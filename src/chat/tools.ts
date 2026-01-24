import path from "node:path";

import LRU from "lru-cache";
import * as vscode from "vscode";

import { lmToolNames } from "../constants";
import Logger from "../logging";
import { exec } from "../utils";
import { getFilenamesFromBuildError } from "./utils";

const chromiumVersionRegex = /\d+\.\d+\.\d+\.\d+/;
const commitLogWithNameStatusRegex =
  /commit ([0-9a-f]+)\n(.*?)\n\n((?:[A|M|D]|[R|C]\d*)\s.*?)\n?(?:\n|$)(?:(?=commit (?:[0-9a-f]+))|$)/;
const commitLogOneLineRegex = /([0-9a-f]+) .*/;

export class EmptyLogPageError extends Error {}

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

  // Confirm that cwd is within the main Chromium git tree
  const gitRoot = path.normalize(
    await exec("git rev-parse --show-toplevel", {
      cwd,
      encoding: "utf8",
    }).then(({ stdout }) => stdout.trim()),
  );

  if (gitRoot !== chromiumRoot.fsPath) {
    throw new Error(`File is not in the main Chromium git tree: ${filename}`);
  }

  return { cwd };
}

// Filter out as much of Chromium's CL footer syntax
// (https://www.chromium.org/developers/contributing-code/-bug-syntax/)
// as possible - this may not be complete but covers the most common ones
function filterGitLogDetails(details: string) {
  return details
    .replaceAll(
      /(?:Author|Date): .*?\n|[ \t>]*(?:Auto-Submit|AX-Relnotes|Bot-Commit|Bug|Change-Id|Cq-Include-Trybots|Commit-Queue|Cr-Branched-From|Cr-Commit-Position|Fixed|Merge-Approval-Bypass|No-Presubmit|No-Tree-Checks|No-Try|Owners-Override|Reviewed-by|Tbr|Test):.*?(?:\n|$)|[ \t>]*(?:BUG|R)=.*?(?:\n|$)|[ \t>]*> Reviewed-on: .*?\n/g,
      "",
    )
    .trimEnd();
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

export interface GitLogToolParameters {
  startVersion: string;
  endVersion: string;
  filename: string;
  continueAfter?: string;
}

async function gitLog(
  chromiumRoot: vscode.Uri,
  startVersion: string,
  endVersion: string,
  filename: string,
  continueAfter?: string,
) {
  if (!chromiumVersionRegex.test(startVersion)) {
    throw new Error(`Invalid Chromium version: ${startVersion}`);
  }

  if (!chromiumVersionRegex.test(endVersion)) {
    throw new Error(`Invalid Chromium version: ${endVersion}`);
  }

  const { cwd } = await validateGitToolFilename(chromiumRoot, filename);

  const output = await exec(
    `git log ${startVersion}..${endVersion} ${path.basename(filename)}`,
    {
      cwd,
      encoding: "utf8",
    },
  ).then(({ stdout }) => stdout.trim());

  let logCommits: { commit: string; details: string }[] = [];
  const regexMatches = output.matchAll(
    /commit ([0-9a-f]+).*?(?:(?=commit [0-9a-f]+)|$)/gs,
  );

  for (const match of regexMatches) {
    logCommits.push({
      commit: match[1],
      details: filterGitLogDetails(match[0]),
    });
  }

  // If continuing, we drop all log output before and
  // including the commit we are continuing from
  if (continueAfter) {
    const idx = logCommits.findIndex(({ commit }) => commit === continueAfter);

    if (idx === -1) {
      throw new Error(
        `Could not find commit to continue from: ${continueAfter}`,
      );
    }

    logCommits = logCommits.slice(idx + 1);
  }

  if (logCommits.length === 0) {
    return new vscode.LanguageModelToolResult([
      new vscode.LanguageModelTextPart(
        `No commits found for ${filename} in the range ${startVersion}..${endVersion}`,
      ),
    ]);
  }

  return new vscode.LanguageModelToolResult([
    new vscode.LanguageModelTextPart(
      logCommits.map(({ details }) => details).join("\n\n"),
    ),
  ]);
}

const chromiumGitLogCache = new Map<string, string[]>();

const chromiumGitDetailsCache = new LRU<
  string,
  { details: string; nameStatus: string }
>({
  maxSize: 25_000_000,
  sizeCalculation: ({ details, nameStatus }) => {
    return details.length + nameStatus.length;
  },
});

async function getChromiumCommitDetails(
  chromiumRoot: vscode.Uri,
  commit: string,
) {
  let commitDetails = chromiumGitDetailsCache.get(commit);
  if (!commitDetails) {
    const output = await exec(`git show --name-status ${commit}`, {
      cwd: chromiumRoot.fsPath,
      encoding: "utf8",
    }).then(({ stdout }) => stdout.trim());
    const regexMatch = output.match(
      new RegExp(commitLogWithNameStatusRegex, "s"),
    );

    if (!regexMatch) {
      throw new Error(`Invalid commit output: ${output}`);
    }

    const [, , details, nameStatus] = regexMatch;

    commitDetails = { details: filterGitLogDetails(details), nameStatus };
    chromiumGitDetailsCache.set(commit, commitDetails);
  }

  return commitDetails;
}

export interface ChromiumGitLogToolParameters {
  startVersion: string;
  endVersion: string;
  page: number;
  pageSize: number;
  continueAfter?: string;
  reverse?: boolean;
  errorText?: string;
}

async function chromiumGitLog(
  chromiumRoot: vscode.Uri,
  startVersion: string,
  endVersion: string,
  page: number, // 1-indexed
  pageSize: number,
  continueAfter?: string,
  reverse?: boolean,
  errorText?: string,
) {
  if (!chromiumVersionRegex.test(startVersion)) {
    throw new Error(`Invalid Chromium version: ${startVersion}`);
  }

  if (!chromiumVersionRegex.test(endVersion)) {
    throw new Error(`Invalid Chromium version: ${endVersion}`);
  }

  const fileLogCommits: string[] = [];

  // If error text is provided, try to extract filenames and then pull the
  // log for those files and prepend it to logCommits so they're checked first
  if (errorText) {
    const filenames = getFilenamesFromBuildError(errorText).map((filename) =>
      path.relative(
        chromiumRoot.fsPath,
        path.join(chromiumRoot.fsPath, "out", "Default", filename),
      ),
    );

    for (const filename of filenames) {
      let cwd: string | undefined;

      try {
        ({ cwd } = await validateGitToolFilename(chromiumRoot, filename));
      } catch {
        // Ignore invalid filenames
        Logger.info(`Skipping invalid filename for git log: ${filename}`);
        continue;
      }

      const fileLog = await exec(
        `git log --oneline --no-abbrev-commit ${startVersion}..${endVersion} ${path.basename(filename)}`,
        {
          cwd,
          encoding: "utf8",
        },
      ).then(({ stdout }) => stdout.trim());

      const regexMatches = fileLog.matchAll(
        new RegExp(commitLogOneLineRegex, "g"),
      );

      for (const [, commit] of regexMatches) {
        fileLogCommits.push(commit);
      }
    }
  }

  let logCommits =
    chromiumGitLogCache.get(`${startVersion}..${endVersion}`) ?? [];

  if (logCommits.length === 0) {
    const fullLog = await exec(
      `git log --name-status ${startVersion}..${endVersion}`,
      {
        cwd: chromiumRoot.fsPath,
        encoding: "utf8",
        maxBuffer: 1024 * 1024 * 50,
      },
    ).then(({ stdout }) => stdout.trim());

    const regexMatches = fullLog.matchAll(
      new RegExp(commitLogWithNameStatusRegex, "gs"),
    );

    for (const match of regexMatches) {
      const [, commit, details, nameStatus] = match;

      const changedFiles = nameStatus.split("\n");

      // Skip "Roll [...] PGO Profile" commits, as they'll never be relevant
      if (changedFiles.every((line) => line.trim().endsWith(".pgo.txt"))) {
        continue;
      }

      logCommits.push(commit);

      // Populate the cache with commit details
      if (!chromiumGitDetailsCache.has(commit)) {
        chromiumGitDetailsCache.set(commit, {
          details: filterGitLogDetails(details),
          nameStatus,
        });
      }
    }

    chromiumGitLogCache.set(`${startVersion}..${endVersion}`, logCommits);
  }

  if (fileLogCommits.length > 0) {
    // Make sure there's no duplication of file-specific commits, and
    // prepend them to the logCommits list so they're checked first
    logCommits = logCommits.filter(
      (commit) => !fileLogCommits.includes(commit),
    );
    logCommits = [...fileLogCommits, ...logCommits];
  }

  if (reverse) {
    logCommits = [...logCommits].reverse();
  }

  // Paginate logCommits and then hydrate the log entries
  let pageCommits = logCommits.slice((page - 1) * pageSize, page * pageSize);

  // If continuing, we drop all log output before and
  // including the commit we are continuing from
  if (continueAfter) {
    const idx = pageCommits.findIndex((commit) => commit === continueAfter);

    if (idx === -1) {
      throw new Error(
        `Could not find commit to continue from: ${continueAfter}`,
      );
    }

    pageCommits = pageCommits.slice(idx + 1);

    if (pageCommits.length === 0) {
      throw new EmptyLogPageError();
    }
  }

  if (pageCommits.length === 0) {
    return new vscode.LanguageModelToolResult([
      new vscode.LanguageModelTextPart("No commits found"),
    ]);
  }

  const output = await Promise.all(
    pageCommits.map(async (commit) => {
      const { details, nameStatus } = await getChromiumCommitDetails(
        chromiumRoot,
        commit,
      );
      return `commit ${commit}\n${details}\n\n${nameStatus}`;
    }),
  );

  return new vscode.LanguageModelToolResult([
    new vscode.LanguageModelTextPart(`This is page ${page} of the log:\n\n`),
    new vscode.LanguageModelTextPart(output.join("\n\n")),
  ]);
}

const chromiumGitDiffCache = new LRU<string, string>({
  maxSize: 25_000_000,
  sizeCalculation: (value) => {
    return value.length;
  },
});

export interface ChromiumGitShowToolParameters {
  commit: string;
}

async function chromiumGitShow(chromiumRoot: vscode.Uri, commit: string) {
  if (!/^[0-9a-f]+$/.test(commit)) {
    throw new Error(`Invalid commit SHA: ${commit}`);
  }

  const { details: commitDetails } = await getChromiumCommitDetails(
    chromiumRoot,
    commit,
  );

  let diff = chromiumGitDiffCache.get(commit);
  if (!diff) {
    const output = await exec(
      `git show --no-notes --pretty=format:"" ${commit}`,
      {
        cwd: chromiumRoot.fsPath,
        encoding: "utf8",
      },
    ).then(({ stdout }) => stdout.trim());

    diff = output
      .split("\n")
      .filter(
        (line) => !line.startsWith("diff --git ") && !line.startsWith("index "),
      )
      .join("\n");
    chromiumGitDiffCache.set(commit, diff);
  }

  return new vscode.LanguageModelToolResult([
    new vscode.LanguageModelTextPart(`commit ${commit}\n${commitDetails}\n\n`),
    new vscode.LanguageModelTextPart(diff),
  ]);
}

export interface GitShowToolParameters {
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
    new vscode.LanguageModelTextPart(filterGitLogDetails(output)),
  ]);
}

