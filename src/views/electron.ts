import * as path from "path";

import * as vscode from "vscode";

export class ElectronViewProvider
  implements vscode.TreeDataProvider<vscode.TreeItem> {
  constructor(private readonly workspaceFolder: vscode.WorkspaceFolder) {
    this.workspaceFolder = workspaceFolder;
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: vscode.TreeItem): Thenable<vscode.TreeItem[]> {
    if (!element) {
      return Promise.resolve([
        new ElectronTreeItem(
          "Getting Started",
          new vscode.ThemeIcon("rocket"),
          vscode.Uri.file(
            path.join(this.workspaceFolder.uri.fsPath, "README.md")
          )
        ),
        new ElectronTreeItem(
          "Code of Conduct",
          new vscode.ThemeIcon("smiley"),
          vscode.Uri.file(
            path.join(this.workspaceFolder.uri.fsPath, "CODE_OF_CONDUCT.md")
          )
        ),
        new ElectronTreeItem(
          "Contributing To Electron",
          new vscode.ThemeIcon("git-pull-request"),
          vscode.Uri.file(
            path.join(this.workspaceFolder.uri.fsPath, "CONTRIBUTING.md")
          )
        ),
        new ElectronTreeItem(
          "Reporting Security Issues",
          new vscode.ThemeIcon("shield"),
          vscode.Uri.file(
            path.join(this.workspaceFolder.uri.fsPath, "SECURITY.md")
          )
        ),
      ]);
    }

    return Promise.resolve([]);
  }
}

class ElectronTreeItem extends vscode.TreeItem {
  constructor(
    public readonly label: string,
    public readonly iconPath: vscode.ThemeIcon,
    public readonly uri: vscode.Uri
  ) {
    super(label, vscode.TreeItemCollapsibleState.None);

    this.command = {
      command: "markdown.showPreview",
      arguments: [uri],
      title: "Show",
    };
  }
}
