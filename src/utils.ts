import * as childProcess from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import * as vscode from "vscode";

import {
  headingsAndContent,
  HeadingContent,
} from "@electron/docs-parser/dist/markdown-helpers";
import MarkdownIt from "markdown-it";
import MarkdownToken from "markdown-it/lib/token";
import { v4 as uuidv4 } from "uuid";

import { buildToolsExecutable } from "./constants";
import { ElectronPatchesConfig, EVMConfig } from "./types";

const patchedFilenameRegex = /^\+\+\+ b\/(.*)$/gm;

export type DocLink = {
  description: string;
  destination: vscode.Uri;
  level: number;
};

export type DocSection = {
  heading: string;
  level: number;
  parent?: DocSection;
  sections: DocSection[];
  links: DocLink[];
};

function matchAll(pattern: RegExp, text: string): RegExpMatchArray[] {
  const matches = [];
  pattern.lastIndex = 0;

  let match: RegExpMatchArray | null;

  while ((match = pattern.exec(text))) {
    matches.push(match);
  }

  return matches;
}

export function isBuildToolsInstalled() {
  const result = childProcess.spawnSync(
    os.platform() === "win32" ? "where" : "which",
    [buildToolsExecutable]
  );

  return result.status === 0;
}

export function generateSocketName() {
  return os.platform() === "win32"
    ? `\\\\.\\pipe\\${uuidv4()}`
    : path.join(os.tmpdir(), `socket-${uuidv4()}`);
}

export function getConfigs() {
  const configs: string[] = [];
  let activeConfig: string | null = null;

  const configsOutput = childProcess
    .execSync(`${buildToolsExecutable} show configs`, { encoding: "utf8" })
    .trim();

  for (const rawConfig of configsOutput.split("\n")) {
    const config = rawConfig.replace("*", "").trim();
    configs.push(config);

    if (rawConfig.trim().startsWith("*")) {
      activeConfig = config;
    }
  }

  return { configs, activeConfig };
}

export function getConfigsFilePath() {
  return path.join(os.homedir(), ".electron_build_tools", "configs");
}

export function getConfigDefaultTarget(): string | undefined {
  const configFilename = childProcess
    .execSync(`${buildToolsExecutable} show current --filename --no-name`, {
      encoding: "utf8",
    })
    .trim();

  const config: EVMConfig = JSON.parse(
    fs.readFileSync(configFilename, { encoding: "utf8" })
  );

  return config.defaultTarget;
}

export function getPatchesConfigFile(workspaceFolder: vscode.WorkspaceFolder) {
  return vscode.Uri.file(
    path.resolve(workspaceFolder.uri.fsPath, "patches", "config.json")
  );
}

export async function getPatches(directory: vscode.Uri): Promise<vscode.Uri[]> {
  const patchListFile = vscode.Uri.file(
    path.resolve(directory.fsPath, ".patches")
  );
  const patchFilenames = (await vscode.workspace.fs.readFile(patchListFile))
    .toString()
    .trim()
    .split("\n");

  return patchFilenames.map((patchFilename) =>
    vscode.Uri.file(path.resolve(directory.fsPath, patchFilename.trim()))
  );
}

export async function getFilesInPatch(
  baseDirectory: vscode.Uri,
  patch: vscode.Uri
): Promise<vscode.Uri[]> {
  const patchContents = (await vscode.workspace.fs.readFile(patch)).toString();
  const filenames = matchAll(patchedFilenameRegex, patchContents)!.map(
    (match) => match[1]
  );

  return filenames.map((filename) =>
    vscode.Uri.file(path.resolve(baseDirectory.fsPath, filename))
  );
}

export async function parsePatchConfig(
  config: vscode.Uri
): Promise<ElectronPatchesConfig> {
  return JSON.parse((await vscode.workspace.fs.readFile(config)).toString());
}

