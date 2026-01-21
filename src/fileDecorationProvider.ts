import * as vscode from "vscode";

import type { RestEndpointMethodTypes } from "@octokit/rest";

import { virtualDocumentScheme, virtualFsScheme } from "./constants";
import { querystringParse } from "./utils";

type PullRequestFileStatus =
  RestEndpointMethodTypes["pulls"]["listFiles"]["response"]["data"][0]["status"];

export class ElectronFileDecorationProvider
  implements vscode.FileDecorationProvider
{
  provideFileDecoration(
    uri: vscode.Uri,
  ): vscode.ProviderResult<vscode.FileDecoration> {
    if (
      uri.scheme === virtualDocumentScheme ||
      uri.scheme === virtualFsScheme
    ) {
      const { isPatch, blobIdA, blobIdB, oldFilename, status } =
        querystringParse(uri.query);

      if (blobIdA && blobIdB) {
        if (/^[0]+$/.test(blobIdA)) {
          // All zeroes for blobIdA indicates it is a new file
          return new vscode.FileDecoration(
            "A",
            "Added",
            new vscode.ThemeColor("gitDecoration.addedResourceForeground"),
          );
        } else if (/^[0]+$/.test(blobIdB)) {
          // All zeroes for blobIdB indicates it is a deleted file
          return new vscode.FileDecoration(
            "D",
            "Deleted",
            new vscode.ThemeColor("gitDecoration.deletedResourceForeground"),
          );
        } else if (oldFilename) {
          return new vscode.FileDecoration(
            "R",
            "Renamed",
            new vscode.ThemeColor("gitDecoration.renamedResourceForeground"),
          );
        } else {
          return new vscode.FileDecoration(
            "M",
            "Modified",
            new vscode.ThemeColor("gitDecoration.modifiedResourceForeground"),
          );
        }
      } else if (isPatch && status) {
        switch (status as PullRequestFileStatus) {
          case "added":
            return new vscode.FileDecoration(
              "A",
              "Added",
              new vscode.ThemeColor("gitDecoration.addedResourceForeground"),
            );

          case "copied":
            return new vscode.FileDecoration(
              "C",
              "Copied",
              new vscode.ThemeColor("gitDecoration.renamedResourceForeground"),
            );

          case "modified":
            return new vscode.FileDecoration(
              "M",
              "Modified",
              new vscode.ThemeColor("gitDecoration.modifiedResourceForeground"),
            );

          case "renamed":
            return new vscode.FileDecoration(
              "R",
              "Renamed",
              new vscode.ThemeColor("gitDecoration.renamedResourceForeground"),
            );

          case "removed":
            return new vscode.FileDecoration(
              "D",
              "Deleted",
              new vscode.ThemeColor("gitDecoration.deletedResourceForeground"),
            );
        }
      }
    }
  }
}
