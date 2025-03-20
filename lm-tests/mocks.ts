import * as vscode from "vscode";

export class MockChatResponseStream implements vscode.ChatResponseStream {
  anchor(): void {}
  button(): void {}
  filetree(): void {}
  markdown(): void {}
  progress(): void {}
  push(): void {}
  reference(): void {}
}
