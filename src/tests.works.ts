import * as net from "net";

import * as vscode from "vscode";

import { setupSpecRunner } from "../electron/spec-runner";

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

interface MochaTestResult {
  title: string;
  fullTitle: string;
  duration: number;
  currentRetry?: number;
  err?: string;
  stack?: string;
}

/*
interface MochaJSONTestResult {
  title: string;
  fullTitle: string;
  duration: number;
  currentRetry: number;
  err: Object;
}

interface MochaJSONReport {
  stats: {
    suites: number;
    tests: number;
    passes: number;
    pending: number;
    failures: number;
    start: string;
    end: string;
    duration: number;
  };
  tests: MochaJSONTestResult[];
  pending: MochaJSONTestResult[];
  failures: MochaJSONTestResult[];
  passes: MochaJSONTestResult[];
}
*/

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

  testController.createRunProfile(
    "Debug",
    vscode.TestRunProfileKind.Debug,
    async (request, token) => {
      Logger.info("Started debug run");
    }
  );

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
        const tests = new Map<string, vscode.TestItem>();
        const testRun = testController.createTestRun(request);

        const testRegexes: string[] = [];

        function addTests(testItem: vscode.TestItem) {
          tests.set(testItem.id, testItem);
          if (testItem.children) {
            testItem.children.forEach(addTests);
          }
        }

        for (const testItem of request.include) {
          addTests(testItem);
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
          shellOptions: {
            env: {
              MOCHA_REPORTER: "json-stream",
            },
          },
        });

        task.onDidWriteLine(({ line }) => {
          testRun.appendOutput(`${line}\r\n`);

          // Looks like a JSON stream event
          if (/^\[("pass"|"fail"|"pending"),\{.*\}\]$/.test(line)) {
            const [result, details]: [string, MochaTestResult] =
              JSON.parse(line);
            const test = tests.get(details.fullTitle);

            if (test) {
              // There is only one result per test, delete so we can find skips
              tests.delete(details.fullTitle);

              if (result === "pass") {
                testRun.passed(test, details.duration);
              } else if (result === "fail") {
                const testMessage = new vscode.TestMessage(
                  details.err ? details.err : "Couldn't parse failure output"
                );

                // Pull file position details if they're available
                if (test.uri && details.err && details.stack) {
                  const failureDetails = /^.*\((.*):(\d+):(\d+)\)\s*$/m.exec(
                    details.stack
                  );

                  if (
                    failureDetails &&
                    test.uri.fsPath.endsWith(failureDetails[1])
                  ) {
                    testMessage.location = new vscode.Location(
                      test.uri,
                      new vscode.Position(
                        parseInt(failureDetails[2]) - 1,
                        parseInt(failureDetails[3]) - 1
                      )
                    );
                  }
                }

                testRun.failed(test, testMessage, details.duration);
              }
            }
          }
        });

        try {
          await task.finished;

          for (const [, test] of tests) {
            testRun.skipped(test);
          }
        } finally {
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

  for (const [idx, parsedTest] of suite.tests.entries()) {
    const test = testController.createTestItem(
      parsedTest.fullTitle,
      parsedTest.title,
      vscode.Uri.file(parsedTest.file)
    );
    test.sortText = `a${idx}`;

    if (parsedTest.range) {
      test.range = parsedTest.range;
    }

    collection.add(test);
  }

  for (const [idx, parsedSuite] of suite.suites.entries()) {
    const testSuite = testController.createTestItem(
      parsedSuite.fullTitle,
      parsedSuite.title,
      vscode.Uri.file(parsedSuite.file)
    );
    // Suites run after tests, so sort accordingly
    testSuite.sortText = `b${idx}`;
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

  try {
    await setupSpecRunner(electronRoot.fsPath);
  } catch (err) {
    Logger.error(err instanceof Error ? err : String(err));
    return {
      suites: [],
      tests: [],
      title: "",
      fullTitle: "",
      pending: false,
      file: "",
    };
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
