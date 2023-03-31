import * as vscode from "vscode";

import { outputChannelName } from "./constants";

const Logger = vscode.window.createOutputChannel(outputChannelName, { log: true });
export default Logger;
