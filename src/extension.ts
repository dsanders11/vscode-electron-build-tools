import * as vscode from "vscode";
import * as childProcess from "child_process";
import * as fs from "fs";
import * as path from "path";

import { ElectronBuildToolsConfigsProvider } from "./configsView";
import { blankConfigEnumValue, buildTargets } from "./constants";
import { HelpTreeDataProvider } from "./helpView";
import { runAsTask } from "./tasks";
import {
  getConfigDefaultTarget,
  getConfigs,
  getConfigsFilePath,
  isBuildToolsInstalled,
} from "./utils";

async function electronIsInWorkspace(workspaceFolder: vscode.WorkspaceFolder) {
  const possiblePackageRoots = [".", "electron"];
  for (const possibleRoot of possiblePackageRoots) {
    const rootPackageFilename = path.join(
      workspaceFolder.uri.fsPath,
      possibleRoot,
      "package.json"
    );
    if (!fs.existsSync(rootPackageFilename)) {
      continue;
    }

    const rootPackageFile = await vscode.workspace.fs.readFile(
      vscode.Uri.file(rootPackageFilename)
    );

    const { name } = JSON.parse(rootPackageFile.toString());

    return name === "electron";
  }
}

function registerElectronBuildToolsCommands(
  context: vscode.ExtensionContext,
  configsProvider: ElectronBuildToolsConfigsProvider
) {
  context.subscriptions.push(
    vscode.commands.registerCommand("electron-build-tools.build", async () => {
      const operationName = "Electron Build Tools - Building";

      const buildConfig = vscode.workspace.getConfiguration(
        "vscode-electron-build-tools.config.electronBuildTools.build"
      );
      const options = Object.entries(
        buildConfig.get("buildOptions") as object
      ).reduce((opts, [key, value]) => {
        opts.push(`${key} ${value}`.trim());
        return opts;
      }, [] as string[]);
      const ninjaArgs = Object.entries(
        buildConfig.get("ninjaArgs") as object
      ).reduce((opts, [key, value]) => {
        opts.push(`${key} ${value}`.trim());
        return opts;
      }, [] as string[]);

      let settingsDefaultTarget = buildConfig.get("target");
      settingsDefaultTarget =
        settingsDefaultTarget === blankConfigEnumValue
          ? ""
          : settingsDefaultTarget;
      let target = settingsDefaultTarget;

      let quickPick: vscode.QuickPick<vscode.QuickPickItem> | undefined;

      if (buildConfig.get("showTargets")) {
        // Settings default target takes precedence
        const defaultTarget = settingsDefaultTarget || getConfigDefaultTarget();
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
            target = quickPick!.selectedItems[0].label || target;
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
        "electron-build-tools",
        "build",
        ...options,
        target,
        ...ninjaArgs,
      ]
        .join(" ")
        .trim();

      const buildEnv = {
        ...process.env,
        FORCE_COLOR: "true",
        NINJA_STATUS: "%p %f/%t ",
      };

      let lastBuildProgress = 0;

      const task = runAsTask(operationName, "build", command, {
        env: buildEnv,
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
    }),
    vscode.commands.registerCommand(
      "electron-build-tools.remove-config",
      (config) => {
        childProcess.exec(
          `electron-build-tools remove ${config.label}`,
          {
            encoding: "utf8",
          },
          (error, stdout, stderr) => {
            if (error || stdout.trim() !== `Removed config ${config.label}`) {
              vscode.window.showErrorMessage(
                `Failed to remove config: ${stderr.trim()}`
              );
            } else {
              // TBD - This isn't very noticeable
              vscode.window.setStatusBarMessage("Removed config");
              configsProvider.refresh();
            }
          }
        );
      }
    ),
    vscode.commands.registerCommand(
      "electron-build-tools.sanitize-config",
      (config) => {
        childProcess.exec(
          `electron-build-tools sanitize-config ${config.label}`,
          {
            encoding: "utf8",
          },
          (error, stdout, stderr) => {
            if (
              error ||
              stdout.trim() !== `SUCCESS Sanitized contents of ${config.label}`
            ) {
              vscode.window.showErrorMessage(
                `Failed to sanitize config: ${stderr.trim()}`
              );
            } else {
              // TBD - This isn't very noticeable
              vscode.window.setStatusBarMessage("Sanitized config");
            }
          }
        );
      }
    ),
    vscode.commands.registerCommand("electron-build-tools.show.exe", () => {
      return childProcess
        .execSync("electron-build-tools show exe", { encoding: "utf8" })
        .trim();
    }),
    vscode.commands.registerCommand("electron-build-tools.show.goma", () => {
      childProcess.execSync("electron-build-tools show goma");
    }),
    vscode.commands.registerCommand("electron-build-tools.show.outdir", () => {
      return childProcess
        .execSync("electron-build-tools show outdir", { encoding: "utf8" })
        .trim();
    }),
    vscode.commands.registerCommand("electron-build-tools.show.root", () => {
      return childProcess
        .execSync("electron-build-tools show root", { encoding: "utf8" })
        .trim();
    }),
    vscode.commands.registerCommand(
      "electron-build-tools.sync",
      (force?: boolean) => {
        const command = `electron-build-tools sync${force ? " --force" : ""}`;
        const operationName = `Electron Build Tools - ${
          force ? "Force " : ""
        }Syncing`;

        const syncEnv = {
          ...process.env,
          FORCE_COLOR: "true",
        };

        let initialProgress = false;

        const task = runAsTask(
          operationName,
          "sync",
          command,
          { env: syncEnv },
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
      }
    ),
    vscode.commands.registerCommand("electron-build-tools.sync.force", () => {
      return vscode.commands.executeCommand("electron-build-tools.sync", true);
    }),
    vscode.commands.registerCommand(
      "electron-build-tools.use-config",
      (config) => {
        // Do an optimistic update for snappier UI
        configsProvider.setActive(config.label);

        childProcess.exec(
          `electron-build-tools use ${config.label}`,
          {
            encoding: "utf8",
          },
          (error, stdout) => {
            if (error || stdout.trim() !== `Now using config ${config.label}`) {
              vscode.window.showErrorMessage(
                "Failed to set active Electron build-tools config"
              );
              configsProvider.setActive(null);
              configsProvider.refresh();
            }
          }
        );
      }
    ),
    vscode.commands.registerCommand(
      "electron-build-tools.use-config.quick-pick",
      async () => {
        const { configs } = getConfigs();
        const selected = await vscode.window.showQuickPick(configs);

        if (selected) {
          // Do an optimistic update for snappier UI
          configsProvider.setActive(selected);

          childProcess.exec(
            `electron-build-tools use ${selected}`,
            {
              encoding: "utf8",
            },
            (error, stdout) => {
              if (error || stdout.trim() !== `Now using config ${selected}`) {
                vscode.window.showErrorMessage(
                  "Failed to set active Electron build-tools config"
                );
                configsProvider.setActive(null);
                configsProvider.refresh();
              }
            }
          );
        }
      }
    ),
    vscode.commands.registerCommand(
      "electron-build-tools.openConfig",
      async (configName) => {
        const configFilePath = path.join(
          getConfigsFilePath(),
          `evm.${configName}.json`
        );
        try {
          const document = await vscode.workspace.openTextDocument(
            configFilePath
          );
          await vscode.window.showTextDocument(document);
        } catch (e) {
          console.log(e);
        }

        return configFilePath;
      }
    )
  );
}

function registerHelperCommands(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "vscode.window.showOpenDialog",
      async (options) => {
        const results = await vscode.window.showOpenDialog(options);

        if (results) {
          return results[0].fsPath;
        }
      }
    )
  );
}

export async function activate(context: vscode.ExtensionContext) {
  const workspaceFolders = vscode.workspace.workspaceFolders;

  const buildToolsIsInstalled = isBuildToolsInstalled();

  vscode.commands.executeCommand(
    "setContext",
    "electron-build-tools:ready",
    false
  );
  vscode.commands.executeCommand(
    "setContext",
    "electron-build-tools:build-tools-installed",
    buildToolsIsInstalled
  );
  vscode.commands.executeCommand(
    "setContext",
    "electron-build-tools:is-electron-workspace",
    false
  );

  // Always show the help view
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider(
      "electron-build-tools:help",
      new HelpTreeDataProvider()
    )
  );

  if (buildToolsIsInstalled && workspaceFolders) {
    const isElectronWorkspace = await electronIsInWorkspace(
      workspaceFolders[0]
    );
    vscode.commands.executeCommand(
      "setContext",
      "electron-build-tools:is-electron-workspace",
      isElectronWorkspace
    );

    if (isElectronWorkspace) {
      vscode.commands.executeCommand(
        "setContext",
        "electron-build-tools:active",
        true
      );

      const configsProvider = new ElectronBuildToolsConfigsProvider();
      registerElectronBuildToolsCommands(context, configsProvider);
      registerHelperCommands(context);
      context.subscriptions.push(
        vscode.languages.createDiagnosticCollection("electron-build-tools"),
        vscode.window.registerTreeDataProvider(
          "electron-build-tools:configs",
          configsProvider
        )
      );
    }
  }

  vscode.commands.executeCommand(
    "setContext",
    "electron-build-tools:ready",
    true
  );
}
