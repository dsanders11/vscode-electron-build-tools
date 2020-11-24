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
import { getConfigsFilePath, sleep } from "../utils";
import type {
  ConfigCollector,
  ConfigTreeItem,
  ElectronBuildToolsConfigsProvider,
} from "../views/configs";

const exec = promisify(childProcess.exec);

export function registerConfigsCommands(
  context: vscode.ExtensionContext,
  confisCollector: ConfigCollector,
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
      `${commandPrefix}.useConfig.quickPick`,
      () => vscode.commands.executeCommand(`${commandPrefix}.useConfig`)
    ),
    vscode.commands.registerCommand(
      `${commandPrefix}.removeConfig`,
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
      `${commandPrefix}.sanitizeConfig`,
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
      `${commandPrefix}.useConfig`,
      () => {
        vscode.window.showErrorMessage(
          "Can't change configs, other work in-progress"
        );
      },
      async (value: { label: string } | string | undefined) => {
        if (value === undefined) {
          await sleep(50); // If this is too fast it has an ugly flash in VS Code
          const { configs, activeConfig } = await confisCollector.getConfigs();
          value = await vscode.window.showQuickPick<vscode.QuickPickItem>(
            configs.map((config) => ({
              label: config,
              description: config === activeConfig ? "Active" : undefined,
            }))
          );

          if (value === undefined || value.label === activeConfig) {
            return;
          }
        }

        const configName = (value as any).label ?? value;

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
