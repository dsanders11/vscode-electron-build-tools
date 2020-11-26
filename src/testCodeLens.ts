import * as vscode from "vscode";

import { commandPrefix } from "./constants";
import { TestCollector } from "./views/tests";

export class TestCodeLensProvider implements vscode.CodeLensProvider {
  constructor(private readonly testsCollector: TestCollector) {}

  async provideCodeLenses(
    document: vscode.TextDocument,
    token: vscode.CancellationToken
  ): Promise<vscode.CodeLens[]> {
    const codeLenses: vscode.CodeLens[] = [];

    // Locations of tests are based on the file on-disk, we
    // can't provide the locations for the unsaved changes
    if (document.isDirty) {
      return codeLenses;
    }

    // const symbols = await vscode.commands.executeCommand("vscode.executeDocumentSymbolProvider", document.uri);
    const { runner, tests } = await this.testsCollector.getTestsForUri(
      document.uri
    );

    for (const test of tests) {
      if (test.range !== null) {
        const { start, end } = test.range;
        const range = new vscode.Range(
          start.line,
          start.character,
          end.line,
          end.character
        );

        codeLenses.push(
          new vscode.CodeLens(range, {
            title: "Electron Build Tools: Run Test",
            tooltip: "Run only this test",
            command: `${commandPrefix}.runTest`,
            arguments: [{ runner, test: test.fullTitle }],
          })
        );
      }
    }

    return codeLenses;
  }
}
