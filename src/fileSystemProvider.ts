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

    // Update the file so that its start and end blob IDs are the same,
    // which will result in an empty diff and the file removed from the patch
    await this.updateFileInPatch(
      patchFileUri,
      uri,
      cwd,
      queryParams.get("blobIdA")!,
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

    await this.updateFileInPatch(patchFileUri, uri, cwd, newBlobId);
  }

  private async updateFileInPatch(
    patchFileUri: vscode.Uri,
    uri: vscode.Uri,
    cwd: vscode.Uri,
    newBlobId: string,
  ) {
    // Parse the existing patch file to get the metadata
    const patchContents = (
      await vscode.workspace.fs.readFile(patchFileUri)
    ).toString();
    const { preamble, from, date, subject, description, files } =
      parsePatchMetadata(patchContents);

    // Now reconstruct the whole patch file
    let newPatchContents = `${preamble}\nFrom: ${from}\nDate: ${date}\nSubject: ${subject}\n\n${description}\n\n`;

    // This isn't the most efficient way to do this, but it requires the least refactoring
    for (const { filename, blobIdA, blobIdB } of files) {
      let fileDiff: string;

      if (vscode.Uri.joinPath(cwd, filename).fsPath === uri.fsPath) {
        // Get the diff between the original blob (before the original patch)
        // and the new blob content so that we have the new patch content
        fileDiff = await gitDiffBlobs(cwd, blobIdA, newBlobId);
        fileDiff = fileDiff.replaceAll(`a/${blobIdA}`, `a/${filename}`);
        fileDiff = fileDiff.replaceAll(`b/${newBlobId}`, `b/${filename}`);
      } else {
        fileDiff = await gitDiffBlobs(cwd, blobIdA, blobIdB);
        fileDiff = fileDiff.replaceAll(`a/${blobIdA}`, `a/${filename}`);
        fileDiff = fileDiff.replaceAll(`b/${blobIdB}`, `b/${filename}`);
      }

      newPatchContents += fileDiff;
    }

    await vscode.workspace.fs.writeFile(
      patchFileUri,
      Buffer.from(newPatchContents, "utf8"),
    );
  }
}
