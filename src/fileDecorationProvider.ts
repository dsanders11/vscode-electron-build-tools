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
      const { isPatch, blobIdA, blobIdB, status } = querystringParse(uri.query);

      // TBD - Should color be used here? It's a bit much if everything has color
      if (blobIdA && blobIdB) {
        if (/^[0]+$/.test(blobIdA)) {
          // All zeroes for blobIdA indciates it is a new file
          return new vscode.FileDecoration("A", "Added");
        } else if (/^[0]+$/.test(blobIdB)) {
          // All zeroes for blobIdB indciates it is a deleted file
          return new vscode.FileDecoration("D", "Deleted");
        } else {
          return new vscode.FileDecoration("M", "Modified");
        }
      } else if (isPatch && status) {
        switch (status as PullRequestFileStatus) {
          case "added":
          case "copied":
            return new vscode.FileDecoration("A", "Added");

          case "modified":
          case "renamed":
            return new vscode.FileDecoration("M", "Modified");

          case "removed":
            return new vscode.FileDecoration("D", "Deleted");
        }
      }
    }
  }
}
