import * as vscode from "vscode";

import { makeCommandUri, parseMarkdownHeader } from "./utils";

export class DocsHoverProvider implements vscode.HoverProvider {
  provideHover(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): vscode.ProviderResult<vscode.Hover> {
    const line = document.lineAt(position);
    const urlFragment = parseMarkdownHeader(line.text)?.urlFragment;

    if (urlFragment !== undefined) {
      const content = new vscode.MarkdownString(undefined, true);
      content.isTrusted = true;

      const commandUri = makeCommandUri(
        "vscode.copyToClipboard",
        `#${urlFragment}`,
      );
      const commandText = "Copy URL Fragment to Clipboard";
      content.appendMarkdown(`$(link) #${urlFragment}\r\n\r\n`);
      content.appendMarkdown(
        `[${commandText}](${commandUri} "${commandText}")`,
      );

      return new vscode.Hover(content, line.range);
    }

    return null;
  }
}
