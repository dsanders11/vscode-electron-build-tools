import * as childProcess from "node:child_process";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";

import * as vscode from "vscode";

import {
  headingsAndContent,
  HeadingContent,
} from "@electron/docs-parser/dist/markdown-helpers";
import { Octokit } from "@octokit/rest";
import * as Diff from "diff";
import LRU from "lru-cache";
import MarkdownIt from "markdown-it";
import type MarkdownToken from "markdown-it/lib/token";
import { v4 as uuidv4 } from "uuid";

import type { PromisifiedExecError } from "./common";
import {
  buildToolsExecutable,
  checkoutDirectoryGitHubRepo,
  contextKeyPrefix,
} from "./constants";
import ExtensionState from "./extensionState";
import Logger from "./logging";
import type { ElectronPatchesConfig, EVMConfig } from "./types";

const exec = promisify(childProcess.exec);

const remoteFileContentCache = new LRU<string, string>({
  max: 500,
  maxSize: 10485760,
  sizeCalculation: (value) => value.length,
});

export const patchedFilenameRegex =
  /diff --git a\/\S+ b\/(\S+)[\r\n]+(?:[\w \t]+ mode \d+[\r\n]+)*index (\S+)\.\.(\S+).*?(?:(?=\ndiff)|(?=\s--\s.+$)|$)/gs;

export interface DocLink {
  description: string;
  destination: vscode.Uri;
  level: number;
}

export interface DocSection {
  heading: string;
  level: number;
  parent?: DocSection;
  sections: DocSection[];
  links: DocLink[];
}

export class ContentNotFoundError extends Error {}

export async function isBuildToolsInstalled(): Promise<boolean> {
  const command = os.platform() === "win32" ? "where" : "which";
  try {
    await exec(`${command} ${buildToolsExecutable}`);
    return true;
  } catch (err) {
    if (
      err instanceof Error &&
      Object.prototype.hasOwnProperty.call(err, "code")
    ) {
      const errorWithCode = err as PromisifiedExecError;
      if (errorWithCode.code === undefined) {
        Logger.error(errorWithCode);
      }
    }

    return false;
  }
}

export function generateSocketName() {
  return os.platform() === "win32"
    ? `\\\\.\\pipe\\${uuidv4()}`
    : path.join(os.tmpdir(), `socket-${uuidv4()}`);
}

export async function getConfigs() {
  const configs: string[] = [];
  let activeConfig: string | null = null;

  const { stdout } = await exec(`${buildToolsExecutable} show configs`, {
    encoding: "utf8",
  });
  const configsOutput = stdout.trim();

  if (!configsOutput.startsWith("No build configs found.")) {
    for (const rawConfig of configsOutput.split("\n")) {
      const config = rawConfig.replace("*", "").trim();
      configs.push(config);

      if (rawConfig.trim().startsWith("*")) {
        activeConfig = config;
      }
    }
  }

  return { configs, activeConfig };
}

export function getConfigsFilePath() {
  return path.join(os.homedir(), ".electron_build_tools", "configs");
}

export async function getConfigDefaultTarget(): Promise<string | undefined> {
  const { stdout } = await exec(
    `${buildToolsExecutable} show current --filepath --no-name`,
    {
      encoding: "utf8",
    },
  );
  const configFilename = vscode.Uri.file(stdout.trim());

  const config: EVMConfig = JSON.parse(
    await vscode.workspace.fs
      .readFile(configFilename)
      .then((buffer) => buffer.toString()),
  );

  return config.defaultTarget;
}

export function getPatchesConfigFile(electronRoot: vscode.Uri) {
  return vscode.Uri.joinPath(electronRoot, "patches", "config.json");
}

export async function getPatches(directory: vscode.Uri): Promise<vscode.Uri[]> {
  const patchListFile = vscode.Uri.joinPath(directory, ".patches");
  const patchListFileContent = (
    await vscode.workspace.fs.readFile(patchListFile)
  )
    .toString()
    .trim();

  if (!patchListFileContent) {
    return [];
  }

  return patchListFileContent
    .split("\n")
    .map((patchFilename) =>
      vscode.Uri.joinPath(directory, patchFilename.trim()),
    );
}

