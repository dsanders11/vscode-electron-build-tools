import * as childProcess from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as querystring from "querystring";
import { promisify } from "util";

import * as vscode from "vscode";

import {
  headingsAndContent,
  HeadingContent,
} from "@electron/docs-parser/dist/markdown-helpers";
import { Octokit } from "@octokit/rest";
import MarkdownIt from "markdown-it";
import type MarkdownToken from "markdown-it/lib/token";
import { v4 as uuidv4 } from "uuid";

import type { PromisifiedExecError } from "./common";
import {
  buildToolsExecutable,
  checkoutDirectoryGitHubRepo,
  commandPrefix,
  contextKeyPrefix,
} from "./constants";
import ExtensionState from "./extensionState";
import Logger from "./logging";
import type { ElectronPatchesConfig, EVMConfig } from "./types";

const exec = promisify(childProcess.exec);
const fsReadFile = promisify(fs.readFile);

export const patchedFilenameRegex =
  /diff --git a\/\S+ b\/(\S+)[\r\n]+(?:new file mode \d+[\r\n]+)?index (\S+)\.\.(\S+).*?(?:(?=\ndiff)|$)/gs;

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

export interface FileInPatch {
  file: vscode.Uri;
  fileIndexA: string;
  fileIndexB: string;
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
    `${buildToolsExecutable} show current --filename --no-name`,
    {
      encoding: "utf8",
    }
  );
  const configFilename = stdout.trim();

  const config: EVMConfig = JSON.parse(
    await fsReadFile(configFilename, { encoding: "utf8" })
  );

  return config.defaultTarget;
}

export function getPatchesConfigFile(electronRoot: vscode.Uri) {
  return vscode.Uri.joinPath(electronRoot, "patches", "config.json");
}

export async function getPatches(directory: vscode.Uri): Promise<vscode.Uri[]> {
  const patchListFile = vscode.Uri.joinPath(directory, ".patches");
  const patchFilenames = (await vscode.workspace.fs.readFile(patchListFile))
    .toString()
    .trim()
    .split("\n");

  return patchFilenames.map((patchFilename) =>
    vscode.Uri.joinPath(directory, patchFilename.trim())
  );
}

export async function getFilesInPatch(
  baseDirectory: vscode.Uri,
  patch: vscode.Uri
): Promise<FileInPatch[]> {
  const patchContents = (await vscode.workspace.fs.readFile(patch)).toString();
  const patchedFiles: FileInPatch[] = [];
  const regexMatches = patchContents.matchAll(patchedFilenameRegex);

  for (const [_, filename, fileIndexA, fileIndexB] of regexMatches) {
    patchedFiles.push({
      // Retain the scheme and query parameters from the patch URI
      file: vscode.Uri.joinPath(baseDirectory, filename).with({
        scheme: patch.scheme,
        query: patch.query,
      }),
      fileIndexA,
      fileIndexB,
    });
  }

  return patchedFiles;
}

export async function parsePatchConfig(
  config: vscode.Uri
): Promise<ElectronPatchesConfig> {
  return JSON.parse((await vscode.workspace.fs.readFile(config)).toString());
}

