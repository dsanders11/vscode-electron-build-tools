import * as vscode from "vscode";
import { ThemeIcon, TreeItem, TreeDataProvider } from "vscode";

import { parseDocsSections, DocSection, DocLink } from "../utils";

export class DocsTreeDataProvider implements TreeDataProvider<TreeItem> {
  constructor(private readonly electronRoot: vscode.Uri) {}

  getTreeItem(element: TreeItem): TreeItem {
    return element;
  }

  async getChildren(element?: TreeItem): Promise<TreeItem[]> {
    if (!element || element instanceof GroupingTreeItem) {
      const { links, sections } = !element
        ? await parseDocsSections(this.electronRoot)
        : element.docSection;

      const children = sections.map((section) => {
        if (section.sections.length === 0 && section.links.length === 1) {
          // Special case, collapse it down to a single item
          return new DocumentTreeItem(
            section.heading,
            new ThemeIcon("file"),
            section.links[0].destination,
          );
        }

        return new GroupingTreeItem(
          section.heading,
          new ThemeIcon("library"),
          section,
        );
      });

      for (let idx = 0; idx < links.length; idx++) {
        const link = links[idx];
        const nestedLinks: DocLink[] = [];

        // Look ahead to see if there's nested links
        while (idx + 1 < links.length && links[idx + 1].level > link.level) {
          nestedLinks.push(links[idx + 1]);
          idx++;
        }

        children.push(
          new DocumentTreeItem(
            link.description,
            new ThemeIcon("file"),
            link.destination,
            nestedLinks,
          ),
        );
      }

      // Ensure sections first, then links
      return [
        ...children.filter((child) => child instanceof GroupingTreeItem),
        ...children.filter((child) => child instanceof DocumentTreeItem),
      ];
    } else if (element instanceof DocumentTreeItem) {
      return element.nestedLinks.map(
        (link) =>
          new DocumentTreeItem(
            link.description,
            new ThemeIcon("file"),
            link.destination,
          ),
      );
    }

    return [];
  }
}

class DocumentTreeItem extends TreeItem {
  constructor(
    label: string,
    public readonly iconPath: ThemeIcon,
    public readonly resourceUri: vscode.Uri,
    public readonly nestedLinks: DocLink[] = [],
  ) {
    super(
      label,
      nestedLinks.length === 0
        ? vscode.TreeItemCollapsibleState.None
        : vscode.TreeItemCollapsibleState.Collapsed,
    );

    this.command = {
      command: "markdown.showPreview",
      arguments: [resourceUri],
      title: "Show",
    };
  }
}

class GroupingTreeItem extends TreeItem {
  constructor(
    label: string,
    public readonly iconPath: vscode.ThemeIcon | undefined,
    public docSection: DocSection,
  ) {
    super(label, vscode.TreeItemCollapsibleState.Collapsed);
  }
}
