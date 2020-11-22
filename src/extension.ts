import * as childProcess from "child_process";
import { promisify } from "util";

import * as vscode from "vscode";

import MarkdownIt from "markdown-it";
import MarkdownItEmoji from "markdown-it-emoji";

import {
  buildToolsExecutable,
  commandPrefix,
  pullRequestScheme,
  viewIds,
  virtualDocumentScheme,
} from "./constants";
import { TextDocumentContentProvider } from "./documentContentProvider";
import { DocsHoverProvider } from "./docsHoverProvider";
import { DocsLinkablesProvider } from "./docsLinkablesProvider";
import { setupDocsLinting } from "./docsLinting";
import ExtensionState from "./extensionState";
import { GnFormattingProvider } from "./gnFormattingProvider";
import { GnLinkProvider } from "./gnLinkProvider";
import Logger from "./logging";
import { TestCodeLensProvider } from "./testCodeLens";
import {
  findElectronRoot,
  getPatchesConfigFile,
  isBuildToolsInstalled,
  OptionalFeature,
  setContext,
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
import { registerBuildCommands } from "./commands/build";

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
  registerBuildCommands(context);
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
    vscode.commands.registerCommand(`${commandPrefix}.show.exe`, async () => {
      const { stdout } = await exec(`${buildToolsExecutable} show exe`, {
        encoding: "utf8",
      });
      return stdout.trim();
    }),
    vscode.commands.registerCommand(`${commandPrefix}.show.goma`, async () => {
      await exec(`${buildToolsExecutable} show goma`);
    }),
    vscode.commands.registerCommand(
      `${commandPrefix}.show.outdir`,
      async () => {
        const { stdout } = await exec(`${buildToolsExecutable} show outdir`, {
          encoding: "utf8",
        });
        return stdout.trim();
      }
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
    })
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
      new HelpTreeDataProvider()
    )
  );

  const workspaceFolders = vscode.workspace.workspaceFolders;
  const buildToolsIsInstalled = await isBuildToolsInstalled();

  await Promise.all([
    setContext("ready", false),
    setContext("build-tools-installed", buildToolsIsInstalled),
    setContext("is-electron-workspace", false),
  ]);

  if (buildToolsIsInstalled && workspaceFolders) {
    const electronRoot = await findElectronRoot(workspaceFolders[0]);

    setContext("is-electron-workspace", electronRoot !== undefined);

    if (electronRoot !== undefined) {
      setContext("active", true);
      ExtensionState.setInitialState();

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
      const patchesView = vscode.window.createTreeView(viewIds.PATCHES, {
        showCollapseAll: true,
        treeDataProvider: patchesProvider,
      });
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
          { location: { viewId: viewIds.CONFIGS } },
          () => refreshFinished
        );
      });
      testsCollector.onDidStartRefreshing(({ refreshFinished }) => {
        vscode.window.withProgress(
          { location: { viewId: viewIds.TESTS } },
          () => refreshFinished
        );
      });

      const testsProvider = new TestsTreeDataProvider(testsCollector);
      context.subscriptions.push(
        diagnosticsCollection,
        vscode.window.registerTreeDataProvider(
          viewIds.CONFIGS,
          configsProvider
        ),
        patchesView,
        vscode.window.createTreeView(viewIds.DOCS, {
          showCollapseAll: true,
          treeDataProvider: new DocsTreeDataProvider(electronRoot),
        }),
        vscode.window.registerTreeDataProvider(
          viewIds.ELECTRON,
          new ElectronViewProvider(electronRoot)
        ),
        vscode.window.createTreeView(viewIds.TESTS, {
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
        ),
        vscode.languages.registerHoverProvider(
          {
            language: "markdown",
            pattern: new vscode.RelativePattern(
              electronRoot.fsPath,
              "docs/**/*.md"
            ),
          },
          new DocsHoverProvider()
        ),
        vscode.languages.registerDocumentLinkProvider(
          { language: "gn" },
          new GnLinkProvider(electronRoot)
        ),
        vscode.languages.registerDocumentFormattingEditProvider(
          { language: "gn" },
          new GnFormattingProvider(electronRoot)
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

      context.subscriptions.push(
        new OptionalFeature(
          "electronBuildTools.tests",
          "runTestCodeLens",
          (codeLensEnabled: boolean) => {
            if (codeLensEnabled) {
              Logger.info("Tests code lens enabled");
              return vscode.languages.registerCodeLensProvider(
                {
                  pattern: new vscode.RelativePattern(
                    electronRoot.fsPath,
                    "{spec,spec-main}/**/*-spec.{js,ts}"
                  ),
                },
                new TestCodeLensProvider(testsProvider)
              );
            } else {
              Logger.info("Tests code lens disabled");
            }
          }
        )
      );

      const linkableProvider = new DocsLinkablesProvider(electronRoot);
      context.subscriptions.push(linkableProvider);

      context.subscriptions.push(
        new OptionalFeature(
          "electronBuildTools.docs",
          "lintRelativeLinks",
          (shouldLintDocs: boolean) => {
            if (shouldLintDocs) {
              Logger.info("Docs relative link linting enabled");
              return setupDocsLinting(linkableProvider, diagnosticsCollection);
            } else {
              // TODO - Clear existing diagnostics so they don't linger
              Logger.info("Docs relative link linting disabled");
            }
          }
        )
      );

      // Render emojis in Markdown
      result.extendMarkdownIt = (md: MarkdownIt) => md.use(MarkdownItEmoji);
    }
  }

  setContext("ready", true);

  return result;
}
