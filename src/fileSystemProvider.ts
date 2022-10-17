import * as vscode from "vscode";

import LRU from "lru-cache";

import { getContentForUri } from "./utils";

export class ElectronFileSystemProvider implements vscode.FileSystemProvider {
  private readonly _statCache = new LRU<string, number>({ max: 500 });

  private readonly _onDidChangeFile = new vscode.EventEmitter<
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

  readDirectory(uri: vscode.Uri): [string, vscode.FileType][] {
    throw new vscode.FileSystemError("Method not implemented.");
  }

  createDirectory(uri: vscode.Uri): void {
    throw new vscode.FileSystemError("Method not implemented.");
  }

  async readFile(uri: vscode.Uri): Promise<Uint8Array> {
    return Buffer.from(
      await getContentForUri(uri.with({ scheme: "file" })),
      "utf8"
    );
  }

  writeFile(): void {
    throw new vscode.FileSystemError("Method not implemented.");
  }

  delete(): void {
    throw new vscode.FileSystemError("Method not implemented.");
  }

  rename(): void {
    throw new vscode.FileSystemError("Method not implemented.");
  }
}
