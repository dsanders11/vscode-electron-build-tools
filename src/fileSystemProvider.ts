import * as path from "node:path";

import * as vscode from "vscode";

import LRU from "lru-cache";

import {
  getContentForUri,
  gitDiffBlobs,
  gitHashObject,
  parsePatchMetadata,
} from "./utils";
import { type ElectronPatchesProvider } from "./views/patches";
import { getPatches } from "./utils.js";

export class ElectronFileSystemProvider implements vscode.FileSystemProvider {
  protected readonly _statCache = new LRU<string, number>({ max: 500 });

  protected readonly _onDidChangeFile = new vscode.EventEmitter<
    vscode.FileChangeEvent[]
  >();
  onDidChangeFile = this._onDidChangeFile.event;

  watch(): vscode.Disposable {
    throw new vscode.FileSystemError("Method not implemented.");
  }

  async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
    const key = uri.toString();

    if (!this._statCache.has(key)) {
      const fileContents = await this.readFile(uri);
      this._statCache.set(key, fileContents.length);
    }

    return {
      ctime: 0,
      mtime: 0,
      size: this._statCache.get(key)!,
      type: vscode.FileType.File,
    };
  }

  readDirectory(): [string, vscode.FileType][] {
    throw new vscode.FileSystemError("Method not implemented.");
  }

  createDirectory(): void {
    throw new vscode.FileSystemError("Method not implemented.");
  }

  async readFile(uri: vscode.Uri): Promise<Uint8Array> {
    return Buffer.from(
      await getContentForUri(uri.with({ scheme: "file" })),
      "utf8",
    );
  }

  writeFile(_uri: vscode.Uri, _content: Uint8Array): void {
    throw new vscode.FileSystemError("Method not implemented.");
  }

  delete(_uri: vscode.Uri): void {
    throw new vscode.FileSystemError("Method not implemented.");
  }

  rename(): void {
    throw new vscode.FileSystemError("Method not implemented.");
  }
}

export class ElectronPatchFileSystemProvider extends ElectronFileSystemProvider {
  constructor(private readonly patchesProvider: ElectronPatchesProvider) {
    super();
  }

  async delete(uri: vscode.Uri): Promise<void> {
    const queryParams = new URLSearchParams(uri.query);
    const patchFileUri = vscode.Uri.parse(queryParams.get("patch")!, true);

    const patchDirectory = vscode.Uri.file(path.dirname(patchFileUri.fsPath));
    const cwd =
      await this.patchesProvider.getCheckoutDirectoryForPatchDirectory(
        patchDirectory,
      );

    const patches = await getPatches(patchDirectory);

    // Find current patch and remove everything up to and including it, so only
    // remaining patches that still remain in the patch chain are present.
    const idx = patches.findIndex(
      (patch) => patch.fsPath === patchFileUri.fsPath,
    );

    if (idx === -1) {
      throw new Error(
        `Patch file ${patchFileUri.fsPath} not found in patch directory ${patchDirectory.fsPath}`,
      );
    }

    const blobIdA = queryParams.get("blobIdA")!;

    // Update the file so that its start and end blob IDs are the same,
    // which will result in an empty diff and the file removed from the patch
    await this.updateFileInPatch(
      patchFileUri,
      uri,
      cwd,
      blobIdA,
      patches.slice(idx + 1),
      blobIdA,
    );
  }

  async writeFile(uri: vscode.Uri, content: Uint8Array): Promise<void> {
    const queryParams = new URLSearchParams(uri.query);
    const patchFileUri = vscode.Uri.parse(queryParams.get("patch")!, true);

    const patchDirectory = vscode.Uri.file(path.dirname(patchFileUri.fsPath));
    const cwd =
      await this.patchesProvider.getCheckoutDirectoryForPatchDirectory(
        patchDirectory,
      );

    const newBlobId = await gitHashObject(
      cwd,
      Buffer.from(content).toString("utf8"),
    );

    const patches = await getPatches(patchDirectory);

    // Find current patch and remove everything up to and including it, so only
    // remaining patches that still remain in the patch chain are present.
    const idx = patches.findIndex(
      (patch) => patch.fsPath === patchFileUri.fsPath,
    );

    if (idx === -1) {
      throw new Error(
        `Patch file ${patchFileUri.fsPath} not found in patch directory ${patchDirectory.fsPath}`,
      );
    }

    await this.updateFileInPatch(
      patchFileUri,
      uri,
      cwd,
      newBlobId,
      patches.slice(idx + 1),
    );
  }

