import { setTimeout } from "node:timers/promises";

import {
  AssistantMessage,
  BasePromptElementProps,
  PromptElement,
  PromptSizing,
  UserMessage,
  renderPrompt,
} from "@vscode/prompt-tsx";
import * as vscode from "vscode";

import type { PromisifiedExecError } from "./common";
import { chatParticipantId } from "./constants";
import Logger from "./logging";
import { exec } from "./utils";

const DEPS_REGEX = new RegExp(`chromium_version':\n +'(.+?)',`, "m");
const TERMINAL_SELECTION_PREAMBLE = "The active terminal's selection:\n";

// Copied from https://github.com/electron/electron/blob/3a3595f2af59cb08fb09e3e2e4b7cdf713db2b27/script/release/notes/notes.ts#L605-L623
const compareChromiumVersions = (v1: string, v2: string) => {
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

async function getChromiumVersions(
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

async function getChromiumVersionCommitDate(
  chromiumRoot: vscode.Uri,
  version: string,
) {
  try {
    const sha = await exec(`git rev-list -1 tags/${version}`, {
      cwd: chromiumRoot.fsPath,
      encoding: "utf8",
    }).then(({ stdout }) => stdout.trim());
    return await exec(`git log -n 1 --format="%cd" ${sha}`, {
      cwd: chromiumRoot.fsPath,
      encoding: "utf8",
    }).then(({ stdout }) => stdout.trim());
  } catch (err) {
    if (
      err instanceof Error &&
      Object.prototype.hasOwnProperty.call(err, "code")
    ) {
      if ((err as PromisifiedExecError).code === 128) {
        // TODO
        Logger.debug("Tag for Chromium version not found");
      }
    }
  }

  return null;
}

interface DetermineErrorTypeProps extends BasePromptElementProps {
  errorText: string;
}

class DetermineErrorTypePrompt extends PromptElement<DetermineErrorTypeProps> {
  override async prepare() {}

  async render(_state: void, _sizing: PromptSizing) {
    return (
      <>
        <AssistantMessage>
          Analyze the following error and determine which phase of the Chromium
          build process it occurred in. Respond with ONLY one of the following:
          'SYNC', 'BUILD', or 'UNKNOWN'. Do not provide explanation. Return
          'UNKNOWN' unless you're absolutely sure.
        </AssistantMessage>
        <UserMessage>
          Here is the user's error:
          <br />
          {this.props.errorText}
        </UserMessage>
      </>
    );
  }
}

enum ErrorType {
  SYNC = "SYNC",
  BUILD = "BUILD",
  UNKNOWN = "UNKNOWN",
}

async function determineErrorType(
  model: vscode.LanguageModelChat,
  errorText: string,
  token: vscode.CancellationToken,
) {
  const { messages } = await renderPrompt(
    DetermineErrorTypePrompt,
    { errorText },
    { modelMaxPromptTokens: 16384 },
    model,
  );
  const response = await model.sendRequest(messages, {}, token);
  let result = "";
  for await (const fragment of response.text) {
    result += fragment;
  }

  if (result.trim() === "SYNC") {
    return ErrorType.SYNC;
  } else if (result.trim() === "BUILD") {
    return ErrorType.BUILD;
  }

  if (result.trim() !== "UNKNOWN") {
    Logger.error(`Unexpected response from model: ${result}`);
  }

  return ErrorType.UNKNOWN;
}

function extractTerminalSelectionText(
  terminalSelection: vscode.ChatPromptReference,
) {
  const text = terminalSelection.value as string;

  if (text.startsWith(TERMINAL_SELECTION_PREAMBLE)) {
    return text.slice(TERMINAL_SELECTION_PREAMBLE.length);
  } else {
    Logger.warn("Expected terminal selection to start with preamble");
  }

  return text;
}

export function registerChatParticipant(
  { extensionUri, languageModelAccessInformation }: vscode.ExtensionContext,
  electronRoot: vscode.Uri,
) {
  const chromiumRoot = vscode.Uri.joinPath(electronRoot, "..");

  const handler: vscode.ChatRequestHandler = async (
    request: vscode.ChatRequest,
    _context: vscode.ChatContext,
    stream: vscode.ChatResponseStream,
    token: vscode.CancellationToken,
  ): Promise<vscode.ChatResult> => {
    console.log(_context.history);
    console.log(request.references);
    console.log(request.toolReferences);
    if (!languageModelAccessInformation.canSendRequest(request.model)) {
      stream.markdown(
        "This extension cannot use the selected model. Please choose a different model.",
      );
      return {};
    }

    if (request.command === "upgradesFindCL") {
      if (request.prompt) {
        stream.markdown("Cannot process prompt after the command.");
      } else if (
        !request.references.find(
          (reference) => reference.id === "copilot.terminalSelection",
        )
      ) {
        stream.markdown(
          "This command requires you attach the 'Terminal Selection' context.",
        );
      } else {
        const terminalSelection = request.references.find(
          (reference) => reference.id === "copilot.terminalSelection",
        )!;
        const terminalSelectionText =
          extractTerminalSelectionText(terminalSelection);

        if (terminalSelectionText === "") {
          stream.markdown("Terminal selection is empty.");
          return {};
        }

        stream.progress("Checking current git branch...");
        const branchName = await exec("git rev-parse --abbrev-ref HEAD", {
          cwd: electronRoot.fsPath,
          encoding: "utf8",
        }).then(({ stdout }) => stdout.trim());
        if (branchName !== "roller/chromium/main") {
          stream.markdown(
            "Confirm you have a Chromium roll branch checked out - only `roller/chromium/main is supported for now.",
          );
          return {};
        }
        stream.progress("Determining Chromium versions...");
        const versions = await getChromiumVersions(electronRoot, branchName);
        if (!versions.previousVersion || !versions.newVersion) {
          stream.markdown(
            "Couldn't determine Chromium versions from local checkout.",
          );
          return {};
        }
        // if (compareChromiumVersions(versions.newVersion, versions.previousVersion) <= 0) {
        //   stream.markdown(
        //     "Chromium version in this branch is the same or older than `origin/main`.",
        //   );
        //   return {};
        // }
        stream.progress("Analyzing terminal selection...");
        const errorType = await determineErrorType(
          request.model,
          terminalSelectionText,
          token,
        );
        if (errorType === ErrorType.SYNC) {
          stream.progress("Analyzing sync error...");
        } else if (errorType === ErrorType.BUILD) {
          stream.progress("Analyzing build error...");
        } else if (errorType === ErrorType.UNKNOWN) {
          stream.markdown(
            "Could not determine the error type from the terminal selection.",
          );
          return {};
        }
        await setTimeout(3000);
        stream.markdown("TODO");
        return {};
      }
    } else {
      stream.markdown("Sorry, I can only respond to specific commands.");
    }

    return {};
  };

  const participant = vscode.chat.createChatParticipant(
    chatParticipantId,
    handler,
  );
  participant.iconPath = vscode.Uri.joinPath(
    extensionUri,
    "resources",
    "icons",
    "electron_logo.png",
  );
}
