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
      async (force?: boolean) => {
        const command = `${buildToolsExecutable} sync${
          force ? " --force" : ""
        }`;
        const operationName = `Electron Build Tools - ${
          force ? "Force " : ""
        }Syncing`;
        const progressWatcher = new SyncProgressWatcher(context);

        const task = runAsTask({
          context,
          operationName,
          taskName: "sync",
          command,
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
    vscode.commands.registerCommand(`${commandPrefix}.sync.force`, () => {
      return vscode.commands.executeCommand(`${commandPrefix}.sync`, true);
    }),
  );
}
