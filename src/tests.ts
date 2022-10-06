import * as net from "net";

import * as vscode from "vscode";

import { buildToolsExecutable, commandPrefix } from "./constants";
import {
  default as ExtensionState,
  ExtensionOperation,
} from "./extensionState";
import Logger from "./logging";
import { runAsTask } from "./tasks";
import { escapeStringForRegex, generateSocketName } from "./utils";

interface ParsedTestData {
  title: string;
  fullTitle: string;
  file: string;
  pending: boolean;
}

interface ParsedTestSuite extends ParsedTestData {
  suites: ParsedTestSuite[];
  tests: ParsedTest[];
}

interface ParsedTest extends ParsedTestData {
  range: vscode.Range | null;
}

export function createTestController(
  context: vscode.ExtensionContext,
  electronRoot: vscode.Uri
) {
  const runProfileData = new WeakMap<vscode.TestRunProfile, string>();

  const testController = vscode.tests.createTestController(
    "electron-build-tools-tests",
    "Electron Tests"
  );

  testController.refreshHandler = async (token: vscode.CancellationToken) => {
    vscode.window.withProgress(
      {
        location: { viewId: "workbench.view.extension.test" },
      },
      () => discoverTests(context, electronRoot, testController, token)
    );
  };

  const runProfile = testController.createRunProfile(
    "Run",
    vscode.TestRunProfileKind.Run,
    async (request, token) => {
      // TODO - Implement running tests
      const extraArgs = runProfileData.get(runProfile);

      // TODO - Improve this logic
      if (!request.include?.length && !request.exclude?.length) {
        // TODO - Run all tests
      } else if (request.include && !request.exclude?.length) {
        const testRun = testController.createTestRun(request);

        const testRegexes = [];

        for (const testItem of request.include) {
          testRun.started(testItem);
          testRegexes.push(escapeStringForRegex(testItem.id));
        }

        let command = `${buildToolsExecutable} test --runners=main -g '${testRegexes.join(
          "|"
        )}'`;

        if (extraArgs) {
          command += ` ${extraArgs}`;
        }

        const task = runAsTask({
          context,
          operationName: "Electron Build Tools - Running Test",
          taskName: "test",
          command,
          cancellationToken: token,
        });

        task.onDidWriteLine(({ line }) => {
          testRun.appendOutput(`${line}\r\n`);
        });

        try {
          await task.finished;
        } finally {
          testRun.passed(request.include[0]);
          testRun.end();
        }
      }
    }
  );

  runProfile.configureHandler = async () => {
    const extraArgs = await vscode.window.showInputBox({
      title: "Electron Test Runner",
      placeHolder: "Extra args to pass to the test runner",
    });

    if (extraArgs) {
      runProfileData.set(runProfile, extraArgs);
    }
  };

  // Do initial discovery and try to show the user that there's
  // something going on with the test explorer
  // TODO - Would be nice if test explorer showed progress better
  vscode.window.withProgress(
    {
      location: { viewId: "workbench.view.extension.test" },
    },
    () => discoverTests(context, electronRoot, testController)
  );

  return testController;
}

function createTestItems(
  testController: vscode.TestController,
  suite: ParsedTestSuite,
  collection: vscode.TestItemCollection
) {
  const tests: ParsedTest[] = [];

  for (const parsedTest of suite.tests) {
    const test = testController.createTestItem(
      parsedTest.fullTitle,
      parsedTest.title,
      vscode.Uri.file(parsedTest.file)
    );

    if (parsedTest.range) {
      test.range = parsedTest.range;
    }

    collection.add(test);
  }

  for (const parsedSuite of suite.suites) {
    const testSuite = testController.createTestItem(
      parsedSuite.fullTitle,
      parsedSuite.title,
      vscode.Uri.file(parsedSuite.file)
    );
    collection.add(testSuite);

    tests.push(
      ...createTestItems(testController, parsedSuite, testSuite.children)
    );
  }

  return tests;
}

