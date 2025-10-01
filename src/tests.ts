import * as net from "node:net";
import * as os from "node:os";

import { ElectronVersions, SemVer } from "@electron/fiddle-core";
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
}

interface MochaTestFailEvent extends MochaTestEvent {
  error: {
    message: string;
    actual?: string;
    expected?: string;
  };
  stack: string;
}

type MochaEvent =
  | ["pass", MochaTestEvent]
  | ["fail", MochaTestFailEvent]
  | ["pending", MochaTestEvent]
  | ["test-start", MochaTestEvent];

enum DebugMode {
  JS,
  NATIVE_AND_JS,
}

const FilterReleasesQuickInputButton: vscode.QuickInputButton = {
  iconPath: new vscode.ThemeIcon("filter"),
  tooltip: "Filter",
};

const FilteredReleasesQuickInputButton: vscode.QuickInputButton = {
  iconPath: new vscode.ThemeIcon("filter-filled"),
  tooltip: "Filter",
};

const RefreshReleasesQuickInputButton: vscode.QuickInputButton = {
  iconPath: new vscode.ThemeIcon("refresh"),
  tooltip: "Refresh",
};

export async function createTestController(
  context: vscode.ExtensionContext,
  electronRoot: vscode.Uri,
) {
  const electronVersions = await ElectronVersions.create();
  const runProfileData = new WeakMap<vscode.TestRunProfile, string>();

  const testController = vscode.tests.createTestController(
    "electron-build-tools-tests",
    "Electron Tests",
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

  async function runTests(
    request: vscode.TestRunRequest,
    token: vscode.CancellationToken,
    options: { debug?: DebugMode; version?: string } = {},
  ) {
    const extraArgs = request.profile
      ? runProfileData.get(request.profile)
      : undefined;
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

    let testsToAdd:
      | vscode.TestItemCollection
      | readonly vscode.TestItem[]
      | undefined;

    if (!request.include?.length) {
      if (request.exclude?.length) {
        // If no request.include, include all top-level tests which aren't excluded
        testsToAdd = testController.items;
      } else {
        // No includes or excludes, add all tests, but no regexes
        testController.items.forEach((test) => addTests(test));
      }
    } else {
      testsToAdd = request.include;
    }

    testsToAdd?.forEach((test) => {
      if (!request.exclude?.includes(test)) {
        addTests(test);
        testRegexes.push(escapeStringForRegex(test.id));
      } else {
        testsById.delete(test.id);
      }
    });

    const processIdFilename = vscode.Uri.joinPath(
      context.storageUri!,
      ".native-test-debugging-process-id",
    );

    const env: Record<string, string> = {
      MOCHA_REPORTER: "mocha-multi-reporters",
      MOCHA_MULTI_REPORTERS: `${context.asAbsolutePath(
        "out/electron/mocha-reporter.js",
      )}, spec`,
      ELECTRON_ROOT: electronRoot.fsPath,
    };
    let command = `${buildToolsExecutable} test --runners=main`;

    if (testRegexes.length) {
      command += ` -g "${testRegexes.join("|")}"`;
    }

    if (extraArgs) {
      command += ` ${extraArgs}`;
    }

    if (options.version) {
      command += ` --electronVersion=${options.version}`;
    }

    if (options.debug !== undefined) {
      command += ` --inspect-brk`;
    }

    if (options.debug === DebugMode.NATIVE_AND_JS) {
      command += ` --wait-for-debugger`;
      env.ELECTRON_TEST_PID_DUMP_PATH = processIdFilename.fsPath;
    }

    // Mark all tests we're about to run as enqueued
    for (const test of testsById.values()) {
      run.enqueued(test);
    }

    let testRunError: vscode.TestMessage | undefined;

    const task = runAsTask({
      context,
      operationName: "Electron Build Tools - Running Test(s)",
      taskName: "test",
      command,
      cancellationToken: token,
      shellOptions: {
        cwd: electronRoot.fsPath,
        env,
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
        const [eventName, details] = data as MochaEvent;
        const test = testsById.get(details.fullTitle);

        if (test) {
          if (eventName === "pass") {
            testsById.delete(details.fullTitle);
            run.passed(test, details.duration);
          } else if (eventName === "fail") {
            testsById.delete(details.fullTitle);

            let testMessage: vscode.TestMessage;

            if (details.error) {
              testMessage = new vscode.TestMessage(details.error.message);
              testMessage.actualOutput = details.error.actual;
              testMessage.expectedOutput = details.error.expected;
            } else {
              testMessage = new vscode.TestMessage(
                "Couldn't parse failure output",
              );
            }

            // Pull file position details if they're available
            if (test.uri && details.error && details.stack) {
              const failureDetails = /^.*\((.*):(\d+):(\d+)\)\s*$/m.exec(
                details.stack,
              );

              if (
                failureDetails &&
                test.uri.fsPath.endsWith(failureDetails[1])
              ) {
                testMessage.location = new vscode.Location(
                  test.uri,
                  new vscode.Position(
                    parseInt(failureDetails[2]) - 1,
                    parseInt(failureDetails[3]) - 1,
                  ),
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
        testRunError = new vscode.TestMessage(
          "An error occurred while running the spec runner",
        );
      }
    });

    if (options.debug === DebugMode.NATIVE_AND_JS) {
      // Directory may not exist so create it first
      await vscode.workspace.fs.createDirectory(context.storageUri!);

      await vscode.workspace.fs.writeFile(
        processIdFilename,
        new TextEncoder().encode("0"),
      );

      // Watch for changes to the PID dump file so we know when
      // the Electron process is started and we can attach to it
      const watcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(
          context.storageUri!,
          ".native-test-debugging-process-id",
        ),
      );
      const processId = await new Promise<number>((resolve, reject) => {
        const timeoutId = setTimeout(reject, 10_000);

        watcher.onDidChange(async (uri) => {
          clearTimeout(timeoutId);
          watcher.dispose();

          resolve(
            parseInt((await vscode.workspace.fs.readFile(uri)).toString()),
          );
        });
      });

      const nativeDebuggingConfigurationType =
        os.platform() === "win32"
          ? "electron.cpp.windows"
          : os.platform() === "darwin"
            ? "electron.cpp.lldb"
            : "electron.cpp.gdb";
      const nativeDebuggingConfiguration =
        await context.extension.packageJSON.contributes.debuggers
          .find(
            ({ type }: { type: string }) =>
              type === nativeDebuggingConfigurationType,
          )
          ?.initialConfigurations.find(
            ({ request }: { request: string }) => request === "attach",
          );

      if (!nativeDebuggingConfiguration) {
        testRunError = new vscode.TestMessage(
          "Couldn't find native debugging configuration",
        );
        task.terminate();
        return;
      }

      const nativeDebuggingSession = await vscode.debug.startDebugging(
        undefined,
        {
          ...nativeDebuggingConfiguration,
          processId,
        },
        { testRun: run },
      );

      if (!nativeDebuggingSession) {
        testRunError = new vscode.TestMessage(
          "Couldn't start native debugging session",
        );
        task.terminate();
      }
    }

    if (testRunError === undefined && options.debug !== undefined) {
      const debuggingSession = await vscode.debug.startDebugging(
        undefined,
        {
          name: "Debug Electron",
          type: "node",
          request: "attach",
          port: 9229,
          // XXX: On macOS Chromium's --wait-for-debugger flag waits 60 seconds
          timeout: 61_000,
          continueOnAttach: true,
        },
        { testRun: run, parentSession: vscode.debug.activeDebugSession },
      );

      if (!debuggingSession) {
        testRunError = new vscode.TestMessage(
          "Couldn't start debugging session",
        );
        task.terminate();
      }
    }

    try {
      const cleanExit = await task.finished;

      if (cleanExit === false && !testRunError) {
        testRunError = new vscode.TestMessage("Error during test execution");
      }

      if (!testRunError) {
        // Ensure all events are done before ending the test run
        await task.eventsDone;
      }

      if (testRunError) {
        for (const test of testsById.values()) {
          run.errored(test, testRunError);
        }
      }
    } finally {
      run.end();
    }
  }

  const includeNightliesStateKey = "testPrebuiltElectron.includeNightlies";
  const includeAlphasStateKey = "testPrebuiltElectron.includeAlphas";
  const includeBetasStateKey = "testPrebuiltElectron.includeBetas";

  let includeNightlies =
    context.globalState.get<boolean>(includeNightliesStateKey) ?? false;
  let includeAlphas =
    context.globalState.get<boolean>(includeAlphasStateKey) ?? false;
  let includeBetas =
    context.globalState.get<boolean>(includeBetasStateKey) ?? false;

  async function showElectronVersionQuickPick() {
    const getVersions = async () => {
      const majors = [
        ...electronVersions.supportedMajors,
        ...electronVersions.prereleaseMajors,
      ];

      const versions: vscode.QuickPickItem[] = [...electronVersions.versions]
        .reverse()
        .filter((version) => {
          if (version.prerelease.length > 0) {
            return (
              (includeNightlies && version.prerelease[0] === "nightly") ||
              (includeAlphas && version.prerelease[0] === "alpha") ||
              (includeBetas && version.prerelease[0] === "beta")
            );
          }

          return true;
        })
        .map((version) => ({ label: `v${version}`, version }));

      // Add a separator after the last stable major version
      versions.splice(
        (versions as unknown as { version: SemVer }[]).findIndex(
          ({ version }) => !majors.includes(version.major),
        ),
        0,
        {
          label: "Unsupported Releases",
          kind: vscode.QuickPickItemKind.Separator,
        },
      );

      return versions;
    };

    const versions = await getVersions();

    return new Promise<string | undefined>((resolve) => {
      const title = "Electron Version";
      const placeholder = "Select an Electron version";

      const filtersApplied = includeNightlies || includeAlphas || includeBetas;

      const quickPick = vscode.window.createQuickPick();
      const setupEventListeners = () => {
        return vscode.Disposable.from(
          quickPick.onDidHide(() => {
            quickPick.dispose();
            resolve(undefined);
          }),
          quickPick.onDidAccept(() => {
            resolve(quickPick.selectedItems[0].label.slice(1));
            quickPick.dispose();
          }),
        );
      };
      quickPick.title = title;
      quickPick.placeholder = placeholder;
      quickPick.buttons = [
        RefreshReleasesQuickInputButton,
        filtersApplied
          ? FilteredReleasesQuickInputButton
          : FilterReleasesQuickInputButton,
      ];
      quickPick.items = versions;
      let eventListeners = setupEventListeners();
      quickPick.onDidTriggerButton(async (button) => {
        if (button === RefreshReleasesQuickInputButton) {
          quickPick.busy = true;
          quickPick.items = [];
          await electronVersions.fetch();
          quickPick.items = await getVersions();
          quickPick.busy = false;
        } else if (
          button === FilterReleasesQuickInputButton ||
          button === FilteredReleasesQuickInputButton
        ) {
          const includeNightliesLabel = "Include Nightlies";
          const includeAlphasLabel = "Include Alphas";
          const includeBetasLabel = "Include Betas";

          // Temporarily transform this quickpick into the filter quickpick
          quickPick.enabled = false;
          quickPick.busy = true;
          eventListeners.dispose();
          quickPick.buttons = [];
          quickPick.title = "Electron Version Filters";
          quickPick.placeholder = "Select Electron version filters";
          const items = [
            { label: includeNightliesLabel },
            { label: includeAlphasLabel },
            { label: includeBetasLabel },
          ];
          const selectedItems: vscode.QuickPickItem[] = [];
          if (includeNightlies) {
            selectedItems.push(
              items.find(({ label }) => label === includeNightliesLabel)!,
            );
          }
          if (includeAlphas) {
            selectedItems.push(
              items.find(({ label }) => label === includeAlphasLabel)!,
            );
          }
          if (includeBetas) {
            selectedItems.push(
              items.find(({ label }) => label === includeBetasLabel)!,
            );
          }
          quickPick.canSelectMany = true;
          quickPick.items = items;
          quickPick.selectedItems = selectedItems;
          quickPick.busy = false;
          quickPick.enabled = true;

          const filters = await new Promise<
            readonly vscode.QuickPickItem[] | undefined
          >((resolve) => {
            const eventListeners = vscode.Disposable.from(
              quickPick.onDidHide(() => {
                eventListeners.dispose();
                resolve(undefined);
              }),
              quickPick.onDidAccept(() => {
                quickPick.enabled = false;
                quickPick.busy = true;
                eventListeners.dispose();
                resolve(quickPick.selectedItems);
              }),
            );
          });

          if (filters) {
            includeNightlies =
              filters.find(
                (filter) => filter.label === includeNightliesLabel,
              ) !== undefined;
            includeAlphas =
              filters.find((filter) => filter.label === includeAlphasLabel) !==
              undefined;
            includeBetas =
              filters.find((filter) => filter.label === includeBetasLabel) !==
              undefined;

            await Promise.all([
              context.globalState.update(
                includeNightliesStateKey,
                includeNightlies,
              ),
              context.globalState.update(includeAlphasStateKey, includeAlphas),
              context.globalState.update(includeBetasStateKey, includeBetas),
            ]);

            //
            // Restore the original quickpick
            //
            // NOTE - We have to hide and show it again otherwise
            // changing `canSelectMany` will make it disappear
            quickPick.hide();
            quickPick.selectedItems = [];
            quickPick.items = [];
            quickPick.canSelectMany = false;
            quickPick.title = title;
            quickPick.placeholder = placeholder;
            quickPick.items = await getVersions();
            quickPick.buttons = [
              RefreshReleasesQuickInputButton,
              filters.length > 0
                ? FilteredReleasesQuickInputButton
                : FilterReleasesQuickInputButton,
            ];
            quickPick.busy = false;
            quickPick.enabled = true;
            // Only restore the event listeners after the change takes effect
            const eventListener = quickPick.onDidChangeActive(() => {
              eventListener.dispose();
              eventListeners = setupEventListeners();
            });
            quickPick.show();
          } else {
            // User cancelled the filter quickpick
            resolve(undefined);
            quickPick.dispose();
          }
        }
      });
      quickPick.show();
    });
  }

  const profiles = [
    testController.createRunProfile(
      "Run",
      vscode.TestRunProfileKind.Run,
      async (request, token) => {
        return ExtensionState.runOperation(
          ExtensionOperation.RUN_TESTS,
          () => runTests(request, token),
          ExtensionState.isOperationRunning(ExtensionOperation.RUN_TESTS),
        );
      },
      true,
    ),
    testController.createRunProfile(
      "Run (Prebuilt)",
      vscode.TestRunProfileKind.Run,
      async (request, token) => {
        const version = await showElectronVersionQuickPick();

        if (!version) {
          return;
        }

        return ExtensionState.runOperation(
          ExtensionOperation.RUN_TESTS,
          () => runTests(request, token, { version }),
          ExtensionState.isOperationRunning(ExtensionOperation.RUN_TESTS),
        );
      },
      false,
    ),
    testController.createRunProfile(
      "Debug",
      vscode.TestRunProfileKind.Debug,
      async (request, token) => {
        return ExtensionState.runOperation(
          ExtensionOperation.RUN_TESTS,
          () => runTests(request, token, { debug: DebugMode.JS }),
          ExtensionState.isOperationRunning(ExtensionOperation.RUN_TESTS),
        );
      },
      false,
    ),
    testController.createRunProfile(
      "Debug (Prebuilt)",
      vscode.TestRunProfileKind.Debug,
      async (request, token) => {
        const version = await showElectronVersionQuickPick();

        if (!version) {
          return;
        }

        return ExtensionState.runOperation(
          ExtensionOperation.RUN_TESTS,
          () => runTests(request, token, { debug: DebugMode.JS, version }),
          ExtensionState.isOperationRunning(ExtensionOperation.RUN_TESTS),
        );
      },
      false,
    ),
    testController.createRunProfile(
      "Debug (C++ and JS)",
      vscode.TestRunProfileKind.Debug,
      async (request, token) => {
        if (!vscode.extensions.getExtension("ms-vscode.cpptools")) {
          vscode.window.showErrorMessage(
            "Please install the 'ms-vscode.cpptools' extension to enable native debugging",
          );
          return;
        }

        const specRunnerContents = await vscode.workspace.fs.readFile(
          vscode.Uri.joinPath(electronRoot, "script", "spec-runner.js"),
        );

        if (
          !specRunnerContents.toString().includes("ELECTRON_TEST_PID_DUMP_PATH")
        ) {
          vscode.window.showErrorMessage(
            "This Electron checkout does not support native debugging - see https://github.com/electron/electron/pull/45481",
          );
          return;
        }

        return ExtensionState.runOperation(
          ExtensionOperation.RUN_TESTS,
          () => runTests(request, token, { debug: DebugMode.NATIVE_AND_JS }),
          ExtensionState.isOperationRunning(ExtensionOperation.RUN_TESTS),
        );
      },
      false,
    ),
  ];

  for (const profile of profiles) {
    profile.configureHandler = async () => {
      const extraArgs = await vscode.window.showInputBox({
        title: "Electron Test Runner",
        placeHolder: "Extra args to pass to the test runner",
        value: runProfileData.get(profile),
      });

      if (extraArgs === "") {
        runProfileData.delete(profile);
      } else if (extraArgs) {
        runProfileData.set(profile, extraArgs);
      }
    };
  }

  return testController;
}

function createTestItems(
  testController: vscode.TestController,
  suite: ParsedTestSuite,
  collection: vscode.TestItemCollection,
) {
  const tests: ParsedTestData[] = [];

  for (const [idx, parsedTest] of suite.tests.entries()) {
    const test = testController.createTestItem(
      parsedTest.fullTitle,
      parsedTest.title,
      parsedTest.file ? vscode.Uri.file(parsedTest.file) : undefined,
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
      parsedSuite.file ? vscode.Uri.file(parsedSuite.file) : undefined,
    );
    // Suites run after tests, so sort accordingly
    testSuite.sortText = `b${idx}`;

    if (parsedSuite.range) {
      testSuite.range = parsedSuite.range;
    }

    collection.add(testSuite);

    tests.push(
      ...createTestItems(testController, parsedSuite, testSuite.children),
    );
  }

  return tests;
}

async function discoverTests(
  context: vscode.ExtensionContext,
  electronRoot: vscode.Uri,
  testController: vscode.TestController,
  token?: vscode.CancellationToken,
) {
  const testSuites = await ExtensionState.runOperation(
    ExtensionOperation.LOAD_TESTS,
    () => getElectronTests(context, electronRoot, token),
    ExtensionState.isOperationRunning(ExtensionOperation.LOAD_TESTS),
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
  files?: vscode.Uri[],
): Promise<ParsedTestSuite | void> {
  if (!files) {
    files = await vscode.workspace.findFiles(
      new vscode.RelativePattern(electronRoot, `spec/**/*-spec.{js,ts}`),
      "{**/node_modules/**,**/spec/fixtures/**}",
    );
  }

  const depotToolsDir = await vscode.commands.executeCommand<string>(
    `${commandPrefix}.show.depotdir`,
  );

  // This does things like install modules if they haven't been installed yet
  await setupSpecRunner(electronRoot.fsPath, depotToolsDir);

  const electronExe = await vscode.commands.executeCommand<string>(
    `${commandPrefix}.show.exec`,
  );
  const scriptName = context.asAbsolutePath("out/electron/listMochaTests.js");
  const tsNodeCompiler = context.asAbsolutePath(
    "out/electron/electron-build-tools-typescript.js",
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
            ([key]) => !key.startsWith("ELECTRON_"),
          ),
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
    }),
  );
  task.presentationOptions = {
    reveal: vscode.TaskRevealKind.Silent,
    echo: false,
    clear: true,
  };

  // eslint-disable-next-line no-async-promise-executor
  return new Promise<ParsedTestSuite | void>(async (resolve, reject) => {
    let result = "";

    const socketServer = net.createServer().listen(socketName);
    const socketClosedPromise = new Promise<void>((resolve, reject) => {
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
          try {
            resolve(JSON.parse(result));
          } catch (err) {
            reject(err);
          }
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
            if (exitCode === 0) {
              try {
                resolve(JSON.parse(result));
              } catch (err) {
                reject(err);
              }
            } else {
              reject(
                new Error(`Error discovering tests - exit code ${exitCode}`),
              );
            }
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
