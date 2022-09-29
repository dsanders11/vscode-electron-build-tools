import * as path from "path";

import * as vscode from "vscode";

import { Markdown } from "./common";
import type { DocsLinkablesProvider } from "./docsLinkablesProvider";
import { ensurePosixSeparators } from "./utils";

export class DocsLinkCompletionProvider
  implements vscode.CompletionItemProvider
{
  // Trigger often and let the regex detect if we're in a link
  public static readonly TRIGGER_CHARACTERS = [
    ..."(.-#",
    ..."abcdefghijklmnopqrstuvwxyz",
    ..."abcdefghijklmnopqrstuvwxyz".toUpperCase(),
    ..."0123456789",
  ];

  constructor(private readonly _linkablesProvider: DocsLinkablesProvider) {}

  async provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken,
    context: vscode.CompletionContext
  ): Promise<vscode.CompletionList<vscode.CompletionItem>> {
    const baseDir = path.dirname(document.uri.path);
    const completions: vscode.CompletionItem[] = [];

    const line = document.lineAt(position);
    const linkMatches = Array.from(line.text.matchAll(Markdown.linkPattern));

    if (linkMatches.length) {
      for (const linkWordMatch of linkMatches) {
        const fullLinkText = linkWordMatch[0];
        const linkText = linkWordMatch[5];
        const hashIdx = linkText.indexOf("#");

        const matchIdx = linkWordMatch.index || 0;
        const positionWithinLink = position.character - matchIdx;
        const linkDefinitionBegin = fullLinkText.indexOf("(");
        const linkDefinitionEnd = fullLinkText.indexOf(")");

        // Only provide completions if the cursor is within the link part of a Markdown link
        if (
          linkDefinitionBegin < positionWithinLink &&
          positionWithinLink <= linkDefinitionEnd
        ) {
          if (
            context.triggerCharacter === "#" ||
            (hashIdx !== -1 && positionWithinLink >= hashIdx)
          ) {
            // Provide completions to linkables within the linked file
            const filename = linkText.split("#")[0];
            const linkedFilePath = vscode.Uri.file(
              path.join(baseDir, filename)
            );
            const linkables = (
              await this._linkablesProvider.getLinkables()
            ).filter((linkable) => {
              const linkableFilePath = vscode.Uri.joinPath(
                this._linkablesProvider.docsRoot,
                linkable.filename
              );

              return linkableFilePath.fsPath === linkedFilePath.fsPath;
            });

            for (const linkable of linkables) {
              if (linkable.urlFragment) {
                const completion = new vscode.CompletionItem(
                  linkable.urlFragment,
                  vscode.CompletionItemKind.Reference
                );
                completion.detail = "Electron";
                completion.documentation = linkable.text;
                completion.range = new vscode.Range(
                  position.line,
                  matchIdx + linkDefinitionBegin + hashIdx + 2, // After hash
                  position.line,
                  matchIdx + linkDefinitionEnd
                );
                completions.push(completion);
              }
            }
          } else {
            // Provide completions to files within the docs, relative to this
            // file. Exclude fiddles, there's too much noise-to-signal there
            const files = await vscode.workspace.findFiles(
              new vscode.RelativePattern(
                this._linkablesProvider.docsRoot,
                "**/*"
              ),
              new vscode.RelativePattern(
                this._linkablesProvider.docsRoot,
                "fiddles"
              ),
              undefined,
              token
            );

            for (const file of files) {
              const relativePath = ensurePosixSeparators(
                path.relative(baseDir, file.path)
              );

              const completion = new vscode.CompletionItem(
                relativePath,
                vscode.CompletionItemKind.File
              );
              completion.detail = "Electron";
              completion.range = new vscode.Range(
                new vscode.Position(
                  position.line,
                  matchIdx + linkDefinitionBegin + 1
                ),
                new vscode.Position(position.line, matchIdx + linkDefinitionEnd)
              );
              // Feels awkward to have the "../" completions at the start, so push them to the end
              completion.sortText = relativePath.startsWith(".")
                ? `zz-${relativePath}`
                : relativePath;
              completions.push(completion);
            }
          }
        }
      }
    }

    return new vscode.CompletionList(completions, true);
  }
}