  private async updateFileInPatch(
    patchFileUri: vscode.Uri,
    uri: vscode.Uri,
    cwd: vscode.Uri,
    newBlobIdB: string,
    remainingPatches: vscode.Uri[],
    newBlobIdA?: string,
  ) {
    const queryParams = new URLSearchParams(uri.query);

    let ghRepo: { owner: string; repo: string } | undefined = undefined;

    if (queryParams.has("repoOwner") && queryParams.has("repo")) {
      ghRepo = {
        owner: queryParams.get("repoOwner")!,
        repo: queryParams.get("repo")!,
      };
    }

    let originalBlobIdA: string | undefined = undefined;
    let originalBlobIdB = "";
    let originalFilename = "";

    // Parse the existing patch file to get the metadata
    const patchContents = (
      await vscode.workspace.fs.readFile(patchFileUri)
    ).toString();
    const { preamble, from, date, subject, description, files } =
      parsePatchMetadata(patchContents);

    const relativeFilePath = path.relative(cwd.fsPath, uri.fsPath);

    // If the file isn't already in the patch, add it as a new file
    if (!files.some((file) => file.filename === relativeFilePath)) {
      const newFile = {
        oldFilename: relativeFilePath,
        filename: relativeFilePath,
        blobIdA: queryParams.get("blobIdA") ?? "",
        blobIdB: newBlobIdB,
      };

      // Since this file wasn't previously in this patch, we can
      // imagine it as having previously been a no-op with the chunk
      // header having been ${blobIdA}..${blobIdA} - as such the
      // `originalBlobIdB` is actually just `blobIdA`
      originalBlobIdB = newFile.blobIdA;
      originalFilename = relativeFilePath;

      // Insert at the correct position to match Git's sorting
      const insertIndex = files.findIndex(
        (file) => file.filename > relativeFilePath,
      );
      if (insertIndex === -1) {
        files.push(newFile);
      } else {
        files.splice(insertIndex, 0, newFile);
      }
    }

    // Now reconstruct the whole patch file
    let newPatchContents = `${preamble}\nFrom: ${from}\nDate: ${date}\nSubject: ${subject}\n\n${description}\n\n`;

    // This isn't the most efficient way to do this, but it requires the least refactoring
    for (const { filename, blobIdA, blobIdB } of files) {
      let fileDiff: string;

      if (vscode.Uri.joinPath(cwd, filename).fsPath === uri.fsPath) {
        // If the file is being removed from the patch, there's nothing more to do
        if ((newBlobIdA ?? blobIdA) === newBlobIdB) {
          originalBlobIdA = blobIdA;
          originalBlobIdB = blobIdB;
          originalFilename = filename;
          continue;
        }

        // Only update these if they're not already set (i.e. new file being added to patch)
        if (!originalBlobIdB && !originalFilename) {
          originalBlobIdB = blobIdB;
          originalFilename = filename;
        }

        // Get the diff between the original blob (before the original patch)
        // and the new blob content so that we have the new patch content
        fileDiff = await gitDiffBlobs(
          cwd,
          filename,
          newBlobIdA ?? blobIdA,
          newBlobIdB,
          ghRepo,
        );
        fileDiff = fileDiff.replaceAll(
          `a/${newBlobIdA ?? blobIdA}`,
          `a/${filename}`,
        );
        fileDiff = fileDiff.replaceAll(`b/${newBlobIdB}`, `b/${filename}`);
      } else {
        // TODO - It's inefficient to redo the git diff here since it should be unchanged,
        //        so look into having `parsePatchMetadata` also return the diff content
        //        for each file so we don't have to redo it here
        fileDiff = await gitDiffBlobs(cwd, filename, blobIdA, blobIdB, ghRepo);
        fileDiff = fileDiff.replaceAll(`a/${blobIdA}`, `a/${filename}`);
        fileDiff = fileDiff.replaceAll(`b/${blobIdB}`, `b/${filename}`);
      }

      newPatchContents += fileDiff;
    }

    await vscode.workspace.fs.writeFile(
      patchFileUri,
      Buffer.from(newPatchContents, "utf8"),
    );

    if (originalBlobIdB) {
      for (const [idx, patch] of remainingPatches.entries()) {
        // Parse the patch file to get the metadata
        const patchContents = await vscode.workspace.fs
          .readFile(patch)
          .then((buffer) => buffer.toString());
        const { files } = parsePatchMetadata(patchContents);

        const file = files.find(
          ({ filename }) => filename === originalFilename,
        );

        if (file) {
          if (file.blobIdA !== originalBlobIdB) {
            throw new Error(
              `Unexpected blob ID for file ${originalFilename} in patch ${patch.fsPath}. Expected ${originalBlobIdB}, got ${file.blobIdA}`,
            );
          }

          // Update query params appropriately - the patch
          // should now be applied to `newBlobIdB`
          const contentQueryParams = new URLSearchParams();
          contentQueryParams.set("blobId", originalBlobIdA ?? newBlobIdB);
          contentQueryParams.set(
            "unpatchedBlobId",
            originalBlobIdA ?? newBlobIdB,
          );
          contentQueryParams.set("patch", patch.toString());

          const content = await getContentForUri(
            uri.with({ query: contentQueryParams.toString() }),
          );
          const patchNewBlobId = await gitHashObject(
            cwd,
            Buffer.from(content).toString("utf8"),
          );

          // Change the blobIdA for the file to reflect the blob ID
          // that resulted after we updated the original patch
          const updatedQueryParams = new URLSearchParams(uri.query);
          updatedQueryParams.set("blobIdA", originalBlobIdA ?? newBlobIdB);

          await this.updateFileInPatch(
            patch,
            uri.with({ query: updatedQueryParams.toString() }),
            cwd,
            patchNewBlobId,
            remainingPatches.slice(idx + 1),
            newBlobIdB,
          );
          break;
        }
      }
    }
  }
}
