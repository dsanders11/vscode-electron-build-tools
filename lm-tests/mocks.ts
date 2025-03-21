import * as vscode from "vscode";

export class MockChatResponseStream implements vscode.ChatResponseStream {
  public _markdownMessages: string[] = [];

  anchor(): void {}
  button(): void {}
  filetree(): void {}
  markdown(value: string | vscode.MarkdownString): void {
    if (value instanceof vscode.MarkdownString) {
      value = value.value;
    }
    this._markdownMessages.push(value);
  }
  progress(): void {}
  push(): void {}
  reference(): void {}
}
