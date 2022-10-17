import * as childProcess from "child_process";
import * as path from "path";
import { promisify } from "util";

import * as vscode from "vscode";

import {
  buildToolsExecutable,
  commandPrefix,
  viewIds,
  virtualDocumentScheme,
  virtualFsScheme,
} from "../constants";
import {
  default as ExtensionState,
  ExtensionOperation,
} from "../extensionState";
import Logger from "../logging";
import {
  getOctokit,
  hasContentForBlobId,
  querystringParse,
  setContentForBlobId,
  startProgress,
} from "../utils";
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
  patchesView: vscode.TreeView<vscode.TreeItem>
) {
  context.subscriptions.push(
    vscode.commands.registerCommand(
      `${commandPrefix}.openPatch`,
      (patchTreeItem: Patch) => {
        let uri = patchTreeItem.resourceUri;

        // This is just about aesthetics - when loaded from FS
        // it will have a lock icon in the editor title bar
        if (uri.scheme === virtualFsScheme) {
          const queryParams = new URLSearchParams(uri.query);
          queryParams.set("view", "contents");
          uri = uri.with({
            scheme: virtualDocumentScheme,
            query: queryParams.toString(),
          });
        }

        return vscode.commands.executeCommand("vscode.open", uri);
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
      (file: vscode.Uri, patchedFilename: string) => {
        const { blobIdA, blobIdB, patch } = querystringParse(file.query);

        if (!blobIdA || !blobIdB || !patch) {
          throw new Error("Required query params missing");
        }

        const patchedQueryParams = new URLSearchParams(file.query);
        patchedQueryParams.delete("blobIdA");
        patchedQueryParams.delete("blobIdB");
        patchedQueryParams.set("blobId", blobIdB);
        patchedQueryParams.set("unpatchedBlobId", blobIdA);
        patchedQueryParams.set("view", "contents");

        const patchedFile = file.with({
          scheme: virtualDocumentScheme,
          query: patchedQueryParams.toString(),
        });

        if (/^[0]+$/.test(blobIdA)) {
          // Show added files as readonly, there's not much point
          // in doing a side-by-side diff where one side is blank
          return vscode.commands.executeCommand(
            "vscode.open",
            patchedFile,
            undefined,
            `${path.basename(patch)} - ${patchedFilename}` // TODO - This isn't used?
          );
        } else {
          const queryParams = new URLSearchParams(file.query);
          queryParams.delete("blobIdA");
          queryParams.delete("blobIdB");
          queryParams.set("blobId", blobIdA);
          queryParams.set("view", "contents");

          const originalFile = file.with({
            scheme: virtualDocumentScheme,
            query: queryParams.toString(),
          });

          return vscode.commands.executeCommand(
            "vscode.diff",
            originalFile,
            patchedFile,
            `${path.basename(patch)} - ${patchedFilename}`
          );
        }
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
        const queryParams = new URLSearchParams(patch.query);
        queryParams.set("view", "patch-overview");

        return vscode.commands.executeCommand(
          "markdown.showPreview",
          patch.with({
            scheme: virtualDocumentScheme,
            query: queryParams.toString(),
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
          return vscode.window.withProgress(
            { location: { viewId: viewIds.PATCHES } },
            async () => {
              const octokit = await getOctokit();
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
                const repo = pullRequest.base.repo;
                const [repoOwner, repoName] = repo.full_name.split("/");
                const pulRequestFiles = prFilesResponse.data;
                const patchRegex = /^patches\/(\S*)\/.+\.patch$/;
                const patches = new Map<string, Set<vscode.Uri>>();

                for (const file of pulRequestFiles) {
                  const matches = patchRegex.exec(file.filename);

                  if (matches) {
                    const patchDirectory = `src/electron/patches/${matches[1]}`;
                    const patchesInDirectory =
                      patches.get(patchDirectory) ?? new Set<vscode.Uri>();

                    const queryParams = new URLSearchParams({
                      isPatch: "1",
                      status: file.status,
                      blobId: file.sha,
                      repoOwner,
                      repo: repoName,
                    });

                    // Populate the blob cache here so it's fast when the user expands tree items
                    if (!hasContentForBlobId(file.sha)) {
                      const response = await octokit.rest.git.getBlob({
                        owner: repoOwner,
                        repo: repoName,
                        // eslint-disable-next-line @typescript-eslint/naming-convention
                        file_sha: file.sha,
                      });

                      setContentForBlobId(
                        file.sha,
                        Buffer.from(response.data.content, "base64").toString()
                      );
                    }

                    patchesInDirectory.add(
                      vscode.Uri.joinPath(electronRoot, file.filename).with({
                        scheme: virtualFsScheme,
                        query: queryParams.toString(),
                      })
                    );

                    patches.set(patchDirectory, patchesInDirectory);
                  }
                }

                if (patches.size > 0) {
                  const patchTreeItem = patchesProvider.showPr({
                    prNumber,
                    title: pullRequest.title,
                    repo: { owner: repoOwner, repo: repoName },
                    patches,
                  });

                  patchesView.reveal(patchTreeItem, {
                    select: false,
                    expand: true,
                  });
                } else {
                  vscode.window.showWarningMessage(
                    "No patches in pull request"
                  );
                }
              } else {
                vscode.window.showErrorMessage("Couldn't find pull request");
              }
            }
          );
        }
      }
    )
  );
}
