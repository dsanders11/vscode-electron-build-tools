import * as vscode from "vscode";

import { outputChannelName } from "./constants";

export interface ILogger {
  debug(message: string): void;
  error(message: string): void;
  info(message: string): void;
  error(errOrMessage: Error | string): void;
}

export class OutputChannelLogger extends vscode.Disposable implements ILogger {
  private _outputChannel: vscode.OutputChannel;

  constructor(channelName: string) {
    const outputChannel = vscode.window.createOutputChannel(channelName);

    super(() => {
      outputChannel.dispose();
    });

    this._outputChannel = outputChannel;
  }

  protected _logMessage(prefix: string, message: string) {
    // Match the timestamp format used by VS Code's built-in log
    const timestamp = new Date()
      .toISOString()
      .match(/^(.*)T(.*)Z$/)!
      .slice(1, 3)
      .join(" ");

    this._outputChannel.appendLine(`[${timestamp}] [${prefix}] ${message}`);
  }

  debug(message: string): void {
    this._logMessage("debug", message);
  }

  error(errOrMessage: Error | string): void {
    this._logMessage(
      "error",
      errOrMessage instanceof Error ? errOrMessage.message : errOrMessage,
    );
  }

  info(message: string): void {
    this._logMessage("info", message);
  }

  warn(message: string): void {
    this._logMessage("warn", message);
  }
}

export default new OutputChannelLogger(outputChannelName);
