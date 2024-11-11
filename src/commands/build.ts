import * as vscode from "vscode";

import {
  blankConfigEnumValue,
  buildTargets,
  buildToolsExecutable,
  commandPrefix,
} from "../constants";
import {
  default as ExtensionState,
  ExtensionOperation,
} from "../extensionState";
import { runAsTask } from "../tasks";
import type { ExtensionConfig } from "../types";
import { getConfigDefaultTarget } from "../utils";

export function registerBuildCommands(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    ExtensionState.registerExtensionOperationCommand(
      ExtensionOperation.BUILD,
      `${commandPrefix}.build`,
      () => {
        vscode.window.showErrorMessage("Can't build, other work in-progress");
      },
      async (advanced?: false) => {
        const operationName = "Electron Build Tools - Building";

        const buildConfig = vscode.workspace.getConfiguration(
          "electronBuildTools.build",
        );
        let options = Object.entries(
          buildConfig.get<ExtensionConfig.BuildOptions>("buildOptions")!,
        ).reduce((opts, [key, value]) => {
          opts.push(`${key} ${value}`.trim());
          return opts;
        }, [] as string[]);
        let ninjaArgs = Object.entries(
          buildConfig.get<ExtensionConfig.NinjaArgs>("ninjaArgs")!,
        ).reduce((opts, [key, value]) => {
          opts.push(`${key} ${value}`.trim());
          return opts;
        }, [] as string[]);

        let settingsDefaultTarget = buildConfig.get<string>("defaultTarget");
        settingsDefaultTarget =
          settingsDefaultTarget === blankConfigEnumValue
            ? undefined
            : settingsDefaultTarget;
        let target = settingsDefaultTarget;

        if (advanced || buildConfig.get<boolean>("showTargets")) {
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

          const quickPick = vscode.window.createQuickPick();
          quickPick.items = quickPickItems;
          quickPick.title = "Build Electron";
          quickPick.placeholder = "Target To Build";

          if (advanced) {
            quickPick.step = 1;
            quickPick.totalSteps = 3;
          }

          target = await new Promise((resolve) => {
            quickPick.onDidAccept(() => {
              resolve(quickPick.selectedItems[0].label ?? target);
              quickPick.dispose();
            });
            quickPick.onDidHide(() => {
              resolve(undefined);
              quickPick.dispose();
            });
            quickPick.show();
          });

          if (!target) {
            return;
          }
        }

        if (advanced) {
          const buildOptionsInput = vscode.window.createInputBox();
          buildOptionsInput.title = "Build Electron";
          buildOptionsInput.prompt = "Build options";
          buildOptionsInput.value = options.join(" ");
          buildOptionsInput.step = 2;
          buildOptionsInput.totalSteps = 3;

          let userQuit = await new Promise((resolve) => {
            buildOptionsInput.onDidAccept(() => {
              resolve(false);
              options = [buildOptionsInput.value];
              buildOptionsInput.dispose();
            });
            buildOptionsInput.onDidHide(() => {
              resolve(true);
              buildOptionsInput.dispose();
            });
            buildOptionsInput.show();
          });

          if (userQuit) {
            return;
          }

          const ninjaArgsInput = vscode.window.createInputBox();
          ninjaArgsInput.title = "Build Electron";
          ninjaArgsInput.prompt = "Ninja args";
          ninjaArgsInput.value = ninjaArgs.join(" ");
          ninjaArgsInput.step = 3;
          ninjaArgsInput.totalSteps = 3;

          userQuit = await new Promise((resolve) => {
            ninjaArgsInput.onDidAccept(() => {
              resolve(false);
              ninjaArgs = [ninjaArgsInput.value];
              ninjaArgsInput.dispose();
            });
            ninjaArgsInput.onDidHide(() => {
              resolve(true);
              ninjaArgsInput.dispose();
            });
            ninjaArgsInput.show();
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
          } else if (/Downloading .*Xcode/.test(line)) {
            // TODO - Capture Xcode download progress and report it
            progress.report({
              message: "Downloading Xcode",
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
      },
    ),
    vscode.commands.registerCommand(`${commandPrefix}.buildAdvanced`, () => {
      return vscode.commands.executeCommand(`${commandPrefix}.build`, true);
    }),
  );
}
