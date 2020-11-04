import * as chokidar from "chokidar";
import * as vscode from "vscode";

import { getConfigs, getConfigsFilePath } from "./utils";

export class ElectronBuildToolsConfigsProvider
  implements vscode.TreeDataProvider<vscode.TreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<
    vscode.TreeItem | undefined | void
  >();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
  private _cachedConfigs: ConfigTreeItem[] = [];

  constructor() {
    const watcher = chokidar.watch(getConfigsFilePath(), {
      ignoreInitial: true,
    });
    watcher.on("all", () => {
      this.refresh();
    });
  }

  setActive(configName: string | null): ConfigTreeItem {
    let oldActiveConfig: ConfigTreeItem;
    let newActiveConfig: ConfigTreeItem;

    for (const config of this._cachedConfigs) {
      const isActive = config.label === configName;
      const changed = config.setActiveLabel(isActive);

      if (isActive) {
        newActiveConfig = config;
      } else if (changed) {
        oldActiveConfig = config;
      }
    }

    // Take off the old label first, then apply new label
    this._onDidChangeTreeData.fire(oldActiveConfig!);
    this._onDidChangeTreeData.fire(newActiveConfig!);

    return oldActiveConfig!;
  }

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: vscode.TreeItem): Thenable<vscode.TreeItem[]> {
    const configs: vscode.TreeItem[] = [];

    if (!element) {
      const { configs: configNames, activeConfig } = getConfigs();

      for (const configName of configNames) {
        configs.push(
          new ConfigTreeItem(
            configName,
            configName === activeConfig,
            vscode.TreeItemCollapsibleState.None
          )
        );
      }

      if (configs.length === 0) {
        configs.push(new vscode.TreeItem("There are no configs"));
      } else {
        this._cachedConfigs = configs as ConfigTreeItem[];
      }
    }

    return Promise.resolve(configs);
  }
}

export class ConfigTreeItem extends vscode.TreeItem {
  constructor(
    public readonly label: string,
    isActive: boolean,
    public readonly collapsibleState: vscode.TreeItemCollapsibleState
  ) {
    super(label, collapsibleState);

    this.setActiveLabel(isActive);

    this.iconPath = new vscode.ThemeIcon("file-code");
    this.command = {
      command: "electron-build-tools.openConfig",
      arguments: [label],
      title: "Open Config",
    };
  }

  setActiveLabel(isActive: boolean) {
    const currentDescription = this.description;

    this.description = isActive ? "(Active)" : undefined;
    this.contextValue = isActive ? "active-config" : "config";

    return currentDescription !== this.description;
  }
}
