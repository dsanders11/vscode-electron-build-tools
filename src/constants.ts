import { ElectronPatchesConfig } from "./types";

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

export const patchDirectoryPretyNames: ElectronPatchesConfig = Object.freeze({
  "src/electron/patches/chromium": "Chromium",
  "src/electron/patches/boringssl": "BoringSSL",
  "src/electron/patches/v8": "V8",
  "src/electron/patches/node": "Node",
  "src/electron/patches/squirrel.mac": "squirrel.mac",
  "src/electron/patches/ReactiveObjC": "ReactiveObjC",
  "src/electron/patches/depot_tools": "depot_tools",
});

export const patchVirtualDocumentScheme = "electron-build-tools-patch";

export const buildToolsRepository = "https://github.com/electron/build-tools";

export const repositoryUrl =
  "https://github.com/dsanders11/vscode-electron-build-tools";
