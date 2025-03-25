import { renderPrompt } from "@vscode/prompt-tsx";
import * as vscode from "vscode";

import { lmToolNames } from "../../constants";
import Logger from "../../logging";
import { exec, getShortSha } from "../../utils";

import {
  AnalyzeBuildErrorPrompt,
  AnalyzeSyncErrorPrompt,
  DetermineErrorTypePrompt,
} from "../prompts";
import {
  ChromiumGitLogToolParameters,
  ChromiumGitShowToolParameters,
  EmptyLogPageError,
} from "../tools";
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

const CONTINUE_ANALYSIS_PROMPT = "continue";

export interface AnalyzeBuildErrorContinuation {
  after: string;
  page: number;
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

export async function analyzeSyncError(
  chromiumRoot: vscode.Uri,
  request: vscode.ChatRequest,
  stream: vscode.ChatResponseStream,
  tools: vscode.LanguageModelChatTool[],
  previousChromiumVersion: string,
  _newChromiumVersion: string,
  gitDiffOutput: string,
  errorText: string,
  token: vscode.CancellationToken,
) {
  const previousChromiumVersionDate = await getChromiumVersionCommitDate(
    chromiumRoot,
    previousChromiumVersion,
  );
  if (!previousChromiumVersionDate) {
    stream.markdown(
      "Couldn't determine the commit date for the previous Chromium version. Ensure you've synced recently.",
    );
    return {};
  }

  stream.progress("Analyzing sync error...");

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

    let analyzingGitLogs = false;

    // Stream text output and collect tool calls from the response
    const toolCalls: vscode.LanguageModelToolCallPart[] = [];
    let responseStr = "";
    for await (const part of response.stream) {
      if (part instanceof vscode.LanguageModelTextPart) {
        analyzingGitLogs = false;
        stream.markdown(part.value);
        responseStr += part.value;
      } else if (part instanceof vscode.LanguageModelToolCallPart) {
        toolCalls.push(part);

        if (part.name === lmToolNames.gitLog && !analyzingGitLogs) {
          stream.progress(`Analyzing git logs...`);
          analyzingGitLogs = true;
        } else if (part.name === lmToolNames.gitShow) {
          analyzingGitLogs = false;
          const shortSha = await getShortSha(
            chromiumRoot,
            (part.input as Record<string, string>).commit,
          );
          stream.progress(`Analyzing commit ${shortSha}...`);
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

export async function analyzeBuildError(
  chromiumRoot: vscode.Uri,
  request: vscode.ChatRequest,
  stream: vscode.ChatResponseStream,
  tools: vscode.LanguageModelChatTool[],
  previousChromiumVersion: string,
  newChromiumVersion: string,
  errorText: string,
  token: vscode.CancellationToken,
  continuation?: AnalyzeBuildErrorContinuation,
) {
  stream.progress("Analyzing build error...");

  // Render the initial prompt
  let { messages } = await renderPrompt(
    AnalyzeBuildErrorPrompt,
    {
      chromiumRoot,
      errorText,
      previousChromiumVersion,
      newChromiumVersion,
      toolCallResults: {},
      toolCallRounds: [],
      toolInvocationToken: request.toolInvocationToken,
    },
    { modelMaxPromptTokens: request.model.maxInputTokens },
    request.model,
  );

  // A hackish way to track state for the Chromium log tool without
  // relying on the model to do it since it constantly gets it wrong
  const chromiumLogToolState = {
    startVersion: previousChromiumVersion,
    endVersion: newChromiumVersion,
    page: continuation?.page ?? 1,
    continueAfter: continuation?.after,
  };

  const accumulatedToolResults: Record<string, vscode.LanguageModelToolResult> =
    {};
  const toolCallRounds: ToolCallRound[] = [];
  const runWithTools = async (): Promise<string> => {
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
        // Don't stream out intermediate messages, they're not useful
        responseStr += part.value;
      } else if (part instanceof vscode.LanguageModelToolCallPart) {
        toolCalls.push(part);
        if (part.name === lmToolNames.chromiumLog) {
          stream.progress(
            `Analyzing page ${chromiumLogToolState.page} of the log...`,
          );

          // Inject the Chromium log tool state into the input
          Object.assign(part.input, chromiumLogToolState);

          // Increment the page number for the next call
          chromiumLogToolState.page += 1;
        } else if (part.name === lmToolNames.chromiumGitShow) {
          const shortSha = await getShortSha(
            chromiumRoot,
            (part.input as Record<string, string>).commit,
          );
          stream.progress(`Analyzing commit ${shortSha}...`);
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
      const renderToolCall = async () => {
        const toolCall = toolCalls[0];

        try {
          return await renderPrompt(
            AnalyzeBuildErrorPrompt,
            {
              chromiumRoot,
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
        } catch (error) {
          if (error instanceof EmptyLogPageError) {
            // Continue on to the next page if the commit the
            // user continued from was the last one on that page
            stream.progress(
              `Analyzing page ${chromiumLogToolState.page} of the log...`,
            );

            // Inject the Chromium log tool state into the input
            Object.assign(toolCall.input, chromiumLogToolState);

            // Increment the page number for the next call
            chromiumLogToolState.page += 1;

            return renderToolCall();
          } else {
            throw error;
          }
        }
      };
      const result = await renderToolCall();
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

    return responseStr;
  };

  // The final message should have the most useful info for the user
  const finalResponse = await runWithTools();
  stream.markdown(finalResponse);

  const result: vscode.ChatResult = {
    metadata: {
      // Return tool call metadata so it can be used in prompt history on the next request
      toolCallsMetadata: {
        toolCallResults: accumulatedToolResults,
        toolCallRounds,
      },
    },
  };

  const lastToolCall = toolCallRounds.at(-1)!.toolCalls[0];
  const previousLogToolCall = toolCallRounds.findLast(
    (round) => round.toolCalls[0].name === lmToolNames.chromiumLog,
  )?.toolCalls[0];

  // If the last tool call was getting details for a commit, then we assume there
  // are more commits available in the log to analyze if the user wants to
  if (
    lastToolCall?.name === lmToolNames.chromiumGitShow &&
    previousLogToolCall !== undefined
  ) {
    (result.metadata as Record<string, object>).continuation = {
      after: (lastToolCall.input as ChromiumGitShowToolParameters).commit,
      page: (previousLogToolCall.input as ChromiumGitLogToolParameters).page,
    };
  }

  return result;
}

export async function upgradesFindCL(
  chromiumRoot: vscode.Uri,
  electronRoot: vscode.Uri,
  tools: vscode.LanguageModelChatTool[],
  request: vscode.ChatRequest,
  context: vscode.ChatContext,
  stream: vscode.ChatResponseStream,
  token: vscode.CancellationToken,
) {
  let continuation: AnalyzeBuildErrorContinuation | undefined;
  let prompt = request.prompt;
  let toolReferences = request.toolReferences;

  if (request.prompt.toLowerCase() === CONTINUE_ANALYSIS_PROMPT) {
    const lastTurn = context.history.at(-1);

    if (lastTurn instanceof vscode.ChatResponseTurn) {
      // Previous request may be several turns back if the user keeps
      // continuing the analysis, so we need to find the last request
      const previousRequestTurn = context.history.findLast(
        (turn) =>
          turn instanceof vscode.ChatRequestTurn &&
          turn.prompt !== CONTINUE_ANALYSIS_PROMPT,
      );

      if (previousRequestTurn instanceof vscode.ChatRequestTurn) {
        // Use the previous prompt and tool references for the
        // checks that follow before continuing the analysis
        prompt = previousRequestTurn.prompt;
        toolReferences = previousRequestTurn.toolReferences;

        // At this point we have everything we need to continue the analysis
        continuation = lastTurn.result.metadata?.continuation;
      }
    }

    if (continuation === undefined) {
      stream.markdown("There is no error analysis in progress.");
      return {};
    }
  }

  const terminalSelectionShebang = prompt.trim() === "#terminalSelection";
  const terminalSelectionAttached =
    !!toolReferences.find(
      (reference) => reference.name === lmToolNames.getTerminalSelection,
    ) || terminalSelectionShebang;

  // If prompt is just #terminalSelection, then there's no real prompt
  prompt = terminalSelectionShebang ? "" : prompt;

  if (
    (!prompt && !terminalSelectionAttached) ||
    (prompt && terminalSelectionAttached)
  ) {
    stream.markdown(
      "This command requires you attach the 'Terminal Selection' context or provide the error in the prompt (but not both).",
    );
    return {};
  }

  let errorText: string;

  if (terminalSelectionAttached) {
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

    errorText = terminalSelectionText;
  } else {
    errorText = prompt;
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
    compareChromiumVersions(versions.newVersion, versions.previousVersion) <= 0
  ) {
    stream.markdown(
      "Chromium version in this branch is the same or older than `origin/main`.",
    );
    return {};
  }

  stream.progress("Analyzing terminal selection...");
  const errorType = await determineErrorType(request.model, errorText, token);

  if (errorType === ErrorType.SYNC) {
    const gitDiffOutput = await exec("git diff", {
      cwd: chromiumRoot.fsPath,
      encoding: "utf8",
    }).then(({ stdout }) => stdout.trim());

    await analyzeSyncError(
      chromiumRoot,
      request,
      stream,
      tools,
      versions.previousVersion,
      versions.newVersion,
      gitDiffOutput,
      errorText,
      token,
    );
  } else if (errorType === ErrorType.BUILD) {
    return analyzeBuildError(
      chromiumRoot,
      request,
      stream,
      tools,
      versions.previousVersion,
      versions.newVersion,
      errorText,
      token,
      continuation,
    );
  } else if (errorType === ErrorType.UNKNOWN) {
    stream.markdown(
      "Could not determine the error type from the terminal selection.",
    );
  }

  return {};
}
