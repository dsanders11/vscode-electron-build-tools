import * as vscode from "vscode";

export class SnippetProvider implements vscode.CompletionItemProvider {
  public static readonly DOCUMENT_SELECTOR: vscode.DocumentSelector = [
    { language: "cpp" },
    { language: "javascript" },
    { language: "objective-cpp" },
    { language: "typescript" },
  ];
  public static readonly TRIGGER_CHARACTERS = ["/", " ", "F", "f", "T", "t"];

  provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken,
    context: vscode.CompletionContext
  ): vscode.ProviderResult<
    vscode.CompletionItem[] | vscode.CompletionList<vscode.CompletionItem>
  > {
    const items = [];

    switch (document.languageId) {
      case "cpp":
        items.push(...this._commentCompletions(document, position));
        break;

      case "javascript":
        items.push(...this._commentCompletions(document, position));
        break;

      case "objective-cpp":
        items.push(...this._commentCompletions(document, position));
        break;

      case "typescript":
        items.push(...this._commentCompletions(document, position));
        break;
    }

    return new vscode.CompletionList(items, true);
  }

  private _commentCompletions(
    document: vscode.TextDocument,
    position: vscode.Position
  ) {
    const range = document.getWordRangeAtPosition(
      position,
      /[\/]{1,2}(?:$|\s+[FfTt]*)/
    );

    if (range !== undefined) {
      const fixMeComment = new vscode.CompletionItem(
        "// FIXME",
        vscode.CompletionItemKind.Snippet
      );
      fixMeComment.detail = "A '// FIXME(...):' comment.";
      fixMeComment.insertText = new vscode.SnippetString(
        "// FIXME(${1}): ${2}"
      );
      fixMeComment.range = range;

      const todoComment = new vscode.CompletionItem(
        "// TODO",
        vscode.CompletionItemKind.Snippet
      );
      todoComment.detail = "A '// TODO(...):' comment.";
      todoComment.insertText = new vscode.SnippetString("// TODO(${1}): ${2}");
      todoComment.range = range;

      return [fixMeComment, todoComment];
    }

    return [];
  }
}
