import * as net from "net";
import * as readline from "readline";

import * as vscode from "vscode";

import { gracefulKillTimeoutMs } from "./constants";
import { generateSocketName, sleep } from "./utils";

type ElectronBuildToolsTask = {
  onDidWriteLine: vscode.Event<OnDidWriteLine>;
  finished: Promise<void>;
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
  // args: string,
  shellOptions?: vscode.ShellExecutionOptions,
  problemMatchers?: string | string[],
  exitCodeHandler?: (exitCode: number) => boolean | undefined
): ElectronBuildToolsTask {
  const socketName = generateSocketName();

  // base64 encode the args to get around shell quoting issues
  const b64args = Buffer.from(command).toString("base64");

  const task = new vscode.Task(
    { type: "electron-build-tools", task: taskName },
    vscode.TaskScope.Workspace,
    taskName,
    "electron-build-tools",
    new vscode.ShellExecution(
      `node out/scripts/echo-to-socket.js C:\\Users\\David\\AppData\\Roaming\\npm\\electron-build-tools.cmd "${b64args}" ${socketName}`,
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

  const taskPromise = vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: operationName.split("-")[1].trim(),
      cancellable: true,
    },
    async (progress, token) => {
      const socketPromise: Promise<net.Socket> = new Promise((resolve) => {
        socketServer.once("connection", (socket) => {
          const rl = readline.createInterface({
            input: socket,
          });

          rl.on("line", (line) =>
            onDidWriteLineEmitter.fire({ progress, line })
          );

          resolve(socket);
        });
      });

      const taskExecution = await vscode.tasks.executeTask(task);
      let processId: number | undefined;

      return new Promise(async (resolve, reject) => {
        socketServer.once("error", () => reject("Socket server error"));

        vscode.tasks.onDidStartTaskProcess((event) => {
          if (event.execution === taskExecution) {
            processId = event.processId;
          }
        });

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

        token.onCancellationRequested(async () => {
          try {
            // Try to gracefully cancel the task first, so we
            // don't end up with stuff like dangling Git locks
            if (processId !== undefined) {
              await new Promise(async (resolve, reject) => {
                let stopTrying = false;
                const timeoutId = setTimeout(() => {
                  reject();
                  stopTrying = true;
                }, gracefulKillTimeoutMs);

                const socket = await socketPromise;
                socket.write("SIGINT");

                while (!stopTrying) {
                  try {
                    process.kill(processId!, 0);
                    await sleep(100);
                  } catch {
                    // Seems inverted, but it will throw an
                    // error if the PID is not found, which
                    // is actually our success case.
                    clearTimeout(timeoutId);
                    resolve();
                    break;
                  }
                }
              });
            } else {
              taskExecution.terminate();
            }
          } catch {
            taskExecution.terminate();
          } finally {
            resolve();
            console.warn(`User canceled '${command}'`);
          }
        });
      }).finally(() => taskExecution.terminate());
    }
  );

  return {
    onDidWriteLine: onDidWriteLineEmitter.event,
    finished: new Promise(async (resolve) => {
      try {
        await taskPromise;
      } finally {
        resolve();
      }
    }),
  };
}