export async function getFilesInPatch(
  baseDirectory: vscode.Uri,
  patch: vscode.Uri,
): Promise<vscode.Uri[]> {
  const patchContents = (await vscode.workspace.fs.readFile(patch)).toString();
  const patchedFiles: vscode.Uri[] = [];
  const regexMatches = patchContents.matchAll(patchedFilenameRegex);

  for (const [_, filename, blobIdA, blobIdB] of regexMatches) {
    // Retain the scheme and query params from the patch URI, but tweak a few params
    const queryParams = new URLSearchParams(patch.query);
    queryParams.set("patch", patch.toString());
    queryParams.delete("blobId");
    queryParams.set("blobIdA", blobIdA);
    queryParams.set("blobIdB", blobIdB);

    const ghRepo = checkoutDirectoryGitHubRepo[baseDirectory.path];

    if (ghRepo) {
      queryParams.set("repoOwner", ghRepo.owner);
      queryParams.set("repo", ghRepo.repo);
    }

    patchedFiles.push(
      vscode.Uri.joinPath(baseDirectory, filename).with({
        scheme: patch.scheme,
        query: queryParams.toString(),
      }),
    );
  }

  return patchedFiles;
}

export async function parsePatchConfig(
  config: vscode.Uri,
): Promise<ElectronPatchesConfig> {
  return JSON.parse((await vscode.workspace.fs.readFile(config)).toString());
}

export function getCheckoutDirectoryForPatchDirectory(
  rootDirectory: vscode.Uri,
  config: ElectronPatchesConfig,
  patchDirectory: vscode.Uri,
) {
  for (const { patch_dir, repo } of config) {
    if (patchDirectory.path.endsWith(patch_dir)) {
      return vscode.Uri.joinPath(rootDirectory, repo);
    }
  }

  throw new Error("Couldn't resolve patch directory");
}

export async function getPatchSubjectLine(patch: vscode.Uri) {
  const patchContents = (await vscode.workspace.fs.readFile(patch)).toString();

  return /^Subject: (.*)$/m.exec(patchContents)![1];
}

export async function getPatchDescription(patch: vscode.Uri) {
  const patchContents = (await vscode.workspace.fs.readFile(patch)).toString();

  return /Subject.*\s+([\s\S]*?)\s+diff/.exec(patchContents)![1];
}

export function truncateToLength(text: string, length: number) {
  return text.length > length ? `${text.slice(0, length - 3)}...` : text;
}

export function parsePatchMetadata(patchContents: string) {
  const subjectAndDescription =
    /Subject: (.*?)\n\n([\s\S]*?)\s*(?=diff)/ms.exec(patchContents);

  return {
    from: /^From: ((.*)<(\S*)>)$/m.exec(patchContents)![1],
    date: /^Date: (.*)$/m.exec(patchContents)![1],
    subject: subjectAndDescription![1]
      .split("\n")
      .map((text) => text.trim())
      .join(" "),
    description: subjectAndDescription![2],
    filenames: Array.from(patchContents.matchAll(patchedFilenameRegex)).map(
      (match) => match[1],
    ),
  };
}

export async function patchTooltipMarkdown(patch: vscode.Uri) {
  const patchContents = (await vscode.workspace.fs.readFile(patch)).toString();
  const patchMetadata = parsePatchMetadata(patchContents);

  const markdown = new vscode.MarkdownString(undefined, true);

  const date = new Date(patchMetadata.date);
  markdown.appendMarkdown(
    `${patchMetadata.from} on ${date.toLocaleString("default", {
      day: "numeric",
      month: "short",
      year: "numeric",
    })}\n\n`,
  );
  markdown.appendMarkdown(`${patchMetadata.subject}`);

  if (patchMetadata.description) {
    markdown.appendMarkdown(
      `\n\n${truncateToLength(patchMetadata.description, 100)}`,
    );
  }

  return markdown;
}

export function patchOverviewMarkdown(
  patch: vscode.Uri,
  patchContents: string,
) {
  const patchMetadata = parsePatchMetadata(patchContents);

  const markdown = new vscode.MarkdownString(undefined, true);

  const date = new Date(patchMetadata.date);
  markdown.appendMarkdown("# Patch Overview\n\n");
  markdown.appendMarkdown(
    `${patchMetadata.from} on ${date.toLocaleString("default", {
      day: "numeric",
      month: "short",
      year: "numeric",
    })}\n\n`,
  );
  markdown.appendMarkdown(`## ${patchMetadata.subject}\n\n`);
  markdown.appendMarkdown(`${patchMetadata.description}\n\n`);
  markdown.appendMarkdown(`## Patch Filename\n\n`);
  markdown.appendMarkdown(`\`${path.basename(patch.fsPath)}\`\n\n`);
  markdown.appendMarkdown(`## Files\n\n`);

  for (const filename of patchMetadata.filenames) {
    markdown.appendMarkdown(`* ${filename}\n`);
  }

  return markdown;
}

