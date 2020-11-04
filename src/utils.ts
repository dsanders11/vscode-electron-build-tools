import * as childProcess from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import * as vscode from "vscode";

import { v4 as uuidv4 } from "uuid";

import { buildToolsExecutable } from "./constants";

const patchedFilenameRegex = /^\+\+\+ b\/(.*)$/gm;

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
  if (os.platform() === "win32") {
    return `\\\\.\\pipe\\${uuidv4()}`;
  } else {
    throw new Error("Not implemented");
  }
}

export function getConfigs() {
  const configs: string[] = [];
  let activeConfig = null;

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

export function getConfigDefaultTarget() {
  const configFilename = childProcess
    .execSync(`${buildToolsExecutable} show current --filename --no-name`, {
      encoding: "utf8",
    })
    .trim();

  return JSON.parse(fs.readFileSync(configFilename, { encoding: "utf8" }))
    .defaultTarget;
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

export async function parsePatchConfig(config: vscode.Uri): Promise<Object> {
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
  config: Object,
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
  markdown.appendMarkdown(
    `**Filename**: \`${path.basename(patch.fsPath)}\`\n\n`
  );
  markdown.appendMarkdown(`**Files**:\n\n`);

  for (const filename in patchMetadata.filenames) {
    markdown.appendMarkdown(`* ${filename}\n`);
  }

  return markdown;
}

export async function findCommitForPatch(
  checkoutDirectory: vscode.Uri,
  patchName: string
) {
  const gitCommand = `git log refs/patches/upstream-head..HEAD --grep "Patch-Filename: ${patchName}" --pretty=format:"%h"`;

  return childProcess
    .execSync(gitCommand, {
      encoding: "utf8",
      cwd: checkoutDirectory.fsPath,
    })
    .trim();
}
