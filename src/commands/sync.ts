import * as vscode from "vscode";

import { buildToolsExecutable } from "../constants";
import { runAsTask } from "../tasks";
import { registerCommandNoBusy, withBusyState } from "../utils";

export function registerSyncCommands(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    registerCommandNoBusy(
      "electron-build-tools.sync",
      () => {
        vscode.window.showErrorMessage("Can't sync, other work in-progress");
      },
      async (force?: boolean) => {
        return withBusyState(async () => {
          const command = `${buildToolsExecutable} sync${
            force ? " --force" : ""
          }`;
          const operationName = `Electron Build Tools - ${
            force ? "Force " : ""
          }Syncing`;

          let initialProgress = false;

          const task = runAsTask(
            context,
            operationName,
            "sync",
            command,
            undefined,
            undefined,
            (exitCode) => {
              if (exitCode === 1 && !force) {
                const confirm = "Force";

                vscode.window
                  .showErrorMessage("Sync failed. Try force sync?", confirm)
                  .then((value) => {
                    if (value && value === confirm) {
                      vscode.commands.executeCommand(
                        "electron-build-tools.sync",
                        true
                      );
                    }
                  });

                return true;
              }
            }
          );

          task.onDidWriteLine(({ progress, line }) => {
            // TODO - Regex for syncing dependencies: /^(\S+)\s+\(Elapsed: ([:\d]+)\)$/

            if (/^gclient.*verify_validity:/.test(line)) {
              progress.report({ message: "Verifying Validity" });
            } else if (/running.*apply_all_patches\.py/.test(line)) {
              progress.report({ message: "Applying Patches" });
            } else if (/Hook.*apply_all_patches\.py.*took/.test(line)) {
              progress.report({ message: "Finishing Up" });
            } else if (!initialProgress) {
              initialProgress = true;
              progress.report({ message: "Dependencies" });
            }
          });

          await task.finished;
        });
      }
    ),
    vscode.commands.registerCommand("electron-build-tools.sync.force", () => {
      return vscode.commands.executeCommand("electron-build-tools.sync", true);
    })
  );
}
