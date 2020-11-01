import * as vscode from "vscode";
import * as childProcess from "child_process";
import * as fs from "fs";
import * as path from "path";

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

function registerElectronBuildToolsCommands(context: vscode.ExtensionContext) {
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
        childProcess.execSync(`electron-build-tools use ${config.label}`, {
          encoding: "utf8",
        });
        configsProvider.refresh();
      }
    ),
    vscode.commands.registerCommand(
      "electron-build-tools.openConfig",
      async (configName) => {
        const configFilePath = path.join(
          os.homedir(),
          ".electron_build_tools",
          "configs",
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
      registerElectronBuildToolsCommands(context);
      registerHelperCommands(context);
    }
  }
}
