import * as path from "path";

import * as vscode from "vscode";

import {
  commandPrefix,
  patchDirectoryPrettyNames,
  pullRequestScheme,
} from "../constants";
import type { ElectronPatchesConfig } from "../types";
import {
  ensurePosixSeparators,
  FileInPatch,
  getCheckoutDirectoryForPatchDirectory,
  getFilesInPatch,
  getPatches,
  getPatchSubjectLine,
  parsePatchConfig,
  patchTooltipMarkdown,
  truncateToLength,
} from "../utils";

export type PullRequestWithPatch = {
  prNumber: string;
  title: string;
  patchDirectories: string[];
};

export class ElectronPatchesProvider
  implements vscode.TreeDataProvider<vscode.TreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<vscode.TreeItem | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private readonly patchesConfig: Promise<ElectronPatchesConfig>;
  private readonly rootDirectory: vscode.Uri;
  private readonly viewPullRequestTreeItem: ViewPullRequestPatchTreeItem;

  constructor(
    private readonly _electronRoot: vscode.Uri,
    patchesConfig: vscode.Uri
  ) {
    this.rootDirectory = vscode.Uri.joinPath(_electronRoot, "..", "..");
    this.patchesConfig = parsePatchConfig(patchesConfig);

    this.viewPullRequestTreeItem = new ViewPullRequestPatchTreeItem();
  }

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  showPr(pullRequest: PullRequestWithPatch): PullRequestTreeItem {
    if (!this.viewPullRequestTreeItem.pullRequests.has(pullRequest.prNumber)) {
      this.viewPullRequestTreeItem.collapsibleState =
        vscode.TreeItemCollapsibleState.Expanded;
      this.viewPullRequestTreeItem.pullRequests.set(
        pullRequest.prNumber,
        new PullRequestTreeItem(pullRequest)
      );

      this._onDidChangeTreeData.fire(this.viewPullRequestTreeItem);
    }

    return this.viewPullRequestTreeItem.pullRequests.get(pullRequest.prNumber)!;
  }

  removePr(pullRequest: PullRequestWithPatch) {
    if (
      this.viewPullRequestTreeItem.pullRequests.delete(pullRequest.prNumber)
    ) {
      if (this.viewPullRequestTreeItem.pullRequests.size === 0) {
        this.viewPullRequestTreeItem.collapsibleState =
          vscode.TreeItemCollapsibleState.None;
      }

      this._onDidChangeTreeData.fire(this.viewPullRequestTreeItem);
    }
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

  getParent(element: vscode.TreeItem): vscode.TreeItem | null {
    if (element instanceof PullRequestTreeItem) {
      return this.viewPullRequestTreeItem;
    } else if (element === this.viewPullRequestTreeItem) {
      return null;
    } else if (element instanceof Patch) {
      return element.parent;
    } else if (element instanceof PatchDirectory) {
      return null;
    } else {
      throw new Error("Not implemented");
    }
  }

  async getPatchTreeItemForUri(uri: vscode.Uri): Promise<Patch> {
    const patchesRoot = vscode.Uri.joinPath(this._electronRoot, "patches");

    if (!uri.path.startsWith(patchesRoot.path)) {
      throw new Error("Uri not in patches directory");
    }

    const patchDir = path.relative(patchesRoot.path, path.dirname(uri.path));

    const walkTree = async (element?: vscode.TreeItem): Promise<Patch> => {
      if (!element) {
        const children = (await this.getChildren()) as PatchDirectory[];
        const child = children.find((child) => child.name === patchDir);

        if (child) {
          return await walkTree(child);
        } else {
          throw new Error("Couldn't find patch directory tree item");
        }
      } else {
        const children = (await this.getChildren(element)) as Patch[];
        const child = children.find((child) => child.uri.fsPath === uri.fsPath);

        if (child) {
          return child;
        } else {
          throw new Error("Couldn't find patch tree item");
        }
      }
    };

    return walkTree();
  }

  async getChildren(element?: vscode.TreeItem): Promise<vscode.TreeItem[]> {
    const children: vscode.TreeItem[] = [];

    if (!element) {
      // Root element, read the config file for all patch directories
      for (const patchDirectory of Object.keys(await this.patchesConfig)) {
        const patchDirectoryBasename = path.basename(patchDirectory);
        const uri = vscode.Uri.joinPath(this.rootDirectory, patchDirectory);
        const label =
          patchDirectoryPrettyNames[patchDirectory] ?? patchDirectoryBasename;

        children.push(new PatchDirectory(label, uri, patchDirectoryBasename));
      }

      // Also include the node for viewing patches in pull requests
      children.push(this.viewPullRequestTreeItem);
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
          children.push(
            new Patch(truncateToLength(label, 50), filename, element)
          );
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
            (metadata) =>
              new FileInPatchTreeItem(element.uri, checkoutDirectory, metadata)
          )
        );
      } else if (element instanceof ViewPullRequestPatchTreeItem) {
        children.push(...element.pullRequests.values());
      } else if (element instanceof PullRequestTreeItem) {
        for (const patchDirectory of element.pullRequest.patchDirectories) {
          const patchDirectoryBasename = path.basename(patchDirectory);
          const uri = vscode.Uri.joinPath(this.rootDirectory, patchDirectory);
          const label =
            patchDirectoryPrettyNames[patchDirectory] ?? patchDirectoryBasename;

          children.push(
            new PatchDirectory(
              label,
              uri.with({
                scheme: pullRequestScheme,
                query: `pullRequest=${element.pullRequest.prNumber}`,
              }),
              patchDirectoryBasename
            )
          );
        }
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
    this.contextValue =
      uri.scheme === pullRequestScheme ? "pull-request-repo" : "repo";
  }
}

