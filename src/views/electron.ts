import * as vscode from "vscode";
import { ThemeColor, ThemeIcon, TreeItem, TreeDataProvider } from "vscode";

export class ElectronViewProvider implements TreeDataProvider<TreeItem> {
  constructor(private readonly electronRoot: vscode.Uri) {}

  getTreeItem(element: TreeItem): TreeItem {
    return element;
  }

  async getChildren(element?: TreeItem): Promise<TreeItem[]> {
    if (!element) {
      return [
        new ElectronTreeItem(
          "Getting Started",
          new ThemeIcon(
            "rocket",
            new ThemeColor("electronBuildTools.gettingStartedIcon")
          ),
          vscode.Uri.joinPath(this.electronRoot, "README.md")
        ),
        new ElectronTreeItem(
          "Code of Conduct",
          new ThemeIcon(
            "smiley",
            new ThemeColor("electronBuildTools.codeOfConductIcon")
          ),
          vscode.Uri.joinPath(this.electronRoot, "CODE_OF_CONDUCT.md")
        ),
        new ElectronTreeItem(
          "Contributing To Electron",
          new ThemeIcon(
            "git-pull-request",
            new ThemeColor("electronBuildTools.contributingIcon")
          ),
          vscode.Uri.joinPath(this.electronRoot, "CONTRIBUTING.md")
        ),
        new ElectronTreeItem(
          "Reporting Security Issues",
          new ThemeIcon(
            "shield",
            new ThemeColor("electronBuildTools.securityIssuesIcon")
          ),
          vscode.Uri.joinPath(this.electronRoot, "SECURITY.md")
        ),
      ];
    }

    return [];
  }
}

class ElectronTreeItem extends TreeItem {
  constructor(
    label: string,
    public readonly iconPath: ThemeIcon,
    public readonly reasourceUri: vscode.Uri
  ) {
    super(label, vscode.TreeItemCollapsibleState.None);

    this.command = {
      command: "markdown.showPreview",
      arguments: [reasourceUri],
      title: "Show",
    };
  }
}
