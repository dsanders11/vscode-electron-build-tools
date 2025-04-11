import {
  AssistantMessage,
  BasePromptElementProps,
  PromptElement,
  PromptSizing,
  UserMessage,
} from "@vscode/prompt-tsx";
import * as vscode from "vscode";

import { ToolCalls, ToolCallRound } from "./toolsPrompts";

interface FindUpstreamFileProps extends BasePromptElementProps {
  fileContents: string;
}

export class FindUpstreamFilePrompt extends PromptElement<FindUpstreamFileProps> {
  override async prepare() {}

  async render(_state: void, _sizing: PromptSizing) {
    return (
      <>
        <AssistantMessage>
          Here is the file content:
          <br />
          {this.props.fileContents}
        </AssistantMessage>
        <UserMessage>
          Does this file look like it was derived from an upstream Chromium
          file? If so, provide ONLY the full path Chromium filename, no other
          output. Otherwise respond with just "No". Do not provide any other
          output.
        </UserMessage>
      </>
    );
  }
}

interface DetermineErrorTypeProps extends BasePromptElementProps {
  errorText: string;
}

export class DetermineErrorTypePrompt extends PromptElement<DetermineErrorTypeProps> {
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

interface DetermineBuildErrorFileProps extends BasePromptElementProps {
  errorText: string;
}

export class DetermineBuildErrorFilePrompt extends PromptElement<DetermineBuildErrorFileProps> {
  override async prepare() {}

  async render(_state: void, _sizing: PromptSizing) {
    return (
      <>
        <AssistantMessage>
          Analyze the following build error and determine which file the error
          occurred in. Respond with ONLY the full path to the file, no other
          output. Do not provide explanation.
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

interface AnalyzeBuildErrorProps extends BasePromptElementProps {
  chromiumRoot: vscode.Uri;
  errorText: string;
  previousChromiumVersion: string;
  newChromiumVersion: string;
  toolCallRounds: ToolCallRound[];
  toolCallResults: Record<string, vscode.LanguageModelToolResult>;
  toolInvocationToken: vscode.ChatParticipantToolToken | undefined;
}

export class AnalyzeBuildErrorPrompt extends PromptElement<AnalyzeBuildErrorProps> {
  override async prepare() {}

  async render(_state: void, _sizing: PromptSizing) {
    return (
      <>
        <AssistantMessage>
          Suggest a list of Chromium CLs that might be the cause of the user's
          build error after upgrading the Chromium version. Analyze each page of
          the Chromium log (using the provided tools) for the changes between $
          {this.props.previousChromiumVersion} and $
          {this.props.newChromiumVersion}. DO NOT GIVE UP until you have checked
          all pages of the log and no more commits are found. DO NOT ASK THE
          USER WHAT THEY WANT TO DO. ALWAYS ask for the next sequential page
          number, do not use a page number you have already asked for, do not
          ask for a page number that is not the next sequential page number, do
          not skip page numbers.
          <br />
          For any commit in the log which might be the cause of the build error,
          request the full commit details (using the provided tools) to
          determine if it is causing the build error. ALWAYS mention which page
          of the log that commit is on. YOU MUST mention the page of the log the
          commit is on. If it looks like it causes the build error, stop
          checking the log and output the commit details. Do not stop for any
          other reason.
          <br />
          List Chromium CLs by the value of \`Reviewed-on\` in the commit
          message.
        </AssistantMessage>
        <UserMessage>
          Here is the user's error:
          <br />
          {this.props.errorText}
        </UserMessage>
        <ToolCalls
          chromiumRoot={this.props.chromiumRoot}
          toolCallRounds={this.props.toolCallRounds}
          toolInvocationToken={this.props.toolInvocationToken}
          toolCallResults={this.props.toolCallResults}
        />
      </>
    );
  }
}

interface AnalyzeSyncErrorProps extends BasePromptElementProps {
  chromiumRoot: vscode.Uri;
  errorText: string;
  gitDiffOutput: string;
  toolCallRounds: ToolCallRound[];
  toolCallResults: Record<string, vscode.LanguageModelToolResult>;
  toolInvocationToken: vscode.ChatParticipantToolToken | undefined;
}

export class AnalyzeSyncErrorPrompt extends PromptElement<AnalyzeSyncErrorProps> {
  override async prepare() {}

  async render(_state: void, _sizing: PromptSizing) {
    return (
      <>
        <AssistantMessage>
          Suggest a list of Chromium CLs that might be the cause of the user's
          merge conflict when applying Electron's patches. Analyze the git log
          (using the provided tools) for the files with merge conflicts. For
          each file, check the git log for commits.
          <br />
          For any commit which might be the cause of the merge conflict, request
          the full commit details (using the provided tools) to determine if it
          is causing the merge conflict.
          <br />
          List Chromium CLs by the value of \`Reviewed-on\` in the commit
          message.
        </AssistantMessage>
        <UserMessage>
          Here is the user's error:
          <br />
          {this.props.errorText}
        </UserMessage>
        <UserMessage>
          Here is the output of `git diff` after the patch failed to apply:
          <br />
          {this.props.gitDiffOutput}
        </UserMessage>
        <ToolCalls
          chromiumRoot={this.props.chromiumRoot}
          toolCallRounds={this.props.toolCallRounds}
          toolInvocationToken={this.props.toolInvocationToken}
          toolCallResults={this.props.toolCallResults}
        />
      </>
    );
  }
}

interface SearchChromiumCommitsProps extends BasePromptElementProps {
  chromiumRoot: vscode.Uri;
  prompt: string;
  startChromiumVersion: string;
  endChromiumVersion: string;
  toolCallRounds: ToolCallRound[];
  toolCallResults: Record<string, vscode.LanguageModelToolResult>;
  toolInvocationToken: vscode.ChatParticipantToolToken | undefined;
}

export class SearchChromiumCommitsPrompt extends PromptElement<SearchChromiumCommitsProps> {
  override async prepare() {}

  async render(_state: void, _sizing: PromptSizing) {
    return (
      <>
        <AssistantMessage>
          Suggest a list of Chromium CLs that might be related to the user's
          query. Analyze each page of the Chromium log (using the provided
          tools) for the changes between ${this.props.startChromiumVersion} and
          ${this.props.endChromiumVersion}. DO NOT GIVE UP until you have
          checked all pages of the log and no more commits are found. DO NOT ASK
          THE USER WHAT THEY WANT TO DO.
          <br />
          For any commit in the log which might be related to the user's query,
          request the full commit details (using the provided tools) to
          determine if it is. If it looks like it's related to the user's query,
          stop checking the log and output the commit details. Do not stop for
          any other reason.
          <br />
          List Chromium CLs by the value of \`Reviewed-on\` in the commit
          message.
        </AssistantMessage>
        <UserMessage>
          Here is the user's query:
          <br />
          {this.props.prompt}
        </UserMessage>
        <ToolCalls
          chromiumRoot={this.props.chromiumRoot}
          toolCallRounds={this.props.toolCallRounds}
          toolInvocationToken={this.props.toolInvocationToken}
          toolCallResults={this.props.toolCallResults}
        />
      </>
    );
  }
}
