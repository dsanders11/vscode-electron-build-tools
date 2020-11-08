import * as net from "net";
import * as readline from "readline";

import * as vscode from "vscode";

import { generateSocketName } from "./utils";

type ElectronBuildToolsTask = {
  onDidWriteLine: vscode.Event<OnDidWriteLine>;
};

type OnDidWriteLine = {
  progress: vscode.Progress<{
    message?: string | undefined;
    increment?: number | undefined;
  }>;
  line: string;
};

export function runAsTask(
  context: vscode.ExtensionContext,
  operationName: string,
  taskName: string,
  command: string,
  shellOptions?: vscode.ShellExecutionOptions,
  problemMatchers?: string | string[],
  exitCodeHandler?: (exitCode: number) => boolean | undefined
): ElectronBuildToolsTask {
  const socketName = generateSocketName();

  // base64 encode the command to get around shell quoting issues
  const b64command = Buffer.from(command).toString("base64");

  const task = new vscode.Task(
    { type: "electron-build-tools", task: taskName },
    vscode.workspace.workspaceFolders![0],
    taskName,
    "electron-build-tools",
    new vscode.ShellExecution(
      `node out/scripts/echo-to-socket.js "${b64command}" ${socketName}`,
      { cwd: context.extensionPath, ...shellOptions }
    ),
    problemMatchers
  );

  // TODO - How to stop the terminal from being closed on task cancel?
  task.presentationOptions = {
    reveal: vscode.TaskRevealKind.Silent,
    echo: false,
    clear: true,
  };

  const socketServer = net.createServer().listen(socketName);

  const onDidWriteLineEmitter = new vscode.EventEmitter<OnDidWriteLine>();

  const wrappedTask: ElectronBuildToolsTask = {
    onDidWriteLine: onDidWriteLineEmitter.event,
  };

  vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: operationName.split("-")[1].trim(),
      cancellable: true,
    },
    async (progress, token) => {
      socketServer.on("connection", (socket) => {
        const rl = readline.createInterface({
          input: socket,
        });

        rl.on("line", (line) => onDidWriteLineEmitter.fire({ progress, line }));
      });

      const taskExecution = await vscode.tasks.executeTask(task);

      return new Promise(async (resolve, reject) => {
        socketServer.on("error", () => reject("Socket server error"));

        vscode.tasks.onDidEndTask(({ execution }) => {
          if (execution === taskExecution) {
            resolve();
          }
        });

        vscode.tasks.onDidEndTaskProcess(({ execution, exitCode }) => {
          if (execution === taskExecution && exitCode !== undefined) {
            const handled = exitCodeHandler ? exitCodeHandler(exitCode) : false;

            if (exitCode !== 0 && !handled) {
              vscode.window.showErrorMessage(
                `'${operationName}' failed with exit code ${exitCode}`
              );
            }
          }
        });

        token.onCancellationRequested(() => {
          resolve();
          taskExecution.terminate();
          console.warn(`User canceled '${command}'`);
        });
      }).finally(() => taskExecution.terminate());
    }
  );

  return wrappedTask;
}
