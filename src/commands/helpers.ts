import * as vscode from "vscode";

import MarkdownIt from "markdown-it";

enum MarkdownTableColumnAlignment {
  LEFT,
  CENTER,
  RIGHT,
}

export function registerHelperCommands(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.commands.registerCommand("vscode.copyToClipboard", (value: string) =>
      vscode.env.clipboard.writeText(value)
    ),
    vscode.commands.registerCommand(
      "vscode.window.showOpenDialog",
      async (options: vscode.OpenDialogOptions | undefined) => {
        const results = await vscode.window.showOpenDialog(options);

        if (results) {
          return results[0].fsPath;
        }
      }
    ),
    vscode.commands.registerTextEditorCommand(
      "markdown.prettifyTable",
      (textEditor: vscode.TextEditor, edit: vscode.TextEditorEdit) => {
        const selection = textEditor.selection;
        const selectedText = textEditor.document
          .getText(new vscode.Range(selection.start, selection.end))
          .trim();
        const md = new MarkdownIt();
        const tokens = md.parse(selectedText, {});

        // TODO - Would be more robust to prettify the table off the parsed tokens
        if (
          tokens[0].type === "table_open" &&
          tokens[tokens.length - 1].type === "table_close"
        ) {
          const tableRawLines = selectedText.split("\n");
          const columnAlignments: MarkdownTableColumnAlignment[] = [];
          const columnMaxLengths: number[] = [];
          const table: string[][] = [];

          for (const [lineNumber, line] of tableRawLines.entries()) {
            const columns = line.split("|").map((column) => column.trim());
            table.push(columns);

            if (lineNumber !== 1) {
              for (const [idx, column] of columns.entries()) {
                if (column.length > (columnMaxLengths[idx] || 0)) {
                  columnMaxLengths[idx] = column.length;
                }
              }
            } else {
              columnAlignments.push(
                ...columns.map((value) => {
                  if (value.startsWith(":") && value.endsWith(":")) {
                    return MarkdownTableColumnAlignment.CENTER;
                  } else if (value.startsWith(":")) {
                    return MarkdownTableColumnAlignment.LEFT;
                  } else if (value.endsWith(":")) {
                    return MarkdownTableColumnAlignment.RIGHT;
                  } else {
                    return MarkdownTableColumnAlignment.LEFT;
                  }
                })
              );
            }
          }

          let prettiedTable = "";

          for (const [lineNumber, line] of table.entries()) {
            const prettiedColumns = [];

            for (const [idx, column] of line.entries()) {
              const alignment = columnAlignments[idx];
              const targetLength = columnMaxLengths[idx];
              let prettifiedColumn = "";

              // The second line is a special case since it defines column alignment
              if (lineNumber === 1) {
                switch (alignment) {
                  case MarkdownTableColumnAlignment.LEFT:
                    if (column.startsWith(":")) {
                      prettifiedColumn = `:${"-".repeat(targetLength - 1)}`;
                    } else {
                      prettifiedColumn = "-".repeat(targetLength);
                    }
                    break;

                  case MarkdownTableColumnAlignment.CENTER:
                    prettifiedColumn = `:${"-".repeat(targetLength - 2)}:`;
                    break;

                  case MarkdownTableColumnAlignment.RIGHT:
                    prettifiedColumn = `${"-".repeat(targetLength - 1)}:`;
                    break;
                }
              } else {
                switch (alignment) {
                  case MarkdownTableColumnAlignment.LEFT:
                    prettifiedColumn = column.padEnd(targetLength, " ");
                    break;

                  case MarkdownTableColumnAlignment.CENTER:
                    const padLeft = Math.ceil(
                      (targetLength - column.length) / 2
                    );
                    const padRight = targetLength - column.length - padLeft;
                    prettifiedColumn = `${" ".repeat(
                      padLeft
                    )}${column}${" ".repeat(padRight)}`;
                    break;

                  case MarkdownTableColumnAlignment.RIGHT:
                    prettifiedColumn = column.padStart(targetLength, " ");
                    break;
                }
              }

              prettiedColumns.push(` ${prettifiedColumn} `);
            }

            prettiedTable += `${prettiedColumns.join("|").trim()}\n`;
          }

          edit.replace(selection, prettiedTable.trim());
        } else {
          vscode.window.setStatusBarMessage("No markdown table selected");
        }
      }
    )
  );
}
