import * as vscode from "vscode";

import { chatParticipantId } from "../constants";

import { findUpstreamFiles } from "./commands/findUpstreamFiles";
import { upgradesFindCL } from "./commands/upgradesFindCL";
import { getPrivateTools } from "./tools";

export function registerChatParticipant(
  { extension, extensionUri }: vscode.ExtensionContext,
  electronRoot: vscode.Uri,
) {
  const chromiumRoot = vscode.Uri.joinPath(electronRoot, "..");

  const handler: vscode.ChatRequestHandler = async (
    request: vscode.ChatRequest,
    _context: vscode.ChatContext,
    stream: vscode.ChatResponseStream,
    token: vscode.CancellationToken,
  ): Promise<vscode.ChatResult> => {
    const tools = getPrivateTools(extension);

    if (request.command === "findUpstreamFiles") {
      await findUpstreamFiles(chromiumRoot, request, stream, token);
      return {};
    } else if (request.command === "upgradesFindCL") {
      await upgradesFindCL(
        chromiumRoot,
        electronRoot,
        tools,
        request,
        stream,
        token,
      );
      return {};
    } else {
      stream.markdown("Sorry, I can only respond to specific commands.");
    }

    return {};
  };

  const participant = vscode.chat.createChatParticipant(
    chatParticipantId,
    handler,
  );
  participant.iconPath = vscode.Uri.joinPath(
    extensionUri,
    "resources",
    "icons",
    "electron_logo.png",
  );
}
