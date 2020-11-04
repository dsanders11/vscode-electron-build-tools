import * as vscode from "vscode";

import { buildToolsRepository, extensionId, repositoryUrl } from "./constants";

export class HelpTreeDataProvider
  implements vscode.TreeDataProvider<vscode.TreeItem> {
  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: vscode.TreeItem): Thenable<vscode.TreeItem[]> {
    if (!element) {
      const reportIssueTreeItem = new vscode.TreeItem(
        "Report Issue",
        vscode.TreeItemCollapsibleState.None
      );
      reportIssueTreeItem.iconPath = new vscode.ThemeIcon(
        "remote-explorer-report-issues"
      );
      reportIssueTreeItem.command = {
        command: "vscode.openIssueReporter",
        arguments: [`${extensionId}`],
        title: "Report Issue",
      };

      return Promise.resolve([
        new LinkHelpTreeItem(
          "Extension Documentation",
          new vscode.ThemeIcon("remote-explorer-documentation"),
          vscode.Uri.parse(`${repositoryUrl}/wiki`)
        ),
        new LinkHelpTreeItem(
          "Electron Build Tools Documentation",
          new vscode.ThemeIcon("remote-explorer-documentation"),
          vscode.Uri.parse(buildToolsRepository)
        ),
        new LinkHelpTreeItem(
          "Review Issues",
          new vscode.ThemeIcon("remote-explorer-review-issues"),
          vscode.Uri.parse(`${repositoryUrl}/issues`)
        ),
        reportIssueTreeItem,
      ]);
    }

    return Promise.resolve([]);
  }
}

class LinkHelpTreeItem extends vscode.TreeItem {
  constructor(
    public readonly label: string,
    public readonly iconPath: vscode.ThemeIcon,
    public readonly url: vscode.Uri
  ) {
    super(label, vscode.TreeItemCollapsibleState.None);

    this.command = {
      command: "vscode.open",
      arguments: [url],
      title: "Open Link",
    };
  }
}
