// Copied and modified from https://github.com/microsoft/vscode-extension-samples/blob/46f526c39cb454d9d9cb9b3adbe86ba2c9a2ee12/chat-sample/src/toolsPrompt.tsx

import {
  AssistantMessage,
  BasePromptElementProps,
  Chunk,
  PromptElement,
  PromptMetadata,
  PromptPiece,
  PromptSizing,
  ToolCall,
  ToolMessage,
  ToolResult,
  UserMessage,
} from "@vscode/prompt-tsx";
import * as vscode from "vscode";

import { invokePrivateTool } from "./tools";

export interface ToolCallRound {
  response: string;
  toolCalls: vscode.LanguageModelToolCallPart[];
}

interface ToolCallsProps extends BasePromptElementProps {
  chromiumRoot: vscode.Uri;
  toolCallRounds: ToolCallRound[];
  toolCallResults: Record<string, vscode.LanguageModelToolResult>;
  toolInvocationToken: vscode.ChatParticipantToolToken | undefined;
}

/**
 * Render a set of tool calls, which look like an AssistantMessage with a set of tool calls followed by the associated UserMessages containing results.
 */
export class ToolCalls extends PromptElement<ToolCallsProps, void> {
  async render(_state: void, _sizing: PromptSizing) {
    if (!this.props.toolCallRounds.length) {
      return undefined;
    }

    // Note- for the copilot models, the final prompt must end with a non-tool-result UserMessage
    return (
      <>
        {this.props.toolCallRounds.map((round) =>
          this.renderOneToolCallRound(round),
        )}
        <UserMessage>
          Above is the result of calling one or more tools. The user cannot see
          the results, so you should explain them to the user if referencing
          them in your answer.
        </UserMessage>
      </>
    );
  }

  private renderOneToolCallRound(round: ToolCallRound) {
    const assistantToolCalls: ToolCall[] = round.toolCalls.map((tc) => ({
      type: "function",
      function: { name: tc.name, arguments: JSON.stringify(tc.input) },
      id: tc.callId,
    }));
    return (
      <Chunk>
        <AssistantMessage toolCalls={assistantToolCalls}>
          {round.response}
        </AssistantMessage>
        {round.toolCalls.map((toolCall) => (
          <ToolResultElement
            chromiumRoot={this.props.chromiumRoot}
            toolCall={toolCall}
            toolInvocationToken={this.props.toolInvocationToken}
            toolCallResult={this.props.toolCallResults[toolCall.callId]}
          />
        ))}
      </Chunk>
    );
  }
}

interface ToolResultElementProps extends BasePromptElementProps {
  chromiumRoot: vscode.Uri;
  toolCall: vscode.LanguageModelToolCallPart;
  toolInvocationToken: vscode.ChatParticipantToolToken | undefined;
  toolCallResult: vscode.LanguageModelToolResult | undefined;
}

/**
 * One tool call result, which either comes from the cache or from invoking the tool.
 */
class ToolResultElement extends PromptElement<ToolResultElementProps, void> {
  async render(
    _state: void,
    _sizing: PromptSizing,
  ): Promise<PromptPiece | undefined> {
    const tool = vscode.lm.tools.find(
      (t) => t.name === this.props.toolCall.name,
    );
    if (!tool) {
      console.error(`Tool not found: ${this.props.toolCall.name}`);
      return (
        <ToolMessage toolCallId={this.props.toolCall.callId}>
          Tool not found
        </ToolMessage>
      );
    }

    const toolResult =
      this.props.toolCallResult ??
      (await invokePrivateTool(
        this.props.chromiumRoot,
        this.props.toolCall.name,
        {
          input: this.props.toolCall.input,
          toolInvocationToken: this.props.toolInvocationToken,
        },
      ));

    return (
      <ToolMessage toolCallId={this.props.toolCall.callId}>
        <meta
          value={new ToolResultMetadata(this.props.toolCall.callId, toolResult)}
        ></meta>
        <ToolResult data={toolResult} />
      </ToolMessage>
    );
  }
}

export class ToolResultMetadata extends PromptMetadata {
  constructor(
    public toolCallId: string,
    public result: vscode.LanguageModelToolResult,
  ) {
    super();
  }
}

export interface ToolCallsMetadata {
  toolCallRounds: ToolCallRound[];
  toolCallResults: Record<string, vscode.LanguageModelToolResult>;
}

export interface TsxToolUserMetadata {
  toolCallsMetadata: ToolCallsMetadata;
}
