/* eslint-disable @typescript-eslint/naming-convention */

export const extensionId = "dsanders11.vscode-electron-build-tools";

export const blankConfigEnumValue = "----";

export const buildTargets = Object.freeze([
  "third_party/breakpad:dump_syms",
  "electron:electron_chromedriver_zip",
  "electron",
  "electron:electron_dist_zip",
  "electron:electron_mksnapshot_zip",
  "electron:node_headers",
]);

export const buildToolsExecutable = "electron-build-tools";

export const patchDirectoryPrettyNames = Object.freeze({
  "src/electron/patches/boringssl": "BoringSSL",
  "src/electron/patches/chromium": "Chromium",
  "src/electron/patches/depot_tools": "depot_tools",
  "src/electron/patches/devtools_frontend": "Chrome DevTools Frontend",
  "src/electron/patches/ffmpeg": "FFmpeg",
  "src/electron/patches/Mantle": "Mantle",
  "src/electron/patches/node": "Node.js",
  "src/electron/patches/nan": "NAN",
  "src/electron/patches/perfetto": "Perfetto",
  "src/electron/patches/ReactiveObjC": "ReactiveObjC",
  "src/electron/patches/reclient-configs": "Reclient Configs",
  "src/electron/patches/squirrel.mac": "Squirrel.Mac",
  "src/electron/patches/v8": "V8",
  "src/electron/patches/webrtc": "WebRTC",
});

export const checkoutDirectoryGitHubRepo = Object.freeze<{
  [k: string]: { owner: string; repo: string } | undefined;
}>({
  src: { owner: "chromium", repo: "chromium" },
  "src/third_party/boringssl/src": { owner: "google", repo: "boringssl" },
  "src/third_party/devtools-frontend/src": {
    owner: "ChromeDevTools",
    repo: "devtools-frontend",
  },
  // TODO - Google actually has a fork of FFmpeg, but it's not on GH
  "src/third_party/ffmpeg": { owner: "FFmpeg", repo: "FFmpeg" },
  "src/v8": { owner: "v8", repo: "v8" },
  "src/third_party/electron_node": { owner: "nodejs", repo: "node" },
  "src/third_party/nan": { owner: "nodejs", repo: "nan" },
  "src/third_party/perfetto": { owner: "google", repo: "perfetto" },
  "src/third_party/squirrel.mac": {
    owner: "Squirrel",
    repo: "Squirrel.Mac",
  },
  "src/third_party/squirrel.mac/vendor/Mantle": {
    owner: "Mantle",
    repo: "Mantle",
  },
  "src/third_party/squirrel.mac/vendor/ReactiveObjC": {
    owner: "ReactiveCocoa",
    repo: "ReactiveObjC.git",
  },
});

export const virtualDocumentScheme = "electron-build-tools";

export const virtualFsScheme = "electron-build-tools-fs";

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

export const chatParticipantId = "electron-build-tools";

export const lmToolNames = Object.freeze({
  chromiumLog: "electron-build-tools_chromiumGitLog",
  chromiumGitShow: "electron-build-tools_chromiumGitShow",
  getTerminalSelection: "copilot_getTerminalSelection",
  gitLog: "electron-build-tools_gitLog",
  gitShow: "electron-build-tools_gitShow",
});
