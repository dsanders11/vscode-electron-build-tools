import * as path from "path";

import * as vscode from "vscode";
import { EventEmitter, ThemeIcon, TreeItem, TreeDataProvider } from "vscode";

import {
  default as ExtensionState,
  ExtensionOperation,
} from "../extensionState";
import { ParsedTest, ParsedTestSuite, Test, TestRunner } from "../common";
import {
  alphabetizeByLabel,
  getElectronTests,
  truncateToLength,
} from "../utils";

export enum TestState {
  NONE,
  RUNNING,
  SUCCESS,
  FAILURE,
}

function findFullPathForTest(
  suite: ParsedTestSuite,
  filename: vscode.Uri,
  test: string
): string[][] {
  const matches: string[][] = [];

  if (!suite.file || suite.file === filename.fsPath) {
    for (const { title } of suite.tests) {
      if (title === test) {
        matches.push([suite.title, test]);
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

export interface OnDidStartRefreshing {
  runner: TestRunner;
  refreshFinished: Promise<void>;
}

interface StoredTests {
  version: number;
  tests: [TestRunner, ParsedTestSuite][];
}

export interface TestCollector {
  onDidStartRefreshing: vscode.Event<OnDidStartRefreshing>;

  refreshTestSuites(): Promise<void>;
  getTestSuites(runner: TestRunner): Promise<ParsedTestSuite>;
  getTestsForUri(
    uri: vscode.Uri
  ): Promise<{ runner: TestRunner; tests: ParsedTest[] }>;
}

export class ElectronTestCollector implements TestCollector {
  private static readonly storedTestsVersion = 3;
  private static readonly storageKey = "cachedTests";

  private _onDidStartRefreshing = new EventEmitter<OnDidStartRefreshing>();
  readonly onDidStartRefreshing = this._onDidStartRefreshing.event;

  private readonly _testSuites: Map<TestRunner, ParsedTestSuite>;
  private readonly _initialRefreshDone = new Map<TestRunner, boolean>([
    [TestRunner.MAIN, false],
    [TestRunner.REMOTE, false],
  ]);

  constructor(
    private readonly _extensionContext: vscode.ExtensionContext,
    private readonly _electronRoot: vscode.Uri
  ) {
    let storedTests = _extensionContext.globalState.get<StoredTests>(
      ElectronTestCollector.storageKey
    );

    if (
      storedTests &&
      storedTests.version !== ElectronTestCollector.storedTestsVersion
    ) {
      // Out-of-date stored tests, delete it
      _extensionContext.globalState.update(
        ElectronTestCollector.storageKey,
        undefined
      );
      storedTests = undefined;
    }

    this._testSuites = new Map<TestRunner, ParsedTestSuite>(storedTests?.tests);

    // TBD - Is it a good idea to fire off refreshes when files change? Seems
    // like there could be lots of failed attempts to list tests as files are
    // saved in-progress and in a state which can't list out tests. The
    // cost-benefit trade-off doesn't seem great, since the TypeScript
    // compilation of listing tests is non-trivial. For now make the user
    // manually refresh the tests when they know it is an acceptable time to
    // do so. However, we should handle tests popping into existance inside
    // an existing test suite and splice them in once we're aware of them.
    //
    // const watcher = vscode.workspace.createFileSystemWatcher(
    //   new vscode.RelativePattern(_electronRoot.fsPath, "{spec,spec-main}/")
    // );
  }

  async _getTests(runner: TestRunner) {
    const testSuites = await ExtensionState.runOperation(
      ExtensionOperation.LOAD_TESTS,
      () =>
        getElectronTests(this._extensionContext, this._electronRoot, runner),
      ExtensionState.isOperationRunning(ExtensionOperation.LOAD_TESTS)
    );

    // Store for future use
    this._testSuites.set(runner, testSuites);
    await this._extensionContext.globalState.update(
      ElectronTestCollector.storageKey,
      {
        version: ElectronTestCollector.storedTestsVersion,
        tests: Array.from(this._testSuites),
      }
    );

    this._initialRefreshDone.set(runner, true);

    return testSuites;
  }

  _refreshRunner(runner: TestRunner): Promise<void> {
    const promise = this._getTests(runner).then(() => {});

    this._onDidStartRefreshing.fire({
      runner,
      refreshFinished: promise,
    });

    return promise;
  }

  async refreshTestSuites(): Promise<void> {
    const promises = [];

    // Only refresh runners which have already had their initial refresh
    for (const [runner, hasRefreshed] of this._initialRefreshDone.entries()) {
      if (hasRefreshed) {
        promises.push(this._refreshRunner(runner));
      }
    }

    return Promise.all(promises).then(() => {});
  }

  async getTestSuites(runner: TestRunner): Promise<ParsedTestSuite> {
    let testSuites = this._testSuites.get(runner);

    if (testSuites === undefined) {
      // Nothing stored so we have to wait
      testSuites = await this._getTests(runner);
    } else if (!this._initialRefreshDone.get(runner)!) {
      // We've got stored results, but they haven't been refreshed since
      // they were loaded from storage, so go fetch a fresh listing, but
      // don't block waiting for fresh results, return what was stored
      this._refreshRunner(runner);
    }

    return testSuites;
  }

  async getTestsForUri(
    uri: vscode.Uri
  ): Promise<{ runner: TestRunner; tests: ParsedTest[] }> {
    if (!uri.path.startsWith(this._electronRoot.path)) {
      throw new Error("Uri is not in Electron root");
    }

    const testDirectory = path.posix
      .relative(this._electronRoot.path, uri.path)
      .split(path.posix.sep)[0];
    let runner: TestRunner;

    if (testDirectory === "spec-main") {
      runner = TestRunner.MAIN;
    } else if (testDirectory === "spec") {
      runner = TestRunner.REMOTE;
    } else {
      throw new Error("Uri is not in a test directory");
    }

    const collectTests = (suite: ParsedTestSuite) => {
      const tests: ParsedTest[] = [];

      for (const test of suite.tests) {
        if (test.file === uri.fsPath) {
          tests.push(test);
        }
      }

      for (const childSuite of suite.suites) {
        tests.push(...collectTests(childSuite));
      }

      return tests;
    };

    const parsedTestSuite = await this.getTestSuites(runner);

    return { runner, tests: await collectTests(parsedTestSuite) };
  }
}

export class TestsTreeDataProvider implements TreeDataProvider<TreeItem> {
  private _onDidChangeTreeData = new EventEmitter<
    TreeItem | undefined | void
  >();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private readonly _testRunnerTreeItems = new Map<
    TestRunner,
    TestRunnerTreeItem
  >();

  constructor(private readonly _testCollector: TestCollector) {
    this._testRunnerTreeItems.set(
      TestRunner.MAIN,
      new TestRunnerTreeItem(
        "Main Process",
        new ThemeIcon("device-desktop"),
        TestRunner.MAIN
      )
    );
    this._testRunnerTreeItems.set(
      TestRunner.REMOTE,
      new TestRunnerTreeItem(
        "Renderer",
        new ThemeIcon("browser"),
        TestRunner.REMOTE
      )
    );

    this._testCollector.onDidStartRefreshing(
      async ({ runner, refreshFinished }) => {
        await refreshFinished;
        this.refresh(this._testRunnerTreeItems.get(runner));
      }
    );
  }

  // TODO - This doesn't work great since test names often aren't unique, so making sure
  // it is matching the exact test is tricky, but it's also tricky to get suite names
  // using regexes
  findTestFullyQualifiedName(
    filename: vscode.Uri,
    test: string
  ): Test | undefined {
    for (const treeItem of this._testRunnerTreeItems.values()) {
      if (treeItem.suite) {
        const testPaths = findFullPathForTest(treeItem.suite, filename, test);

        if (testPaths.length === 1) {
          return {
            runner: treeItem.runner,
            test: testPaths[0].join(" ").trim(),
          };
        }
      }
    }
  }

  refresh(data: void | vscode.TreeItem | undefined): void {
    this._onDidChangeTreeData.fire(data);
  }

  getTreeItem(element: TreeItem): TreeItem {
    return element;
  }

  getParent(element: TreeItem): TreeItem | null {
    if (element instanceof TestBaseTreeItem) {
      return element.parent!;
    } else if (element instanceof TestRunnerTreeItem) {
      return null;
    }

    throw new Error("Not implemented");
  }

  async getChildren(element?: TreeItem): Promise<TreeItem[]> {
    if (!element) {
      return Array.from(this._testRunnerTreeItems.values());
    } else if (element instanceof TestSuiteTreeItem) {
      const children: TestBaseTreeItem[] = [
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

      if (element.getState() === TestState.RUNNING) {
        children.forEach((treeItem) => treeItem.setState(TestState.RUNNING));
      }

      return children;
    } else if (element instanceof TestRunnerTreeItem) {
      try {
        element.suite = await this._testCollector.getTestSuites(element.runner);

        return alphabetizeByLabel(
          element.suite.suites.map(
            (suite) => new TestSuiteTreeItem(suite, element.runner, element)
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

export abstract class TestBaseTreeItem extends TreeItem {
  public readonly parent?: TreeItem;
  private _state: TestState;

  constructor(
    public readonly uri: vscode.Uri,
    public readonly label: string,
    public readonly runner: TestRunner,
    public readonly fullName: string,
    public readonly collapsibleState?: vscode.TreeItemCollapsibleState
  ) {
    super(label, collapsibleState);

    this._state = TestState.NONE;
  }

  abstract get fullTitle(): string;

  getState() {
    return this._state;
  }

  setState(state: TestState) {
    if (state === TestState.RUNNING) {
      this.iconPath = new ThemeIcon("loading");
    } else if (state === TestState.SUCCESS) {
      this.iconPath = new ThemeIcon(
        "check",
        new vscode.ThemeColor("debugIcon.startForeground")
      );
    } else if (state === TestState.FAILURE) {
      this.iconPath = new ThemeIcon(
        "error",
        new vscode.ThemeColor("debugIcon.stopForeground")
      );
    }

    this._state = state;
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

export class TestSuiteTreeItem extends TestBaseTreeItem {
  constructor(
    public readonly suite: ParsedTestSuite,
    public readonly runner: TestRunner,
    public readonly parent: TreeItem
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

  get fullTitle() {
    return this.suite.fullTitle;
  }

  setState(state: TestState) {
    if (state === TestState.NONE) {
      this.iconPath = new ThemeIcon("library");
    } else {
      super.setState(state);
    }
  }
}

export class TestTreeItem extends TestBaseTreeItem {
  constructor(
    public readonly test: ParsedTest,
    public readonly runner: TestRunner,
    public readonly parent: TestSuiteTreeItem
  ) {
    super(
      vscode.Uri.file(parent.suite.file),
      truncateToLength(test.title, 40),
      runner,
      test.title,
      vscode.TreeItemCollapsibleState.None
    );

    this.setState(TestState.NONE);
    this.tooltip = test.title;
    this.contextValue = "test";
  }

  get fullTitle() {
    return this.test.fullTitle;
  }

  setState(state: TestState) {
    if (state === TestState.NONE) {
      this.iconPath = new ThemeIcon("code");
    } else {
      super.setState(state);
    }
  }
}
