import * as vscode from "vscode";

import { buildToolsExecutable, commandPrefix } from "../constants";
import {
  default as ExtensionState,
  ExtensionOperation,
} from "../extensionState";
import { runAsTask } from "../tasks";
import { embeddedReferenceRun } from "./syncReferenceRun";

type IncrementalProgress = vscode.Progress<{
  message?: string | undefined;
  increment?: number | undefined;
}>;

interface ReferenceSyncMilestone {
  line: string;
  progress: number;
}

interface SyncMilestone {
  line: string;
  message: string;
  timestamp: number;
}

type SyncRun = SyncMilestone[];
type ReferenceSyncRun = ReferenceSyncMilestone[];

class SyncProgressWatcher {
  // These are ordered so that the most common milestone is tested first
  private static readonly _milestoneRegexes = [
    {
      regex: /^(\S+)\s+\(Elapsed: ([:\d]+)\)$/,
      message: "Dependencies",
    },
    {
      regex: /(running.*apply_all_patches\.py\s.*)\sin/,
      message: "Applying Patches",
    },
    {
      regex: /(^Applying:\s.*$)/,
      message: "Applying Patches",
    },
    {
      regex: /(Hook.*apply_all_patches\.py.*\stook)/,
      message: "Patches Applied",
    },
    {
      regex: /(Hook\s\'.*\')\stook/,
      message: "Running Hooks",
    },
  ];

  private readonly _referenceRun: ReferenceSyncRun;
  private _startTime = 0;
  private _currentProgress: number;
  private _currentRun: SyncRun;

  constructor(private readonly _extensionContext: vscode.ExtensionContext) {
    this._currentProgress = 0;
    this._currentRun = [];

    // Load stored reference run, otherwise fall back to the embedded one
    const storedReferenceRun =
      this._extensionContext.globalState.get<ReferenceSyncRun>(
        "referenceSyncRun",
      );
    this._referenceRun = [...(storedReferenceRun || embeddedReferenceRun)];
  }

  startRun() {
    this._startTime = Date.now();
  }

  async finishRun() {
    const elapsedTime = Date.now() - this._startTime;

    // Re-calculate reference run and store it
    const referenceRun: ReferenceSyncRun = this._currentRun.map(
      (milestone) => ({
        line: milestone.line,
        progress: Math.floor((100 * milestone.timestamp) / elapsedTime),
      }),
    );

    await this._extensionContext.globalState.update(
      "referenceSyncRun",
      referenceRun,
    );
  }

  updateProgress(progress: IncrementalProgress, line: string) {
    let milestone: SyncMilestone | undefined;

    for (const { regex, message } of SyncProgressWatcher._milestoneRegexes) {
      const lineMatch = line.match(regex);

      if (lineMatch) {
        // Timestamp the milestone within the current run
        milestone = {
          line: lineMatch[1],
          message,
          timestamp: Date.now() - this._startTime,
        };
        this._currentRun.push(milestone);
        break;
      }
    }

    if (milestone) {
      const idx = this._referenceRun.findIndex(
        (referenceMilestone) => referenceMilestone.line === milestone!.line,
      );

      if (idx !== -1) {
        const referenceMilestone = this._referenceRun[idx];

        // Continually drop milestones we've passed to minimize searching
        this._referenceRun.splice(0, idx + 1);

        // Report and update our progress
        progress.report({
          message: milestone.message,
          increment: referenceMilestone.progress - this._currentProgress,
        });
        this._currentProgress = referenceMilestone.progress;
      } else {
        // No reference milestone, might be out of date, just output the message
        progress.report({ message: milestone.message });
      }
    }
  }
}

export function registerSyncCommands(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    ExtensionState.registerExtensionOperationCommand(
      ExtensionOperation.SYNC,
      `${commandPrefix}.sync`,
      () => {
        vscode.window.showErrorMessage("Can't sync, other work in-progress");
      },
      async (force?: boolean, advanced?: boolean) => {
        const options: vscode.QuickPickItem[] = [];
        let args = "";

        if (advanced) {
          const quickPick = vscode.window.createQuickPick();
          quickPick.step = 1;
          quickPick.totalSteps = 2;
          quickPick.canSelectMany = true;
          quickPick.title = "Sync Electron Checkout";
          quickPick.placeholder = "Advanced Options";
          quickPick.items = [
            {
              label: "Force Sync",
              description: "Force update even for unchanged modules",
            },
            {
              label: "Three-way Merge",
              description:
                "Apply Electron patches using a three-way merge, useful when upgrading Chromium",
            },
          ];

          let userQuit = await new Promise((resolve) => {
            quickPick.onDidAccept(() => {
              resolve(false);
              options.push(...quickPick.selectedItems);
              quickPick.dispose();
            });
            quickPick.onDidHide(() => {
              resolve(true);
              quickPick.dispose();
            });
            quickPick.show();
          });

          if (userQuit) {
            return;
          }

          if (options.find(({ label }) => label === "Force Sync")) {
            force = true;
          }

          if (options.find(({ label }) => label === "Three-way Merge")) {
            args += " --three-way";
          }

          const syncOptionsInput = vscode.window.createInputBox();
          syncOptionsInput.title = "Sync Electron";
          syncOptionsInput.prompt = "Extra options";
          syncOptionsInput.step = 2;
          syncOptionsInput.totalSteps = 3;

          userQuit = await new Promise((resolve) => {
            syncOptionsInput.onDidAccept(() => {
              resolve(false);
              args += ` ${syncOptionsInput.value}`;
              syncOptionsInput.dispose();
            });
            syncOptionsInput.onDidHide(() => {
              resolve(true);
              syncOptionsInput.dispose();
            });
            syncOptionsInput.show();
          });

          if (userQuit) {
            return;
          }
        }

        if (force) {
          args += " --force";
        }

        const operationName = `Electron Build Tools - ${
          force ? "Force " : ""
        }Syncing`;
        const progressWatcher = new SyncProgressWatcher(context);

        const task = runAsTask({
          context,
          operationName,
          taskName: "sync",
          command: `${buildToolsExecutable} sync ${args.trim()}`,
          cancellable: false,
          exitCodeHandler: (exitCode) => {
            if (exitCode === 1 && !force) {
              const confirm = "Force";

              vscode.window
                .showErrorMessage("Sync failed. Try force sync?", confirm)
                .then((value) => {
                  if (value && value === confirm) {
                    vscode.commands.executeCommand(
                      `${commandPrefix}.sync`,
                      true,
                    );
                  }
                });

              return true;
            }
          },
        });

        progressWatcher.startRun();

        task.onDidWriteLine(({ progress, line }) => {
          progressWatcher.updateProgress(progress, line);
        });

        // Only update reference run on successful completion
        if (await task.finished) {
          // Don't update reference run on a force sync
          if (!force) {
            await progressWatcher.finishRun();
          }
        }
      },
    ),
    vscode.commands.registerCommand(`${commandPrefix}.sync.advanced`, () => {
      return vscode.commands.executeCommand(
        `${commandPrefix}.sync`,
        false,
        true,
      );
    }),
    vscode.commands.registerCommand(`${commandPrefix}.sync.force`, () => {
      return vscode.commands.executeCommand(`${commandPrefix}.sync`, true);
    }),
  );
}
