import * as childProcess from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { v4 as uuidv4 } from "uuid";

import { buildToolsExecutable } from "./constants";

export function isBuildToolsInstalled() {
  const result = childProcess.spawnSync(
    os.platform() === "win32" ? "where" : "which",
    [buildToolsExecutable]
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
    .execSync(`${buildToolsExecutable} show configs`, { encoding: "utf8" })
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

export function getConfigDefaultTarget() {
  const configFilename = childProcess
    .execSync(`${buildToolsExecutable} show current --filename --no-name`, {
      encoding: "utf8",
    })
    .trim();

  return JSON.parse(fs.readFileSync(configFilename, { encoding: "utf8" }))
    .defaultTarget;
}
