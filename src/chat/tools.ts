import path from "node:path";

import * as vscode from "vscode";

import { lmToolNames } from "../constants";
import { exec } from "../utils";

const chromiumVersionRegex = /\d+\.\d+\.\d+\.\d+/;
const commitLogRegex =
  /commit ([0-9a-f]+).*?(?:\n|$)(?:(?=commit (?:[0-9a-f]+))|$)/gs;

export class EmptyLogPageError extends Error {}

function sanitizeDate(date: string) {
  const parsedDate = new Date(date);
  if (isNaN(parsedDate.getTime())) {
    throw new Error(`Invalid date: ${date}`);
  }

  return parsedDate.toISOString();
}

async function validateGitToolFilename(
  chromiumRoot: vscode.Uri,
  filename: string,
) {
  const absolutePath = vscode.Uri.joinPath(chromiumRoot, filename);

  // Confirm the file exists on disk or commands will be useless
  try {
    await vscode.workspace.fs.stat(absolutePath);
  } catch {
    throw new Error(`File not found: ${filename}`);
  }

  // Use the dirname for the file as the working directory so
  // that we properly handle filenames in nested git trees
  const cwd = path.dirname(vscode.Uri.joinPath(chromiumRoot, filename).fsPath);

  return { cwd };
}

export function getPrivateTools(
  extension: vscode.Extension<unknown>,
): vscode.LanguageModelChatTool[] {
  return extension.packageJSON.contributes.languageModelTools.map(
    ({
      name,
      modelDescription,
      inputSchema,
    }: {
      name: string;
      modelDescription: string;
      inputSchema: object;
    }) => ({
      name,
      description: modelDescription,
      inputSchema,
    }),
  );
}

interface GitLogToolParameters {
  startVersion: string;
  endVersion: string;
  filename: string;
}

async function gitLog(
  chromiumRoot: vscode.Uri,
  startVersion: string,
  endVersion: string,
  filename: string,
) {
  if (!chromiumVersionRegex.test(startVersion)) {
    throw new Error(`Invalid Chromium version: ${startVersion}`);
  }

  if (!chromiumVersionRegex.test(endVersion)) {
    throw new Error(`Invalid Chromium version: ${endVersion}`);
  }

  const { cwd } = await validateGitToolFilename(chromiumRoot, filename);

  let output = await exec(
    `git log ${startVersion}..${endVersion} ${path.basename(filename)}`,
    {
      cwd,
      encoding: "utf8",
    },
  ).then(({ stdout }) => stdout.trim());

  if (!output) {
    output = `No commits found for ${filename} in the range ${startVersion}..${endVersion}`;
  }

  return new vscode.LanguageModelToolResult([
    new vscode.LanguageModelTextPart(output),
  ]);
}

export interface ChromiumGitLogToolParameters {
  startVersion: string;
  endVersion: string;
  page: number;
  continueAfter?: string;
}

async function chromiumGitLog(
  chromiumRoot: vscode.Uri,
  startVersion: string,
  endVersion: string,
  page: number, // 1-indexed
  continueAfter?: string,
) {
  if (!chromiumVersionRegex.test(startVersion)) {
    throw new Error(`Invalid Chromium version: ${startVersion}`);
  }

  if (!chromiumVersionRegex.test(endVersion)) {
    throw new Error(`Invalid Chromium version: ${endVersion}`);
  }

  let output = await exec(
    `git log --max-count=10 --skip=${(page - 1) * 10} --name-status ${startVersion}..${endVersion}`,
    {
      cwd: chromiumRoot.fsPath,
      encoding: "utf8",
    },
  ).then(({ stdout }) => stdout.trim());

  // If continuing, we drop all log output before and
  // including the commit we are continuing from
  if (continueAfter) {
    const regexMatches = output.matchAll(commitLogRegex);
    const logEntries = [...regexMatches];
    const targetEntryIdx = logEntries.findIndex(
      (entry) => entry[1] === continueAfter,
    );

    if (targetEntryIdx !== -1) {
      const nextEntry = logEntries[targetEntryIdx + 1];

      if (nextEntry) {
        output = output.slice(nextEntry.index);
      } else {
        throw new EmptyLogPageError();
      }
    }
  }

  if (!output) {
    return new vscode.LanguageModelToolResult([
      new vscode.LanguageModelTextPart("No commits found"),
    ]);
  }

  return new vscode.LanguageModelToolResult([
    new vscode.LanguageModelTextPart(`This is page ${page} of the log:\n\n`),
    new vscode.LanguageModelTextPart(output),
  ]);
}

export interface ChromiumGitShowToolParameters {
  commit: string;
}

async function chromiumGitShow(chromiumRoot: vscode.Uri, commit: string) {
  if (!/^[0-9a-f]+$/.test(commit)) {
    throw new Error(`Invalid commit SHA: ${commit}`);
  }

  const output = await exec(`git show ${commit}`, {
    cwd: chromiumRoot.fsPath,
    encoding: "utf8",
  }).then(({ stdout }) => stdout.trim());

  return new vscode.LanguageModelToolResult([
    new vscode.LanguageModelTextPart(output),
  ]);
}

interface GitShowToolParameters {
  commit: string;
  filename: string;
}

async function gitShow(
  chromiumRoot: vscode.Uri,
  commit: string,
  filename: string,
) {
  if (!/^[0-9a-f]+$/.test(commit)) {
    throw new Error(`Invalid commit SHA: ${commit}`);
  }

  const { cwd } = await validateGitToolFilename(chromiumRoot, filename);

  const output = await exec(
    `git show ${commit} -- ${path.basename(filename)}`,
    {
      cwd,
      encoding: "utf8",
    },
  ).then(({ stdout }) => stdout.trim());

  return new vscode.LanguageModelToolResult([
    new vscode.LanguageModelTextPart(output),
  ]);
}

export function invokePrivateTool(
  chromiumRoot: vscode.Uri,
  name: string,
  options: vscode.LanguageModelToolInvocationOptions<object>,
  _token?: vscode.CancellationToken,
): Promise<vscode.LanguageModelToolResult> {
  if (name === lmToolNames.gitLog) {
    const { startVersion, endVersion, filename } =
      options.input as GitLogToolParameters;
    return gitLog(chromiumRoot, startVersion, endVersion, filename);
  } else if (name === lmToolNames.gitShow) {
    const { commit, filename } = options.input as GitShowToolParameters;
    return gitShow(chromiumRoot, commit, filename);
  } else if (name === lmToolNames.chromiumLog) {
    const { startVersion, endVersion, page, continueAfter } =
      options.input as ChromiumGitLogToolParameters;
    return chromiumGitLog(
      chromiumRoot,
      startVersion,
      endVersion,
      page,
      continueAfter,
    );
  } else if (name === lmToolNames.chromiumGitShow) {
    const { commit } = options.input as ChromiumGitShowToolParameters;
    return chromiumGitShow(chromiumRoot, commit);
  }

  throw new Error(`Tool not found: ${name}`);
}
