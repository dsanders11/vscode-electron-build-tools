import * as vscode from "vscode";

import { virtualDocumentScheme } from "./constants";
import { querystringParse } from "./utils";

export class ElectronFileDecorationProvider
  implements vscode.FileDecorationProvider
{
  provideFileDecoration(
    uri: vscode.Uri,
    token: vscode.CancellationToken
  ): vscode.ProviderResult<vscode.FileDecoration> {
    if (uri.scheme === virtualDocumentScheme) {
      const { isPatchFile, fileIndexA, fileIndexB } = querystringParse(
        uri.query
      );

      // TBD - Should color be used here? It's a bit much if everything has color
      if (isPatchFile) {
        if (/^[0]+$/.test(fileIndexA)) {
          // All zeroes for fileIndexA indciates it is a new file
          return new vscode.FileDecoration("A", "Added");
        } else if (/^[0]+$/.test(fileIndexB)) {
          // All zeroes for fileIndexB indciates it is a deleted file
          return new vscode.FileDecoration("D", "Deleted");
        } else {
          return new vscode.FileDecoration("M", "Modified");
        }
      }
    }
  }
}
