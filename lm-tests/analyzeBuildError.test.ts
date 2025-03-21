import assert from "node:assert/strict";

import escapeRegExp from "lodash.escaperegexp";
import * as vscode from "vscode";

import { analyzeBuildError } from "../src/chat/commands/upgradesFindCL";
import { getPrivateTools } from "../src/chat/tools";

import { MockChatResponseStream } from "./mocks";

describe("analyzeBuildError", () => {
  describe("finds the upstream CL for a build error", () => {
    for (const model of globalThis._testModels) {
      for (const fixture of globalThis._testFixtures.buildErrors) {
        it(`using ${model.name}`, async function () {
          const stream = new MockChatResponseStream();
          const tools = getPrivateTools(this.globalContext.extension);
          await analyzeBuildError(
            this.globalContext.chromiumRoot,
            { model, toolInvocationToken: null } as vscode.ChatRequest,
            stream,
            tools,
            fixture.previousVersion,
            fixture.newVersion,
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
