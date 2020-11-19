import * as vscode from "vscode";

import { parseMarkdownHeader } from "./utils";

export class DocsHoverProvider implements vscode.HoverProvider {
  provideHover(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken
  ): vscode.ProviderResult<vscode.Hover> {
    const line = document.lineAt(position);
    const header = parseMarkdownHeader(line.text);

    if (header !== undefined) {
      const content = new vscode.MarkdownString(undefined, true);
      content.isTrusted = true;

      // TODO - Use command to add link for copying to clipboard
      content.appendMarkdown(`$(link) #${header.urlFragment}\r\n`);

      return new vscode.Hover(content, line.range);
    }

    return null;
  }
}
