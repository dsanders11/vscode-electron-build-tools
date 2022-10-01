export interface IpcMessage {
  stream: string;
  data: string;
}

export namespace Markdown {
  // From vscode's source
  export const linkPattern =
    /(\[((!\[[^\]]*?\]\(\s*)([^\s\(\)]+?)\s*\)\]|(?:\\\]|[^\]])*\])\(\s*)(([^\s\(\)]|\(\S*?\))*)\s*(".*?")?\)/g;
  export const definitionPattern = /^([\t ]*\[((?:\\\]|[^\]])+)\]:\s*)(\S+)/gm;
}

export interface PromisifiedExecError extends Error {
  code?: number;
  stderr: string;
  stdout: string;
}
