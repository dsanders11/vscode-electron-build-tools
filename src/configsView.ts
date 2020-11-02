import * as vscode from "vscode";

import { getConfigs } from "./utils";

export class ElectronBuildToolsConfigsProvider
  implements vscode.TreeDataProvider<Config> {
  private _onDidChangeTreeData = new vscode.EventEmitter<
    Config | undefined | void
  >();
  readonly onDidChangeTreeData: vscode.Event<Config | undefined | void> = this
    ._onDidChangeTreeData.event;
  private _cachedConfigs: Config[] = [];

  setActive(configName: string) {
    let oldActiveConfig;
    let newActiveConfig;

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
    this._onDidChangeTreeData.fire(oldActiveConfig);
    this._onDidChangeTreeData.fire(newActiveConfig);
  }

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: Config): vscode.TreeItem {
    return element;
  }

  getChildren(element?: Config): Thenable<Config[]> {
    const configs = [];

    if (!element) {
      const { configs: configNames, activeConfig } = getConfigs();
      for (const configName of configNames) {
        configs.push(
          new Config(
            configName,
            configName === activeConfig,
            vscode.TreeItemCollapsibleState.None
          )
        );
      }
    }

    this._cachedConfigs = configs;

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

    this.setActiveLabel(isActive);

    this.command = {
      command: "electron-build-tools.openConfig",
      arguments: [label],
      title: "Open Config",
    };
  }

  setActiveLabel(isActive: boolean) {
    const currentDescription = this.description;

    this.description = isActive ? "(Active)" : undefined;

    return currentDescription !== this.description;
  }
}
