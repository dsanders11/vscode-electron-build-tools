export const extensionId: string = "dsanders11.vscode-electron-build-tools";

export const blankConfigEnumValue: string = "----";

export const buildTargets: string[] = [
  "breakpad",
  "chromedriver",
  "electron",
  "electron:dist",
  "mksnapshot",
  "node:headers",
];

export const buildToolsExecutable: string = "electron-build-tools";

export const patchDirectoryPretyNames: Record<string, string> = Object.freeze({
  "src/electron/patches/chromium": "Chromium",
  "src/electron/patches/boringssl": "BoringSSL",
  "src/electron/patches/v8": "V8",
  "src/electron/patches/node": "Node",
  "src/electron/patches/squirrel.mac": "squirrel.mac",
  "src/electron/patches/ReactiveObjC": "ReactiveObjC",
  "src/electron/patches/depot_tools": "depot_tools",
});

export const patchVirtualDocumentScheme: string = "electron-build-tools-patch";
