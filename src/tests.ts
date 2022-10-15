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
  file?: string;
  pending: boolean;
  range: vscode.Range | null;
}

export interface ParsedTestSuite extends ParsedTestData {
  suites: ParsedTestSuite[];
  tests: ParsedTestData[];
}

interface MochaTestEvent {
  title: string;
  fullTitle: string;
  duration: number;
  currentRetry?: number;
  err?: {
    message: string;
    actual?: string;
    expected?: string;
  };
  stack?: string;
}

type MochaEvent =
  | ["pass", MochaTestEvent]
  | ["fail", MochaTestEvent]
  | ["pending", MochaTestEvent]
  | ["test-start", MochaTestEvent];

export function createTestController(
  context: vscode.ExtensionContext,
  electronRoot: vscode.Uri
) {
  const runProfileData = new WeakMap<vscode.TestRunProfile, string>();

  const testController = vscode.tests.createTestController(
    "electron-build-tools-tests",
    "Electron Tests"
  );

  testController.resolveHandler = async (test?: vscode.TestItem) => {
    if (!test) {
      try {
        await discoverTests(context, electronRoot, testController);
      } catch (err) {
        Logger.error(err instanceof Error ? err : String(err));
        throw new Error("Error when loading Electron tests");
      }
    }
  };

  testController.refreshHandler = async (token: vscode.CancellationToken) => {
    try {
      await discoverTests(context, electronRoot, testController, token);
    } catch (err) {
      Logger.error(err instanceof Error ? err : String(err));
      throw new Error("Error when refreshing Electron tests");
    }
  };

  // TODO - Add a debug profile
  const runProfile = testController.createRunProfile(
    "Run",
    vscode.TestRunProfileKind.Run,
    async (request, token) => {
      const extraArgs = runProfileData.get(runProfile);
      const run = testController.createTestRun(request);

      const testRegexes: string[] = [];
      const testsById = new Map<string, vscode.TestItem>();

      // To process test results we need a map of all test IDs to the TestItem
      // Don't map suites, since VS Code acts buggy if you set state for them
      // since it tries to apply state based on what the children are doing
      function addTests(testItem: vscode.TestItem) {
        if (testItem.children.size > 0) {
          testItem.children.forEach(addTests);
        } else {
          testsById.set(testItem.id, testItem);
        }
      }

      if (!request.include) {
        if (request.exclude) {
          // If no request.include, include all top-level tests which aren't excluded
          for (const [, test] of testController.items) {
            if (!request.exclude?.includes(test)) {
              addTests(test);
              testRegexes.push(`'${escapeStringForRegex(test.id)}`);
            } else {
              testsById.delete(test.id);
            }
          }
        }
      } else {
        request.include.forEach((test) => {
          addTests(test);
          testRegexes.push(escapeStringForRegex(test.id));
        });
      }

      let command = `${buildToolsExecutable} test --runners=main`;

      if (testRegexes.length) {
        command += ` -g '${testRegexes.join("|")}'`;
      }

      if (extraArgs) {
        command += ` ${extraArgs}`;
      }

      // Mark all tests we're about to run as enqueued
      for (const test of testsById.values()) {
        run.enqueued(test);
      }

      let testRunError = false;

      const task = runAsTask({
        context,
        operationName: "Electron Build Tools - Running Test(s)",
        taskName: "test",
        command,
        cancellationToken: token,
        shellOptions: {
          cwd: electronRoot.fsPath,
          env: {
            MOCHA_REPORTER: "mocha-multi-reporters",
            MOCHA_MULTI_REPORTERS: `${context.asAbsolutePath(
              "out/electron/mocha-reporter.js"
            )}, spec`,
            ELECTRON_ROOT: electronRoot.fsPath,
          },
        },
        // Ignore non-zero exit codes, there's no way to
        // distinguish from normal test failures
        suppressExitCode: true,
      });

      task.onDidWriteLine(({ line }) => {
        run.appendOutput(`${line}\r\n`);
      });

      task.onDidWriteData(({ stream, data }) => {
        if (stream === "mocha-test-results") {
          const [eventName, details]: MochaEvent = data;
          const test = testsById.get(details.fullTitle);

          if (test) {
            if (eventName === "pass") {
              testsById.delete(details.fullTitle);
              run.passed(test, details.duration);
            } else if (eventName === "fail") {
              testsById.delete(details.fullTitle);

              let testMessage: vscode.TestMessage;

              if (details.err) {
                testMessage = new vscode.TestMessage(details.err.message);
                testMessage.actualOutput = details.err.actual;
                testMessage.expectedOutput = details.err.expected;
              } else {
                testMessage = new vscode.TestMessage(
                  "Couldn't parse failure output"
                );
              }

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

              run.failed(test, testMessage, details.duration);
            } else if (eventName === "pending") {
              testsById.delete(details.fullTitle);
              run.skipped(test);
            } else if (eventName === "test-start") {
              run.started(test);
            }
          }
        }
      });

      task.onDidWriteErrorLine(({ line }) => {
        if (/^An error occurred while running the spec runner\s*$/.test(line)) {
          testRunError = true;
        }
      });

      try {
        const cleanExit = await task.finished;
        testRunError = testRunError || cleanExit === false;

        // Ensure all events are done before ending the test run
        await task.eventsDone;

        if (testRunError) {
          for (const test of testsById.values()) {
            run.errored(
              test,
              new vscode.TestMessage("Error during test execution")
            );
          }
        }
      } finally {
        run.end();
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

  return testController;
}

function createTestItems(
  testController: vscode.TestController,
  suite: ParsedTestSuite,
  collection: vscode.TestItemCollection
) {
  const tests: ParsedTestData[] = [];

  for (const [idx, parsedTest] of suite.tests.entries()) {
    const test = testController.createTestItem(
      parsedTest.fullTitle,
      parsedTest.title,
      parsedTest.file ? vscode.Uri.file(parsedTest.file) : undefined
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
      parsedSuite.file ? vscode.Uri.file(parsedSuite.file) : undefined
    );
    // Suites run after tests, so sort accordingly
    testSuite.sortText = `b${idx}`;

    if (parsedSuite.range) {
      testSuite.range = parsedSuite.range;
    }

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
  const testSuites = await ExtensionState.runOperation(
    ExtensionOperation.LOAD_TESTS,
    () => getElectronTests(context, electronRoot, token),
    ExtensionState.isOperationRunning(ExtensionOperation.LOAD_TESTS)
  );

  // CancellationToken may have been used
  if (testSuites) {
    createTestItems(testController, testSuites, testController.items);
  }
}

// TODO - Determine why Electron doesn't exit on task terminate
async function getElectronTests(
  context: vscode.ExtensionContext,
  electronRoot: vscode.Uri,
  token?: vscode.CancellationToken,
  files?: vscode.Uri[]
): Promise<ParsedTestSuite | void> {
  if (!files) {
    files = await vscode.workspace.findFiles(
      new vscode.RelativePattern(electronRoot, `spec/**/*-spec.{js,ts}`),
      "**/node_modules/**"
    );
  }

  // This does things like install modules if they haven't been installed yet
  await setupSpecRunner(electronRoot.fsPath);

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
        ELECTRON_ROOT: electronRoot.fsPath,
      },
    })
  );
  task.presentationOptions = {
    reveal: vscode.TaskRevealKind.Silent,
    echo: false,
    clear: true,
  };

  return new Promise<ParsedTestSuite | void>(async (resolve, reject) => {
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
            resolve();
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
