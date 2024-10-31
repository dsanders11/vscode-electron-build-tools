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

  private _ghAuthenticationSession: vscode.AuthenticationSession | null = null;

  private _updateContexts() {
    return Promise.all([
      setContext("canBuild", this.canRunOperation(ExtensionOperation.BUILD)),
      setContext(
        "canChangeConfig",
        this.canRunOperation(ExtensionOperation.CHANGE_CONFIG),
      ),
      setContext(
        "canLoadTests",
        this.canRunOperation(ExtensionOperation.LOAD_TESTS),
      ),
      setContext(
        "canRefreshPatches",
        this.canRunOperation(ExtensionOperation.REFRESH_PATCHES),
      ),
      setContext(
        "canRunTests",
        this.canRunOperation(ExtensionOperation.RUN_TESTS),
      ),
      setContext("canSync", this.canRunOperation(ExtensionOperation.SYNC)),
    ]);
  }

  private async _updateState(operation: ExtensionOperation, running: boolean) {
    const ops = this._runningOperations;
    if (running) {
      ops.add(operation);
    } else {
      ops.delete(operation);
    }

    // Update contexts for use in UI
    await this._updateContexts();
  }

  async setInitialState() {
    this._runningOperations.clear();
    await this._updateContexts();
  }

  isOperationRunning(...ops: ExtensionOperation[]) {
    return ops.some((op: ExtensionOperation) =>
      this._runningOperations.has(op),
    );
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
    const isOpRunning = this.isOperationRunning.bind(this);

    switch (operation) {
      case BUILD:
        return !isOpRunning(BUILD, CHANGE_CONFIG, RUN_TESTS, SYNC);

      case CHANGE_CONFIG:
        return !isOpRunning(
          BUILD,
          CHANGE_CONFIG,
          LOAD_TESTS,
          REFRESH_PATCHES,
          RUN_TESTS,
          SYNC,
        );

      case LOAD_TESTS:
        return !isOpRunning(
          BUILD,
          CHANGE_CONFIG,
          LOAD_TESTS,
          REFRESH_PATCHES,
          RUN_TESTS,
          SYNC,
        );

      case REFRESH_PATCHES:
        return !isOpRunning(CHANGE_CONFIG, REFRESH_PATCHES, SYNC);

      case RUN_TESTS:
        return !isOpRunning(BUILD, CHANGE_CONFIG, LOAD_TESTS, RUN_TESTS);

      case SYNC:
        return !isOpRunning(BUILD, CHANGE_CONFIG, SYNC);

      // No default, let TypeScript error if we miss a case
    }
  }

  async runOperation<T>(
    operation: ExtensionOperation,
    workFn: () => Promise<T> | T,
    runOnlyWorkFn: boolean = false,
  ): Promise<T> {
    // TODO - This is a short-circuit to get around reentrancy issues.
    //        In future VS Code versions, AsyncLocalStorage should be
    //        available, consider using that to allow for reentrancy
    if (runOnlyWorkFn) {
      return await workFn();
    } else {
      if (!this.canRunOperation(operation)) {
        Logger.error(
          `ExtensionState.runOperation denied operation ${operation}`,
        );
        throw new Error("Can't run operation");
      }

      await this._updateState(operation, true);

      try {
        return await workFn();
      } finally {
        await this._updateState(operation, false);
      }
    }
  }

  registerExtensionOperationCommand(
    operation: ExtensionOperation,
    command: string,
    operationDeniedCallback: () => void,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    callback: (...args: any[]) => unknown,
    thisArg?: unknown,
  ): vscode.Disposable {
    return vscode.commands.registerCommand(
      command,
      (...args: unknown[]): unknown => {
        if (!this.canRunOperation(operation)) {
          return operationDeniedCallback();
        }

        return this.runOperation(operation, () => callback(...args));
      },
      thisArg,
    );
  }

  async getGitHubAuthenticationSession() {
    if (!this._ghAuthenticationSession) {
      this._ghAuthenticationSession = await vscode.authentication.getSession(
        "github",
        [],
        { createIfNone: true },
      );
    }

    return this._ghAuthenticationSession;
  }
}

export default new ExtensionStateTracker();
