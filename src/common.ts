export interface IpcMessage {
  stream: string;
  data: unknown;
}

export const Markdown = {
  // From vscode's source
  linkPattern:
    /(\[((!\[[^\]]*?\]\(\s*)([^\s\(\)]+?)\s*\)\]|(?:\\\]|[^\]])*\])\(\s*)(([^\s\(\)]|\(\S*?\))*)\s*(".*?")?\)/g,
  definitionPattern: /^([\t ]*\[((?:\\\]|[^\]])+)\]:\s*)(\S+)/gm,
};

export interface PromisifiedExecError extends Error {
  code?: number;
  stderr: string;
  stdout: string;
}