export async function parseDocsSections(electronRoot: vscode.Uri) {
  const docsRoot = vscode.Uri.joinPath(electronRoot, "docs");
  const readmeContent = await vscode.workspace.fs.readFile(
    vscode.Uri.joinPath(docsRoot, "README.md"),
  );

  const md = new MarkdownIt();
  const parsedHeadings = headingsAndContent(
    md.parse(readmeContent.toString(), {}),
  );
  const rootHeading = parsedHeadings[0];

  const parseLinks = (content: MarkdownToken[]) => {
    const links: DocLink[] = [];

    for (const { children, level, type } of content) {
      if (type === "inline" && children) {
        let href: string | undefined;

        for (const child of children) {
          if (child.type === "link_open") {
            href = child.attrs![0][1];
          } else if (href && child.type === "text") {
            // Mixed separators will mess with things, so make sure it's
            // POSIX since that's what links in the docs will be using
            const filePath = ensurePosixSeparators(
              path.resolve(docsRoot.fsPath, href),
            );

            // These links have fragments in them, so don't
            // use vscode.Uri.file to parse them
            links.push({
              description: child.content,
              destination: vscode.Uri.parse(`file://${filePath}`),
              level,
            });
          }
        }
      } else if (type === "heading_open") {
        break; // Don't bleed into other sections
      }
    }

    return links;
  };

  const rootSection: DocSection = {
    heading: rootHeading.heading,
    level: rootHeading.level,
    sections: [],
    links: [],
  };

  const walkSections = (
    parent: DocSection | undefined,
    headings: HeadingContent[],
  ) => {
    if (headings.length === 0) {
      return;
    }

    const [{ heading, level, content }, ...remainingHeadings] = headings;

    while (parent && level <= parent.level) {
      parent = parent.parent;
    }

    if (parent) {
      parent.sections.push({
        heading,
        level,
        parent,
        sections: [],
        links: parseLinks(content),
      });
    } else {
      throw new Error("Malformed document layout");
    }

    walkSections(parent.sections.slice(-1)[0], remainingHeadings);
  };

  walkSections(rootSection, parsedHeadings.slice(1));

  return rootSection;
}

export function alphabetizeByLabel<T extends vscode.TreeItem>(
  treeItems: T[],
): T[] {
  return treeItems.sort((a, b) => {
    if (typeof a.label === "string" && typeof b.label === "string") {
      if (a.label.toLowerCase() < b.label.toLowerCase()) {
        return -1;
      }
      if (a.label.toLowerCase() > b.label.toLowerCase()) {
        return 1;
      }
      return 0;
    } else {
      throw new Error("All TreeItems must have a string label");
    }
  });
}

export function escapeStringForRegex(str: string) {
  return str.replace("(", "\\(").replace(")", "\\)").replace(".", "\\.");
}

export function ensurePosixSeparators(filePath: string) {
  return filePath.split(path.sep).join(path.posix.sep);
}

export const slugifyHeading = (heading: string): string => {
  return heading
    .replace(/[^A-Za-z0-9 \-]/g, "")
    .replace(/ /g, "-")
    .toLowerCase();
};

