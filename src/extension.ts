import * as childProcess from "child_process";
import * as path from "path";
import * as querystring from "querystring";
import { promisify } from "util";

import * as vscode from "vscode";

import MarkdownIt from "markdown-it";
import MarkdownItEmoji from "markdown-it-emoji";
import { Octokit } from "@octokit/rest";

import {
  blankConfigEnumValue,
  buildTargets,
  buildToolsExecutable,
  pullRequestScheme,
  virtualDocumentScheme,
} from "./constants";
import { TextDocumentContentProvider } from "./documentContentProvider";
import { DocsLinkablesProvider } from "./docsLinkablesProvider";
import { setupDocsLinting } from "./docsLinting";
import { runAsTask } from "./tasks";
import { TestCodeLensProvider } from "./testCodeLens";
import { ExtensionConfig } from "./types";
import {
  FileInPatch,
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
import {
  ElectronPatchesProvider,
  Patch,
  PatchDirectory,
  PullRequestTreeItem,
} from "./views/patches";
import { HelpTreeDataProvider } from "./views/help";
import { TestsTreeDataProvider } from "./views/tests";
import { ElectronPullRequestFileSystemProvider } from "./pullRequestFileSystemProvider";
import { registerTestCommands } from "./commands/tests";
import { registerHelperCommands } from "./commands/helpers";

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
  testsProvider: TestsTreeDataProvider,
  pullRequestFileSystemProvider: ElectronPullRequestFileSystemProvider
) {
  registerTestCommands(context, electronRoot, testsProvider);

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

            cp.once("error", (err) => reject(err));
            cp.once("exit", (code) => {
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
    vscode.commands.registerCommand(
      "electron-build-tools.showCommitDiff",
      async (
        checkoutDirectory: vscode.Uri,
        patch: vscode.Uri,
        metadata: FileInPatch,
        patchedFilename: string
      ) => {
        const originalFile = metadata.file.with({
          scheme: virtualDocumentScheme,
          query: querystring.stringify({
            ...querystring.parse(metadata.file.query),
            view: "contents",
            fileIndex: metadata.fileIndexA,
            checkoutPath: checkoutDirectory.fsPath,
          }),
        });
        const patchedFile = metadata.file.with({
          scheme: virtualDocumentScheme,
          query: querystring.stringify({
            ...querystring.parse(metadata.file.query),
            view: "contents",
            fileIndex: metadata.fileIndexB,
            checkoutPath: checkoutDirectory.fsPath,
          }),
        });

        vscode.commands.executeCommand(
          "vscode.diff",
          originalFile,
          patchedFile,
          `${path.basename(patch.path)} - ${patchedFilename}`
        );
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
      "electron-build-tools.showPatchOverview",
      (patch: vscode.Uri) => {
        return vscode.commands.executeCommand(
          "markdown.showPreview",
          patch.with({
            scheme: virtualDocumentScheme,
            query: querystring.stringify({
              ...querystring.parse(patch.query),
              view: "patch-overview",
            }),
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
    }),
    registerCommandNoBusy(
      "electron-build-tools.use-config",
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
    ),
    vscode.commands.registerCommand(
      "electron-build-tools.openPatch",
      (patchTreeItem: Patch) => {
        return vscode.commands.executeCommand("vscode.open", patchTreeItem.uri);
      }
    ),
    vscode.commands.registerCommand(
      "electron-build-tools.removePullRequestPatch",
      async (treeItem: PullRequestTreeItem) => {
        patchesProvider.removePr(treeItem.pullRequest);
      }
    ),
    vscode.commands.registerCommand(
      "electron-build-tools.viewPullRequestPatch",
      async () => {
        const prNumber = await vscode.window.showInputBox({
          prompt: "Enter the pull request number",
          validateInput: (value: string) => {
            if (isNaN(parseInt(value))) {
              return "Enter a number only";
            }
          },
        });

        if (prNumber) {
          const octokit = new Octokit();
          const prDetails = {
            owner: "electron",
            repo: "electron",
            pull_number: parseInt(prNumber),
          };
          const prResponse = await octokit.pulls.get(prDetails);
          const prFilesResponse = await octokit.pulls.listFiles(prDetails);

          if (prResponse.status === 200 && prFilesResponse.status === 200) {
            const pullRequest = prResponse.data;
            const pulRequestFiles = prFilesResponse.data;
            const patchDirectoryRegex = /^patches\/(\S*)\/.patches$/;
            const patchDirectories = [];

            for (const file of prFilesResponse.data) {
              const matches = patchDirectoryRegex.exec(file.filename);

              if (matches) {
                patchDirectories.push(`src/electron/patches/${matches[1]}`);
              }
            }

            if (patchDirectories.length > 0) {
              await pullRequestFileSystemProvider.addPullRequestFiles(
                prNumber,
                pulRequestFiles
              );

              patchesProvider.showPr({
                prNumber,
                title: pullRequest.title,
                patchDirectories,
              });
            } else {
              vscode.window.showWarningMessage("No patches in pull request");
            }
          } else {
            vscode.window.showErrorMessage("Couldn't find pull request");
          }
        }
      }
    )
  );
}

export async function activate(context: vscode.ExtensionContext) {
  const result = {
    extendMarkdownIt: undefined as undefined | ((md: MarkdownIt) => MarkdownIt),
  };

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

      const diagnosticsCollection = vscode.languages.createDiagnosticCollection(
        "electron-build-tools"
      );

      const patchesConfig = getPatchesConfigFile(electronRoot);
      const configsProvider = new ElectronBuildToolsConfigsProvider();
      const patchesProvider = new ElectronPatchesProvider(
        electronRoot,
        patchesConfig
      );
      const pullRequestFileSystemProvider = new ElectronPullRequestFileSystemProvider(
        electronRoot,
        patchesConfig
      );
      const testsProvider = new TestsTreeDataProvider(context, electronRoot);
      context.subscriptions.push(
        vscode.languages.registerCodeLensProvider(
          "typescript",
          new TestCodeLensProvider(testsProvider)
        ),
        diagnosticsCollection,
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
        ),
        vscode.workspace.registerFileSystemProvider(
          pullRequestScheme,
          pullRequestFileSystemProvider,
          { isReadonly: true }
        )
      );
      registerElectronBuildToolsCommands(
        context,
        electronRoot,
        configsProvider,
        patchesProvider,
        testsProvider,
        pullRequestFileSystemProvider
      );
      registerHelperCommands(context);

      const linkableProvider = new DocsLinkablesProvider(electronRoot);
      context.subscriptions.push(linkableProvider);

      setupDocsLinting(linkableProvider, diagnosticsCollection);

      // Render emojis in Markdown
      result.extendMarkdownIt = (md: MarkdownIt) => md.use(MarkdownItEmoji);
    }
  }

  vscode.commands.executeCommand(
    "setContext",
    "electron-build-tools:ready",
    true
  );

  return result;
}
