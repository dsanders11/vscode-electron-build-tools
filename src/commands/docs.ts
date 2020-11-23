import * as vscode from "vscode";

import { commandPrefix } from "../constants";
import type { DocsLinkablesProvider } from "../docsLinkablesProvider";

interface DocsQuickPickItem extends vscode.QuickPickItem {
  filename: string;
  urlFragment?: string;
}

const toTheSideButton: vscode.QuickInputButton = {
  iconPath: new vscode.ThemeIcon("split-horizontal"),
  tooltip: "Change: Open Docs in Active Column",
};

const activeColumnButton: vscode.QuickInputButton = {
  iconPath: new vscode.ThemeIcon("symbol-file"),
  tooltip: "Change: Open Docs to the Side",
};

export function registerDocsCommands(
  context: vscode.ExtensionContext,
  linkableProvider: DocsLinkablesProvider
) {
  context.subscriptions.push(
    vscode.commands.registerCommand(`${commandPrefix}.searchDocs`, async () => {
      let docsSearchOpenToSide: boolean =
        context.globalState.get<boolean>("docsSearchOpenToSide") || false;

      // TODO - Can QuickPick support showing only N results at a time?
      const quickPick = vscode.window.createQuickPick<DocsQuickPickItem>();
      quickPick.title = "Search Electron Documentation";
      quickPick.items = (await linkableProvider.getLinkables()).map(
        (linkable) => {
          return {
            label: linkable.text,
            detail: linkable.filename,
            filename: linkable.filename,
            urlFragment: linkable.urlFragment,
          };
        }
      );
      quickPick.onDidAccept(() => {
        const selectedItem = quickPick.selectedItems[0];
        quickPick.dispose();

        vscode.commands.executeCommand(
          quickPick.buttons[0] === activeColumnButton
            ? "markdown.showPreview"
            : "markdown.showLockedPreviewToSide",
          vscode.Uri.joinPath(
            linkableProvider.docsRoot,
            selectedItem.filename
          ).with({ fragment: selectedItem.urlFragment })
        );
      });
      quickPick.onDidHide(() => quickPick.dispose());
      quickPick.buttons = [
        docsSearchOpenToSide ? toTheSideButton : activeColumnButton,
      ];
      quickPick.onDidTriggerButton(async (button) => {
        docsSearchOpenToSide = button === activeColumnButton;
        await context.globalState.update(
          "docsSearchOpenToSide",
          docsSearchOpenToSide
        );

        quickPick.buttons = [
          docsSearchOpenToSide ? toTheSideButton : activeColumnButton,
        ];
      });
      quickPick.show();
    }),
    vscode.commands.registerCommand(`${commandPrefix}.searchDocs-icon`, () =>
      vscode.commands.executeCommand(`${commandPrefix}.searchDocs`)
    )
  );
}
