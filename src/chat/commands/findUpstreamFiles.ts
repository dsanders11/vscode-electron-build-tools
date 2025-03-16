import { renderPrompt } from "@vscode/prompt-tsx";
import * as vscode from "vscode";

import { FindUpstreamFilePrompt } from "../prompts";

export async function findUpstreamFiles(
  chromiumRoot: vscode.Uri,
  request: vscode.ChatRequest,
  stream: vscode.ChatResponseStream,
  token: vscode.CancellationToken,
) {
  const files = await vscode.workspace.findFiles(
    "shell/**/*.{cc,cpp,h,mm,hxx}",
    null,
    undefined,
    token,
  );
  for (const file of files) {
    const fileContents = await vscode.workspace.fs.readFile(file);
    const { messages } = await renderPrompt(
      FindUpstreamFilePrompt,
      { fileContents: fileContents.toString() },
      { modelMaxPromptTokens: request.model.maxInputTokens },
      request.model,
    );

    const response = await request.model.sendRequest(messages, {}, token);
    let result = "";
    for await (const fragment of response.text) {
      result += fragment;
    }
    if (result.toLowerCase() !== "no") {
      try {
        await vscode.workspace.fs.stat(
          vscode.Uri.joinPath(chromiumRoot, result),
        );
        stream.markdown(
          `${vscode.workspace.asRelativePath(file, false)} -> ${result}\n`,
        );
      } catch {
        // File doesn't exist so ignore it
      }
    }
  }
}
