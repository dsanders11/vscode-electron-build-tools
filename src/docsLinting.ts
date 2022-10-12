/* eslint-disable @typescript-eslint/naming-convention */

import * as vscode from "vscode";

import Logger from "./logging";
import { OptionalFeature } from "./utils";

const markdownSettings = {
  enabled: true,
  "fileLinks.enabled": "error",
  "fragmentLinks.enabled": "error",
  "referenceLinks.enabled": "error",
};

export function setupDocsLinting(
  context: vscode.ExtensionContext
) {
  context.subscriptions.push(
    new OptionalFeature(
      "electronBuildTools.docs",
      "lintRelativeLinks",
      (shouldLintDocs: boolean) => {
        if (shouldLintDocs) {
          // Turn on the Markdown settings in the workspace
          for (const [setting, value] of Object.entries(markdownSettings)) {
            vscode.workspace
              .getConfiguration("markdown.validate")
              .update(setting, value);
          }

          Logger.info("Docs relative link linting enabled");
        } else {
          // Turn off the Markdown settings in the workspace
          for (const setting in markdownSettings) {
            vscode.workspace
              .getConfiguration("markdown.validate")
              .update(setting, undefined);
          }

          Logger.info("Docs relative link linting disabled");
        }
      }
    )
  );
}
