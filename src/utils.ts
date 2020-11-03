import * as childProcess from "child_process";
import * as net from "net";
import * as os from "os";
import * as path from "path";
import * as readline from "readline";

import * as vscode from "vscode";

import { v4 as uuidv4 } from "uuid";

export function isBuildToolsInstalled() {
  const result = childProcess.spawnSync(
    os.platform() === "win32" ? "where" : "which",
    ["electron-build-tools"]
  );

  return result.status === 0;
}

export function generateSocketName() {
  if (os.platform() === "win32") {
    return `\\\\.\\pipe\\${uuidv4()}`;
  } else {
    throw new Error("Not implemented");
  }
}

export function getConfigs() {
  const configs: string[] = [];
  let activeConfig = null;

  const configsOutput = childProcess
    .execSync("electron-build-tools show configs", { encoding: "utf8" })
    .trim();

  for (const rawConfig of configsOutput.split("\n")) {
    const config = rawConfig.replace("*", "").trim();
    configs.push(config);

    if (rawConfig.trim().startsWith("*")) {
      activeConfig = config;
    }
  }

  return { configs, activeConfig };
}

export function getConfigsFilePath() {
  return path.join(os.homedir(), ".electron_build_tools", "configs");
}

export function runAsTask(
  operationName: string,
  taskName: string,
  command: string,
  shellOptions: vscode.ShellExecutionOptions,
  outputParser: (
    progress: vscode.Progress<{
      message?: string | undefined;
      increment?: number | undefined;
    }>,
    line: string
  ) => void
) {
  const socketName = generateSocketName();

  const task = new vscode.Task(
    { type: "electron-build-tools", task: taskName },
    vscode.workspace.workspaceFolders![0],
    taskName,
    "electron-build-tools",
    new vscode.ShellExecution(
      `${command} | node tee-to-socket.js ${socketName}`,
      { cwd: __dirname, ...shellOptions }
    ),
    "$electron"
  );

  // TODO - How to stop the terminal from being closed on task cancel?
  task.presentationOptions = {
    reveal: vscode.TaskRevealKind.Silent,
    echo: false,
    clear: true,
  };

  const socketServer = net.createServer().listen(socketName);

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

        rl.on("line", (line) => outputParser(progress, line));
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
          if (execution === taskExecution && exitCode && exitCode !== 0) {
            vscode.window.showErrorMessage(
              `'${operationName}' failed with exit code ${exitCode}`
            );
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
}
