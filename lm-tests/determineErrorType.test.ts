import assert from "node:assert/strict";

import {
  determineErrorType,
  ErrorType,
} from "../src/chat/commands/upgradesFindCL";

describe("determineErrorType", () => {
  describe("returns unknown for random text", () => {
    for (const model of globalThis._testModels) {
      it(`using ${model.name}`, async function () {
        const result = await determineErrorType(
          model,
          "foobar",
          this.globalContext.cancellationToken,
        );
        assert.strictEqual(result, ErrorType.UNKNOWN);
      });
    }
  });

  describe("can detect sync errors", () => {
    for (const model of globalThis._testModels) {
      for (const { error } of globalThis._testFixtures.syncErrors) {
        it(`using ${model.name}`, async function () {
          const result = await determineErrorType(
            model,
            error,
            this.globalContext.cancellationToken,
          );
          assert.strictEqual(result, ErrorType.SYNC);
        });
      }
    }
  });

  describe("can detect build errors", () => {
    for (const model of globalThis._testModels) {
      for (const { error } of globalThis._testFixtures.buildErrors) {
        it(`using ${model.name}`, async function () {
          const result = await determineErrorType(
            model,
            error,
            this.globalContext.cancellationToken,
          );
          assert.strictEqual(result, ErrorType.BUILD);
        });
      }
    }
  });
});
