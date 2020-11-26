export interface IpcMessage {
  stream: string;
  data: string;
}

interface Position {
  line: number;
  character: number;
}

export interface ParsedTestData {
  title: string;
  fullTitle: string;
  file: string;
  pending: boolean;
}

export interface ParsedTest extends ParsedTestData {
  range: {
    start: Position;
    end: Position;
  } | null;
}

export interface ParsedTestSuite extends ParsedTestData {
  suites: ParsedTestSuite[];
  tests: ParsedTest[];
}

export enum TestRunner {
  MAIN = "main",
  REMOTE = "remote",
}

export interface Test {
  runner: TestRunner;
  test: string;
}

export namespace Markdown {
  // From vscode's source
  export const linkPattern = /(\[((!\[[^\]]*?\]\(\s*)([^\s\(\)]+?)\s*\)\]|(?:\\\]|[^\]])*\])\(\s*)(([^\s\(\)]|\(\S*?\))*)\s*(".*?")?\)/g;
  export const definitionPattern = /^([\t ]*\[((?:\\\]|[^\]])+)\]:\s*)(\S+)/gm;
}
