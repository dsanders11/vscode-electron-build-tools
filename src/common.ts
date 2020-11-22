export type IpcMessage = {
  stream: string;
  data: string;
};

export interface ParsedRunnable {
  title: string;
  fullTitle: string;
}

export interface ParsedTestSuite extends ParsedRunnable {
  file: string;
  suites: ParsedTestSuite[];
  tests: ParsedRunnable[];
}

export enum TestRunner {
  MAIN = "main",
  REMOTE = "remote",
}

export type Test = {
  runner: TestRunner;
  test: string;
};

export namespace Markdown {
  // From vscode's source
  export const linkPattern = /(\[((!\[[^\]]*?\]\(\s*)([^\s\(\)]+?)\s*\)\]|(?:\\\]|[^\]])*\])\(\s*)(([^\s\(\)]|\(\S*?\))*)\s*(".*?")?\)/g;
  export const definitionPattern = /^([\t ]*\[((?:\\\]|[^\]])+)\]:\s*)(\S+)/gm;
}
