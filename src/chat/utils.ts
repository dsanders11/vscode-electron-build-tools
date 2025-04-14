import * as vscode from "vscode";

import Logger from "../logging";
import { exec } from "../utils";

const DEPS_REGEX = new RegExp(`chromium_version':\n +'(.+?)',`, "m");
const TERMINAL_SELECTION_PREAMBLE = "The active terminal's selection:\n";
const TERMINAL_SELECTION_NO_TEXT =
  "No text is currently selected in the active terminal.";

// Copied from https://github.com/electron/electron/blob/3a3595f2af59cb08fb09e3e2e4b7cdf713db2b27/script/release/notes/notes.ts#L605-L623
export const compareChromiumVersions = (v1: string, v2: string) => {
  const [split1, split2] = [v1.split("."), v2.split(".")];

  if (split1.length !== split2.length) {
    throw new Error(
      `Expected version strings to have same number of sections: ${split1} and ${split2}`,
    );
  }
  for (let i = 0; i < split1.length; i++) {
    const p1 = parseInt(split1[i], 10);
    const p2 = parseInt(split2[i], 10);

    if (p1 > p2) {
      return 1;
    } else if (p1 < p2) {
      return -1;
    }
    // Continue checking the value if this portion is equal
  }

  return 0;
};

export async function getChromiumVersions(
  electronRoot: vscode.Uri,
  branchName: string,
): Promise<{
  previousVersion: string | undefined;
  newVersion: string | undefined;
}> {
  const parentSha = await exec(`git merge-base ${branchName} origin/main`, {
    cwd: electronRoot.fsPath,
    encoding: "utf8",
  }).then(({ stdout }) => stdout.trim());
  const { stdout: oldDepsContent } = await exec(`git show ${parentSha}:DEPS`, {
    cwd: electronRoot.fsPath,
    encoding: "utf8",
  });
  const previousVersion = DEPS_REGEX.exec(oldDepsContent)?.[1];

  const newDepsContent = await vscode.workspace.fs.readFile(
    vscode.Uri.joinPath(electronRoot, "DEPS"),
  );
  const newVersion = DEPS_REGEX.exec(newDepsContent.toString())?.[1];

  return { previousVersion, newVersion };
}

export function extractTerminalSelectionText(
  terminalSelection: vscode.LanguageModelToolResult,
) {
  if (!(terminalSelection.content[0] instanceof vscode.LanguageModelTextPart)) {
    throw new Error("Expected terminal selection to have a text value");
  }

  const text = terminalSelection.content[0].value;

  if (text === TERMINAL_SELECTION_NO_TEXT) {
    return "";
  } else if (text.startsWith(TERMINAL_SELECTION_PREAMBLE)) {
    return text.slice(TERMINAL_SELECTION_PREAMBLE.length);
  } else {
    Logger.warn("Expected terminal selection to start with preamble");
  }

  return text;
}
