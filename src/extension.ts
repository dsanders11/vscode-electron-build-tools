import * as path from "node:path";

import * as vscode from "vscode";

import type MarkdownIt from "markdown-it";

import { registerChatParticipant } from "./chat/participant";
import {
  buildToolsExecutable,
  commandPrefix,
  outputChannelName,
  virtualPatchFsScheme,
  viewIds,
  virtualDocumentScheme,
  virtualFsScheme,
} from "./constants";
import { TextDocumentContentProvider } from "./documentContentProvider";
import { DocsHoverProvider } from "./docsHoverProvider";
import { DocsLinkablesProvider } from "./docsLinkablesProvider";
import { setupDocsLinting } from "./docsLinting";
import ExtensionState from "./extensionState";
import { ElectronFileDecorationProvider } from "./fileDecorationProvider";
import {
  ElectronFileSystemProvider,
  ElectronPatchFileSystemProvider,
} from "./fileSystemProvider";
import { GnFormattingProvider } from "./gnFormattingProvider";
import { GnLinkProvider } from "./gnLinkProvider";
import Logger from "./logging";
import { SnippetProvider } from "./snippetProvider";
import { createTestController } from "./tests";
import {
  drillDown,
  exec,
  findElectronRoot,
  getPatchesConfigFile,
  isBuildToolsInstalled,
  setContext,
  TreeViewRevealOptions,
} from "./utils";
import {
  BuildToolsConfigCollector,
  ElectronBuildToolsConfigsProvider,
} from "./views/configs";
import { DocsTreeDataProvider } from "./views/docs";
import { ElectronViewProvider } from "./views/electron";
import {
  ElectronPatchesProvider,
  Patch,
  PatchDirectory,
} from "./views/patches";
import { HelpTreeDataProvider } from "./views/help";
import { registerHelperCommands } from "./commands/helpers";
import { registerConfigsCommands } from "./commands/configs";
import { registerPatchesCommands } from "./commands/patches";
import { registerSyncCommands } from "./commands/sync";
import { registerBuildCommands } from "./commands/build";
import { DocsLinkCompletionProvider } from "./docsLinkCompletionProvider";
import { registerDocsCommands } from "./commands/docs";