export function getCheckoutDirectoryForPatchDirectory(
  rootDirectory: vscode.Uri,
  config: ElectronPatchesConfig,
  patchDirectory: vscode.Uri
) {
  for (const [patchDirectoryTail, checkoutDirectory] of Object.entries(
    config
  )) {
    if (patchDirectory.path.endsWith(patchDirectoryTail)) {
      return vscode.Uri.joinPath(rootDirectory, checkoutDirectory);
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
  return text.length > length ? `${text.substr(0, length - 3)}...` : text;
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
      (match) => match[1]
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
    })}\n\n`
  );
  markdown.appendMarkdown(`${patchMetadata.subject}`);

  if (patchMetadata.description) {
    markdown.appendMarkdown(
      `\n\n${truncateToLength(patchMetadata.description, 100)}`
    );
  }

  return markdown;
}

export async function patchOverviewMarkdown(patch: vscode.Uri) {
  const patchContents = (await vscode.workspace.fs.readFile(patch)).toString();
  const patchMetadata = parsePatchMetadata(patchContents);

  const markdown = new vscode.MarkdownString(undefined, true);

  const date = new Date(patchMetadata.date);
  markdown.appendMarkdown("# Patch Overview\n\n");
  markdown.appendMarkdown(
    `${patchMetadata.from} on ${date.toLocaleString("default", {
      day: "numeric",
      month: "short",
      year: "numeric",
    })}\n\n`
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
    vscode.Uri.joinPath(docsRoot, "README.md")
  );

  const md = new MarkdownIt();
  const parsedHeadings = headingsAndContent(
    md.parse(readmeContent.toString(), {}) as any
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
              path.resolve(docsRoot.fsPath, href)
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
    headings: HeadingContent[]
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
        links: parseLinks(content as any),
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
  treeItems: T[]
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

async function getOctokit() {
  try {
    const ghAuthSession = await ExtensionState.getGitHubAuthenticationSession();
    return new Octokit({ auth: ghAuthSession.accessToken });
  } catch (err) {
    Logger.error(err instanceof Error ? err : String(err));

    return new Octokit();
  }
}

export async function getContentForFileIndex(
  fileIndex: string,
  checkoutPath: string
) {
  if (/^[0]+$/.test(fileIndex)) {
    // Special case where it's all zeroes, so it's an empty file
    return "";
  }

  try {
    const { stdout } = await exec(`git show ${fileIndex}`, {
      encoding: "utf8",
      cwd: checkoutPath,
    });

    return stdout.trim();
  } catch (err) {
    if (
      err instanceof Error &&
      Object.prototype.hasOwnProperty.call(err, "code")
    ) {
      const errorWithCode = err as PromisifiedExecError;
      if (errorWithCode.code === 128) {
        // Couldn't find content locally (might not be synced)
        // so instead pull it from GitHub where it hopefully is
        // TODO - Replace this with plumbing the root dir down to this point
        const rootDir = await vscode.commands.executeCommand<string>(
          `${commandPrefix}.show.root`
        )!;

        if (!checkoutPath.startsWith(rootDir)) {
          throw new ContentNotFoundError(
            `Couldn't load content for ${fileIndex}`
          );
        }

        const ghRepo =
          checkoutDirectoryGitHubRepo[path.relative(rootDir, checkoutPath)];

        if (!ghRepo) {
          throw new ContentNotFoundError(
            `Couldn't load content for ${fileIndex}`
          );
        }

        const octokit = await getOctokit();

        try {
          // TODO - Cache responses to avoid rate-limiting
          const response = await octokit.rest.git.getBlob({
            ...ghRepo,
            // eslint-disable-next-line @typescript-eslint/naming-convention
            file_sha: fileIndex,
          });

          return Buffer.from(response.data.content, "base64").toString();
        } catch (err) {
          throw new ContentNotFoundError(
            `Couldn't load content for ${fileIndex}`
          );
        }
      }
    }

    throw err;
  }
}

export function querystringParse(
  str: string,
  sep?: string | undefined,
  eq?: string | undefined,
  options?: querystring.ParseOptions | undefined
) {
  const parsedUrlQuery = querystring.parse(str, sep, eq, options);

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

  return parsedUrlQuery as Record<string, string>;
}

export async function findElectronRoot(
  workspaceFolder: vscode.WorkspaceFolder
): Promise<vscode.Uri | undefined> {
  // Support opening the src/electron folder, as well as src/
  const possiblePackageRoots = [".", "electron"];

  for (const possibleRoot of possiblePackageRoots) {
    const rootPackageFilename = vscode.Uri.joinPath(
      workspaceFolder.uri,
      possibleRoot,
      "package.json"
    );

    try {
      const rootPackageFile = await vscode.workspace.fs.readFile(
        rootPackageFilename
      );

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

export function makeCommandUri(command: string, ...args: any[]) {
  const commandArgs = encodeURIComponent(JSON.stringify(args));
  return vscode.Uri.parse(`command:${command}?${commandArgs}`);
}

export async function setContext<ValueType>(
  key: string,
  value: ValueType
): Promise<any> {
  return await vscode.commands.executeCommand(
    "setContext",
    `${contextKeyPrefix}:${key}`,
    value
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
    setupFeature: (settingValue: T) => vscode.Disposable | undefined
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
          `Failed to read setting value for "${configSection}.${settingName}"`
        );
        throw new Error("Setting could not be read");
      }

      return settingValue;
    };

    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration(configSection)) {
        this._disposable?.dispose();
        this._disposable = setupFeature(getSettingValue());
      }
    });

    // Initial setup of the feature
    this._disposable = setupFeature(getSettingValue());
  }
}

export async function drillDown(
  treeView: vscode.TreeView<vscode.TreeItem>,
  treeDataProvider: vscode.TreeDataProvider<vscode.TreeItem>,
  callback: (
    element: vscode.TreeItem | undefined,
    children: vscode.TreeItem[]
  ) =>
    | Promise<{ item: vscode.TreeItem | undefined; done: boolean }>
    | { item: vscode.TreeItem | undefined; done: boolean },
  revealOptions?: {
    select?: boolean | undefined;
    focus?: boolean | undefined;
    expand?: number | boolean | undefined;
  }
): Promise<void> {
  let parentChain: vscode.TreeItem[] = [];
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
          "Drill down tried to continue, but returned item has no children"
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
    content.slice(0, offset).matchAll(/^(.*)(?:\r\n|$)/gm)
  );
  const lastLine = lines.slice(-1)[0][1];

  return new vscode.Position(lines.length - 1, lastLine.length);
}
