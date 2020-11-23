import * as childProcess from "child_process";
import * as path from "path";
import { promisify } from "util";

import * as vscode from "vscode";

import { buildToolsExecutable, commandPrefix } from "../constants";
import {
  default as ExtensionState,
  ExtensionOperation,
} from "../extensionState";
import Logger from "../logging";
import { getConfigs, getConfigsFilePath } from "../utils";
import type {
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
      `${commandPrefix}.openConfig`,
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
      `${commandPrefix}.use-config.quick-pick`,
      async () => {
        const { configs } = await getConfigs();
        const selected = await vscode.window.showQuickPick(configs);

        if (selected) {
          await vscode.commands.executeCommand(
            `${commandPrefix}.use-config`,
            selected
          );
        }
      }
    ),
    vscode.commands.registerCommand(
      `${commandPrefix}.remove-config`,
      async (config: ConfigTreeItem) => {
        try {
          await exec(`${buildToolsExecutable} remove ${config.label}`);

          // TBD - This isn't very noticeable
          vscode.window.setStatusBarMessage("Removed config");
        } catch (err) {
          Logger.error(err);
          vscode.window.showErrorMessage(
            `Failed to remove config: ${err.stderr.trim()}`
          );
          configsProvider.refresh();
        }
      }
    ),
    vscode.commands.registerCommand(
      `${commandPrefix}.sanitize-config`,
      async (config: ConfigTreeItem) => {
        try {
          await exec(`${buildToolsExecutable} sanitize-config ${config.label}`);

          // TBD - This isn't very noticeable
          vscode.window.setStatusBarMessage("Sanitized config");
        } catch (err) {
          Logger.error(err);
          vscode.window.showErrorMessage(
            `Failed to sanitize config: ${err.stderr.trim()}`
          );
        }
      }
    ),
    ExtensionState.registerExtensionOperationCommand(
      ExtensionOperation.CHANGE_CONFIG,
      `${commandPrefix}.use-config`,
      () => {
        vscode.window.showErrorMessage(
          "Can't change configs, other work in-progress"
        );
      },
      async (treeItemOrName: ConfigTreeItem | string) => {
        const configName = (treeItemOrName as any).label ?? treeItemOrName;

        // Do an optimistic update for snappier UI
        configsProvider.setActive(configName);

        try {
          await exec(`${buildToolsExecutable} use ${configName}`);
        } catch (err) {
          Logger.error(err);
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
