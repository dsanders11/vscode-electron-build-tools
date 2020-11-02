import * as vscode from "vscode";
import * as childProcess from "child_process";
import * as fs from "fs";
import * as path from "path";

import { ElectronBuildToolsConfigsProvider } from "./configsView";
import { getConfigs, getConfigsFilePath } from "./utils";

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
    vscode.commands.registerCommand("electron-build-tools.show.exe", () => {
      return childProcess
        .execSync("electron-build-tools show exe", { encoding: "utf8" })
        .trim();
    }),
    vscode.commands.registerCommand("electron-build-tools.show.root", () => {
      return childProcess
        .execSync("electron-build-tools show root", { encoding: "utf8" })
        .trim();
    }),
    vscode.commands.registerCommand(
      "electron-build-tools.useConfig",
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
      "electron-build-tools.useConfigQuickPick",
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

  if (workspaceFolders) {
    if (electronIsInWorkspace(workspaceFolders[0])) {
      const configsProvider = new ElectronBuildToolsConfigsProvider();
      registerElectronBuildToolsCommands(context, configsProvider);
      registerHelperCommands(context);
      context.subscriptions.push(
        vscode.window.registerTreeDataProvider(
          "electron-build-tools:configs",
          configsProvider
        )
      );
    }
  }
}
