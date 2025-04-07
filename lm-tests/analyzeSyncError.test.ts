import assert from "node:assert/strict";

import escapeRegExp from "lodash.escaperegexp";
import * as vscode from "vscode";

import { analyzeSyncError } from "../src/chat/commands/upgradesFindCL";
import { getPrivateTools } from "../src/chat/tools";
import { getChromiumVersionCommitDate } from "../src/chat/utils";

import { MockChatResponseStream } from "./mocks";

describe("analyzeSyncError", () => {
  describe("finds the upstream CL for a sync error", () => {
    for (const fixture of globalThis._testFixtures.syncErrors) {
      describe(fixture.cl, () => {
        for (const model of globalThis._testModels) {
          it(`using ${model.name}`, async function () {
            const stream = new MockChatResponseStream();
            const previousChromiumVersionDate =
              await getChromiumVersionCommitDate(
                this.globalContext.chromiumRoot,
                fixture.previousVersion,
              );
            assert.notStrictEqual(previousChromiumVersionDate, null);
            const tools = getPrivateTools(this.globalContext.extension);
            await analyzeSyncError(
              this.globalContext.chromiumRoot,
              { model, toolInvocationToken: null } as vscode.ChatRequest,
              stream,
              tools,
              fixture.previousVersion,
              fixture.newVersion,
              fixture.diff,
              fixture.error,
              this.globalContext.cancellationToken,
            );
            assert.ok(stream._markdownMessages.length >= 1);
            assert.match(
              stream._markdownMessages.join(""),
              new RegExp(escapeRegExp(fixture.cl)),
            );
          });
        }
      });
    }
  });
});
