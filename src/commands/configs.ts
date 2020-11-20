import * as childProcess from "child_process";
import * as path from "path";
import { promisify } from "util";

import * as vscode from "vscode";

import { buildToolsExecutable } from "../constants";
import {
  default as ExtensionState,
  ExtensionOperation,
} from "../extensionState";
import Logger from "../logging";
import { getConfigs, getConfigsFilePath } from "../utils";
import {
  ConfigTreeItem,
  ElectronBuildToolsConfigsProvider,
} from "../views/configs";

const exec = promisify(childProcess.exec);

export function registerConfigsCommands(
  context: vscode.ExtensionContext,
  configsProvider: ElectronBuildToolsConfigsProvider
) {
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "electron-build-tools.openConfig",
      async (configName: string) => {
        const configFilePath = path.join(
          getConfigsFilePath(),
          `evm.${configName}.json`
        );
        try {
          const document = await vscode.workspace.openTextDocument(
            configFilePath
          );
          await vscode.window.showTextDocument(document);
        } catch (e) {
          Logger.error(e);
        }

        return configFilePath;
      }
    ),
    vscode.commands.registerCommand(
      "electron-build-tools.use-config.quick-pick",
      async () => {
        const { configs } = await getConfigs();
        const selected = await vscode.window.showQuickPick(configs);

        if (selected) {
          // Do an optimistic update for snappier UI
          configsProvider.setActive(selected);

          childProcess.exec(
            `${buildToolsExecutable} use ${selected}`,
            {
              encoding: "utf8",
            },
            (error, stdout) => {
              if (error ?? stdout.trim() !== `Now using config ${selected}`) {
                vscode.window.showErrorMessage(
                  "Failed to set active Electron build-tools config"
                );
                configsProvider.setActive(null);
                configsProvider.refresh();
              }
            }
          );
        }
      }
    ),
    vscode.commands.registerCommand(
      "electron-build-tools.remove-config",
      (config: ConfigTreeItem) => {
        childProcess.exec(
          `${buildToolsExecutable} remove ${config.label}`,
          {
            encoding: "utf8",
          },
          (error, stdout, stderr) => {
            if (error ?? stdout.trim() !== `Removed config ${config.label}`) {
              vscode.window.showErrorMessage(
                `Failed to remove config: ${stderr.trim()}`
              );
            } else {
              // TBD - This isn't very noticeable
              vscode.window.setStatusBarMessage("Removed config");
              configsProvider.refresh();
            }
          }
        );
      }
    ),
    vscode.commands.registerCommand(
      "electron-build-tools.sanitize-config",
      (config: ConfigTreeItem) => {
        childProcess.exec(
          `${buildToolsExecutable} sanitize-config ${config.label}`,
          {
            encoding: "utf8",
          },
          (error, stdout, stderr) => {
            if (
              error ||
              stdout.trim() !== `SUCCESS Sanitized contents of ${config.label}`
            ) {
              vscode.window.showErrorMessage(
                `Failed to sanitize config: ${stderr.trim()}`
              );
            } else {
              // TBD - This isn't very noticeable
              vscode.window.setStatusBarMessage("Sanitized config");
            }
          }
        );
      }
    ),
    ExtensionState.registerExtensionOperationCommand(
      ExtensionOperation.CHANGE_CONFIG,
      "electron-build-tools.use-config",
      () => {
        vscode.window.showErrorMessage(
          "Can't change configs, other work in-progress"
        );
      },
      async (config: ConfigTreeItem) => {
        // Do an optimistic update for snappier UI
        configsProvider.setActive(config.label);

        let result: Error | boolean;

        try {
          const { stdout } = await exec(
            `${buildToolsExecutable} use ${config.label}`,
            {
              encoding: "utf8",
            }
          );

          result = stdout.trim() === `Now using config ${config.label}`;
        } catch (err) {
          result = err;
        }

        if (result !== true) {
          vscode.window.showErrorMessage(
            "Failed to set active Electron build-tools config"
          );
          configsProvider.setActive(null);
          configsProvider.refresh();
        }
      }
    )
  );
}
