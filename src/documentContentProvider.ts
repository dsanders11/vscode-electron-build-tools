import * as vscode from "vscode";

import { pullRequestScheme } from "./constants";
import {
  getContentForFileIndex,
  patchOverviewMarkdown,
  querystringParse,
} from "./utils";

export class TextDocumentContentProvider
  implements vscode.TextDocumentContentProvider {
  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const { checkoutPath, fileIndex, pullRequest, view } = querystringParse(
      uri.query
    );
    let content = "";

    if (view === "contents") {
      if (/^[0]+$/.test(fileIndex)) {
        // Special case where it's all zeroes, so it's an empty file
        content = "";
      } else {
        // Try on-disk first, and if that fails, and it's a PR, use the PR filesystem
        try {
          content = await getContentForFileIndex(fileIndex, checkoutPath);
        } catch (err) {
          if (err && err.code === 128 && pullRequest) {
            content = (
              await vscode.workspace.fs.readFile(
                uri.with({ scheme: pullRequestScheme })
              )
            ).toString();
          } else {
            throw err;
          }
        }
      }
    } else if (view === "patch-overview") {
      const scheme = pullRequest ? pullRequestScheme : "file";
      const query = pullRequest ? `pullRequest=${pullRequest}` : "";

      content = (await patchOverviewMarkdown(uri.with({ scheme, query })))
        .value;
    } else {
      throw new Error("Unknown view");
    }

    return content;
  }
}
