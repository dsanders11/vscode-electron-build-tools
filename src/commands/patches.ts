import * as childProcess from "child_process";
import * as path from "path";
import * as querystring from "querystring";
import { promisify } from "util";

import * as vscode from "vscode";

import { Octokit } from "@octokit/rest";

import {
  buildToolsExecutable,
  commandPrefix,
  viewIds,
  virtualDocumentScheme,
} from "../constants";
import {
  default as ExtensionState,
  ExtensionOperation,
} from "../extensionState";
import Logger from "../logging";
import type { ElectronPullRequestFileSystemProvider } from "../pullRequestFileSystemProvider";
import { FileInPatch, startProgress } from "../utils";
import type {
  ElectronPatchesProvider,
  Patch,
  PatchDirectory,
  PullRequestTreeItem,
} from "../views/patches";

const exec = promisify(childProcess.exec);

export function registerPatchesCommands(
  context: vscode.ExtensionContext,
  electronRoot: vscode.Uri,
  patchesProvider: ElectronPatchesProvider,
  patchesView: vscode.TreeView<vscode.TreeItem>,
  pullRequestFileSystemProvider: ElectronPullRequestFileSystemProvider
) {
  context.subscriptions.push(
    vscode.commands.registerCommand(
      `${commandPrefix}.openPatch`,
      (patchTreeItem: Patch) => {
        return vscode.commands.executeCommand(
          "vscode.open",
          patchTreeItem.resourceUri
        );
      }
    ),
    ExtensionState.registerExtensionOperationCommand(
      ExtensionOperation.REFRESH_PATCHES,
      `${commandPrefix}.refreshPatches`,
      () => {
        vscode.window.showErrorMessage(
          "Can't refresh patches, other work in-progress"
        );
      },
      async (arg: PatchDirectory | string | undefined) => {
        const target = typeof arg === "string" ? arg : arg?.name ?? "all";

        const endProgress = startProgress({
          location: { viewId: viewIds.PATCHES },
        });

        try {
          await exec(`${buildToolsExecutable} patches ${target}`);

          // TBD - This isn't very noticeable
          vscode.window.setStatusBarMessage("Refreshed patches");
          patchesProvider.refresh();
        } catch (err) {
          Logger.error(err instanceof Error ? err : String(err));
          vscode.window.showErrorMessage("Failed to refresh patches");
        } finally {
          endProgress();
        }
      }
    ),
    vscode.commands.registerCommand(
      `${commandPrefix}.removePullRequestPatch`,
      (treeItem: PullRequestTreeItem) => {
        patchesProvider.removePr(treeItem.pullRequest);
      }
    ),
    vscode.commands.registerCommand(
      `${commandPrefix}.showPatchedFileDiff`,
      (
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

        return vscode.commands.executeCommand(
          "vscode.diff",
          originalFile,
          patchedFile,
          `${path.basename(patch.path)} - ${patchedFilename}`
        );
      }
    ),
    vscode.commands.registerCommand(`${commandPrefix}.showPatchesDocs`, () => {
      return vscode.commands.executeCommand(
        "markdown.showPreview",
        vscode.Uri.joinPath(electronRoot, "docs", "development", "patches.md")
      );
    }),
    vscode.commands.registerCommand(
      `${commandPrefix}.showPatchOverview`,
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
      `${commandPrefix}.viewPullRequestPatch`,
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
            const patchDirectories: string[] = [];

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
