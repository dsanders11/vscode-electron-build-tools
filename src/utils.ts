import * as childProcess from "child_process";
import * as os from "os";
import * as path from "path";

import { v4 as uuidv4 } from "uuid";

export function isBuildToolsInstalled() {
  const result = childProcess.spawnSync(
    os.platform() === "win32" ? "where" : "which",
    ["electron-build-tools"]
  );

  return result.status === 0;
}

export function generateSocketName() {
  if (os.platform() === "win32") {
    return `\\\\.\\pipe\\${uuidv4()}`;
  } else {
    throw new Error("Not implemented");
  }
}

export function getConfigs() {
  const configs: string[] = [];
  let activeConfig = null;

  const configsOutput = childProcess
    .execSync("electron-build-tools show configs", { encoding: "utf8" })
    .trim();

  for (const rawConfig of configsOutput.split("\n")) {
    const config = rawConfig.replace("*", "").trim();
    configs.push(config);

    if (rawConfig.trim().startsWith("*")) {
      activeConfig = config;
    }
  }

  return { configs, activeConfig };
}

export function getConfigsFilePath() {
  return path.join(os.homedir(), ".electron_build_tools", "configs");
}
