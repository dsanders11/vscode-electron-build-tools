import * as childProcess from "child_process";
import * as fs from "fs";
import * as path from "path";
import { promisify } from "util";

import * as vscode from "vscode";

import {
  blankConfigEnumValue,
  buildTargets,
  buildToolsExecutable,
  virtualDocumentScheme,
} from "./constants";
import { TextDocumentContentProvider } from "./documentContentProvider";
import { runAsTask } from "./tasks";
import { TestCodeLensProvider } from "./testCodeLens";
import { ExtensionConfig } from "./types";
import {
  escapeStringForRegex,
  findCommitForPatch,
  getConfigDefaultTarget,
  getConfigs,
  getConfigsFilePath,
  getPatchesConfigFile,
  isBuildToolsInstalled,
  registerCommandNoBusy,
  withBusyState,
} from "./utils";
import {
  ConfigTreeItem,
  ElectronBuildToolsConfigsProvider,
} from "./views/configs";
import { DocsTreeDataProvider } from "./views/docs";
import { ElectronViewProvider } from "./views/electron";
import { ElectronPatchesProvider, PatchDirectory } from "./views/patches";
import { HelpTreeDataProvider } from "./views/help";
import {
  Test,
  TestBaseTreeItem,
  TestRunnerTreeItem,
  TestState,
  TestsTreeDataProvider,
} from "./views/tests";

const exec = promisify(childProcess.exec);

async function findElectronRoot(
  workspaceFolder: vscode.WorkspaceFolder
): Promise<vscode.Uri | undefined> {
  // Support opening the src/electron folder, as well as src/
  const possiblePackageRoots = [".", "electron"];

  for (const possibleRoot of possiblePackageRoots) {
    const rootPackageFilename = vscode.Uri.joinPath(
      workspaceFolder.uri,
      possibleRoot,
      "package.json"
    );

    try {
      const rootPackageFile = await vscode.workspace.fs.readFile(
        rootPackageFilename
      );

      const { name } = JSON.parse(rootPackageFile.toString()) as Record<
        string,
        string
      >;

      if (name === "electron") {
        return vscode.Uri.joinPath(workspaceFolder.uri, possibleRoot);
      }
    } catch {
      continue;
    }
  }
}

