import * as childProcess from "child_process";
import { promisify } from "util";

import * as vscode from "vscode";

import MarkdownIt from "markdown-it";
import MarkdownItEmoji from "markdown-it-emoji";

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
  findElectronRoot,
  getConfigDefaultTarget,
  getPatchesConfigFile,
  isBuildToolsInstalled,
  registerCommandNoBusy,
  withBusyState,
} from "./utils";
import {
  BuildToolsConfigCollector,
  ElectronBuildToolsConfigsProvider,
} from "./views/configs";
import { DocsTreeDataProvider } from "./views/docs";
import { ElectronViewProvider } from "./views/electron";
import { ElectronPatchesProvider } from "./views/patches";
import { HelpTreeDataProvider } from "./views/help";
import {
  ElectronTestCollector,
  TestCollector,
  TestsTreeDataProvider,
} from "./views/tests";
import { ElectronPullRequestFileSystemProvider } from "./pullRequestFileSystemProvider";
import { registerTestCommands } from "./commands/tests";
import { registerHelperCommands } from "./commands/helpers";
import { registerConfigsCommands } from "./commands/configs";
import { registerPatchesCommands } from "./commands/patches";
import { registerSyncCommands } from "./commands/sync";

const exec = promisify(childProcess.exec);

function registerElectronBuildToolsCommands(
  context: vscode.ExtensionContext,
  electronRoot: vscode.Uri,
  configsProvider: ElectronBuildToolsConfigsProvider,
  patchesProvider: ElectronPatchesProvider,
  patchesView: vscode.TreeView<vscode.TreeItem>,
  testsProvider: TestsTreeDataProvider,
  testsCollector: TestCollector,
  pullRequestFileSystemProvider: ElectronPullRequestFileSystemProvider
) {
  registerConfigsCommands(context, configsProvider);
  registerTestCommands(context, electronRoot, testsProvider, testsCollector);
  registerPatchesCommands(
    context,
    electronRoot,
    patchesProvider,
    patchesView,
    pullRequestFileSystemProvider
  );
  registerSyncCommands(context);

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
        });
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
      const configsCollector = new BuildToolsConfigCollector(context);
      const configsProvider = new ElectronBuildToolsConfigsProvider(
        configsCollector
      );
      const patchesProvider = new ElectronPatchesProvider(
        electronRoot,
        patchesConfig
      );
      const patchesView = vscode.window.createTreeView(
        "electron-build-tools:patches",
        {
          showCollapseAll: true,
          treeDataProvider: patchesProvider,
        }
      );
      const pullRequestFileSystemProvider = new ElectronPullRequestFileSystemProvider(
        electronRoot,
        patchesConfig
      );
      const testsCollector = new ElectronTestCollector(context, electronRoot);

      // Show progress on views while the collector is working. This lets us
      // immediately show the cached data from extension storage, while
      // refreshing them in the background and showing that it's working
      configsCollector.onDidStartRefreshing(({ refreshFinished }) => {
        vscode.window.withProgress(
          { location: { viewId: "electron-build-tools:configs" } },
          async () => {
            await refreshFinished;
          }
        );
      });
      testsCollector.onDidStartRefreshing(({ refreshFinished }) => {
        vscode.window.withProgress(
          { location: { viewId: "electron-build-tools:tests" } },
          async () => {
            await refreshFinished;
          }
        );
      });

      const testsProvider = new TestsTreeDataProvider(testsCollector);
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
        patchesView,
        vscode.window.createTreeView("electron-build-tools:docs", {
          showCollapseAll: true,
          treeDataProvider: new DocsTreeDataProvider(electronRoot),
        }),
        vscode.window.registerTreeDataProvider(
          "electron-build-tools:electron",
          new ElectronViewProvider(electronRoot)
        ),
        vscode.window.createTreeView("electron-build-tools:tests", {
          showCollapseAll: true,
          treeDataProvider: testsProvider,
        }),
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
        patchesView,
        testsProvider,
        testsCollector,
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
