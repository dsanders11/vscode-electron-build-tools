import * as vscode from "vscode";

import { contextKeyPrefix } from "./constants";
import Logger from "./logging";

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

  private async _setContext(
    contextKey: string,
    contextValue: any
  ): Promise<any> {
    return await vscode.commands.executeCommand(
      "setContext",
      `${contextKeyPrefix}:${contextKey}`,
      contextValue
    );
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
    this._setContext(
      "canBuild",
      this.canRunOperation(ExtensionOperation.BUILD)
    );
    this._setContext(
      "canChangeConfig",
      this.canRunOperation(ExtensionOperation.CHANGE_CONFIG)
    );
    this._setContext(
      "canLoadTests",
      this.canRunOperation(ExtensionOperation.LOAD_TESTS)
    );
    this._setContext(
      "canRefreshPatches",
      this.canRunOperation(ExtensionOperation.REFRESH_PATCHES)
    );
    this._setContext(
      "canRunTests",
      this.canRunOperation(ExtensionOperation.RUN_TESTS)
    );
    this._setContext("canSync", this.canRunOperation(ExtensionOperation.SYNC));
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
    operationDeniedGuard: () => void,
    callback: (...args: any[]) => any,
    thisArg?: any
  ): vscode.Disposable {
    return vscode.commands.registerCommand(
      command,
      (...args: any[]): any => {
        if (!this.canRunOperation(operation)) {
          return operationDeniedGuard();
        }

        return this.runOperation(operation, () => callback(...args));
      },
      thisArg
    );
  }
}

export default new ExtensionStateTracker();
