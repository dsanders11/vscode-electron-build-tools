/* eslint-disable @typescript-eslint/naming-convention */

import * as vscode from "vscode";

import type { ElectronPatchesConfig } from "./types";

export const extensionId = "dsanders11.vscode-electron-build-tools";

export const blankConfigEnumValue = "----";

export const buildTargets = Object.freeze([
  "breakpad",
  "chromedriver",
  "electron",
  "electron:dist",
  "mksnapshot",
  "node:headers",
]);

export const buildToolsExecutable = "electron-build-tools";

export const patchDirectoryPrettyNames = Object.freeze<ElectronPatchesConfig>({
  "src/electron/patches/chromium": "Chromium",
  "src/electron/patches/boringssl": "BoringSSL",
  "src/electron/patches/v8": "V8",
  "src/electron/patches/node": "Node",
  "src/electron/patches/squirrel.mac": "squirrel.mac",
  "src/electron/patches/ReactiveObjC": "ReactiveObjC",
  "src/electron/patches/depot_tools": "depot_tools",
});

export const virtualDocumentScheme = "electron-build-tools";

export const pullRequestScheme = "electron-pull-request";

export const buildToolsRepository = "https://github.com/electron/build-tools";

export const repositoryUrl =
  "https://github.com/dsanders11/vscode-electron-build-tools";

export const outputChannelName = "Electron Build Tools";

export const contextKeyPrefix = "electron-build-tools";

export const commandPrefix = "electron-build-tools";

export const viewIdPrefix = "electron-build-tools";

export const viewIds = Object.freeze({
  CONFIGS: `${viewIdPrefix}:configs`,
  DOCS: `${viewIdPrefix}:docs`,
  ELECTRON: `${viewIdPrefix}:electron`,
  HELP: `${viewIdPrefix}:help`,
  PATCHES: `${viewIdPrefix}:patches`,
});