async function discoverTests(
  context: vscode.ExtensionContext,
  electronRoot: vscode.Uri,
  testController: vscode.TestController,
  token?: vscode.CancellationToken
) {
  // TODO - Store cached tests, fill the tree with them but mark them all busy, then do initial refresh

  const testSuites = await ExtensionState.runOperation(
    ExtensionOperation.LOAD_TESTS,
    () => getElectronTests(context, electronRoot, token),
    ExtensionState.isOperationRunning(ExtensionOperation.LOAD_TESTS)
  );

  createTestItems(testController, testSuites, testController.items);
}

// TODO - Determine why Electron doesn't exit on task terminate
async function getElectronTests(
  context: vscode.ExtensionContext,
  electronRoot: vscode.Uri,
  token?: vscode.CancellationToken,
  files?: vscode.Uri[]
): Promise<ParsedTestSuite> {
  if (!files) {
    files = await vscode.workspace.findFiles(
      new vscode.RelativePattern(electronRoot, `spec/**/*-spec.{js,ts}`),
      "**/node_modules/**"
    );
  }

  const electronExe = await vscode.commands.executeCommand<string>(
    `${commandPrefix}.show.exe`
  )!;
  const scriptName = context.asAbsolutePath("out/electron/listMochaTests.js");
  const tsNodeCompiler = context.asAbsolutePath(
    "out/electron/electron-build-tools-typescript.js"
  );
  const socketName = generateSocketName();

  const task = new vscode.Task(
    { type: "electron-build-tools", task: "discover-tests" },
    vscode.TaskScope.Workspace,
    "Discover Electron Tests",
    "electron-build-tools",
    new vscode.ProcessExecution(electronExe, [scriptName, socketName], {
      cwd: electronRoot.fsPath,
      env: {
        // Filter out environment variables that VS Code has set which
        // would effect Electron, such as ELECTRON_RUN_AS_NODE, but try
        // to pick up the other handy stuff like debugger auto-attach
        ...Object.fromEntries(
          Object.entries(process.env).filter(
            ([key]) => !key.startsWith("ELECTRON_")
          )
        ),
        TS_NODE_PROJECT: vscode.Uri.joinPath(electronRoot, "tsconfig.spec.json")
          .fsPath,
        TS_NODE_FILES: "true", // Without this compilation fails
        TS_NODE_TRANSPILE_ONLY: "true", // Faster
        TS_NODE_CACHE: "false",
        TS_NODE_COMPILER: tsNodeCompiler,
        ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
      },
    })
  );
  task.presentationOptions = {
    reveal: vscode.TaskRevealKind.Never,
    echo: false,
    clear: true,
  };

  return new Promise(async (resolve, reject) => {
    let result = "";

    const socketServer = net.createServer().listen(socketName);
    const socketClosedPromise = new Promise((resolve, reject) => {
      socketServer.once("connection", (socket) => {
        socket.on("data", (data) => {
          result += data.toString();
        });
        socket.on("close", resolve);

        socket.once("error", reject);

        // Send filenames of the tests
        for (const uri of files!) {
          socket.write(`${uri.fsPath}\n`);
        }
        socket.write("DONE\n");
      });
      socketServer.once("error", reject);
    });

    try {
      const taskExecution = await vscode.tasks.executeTask(task);
      token?.onCancellationRequested(() => taskExecution.terminate());

      vscode.tasks.onDidEndTask(async ({ execution }) => {
        if (execution === taskExecution) {
          await socketClosedPromise;
          socketServer.close();
          Logger.info(result); // TODO - Remove debug code
          resolve(JSON.parse(result));
        }
      });

      vscode.tasks.onDidEndTaskProcess(async ({ execution, exitCode }) => {
        if (execution === taskExecution) {
          if (exitCode === undefined) {
            // Task terminated
            reject();
            socketServer.close();
          } else {
            await socketClosedPromise;
            socketServer.close();
            Logger.info(result); // TODO - Remove debug code
            resolve(JSON.parse(result));
          }
        }
      });
    } catch (err) {
      socketServer.close();
      Logger.error(err instanceof Error ? err : String(err));
      reject(err);
    }
  });
}
