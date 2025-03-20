import { renderPrompt } from "@vscode/prompt-tsx";
import * as vscode from "vscode";

import { lmToolNames } from "../../constants";
import Logger from "../../logging";
import { exec } from "../../utils";

import {
  AnalyzeBuildErrorPrompt,
  AnalyzeSyncErrorPrompt,
  DetermineBuildErrorFilePrompt,
  DetermineErrorTypePrompt,
} from "../prompts";
import { ToolResultMetadata, ToolCallRound } from "../toolsPrompts";
import {
  compareChromiumVersions,
  extractTerminalSelectionText,
  getChromiumVersions,
  getChromiumVersionCommitDate,
} from "../utils";

export enum ErrorType {
  SYNC = "SYNC",
  BUILD = "BUILD",
  UNKNOWN = "UNKNOWN",
}

export async function determineErrorType(
  model: vscode.LanguageModelChat,
  errorText: string,
  token: vscode.CancellationToken,
) {
  const { messages } = await renderPrompt(
    DetermineErrorTypePrompt,
    { errorText },
    { modelMaxPromptTokens: model.maxInputTokens },
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

async function analyzeSyncError(
  chromiumRoot: vscode.Uri,
  request: vscode.ChatRequest,
  stream: vscode.ChatResponseStream,
  tools: vscode.LanguageModelChatTool[],
  previousChromiumVersionDate: string,
  errorText: string,
  token: vscode.CancellationToken,
) {
  stream.progress("Analyzing sync error...");

  const gitDiffOutput = await exec("git diff", {
    cwd: chromiumRoot.fsPath,
    encoding: "utf8",
  }).then(({ stdout }) => stdout.trim());

  // Render the initial prompt
  let { messages } = await renderPrompt(
    AnalyzeSyncErrorPrompt,
    {
      chromiumRoot,
      errorText,
      gitDiffOutput,
      previousChromiumVersionDate,
      toolCallResults: {},
      toolCallRounds: [],
      toolInvocationToken: request.toolInvocationToken,
    },
    { modelMaxPromptTokens: request.model.maxInputTokens },
    request.model,
  );

  const accumulatedToolResults: Record<string, vscode.LanguageModelToolResult> =
    {};
  const toolCallRounds: ToolCallRound[] = [];
  const runWithTools = async (): Promise<void> => {
    // Send the request to the LanguageModelChat
    const response = await request.model.sendRequest(
      messages,
      {
        toolMode: vscode.LanguageModelChatToolMode.Auto,
        tools: tools.filter(
          ({ name }) =>
            name === lmToolNames.gitLog || name === lmToolNames.gitShow,
        ),
      },
      token,
    );

    // Stream text output and collect tool calls from the response
    const toolCalls: vscode.LanguageModelToolCallPart[] = [];
    let responseStr = "";
    for await (const part of response.stream) {
      if (part instanceof vscode.LanguageModelTextPart) {
        stream.markdown(part.value);
        responseStr += part.value;
      } else if (part instanceof vscode.LanguageModelToolCallPart) {
        toolCalls.push(part);
      }
    }

    if (toolCalls.length) {
      // If the model called any tools, then we do another round- render the prompt with those tool calls (rendering the PromptElements will invoke the tools)
      // and include the tool results in the prompt for the next request.
      toolCallRounds.push({
        response: responseStr,
        toolCalls,
      });
      const result = await renderPrompt(
        AnalyzeSyncErrorPrompt,
        {
          chromiumRoot,
          errorText,
          gitDiffOutput,
          previousChromiumVersionDate,
          toolCallResults: accumulatedToolResults,
          toolCallRounds,
          toolInvocationToken: request.toolInvocationToken,
        },
        { modelMaxPromptTokens: request.model.maxInputTokens },
        request.model,
      );
      messages = result.messages;
      const toolResultMetadata = result.metadata.getAll(ToolResultMetadata);
      if (toolResultMetadata?.length) {
        // Cache tool results for later, so they can be incorporated into later prompts without calling the tool again
        toolResultMetadata.forEach(
          (meta) => (accumulatedToolResults[meta.toolCallId] = meta.result),
        );
      }

      // This loops until the model doesn't want to call any more tools, then the request is done.
      return runWithTools();
    }
  };

  await runWithTools();

  return {
    metadata: {
      // Return tool call metadata so it can be used in prompt history on the next request
      toolCallsMetadata: {
        toolCallResults: accumulatedToolResults,
        toolCallRounds,
      },
    },
  };
}

async function analyzeBuildError(
  chromiumRoot: vscode.Uri,
  request: vscode.ChatRequest,
  stream: vscode.ChatResponseStream,
  tools: vscode.LanguageModelChatTool[],
  previousChromiumVersion: string,
  newChromiumVersion: string,
  errorText: string,
  token: vscode.CancellationToken,
) {
  stream.progress("Analyzing build error...");

  let { messages } = await renderPrompt(
    DetermineBuildErrorFilePrompt,
    {
      errorText,
    },
    { modelMaxPromptTokens: request.model.maxInputTokens },
    request.model,
  );

  const response = await request.model.sendRequest(messages, {}, token);
  let filename = "";
  for await (const fragment of response.text) {
    filename += fragment;
  }

  const file = vscode.Uri.joinPath(chromiumRoot, "out", "Default", filename);
  const contents = await vscode.workspace.fs.readFile(file);

  // Render the initial prompt
  ({ messages } = await renderPrompt(
    AnalyzeBuildErrorPrompt,
    {
      chromiumRoot,
      fileName: filename,
      fileContents: contents.toString(),
      errorText,
      previousChromiumVersion,
      newChromiumVersion,
      toolCallResults: {},
      toolCallRounds: [],
      toolInvocationToken: request.toolInvocationToken,
    },
    { modelMaxPromptTokens: request.model.maxInputTokens },
    request.model,
  ));

  // A hackish way to track state for the Chromium log tool without
  // relying on the model to do it since it constantly gets it wrong
  const chromiumLogToolState = {
    startVersion: previousChromiumVersion,
    endVersion: newChromiumVersion,
    page: 1,
  };

  const accumulatedToolResults: Record<string, vscode.LanguageModelToolResult> =
    {};
  const toolCallRounds: ToolCallRound[] = [];
  const runWithTools = async (): Promise<void> => {
    // Send the request to the LanguageModelChat
    const response = await request.model.sendRequest(
      messages,
      {
        toolMode: vscode.LanguageModelChatToolMode.Auto,
        tools: tools.filter(
          ({ name }) =>
            name === lmToolNames.chromiumLog ||
            name === lmToolNames.chromiumGitShow,
        ),
      },
      token,
    );

    // Stream text output and collect tool calls from the response
    const toolCalls: vscode.LanguageModelToolCallPart[] = [];
    let responseStr = "";
    for await (const part of response.stream) {
      if (part instanceof vscode.LanguageModelTextPart) {
        stream.markdown(part.value);
        responseStr += part.value;
      } else if (part instanceof vscode.LanguageModelToolCallPart) {
        toolCalls.push(part);
        if (part.name === lmToolNames.chromiumLog) {
          // Inject the Chromium log tool state into the input
          Object.assign(part.input, chromiumLogToolState);

          // Increment the page number for the next call
          chromiumLogToolState.page += 1;
        }
      }
    }

    if (toolCalls.length) {
      // If the model called any tools, then we do another round- render the prompt with those tool calls (rendering the PromptElements will invoke the tools)
      // and include the tool results in the prompt for the next request.
      toolCallRounds.push({
        response: responseStr,
        toolCalls,
      });
      const result = await renderPrompt(
        AnalyzeBuildErrorPrompt,
        {
          chromiumRoot,
          fileName: filename,
          fileContents: contents.toString(),
          errorText,
          previousChromiumVersion,
          newChromiumVersion,
          toolCallResults: accumulatedToolResults,
          // Only provide the last round of tool calls
          toolCallRounds: toolCallRounds.slice(-1),
          toolInvocationToken: request.toolInvocationToken,
        },
        { modelMaxPromptTokens: request.model.maxInputTokens },
        request.model,
      );
      messages = result.messages;
      const toolResultMetadata = result.metadata.getAll(ToolResultMetadata);
      if (toolResultMetadata?.length) {
        // Cache tool results for later, so they can be incorporated into later prompts without calling the tool again
        toolResultMetadata.forEach(
          (meta) => (accumulatedToolResults[meta.toolCallId] = meta.result),
        );
      }

      // This loops until the model doesn't want to call any more tools, then the request is done.
      return runWithTools();
    }
  };

  await runWithTools();

  return {
    metadata: {
      // Return tool call metadata so it can be used in prompt history on the next request
      toolCallsMetadata: {
        toolCallResults: accumulatedToolResults,
        toolCallRounds,
      },
    },
  };
}

export async function upgradesFindCL(
  chromiumRoot: vscode.Uri,
  electronRoot: vscode.Uri,
  tools: vscode.LanguageModelChatTool[],
  request: vscode.ChatRequest,
  stream: vscode.ChatResponseStream,
  token: vscode.CancellationToken,
) {
  if (request.prompt) {
    stream.markdown("Cannot process prompt after the command.");
  } else if (
    !request.toolReferences.find(
      (reference) => reference.name === lmToolNames.getTerminalSelection,
    )
  ) {
    stream.markdown(
      "This command requires you attach the 'Terminal Selection' context.",
    );
  } else {
    const terminalSelection = await vscode.lm.invokeTool(
      lmToolNames.getTerminalSelection,
      { input: {}, toolInvocationToken: request.toolInvocationToken },
      token,
    );
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
    if (
      compareChromiumVersions(versions.newVersion, versions.previousVersion) <=
      0
    ) {
      stream.markdown(
        "Chromium version in this branch is the same or older than `origin/main`.",
      );
      return {};
    }
    const previousChromiumVersionDate = await getChromiumVersionCommitDate(
      chromiumRoot,
      versions.previousVersion,
    );
    if (!previousChromiumVersionDate) {
      stream.markdown(
        "Couldn't determine the commit date for the previous Chromium version. Ensure you've synced recently.",
      );
      return {};
    }
    stream.progress("Analyzing terminal selection...");
    const errorType = await determineErrorType(
      request.model,
      terminalSelectionText,
      token,
    );
    if (errorType === ErrorType.SYNC) {
      await analyzeSyncError(
        chromiumRoot,
        request,
        stream,
        tools,
        previousChromiumVersionDate,
        terminalSelectionText,
        token,
      );
    } else if (errorType === ErrorType.BUILD) {
      await analyzeBuildError(
        chromiumRoot,
        request,
        stream,
        tools,
        versions.previousVersion,
        versions.newVersion,
        terminalSelectionText,
        token,
      );
    } else if (errorType === ErrorType.UNKNOWN) {
      stream.markdown(
        "Could not determine the error type from the terminal selection.",
      );
      return {};
    }
    return {};
  }
}
