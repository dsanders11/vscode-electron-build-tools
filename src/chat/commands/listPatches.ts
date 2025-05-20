import path from "node:path";

import * as vscode from "vscode";

import { type ElectronPatchesProvider } from "../../views/patches";

async function fileExists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}

export async function listPatches(
  chromiumRoot: vscode.Uri,
  electronRoot: vscode.Uri,
  patchesProvider: ElectronPatchesProvider,
  request: vscode.ChatRequest,
  stream: vscode.ChatResponseStream,
  token: vscode.CancellationToken,
) {
  // Find the file the user is asking about
  const filename = request.prompt.trim();
  let patchedFile: vscode.Uri;

  const absoluteFileUri = vscode.Uri.file(filename);
  const chromiumRelativeFileUri = vscode.Uri.joinPath(chromiumRoot, filename);

  if (await fileExists(absoluteFileUri)) {
    patchedFile = absoluteFileUri;
  } else if (await fileExists(chromiumRelativeFileUri)) {
    patchedFile = chromiumRelativeFileUri;
  } else {
    stream.markdown("File not found");
    return;
  }

  const patches = await vscode.workspace.findFiles(
    new vscode.RelativePattern(
      vscode.Uri.joinPath(electronRoot, "patches"),
      "**/*.patch",
    ),
    null,
    undefined,
    token,
  );

  const matchingPatches = new Map<string, string[]>();

  for (const patch of patches) {
    const patchDirectory = vscode.Uri.file(path.dirname(patch.fsPath));
    const checkoutDirectory =
      await patchesProvider.getCheckoutDirectoryForPatchDirectory(
        patchDirectory,
      );
    const relativeFilename = path.relative(
      checkoutDirectory.fsPath,
      patchedFile.fsPath,
    );

    if (relativeFilename.startsWith("..")) {
      continue;
    }

    const contents = (await vscode.workspace.fs.readFile(patch)).toString();
    if (
      contents.includes(
        `diff --git a/${relativeFilename} b/${relativeFilename}`,
      )
    ) {
      const patchDirectoryName = path.basename(patchDirectory.fsPath);
      if (!matchingPatches.has(patchDirectoryName)) {
        matchingPatches.set(patchDirectoryName, []);
      }
      matchingPatches
        .get(patchDirectoryName)!
        .push(path.basename(patch.fsPath));
    }
  }

  if (matchingPatches.size === 0) {
    stream.markdown("No patches found");
    return;
  }

  stream.markdown("Found the following patches for ");
  stream.anchor(patchedFile);
  stream.markdown(":\n");

  // Output the final file tree
  stream.filetree(
    [
      {
        name: "patches",
        children: Array.from(matchingPatches.entries()).map(
          ([patchDirectory, patches]) => {
            return {
              name: patchDirectory,
              children: patches.map((patch) => ({ name: patch })),
            };
          },
        ),
      },
    ],
    electronRoot,
  );
}
