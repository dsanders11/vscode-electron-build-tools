import * as vscode from "vscode";

import { outputChannelName } from "./constants";

export default vscode.window.createOutputChannel(outputChannelName, {
  log: true,
});
