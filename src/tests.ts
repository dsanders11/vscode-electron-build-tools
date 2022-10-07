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

  const runProfile = testController.createRunProfile(
    "Run",
    vscode.TestRunProfileKind.Run,
    async (request, token) => {
      const extraArgs = runProfileData.get(runProfile);
      const run = testController.createTestRun(request);

      const testRegexes: string[] = [];
      const testsById = new Map<string, vscode.TestItem>();

      // To process test results we need a map of all test IDs to the
      // corresponding TestItem. Would be great if `testController.items.get`
      // had an option to do a deep get in all children, but it doesn't.
      // We'll also used testsById to track which tests were skipped, since
      // Mocha's json-stream reporter provides no output on skipped tests.
      function addTests(testItem: vscode.TestItem) {
        testsById.set(testItem.id, testItem);
        testItem.children.forEach(addTests);
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

      // Mark all tests we're about to run as started
      for (const test of testsById.values()) {
        run.started(test);
      }

      const task = runAsTask({
        context,
        operationName: "Electron Build Tools - Running Test(s)",
        taskName: "test",
        command,
        cancellationToken: token,
        shellOptions: {
          env: {
            MOCHA_REPORTER: "json-stream",
          },
        },
        // Ignore non-zero exit codes, there's no way to
        // distinguish from normal test failures
        suppressExitCode: true,
      });

      task.onDidWriteLine(({ line }) => {
        run.appendOutput(`${line}\r\n`);

        // Looks like a JSON stream event
        if (/^\[("pass"|"fail"|"pending"),\{.*\}\]$/.test(line)) {
          const [result, details]: [string, MochaTestResult] = JSON.parse(line);
          const test = testsById.get(details.fullTitle);

          if (test) {
            // There is only one result per test, delete so we can find skips
            testsById.delete(details.fullTitle);

            if (result === "pass") {
              run.passed(test, details.duration);
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

              run.failed(test, testMessage, details.duration);
            }
          }
        }
      });

      try {
        await task.finished;

        for (const test of testsById.values()) {
          run.skipped(test);
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
