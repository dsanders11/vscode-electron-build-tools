import * as childProcess from "child_process";

import * as vscode from "vscode";

import Logger from "./logging";

export class GnFormattingProvider
  implements vscode.DocumentFormattingEditProvider
{
  private readonly _gnFormatScript: vscode.Uri;

  constructor(private readonly _electronRoot: vscode.Uri) {
    this._gnFormatScript = vscode.Uri.joinPath(
      _electronRoot,
      "script",
      "run-gn-format.py"
    );
  }

  provideDocumentFormattingEdits(
    document: vscode.TextDocument,
    options: vscode.FormattingOptions,
    token: vscode.CancellationToken
  ): vscode.ProviderResult<vscode.TextEdit[]> {
    const text = document.getText();
    let formattedText = "";

    return new Promise((resolve, reject) => {
      const cp = childProcess.spawn(
        "python",
        [this._gnFormatScript.fsPath, "--stdin"],
        {
          cwd: this._electronRoot.fsPath,
        }
      );

      cp.stdout.on("data", (data) => {
        formattedText += data.toString("utf8");
      });

      cp.on("error", (err) => {
        Logger.error(err);
        reject();
      });

      cp.on("exit", (code) => {
        if (code === 0) {
          if (formattedText !== text) {
            resolve([
              vscode.TextEdit.replace(
                new vscode.Range(
                  document.positionAt(0),
                  document.positionAt(text.length)
                ),
                formattedText
              ),
            ]);
          } else {
            resolve(undefined);
          }
        } else {
          Logger.error("gn-format exited with non-zero exit code");
          reject();
        }
      });

      // Write the file content via stdin so we can format the unsaved changes
      cp.stdin.write(text, (err) => {
        if (err) {
          cp.kill();
          Logger.error(err);
          reject();
        } else {
          cp.stdin.end();
        }
      });

      token.onCancellationRequested(() => {
        cp.kill();
        reject();
      });
    });
  }
}
