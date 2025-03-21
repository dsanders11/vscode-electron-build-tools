/* eslint-disable @typescript-eslint/naming-convention */

import * as childProcess from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

export async function setupSpecRunner(
  electronRoot: string,
  depotToolsDir: string,
) {
  const { hashElement } = await import(
    pathToFileURL(
      path.resolve(electronRoot, "node_modules", "folder-hash", "index.js"),
    ).toString()
  );

  const SCRIPT_DIR = path.resolve(electronRoot, "script");

  const utils = await import(
    pathToFileURL(path.resolve(SCRIPT_DIR, "lib", "utils.js")).toString()
  );
  const { YARN_VERSION } = await import(
    pathToFileURL(path.resolve(SCRIPT_DIR, "yarn.js")).toString()
  );

  const BASE = path.resolve(electronRoot, "..");

  function generateTypeDefinitions() {
    const { status } = childProcess.spawnSync(
      "npm",
      ["run", "create-typescript-definitions"],
      {
        cwd: electronRoot,
        stdio: "inherit",
        shell: true,
      },
    );
    if (status !== 0) {
      throw new Error(
        `Electron typescript definition generation failed with exit code: ${status}.`,
      );
    }
  }

  function getSpecHash() {
    return Promise.all([
      (() => {
        const hasher = crypto.createHash("SHA256");
        hasher.update(
          fs.readFileSync(path.resolve(electronRoot, "spec", "package.json")),
        );
        hasher.update(
          fs.readFileSync(path.resolve(electronRoot, "spec", "yarn.lock")),
        );
        hasher.update(
          fs.readFileSync(path.resolve(SCRIPT_DIR, "spec-runner.js")),
        );
        return hasher.digest("hex");
      })(),
      (async () => {
        const specNodeModulesPath = path.resolve(
          electronRoot,
          "spec",
          "node_modules",
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
    const nodeDir = path.resolve(
      BASE,
      `out/${utils.getOutDir({ shouldLog: true })}/gen/node_headers`,
    );
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      CXXFLAGS: process.env.CXXFLAGS,
      npm_config_nodedir: nodeDir,
      npm_config_msvs_version: "2022",
      npm_config_yes: "true",
    };
    if (process.platform === "win32") {
      env.npm_config_python = path.resolve(depotToolsDir, "python3.bat");
    }
    if (fs.existsSync(path.resolve(dir, "node_modules"))) {
      await fs.promises.rm(path.resolve(dir, "node_modules"), {
        force: true,
        recursive: true,
      });
    }
    const { status, stderr } = childProcess.spawnSync(
      "e",
      ["d", "npx", `yarn@${YARN_VERSION}`, "install", "--frozen-lockfile"],
      {
        env,
        cwd: dir,
        stdio: "pipe",
        shell: process.platform === "win32",
        encoding: "utf-8",
      },
    );
    if (status !== 0 && !process.env.IGNORE_YARN_INSTALL_ERROR) {
      if (stderr.includes("missing any VC++ toolset")) {
        throw new Error(
          `Failed to yarn install in '${dir}': missing any VC++ toolset`,
        );
      }

      if (stderr.includes("missing any Windows SDK")) {
        throw new Error(
          `Failed to yarn install in '${dir}': missing any Windows SDK`,
        );
      }

      throw new Error(`Failed to yarn install in '${dir}': ${stderr}`);
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