export function invokePrivateTool(
  chromiumRoot: vscode.Uri,
  name: string,
  options: vscode.LanguageModelToolInvocationOptions<object>,
  _token?: vscode.CancellationToken,
): Promise<vscode.LanguageModelToolResult> {
  if (name === lmToolNames.gitLog) {
    const { startVersion, endVersion, filename, continueAfter } =
      options.input as GitLogToolParameters;
    return gitLog(
      chromiumRoot,
      startVersion,
      endVersion,
      filename,
      continueAfter,
    );
  } else if (name === lmToolNames.gitShow) {
    const { commit, filename } = options.input as GitShowToolParameters;
    return gitShow(chromiumRoot, commit, filename);
  } else if (name === lmToolNames.chromiumLog) {
    const {
      startVersion,
      endVersion,
      page,
      pageSize,
      continueAfter,
      reverse,
      errorText,
    } = options.input as ChromiumGitLogToolParameters;
    return chromiumGitLog(
      chromiumRoot,
      startVersion,
      endVersion,
      page,
      pageSize,
      continueAfter,
      reverse,
      errorText,
    );
  } else if (name === lmToolNames.chromiumGitShow) {
    const { commit } = options.input as ChromiumGitShowToolParameters;
    return chromiumGitShow(chromiumRoot, commit);
  }

  throw new Error(`Tool not found: ${name}`);
}