export function parseMarkdownHeader(line: string) {
  if (/^#+\s+/.test(line)) {
    const header = line.split(" ").slice(1).join(" ").trim();
    const urlFragment = slugifyHeading(header);

    return { text: header.replace(/`/g, ""), urlFragment };
  }
}

export async function getOctokit() {
  try {
    const ghAuthSession = await ExtensionState.getGitHubAuthenticationSession();
    return new Octokit({ auth: ghAuthSession.accessToken });
  } catch (err) {
    Logger.error(err instanceof Error ? err : String(err));

    return new Octokit();
  }
}

async function getCheckoutDirectoryForUri(
  uri: vscode.Uri,
): Promise<vscode.Uri> {
  const { stdout } = await exec("git rev-parse --show-toplevel", {
    encoding: "utf8",
    cwd: path.dirname(uri.fsPath),
  });

  return vscode.Uri.file(stdout.trim());
}

export async function getContentForUri(uri: vscode.Uri): Promise<string> {
  const { blobId, patch, unpatchedBlobId, repo, repoOwner } = querystringParse(
    uri.query,
  );

  if (!blobId) {
    // If there's no blobId, only choice is to read the path from disk
    return (await vscode.workspace.fs.readFile(uri)).toString();
  }

  const ghRepo = repo && repoOwner ? { owner: repoOwner, repo } : undefined;
  const checkoutDirectory = await getCheckoutDirectoryForUri(uri);

  if (patch && unpatchedBlobId) {
    // If it's a patched file, apply the patch if the unpatched content is found
    const unpatchedContents = await getContentForBlobId(
      unpatchedBlobId,
      checkoutDirectory,
      ghRepo,
    );
    const patchContents = (
      await vscode.workspace.fs.readFile(vscode.Uri.parse(patch, true))
    ).toString();

    const regexMatches = patchContents.matchAll(patchedFilenameRegex);
    let filePatch: string | undefined = undefined;

    for (const [patch, filename] of regexMatches) {
      if (filename === path.relative(checkoutDirectory.path, uri.path)) {
        filePatch = patch;
        break;
      }
    }

    // Patch was provided, but it doesn't modify the provided URI... programming error
    if (!filePatch) {
      throw new ContentNotFoundError(`Couldn't load content for ${blobId}`);
    }

    return Buffer.from(applyPatch(unpatchedContents, filePatch)).toString();
  }

  return getContentForBlobId(blobId, checkoutDirectory, ghRepo);
}

export function hasContentForBlobId(blobId: string) {
  return remoteFileContentCache.has(blobId);
}

export function setContentForBlobId(blobId: string, content: string) {
  remoteFileContentCache.set(blobId, content);
}

async function getContentForBlobId(
  blobId: string,
  checkoutDirectory: vscode.Uri,
  ghRepo?: { owner: string; repo: string },
): Promise<string> {
  if (/^[0]+$/.test(blobId)) {
    // Special case where it's all zeroes, so it's an empty file
    return "";
  }

  // Check cache first
  if (remoteFileContentCache.has(blobId)) {
    return remoteFileContentCache.get(blobId)!;
  }

  try {
    const { stdout } = await exec(`git show ${blobId}`, {
      encoding: "utf8",
      cwd: checkoutDirectory.fsPath,
    });

    return stdout.trim();
  } catch (err) {
    if (
      err instanceof Error &&
      Object.prototype.hasOwnProperty.call(err, "code")
    ) {
      if ((err as PromisifiedExecError).code === 128) {
        if (!ghRepo) {
          throw new ContentNotFoundError(`Couldn't load content for ${blobId}`);
        }

        try {
          const octokit = await getOctokit();

          const response = await octokit.rest.git.getBlob({
            ...ghRepo,
            // eslint-disable-next-line @typescript-eslint/naming-convention
            file_sha: blobId,
          });

          const content = Buffer.from(
            response.data.content,
            "base64",
          ).toString();

          // Cache responses to avoid rate-limiting
          remoteFileContentCache.set(blobId, content);

          return content;
        } catch {
          throw new ContentNotFoundError(`Couldn't load content for ${blobId}`);
        }
      }
    }

    throw err;
  }
}

export function querystringParse(str: string) {
  const parsedUrlQuery = Object.fromEntries(new URLSearchParams(str).entries());

  for (const param in parsedUrlQuery) {
    const value = parsedUrlQuery[param];

    if (Array.isArray(value)) {
      if (value.length === 1) {
        parsedUrlQuery[param] = value[0];
      } else {
        throw new Error("Expected a single value for query param");
      }
    }
  }

  return parsedUrlQuery as Record<string, string | undefined>;
}

export async function findElectronRoot(
  workspaceFolder: vscode.WorkspaceFolder,
): Promise<vscode.Uri | undefined> {
  // Support opening the src/electron folder, as well as src/
  const possiblePackageRoots = [".", "electron"];

  for (const possibleRoot of possiblePackageRoots) {
    const rootPackageFilename = vscode.Uri.joinPath(
      workspaceFolder.uri,
      possibleRoot,
      "package.json",
    );

    try {
      const rootPackageFile =
        await vscode.workspace.fs.readFile(rootPackageFilename);

      const { name } = JSON.parse(rootPackageFile.toString()) as Record<
        string,
        string
      >;

      if (name === "electron") {
        return vscode.Uri.joinPath(workspaceFolder.uri, possibleRoot);
      }
    } catch {
      continue;
    }
  }
}

export function makeCommandUri(command: string, ...args: unknown[]) {
  const commandArgs = encodeURIComponent(JSON.stringify(args));
  return vscode.Uri.parse(`command:${command}?${commandArgs}`);
}

export async function setContext<ValueType>(
  key: string,
  value: ValueType,
): Promise<unknown> {
  return await vscode.commands.executeCommand(
    "setContext",
    `${contextKeyPrefix}:${key}`,
    value,
  );
}

export function startProgress(options: vscode.ProgressOptions) {
  let resolver: (value?: unknown) => void;

  const promise = new Promise((resolve) => {
    resolver = resolve;
  });

  vscode.window.withProgress(options, () => promise);

  return () => resolver();
}

export class OptionalFeature<T> extends vscode.Disposable {
  private _disposable: vscode.Disposable | undefined;

  constructor(
    configSection: string,
    settingName: string,
    setupFeature: (settingValue: T) => vscode.Disposable | void,
  ) {
    super(() => {
      this._disposable?.dispose();
    });

    const getSettingValue = (): T => {
      const settingValue = vscode.workspace
        .getConfiguration(configSection)
        .get<T>(settingName);

      if (settingValue === undefined) {
        Logger.error(
          `Failed to read setting value for "${configSection}.${settingName}"`,
        );
        throw new Error("Setting could not be read");
      }

      return settingValue;
    };

    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration(configSection)) {
        this._disposable?.dispose();
        this._disposable = setupFeature(getSettingValue())!;
      }
    });

    // Initial setup of the feature
    this._disposable = setupFeature(getSettingValue())!;
  }
}

