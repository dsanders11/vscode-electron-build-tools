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
  GitLogToolParameters,
  GitShowToolParameters,
} from "../tools";
import { ToolResultMetadata, ToolCallRound } from "../toolsPrompts";
import {
  compareChromiumVersions,
  extractTerminalSelectionText,
  getChromiumVersions,
  showQuickPick,
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

export interface AnalyzeSyncErrorContinuation {
  after: string;
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
  newChromiumVersion: string,
  gitDiffOutput: string,
  errorText: string,
  token: vscode.CancellationToken,
  continuation?: AnalyzeSyncErrorContinuation,
) {
  stream.progress("Analyzing sync error...");

  // Render the initial prompt
  let { messages } = await renderPrompt(
    AnalyzeSyncErrorPrompt,
    {
      chromiumRoot,
      errorText,
      gitDiffOutput,
      toolCallResults: {},
      toolCallRounds: [],
      toolInvocationToken: request.toolInvocationToken,
    },
    { modelMaxPromptTokens: request.model.maxInputTokens },
    request.model,
  );

  // A hackish way to track state without relying on the
  // model to do it since it constantly gets it wrong
  const gitLogToolState: Omit<GitLogToolParameters, "filename"> = {
    startVersion: previousChromiumVersion,
    endVersion: newChromiumVersion,
    continueAfter: continuation?.after,
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

        if (part.name === lmToolNames.gitLog) {
          if (!analyzingGitLogs) {
            stream.progress(`Analyzing git logs...`);
            analyzingGitLogs = true;
          }

          // Inject the git log tool state into the input
          Object.assign(part.input, gitLogToolState);
        } else if (part.name === lmToolNames.gitShow) {
          analyzingGitLogs = false;
          const { commit } = part.input as GitShowToolParameters;
          const shortSha = await getShortSha(chromiumRoot, commit);
          stream.progress(`Analyzing commit ${shortSha}...`);

          // Set up continuation state so that the remaining commits
          // on this page will still be analyzed if this one isn't it
          gitLogToolState.continueAfter = commit;
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

  // If the last tool call was getting details for a commit, then we assume there
  // are more commits available to analyze if the user wants to
  if (lastToolCall?.name === lmToolNames.gitShow) {
    (
      result.metadata as Record<string, AnalyzeSyncErrorContinuation>
    ).continuation = {
      after: gitLogToolState.continueAfter!,
    };
  }

  return result;
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
  reverse: boolean = false,
) {
  const { nanoid } = await import("nanoid");

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

  const chatConfig = vscode.workspace.getConfiguration(
    "electronBuildTools.chat",
  );
  const pageSize = chatConfig.get<number>("chromiumLogPageSize")!;

  // A hackish way to track state for the Chromium log tool without
  // relying on the model to do it since it constantly gets it wrong
  const chromiumLogToolState: ChromiumGitLogToolParameters = {
    startVersion: previousChromiumVersion,
    endVersion: newChromiumVersion,
    page: continuation?.page ?? 1,
    pageSize,
    continueAfter: continuation?.after,
    reverse,
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

    const processToolCall = async (
      toolCall: vscode.LanguageModelToolCallPart,
    ) => {
      if (toolCall.name === lmToolNames.chromiumLog) {
        stream.progress(
          `Analyzing page ${chromiumLogToolState.page} of the log...`,
        );

        // Inject the Chromium log tool state into the input
        Object.assign(toolCall.input, chromiumLogToolState);

        // Increment the page number for the next call
        chromiumLogToolState.page += 1;

        // Clear continueAfter so we don't keep passing it
        chromiumLogToolState.continueAfter = undefined;
      } else if (toolCall.name === lmToolNames.chromiumGitShow) {
        const { commit } = toolCall.input as ChromiumGitShowToolParameters;
        const shortSha = await getShortSha(chromiumRoot, commit);
        stream.progress(`Analyzing commit ${shortSha}...`);

        const previousLogToolCall = toolCallRounds.findLast(
          (round) => round.toolCalls[0].name === lmToolNames.chromiumLog,
        )?.toolCalls[0];

        // Set up continuation state so that the remaining commits
        // on this page will still be analyzed if this one isn't it
        chromiumLogToolState.page = (
          previousLogToolCall!.input as ChromiumGitLogToolParameters
        ).page;
        chromiumLogToolState.continueAfter = commit;
      }
    };

    // Stream text output and collect tool calls from the response
    const toolCalls: vscode.LanguageModelToolCallPart[] = [];
    let responseStr = "";
    for await (const part of response.stream) {
      if (part instanceof vscode.LanguageModelTextPart) {
        // Don't stream out intermediate messages, they're not useful
        responseStr += part.value;
      } else if (part instanceof vscode.LanguageModelToolCallPart) {
        toolCalls.push(part);
        processToolCall(part);
      }
    }

    // OpenAI models sometimes get confused and says it's going to call
    // the tool, but doesn't actually do it. This is a hack for that.
    if (toolCalls.length === 0) {
      let toolCall: vscode.LanguageModelToolCallPart | undefined;

      if (
        /the next page of the ?(?:Chromium)? log|I will now ?(?:proceed to)? check page|check the next page|continue (?:analyzing|checking|searching)|continue to ?(?:the next)? page/.test(
          responseStr,
        )
      ) {
        toolCall = new vscode.LanguageModelToolCallPart(
          nanoid(),
          lmToolNames.chromiumLog,
          {},
        );
      } else if (
        /[0-9a-f]{40}/.test(responseStr) &&
        /(?:fetch|retrieve) the full ?(?:commit)? details|(?:further|more) details about this commit|analysis of this commit/.test(
          responseStr,
        )
      ) {
        const commit = responseStr.match(/[0-9a-f]{40}/)![0];

        toolCall = new vscode.LanguageModelToolCallPart(
          nanoid(),
          lmToolNames.chromiumGitShow,
          { commit },
        );
      }

      if (toolCall) {
        processToolCall(toolCall);
        toolCalls.push(toolCall);
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

  // If the last tool call was getting details for a commit, then we assume there
  // are more commits available in the log to analyze if the user wants to
  if (lastToolCall?.name === lmToolNames.chromiumGitShow) {
    (
      result.metadata as Record<string, AnalyzeBuildErrorContinuation>
    ).continuation = {
      after: chromiumLogToolState.continueAfter!,
      page: chromiumLogToolState.page,
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
  advanced: boolean = false,
) {
  let continuation:
    | AnalyzeBuildErrorContinuation
    | AnalyzeSyncErrorContinuation
    | undefined;
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
      continuation as AnalyzeSyncErrorContinuation,
    );
  } else if (errorType === ErrorType.BUILD) {
    let previousChromiumVersion: string | undefined = versions.previousVersion;
    let newChromiumVersion: string | undefined = versions.newVersion;
    let reverse = false;

    if (advanced) {
      let chromiumVersions = await exec(
        'git tag --sort=version:refname --list "[1-2]??.*.*.*"',
        {
          cwd: chromiumRoot.fsPath,
          encoding: "utf8",
        },
      ).then(({ stdout }) => stdout.trim().split("\n"));

      chromiumVersions = chromiumVersions.filter(
        (version) =>
          compareChromiumVersions(version, previousChromiumVersion!) >= 0 &&
          compareChromiumVersions(version, newChromiumVersion!) <= 0,
      );

      let quickPick = vscode.window.createQuickPick<vscode.QuickPickItem>();
      quickPick.title = "Advanced Options";
      quickPick.canSelectMany = true;
      quickPick.items = [
        {
          label: "Reverse",
          detail: "Search the git log in reverse order (oldest to newest)",
        },
      ];
      quickPick.step = 1;
      quickPick.totalSteps = 3;

      const selectedOptions = await showQuickPick(quickPick);

      if (!selectedOptions) {
        return {};
      }

      reverse =
        selectedOptions.find(({ label }) => label === "Reverse") !== undefined;

      quickPick = vscode.window.createQuickPick();
      quickPick.items = chromiumVersions.map((version) => ({
        label: version,
        description:
          version === previousChromiumVersion ? "Default" : undefined,
      }));
      quickPick.title = "Advanced Options";
      quickPick.placeholder = "Choose Chromium start version";
      quickPick.step = 2;
      quickPick.totalSteps = 3;

      previousChromiumVersion = (await showQuickPick(quickPick))?.[0].label;

      if (!previousChromiumVersion) {
        return {};
      }

      const remainingVersions = chromiumVersions
        .filter(
          (version) =>
            compareChromiumVersions(version, previousChromiumVersion!) > 0,
        )
        .reverse();

      quickPick = vscode.window.createQuickPick();
      quickPick.items = remainingVersions.map((version) => ({
        label: version,
        description: version === newChromiumVersion ? "Default" : undefined,
      }));
      quickPick.title = "Advanced Options";
      quickPick.placeholder = "Choose Chromium end version";
      quickPick.step = 3;
      quickPick.totalSteps = 3;

      newChromiumVersion = (await showQuickPick(quickPick))?.[0].label;

      if (!newChromiumVersion) {
        return {};
      }
    }

    return analyzeBuildError(
      chromiumRoot,
      request,
      stream,
      tools,
      previousChromiumVersion,
      newChromiumVersion,
      errorText,
      token,
      continuation as AnalyzeBuildErrorContinuation,
      reverse,
    );
  } else if (errorType === ErrorType.UNKNOWN) {
    stream.markdown(
      "Could not determine the error type from the terminal selection.",
    );
  }

  return {};
}
