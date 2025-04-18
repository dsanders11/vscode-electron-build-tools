import { renderPrompt } from "@vscode/prompt-tsx";
import * as vscode from "vscode";

import { lmToolNames } from "../../constants";
import { exec, getShortSha } from "../../utils";

import { SearchChromiumCommitsPrompt } from "../prompts";
import {
  ChromiumGitLogToolParameters,
  ChromiumGitShowToolParameters,
  EmptyLogPageError,
} from "../tools";
import { ToolResultMetadata, ToolCallRound } from "../toolsPrompts";
import { compareChromiumVersions } from "../utils";

const CONTINUE_SEARCHING_PROMPT = "continue";

export interface SearchCommitsContinuation {
  after: string;
  page: number;
  startChromiumVersion: string;
  endChromiumVersion: string;
}

async function showQuickPick(
  quickPick: vscode.QuickPick<vscode.QuickPickItem>,
) {
  return new Promise<string | undefined>((resolve) => {
    quickPick.onDidAccept(() => {
      resolve(quickPick.selectedItems[0].label);
      quickPick.dispose();
    });
    quickPick.onDidHide(() => {
      resolve(undefined);
      quickPick.dispose();
    });
    quickPick.show();
  });
}

export async function searchChromiumLog(
  chromiumRoot: vscode.Uri,
  request: vscode.ChatRequest,
  stream: vscode.ChatResponseStream,
  tools: vscode.LanguageModelChatTool[],
  startChromiumVersion: string,
  endChromiumVersion: string,
  prompt: string,
  token: vscode.CancellationToken,
  continuation?: SearchCommitsContinuation,
) {
  const { nanoid } = await import("nanoid");

  stream.progress("Searching Chromium git log...");

  const chatConfig = vscode.workspace.getConfiguration(
    "electronBuildTools.chat",
  );
  const pageSize = chatConfig.get<boolean>("chromiumLogPageSize");

  // Render the initial prompt
  let { messages } = await renderPrompt(
    SearchChromiumCommitsPrompt,
    {
      chromiumRoot,
      prompt,
      startChromiumVersion,
      endChromiumVersion,
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
    startVersion: startChromiumVersion,
    endVersion: endChromiumVersion,
    page: continuation?.page ?? 1,
    pageSize,
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

    const processToolCall = async (
      toolCall: vscode.LanguageModelToolCallPart,
    ) => {
      if (toolCall.name === lmToolNames.chromiumLog) {
        stream.progress(
          `Searching page ${chromiumLogToolState.page} of the log...`,
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
        /the next page of the ?(?:Chromium)? log|I will now check page|check the next page|continue (?:analyzing|checking|searching)|continue to ?(?:the next)? page/.test(
          responseStr,
        )
      ) {
        toolCall = new vscode.LanguageModelToolCallPart(
          nanoid(),
          lmToolNames.chromiumLog,
          {},
        );
      } else if (/[0-9a-f]{40}/.test(responseStr)) {
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
            SearchChromiumCommitsPrompt,
            {
              chromiumRoot,
              prompt,
              startChromiumVersion,
              endChromiumVersion,
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
              `Searching page ${chromiumLogToolState.page} of the log...`,
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
      result.metadata as Record<string, SearchCommitsContinuation>
    ).continuation = {
      after: chromiumLogToolState.continueAfter!,
      page: chromiumLogToolState.page,
      startChromiumVersion,
      endChromiumVersion,
    };
  }

  return result;
}

export async function searchCLs(
  chromiumRoot: vscode.Uri,
  _electronRoot: vscode.Uri,
  tools: vscode.LanguageModelChatTool[],
  request: vscode.ChatRequest,
  context: vscode.ChatContext,
  stream: vscode.ChatResponseStream,
  token: vscode.CancellationToken,
) {
  let continuation: SearchCommitsContinuation | undefined;
  let prompt = request.prompt;

  if (request.prompt.toLowerCase() === CONTINUE_SEARCHING_PROMPT) {
    const lastTurn = context.history.at(-1);

    if (lastTurn instanceof vscode.ChatResponseTurn) {
      // Previous request may be several turns back if the user keeps
      // continuing the analysis, so we need to find the last request
      const previousRequestTurn = context.history.findLast(
        (turn) =>
          turn instanceof vscode.ChatRequestTurn &&
          turn.prompt !== CONTINUE_SEARCHING_PROMPT,
      );

      if (previousRequestTurn instanceof vscode.ChatRequestTurn) {
        // Use the previous prompt and tool references for the
        // checks that follow before continuing the analysis
        prompt = previousRequestTurn.prompt;

        // At this point we have everything we need to continue the analysis
        continuation = lastTurn.result.metadata?.continuation;
      }
    }

    if (continuation === undefined) {
      stream.markdown("There is no error analysis in progress.");
      return {};
    }
  }

  let startChromiumVersion: string | undefined;
  let endChromiumVersion: string | undefined;

  if (!continuation) {
    stream.progress("Fetching Chromium versions...");
    const versions = await exec(
      'git tag --sort=version:refname --list "[1-2]??.*.*.*"',
      {
        cwd: chromiumRoot.fsPath,
        encoding: "utf8",
      },
    ).then(({ stdout }) => stdout.trim().split("\n"));

    let quickPick = vscode.window.createQuickPick();
    quickPick.items = versions.map((version) => ({
      label: version,
    }));
    quickPick.title = "Search Chromium CLs";
    quickPick.placeholder = "Choose Chromium start version";
    quickPick.step = 1;
    quickPick.totalSteps = 2;

    startChromiumVersion = await showQuickPick(quickPick);

    if (!startChromiumVersion) {
      return {};
    }

    const remainingVersions = versions.filter(
      (version) => compareChromiumVersions(version, startChromiumVersion!) > 0,
    );

    quickPick = vscode.window.createQuickPick();
    quickPick.items = remainingVersions.map((version) => ({
      label: version,
    }));
    quickPick.title = "Search Chromium CLs";
    quickPick.placeholder = "Choose Chromium end version";
    quickPick.step = 2;
    quickPick.totalSteps = 2;

    endChromiumVersion = await showQuickPick(quickPick);

    if (!endChromiumVersion) {
      return {};
    }
  } else {
    ({ startChromiumVersion, endChromiumVersion } = continuation);
  }

  return searchChromiumLog(
    chromiumRoot,
    request,
    stream,
    tools,
    startChromiumVersion,
    endChromiumVersion,
    prompt,
    token,
    continuation,
  );
}
