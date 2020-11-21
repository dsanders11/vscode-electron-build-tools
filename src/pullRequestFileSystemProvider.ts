import * as path from "path";

import * as vscode from "vscode";

import * as Diff from "diff";
import { PullsListFilesResponseData } from "@octokit/types";

import {
  ensurePosixSeparators,
  getCheckoutDirectoryForPatchDirectory,
  getContentForFileIndex,
  parsePatchConfig,
  patchedFilenameRegex,
  querystringParse,
} from "./utils";
import { ElectronPatchesConfig } from "./types";

type PullRequestFileStatus = "added" | "deleted" | "modified";

type PullRequestFile = {
  uri: vscode.Uri;
  status: PullRequestFileStatus;
  patch: string;
};

type PullRequestPatchedFile = {
  uri: vscode.Uri;
  patch: string;
  checkoutDirectory: vscode.Uri;
  fileIndexA: string;
  fileIndexB: string;
};

type FileFromPullRequest = PullRequestFile | PullRequestPatchedFile;

function isPullRequestFile(file: FileFromPullRequest): file is PullRequestFile {
  return !!(file as any).status;
}

function getPatchAddedLines(patch: string) {
  return patch
    .split("\n")
    .filter((line) => line.startsWith("+"))
    .map((line) => line.slice(1));
}

export class ElectronPullRequestFileSystemProvider
  implements vscode.FileSystemProvider {
  private readonly _onDidChangeFile = new vscode.EventEmitter<
    vscode.FileChangeEvent[]
  >();
  onDidChangeFile = this._onDidChangeFile.event;

  private readonly patchesConfig: Promise<ElectronPatchesConfig>;
  private readonly rootDirectory: vscode.Uri;
  private readonly pullRequestFiles: Map<
    string,
    FileFromPullRequest[]
  > = new Map();

  constructor(
    private readonly electronRoot: vscode.Uri,
    patchesConfig: vscode.Uri
  ) {
    this.rootDirectory = vscode.Uri.joinPath(electronRoot, "..", "..");
    this.electronRoot = vscode.Uri.file(
      ensurePosixSeparators(electronRoot.fsPath)
    );
    this.patchesConfig = parsePatchConfig(patchesConfig);
  }

  private getPullRequestFile(uri: vscode.Uri): FileFromPullRequest {
    const { fileIndex, pullRequest } = querystringParse(uri.query);
    const prFiles = this.pullRequestFiles.get(pullRequest);

    if (prFiles === undefined) {
      throw new Error("Pull request doesn't exist");
    }

    const prFile = prFiles.find((file) => uri.path === file.uri.path);

    if (prFile === undefined) {
      throw new Error("File not found");
    }

    if (!isPullRequestFile(prFile)) {
      // If it's a patched file, confirm fileIndex just to be sure
      if (prFile.fileIndexB !== fileIndex) {
        throw new Error("File not found");
      }
    }

    return prFile;
  }

  async addPullRequestFiles(
    prNumber: string,
    files: PullsListFilesResponseData
  ) {
    const allFiles: FileFromPullRequest[] = [
      ...files.map(({ filename, status, ...other }) => ({
        ...other,
        uri: vscode.Uri.joinPath(this.electronRoot, filename),
        status: status as PullRequestFileStatus,
      })),
    ];

    // Unroll patches into the patched files
    for (const patchFile of allFiles.filter((file) =>
      file.uri.path.endsWith(".patch")
    ) as PullRequestFile[]) {
      if (patchFile.status === "modified") {
        throw new Error("Not implemented");
      }

      const patchContents = getPatchAddedLines(patchFile.patch).join("\n");
      const checkoutDirectory = getCheckoutDirectoryForPatchDirectory(
        this.rootDirectory,
        await this.patchesConfig,
        vscode.Uri.file(path.dirname(patchFile.uri.fsPath))
      );
      const regexMatches = patchContents.matchAll(patchedFilenameRegex);

      for (const [patch, filename, fileIndexA, fileIndexB] of regexMatches) {
        allFiles.push({
          uri: vscode.Uri.joinPath(checkoutDirectory, filename),
          patch,
          checkoutDirectory,
          fileIndexA,
          fileIndexB,
        });
      }
    }

    this.pullRequestFiles.set(prNumber, allFiles);
  }

  watch(): vscode.Disposable {
    throw new Error("Method not implemented.");
  }

  async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
    const fileContents = await this.readFile(uri);

    // TBD - Don't think it matters, but could always use the PR creation
    // date for the ctime/mtime rather than setting them to zero
    return {
      ctime: 0,
      mtime: 0,
      size: fileContents.length,
      type: vscode.FileType.File,
    };
  }

  readDirectory(uri: vscode.Uri): [string, vscode.FileType][] {
    throw new Error("Method not implemented.");
  }

  createDirectory(uri: vscode.Uri): void {
    throw new Error("Method not implemented.");
  }

  async readFile(uri: vscode.Uri): Promise<Uint8Array> {
    const file = this.getPullRequestFile(uri);

    if (isPullRequestFile(file)) {
      if (path.basename(uri.path) === ".patches") {
        // We don't want the full content for .patches, only what was added
        return Buffer.from(getPatchAddedLines(file.patch).join("\n"));
      } else if (file.status === "added") {
        // For an added file it just so happens that we also only want added lines
        return Buffer.from(getPatchAddedLines(file.patch).join("\n"));
      } else {
        throw new Error("Not implemented.");
      }
    } else {
      // Patched file, we need to apply the patch to generate the content
      const unpatchedContents = await getContentForFileIndex(
        file.fileIndexA,
        file.checkoutDirectory.fsPath
      );

      return Buffer.from(Diff.applyPatch(unpatchedContents, file.patch));
    }
  }

  writeFile(): void {
    throw new Error("Method not implemented.");
  }

  delete(): void {
    throw new Error("Method not implemented.");
  }

  rename(): void {
    throw new Error("Method not implemented.");
  }
}
