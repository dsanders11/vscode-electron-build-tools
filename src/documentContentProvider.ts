import * as vscode from "vscode";

import { virtualFsScheme } from "./constants";
import { patchOverviewMarkdown, querystringParse } from "./utils";

export class TextDocumentContentProvider
  implements vscode.TextDocumentContentProvider
{
  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const { view } = querystringParse(uri.query);

    if (view === "contents") {
      return (
        await vscode.workspace.fs.readFile(
          uri.with({ scheme: virtualFsScheme })
        )
      ).toString();
    } else if (view === "patch-overview") {
      const patchContents = (
        await vscode.workspace.fs.readFile(
          uri.with({ scheme: virtualFsScheme })
        )
      ).toString();

      return patchOverviewMarkdown(uri, patchContents).value;
    }

    throw new Error("Unknown view");
  }
}
