import * as path from "path";

import * as vscode from "vscode";

const importRegex = /^[ \t]*import[ \t]*\(\s*[\"\'](.*)[\"\']\s*\)\s*$/gm;
const scriptRegex = /^[ \t]*script[ \t]*=[ \t]*[\"\'](.*)[\"\'][ \t]*$/gm;

const linkRegexes = [importRegex, scriptRegex];

export class GnLinkProvider implements vscode.DocumentLinkProvider {
  constructor(private readonly _electronRoot: vscode.Uri) {}

  provideDocumentLinks(
    document: vscode.TextDocument,
    token: vscode.CancellationToken
  ): vscode.ProviderResult<vscode.DocumentLink[]> {
    const links: vscode.DocumentLink[] = [];
    const text = document.getText();

    for (const regex of linkRegexes) {
      for (const match of text.matchAll(regex)) {
        if (match.index !== undefined) {
          const link = match[1];
          const linkIdx = match[0].indexOf(link);

          const linkRange = new vscode.Range(
            document.positionAt(match.index + linkIdx),
            document.positionAt(match.index + linkIdx + link.length)
          );

          if (link.startsWith("//")) {
            // Relative to Chromium's root
            links.push(
              new vscode.DocumentLink(
                linkRange,
                vscode.Uri.joinPath(this._electronRoot, "..", link.slice(2))
              )
            );
          } else {
            // Relative to the document's location
            // TODO - Properly handle files which may not have a file path
            links.push(
              new vscode.DocumentLink(
                linkRange,
                vscode.Uri.file(
                  path.join(path.dirname(document.uri.fsPath), link)
                )
              )
            );
          }
        }
      }
    }

    return links;
  }
}
