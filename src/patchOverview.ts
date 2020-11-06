import * as vscode from "vscode";

export class PatchOverviewPanel {
  public static currentPanel: PatchOverviewPanel | undefined;

  public static readonly viewType = "electron-build-tools.patchOverview";

  private readonly _panel: vscode.WebviewPanel;
  private _disposables: vscode.Disposable[] = [];

  public static createOrShow(markdownContent: vscode.MarkdownString) {
    const column = vscode.window.activeTextEditor
      ? vscode.window.activeTextEditor.viewColumn
      : undefined;

    if (PatchOverviewPanel.currentPanel) {
      // Replace the content and show it
      PatchOverviewPanel.currentPanel.setWebviewPanelContent(markdownContent);
      PatchOverviewPanel.currentPanel._panel.reveal(column);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      PatchOverviewPanel.viewType,
      "Patch Overview",
      column ?? vscode.ViewColumn.One,
      {
        enableScripts: true,
      }
    );

    PatchOverviewPanel.currentPanel = new PatchOverviewPanel(
      panel,
      markdownContent
    );
  }

  public static revive(
    panel: vscode.WebviewPanel,
    markdownContent: vscode.MarkdownString
  ) {
    PatchOverviewPanel.currentPanel = new PatchOverviewPanel(
      panel,
      markdownContent
    );
  }

  private constructor(
    panel: vscode.WebviewPanel,
    markdownContent: vscode.MarkdownString
  ) {
    this._panel = panel;
    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

    this.setWebviewPanelContent(markdownContent);
  }

  private setWebviewPanelContent(markdownContent: vscode.MarkdownString) {
    const webview = this._panel.webview;
    webview.html = `<!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; img-src ${webview.cspSource} https:; script-src https://cdn.jsdelivr.net/;">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Patch Overview</title>
        <script type="module" src="https://cdn.jsdelivr.net/gh/zerodevx/zero-md@2/dist/zero-md.min.js"></script>
      </head>
      <body>
        <zero-md>
          <script type="text/markdown">${markdownContent.value}</script>
        </zero-md>
      </body>
      </html>`;
  }

  public dispose() {
    PatchOverviewPanel.currentPanel = undefined;

    this._panel.dispose();

    for (const disposable of this._disposables) {
      disposable.dispose();
    }
  }
}
