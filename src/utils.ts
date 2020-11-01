import * as childProcess from "child_process";

export function getConfigs() {
  const configs = [];
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
