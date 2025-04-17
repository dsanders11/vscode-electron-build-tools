import assert from "node:assert/strict";

import escapeRegExp from "lodash.escaperegexp";
import * as vscode from "vscode";

import {
  analyzeBuildError,
  AnalyzeBuildErrorContinuation,
} from "../src/chat/commands/upgradesFindCL";
import { getPrivateTools } from "../src/chat/tools";

import { MockChatResponseStream } from "./mocks";
import type { ExtendedTest } from "./reporter";

describe.skip("analyzeBuildError", () => {
  describe("finds the upstream CL for a build error", () => {
    for (const fixture of globalThis._testFixtures.buildErrors) {
      describe(fixture.cl, () => {
        for (const model of globalThis._testModels) {
          it(`using ${model.name}`, async function () {
            const request = {
              model,
              toolInvocationToken: null,
            } as vscode.ChatRequest;
            let continuation: AnalyzeBuildErrorContinuation | undefined;

            do {
              const stream = new MockChatResponseStream();
              const tools = getPrivateTools(this.globalContext.extension);

              const result = await analyzeBuildError(
                this.globalContext.chromiumRoot,
                request,
                stream,
                tools,
                fixture.previousVersion,
                fixture.newVersion,
                fixture.error,
                this.globalContext.cancellationToken,
                continuation,
              );
              continuation = result.metadata?.continuation;

              try {
                assert.strictEqual(stream._markdownMessages.length, 1);
                assert.match(
                  stream._markdownMessages[0],
                  new RegExp(escapeRegExp(fixture.cl)),
                );

                // Test passed, clear the continuation
                continuation = undefined;
              } catch (error) {
                // Don't fail the test unless it's not possible to continue searching
                if (
                  continuation === undefined ||
                  !(error instanceof assert.AssertionError)
                ) {
                  throw error;
                } else {
                  // Keep track of the number of continuations so we can show output
                  const test = this.test as ExtendedTest;
                  if (test._continuations === undefined) {
                    test._continuations = 0;
                  }
                  test._continuations += 1;
                }
              }
            } while (continuation !== undefined);
          });
        }
      });
    }
  });
});
