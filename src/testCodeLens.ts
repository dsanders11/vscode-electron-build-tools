import * as vscode from "vscode";

import { commandPrefix } from "./constants";
import { TestsTreeDataProvider } from "./views/tests";

export class TestCodeLensProvider implements vscode.CodeLensProvider {
  constructor(private readonly testsProvider: TestsTreeDataProvider) {}

  async provideCodeLenses(
    document: vscode.TextDocument,
    token: vscode.CancellationToken
  ): Promise<vscode.CodeLens[]> {
    const codeLenses = [];
    const regex = /^.*\.?it\(.*['"](.+)['"],.*$/gm;

    for (const match of document.getText().matchAll(regex)) {
      const line = document.lineAt(document.positionAt(match.index!).line);
      const indexOf = line.text.indexOf(match[0]);
      const position = new vscode.Position(line.lineNumber, indexOf);
      const range = document.getWordRangeAtPosition(position, regex);

      if (range) {
        const testName = this.testsProvider.findTestFullyQualifiedName(
          document.uri,
          match[1]
        );

        if (testName) {
          codeLenses.push(
            new vscode.CodeLens(range, {
              title: "Electron Build Tools: Run Test",
              tooltip: "Run only this test",
              command: `${commandPrefix}.runTest`,
              arguments: [testName],
            })
          );
        }
      }
    }

    return codeLenses;
  }
}
