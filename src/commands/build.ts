import * as vscode from "vscode";

import {
  blankConfigEnumValue,
  buildTargets,
  buildToolsExecutable,
} from "../constants";
import {
  default as ExtensionState,
  ExtensionOperation,
} from "../extensionState";
import { runAsTask } from "../tasks";
import { ExtensionConfig } from "../types";
import { getConfigDefaultTarget } from "../utils";

export function registerBuildCommands(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    ExtensionState.registerExtensionOperationCommand(
      ExtensionOperation.BUILD,
      "electron-build-tools.build",
      () => {
        vscode.window.showErrorMessage("Can't build, other work in-progress");
      },
      async () => {
        const operationName = "Electron Build Tools - Building";

        const buildConfig = vscode.workspace.getConfiguration(
          "electronBuildTools.build"
        );
        const options = Object.entries(
          buildConfig.get<ExtensionConfig.BuildOptions>("buildOptions")!
        ).reduce((opts, [key, value]) => {
          opts.push(`${key} ${value}`.trim());
          return opts;
        }, [] as string[]);
        const ninjaArgs = Object.entries(
          buildConfig.get<ExtensionConfig.NinjaArgs>("ninjaArgs")!
        ).reduce((opts, [key, value]) => {
          opts.push(`${key} ${value}`.trim());
          return opts;
        }, [] as string[]);

        let settingsDefaultTarget = buildConfig.get<string>("defaultTarget");
        settingsDefaultTarget =
          settingsDefaultTarget === blankConfigEnumValue
            ? ""
            : settingsDefaultTarget;
        let target = settingsDefaultTarget;

        let quickPick: vscode.QuickPick<vscode.QuickPickItem> | undefined;

        if (buildConfig.get<boolean>("showTargets")) {
          // Settings default target takes precedence
          const defaultTarget =
            settingsDefaultTarget ?? (await getConfigDefaultTarget());
          const quickPickItems: vscode.QuickPickItem[] = [];

          if (defaultTarget) {
            quickPickItems.push({
              label: defaultTarget,
              description: `Default from ${
                settingsDefaultTarget ? "Settings" : "Config"
              }`,
            });
          } else {
            quickPickItems.push({
              label: "electron",
              description: "Default",
            });
          }

          for (const buildTarget of buildTargets) {
            if (buildTarget !== quickPickItems[0].label) {
              quickPickItems.push({
                label: buildTarget,
              });
            }
          }

          quickPick = vscode.window.createQuickPick();
          quickPick.items = quickPickItems;
          quickPick.placeholder = "Target To Build";
        }

        if (quickPick) {
          const userQuit = await new Promise((resolve) => {
            quickPick!.onDidAccept(() => {
              target = quickPick!.selectedItems[0].label ?? target;
              quickPick!.hide();
              resolve();
            });
            quickPick!.onDidHide(() => {
              resolve(true);
            });
            quickPick!.show();
          });

          if (userQuit) {
            return;
          }
        }

        const command = [
          buildToolsExecutable,
          "build",
          ...options,
          target,
          ...ninjaArgs,
        ]
          .join(" ")
          .trim();

        const buildEnv = {
          ...process.env,
          NINJA_STATUS: "%p %f/%t ",
        };

        let lastBuildProgress = -1;

        const task = runAsTask({
          context,
          operationName,
          taskName: "build",
          command,
          shellOptions: { env: buildEnv },
          problemMatchers: "$electron",
        });

        task.onDidWriteLine(({ progress, line }) => {
          if (/Regenerating ninja files/.test(line)) {
            progress.report({
              message: "Regenerating Ninja Files",
              increment: 0,
            });
          } else {
            const buildProgress = parseInt(line.split("%")[0].trim());

            if (!isNaN(buildProgress)) {
              if (buildProgress > lastBuildProgress) {
                progress.report({
                  message: "Compiling",
                  increment: buildProgress - lastBuildProgress,
                });
                lastBuildProgress = buildProgress;
              }
            } else {
              if (/Running.*goma/.test(line)) {
                progress.report({ message: "Starting Goma" });
              } else if (/Running.*ninja/.test(line)) {
                progress.report({ message: "Starting Ninja" });
              }
            }
          }
        });

        await task.finished;
      }
    )
  );
}
