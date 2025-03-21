import assert from "node:assert/strict";

import escapeRegExp from "lodash.escaperegexp";
import * as vscode from "vscode";

import { analyzeSyncError } from "../src/chat/commands/upgradesFindCL";
import { getPrivateTools } from "../src/chat/tools";
import { getChromiumVersionCommitDate } from "../src/chat/utils";

import { MockChatResponseStream } from "./mocks";

describe.skip("analyzeSyncError", () => {
  describe("finds the upstream CL for a sync error", () => {
    for (const model of globalThis._testModels) {
      for (const fixture of globalThis._testFixtures.syncErrors) {
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
            previousChromiumVersionDate!,
            fixture.error,
            this.globalContext.cancellationToken,
          );
          assert.strictEqual(stream._markdownMessages.length, 1);
          assert.match(
            stream._markdownMessages[0],
            new RegExp(escapeRegExp(fixture.cl)),
          );
        });
      }
    }
  });
});
