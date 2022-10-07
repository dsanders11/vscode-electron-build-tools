import * as vscode from "vscode";

import MarkdownIt from "markdown-it";
import wrap from "word-wrap";

import Logger from "../logging";

enum MarkdownTableColumnAlignment {
  LEFT,
  CENTER,
  RIGHT,
}

const indentedLineRegex = { regex: /^([ \t]*)(?=\S)/, linePrefix: "" };
const orderedListRegex = {
  regex: /^([ \t]*)\d+\.[ \t]*(?=\S)/,
  linePrefix: "",
};
const unorderedListRegex = {
  regex: /^([ \t]*)\*[ \t]*(?=[^\s\*])/,
  linePrefix: "",
};
const quoteRegex = { regex: /^()\>[ \t]*(?=\S)/, linePrefix: ">" };
// NOTE - Regexes are ordered such that the least specific, any indentation
const wrapLineRegexes = [
  orderedListRegex,
  unorderedListRegex,
  quoteRegex,
  indentedLineRegex,
];
const targetLineLength = 80;

function getLinesForSelection(
  document: vscode.TextDocument,
  selection: vscode.Selection,
  allowEmptySelections = true
) {
  const lines: vscode.TextLine[] = [];

  if (!selection.isEmpty) {
    const { start, end } = selection;
    const endLineEnd = document.lineAt(end).range.end;
    const beginsAtStartOfLine = start.character === 0;
    const endsAtEndOfLine = end.character === endLineEnd.character;

    if (beginsAtStartOfLine && endsAtEndOfLine) {
      for (let lineNum = start.line; lineNum <= end.line; lineNum++) {
        lines.push(document.lineAt(lineNum));
      }
    } else {
      return null;
    }
  } else if (allowEmptySelections) {
    lines.push(document.lineAt(selection.active));
  } else {
    return null;
  }

  return lines;
}

function wrapLine(text: string) {
  let initialIndent = "";
  let indent = "";
  text = text.trimRight();

  for (const { regex, linePrefix } of wrapLineRegexes) {
    if (regex.test(text)) {
      const match = text.match(regex)!;
      initialIndent = match[1];
      indent = linePrefix + " ".repeat(match[0].length - linePrefix.length);
      text = text.slice(linePrefix.length).trimLeft();
      break;
    }
  }

  return (
    initialIndent +
    wrap(text, {
      indent,
      trim: true,
      width: 79 - indent.length,
    }).trim()
  );
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
            const prettiedColumns: string[] = [];

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
    ),
    vscode.commands.registerTextEditorCommand(
      "markdown.rewrapSelections",
      (
        { document, selections }: vscode.TextEditor,
        edit: vscode.TextEditorEdit
      ) => {
        for (const selection of selections) {
          const originalText = document.getText(selection);
          const lines = getLinesForSelection(document, selection, false);

          if (lines === null) {
            Logger.warn("User tried to rewrap empty or partial line selection");
            vscode.window.setStatusBarMessage(
              "Can't rewrap empty or partial line selection"
            );
            continue;
          }

          const unwrappedText = lines.map((line) => line.text).join(" ");
          const rewrappedText = wrapLine(unwrappedText);

          if (rewrappedText !== originalText) {
            edit.replace(selection, rewrappedText);
          }
        }
      }
    ),
    vscode.commands.registerTextEditorCommand(
      "markdown.wrapLines",
      (
        { document, selections }: vscode.TextEditor,
        edit: vscode.TextEditorEdit
      ) => {
        for (const selection of selections) {
          const lines = getLinesForSelection(document, selection);

          if (lines === null) {
            Logger.warn("User tried to wrap line with partial line selection");
            vscode.window.setStatusBarMessage(
              "Can't wrap line with partial line selection"
            );
            continue;
          }

          for (const line of lines) {
            // Skip lines which don't need wrapping
            if (
              line.isEmptyOrWhitespace ||
              line.range.end.character < targetLineLength
            ) {
              continue;
            }

            const wrappedText = wrapLine(line.text);

            if (wrappedText !== line.text) {
              edit.replace(line.range, wrappedText);
            }
          }
        }
      }
    )
  );
}
