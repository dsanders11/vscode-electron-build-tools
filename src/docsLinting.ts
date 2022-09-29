import * as path from "path";

import * as vscode from "vscode";

import { debounce } from "throttle-debounce";

import { Markdown } from "./common";
import type {
  DocsLinkable,
  DocsLinkablesProvider,
} from "./docsLinkablesProvider";
import { ensurePosixSeparators, positionAt } from "./utils";

function getLinksInDocument(document: vscode.TextDocument) {
  const text = document.getText();
  const links = [];

  const inlineLinkMatches = Array.from(text.matchAll(Markdown.linkPattern)).map(
    (match) => ["inline", match]
  ) as [string, RegExpMatchArray][];
  const referenceLinkDefinitionMatches = Array.from(
    text.matchAll(Markdown.definitionPattern)
  ).map((match) => ["reference-definition", match]) as [
    string,
    RegExpMatchArray
  ][];
  const matches = [...inlineLinkMatches, ...referenceLinkDefinitionMatches];

  for (const [matchType, match] of matches) {
    const linkUri = match[matchType === "inline" ? 5 : 3].trim();

    if (linkUri) {
      const matchIdx = match.index || 0;
      const linkRange = new vscode.Range(
        positionAt(text, matchIdx + match[1].length),
        positionAt(text, matchIdx + match[1].length + linkUri.length)
      );
      let uri = vscode.Uri.parse(linkUri);

      if (uri.scheme === "file") {
        // Use a fake scheme
        uri = vscode.Uri.parse(`electron-docs:${linkUri}`);
      }

      links.push(new vscode.DocumentLink(linkRange, uri));
    }
  }

  return links;
}

function getRelativeLinksInDocument(document: vscode.TextDocument) {
  return getLinksInDocument(document).filter(
    (link) =>
      link.target!.scheme === "electron-docs" &&
      !link.target!.path.startsWith("/")
  );
}

async function isRelativeLinkBroken(
  uri: vscode.Uri,
  link: vscode.DocumentLink
) {
  const docPath = vscode.Uri.file(
    path.join(path.dirname(uri.fsPath), link.target!.fsPath)
  );

  try {
    await vscode.workspace.fs.stat(docPath);
    return false; // File exists, link not broken
  } catch {
    return true;
  }
}

function isRelativeLinkUrlFragmentBroken(
  docsPath: vscode.Uri,
  docsLinkables: DocsLinkable[],
  uri: vscode.Uri,
  link: vscode.DocumentLink
) {
  if (!link.target!.fragment) {
    return false;
  }

  let docPath: string;

  if (link.target!.path) {
    docPath = ensurePosixSeparators(
      path.join(path.dirname(uri.fsPath), link.target!.path)
    );
  } else {
    docPath = ensurePosixSeparators(uri.fsPath);
  }

  const targetFilename = ensurePosixSeparators(
    path.relative(docsPath.fsPath, docPath)
  );

  for (const linkable of docsLinkables) {
    if (linkable.filename === targetFilename) {
      if (
        linkable.urlFragment &&
        linkable.urlFragment === link.target!.fragment
      ) {
        return false;
      }
    }
  }

  return true;
}

export function setupDocsLinting(
  linkableProvider: DocsLinkablesProvider,
  diagnosticsCollection: vscode.DiagnosticCollection
): vscode.Disposable {
  const lintDocument = async (document: vscode.TextDocument) => {
    if (document.languageId !== "markdown") {
      throw new Error("Can only lint Markdown documents");
    }

    const linkables = await linkableProvider.getLinkables();
    const links = getRelativeLinksInDocument(document);

    const diagnostics: vscode.Diagnostic[] = [];

    for (const link of links) {
      if (await isRelativeLinkBroken(document.uri, link)) {
        const diagnostic = new vscode.Diagnostic(
          link.range,
          "Relative link is broken",
          vscode.DiagnosticSeverity.Error
        );
        diagnostic.code = "broken-relative-link";
        diagnostic.source = "electron-build";
        diagnostics.push(diagnostic);
      } else if (
        isRelativeLinkUrlFragmentBroken(
          linkableProvider.docsRoot,
          linkables,
          document.uri,
          link
        )
      ) {
        const diagnostic = new vscode.Diagnostic(
          link.range,
          "Url fragment is broken",
          vscode.DiagnosticSeverity.Error
        );
        diagnostic.code = "broken-url-fragment";
        diagnostic.source = "electron-build";
        diagnostics.push(diagnostic);
      }
    }

    diagnosticsCollection.set(document.uri, diagnostics);
  };

  const shouldLintDocument = (document: vscode.TextDocument) => {
    if (document.languageId === "markdown") {
      return document.uri.path.startsWith(linkableProvider.docsRoot.path);
    }

    return false;
  };

  const lintVisibleEditors = () => {
    for (const textEditor of vscode.window.visibleTextEditors) {
      if (shouldLintDocument(textEditor.document)) {
        lintDocument(textEditor.document);
      }
    }
  };

  // When changing the active text document, debounce these
  // checks so they don't fire with every keystroke
  const debouncedLinkCheck = debounce(500, lintDocument);

  // Do an initial linting of any visible editors
  lintVisibleEditors();

  return vscode.Disposable.from(
    vscode.workspace.onDidChangeTextDocument((event) => {
      if (shouldLintDocument(event.document)) {
        debouncedLinkCheck(event.document);
      }
    }),
    vscode.window.onDidChangeVisibleTextEditors((textEditors) => {
      for (const textEditor of textEditors) {
        if (shouldLintDocument(textEditor.document)) {
          lintDocument(textEditor.document);
        }
      }
    }),
    // TODO - Should we just lint all documents and let it show in
    // the problems output panel?
    // TODO - If we don't re-lint documents with problems, the problem
    // remains in the output panel even after the linkable is fixed
    linkableProvider.onDidChangeLinkables(() => lintVisibleEditors())
  );
}
