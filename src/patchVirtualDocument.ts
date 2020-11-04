import * as childProcess from "child_process";
import * as querystring from "querystring";
import * as path from "path";

import * as vscode from "vscode";

export class PatchVirtualTextDocumentContentProvider
  implements vscode.TextDocumentContentProvider {
  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const { gitObject, checkoutPath } = querystring.parse(uri.query);
    const relativeFilePath = path
      .relative(checkoutPath as string, uri.fsPath)
      .split(path.sep)
      .join(path.posix.sep);

    const gitCommand = `git show ${gitObject as string}:${relativeFilePath}`;

    return childProcess
      .execSync(gitCommand, {
        encoding: "utf8",
        cwd: checkoutPath as string,
      })
      .trim();
  }
}
