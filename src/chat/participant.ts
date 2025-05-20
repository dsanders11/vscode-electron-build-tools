import * as vscode from "vscode";

import { chatParticipantId } from "../constants";
import { type ElectronPatchesProvider } from "../views/patches";

import { findUpstreamFiles } from "./commands/findUpstreamFiles";
import { listPatches } from "./commands/listPatches";
import { upgradesFindCL } from "./commands/upgradesFindCL";
import { searchCLs } from "./commands/searchCLs";
import { getPrivateTools } from "./tools";

export function registerChatParticipant(
  { extension, extensionUri }: vscode.ExtensionContext,
  electronRoot: vscode.Uri,
  patchesProvider: ElectronPatchesProvider,
) {
  const chromiumRoot = vscode.Uri.joinPath(electronRoot, "..");

  const handler: vscode.ChatRequestHandler = async (
    request: vscode.ChatRequest,
    context: vscode.ChatContext,
    stream: vscode.ChatResponseStream,
    token: vscode.CancellationToken,
  ): Promise<vscode.ChatResult> => {
    const tools = getPrivateTools(extension);

    if (request.command === "findUpstreamFiles") {
      await findUpstreamFiles(chromiumRoot, request, stream, token);
      return {};
    } else if (request.command === "listPatches") {
      await listPatches(
        chromiumRoot,
        electronRoot,
        patchesProvider,
        request,
        stream,
        token,
      );
    } else if (
      request.command === "upgradesFindCL" ||
      request.command === "upgradesFindCLAdvanced"
    ) {
      return upgradesFindCL(
        chromiumRoot,
        electronRoot,
        tools,
        request,
        context,
        stream,
        token,
        request.command === "upgradesFindCLAdvanced",
      );
    } else if (request.command === "searchCLs") {
      return searchCLs(
        chromiumRoot,
        electronRoot,
        tools,
        request,
        context,
        stream,
        token,
      );
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

  participant.followupProvider = {
    provideFollowups(
      result: vscode.ChatResult,
      _context: vscode.ChatContext,
      _token: vscode.CancellationToken,
    ): vscode.ProviderResult<vscode.ChatFollowup[]> {
      if (result.metadata?.continuation) {
        return [{ label: "Continue Searching", prompt: "continue" }];
      }

      return [];
    },
  };

  return participant;
}
