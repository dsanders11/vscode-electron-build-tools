import * as path from "path";

import * as vscode from "vscode";

import { ensurePosixSeparators, parseMarkdownHeader } from "./utils";

export interface DocsLinkable {
  text: string;
  filename: string;
  urlFragment?: string;
}

function isSameLinkable(a: DocsLinkable, b: DocsLinkable) {
  return (
    a.text === b.text &&
    a.filename === b.filename &&
    a.urlFragment === b.urlFragment
  );
}

function sortLinkables(linkables: DocsLinkable[]) {
  return linkables.sort((a, b) => {
    if (a.text.toLowerCase() < b.text.toLowerCase()) {
      return -1;
    } else if (a.text.toLowerCase() > b.text.toLowerCase()) {
      return 1;
    }
    return 0;
  });
}

function linkablesAreEqual(a: DocsLinkable[], b: DocsLinkable[]) {
  if (a.length === b.length) {
    const sortedA = sortLinkables(a);
    const sortedB = sortLinkables(b);

    return sortedA.every((linkable, idx) =>
      isSameLinkable(linkable, sortedB[idx])
    );
  }

  return false;
}

export class DocsLinkablesProvider extends vscode.Disposable {
  private _onDidChangeLinkables = new vscode.EventEmitter<DocsLinkable[]>();
  readonly onDidChangeLinkables = this._onDidChangeLinkables.event;

  private _disposables: vscode.Disposable[] = [];
  private _linkables: Map<string, DocsLinkable[]>;
  public readonly docsRoot: vscode.Uri;

  constructor(private readonly _electronRoot: vscode.Uri) {
    super(() => {
      this._disposables.forEach((disposable) => disposable.dispose());
    });

    this._linkables = new Map();
    this.docsRoot = vscode.Uri.joinPath(_electronRoot, "docs");
  }

  async _extractLinkables(uri: vscode.Uri): Promise<DocsLinkable[]> {
    const linkables: DocsLinkable[] = [];

    const filename = ensurePosixSeparators(
      path.relative(this.docsRoot.fsPath, uri.fsPath)
    );
    const fileLines = (await vscode.workspace.fs.readFile(uri))
      .toString()
      .split("\n");

    for (const [idx, line] of fileLines.entries()) {
      const parsedHeader = parseMarkdownHeader(line);

      if (parsedHeader !== undefined) {
        const { text, urlFragment } = parsedHeader;

        if (idx === 0) {
          linkables.push({ text, filename });
        } else {
          // Only the top-level header can have an empty urlFragment
          if (urlFragment.length > 0) {
            linkables.push({ text, filename, urlFragment });
          }
        }
      }
    }

    return linkables;
  }

  async getLinkables(): Promise<DocsLinkable[]> {
    const _getLinkables = () => Array.from(this._linkables.values()).flat();

    // Lazily get the linkables the first time
    if (this._linkables.size === 0) {
      const docsGlobPattern = new vscode.RelativePattern(
        this._electronRoot.fsPath,
        "docs/**/*.md"
      );

      const files = await vscode.workspace.findFiles(docsGlobPattern);
      for (const file of files) {
        this._linkables.set(file.path, await this._extractLinkables(file));
      }

      const docsWatcher = vscode.workspace.createFileSystemWatcher(
        docsGlobPattern
      );
      const onDocsChanged = async (uri: vscode.Uri) => {
        const currentLinkables = this._linkables.get(uri.path);
        const linkables = await this._extractLinkables(uri);
        this._linkables.set(uri.path, linkables);

        if (
          currentLinkables === undefined ||
          !linkablesAreEqual(currentLinkables, linkables)
        ) {
          this._onDidChangeLinkables.fire(_getLinkables());
        }
      };

      this._disposables.push(
        docsWatcher,
        docsWatcher.onDidChange(onDocsChanged),
        docsWatcher.onDidCreate(onDocsChanged),
        docsWatcher.onDidDelete(onDocsChanged)
      );
    }

    return _getLinkables();
  }
}
