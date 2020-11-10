import * as vscode from "vscode";
import { EventEmitter, ThemeIcon, TreeItem, TreeDataProvider } from "vscode";

import {
  alphabetizeByLabel,
  getElectronTests,
  truncateToLength,
  TestRunner,
  withBusyState,
} from "../utils";

export enum TestState {
  NONE,
  RUNNING,
  SUCCESS,
  FAILURE,
}

type ParsedTestSuite = {
  title: string;
  file: string;
  suites: ParsedTestSuite[];
  tests: string[];
};

export type Test = {
  runner: TestRunner;
  test: string;
};

function findFullPathForTest(
  suite: ParsedTestSuite,
  filename: vscode.Uri,
  test: string
): string[][] {
  const matches: string[][] = [];

  if (!suite.file || suite.file === filename.fsPath) {
    if (suite.tests.includes(test)) {
      for (const suiteTest of suite.tests) {
        if (suiteTest === test) {
          matches.push([suite.title, test]);
        }
      }
    }
    for (const nestedSuite of suite.suites) {
      const results = findFullPathForTest(nestedSuite, filename, test);
      for (const result of results) {
        matches.push([suite.title, ...result]);
      }
    }
  }

  return matches;
}

// TODO - When adding a code lens this is now pretty overloaded, pull out
// the test listing logic so it's not all tied up in here
export class TestsTreeDataProvider implements TreeDataProvider<TreeItem> {
  private _onDidChangeTreeData = new EventEmitter<
    TreeItem | undefined | void
  >();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
  private readonly mainProcessRunner: TestRunnerTreeItem;
  private readonly rendererRunner: TestRunnerTreeItem;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly electronRoot: vscode.Uri
  ) {
    this.mainProcessRunner = new TestRunnerTreeItem(
      "Main Process",
      new ThemeIcon("device-desktop~spin"),
      TestRunner.MAIN
    );
    this.rendererRunner = new TestRunnerTreeItem(
      "Renderer",
      new ThemeIcon("browser"),
      TestRunner.REMOTE
    );
  }

  // TODO - This doesn't work great since test names often aren't unique, so making sure
  // it is matching the exact test is tricky, but it's also tricky to get suite names
  // using regexes
  findTestFullyQualifiedName(
    filename: vscode.Uri,
    test: string
  ): Test | undefined {
    if (this.mainProcessRunner.suite) {
      const testPaths = findFullPathForTest(
        this.mainProcessRunner.suite,
        filename,
        test
      );

      if (testPaths.length === 1) {
        return {
          runner: this.mainProcessRunner.runner,
          test: testPaths[0].join(" ").trim(),
        };
      }
    }
    if (this.rendererRunner.suite) {
      const testPaths = findFullPathForTest(
        this.rendererRunner.suite,
        filename,
        test
      );

      if (testPaths.length === 1) {
        return {
          runner: this.rendererRunner.runner,
          test: testPaths[0].join(" ").trim(),
        };
      }
    }
  }

  refresh(data: void | vscode.TreeItem | undefined): void {
    this._onDidChangeTreeData.fire(data);
  }

  getTreeItem(element: TreeItem): TreeItem {
    return element;
  }

  async getChildren(element?: TreeItem): Promise<TreeItem[]> {
    if (!element) {
      return [this.mainProcessRunner, this.rendererRunner];
    } else if (element instanceof TestSuiteTreeItem) {
      return [
        ...alphabetizeByLabel(
          element.suite.suites.map(
            (suite) => new TestSuiteTreeItem(suite, element.runner, element)
          )
        ),
        ...alphabetizeByLabel(
          element.suite.tests.map(
            (test) => new TestTreeItem(test, element.runner, element)
          )
        ),
      ];
    } else if (element instanceof TestRunnerTreeItem) {
      try {
        const tests = await withBusyState(() => {
          return getElectronTests(
            this.context,
            this.electronRoot,
            element.runner
          ) as Promise<ParsedTestSuite>;
        }, "loadingTests");

        element.suite = tests;

        return alphabetizeByLabel(
          tests.suites.map(
            (suite) => new TestSuiteTreeItem(suite, element.runner)
          )
        );
      } catch (err) {
        console.error(err);
        vscode.window.showErrorMessage("Couldn't load Electron test info");

        const errorTreeItem = new TreeItem("Couldn't load tests");
        errorTreeItem.iconPath = new ThemeIcon("warning");

        return [errorTreeItem];
      }
    }

    return [];
  }
}

export class TestBaseTreeItem extends TreeItem {
  public readonly parent?: TestBaseTreeItem;

  constructor(
    public readonly uri: vscode.Uri,
    public readonly label: string,
    public readonly runner: TestRunner,
    public readonly fullName: string,
    public readonly collapsibleState?: vscode.TreeItemCollapsibleState
  ) {
    super(label, collapsibleState);
  }

  getFullyQualifiedTestName() {
    let fullName = this.fullName;
    let parent: TestBaseTreeItem | undefined = this.parent;

    while (parent) {
      fullName = `${parent.fullName} ${fullName}`;
      parent = parent.parent;
    }

    return fullName;
  }

  setState(state: TestState) {
    // TODO - Color is disabled because it's buggy as heck in VS Code 1.51.0
    if (state === TestState.RUNNING) {
      this.iconPath = new ThemeIcon("loading");
    } else if (state === TestState.SUCCESS) {
      this.iconPath = new ThemeIcon(
        "check"
        // new vscode.ThemeColor("debugIcon.startForeground")
      );
    } else if (state === TestState.FAILURE) {
      this.iconPath = new ThemeIcon(
        "error"
        // new vscode.ThemeColor("debugIcon.stopForeground")
      );
    }
  }
}

export class TestRunnerTreeItem extends TreeItem {
  public suite?: ParsedTestSuite;

  constructor(
    public readonly label: string,
    public iconPath: ThemeIcon,
    public readonly runner: TestRunner
  ) {
    super(label, vscode.TreeItemCollapsibleState.Collapsed);

    this.contextValue = "runner";
  }
}

class TestSuiteTreeItem extends TestBaseTreeItem {
  constructor(
    public readonly suite: ParsedTestSuite,
    public readonly runner: TestRunner,
    public readonly parent?: TestSuiteTreeItem
  ) {
    super(
      vscode.Uri.file(suite.file),
      suite.title,
      runner,
      suite.title,
      vscode.TreeItemCollapsibleState.Collapsed
    );

    this.setState(TestState.NONE);
    this.contextValue = "suite";
    // this.resourceUri = vscode.Uri.file(suite.file);
  }

  setState(state: TestState) {
    if (state === TestState.NONE) {
      this.iconPath = new ThemeIcon("library");
    } else {
      super.setState(state);
    }
  }
}

class TestTreeItem extends TestBaseTreeItem {
  constructor(
    public readonly testName: string,
    public readonly runner: TestRunner,
    public readonly parent: TestSuiteTreeItem
  ) {
    super(
      vscode.Uri.file(parent.suite.file),
      truncateToLength(testName, 40),
      runner,
      testName,
      vscode.TreeItemCollapsibleState.None
    );

    this.setState(TestState.NONE);
    this.tooltip = testName;
    this.contextValue = "test";
  }

  setState(state: TestState) {
    if (state === TestState.NONE) {
      this.iconPath = new ThemeIcon("code");
    } else {
      super.setState(state);
    }
  }
}
