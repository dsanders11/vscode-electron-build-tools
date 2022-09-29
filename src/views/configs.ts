import * as vscode from "vscode";

import { commandPrefix } from "../constants";
import { getConfigs, getConfigsFilePath } from "../utils";

export interface OnDidStartRefreshing {
  refreshFinished: Promise<void>;
}

export interface ConfigCollector {
  onDidStartRefreshing: vscode.Event<OnDidStartRefreshing>;

  refreshConfigs(): Promise<void>;
  getConfigs(): Promise<{ configs: string[]; activeConfig: string | null }>;
}

export class BuildToolsConfigCollector
  extends vscode.Disposable
  implements ConfigCollector {
  private _onDidStartRefreshing = new vscode.EventEmitter<OnDidStartRefreshing>();
  readonly onDidStartRefreshing = this._onDidStartRefreshing.event;

  private _configs?: string[];
  private _activeConfig: string | null = null;
  private _disposables: vscode.Disposable[] = [];

  constructor(private readonly _extensionContext: vscode.ExtensionContext) {
    super(() => {
      this._disposables.forEach((disposable) => disposable.dispose());
    });

    this._configs = _extensionContext.globalState.get<string[]>(
      "cachedConfigs"
    );

    const configWatcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(getConfigsFilePath(), "**")
    );

    this._disposables.push(
      configWatcher,
      configWatcher.onDidChange(() => this.refreshConfigs()),
      configWatcher.onDidCreate(() => this.refreshConfigs()),
      configWatcher.onDidDelete(() => this.refreshConfigs())
    );
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

    // Fire off an initial refresh for a better UX
    this._configCollector.refreshConfigs();
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

      if (configs.length !== 0) {
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
      command: `${commandPrefix}.openConfig`,
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
