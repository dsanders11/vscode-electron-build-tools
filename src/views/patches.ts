import * as path from "node:path";

import * as vscode from "vscode";

import {
  commandPrefix,
  patchDirectoryPrettyNames,
  virtualDocumentScheme,
  PatchDirectoryPrettyName,
} from "../constants";
import Logger from "../logging";
import type { ElectronPatchesConfig } from "../types";
import {
  ensurePosixSeparators,
  getCheckoutDirectoryForPatchDirectory,
  getFilesInPatch,
  getPatches,
  getPatchSubjectLine,
  parsePatchConfig,
  patchTooltipMarkdown,
  truncateToLength,
} from "../utils";

interface PullRequestWithPatch {
  prNumber: string;
  title: string;
  repo: { owner: string; repo: string };
  patches: Map<string, Set<vscode.Uri>>;
}

function sortPatchDirectories(children: vscode.TreeItem[]) {
  try {
    children.sort((a, b) => {
      if (a instanceof PatchDirectory && b instanceof PatchDirectory) {
        return a.label.localeCompare(b.label);
      } else {
        throw new Error("Expected only PatchDirectory files");
      }
    });
  } catch (err) {
    Logger.error(err instanceof Error ? err : String(err));
  }
}

export class ElectronPatchesProvider
  implements vscode.TreeDataProvider<vscode.TreeItem>
{
  private _onDidChangeTreeData =
    new vscode.EventEmitter<vscode.TreeItem | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private readonly patchesConfig: Promise<ElectronPatchesConfig>;
  private readonly rootDirectory: vscode.Uri;
  private readonly viewPullRequestTreeItem: ViewPullRequestPatchTreeItem;

  constructor(
    context: vscode.ExtensionContext,
    _electronRoot: vscode.Uri,
    patchesConfig: vscode.Uri,
  ) {
    this.rootDirectory = vscode.Uri.joinPath(_electronRoot, "..", "..");
    this.patchesConfig = parsePatchConfig(patchesConfig);

    this.viewPullRequestTreeItem = new ViewPullRequestPatchTreeItem();

    const fsWatcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(_electronRoot, "patches/**"),
    );

    context.subscriptions.push(
      fsWatcher,
      fsWatcher.onDidChange(() => this.refresh()),
      fsWatcher.onDidCreate(() => this.refresh()),
      fsWatcher.onDidDelete(() => this.refresh()),
    );
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
        new PullRequestTreeItem(pullRequest),
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

  async resolveTreeItem(
    element: vscode.TreeItem,
    item: vscode.TreeItem,
  ): Promise<vscode.TreeItem> {
    if (element instanceof Patch) {
      item.tooltip = await patchTooltipMarkdown(element.resourceUri);
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

  async getChildren(element?: vscode.TreeItem): Promise<vscode.TreeItem[]> {
    const children: vscode.TreeItem[] = [];

    if (!element) {
      // Root element, read the config file for all patch directories
      for (const { patch_dir: patchDirectory } of await this.patchesConfig) {
        const patchDirectoryBasename = path.basename(patchDirectory);
        const uri = vscode.Uri.joinPath(this.rootDirectory, patchDirectory);
        const label =
          patchDirectoryPrettyNames[
            patchDirectory as PatchDirectoryPrettyName
          ] ?? patchDirectoryBasename;

        children.push(new PatchDirectory(label, uri, patchDirectoryBasename));
      }

      // Sort by label to make it easier to visually browse
      sortPatchDirectories(children);

      // Also include the node for viewing patches in pull requests
      children.push(this.viewPullRequestTreeItem);
    } else if (
      element.collapsibleState !== vscode.TreeItemCollapsibleState.None
    ) {
      if (element instanceof PatchDirectory) {
        let patchFilenames: vscode.Uri[];

        if (element instanceof PullRequestPatchDirectory) {
          patchFilenames = element.patches;
        } else {
          patchFilenames = await getPatches(element.resourceUri);
        }

        // Use the patch subject line for a more human-friendly label
        for (const filename of patchFilenames) {
          const label =
            (await getPatchSubjectLine(filename)) ||
            path.basename(filename.fsPath);

          children.push(
            new Patch(truncateToLength(label, 50), filename, element),
          );
        }
      } else if (element instanceof Patch) {
        children.push(new PatchOverview(element.resourceUri));

        const patchDirectory = vscode.Uri.file(
          path.dirname(element.resourceUri.fsPath),
        );
        const checkoutDirectory = getCheckoutDirectoryForPatchDirectory(
          this.rootDirectory,
          await this.patchesConfig,
          patchDirectory,
        );
        const patchedFilenames = await getFilesInPatch(
          checkoutDirectory,
          element.resourceUri,
        );

        children.push(
          ...patchedFilenames.map(
            (file) =>
              new FileInPatchTreeItem(
                file.with({ scheme: virtualDocumentScheme }),
                checkoutDirectory,
              ),
          ),
        );
      } else if (element instanceof ViewPullRequestPatchTreeItem) {
        children.push(...element.pullRequests.values());
      } else if (element instanceof PullRequestTreeItem) {
        for (const patchDirectory of element.pullRequest.patches.keys()) {
          const patchDirectoryBasename = path.basename(patchDirectory);
          const uri = vscode.Uri.joinPath(this.rootDirectory, patchDirectory);
          const label =
            patchDirectoryPrettyNames[
              patchDirectory as PatchDirectoryPrettyName
            ] ?? patchDirectoryBasename;

          children.push(
            new PullRequestPatchDirectory(label, uri, patchDirectoryBasename, [
              ...element.pullRequest.patches.get(patchDirectory)!.values(),
            ]),
          );
        }

        // Sort by label to make it easier to visually browse
        sortPatchDirectories(children);
      }
    }

    return Promise.resolve(children);
  }
}

export class PatchDirectory extends vscode.TreeItem {
  constructor(
    public label: string,
    public resourceUri: vscode.Uri,
    public name: string,
  ) {
    super(label, vscode.TreeItemCollapsibleState.Collapsed);

    this.iconPath = new vscode.ThemeIcon("repo");
    this.contextValue = "repo";
  }
}

class PullRequestPatchDirectory extends PatchDirectory {
  constructor(
    label: string,
    resourceUri: vscode.Uri,
    name: string,
    public patches: vscode.Uri[],
  ) {
    super(label, resourceUri, name);

    this.contextValue = "pull-request-repo";
  }
}

export class Patch extends vscode.TreeItem {
  constructor(
    public label: string,
    public resourceUri: vscode.Uri,
    public readonly parent: PatchDirectory,
  ) {
    super(resourceUri, vscode.TreeItemCollapsibleState.Collapsed);

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

export class FileInPatchTreeItem extends vscode.TreeItem {
  constructor(
    public resourceUri: vscode.Uri,
    checkoutDirectory: vscode.Uri,
  ) {
    // Label it with the path within the checkout directory to avoid duplicate names
    const label = ensurePosixSeparators(
      path.relative(checkoutDirectory.path, resourceUri.path),
    );

    super(label, vscode.TreeItemCollapsibleState.None);

    this.tooltip = label;

    this.command = {
      command: `${commandPrefix}.showPatchedFileDiff`,
      arguments: [this.resourceUri, this.label],
      title: "Show Patched File Diff",
    };
    this.contextValue = "file-in-patch";
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
      vscode.TreeItemCollapsibleState.Expanded,
    );

    this.tooltip = this.label as string;
    this.iconPath = new vscode.ThemeIcon("git-pull-request");
    this.contextValue = "pull-request";
  }
}