export async function drillDown(
  treeView: vscode.TreeView<vscode.TreeItem>,
  treeDataProvider: vscode.TreeDataProvider<vscode.TreeItem>,
  callback: (
    element: vscode.TreeItem | undefined,
    children: vscode.TreeItem[],
  ) =>
    | Promise<{ item: vscode.TreeItem | undefined; done: boolean }>
    | { item: vscode.TreeItem | undefined; done: boolean },
  revealOptions?: {
    select?: boolean | undefined;
    focus?: boolean | undefined;
    expand?: number | boolean | undefined;
  },
): Promise<void> {
  const parentChain: vscode.TreeItem[] = [];
  let children: vscode.TreeItem[] | null | undefined =
    await treeDataProvider.getChildren();

  while (children && children.length > 0) {
    const element: vscode.TreeItem | undefined =
      parentChain[parentChain.length - 1];
    const { item, done } = await callback(element, children);

    if (item && !children.includes(item)) {
      throw new Error("Drill down must return one of the children");
    }

    if (done) {
      if (item) {
        // This would use parentChain to reveal the item
        // instead of calling treeDataProvider.getParent(...)
        treeView.reveal(item, revealOptions);
      }
      return;
    } else if (!item) {
      throw new Error("Drill down tried to continue, but no item returned");
    } else {
      if (!item.collapsibleState) {
        throw new Error(
          "Drill down tried to continue, but returned item has no children",
        );
      }

      parentChain.push(item);
      children = await treeDataProvider.getChildren(item);
    }
  }

  throw new Error("Drill down tried to continue, but no children of item");
}

export function sleep(timeMs: number) {
  return new Promise((resolve) => setTimeout(resolve, timeMs));
}

export function positionAt(content: string, offset: number) {
  const lines = Array.from(
    content.slice(0, offset).matchAll(/^(.*)(?:\r\n|$)/gm),
  );
  const lastLine = lines.slice(-1)[0][1];

  return new vscode.Position(lines.length - 1, lastLine.length);
}

export function applyPatch(source: string, patch: string) {
  const patchedResult = Diff.applyPatch(source, patch);

  if (patchedResult === false) {
    throw new Error("Malformed patch");
  }

  return patchedResult;
}
