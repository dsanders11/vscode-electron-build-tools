import * as path from "path";

import * as vscode from "vscode";

import { parseDocsSections, DocSection, DocLink } from "../utils";

export class ElectronViewProvider
  implements vscode.TreeDataProvider<vscode.TreeItem> {
  private readonly documentationRoot: ElectronDocsTreeItem;

  constructor(private readonly workspaceFolder: vscode.WorkspaceFolder) {
    this.workspaceFolder = workspaceFolder;
    this.documentationRoot = new ElectronDocsTreeItem(
      "Documentation",
      new vscode.ThemeIcon("remote-explorer-documentation"),
      null
    );
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: vscode.TreeItem): Promise<vscode.TreeItem[]> {
    if (!element) {
      return [
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
        this.documentationRoot,
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
      ];
    } else if (element instanceof ElectronDocsTreeItem) {
      if (element === this.documentationRoot) {
        element.docSection = await parseDocsSections(this.workspaceFolder);
      }

      const { links, sections } = element.docSection!;

      const children = sections.map((section) => {
        if (section.sections.length === 0 && section.links.length === 1) {
          // Special case, collapse it down to a single item
          return new ElectronTreeItem(
            section.heading,
            new vscode.ThemeIcon("file"),
            section.links[0].destination
          );
        }

        return new ElectronDocsTreeItem(section.heading, undefined, section);
      });

      for (let idx = 0; idx < links.length; idx++) {
        const link = links[idx];
        const nestedLinks = [];

        // Look ahead to see if there's nested links
        while (idx + 1 < links.length && links[idx + 1].level > link.level) {
          nestedLinks.push(links[idx + 1]);
          idx++;
        }

        children.push(
          new ElectronTreeItem(
            link.description,
            new vscode.ThemeIcon("file"),
            link.destination,
            nestedLinks
          )
        );
      }

      // Ensure sections first, then links
      return [
        ...children.filter((child) => child instanceof ElectronDocsTreeItem),
        ...children.filter((child) => child instanceof ElectronTreeItem),
      ];
    } else if (element instanceof ElectronTreeItem) {
      return element.nestedLinks.map(
        (link) =>
          new ElectronTreeItem(
            link.description,
            new vscode.ThemeIcon("file"),
            link.destination
          )
      );
    }

    return [];
  }
}

class ElectronTreeItem extends vscode.TreeItem {
  constructor(
    label: string,
    public readonly iconPath: vscode.ThemeIcon,
    public readonly reasourceUri: vscode.Uri,
    public readonly nestedLinks: DocLink[] = []
  ) {
    super(
      label,
      nestedLinks.length === 0
        ? vscode.TreeItemCollapsibleState.None
        : vscode.TreeItemCollapsibleState.Collapsed
    );

    this.command = {
      command: "markdown.showPreview",
      arguments: [reasourceUri],
      title: "Show",
    };
  }
}

class ElectronDocsTreeItem extends vscode.TreeItem {
  constructor(
    label: string,
    public readonly iconPath: vscode.ThemeIcon | undefined,
    public docSection: DocSection | null
  ) {
    super(label, vscode.TreeItemCollapsibleState.Collapsed);
  }
}
