import * as vscode from "vscode";

import Logger from "./logging";
import { setContext } from "./utils";

export enum ExtensionOperation {
  BUILD,
  CHANGE_CONFIG,
  LOAD_TESTS,
  REFRESH_PATCHES,
  RUN_TESTS,
  SYNC,
}

class ExtensionStateTracker {
  // TBD - Some operations may be safe to have multiple parallel runs of,
  //       such as running tests. So Set() may by overly constricting here
  private readonly _runningOperations = new Set<ExtensionOperation>();

  private _updateContexts() {
    return Promise.all([
      setContext("canBuild", this.canRunOperation(ExtensionOperation.BUILD)),
      setContext(
        "canChangeConfig",
        this.canRunOperation(ExtensionOperation.CHANGE_CONFIG)
      ),
      setContext(
        "canLoadTests",
        this.canRunOperation(ExtensionOperation.LOAD_TESTS)
      ),
      setContext(
        "canRefreshPatches",
        this.canRunOperation(ExtensionOperation.REFRESH_PATCHES)
      ),
      setContext(
        "canRunTests",
        this.canRunOperation(ExtensionOperation.RUN_TESTS)
      ),
      setContext("canSync", this.canRunOperation(ExtensionOperation.SYNC)),
    ]);
  }

  private _isOpRunning(...ops: ExtensionOperation[]) {
    return ops.some((op: ExtensionOperation) =>
      this._runningOperations.has(op)
    );
  }

  private async _updateState(operation: ExtensionOperation, running: boolean) {
    const ops = this._runningOperations;
    running ? ops.add(operation) : ops.delete(operation);

    // Update contexts for use in UI
    await this._updateContexts();
  }

  async setInitialState() {
    this._runningOperations.clear();
    await this._updateContexts();
  }

  canRunOperation(operation: ExtensionOperation): boolean {
    // Destructure the enum so it's not so wordy in here
    const {
      BUILD,
      CHANGE_CONFIG,
      LOAD_TESTS,
      REFRESH_PATCHES,
      RUN_TESTS,
      SYNC,
    } = ExtensionOperation;

    switch (operation) {
      case BUILD:
        return !this._isOpRunning(BUILD, CHANGE_CONFIG, RUN_TESTS, SYNC);

      case CHANGE_CONFIG:
        return !this._isOpRunning(
          BUILD,
          CHANGE_CONFIG,
          LOAD_TESTS,
          REFRESH_PATCHES,
          RUN_TESTS,
          SYNC
        );

      case LOAD_TESTS:
        return !this._isOpRunning(
          BUILD,
          CHANGE_CONFIG,
          LOAD_TESTS,
          REFRESH_PATCHES,
          RUN_TESTS,
          SYNC
        );

      case REFRESH_PATCHES:
        return !this._isOpRunning(CHANGE_CONFIG, REFRESH_PATCHES, SYNC);

      case RUN_TESTS:
        return !this._isOpRunning(BUILD, CHANGE_CONFIG, LOAD_TESTS, RUN_TESTS);

      case SYNC:
        return !this._isOpRunning(BUILD, CHANGE_CONFIG, SYNC);

      // No default, let TypeScript error if we miss a case
    }
  }

  async runOperation<T>(
    operation: ExtensionOperation,
    workFn: () => Promise<T> | T
  ): Promise<T> {
    if (!this.canRunOperation(operation)) {
      Logger.error(`ExtensionState.runOperation denied operation ${operation}`);
      throw new Error("Can't run operation");
    }

    await this._updateState(operation, true);

    try {
      return await workFn();
    } finally {
      await this._updateState(operation, false);
    }
  }

  registerExtensionOperationCommand(
    operation: ExtensionOperation,
    command: string,
    operationDeniedCallback: () => void,
    callback: (...args: any[]) => any,
    thisArg?: any
  ): vscode.Disposable {
    return vscode.commands.registerCommand(
      command,
      (...args: any[]): any => {
        if (!this.canRunOperation(operation)) {
          return operationDeniedCallback();
        }

        return this.runOperation(operation, () => callback(...args));
      },
      thisArg
    );
  }
}

export default new ExtensionStateTracker();
