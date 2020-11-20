import * as childProcess from "child_process";
import * as path from "path";
import * as querystring from "querystring";

import * as vscode from "vscode";

import { Octokit } from "@octokit/rest";

import { buildToolsExecutable, virtualDocumentScheme } from "../constants";
import {
  default as ExtensionState,
  ExtensionOperation,
} from "../extensionState";
import { ElectronPullRequestFileSystemProvider } from "../pullRequestFileSystemProvider";
import { FileInPatch } from "../utils";
import {
  ElectronPatchesProvider,
  Patch,
  PatchDirectory,
  PullRequestTreeItem,
} from "../views/patches";

export function registerPatchesCommands(
  context: vscode.ExtensionContext,
  electronRoot: vscode.Uri,
  patchesProvider: ElectronPatchesProvider,
  patchesView: vscode.TreeView<vscode.TreeItem>,
  pullRequestFileSystemProvider: ElectronPullRequestFileSystemProvider
) {
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "electron-build-tools.openPatch",
      (patchTreeItem: Patch) => {
        return vscode.commands.executeCommand("vscode.open", patchTreeItem.uri);
      }
    ),
    ExtensionState.registerExtensionOperationCommand(
      ExtensionOperation.REFRESH_PATCHES,
      "electron-build-tools.refreshPatches",
      () => {
        vscode.window.showErrorMessage(
          "Can't refresh patches, other work in-progress"
        );
      },
      (arg: PatchDirectory | string) => {
        const target = arg instanceof PatchDirectory ? arg.name : arg;

        return new Promise((resolve, reject) => {
          const cp = childProcess.exec(
            `${buildToolsExecutable} patches ${target || "all"}`
          );

          cp.once("error", (err) => reject(err));
          cp.once("exit", (code) => {
            if (code !== 0) {
              vscode.window.showErrorMessage("Failed to refresh patches");
            } else {
              // TBD - This isn't very noticeable
              vscode.window.setStatusBarMessage("Refreshed patches");
              patchesProvider.refresh();
              resolve();
            }
          });
        });
      }
    ),
    vscode.commands.registerCommand(
      "electron-build-tools.removePullRequestPatch",
      async (treeItem: PullRequestTreeItem) => {
        patchesProvider.removePr(treeItem.pullRequest);
      }
    ),
    vscode.commands.registerCommand(
      "electron-build-tools.showPatchedFileDiff",
      async (
        checkoutDirectory: vscode.Uri,
        patch: vscode.Uri,
        metadata: FileInPatch,
        patchedFilename: string
      ) => {
        const originalFile = metadata.file.with({
          scheme: virtualDocumentScheme,
          query: querystring.stringify({
            ...querystring.parse(metadata.file.query),
            view: "contents",
            fileIndex: metadata.fileIndexA,
            checkoutPath: checkoutDirectory.fsPath,
          }),
        });
        const patchedFile = metadata.file.with({
          scheme: virtualDocumentScheme,
          query: querystring.stringify({
            ...querystring.parse(metadata.file.query),
            view: "contents",
            fileIndex: metadata.fileIndexB,
            checkoutPath: checkoutDirectory.fsPath,
          }),
        });

        vscode.commands.executeCommand(
          "vscode.diff",
          originalFile,
          patchedFile,
          `${path.basename(patch.path)} - ${patchedFilename}`
        );
      }
    ),
    vscode.commands.registerCommand(
      "electron-build-tools.showPatchesDocs",
      () => {
        vscode.commands.executeCommand(
          "markdown.showPreview",
          vscode.Uri.joinPath(electronRoot, "docs", "development", "patches.md")
        );
      }
    ),
    vscode.commands.registerCommand(
      "electron-build-tools.showPatchOverview",
      (patch: vscode.Uri) => {
        return vscode.commands.executeCommand(
          "markdown.showPreview",
          patch.with({
            scheme: virtualDocumentScheme,
            query: querystring.stringify({
              ...querystring.parse(patch.query),
              view: "patch-overview",
            }),
          })
        );
      }
    ),
    vscode.commands.registerCommand(
      "electron-build-tools.viewPullRequestPatch",
      async () => {
        const prNumber = await vscode.window.showInputBox({
          prompt: "Enter the pull request number",
          validateInput: (value: string) => {
            if (isNaN(parseInt(value))) {
              return "Enter a number only";
            }
          },
        });

        if (prNumber) {
          const octokit = new Octokit();
          const prDetails = {
            owner: "electron",
            repo: "electron",
            // eslint-disable-next-line @typescript-eslint/naming-convention
            pull_number: parseInt(prNumber),
          };
          const prResponse = await octokit.pulls.get(prDetails);
          const prFilesResponse = await octokit.pulls.listFiles(prDetails);

          if (prResponse.status === 200 && prFilesResponse.status === 200) {
            const pullRequest = prResponse.data;
            const pulRequestFiles = prFilesResponse.data;
            const patchDirectoryRegex = /^patches\/(\S*)\/.patches$/;
            const patchDirectories = [];

            for (const file of prFilesResponse.data) {
              const matches = patchDirectoryRegex.exec(file.filename);

              if (matches) {
                patchDirectories.push(`src/electron/patches/${matches[1]}`);
              }
            }

            if (patchDirectories.length > 0) {
              await pullRequestFileSystemProvider.addPullRequestFiles(
                prNumber,
                pulRequestFiles
              );

              const patchTreeItem = patchesProvider.showPr({
                prNumber,
                title: pullRequest.title,
                patchDirectories,
              });

              patchesView.reveal(patchTreeItem, {
                select: false,
                expand: true,
              });
            } else {
              vscode.window.showWarningMessage("No patches in pull request");
            }
          } else {
            vscode.window.showErrorMessage("Couldn't find pull request");
          }
        }
      }
    )
  );
}
