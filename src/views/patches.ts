import * as path from "path";

import * as vscode from "vscode";

import { patchDirectoryPretyNames } from "../constants";
import { ElectronPatchesConfig } from "../types";
import {
  getCheckoutDirectoryForPatchDirectory,
  getFilesInPatch,
  getPatches,
  getPatchSubjectLine,
  getRootDirectoryFromWorkspaceFolder,
  parsePatchConfig,
  patchTooltipMarkdown,
  truncateToLength,
} from "../utils";

export class ElectronPatchesProvider
  implements vscode.TreeDataProvider<vscode.TreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<vscode.TreeItem | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private readonly patchesConfig: Promise<ElectronPatchesConfig>;
  private readonly rootDirectory: vscode.Uri;

  constructor(
    workspaceFolder: vscode.WorkspaceFolder,
    patchesConfig: vscode.Uri
  ) {
    this.rootDirectory = getRootDirectoryFromWorkspaceFolder(workspaceFolder);
    this.patchesConfig = parsePatchConfig(patchesConfig);
  }

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  async resolveTreeItem(element: vscode.TreeItem, item: any): Promise<any> {
    if (element instanceof Patch) {
      item.tooltip = await patchTooltipMarkdown(element.uri);
    }

    return item;
  }

  async getChildren(element?: vscode.TreeItem): Promise<vscode.TreeItem[]> {
    const children: vscode.TreeItem[] = [];

    if (!element) {
      // Root element, read the config file for all patch directories
      for (const patchDirectory of Object.keys(await this.patchesConfig)) {
        const patchDirectoryBasename = path.basename(patchDirectory);
        const uri = vscode.Uri.file(
          path.resolve(this.rootDirectory.fsPath, patchDirectory)
        );
        const label =
          patchDirectoryPretyNames[patchDirectory] || patchDirectoryBasename;

        children.push(new PatchDirectory(label, uri, patchDirectoryBasename));
      }
    } else if (
      element.collapsibleState !== vscode.TreeItemCollapsibleState.None
    ) {
      if (element instanceof PatchDirectory) {
        const patchFilenames = await getPatches(element.uri);

        // Use the patch subject line for a more human-friendly label
        for (const filename of patchFilenames) {
          const label =
            (await getPatchSubjectLine(filename)) ||
            path.basename(filename.fsPath);
          children.push(new Patch(truncateToLength(label, 50), filename));
        }
      } else if (element instanceof Patch) {
        children.push(new PatchOverview(element.uri));

        const patchDirectory = vscode.Uri.file(
          path.dirname(element.uri.fsPath)
        );
        const checkoutDirectory = getCheckoutDirectoryForPatchDirectory(
          this.rootDirectory,
          await this.patchesConfig,
          patchDirectory
        );
        const patchedFilenames = await getFilesInPatch(
          checkoutDirectory,
          element.uri
        );

        children.push(
          ...patchedFilenames.map(
            (filename) =>
              new FileInPatch(
                path.basename(element.uri.path),
                checkoutDirectory,
                filename
              )
          )
        );
      }
    }

    return Promise.resolve(children);
  }
}

export class PatchDirectory extends vscode.TreeItem {
  constructor(label: string, public uri: vscode.Uri, public name: string) {
    super(label, vscode.TreeItemCollapsibleState.Collapsed);

    this.name = name;
    this.uri = uri; // BUG - resourceUri doesn't play nice with advanced hover
    this.iconPath = new vscode.ThemeIcon("repo");
    this.contextValue = "repo";
  }
}

class Patch extends vscode.TreeItem {
  constructor(label: string, public uri: vscode.Uri) {
    super(label, vscode.TreeItemCollapsibleState.Collapsed);

    this.uri = uri; // BUG - resourceUri doesn't play nice with advanced hover
    this.iconPath = new vscode.ThemeIcon("file-text");
  }
}

class PatchOverview extends vscode.TreeItem {
  constructor(uri: vscode.Uri) {
    super("Overview", vscode.TreeItemCollapsibleState.None);

    this.iconPath = new vscode.ThemeIcon("preview");

    this.command = {
      command: "electron-build-tools.showPatchOverview",
      arguments: [uri],
      title: "Show Patch Overview",
    };
  }
}

class FileInPatch extends vscode.TreeItem {
  constructor(
    patchName: string,
    checkoutDirectory: vscode.Uri,
    uri: vscode.Uri
  ) {
    super(uri, vscode.TreeItemCollapsibleState.None);

    // Label it with the path within the checkout directory to avoid duplicate names
    this.label = path
      .relative(checkoutDirectory.path, uri.path)
      .split(path.sep)
      .join(path.posix.sep);

    this.command = {
      command: "electron-build-tools.showCommitDiff",
      arguments: [checkoutDirectory, patchName, uri, this.label],
      title: "Show Commit Diff",
    };
  }
}
