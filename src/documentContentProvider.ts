import * as path from "path";

import * as vscode from "vscode";

import { pullRequestScheme } from "./constants";
import {
  applyPatch,
  getContentForFileIndex,
  patchedFilenameRegex,
  patchOverviewMarkdown,
  querystringParse,
  ContentNotFoundError,
} from "./utils";

export class TextDocumentContentProvider
  implements vscode.TextDocumentContentProvider
{
  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const {
      checkoutPath,
      fileIndex,
      patch,
      pullRequest,
      view,
      unpatchedFileIndex,
    } = querystringParse(uri.query);
    let content = "";

    if (view === "contents") {
      // Try on-disk/remote first. If that fails:
      //   * If it's a PR, use the PR filesystem
      //   * If it's a patch, apply the patch if unpatched content is found
      try {
        content = await getContentForFileIndex(fileIndex, checkoutPath);
      } catch (err) {
        if (err instanceof ContentNotFoundError) {
          if (pullRequest) {
            content = (
              await vscode.workspace.fs.readFile(
                uri.with({ scheme: pullRequestScheme })
              )
            ).toString();
          } else if (patch) {
            const unpatchedContents = await getContentForFileIndex(
              unpatchedFileIndex,
              checkoutPath
            );
            const patchContents = (
              await vscode.workspace.fs.readFile(vscode.Uri.file(patch))
            ).toString();

            const regexMatches = patchContents.matchAll(patchedFilenameRegex);
            let filePatch: string | undefined = undefined;

            for (const [patch, filename] of regexMatches) {
              if (filename === path.relative(checkoutPath, uri.fsPath)) {
                filePatch = patch;
                break;
              }
            }

            if (!filePatch) {
              throw err;
            }

            content = Buffer.from(
              applyPatch(unpatchedContents, filePatch)
            ).toString();
          } else {
            throw err;
          }
        } else {
          throw err;
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