function registerElectronBuildToolsCommands(
  context: vscode.ExtensionContext,
  electronRoot: vscode.Uri,
  patchesProvider: ElectronPatchesProvider,
  patchesView: vscode.TreeView<vscode.TreeItem>,
) {
  registerBuildCommands(context);
  registerPatchesCommands(context, electronRoot, patchesProvider, patchesView);

  context.subscriptions.push(
    vscode.commands.registerCommand(
      `${commandPrefix}.revealInElectronSidebar`,
      async (file: vscode.Uri, options?: TreeViewRevealOptions) => {
        if (!options) {
          options = { expand: true, focus: true };
        }

        if (/.*\/electron\/patches\/.*\.patch$/.test(file.path)) {
          const patchesRoot = vscode.Uri.joinPath(electronRoot, "patches");

          if (!file.path.startsWith(patchesRoot.path)) {
            throw new Error("Uri not in patches directory");
          }

          const patchDir = path.relative(
            patchesRoot.path,
            path.dirname(file.path),
          );

          try {
            await drillDown(
              patchesView,
              patchesProvider,
              (
                element: vscode.TreeItem | undefined,
                children: vscode.TreeItem[],
              ) => {
                if (!element) {
                  const item = (children as PatchDirectory[]).find(
                    (child) => child.name === patchDir,
                  );

                  if (item) {
                    return { item, done: false };
                  } else {
                    throw new Error("Couldn't find patch directory tree item");
                  }
                } else {
                  const item = (children as Patch[]).find(
                    (child) => child.resourceUri.fsPath === file.fsPath,
                  );

                  if (item) {
                    return { item, done: true };
                  } else {
                    throw new Error("Couldn't find patch tree item");
                  }
                }
              },
              options,
            );
          } catch (err) {
            Logger.error(err instanceof Error ? err : String(err));
            vscode.window.showErrorMessage("Couldn't reveal patch in sidebar");
          }
        }
      },
    ),
    vscode.commands.registerCommand(`${commandPrefix}.run`, async () => {
      const arg = await vscode.commands.executeCommand<string | null>(
        `${commandPrefix}.debug.showOpenDialog`,
      );

      if (arg !== null) {
        const task = new vscode.Task(
          { type: "electron-build-tools", task: "run" },
          vscode.TaskScope.Workspace,
          "Run Electron",
          "electron-build-tools",
          new vscode.ProcessExecution(buildToolsExecutable, ["run", arg], {
            cwd: electronRoot.fsPath,
          }),
        );
        task.presentationOptions = {
          reveal: vscode.TaskRevealKind.Always,
          echo: true,
          clear: true,
        };
        await vscode.tasks.executeTask(task);
      }
    }),
    vscode.commands.registerCommand(
      `${commandPrefix}.show.depotdir`,
      async () => {
        const { stdout } = await exec(`${buildToolsExecutable} show depotdir`, {
          encoding: "utf8",
        });
        return stdout.trim();
      },
    ),
    vscode.commands.registerCommand(`${commandPrefix}.show.exe`, async () => {
      const { stdout } = await exec(`${buildToolsExecutable} show exe`, {
        encoding: "utf8",
      });
      return stdout.trim();
    }),
    vscode.commands.registerCommand(`${commandPrefix}.show.exec`, async () => {
      const { stdout } = await exec(`${buildToolsExecutable} show exec`, {
        encoding: "utf8",
      });
      return stdout.trim();
    }),
    vscode.commands.registerCommand(
      `${commandPrefix}.show.out.path`,
      async () => {
        const { stdout } = await exec(
          `${buildToolsExecutable} show out --path`,
          {
            encoding: "utf8",
          },
        );
        return stdout.trim();
      },
    ),
    vscode.commands.registerCommand(`${commandPrefix}.show.root`, async () => {
      const { stdout } = await exec(`${buildToolsExecutable} show root`, {
        encoding: "utf8",
      });
      return stdout.trim();
    }),
    vscode.commands.registerCommand(`${commandPrefix}.show.src`, async () => {
      const { stdout } = await exec(`${buildToolsExecutable} show src`, {
        encoding: "utf8",
      });
      return stdout.trim();
    }),
    vscode.commands.registerCommand(`${commandPrefix}.runLmTests`, async () => {
      const allModels = await vscode.lm.selectChatModels({ vendor: "copilot" });
      const models = await vscode.window.showQuickPick(
        allModels.map(({ name }) => name),
        { placeHolder: "Select models to test", canPickMany: true },
      );

      if (!models?.length) {
        return;
      }

      (globalThis as Record<string, unknown>)._testModels = allModels.filter(
        (model) => models.includes(model.name),
      );

      (globalThis as Record<string, unknown>)._testFixtures = {
        buildErrors: JSON.parse(
          (
            await vscode.workspace.fs.readFile(
              vscode.Uri.joinPath(
                context.extensionUri,
                "lm-tests/fixtures/build-errors.json",
              ),
            )
          ).toString(),
        ),
        searchChromiumLog: JSON.parse(
          (
            await vscode.workspace.fs.readFile(
              vscode.Uri.joinPath(
                context.extensionUri,
                "lm-tests/fixtures/search-chromium-log.json",
              ),
            )
          ).toString(),
        ),
        syncErrors: JSON.parse(
          (
            await vscode.workspace.fs.readFile(
              vscode.Uri.joinPath(
                context.extensionUri,
                "lm-tests/fixtures/sync-errors.json",
              ),
            )
          ).toString(),
        ),
        testErrors: JSON.parse(
          (
            await vscode.workspace.fs.readFile(
              vscode.Uri.joinPath(
                context.extensionUri,
                "lm-tests/fixtures/test-errors.json",
              ),
            )
          ).toString(),
        ),
        tools: JSON.parse(
          (
            await vscode.workspace.fs.readFile(
              vscode.Uri.joinPath(
                context.extensionUri,
                "lm-tests/fixtures/tools.json",
              ),
            )
          ).toString(),
        ),
      };

      const { default: Mocha } = await import("mocha");

      // Use a custom reporter to send output to an OutputChannel, and
      // also output the number of continuations a given test needed
      const reporterModule = await import(
        vscode.Uri.joinPath(context.extensionUri, "out/lm-tests/reporter.cjs")
          .fsPath
      );

      interface MochaGlobalContext {
        cancellationToken?: vscode.CancellationToken;
        chromiumRoot: vscode.Uri;
        extension: vscode.Extension<unknown>;
      }
      const globalContext: MochaGlobalContext = {
        cancellationToken: undefined,
        chromiumRoot: vscode.Uri.joinPath(electronRoot, ".."),
        extension: context.extension,
      };
      const mocha = new Mocha({
        timeout: 1_200_000,
        rootHooks: {
          async beforeAll() {
            (this as Record<string, unknown>).globalContext = globalContext;
          },
        },
        reporter: reporterModule.default.default,
        reporterOptions: {
          maxDiffSize: 128 * 1024,
        },
      });

      const files = await vscode.workspace.findFiles(
        new vscode.RelativePattern(
          context.extensionUri,
          `out/lm-tests/**/*.test.js`,
        ),
      );
      for (const file of files) {
        mocha.addFile(file.fsPath);
      }
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `${outputChannelName}: Running LM Tests`,
          cancellable: true,
        },
        async (_progress, token) => {
          globalContext.cancellationToken = token;
          await new Promise<void>((resolve) => {
            const runner = mocha.run(() => resolve());
            runner.on("end", () => resolve());
            token.onCancellationRequested(() => {
              runner.abort();
            });
          });
        },
      );
      mocha.dispose();
    }),
  );
}

