import * as net from "net";
import * as readline from "readline";
import { PassThrough } from "stream";

import * as vscode from "vscode";

import type { IpcMessage } from "./common";
import Logger from "./logging";
import { generateSocketName } from "./utils";

export interface ElectronBuildToolsTask {
  onDidWriteData: vscode.Event<OnDidWriteData>;
  onDidWriteLine: vscode.Event<OnDidWriteLine>;
  finished: Promise<boolean>;
}

type OnDidWriteData = IpcMessage;

interface OnDidWriteLine {
  progress: vscode.Progress<{
    message?: string | undefined;
    increment?: number | undefined;
  }>;
  line: string;
}

export function runAsTask({
  context,
  operationName,
  taskName,
  command,
  cancellable = true,
  shellOptions,
  problemMatchers,
  exitCodeHandler,
  presentationOptions,
  cancellationToken,
}: {
  context: vscode.ExtensionContext;
  operationName: string;
  taskName: string;
  command: string;
  cancellable?: boolean;
  shellOptions?: vscode.ShellExecutionOptions;
  problemMatchers?: string | string[];
  exitCodeHandler?: (exitCode: number) => boolean | undefined;
  presentationOptions?: vscode.TaskPresentationOptions;
  cancellationToken?: vscode.CancellationToken;
}): ElectronBuildToolsTask {
  const socketName = generateSocketName();

  // base64 encode the command to get around shell quoting issues
  const b64command = Buffer.from(command).toString("base64");

  const task = new vscode.Task(
    { type: "electron-build-tools", task: taskName },
    vscode.TaskScope.Workspace,
    taskName,
    "electron-build-tools",
    new vscode.ShellExecution(
      `node out/scripts/echo-to-socket.js "${b64command}" ${socketName}`,
      {
        cwd: context.extensionPath,
        ...shellOptions,
        env: {
          FORCE_COLOR: "true",
          ...shellOptions?.env,
        },
      }
    ),
    problemMatchers
  );

  if (presentationOptions) {
    task.presentationOptions = presentationOptions;
  } else {
    // TODO - How to stop the terminal from being closed on task cancel?
    task.presentationOptions = {
      reveal: vscode.TaskRevealKind.Silent,
      echo: false,
      clear: true,
    };
  }

  const socketServer = net.createServer().listen(socketName);

  const onDidWriteDataEmitter = new vscode.EventEmitter<OnDidWriteData>();
  const onDidWriteLineEmitter = new vscode.EventEmitter<OnDidWriteLine>();

  const taskPromise = vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: operationName.split("-")[1].trim(),
      cancellable,
    },
    async (progress, token) => {
      socketServer.on("connection", (socket) => {
        const stdoutStream = new PassThrough();
        const rl = readline.createInterface({
          input: stdoutStream,
        });

        socket.on("data", (data) => {
          const message: IpcMessage = JSON.parse(data.toString());

          if (message.stream === "stdout") {
            stdoutStream.write(message.data);
          } else {
            onDidWriteDataEmitter.fire(message);
          }
        });

        rl.on("line", (line) => onDidWriteLineEmitter.fire({ progress, line }));
      });

      const taskExecution = await vscode.tasks.executeTask(task);

      return new Promise<boolean>(async (resolve, reject) => {
        socketServer.once("error", () => reject("Socket server error"));

        vscode.tasks.onDidEndTask(({ execution }) => {
          if (execution === taskExecution) {
            resolve(true);
          }
        });

        vscode.tasks.onDidEndTaskProcess(({ execution, exitCode }) => {
          if (execution === taskExecution && exitCode !== undefined) {
            resolve(exitCode === 0);
            const handled = exitCodeHandler ? exitCodeHandler(exitCode) : false;

            if (exitCode !== 0 && !handled) {
              vscode.window.showErrorMessage(
                `'${operationName}' failed with exit code ${exitCode}`
              );
            }
          }
        });

        const cancelTask = () => {
          resolve(false);
          taskExecution.terminate();
          Logger.warn(`User canceled '${command}'`);
        };

        token.onCancellationRequested(cancelTask);
        cancellationToken?.onCancellationRequested(cancelTask);
      }).finally(() => taskExecution.terminate());
    }
  );

  return {
    onDidWriteData: onDidWriteDataEmitter.event,
    onDidWriteLine: onDidWriteLineEmitter.event,
    finished: new Promise<boolean>(async (resolve) => {
      try {
        resolve(await taskPromise);
      } catch {
        resolve(false);
      }
    }),
  };
}