export class Patch extends vscode.TreeItem {
  constructor(
    label: string,
    public uri: vscode.Uri,
    public readonly parent: PatchDirectory
  ) {
    super(label, vscode.TreeItemCollapsibleState.Collapsed);

    this.uri = uri; // BUG - resourceUri doesn't play nice with advanced hover
    this.iconPath = new vscode.ThemeIcon("file-text");
    this.contextValue = "patch";
  }
}

class PatchOverview extends vscode.TreeItem {
  constructor(uri: vscode.Uri) {
    super("Overview", vscode.TreeItemCollapsibleState.None);

    this.iconPath = new vscode.ThemeIcon("preview");

    this.command = {
      command: `${commandPrefix}.showPatchOverview`,
      arguments: [uri],
      title: "Show Patch Overview",
    };
  }
}

class FileInPatchTreeItem extends vscode.TreeItem {
  constructor(
    patch: vscode.Uri,
    checkoutDirectory: vscode.Uri,
    metadata: FileInPatch
  ) {
    super(metadata.file, vscode.TreeItemCollapsibleState.None);

    // Label it with the path within the checkout directory to avoid duplicate names
    this.label = ensurePosixSeparators(
      path.relative(checkoutDirectory.path, metadata.file.path)
    );
    this.tooltip = this.label;

    this.command = {
      command: `${commandPrefix}.showPatchedFileDiff`,
      arguments: [checkoutDirectory, patch, metadata, this.label],
      title: "Show Patched File Diff",
    };
  }
}

class ViewPullRequestPatchTreeItem extends vscode.TreeItem {
  public readonly pullRequests: Map<string, PullRequestTreeItem> = new Map();

  constructor() {
    super("View Patches in Pull Request", vscode.TreeItemCollapsibleState.None);

    this.iconPath = new vscode.ThemeIcon("git-pull-request");
    this.contextValue = "view-pull-request-patch";
  }
}

export class PullRequestTreeItem extends vscode.TreeItem {
  constructor(public readonly pullRequest: PullRequestWithPatch) {
    super(
      `#${pullRequest.prNumber} - ${pullRequest.title}`,
      vscode.TreeItemCollapsibleState.Expanded
    );

    this.tooltip = this.label;
    this.iconPath = new vscode.ThemeIcon("git-pull-request");
    this.contextValue = "pull-request";
  }
}
