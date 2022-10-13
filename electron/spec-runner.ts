/* eslint-disable @typescript-eslint/naming-convention */

import * as childProcess from "child_process";
import * as crypto from "crypto";
import * as path from "path";

export async function setupSpecRunner(electronRoot: string) {
  const fs = require(path.resolve(electronRoot, "node_modules", "fs-extra"));
  const { hashElement } = require(path.resolve(
    electronRoot,
    "node_modules",
    "folder-hash"
  ));

  const SCRIPT_DIR = path.resolve(electronRoot, "script");

  const utils = require(path.resolve(SCRIPT_DIR, "lib", "utils"));
  const { YARN_VERSION } = require(path.resolve(SCRIPT_DIR, "yarn"));

  const BASE = path.resolve(electronRoot, "..");
  const NPX_CMD = process.platform === "win32" ? "npx.cmd" : "npx";

  function generateTypeDefinitions() {
    const { status } = childProcess.spawnSync(
      "npm",
      ["run", "create-typescript-definitions"],
      {
        cwd: electronRoot,
        stdio: "inherit",
        shell: true,
      }
    );
    if (status !== 0) {
      throw new Error(
        `Electron typescript definition generation failed with exit code: ${status}.`
      );
    }
  }

  function getSpecHash() {
    return Promise.all([
      (async () => {
        const hasher = crypto.createHash("SHA256");
        hasher.update(
          fs.readFileSync(path.resolve(electronRoot, "spec", "package.json"))
        );
        hasher.update(
          fs.readFileSync(path.resolve(electronRoot, "spec", "yarn.lock"))
        );
        hasher.update(
          fs.readFileSync(path.resolve(SCRIPT_DIR, "spec-runner.js"))
        );
        return hasher.digest("hex");
      })(),
      (async () => {
        const specNodeModulesPath = path.resolve(
          electronRoot,
          "spec",
          "node_modules"
        );
        if (!fs.existsSync(specNodeModulesPath)) {
          return null;
        }
        const { hash } = await hashElement(specNodeModulesPath, {
          folders: {
            exclude: [".bin"],
          },
        });
        return hash;
      })(),
    ]);
  }

  async function installSpecModules(dir: string) {
    // v8 headers use c++17 so override the gyp default of -std=c++14,
    // but don't clobber any other CXXFLAGS that were passed into spec-runner.js
    const CXXFLAGS = ["-std=c++17", process.env.CXXFLAGS]
      .filter((x) => !!x)
      .join(" ");

    const nodeDir = path.resolve(
      BASE,
      `out/${utils.getOutDir({ shouldLog: true })}/gen/node_headers`
    );
    const env = {
      ...process.env,
      CXXFLAGS,
      npm_config_nodedir: nodeDir,
      npm_config_msvs_version: "2019",
      npm_config_yes: "true",
    };
    if (fs.existsSync(path.resolve(dir, "node_modules"))) {
      await fs.remove(path.resolve(dir, "node_modules"));
    }
    const { status } = childProcess.spawnSync(
      NPX_CMD,
      [`yarn@${YARN_VERSION}`, "install", "--frozen-lockfile"],
      {
        env,
        cwd: dir,
        stdio: "inherit",
      }
    );
    if (status !== 0 && !process.env.IGNORE_YARN_INSTALL_ERROR) {
      console.log(`Failed to yarn install in '${dir}'`);
      process.exit(1);
    }
  }

  function loadLastSpecHash() {
    return fs.existsSync(specHashPath)
      ? fs.readFileSync(specHashPath, "utf8").split("\n")
      : [null, null];
  }

  function saveSpecHash([newSpecHash, newSpecInstallHash]: [string, string]) {
    fs.writeFileSync(specHashPath, `${newSpecHash}\n${newSpecInstallHash}`);
  }

  const specHashPath = path.resolve(electronRoot, "spec", ".hash");

  const [lastSpecHash, lastSpecInstallHash] = loadLastSpecHash();
  const [currentSpecHash, currentSpecInstallHash] = await getSpecHash();
  const somethingChanged =
    currentSpecHash !== lastSpecHash ||
    lastSpecInstallHash !== currentSpecInstallHash;

  if (somethingChanged) {
    await installSpecModules(path.resolve(electronRoot, "spec"));
    await getSpecHash().then(saveSpecHash);
  }

  if (!fs.existsSync(path.resolve(electronRoot, "electron.d.ts"))) {
    console.log("Generating electron.d.ts as it is missing");
    generateTypeDefinitions();
  }
}
