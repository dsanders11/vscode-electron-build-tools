import * as path from "path";

import * as vscode from "vscode";

import { buildToolsExecutable } from "../constants";
import { runAsTask } from "../tasks";
import {
  escapeStringForRegex,
  registerCommandNoBusy,
  withBusyState,
} from "../utils";
import {
  Test,
  TestBaseTreeItem,
  TestRunnerTreeItem,
  TestState,
  TestsTreeDataProvider,
} from "../views/tests";

export function registerTestCommands(
  context: vscode.ExtensionContext,
  electronRoot: vscode.Uri,
  testsProvider: TestsTreeDataProvider
) {
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "electron-build-tools.openTestFile",
      (testOrSuite: TestBaseTreeItem) => {
        return vscode.commands.executeCommand("vscode.open", testOrSuite.uri);
      }
    ),
    vscode.commands.registerCommand("electron-build-tools.refreshTests", () => {
      withBusyState(() => {
        testsProvider.refresh();
      }, "loadingTests");
    }),
    registerCommandNoBusy(
      "electron-build-tools.runTest",
      () => {
        vscode.window.showErrorMessage(
          "Can't run test, other work in-progress"
        );
      },
      async (test: TestBaseTreeItem | Test) => {
        return withBusyState(async () => {
          const operationName = "Electron Build Tools - Running Test";
          let command = `${buildToolsExecutable} test`;
          let task;

          // TODO - Need to sanity check output to make sure tests ran
          // and there wasn't a regex problem causing 0 tests to be run

          // TODO - Fix this up
          if (test instanceof TestBaseTreeItem) {
            const testRegex = escapeStringForRegex(
              test.getFullyQualifiedTestName()
            );

            task = runAsTask(
              context,
              operationName,
              "test",
              `${command} --runners=${test.runner.toString()} -g "${testRegex}"`,
              undefined,
              "$mocha",
              (exitCode) => {
                test.setState(
                  exitCode === 0 ? TestState.SUCCESS : TestState.FAILURE
                );
                testsProvider.refresh(test);

                return false;
              }
            );

            test.setState(TestState.RUNNING);
            testsProvider.refresh(test);
          } else {
            const testRegex = escapeStringForRegex(test.test);

            task = runAsTask(
              context,
              operationName,
              "test",
              `${command} --runners=${test.runner.toString()} -g "${testRegex}"`,
              undefined,
              "$mocha"
            );
          }

          await task.finished;
        });
      }
    ),
    registerCommandNoBusy(
      "electron-build-tools.runTestFile",
      () => {
        vscode.window.showErrorMessage(
          "Can't run tests, other work in-progress"
        );
      },
      (file: vscode.Uri) => {
        return withBusyState(async () => {
          const operationName = "Electron Build Tools - Running Tests";
          const command = `${buildToolsExecutable} test`;

          let runner: string | undefined;

          if (file.path.includes("electron/spec/")) {
            runner = "remote";
          } else if (file.path.includes("electron/spec-main/")) {
            runner = "main";
          }

          // Test runner expects filenames as relative to the root, not absolute
          const relativeFilePath = path.relative(
            electronRoot.fsPath,
            file.fsPath
          );

          // TODO - Fix this up
          runAsTask(
            context,
            operationName,
            "test",
            `${command} --runners=${runner} --files ${relativeFilePath}"`,
            undefined,
            "$mocha"
          );
        });
      }
    ),
    registerCommandNoBusy(
      "electron-build-tools.runTestRunner",
      () => {
        vscode.window.showErrorMessage(
          "Can't run tests, other work in-progress"
        );
      },
      async (testRunner: TestRunnerTreeItem) => {
        const operationName = "Electron Build Tools - Running Tests";
        let command = `${buildToolsExecutable} test`;

        // TODO - Fix this up
        runAsTask(
          context,
          operationName,
          "test",
          `${command} --runners=${testRunner.runner.toString()}"`,
          undefined,
          "$mocha"
        );
      }
    ),
    registerCommandNoBusy(
      "electron-build-tools.runTestSuite",
      () => {
        vscode.window.showErrorMessage(
          "Can't run tests, other work in-progress"
        );
      },
      async (testSuite: TestBaseTreeItem) => {
        const operationName = "Electron Build Tools - Running Tests";
        let command = `${buildToolsExecutable} test`;

        const testRegex = escapeStringForRegex(
          testSuite.getFullyQualifiedTestName()
        );

        // TODO - Fix this up
        runAsTask(
          context,
          operationName,
          "test",
          `${command} --runners=${testSuite.runner.toString()} -g "${testRegex}"`,
          undefined,
          "$mocha",
          (exitCode) => {
            testSuite.setState(
              exitCode === 0 ? TestState.SUCCESS : TestState.FAILURE
            );
            testsProvider.refresh(testSuite);

            return false;
          }
        );

        testSuite.setState(TestState.RUNNING);
        testsProvider.refresh(testSuite);
      }
    ),
    vscode.commands.registerCommand(
      "electron-build-tools.showTestsDocs",
      () => {
        vscode.commands.executeCommand(
          "markdown.showPreview",
          vscode.Uri.joinPath(electronRoot, "docs", "development", "testing.md")
        );
      }
    ),
    vscode.commands.registerCommand("electron-build-tools.test", async () => {
      const operationName = "Electron Build Tools - Running Tests";
      let command = `${buildToolsExecutable} test`;

      const runnerOptions: vscode.QuickPickItem[] = [
        {
          label: "main",
          picked: true,
        },
        {
          label: "native",
          picked: true,
        },
        {
          label: "remote",
          picked: true,
        },
      ];

      const runners = await vscode.window.showQuickPick(runnerOptions, {
        placeHolder: "Choose runners to use",
        canPickMany: true,
      });
      const extraArgs = await vscode.window.showInputBox({
        placeHolder: "Extra args to pass to the test runner",
      });

      if (runners && extraArgs) {
        if (runners.length > 0) {
          command = `${command} --runners=${runners
            .map((runner) => runner.label)
            .join(",")}`;
        }

        runAsTask(
          context,
          operationName,
          "test",
          `${command} ${extraArgs}`,
          undefined,
          "$mocha"
        );
      }
    })
  );
}
