import * as net from "net";
import * as readline from "readline";
import { PassThrough } from "stream";

import * as vscode from "vscode";

import type { IpcMessage } from "./common";
import Logger from "./logging";
import { generateSocketName } from "./utils";

export interface ElectronBuildToolsTask {
  onDidWriteData: vscode.Event<OnDidWriteData>;
  onDidWriteErrorLine: vscode.Event<OnDidWriteLine>;
  onDidWriteLine: vscode.Event<OnDidWriteLine>;
  eventsDone: Promise<void>;
  finished: Promise<boolean | undefined>;
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
  suppressExitCode = false,
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
  suppressExitCode?: boolean;
}): ElectronBuildToolsTask {
  const socketName = generateSocketName();

  // base64 encode the command to get around shell quoting issues
  const b64command = Buffer.from(command).toString("base64");

  const script = context.asAbsolutePath("out/scripts/echo-to-socket.js");

  const task = new vscode.Task(
    { type: "electron-build-tools", task: taskName },
    vscode.TaskScope.Workspace,
    taskName,
    "electron-build-tools",
    new vscode.ShellExecution(
      `node ${script} "${b64command}" ${socketName} ${
        suppressExitCode ? 1 : ""
      }`.trimEnd(),
      {
        cwd: context.extensionPath,
        ...shellOptions,
        env: {
          FORCE_COLOR: "true",
          EBT_SOCKET_PATH: socketName,
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
  const onDidWriteErrorLineEmitter = new vscode.EventEmitter<OnDidWriteLine>();
  const onDidWriteLineEmitter = new vscode.EventEmitter<OnDidWriteLine>();

  let eventsStarted = false;
  let eventsDone: (value: void) => void;
  const eventsDonePromise = new Promise<void>(
    (resolve) => (eventsDone = resolve)
  );

  const taskPromise = vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: operationName.split("-")[1].trim(),
      cancellable,
    },
    async (progress, token) => {
      socketServer.on("connection", (socket) => {
        eventsStarted = true;

        const messageStream = new PassThrough();
        const stderrStream = new PassThrough();
        const stdoutStream = new PassThrough();

        const messages = readline.createInterface({
          input: messageStream,
        });
        const stderr = readline.createInterface({
          input: stderrStream,
        });
        const stdout = readline.createInterface({
          input: stdoutStream,
        });

        socket.on("data", (data) => {
          messageStream.write(data);
        });

        messages.on("line", (line) => {
          // Remove the newline encoding
          line = line.replace(/%25|%0A/g, (match) => {
            switch (match) {
              case "%25":
                return "%";
              case "%0A":
                return "\n";
              default:
                throw new Error("Unreachable");
            }
          });

          let message: IpcMessage;

          try {
            message = JSON.parse(line);
          } catch (err) {
            Logger.error(`Failed to parse message: ${err}`);
            return;
          }

          if (message.stream === "stdout") {
            stdoutStream.write(message.data);
          } else if (message.stream === "stderr") {
            stderrStream.write(message.data);
          } else {
            onDidWriteDataEmitter.fire(message);
          }
        });

        const socketDone = () => {
          socket.destroy();
          eventsDone();
        };

        socket.once("close", socketDone);
        socket.once("end", socketDone);

        stderr.on("line", (line) =>
          onDidWriteErrorLineEmitter.fire({ progress, line })
        );
        stdout.on("line", (line) =>
          onDidWriteLineEmitter.fire({ progress, line })
        );
      });

      const taskExecution = await vscode.tasks.executeTask(task);
      const disposables: vscode.Disposable[] = [];

      return new Promise<boolean | undefined>(async (resolve, reject) => {
        socketServer.once("error", () => reject("Socket server error"));

        vscode.tasks.onDidEndTask(({ execution }) => {
          if (execution === taskExecution) {
            resolve(true);
          }
        }, disposables);

        vscode.tasks.onDidEndTaskProcess(({ execution, exitCode }) => {
          if (execution === taskExecution) {
            if (exitCode !== undefined) {
              resolve(exitCode === 0);
              const handled = exitCodeHandler
                ? exitCodeHandler(exitCode)
                : false;

              if (exitCode !== 0 && !handled) {
                vscode.window.showErrorMessage(
                  `'${operationName}' failed with exit code ${exitCode}`
                );
              }
            } else {
              resolve(undefined);
            }
          }
        }, disposables);

        const cancelTask = () => {
          resolve(undefined);
          taskExecution.terminate();
          Logger.warn(`User canceled '${command}'`);
        };

        if (
          token.isCancellationRequested ||
          cancellationToken?.isCancellationRequested
        ) {
          cancelTask();
          return;
        }

        token.onCancellationRequested(cancelTask);
        cancellationToken?.onCancellationRequested(cancelTask);
      }).finally(() => {
        taskExecution.terminate();
        disposables.forEach((disposable) => disposable.dispose());
      });
    }
  );

  return {
    onDidWriteData: onDidWriteDataEmitter.event,
    onDidWriteErrorLine: onDidWriteErrorLineEmitter.event,
    onDidWriteLine: onDidWriteLineEmitter.event,
    eventsDone: eventsDonePromise,
    finished: new Promise(async (resolve) => {
      try {
        resolve(await taskPromise);
      } catch (err) {
        Logger.error(err instanceof Error ? err : String(err));
        resolve(false);
      } finally {
        // Events never started, they're now done
        if (!eventsStarted) {
          eventsDone();
        }
      }
    }),
  };
}
