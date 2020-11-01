import * as vscode from "vscode";

import * as childProcess from "child_process";

export class ElectronBuildToolsConfigsProvider
  implements vscode.TreeDataProvider<Config> {
  private _onDidChangeTreeData: vscode.EventEmitter<
    Config | undefined
  > = new vscode.EventEmitter<Config | undefined>();
  readonly onDidChangeTreeData: vscode.Event<Config | undefined> = this
    ._onDidChangeTreeData.event;

  refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  getTreeItem(element: Config): vscode.TreeItem {
    return element;
  }

  getChildren(element?: Config): Thenable<Config[]> {
    const configs = [];

    if (!element) {
      const configsOutput = childProcess
        .execSync("electron-build-tools show configs", { encoding: "utf8" })
        .trim();
      for (const configName of configsOutput.split("\n")) {
        const isActive = configName.trim().startsWith("*");
        configs.push(
          new Config(
            configName.replace("*", "").trim(),
            isActive,
            vscode.TreeItemCollapsibleState.None
          )
        );
      }
    }

    return Promise.resolve(configs);
  }
}

class Config extends vscode.TreeItem {
  constructor(
    public readonly label: string,
    isActive: boolean,
    public readonly collapsibleState: vscode.TreeItemCollapsibleState
  ) {
    super(label, collapsibleState);

    if (isActive) {
      this.description = "(Active)";
    }

    this.command = {
      command: "electron-build-tools.openConfig",
      arguments: [label],
      title: "Open Config",
    };
  }
}
