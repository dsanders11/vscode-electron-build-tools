import * as vscode from "vscode";

import * as chokidar from "chokidar";

import { getConfigs, getConfigsFilePath } from "../utils";

export type OnDidStartRefreshing = {
  refreshFinished: Promise<void>;
};

export interface ConfigCollector {
  onDidStartRefreshing: vscode.Event<OnDidStartRefreshing>;

  refreshConfigs(): Promise<void>;
  getConfigs(): Promise<{ configs: string[]; activeConfig: string | null }>;
}

export class BuildToolsConfigCollector implements ConfigCollector {
  private _onDidStartRefreshing = new vscode.EventEmitter<
    OnDidStartRefreshing
  >();
  readonly onDidStartRefreshing = this._onDidStartRefreshing.event;

  private _configs?: string[];
  private _activeConfig: string | null = null;

  constructor(private readonly _extensionContext: vscode.ExtensionContext) {
    this._configs = _extensionContext.globalState.get<string[]>(
      "cachedConfigs"
    );

    const watcher = chokidar.watch(getConfigsFilePath(), {
      ignoreInitial: true,
    });
    watcher.on("all", () => this.refreshConfigs());
  }

  async _getConfigs(): Promise<void> {
    const { configs, activeConfig } = await getConfigs();

    this._configs = configs;
    this._activeConfig = activeConfig;

    await this._extensionContext.globalState.update(
      "cachedConfigs",
      this._configs
    );
  }

  refreshConfigs(): Promise<void> {
    const refreshFinished = this._getConfigs();
    this._onDidStartRefreshing.fire({ refreshFinished });

    return refreshFinished;
  }

  async getConfigs(): Promise<{
    configs: string[];
    activeConfig: string | null;
  }> {
    if (this._configs === undefined) {
      await this._getConfigs();
    } else if (this._activeConfig === null) {
      // Active config isn't stored since it changes more often, so
      // do a background refresh to get the currently active config
      this.refreshConfigs();
    }

    return { configs: this._configs!, activeConfig: this._activeConfig };
  }
}

export class ElectronBuildToolsConfigsProvider
  implements vscode.TreeDataProvider<vscode.TreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<
    vscode.TreeItem | undefined | void
  >();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
  private _treeItems: ConfigTreeItem[] = [];

  constructor(private readonly _configCollector: ConfigCollector) {
    this._configCollector.onDidStartRefreshing(async ({ refreshFinished }) => {
      await refreshFinished;
      this.refresh();
    });
  }

  setActive(configName: string | null): ConfigTreeItem | undefined {
    let oldActiveConfig: ConfigTreeItem | undefined;
    let newActiveConfig: ConfigTreeItem;

    for (const config of this._treeItems) {
      const isActive = config.label === configName;
      const changed = config.setActiveLabel(isActive);

      if (isActive) {
        newActiveConfig = config;
      } else if (changed) {
        oldActiveConfig = config;
      }
    }

    // Take off the old label first, then apply new label
    if (oldActiveConfig) {
      this._onDidChangeTreeData.fire(oldActiveConfig!);
    }
    this._onDidChangeTreeData.fire(newActiveConfig!);

    return oldActiveConfig;
  }

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: vscode.TreeItem): Promise<vscode.TreeItem[]> {
    const configs: vscode.TreeItem[] = [];

    if (!element) {
      const {
        configs: configNames,
        activeConfig,
      } = await this._configCollector.getConfigs();

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
        this._treeItems = configs as ConfigTreeItem[];
      }
    }

    return configs;
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