function registerElectronBuildToolsCommands(
  context: vscode.ExtensionContext,
  electronRoot: vscode.Uri,
  configsProvider: ElectronBuildToolsConfigsProvider,
  patchesProvider: ElectronPatchesProvider,
  testsProvider: TestsTreeDataProvider
) {
  context.subscriptions.push(
    registerCommandNoBusy(
      "electron-build-tools.build",
      () => {
        vscode.window.showErrorMessage("Can't build, other work in-progress");
      },
      () => {
        return withBusyState(async () => {
          const operationName = "Electron Build Tools - Building";

          const buildConfig = vscode.workspace.getConfiguration(
            "electronBuildTools.build"
          );
          const options = Object.entries(
            buildConfig.get("buildOptions") as ExtensionConfig.BuildOptions
          ).reduce((opts, [key, value]) => {
            opts.push(`${key} ${value}`.trim());
            return opts;
          }, [] as string[]);
          const ninjaArgs = Object.entries(
            buildConfig.get("ninjaArgs") as ExtensionConfig.NinjaArgs
          ).reduce((opts, [key, value]) => {
            opts.push(`${key} ${value}`.trim());
            return opts;
          }, [] as string[]);

          let settingsDefaultTarget: string | undefined = buildConfig.get(
            "defaultTarget"
          );
          settingsDefaultTarget =
            settingsDefaultTarget === blankConfigEnumValue
              ? ""
              : settingsDefaultTarget;
          let target = settingsDefaultTarget;

          let quickPick: vscode.QuickPick<vscode.QuickPickItem> | undefined;

          if (buildConfig.get("showTargets")) {
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
            FORCE_COLOR: "true",
            NINJA_STATUS: "%p %f/%t ",
          };

          let lastBuildProgress = 0;

          const task = runAsTask(
            context,
            operationName,
            "build",
            command,
            {
              env: buildEnv,
            },
            "$electron"
          );

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
        });
      }
    ),
    registerCommandNoBusy(
      "electron-build-tools.refreshPatches",
      () => {
        vscode.window.showErrorMessage(
          "Can't refresh patches, other work in-progress"
        );
      },
      (arg: PatchDirectory | string) => {
        return withBusyState(() => {
          const target = arg instanceof PatchDirectory ? arg.name : arg;

          return new Promise((resolve, reject) => {
            const cp = childProcess.exec(
              `${buildToolsExecutable} patches ${target || "all"}`
            );

            cp.on("error", (err) => reject(err));
            cp.on("exit", (code) => {
              if (code !== 0) {
                vscode.window.showErrorMessage("Failed to refresh patches");
              } else {
                // TBD - This isn't very noticeable
                vscode.window.setStatusBarMessage("Refreshed patches");
                patchesProvider.refresh();
                resolve();
              }
            });
          });
        });
      }
    ),
    vscode.commands.registerCommand(
      "electron-build-tools.remove-config",
      (config: ConfigTreeItem) => {
        childProcess.exec(
          `${buildToolsExecutable} remove ${config.label}`,
          {
            encoding: "utf8",
          },
          (error, stdout, stderr) => {
            if (error ?? stdout.trim() !== `Removed config ${config.label}`) {
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
    registerCommandNoBusy(
      "electron-build-tools.runTest",
      () => {
        vscode.window.showErrorMessage(
          "Can't run test, other work in-progress"
        );
      },
      async (test: TestBaseTreeItem | Test) => {
        return withBusyState(async () => {
          const operationName = "Electron Build Tools - Running Test";
          let command = `${buildToolsExecutable} test`;
          let task;

          // TODO - Need to sanity check output to make sure tests ran
          // and there wasn't a regex problem causing 0 tests to be run

          // TODO - Fix this up
          if (test instanceof TestBaseTreeItem) {
            const testRegex = escapeStringForRegex(
              test.getFullyQualifiedTestName()
            );

            task = runAsTask(
              context,
              operationName,
              "test",
              `${command} --runners=${test.runner.toString()} -g "${testRegex}"`,
              {},
              "$mocha",
              (exitCode) => {
                test.setState(
                  exitCode === 0 ? TestState.SUCCESS : TestState.FAILURE
                );
                testsProvider.refresh(test);

                return false;
              }
            );

            test.setState(TestState.RUNNING);
            testsProvider.refresh(test);
          } else {
            const testRegex = escapeStringForRegex(test.test);

            task = runAsTask(
              context,
              operationName,
              "test",
              `${command} --runners=${test.runner.toString()} -g "${testRegex}"`,
              {},
              "$mocha"
            );
          }

          await task.finished;
        });
      }
    ),
    registerCommandNoBusy(
      "electron-build-tools.runTestRunner",
      () => {
        vscode.window.showErrorMessage(
          "Can't run tests, other work in-progress"
        );
      },
      async (testRunner: TestRunnerTreeItem) => {
        const operationName = "Electron Build Tools - Running Tests";
        let command = `${buildToolsExecutable} test`;

        // TODO - Fix this up
        runAsTask(
          context,
          operationName,
          "test",
          `${command} --runner=${testRunner.runner.toString()}"`,
          {},
          "$mocha"
        );
      }
    ),
    registerCommandNoBusy(
      "electron-build-tools.runTestSuite",
      () => {
        vscode.window.showErrorMessage(
          "Can't run tests, other work in-progress"
        );
      },
      async (testSuite: TestBaseTreeItem) => {
        const operationName = "Electron Build Tools - Running Tests";
        let command = `${buildToolsExecutable} test`;

        const testRegex = escapeStringForRegex(
          testSuite.getFullyQualifiedTestName()
        );

        // TODO - Fix this up
        runAsTask(
          context,
          operationName,
          "test",
          `${command} --runners=${testSuite.runner.toString()} -g "${testRegex}"`,
          {},
          "$mocha",
          (exitCode) => {
            testSuite.setState(
              exitCode === 0 ? TestState.SUCCESS : TestState.FAILURE
            );
            testsProvider.refresh(testSuite);

            return false;
          }
        );

        testSuite.setState(TestState.RUNNING);
        testsProvider.refresh(testSuite);
      }
    ),
    vscode.commands.registerCommand(
      "electron-build-tools.showCommitDiff",
      async (
        checkoutDirectory: vscode.Uri,
        patch: vscode.Uri,
        filename: vscode.Uri,
        patchedFilename: string
      ) => {
        const commitSha = await findCommitForPatch(checkoutDirectory, patch);

        if (commitSha) {
          const originalFile = filename.with({
            scheme: virtualDocumentScheme,
            query: `view=contents&gitObject=${commitSha}~1&checkoutPath=${checkoutDirectory.fsPath}`,
          });
          const patchedFile = filename.with({
            scheme: virtualDocumentScheme,
            query: `view=contents&gitObject=${commitSha}&checkoutPath=${checkoutDirectory.fsPath}`,
          });

          vscode.commands.executeCommand(
            "vscode.diff",
            originalFile,
            patchedFile,
            `${path.basename(patch.path)} - ${patchedFilename}`
          );
        } else {
          vscode.window.showErrorMessage("Couldn't open commit diff for file");
        }
      }
    ),
    vscode.commands.registerCommand(
      "electron-build-tools.showPatchesDocs",
      () => {
        vscode.commands.executeCommand(
          "markdown.showPreview",
          vscode.Uri.joinPath(electronRoot, "docs", "development", "patches.md")
        );
      }
    ),
    vscode.commands.registerCommand(
      "electron-build-tools.showTestsDocs",
      () => {
        vscode.commands.executeCommand(
          "markdown.showPreview",
          vscode.Uri.joinPath(electronRoot, "docs", "development", "testing.md")
        );
      }
    ),
    vscode.commands.registerCommand(
      "electron-build-tools.showPatchOverview",
      (patch: vscode.Uri) => {
        return vscode.commands.executeCommand(
          "markdown.showPreview",
          patch.with({
            scheme: virtualDocumentScheme,
            query: "view=patch-overview",
          })
        );
      }
    ),
    vscode.commands.registerCommand(
      "electron-build-tools.sanitize-config",
      (config: ConfigTreeItem) => {
        childProcess.exec(
          `${buildToolsExecutable} sanitize-config ${config.label}`,
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
    vscode.commands.registerCommand(
      "electron-build-tools.show.exe",
      async () => {
        const { stdout } = await exec(`${buildToolsExecutable} show exe`, {
          encoding: "utf8",
        });
        return stdout.trim();
      }
    ),
    vscode.commands.registerCommand(
      "electron-build-tools.show.goma",
      async () => {
        await exec(`${buildToolsExecutable} show goma`);
      }
    ),
    vscode.commands.registerCommand(
      "electron-build-tools.show.outdir",
      async () => {
        const { stdout } = await exec(`${buildToolsExecutable} show outdir`, {
          encoding: "utf8",
        });
        return stdout.trim();
      }
    ),
    vscode.commands.registerCommand(
      "electron-build-tools.show.root",
      async () => {
        const { stdout } = await exec(`${buildToolsExecutable} show root`, {
          encoding: "utf8",
        });
        return stdout.trim();
      }
    ),
    vscode.commands.registerCommand(
      "electron-build-tools.show.src",
      async () => {
        const { stdout } = await exec(`${buildToolsExecutable} show src`, {
          encoding: "utf8",
        });
        return stdout.trim();
      }
    ),
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

          const syncEnv = {
            ...process.env,
            FORCE_COLOR: "true",
          };

          let initialProgress = false;

          const task = runAsTask(
            context,
            operationName,
            "sync",
            command,
            { env: syncEnv },
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
    }),
    vscode.commands.registerCommand("electron-build-tools.test", async () => {
      const operationName = "Electron Build Tools - Running Tests";
      let command = `${buildToolsExecutable} test`;

      const runnerOptions: vscode.QuickPickItem[] = [
        {
          label: "main",
          picked: true,
        },
        {
          label: "native",
          picked: true,
        },
        {
          label: "remote",
          picked: true,
        },
      ];

      const runners = await vscode.window.showQuickPick(runnerOptions, {
        placeHolder: "Choose runners to use",
        canPickMany: true,
      });
      const extraArgs = await vscode.window.showInputBox({
        placeHolder: "Extra args to pass to the test runner",
      });

      if (runners && extraArgs) {
        if (runners.length > 0) {
          command = `${command} --runners=${runners
            .map((runner) => runner.label)
            .join(",")}`;
        }

        runAsTask(
          context,
          operationName,
          "test",
          `${command} ${extraArgs}`,
          {},
          "$mocha"
        );
      }
    }),
    registerCommandNoBusy(
      "electron-build-tools.use-cnfig",
      () => {
        vscode.window.showErrorMessage(
          "Can't change configs, other work in-progress"
        );
      },
      (config: ConfigTreeItem) => {
        // Do an optimistic update for snappier UI
        configsProvider.setActive(config.label);

        childProcess.exec(
          `${buildToolsExecutable} use ${config.label}`,
          {
            encoding: "utf8",
          },
          (error, stdout) => {
            if (error ?? stdout.trim() !== `Now using config ${config.label}`) {
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
        const { configs } = await getConfigs();
        const selected = await vscode.window.showQuickPick(configs);

        if (selected) {
          // Do an optimistic update for snappier UI
          configsProvider.setActive(selected);

          childProcess.exec(
            `${buildToolsExecutable} use ${selected}`,
            {
              encoding: "utf8",
            },
            (error, stdout) => {
              if (error ?? stdout.trim() !== `Now using config ${selected}`) {
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
      async (configName: string) => {
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
      async (options: vscode.OpenDialogOptions | undefined) => {
        const results = await vscode.window.showOpenDialog(options);

        if (results) {
          return results[0].fsPath;
        }
      }
    )
  );
}

export async function activate(context: vscode.ExtensionContext) {
  // Always show the help view
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider(
      "electron-build-tools:help",
      new HelpTreeDataProvider()
    )
  );

  const workspaceFolders = vscode.workspace.workspaceFolders;
  const buildToolsIsInstalled = await isBuildToolsInstalled();

  await Promise.all([
    vscode.commands.executeCommand(
      "setContext",
      "electron-build-tools:ready",
      false
    ),
    vscode.commands.executeCommand(
      "setContext",
      "electron-build-tools:build-tools-installed",
      await buildToolsIsInstalled
    ),
    vscode.commands.executeCommand(
      "setContext",
      "electron-build-tools:is-electron-workspace",
      false
    ),
  ]);

  if (buildToolsIsInstalled && workspaceFolders) {
    const electronRoot = await findElectronRoot(workspaceFolders[0]);

    await vscode.commands.executeCommand(
      "setContext",
      "electron-build-tools:is-electron-workspace",
      electronRoot !== undefined
    );

    if (electronRoot !== undefined) {
      vscode.commands.executeCommand(
        "setContext",
        "electron-build-tools:active",
        true
      );

      const configsProvider = new ElectronBuildToolsConfigsProvider();
      const patchesProvider = new ElectronPatchesProvider(
        electronRoot,
        getPatchesConfigFile(electronRoot)
      );
      const testsProvider = new TestsTreeDataProvider(context, electronRoot);
      context.subscriptions.push(
        vscode.languages.registerCodeLensProvider(
          "typescript",
          new TestCodeLensProvider(testsProvider)
        ),
        vscode.languages.createDiagnosticCollection("electron-build-tools"),
        vscode.window.registerTreeDataProvider(
          "electron-build-tools:configs",
          configsProvider
        ),
        vscode.window.registerTreeDataProvider(
          "electron-build-tools:patches",
          patchesProvider
        ),
        vscode.window.registerTreeDataProvider(
          "electron-build-tools:docs",
          new DocsTreeDataProvider(electronRoot)
        ),
        vscode.window.registerTreeDataProvider(
          "electron-build-tools:electron",
          new ElectronViewProvider(electronRoot)
        ),
        vscode.window.registerTreeDataProvider(
          "electron-build-tools:tests",
          testsProvider
        ),
        vscode.workspace.registerTextDocumentContentProvider(
          virtualDocumentScheme,
          new TextDocumentContentProvider()
        )
      );
      registerElectronBuildToolsCommands(
        context,
        electronRoot,
        configsProvider,
        patchesProvider,
        testsProvider
      );
      registerHelperCommands(context);
    }
  }

  vscode.commands.executeCommand(
    "setContext",
    "electron-build-tools:ready",
    true
  );
}
