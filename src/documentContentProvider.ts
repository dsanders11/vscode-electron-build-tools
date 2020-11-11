import { exec as callbackExec } from "child_process";
import * as path from "path";
import * as querystring from "querystring";
import { promisify } from "util";

import * as vscode from "vscode";

import { ensurePosixSeparators, patchOverviewMarkdown } from "./utils";

const exec = promisify(callbackExec);

export class TextDocumentContentProvider
  implements vscode.TextDocumentContentProvider {
  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const { checkoutPath, fileIndex, view } = querystring.parse(uri.query);
    let content = "";

    if (view === "contents") {
      const gitCommand = `git show ${fileIndex as string}`;

      const { stdout } = await exec(gitCommand, {
        encoding: "utf8",
        cwd: checkoutPath as string,
      });
      content = stdout.trim();
    } else if (view === "patch-overview") {
      content = (
        await patchOverviewMarkdown(uri.with({ scheme: "file", query: "" }))
      ).value;
    } else {
      throw new Error("Unknown view");
    }

    return content;
  }
}
