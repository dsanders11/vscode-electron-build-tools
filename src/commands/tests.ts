import * as path from "path";

import * as vscode from "vscode";

import { Test } from "../common";
import { buildToolsExecutable, commandPrefix } from "../constants";
import {
  default as ExtensionState,
  ExtensionOperation,
} from "../extensionState";
import { ElectronBuildToolsTask, runAsTask } from "../tasks";
import { escapeStringForRegex } from "../utils";
import {
  TestBaseTreeItem,
  TestCollector,
  TestRunnerTreeItem,
  TestState,
  TestsTreeDataProvider,
  TestTreeItem,
} from "../views/tests";

export function registerTestCommands(
  context: vscode.ExtensionContext,
  electronRoot: vscode.Uri,
  testsProvider: TestsTreeDataProvider,
  testsCollector: TestCollector
) {
  context.subscriptions.push(
    vscode.commands.registerCommand(
      `${commandPrefix}.openTestFile`,
      async (testOrSuite: TestBaseTreeItem) => {
        let range: vscode.Range | undefined;

        if (testOrSuite instanceof TestTreeItem) {
          const test = testOrSuite.test;

          if (test.range !== null) {
            const { start, end } = test.range;

            range = new vscode.Range(
              start.line,
              start.character,
              end.line,
              end.character
            );
          }
        }

        const textEditor = await vscode.window.showTextDocument(
          testOrSuite.uri
        );

        if (range !== undefined) {
          textEditor.revealRange(range, vscode.TextEditorRevealType.InCenter);
        }

        return textEditor;
      }
    ),
    ExtensionState.registerExtensionOperationCommand(
      ExtensionOperation.LOAD_TESTS,
      `${commandPrefix}.refreshTests`,
      () => {
        vscode.window.showErrorMessage(
          "Can't refresh tests, other work in-progress"
        );
      },
      () => testsCollector.refreshTestSuites()
    ),
    ExtensionState.registerExtensionOperationCommand(
      ExtensionOperation.RUN_TESTS,
      `${commandPrefix}.runTest`,
      () => {
        vscode.window.showErrorMessage(
          "Can't run test, other work in-progress"
        );
      },
      async (test: TestBaseTreeItem | Test) => {
        const operationName = "Electron Build Tools - Running Test";
        let command = `${buildToolsExecutable} test`;
        let task: ElectronBuildToolsTask;

        // TODO - Need to sanity check output to make sure tests ran
        // and there wasn't a regex problem causing 0 tests to be run

        // TODO - Fix this up
        if (test instanceof TestBaseTreeItem) {
          const testRegex = escapeStringForRegex(test.getFullTitle());

          task = runAsTask({
            context,
            operationName,
            taskName: "test",
            command: `${command} --runners=${test.runner.toString()} -g "${testRegex}"`,
            problemMatchers: "$mocha",
            exitCodeHandler: (exitCode) => {
              test.setState(
                exitCode === 0 ? TestState.SUCCESS : TestState.FAILURE
              );
              testsProvider.refresh(test);

              return false;
            },
          });

          test.setState(TestState.RUNNING);
          testsProvider.refresh(test);
        } else {
          const testRegex = escapeStringForRegex(test.test);

          task = runAsTask({
            context,
            operationName,
            taskName: "test",
            command: `${command} --runners=${test.runner.toString()} -g "${testRegex}"`,
            problemMatchers: "$mocha",
          });
        }

        await task.finished;
      }
    ),
    ExtensionState.registerExtensionOperationCommand(
      ExtensionOperation.RUN_TESTS,
      `${commandPrefix}.runTestFile`,
      () => {
        vscode.window.showErrorMessage(
          "Can't run tests, other work in-progress"
        );
      },
      async (file: vscode.Uri) => {
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
        await runAsTask({
          context,
          operationName,
          taskName: "test",
          command: `${command} --runners=${runner} --files ${relativeFilePath}"`,
          problemMatchers: "$mocha",
        }).finished;
      }
    ),
    ExtensionState.registerExtensionOperationCommand(
      ExtensionOperation.RUN_TESTS,
      `${commandPrefix}.runTestRunner`,
      () => {
        vscode.window.showErrorMessage(
          "Can't run tests, other work in-progress"
        );
      },
      async (testRunner: TestRunnerTreeItem) => {
        const operationName = "Electron Build Tools - Running Tests";
        let command = `${buildToolsExecutable} test`;

        // TODO - Fix this up
        await runAsTask({
          context,
          operationName,
          taskName: "test",
          command: `${command} --runners=${testRunner.runner.toString()}"`,
          problemMatchers: "$mocha",
        }).finished;
      }
    ),
    ExtensionState.registerExtensionOperationCommand(
      ExtensionOperation.RUN_TESTS,
      `${commandPrefix}.runTestSuite`,
      () => {
        vscode.window.showErrorMessage(
          "Can't run tests, other work in-progress"
        );
      },
      async (testSuite: TestBaseTreeItem) => {
        const operationName = "Electron Build Tools - Running Tests";
        let command = `${buildToolsExecutable} test`;

        const testRegex = escapeStringForRegex(testSuite.getFullTitle());

        // TODO - Fix this up
        const task = runAsTask({
          context,
          operationName,
          taskName: "test",
          command: `${command} --runners=${testSuite.runner.toString()} -g "${testRegex}"`,
          problemMatchers: "$mocha",
          exitCodeHandler: (exitCode) => {
            testSuite.setState(
              exitCode === 0 ? TestState.SUCCESS : TestState.FAILURE
            );
            testsProvider.refresh(testSuite);

            return false;
          },
        });

        testSuite.setState(TestState.RUNNING);
        testsProvider.refresh(testSuite);
        await task.finished;
      }
    ),
    vscode.commands.registerCommand(`${commandPrefix}.showTestsDocs`, () => {
      return vscode.commands.executeCommand(
        "markdown.showPreview",
        vscode.Uri.joinPath(electronRoot, "docs", "development", "testing.md")
      );
    }),
    ExtensionState.registerExtensionOperationCommand(
      ExtensionOperation.RUN_TESTS,
      `${commandPrefix}.test`,
      () => {
        vscode.window.showErrorMessage(
          "Can't run tests, other work in-progress"
        );
      },
      async () => {
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

          runAsTask({
            context,
            operationName,
            taskName: "test",
            command: `${command} ${extraArgs}`,
            problemMatchers: "$mocha",
          });
        }
      }
    )
  );
}
