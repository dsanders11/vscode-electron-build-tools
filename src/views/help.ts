import * as vscode from "vscode";

import {
  buildToolsRepository,
  commandPrefix,
  extensionId,
  repositoryUrl,
} from "../constants";

export class HelpTreeDataProvider
  implements vscode.TreeDataProvider<vscode.TreeItem>
{
  constructor(private readonly extensionUri: vscode.Uri) {}

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: vscode.TreeItem): Promise<vscode.TreeItem[]> {
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

      const walkthroughTreeItem = new vscode.TreeItem(
        "Open Extension Walkthrough",
        vscode.TreeItemCollapsibleState.None
      );
      walkthroughTreeItem.iconPath = new vscode.ThemeIcon("extensions");
      walkthroughTreeItem.command = {
        command: `${commandPrefix}.openWalkthrough`,
        title: "Open Walkthrough",
      };

      return [
        new LinkHelpTreeItem(
          "Extension Documentation",
          new vscode.ThemeIcon("remote-explorer-documentation"),
          vscode.Uri.parse(`${repositoryUrl}/wiki`)
        ),
        new LinkHelpTreeItem(
          "Electron Build Tools",
          {
            dark: vscode.Uri.joinPath(
              this.extensionUri,
              "resources",
              "icons",
              "dark",
              "electron.svg"
            ),
            light: vscode.Uri.joinPath(
              this.extensionUri,
              "resources",
              "icons",
              "light",
              "electron.svg"
            ),
          },
          vscode.Uri.parse(buildToolsRepository)
        ),
        walkthroughTreeItem,
        new LinkHelpTreeItem(
          "Review Issues",
          new vscode.ThemeIcon("remote-explorer-review-issues"),
          vscode.Uri.parse(`${repositoryUrl}/issues`)
        ),
        reportIssueTreeItem,
      ];
    }

    return [];
  }
}

class LinkHelpTreeItem extends vscode.TreeItem {
  constructor(
    public readonly label: string,
    public readonly iconPath:
      | vscode.ThemeIcon
      | {
          light: vscode.Uri;
          dark: vscode.Uri;
        },
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