export function getRootDirectoryFromWorkspaceFolder(
  workspaceFolder: vscode.WorkspaceFolder
) {
  // TODO - Handle the case where either src or src/electron is workspaceFolder
  return vscode.Uri.file(path.resolve(workspaceFolder.uri.fsPath, "..", ".."));
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
      return vscode.Uri.file(
        path.resolve(rootDirectory.fsPath, checkoutDirectory)
      );
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
  return {
    from: /^From: ((.*)<(\S*)>)$/m.exec(patchContents)![1],
    date: /^Date: (.*)$/m.exec(patchContents)![1],
    subject: /^Subject: (.*)$/m.exec(patchContents)![1],
    description: /Subject.*\s+([\s\S]*?)\s+diff/.exec(patchContents)![1],
    filenames: matchAll(patchedFilenameRegex, patchContents)!.map(
      (match) => match[1]
    ),
  };
}

export async function patchTooltipMarkdown(patch: vscode.Uri) {
  const patchContents = (await vscode.workspace.fs.readFile(patch)).toString();
  const patchMetadata = parsePatchMetadata(patchContents);

  let tooltip = "";

  const date = new Date(patchMetadata.date);
  tooltip += `${patchMetadata.from} on ${date.toLocaleString("default", {
    day: "numeric",
    month: "short",
    year: "numeric",
  })}  \n`;
  tooltip += `${patchMetadata.subject} \n`;
  tooltip += truncateToLength(patchMetadata.description, 100);

  return tooltip;
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

export async function findCommitForPatch(
  checkoutDirectory: vscode.Uri,
  patch: vscode.Uri
) {
  const patchContents = (await vscode.workspace.fs.readFile(patch)).toString();
  const patchMetadata = parsePatchMetadata(patchContents);
  const patchName = path.basename(patch.path);

  // A local patch that hasn't been re-applied won't have the Patch-Filename
  // line, so include other details to try to ensure we get a single commit
  const gitCommand = [
    "git log refs/patches/upstream-head..HEAD",
    `--author "${patchMetadata.from}"`,
    `--since "${patchMetadata.date}"`,
    `--grep "Patch-Filename: ${patchName}"`,
    `--grep "${patchMetadata.subject}"`,
    `--pretty=format:"%h"`,
  ];

  const result = childProcess
    .execSync(gitCommand.join(" "), {
      encoding: "utf8",
      cwd: checkoutDirectory.fsPath,
    })
    .trim();

  if (!result || result.split("\n").length !== 1) {
    throw new Error("Couldn't find commit");
  }

  return result;
}

export async function parseDocsSections(
  workspaceFolder: vscode.WorkspaceFolder
) {
  const docsRoot = vscode.Uri.file(
    path.resolve(workspaceFolder.uri.fsPath, "docs")
  );
  const readmeContent = await vscode.workspace.fs.readFile(
    vscode.Uri.file(path.resolve(docsRoot.fsPath, "README.md"))
  );

  const md = new MarkdownIt();
  const parsedHeadings = headingsAndContent(
    md.parse(readmeContent.toString(), {}) as any
  );
  const rootHeading = parsedHeadings[0];

  const parseLinks = (content: MarkdownToken[]) => {
    const links = [];

    for (const { children, level, type } of content) {
      if (type === "inline" && children) {
        let href: string | undefined;

        for (const child of children) {
          if (child.type === "link_open") {
            href = child.attrs![0][1];
          } else if (href && child.type === "text") {
            // Mixed separators will mess with things, so make sure it's
            // POSIX since that's what links in the docs will be using
            const filePath = path
              .resolve(docsRoot.fsPath, href)
              .split(path.sep)
              .join(path.posix.sep);

            // These links have fragments in them, so don't
            // use vscode.Uri.file to parse them
            links.push({
              description: child.content,
              destination: vscode.Uri.parse(`file:///${filePath}`),
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

    walkSections(
      parent.sections[parent.sections.length - 1],
      remainingHeadings
    );
  };

  walkSections(rootSection, parsedHeadings.slice(1));

  return rootSection;
}