export async function activate(context: vscode.ExtensionContext) {
  const result = {
    extendMarkdownIt: undefined as undefined | ((md: MarkdownIt) => MarkdownIt),
  };

  // Always show the help view
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider(
      viewIds.HELP,
      new HelpTreeDataProvider(context.extensionUri),
    ),
  );

  const workspaceFolders = vscode.workspace.workspaceFolders;
  const buildToolsIsInstalled = await isBuildToolsInstalled();

  await Promise.all([
    setContext("ready", false),
    setContext("build-tools-installed", buildToolsIsInstalled),
    setContext("is-electron-workspace", false),
    setContext(
      "development-mode",
      context.extensionMode === vscode.ExtensionMode.Development,
    ),
  ]);

  // If build-tools is installed, always provide config and sync functionality
  // so that a user can fully setup Electron on a clean machine with commands
  if (buildToolsIsInstalled) {
    await ExtensionState.setInitialState();

    const configsCollector = new BuildToolsConfigCollector(context);
    const configsProvider = new ElectronBuildToolsConfigsProvider(
      configsCollector,
    );
    const configsView = vscode.window.createTreeView(viewIds.CONFIGS, {
      treeDataProvider: configsProvider,
    });

    // Show progress on views while the collector is working. This lets us
    // immediately show the cached data from extension storage, while
    // refreshing them in the background and showing that it's working
    const disposable = configsCollector.onDidStartRefreshing(
      ({ refreshFinished }) => {
        vscode.window.withProgress(
          { location: { viewId: viewIds.CONFIGS } },
          async () => {
            try {
              await refreshFinished;
              const { configs } = await configsCollector.getConfigs();

              if (configs.length === 0) {
                configsView.message = "No build configs.";
              } else {
                configsView.message = undefined;
              }
            } catch {
              configsView.message = "Couldn't get configs.";
            }
          },
        );
      },
    );

    registerConfigsCommands(context, configsCollector, configsProvider);
    registerSyncCommands(context);

    context.subscriptions.push(configsCollector, configsView, disposable);
  }

  if (buildToolsIsInstalled && workspaceFolders) {
    const electronRoot = await findElectronRoot(workspaceFolders[0]);

    await setContext("is-electron-workspace", electronRoot !== undefined);

    if (electronRoot !== undefined) {
      await setContext("active", true);

      const testController = await createTestController(context, electronRoot);

      const patchesConfig = getPatchesConfigFile(electronRoot);
      const patchesProvider = new ElectronPatchesProvider(
        context,
        electronRoot,
        patchesConfig,
      );
      const patchesView = vscode.window.createTreeView(viewIds.PATCHES, {
        showCollapseAll: true,
        treeDataProvider: patchesProvider,
      });
      const linkableProvider = new DocsLinkablesProvider(electronRoot);

      context.subscriptions.push(
        testController,
        linkableProvider,
        patchesView,
        vscode.window.createTreeView(viewIds.DOCS, {
          showCollapseAll: true,
          treeDataProvider: new DocsTreeDataProvider(electronRoot),
        }),
        vscode.window.registerTreeDataProvider(
          viewIds.ELECTRON,
          new ElectronViewProvider(electronRoot),
        ),
        // There are three custom schemes used:
        //   * electron-build-tools
        //   * electron-build-tools-fs
        //   * electron-build-tools-patch-fs
        //
        // `electron-build-tools` is for providing read-only content to show
        // the user in an editor, e.g. files inside a patch, patch overview,
        // content from a pull request, etc. It could also be used to show
        // any random markdown documentation we might want to show the user.
        //
        // `electron-build-tools-fs` also provides read-only content, based on
        // optional blob IDs. It can also apply a provided patch to the content
        // of a file on the fly. If a blob Id is provided, it will check for
        // the blob on disk first, then fall back to remote content, and will
        // cache remote content for fast subsequent lookups. The role of
        // `electron-build-tools` could also be accomplished with this
        // `FileSystemProvider`, but there are a few downsides to that, which
        // is why both exist. Namely, VS Code displays a lock icon for
        // read-only content served by a `FileSystemProvider` (undesirable),
        // and any open editor to that content will cause constant hits to the
        // `stat` method on the `FileSystemProvider`, which is unnecessary for
        // our needs.
        //
        // `electron-build-tools-patch-fs` is a read-write `FileSystemProvider`
        // that allows for editing files in a patch and updating the patch on
        // save.
        vscode.workspace.registerTextDocumentContentProvider(
          virtualDocumentScheme,
          new TextDocumentContentProvider(),
        ),
        vscode.workspace.registerFileSystemProvider(
          virtualFsScheme,
          new ElectronFileSystemProvider(),
          { isReadonly: true },
        ),
        vscode.workspace.registerFileSystemProvider(
          virtualPatchFsScheme,
          new ElectronPatchFileSystemProvider(patchesProvider),
        ),
        vscode.window.registerFileDecorationProvider(
          new ElectronFileDecorationProvider(),
        ),
        vscode.languages.registerHoverProvider(
          {
            language: "markdown",
            pattern: new vscode.RelativePattern(electronRoot, "docs/**/*.md"),
          },
          new DocsHoverProvider(),
        ),
        vscode.languages.registerDocumentLinkProvider(
          { language: "gn" },
          new GnLinkProvider(electronRoot),
        ),
        vscode.languages.registerDocumentFormattingEditProvider(
          { language: "gn" },
          new GnFormattingProvider(electronRoot),
        ),
        vscode.languages.registerCompletionItemProvider(
          SnippetProvider.DOCUMENT_SELECTOR,
          new SnippetProvider(),
          ...SnippetProvider.TRIGGER_CHARACTERS,
        ),
        vscode.languages.registerCompletionItemProvider(
          {
            language: "markdown",
            pattern: new vscode.RelativePattern(electronRoot, "docs/**/*.md"),
          },
          new DocsLinkCompletionProvider(linkableProvider),
          ...DocsLinkCompletionProvider.TRIGGER_CHARACTERS,
        ),
        registerChatParticipant(context, electronRoot, patchesProvider),
      );
      registerElectronBuildToolsCommands(
        context,
        electronRoot,
        patchesProvider,
        patchesView,
      );
      registerDocsCommands(context, linkableProvider);
      registerHelperCommands(context);

      setupDocsLinting(context);

      // Render emojis in Markdown
      const { full: emojiMarkdownIt } = await import("markdown-it-emoji");
      result.extendMarkdownIt = (md: MarkdownIt) => md.use(emojiMarkdownIt);
    }
  }

  await setContext("ready", true);

  return result;
}
