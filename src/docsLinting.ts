import * as path from "path";

import * as vscode from "vscode";

import { debounce } from "throttle-debounce";

import { DocsLinkable, DocsLinkablesProvider } from "./docsLinkablesProvider";
import { ensurePosixSeparators } from "./utils";

// From vscode's source
const linkPattern = /(\[((!\[[^\]]*?\]\(\s*)([^\s\(\)]+?)\s*\)\]|(?:\\\]|[^\]])*\])\(\s*)(([^\s\(\)]|\(\S*?\))*)\s*(".*?")?\)/g;
const definitionPattern = /^([\t ]*\[((?:\\\]|[^\]])+)\]:\s*)(\S+)/gm;

function getLinksInDocument(document: vscode.TextDocument) {
  const links = [];

  const inlineLinkMatches = Array.from(
    document.getText().matchAll(linkPattern)
  ).map((match) => ["inline", match]) as [string, RegExpMatchArray][];
  const referenceLinkDefinitionMatches = Array.from(
    document.getText().matchAll(definitionPattern)
  ).map((match) => ["reference-definition", match]) as [
    string,
    RegExpMatchArray
  ][];
  const matches = [...inlineLinkMatches, ...referenceLinkDefinitionMatches];

  for (const [matchType, match] of matches) {
    const linkUri = match[matchType === "inline" ? 5 : 3].trim();
    const matchIdx = match.index || 0;
    const linkRange = new vscode.Range(
      document.positionAt(matchIdx + match[1].length),
      document.positionAt(matchIdx + match[1].length + linkUri.length)
    );
    let uri = vscode.Uri.parse(linkUri);

    if (uri.scheme === "file") {
      // Use a fake scheme
      uri = vscode.Uri.parse(`electron-docs:${linkUri}`);
    }

    links.push(new vscode.DocumentLink(linkRange, uri));
  }

  return links;
}

function getRelativeLinksInDocument(document: vscode.TextDocument) {
  return getLinksInDocument(document).filter(
    (link) => link.target!.scheme === "electron-docs"
  );
}

async function isRelativeLinkBroken(
  document: vscode.TextDocument,
  link: vscode.DocumentLink
) {
  const docPath = vscode.Uri.file(
    path.join(path.dirname(document.uri.fsPath), link.target!.fsPath)
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
  document: vscode.TextDocument,
  link: vscode.DocumentLink
) {
  if (!link.target!.fragment) {
    return false;
  }

  let docPath: string;

  if (link.target!.path) {
    docPath = ensurePosixSeparators(
      path.join(path.dirname(document.uri.fsPath), link.target!.path)
    );
  } else {
    docPath = ensurePosixSeparators(document.uri.fsPath);
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
) {
  const lintDocument = async (document: vscode.TextDocument) => {
    if (document.languageId !== "markdown") {
      throw new Error("Can only lint Markdown documents");
    }

    const linkables = await linkableProvider.getLinkables();
    const links = getRelativeLinksInDocument(document);

    const diagnostics: vscode.Diagnostic[] = [];

    for (const link of links) {
      if (await isRelativeLinkBroken(document, link)) {
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
          document,
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

  // When changing the active text document, debounce these
  // checks so they don't fire with every keystroke
  const debouncedLinkCheck = debounce(500, lintDocument);

  vscode.workspace.onDidChangeTextDocument((event) => {
    if (event.document.languageId === "markdown") {
      debouncedLinkCheck(event.document);
    }
  });

  vscode.window.onDidChangeVisibleTextEditors((textEditors) => {
    for (const textEditor of textEditors) {
      if (textEditor.document.languageId === "markdown") {
        lintDocument(textEditor.document);
      }
    }
  });

  const lintVisibleEditors = () => {
    for (const textEditor of vscode.window.visibleTextEditors) {
      if (textEditor.document.languageId === "markdown") {
        lintDocument(textEditor.document);
      }
    }
  };

  lintVisibleEditors();

  // TODO - Should we just lint all documents and let it show in
  // the problems output panel?
  // TODO - If we don't re-lint documents with problems, the problem
  // remains in the output panel even after the linkable is fixed
  linkableProvider.onDidChangeLinkables(() => lintVisibleEditors());
}
