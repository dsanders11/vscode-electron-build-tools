import assert from "node:assert/strict";

import * as vscode from "vscode";

import { invokePrivateTool } from "../src/chat/tools";
import { lmToolNames } from "../src/constants";

describe("invokePrivateTool", () => {
  describe(`invoking ${lmToolNames.gitLog}`, () => {
    const startVersion = "136.0.7064.0";
    const endVersion = "136.0.7080.0";

    it("gets the log", async function () {
      const result = await invokePrivateTool(
        this.globalContext.chromiumRoot,
        lmToolNames.gitLog,
        {
          input: {
            startVersion,
            endVersion,
            filename: "base/check.cc",
          },
          toolInvocationToken: undefined,
        },
      );

      assert.strictEqual(result.content.length, 1);
      assert.ok(result.content[0] instanceof vscode.LanguageModelTextPart);
      assert.strictEqual(
        result.content[0].value,
        globalThis._testFixtures.tools[lmToolNames.gitLog][0],
      );
    });

    it("handles no more commits", async function () {
      const filename = "base/run_loop.h";

      const result = await invokePrivateTool(
        this.globalContext.chromiumRoot,
        lmToolNames.gitLog,
        {
          input: {
            startVersion,
            endVersion,
            filename,
          },
          toolInvocationToken: undefined,
        },
      );

      assert.strictEqual(result.content.length, 1);
      assert.ok(result.content[0] instanceof vscode.LanguageModelTextPart);
      assert.strictEqual(
        result.content[0].value,
        `No commits found for ${filename} in the range ${startVersion}..${endVersion}`,
      );
    });
  });

  describe(`invoking ${lmToolNames.gitShow}`, () => {
    it("throws an error if the commit SHA is invalid", async function () {
      const invalidCommit = "invalid-sha";

      await assert.rejects(
        () =>
          invokePrivateTool(
            this.globalContext.chromiumRoot,
            lmToolNames.gitShow,
            {
              input: { commit: invalidCommit, filename: "foo" },
              toolInvocationToken: undefined,
            },
          ),
        {
          name: "Error",
          message: `Invalid commit SHA: ${invalidCommit}`,
        },
      );
    });

    it.skip("handles commit not found", async function () {
      const result = await invokePrivateTool(
        this.globalContext.chromiumRoot,
        lmToolNames.gitShow,
        {
          input: { commit: "deadbeef", filename: "foo" },
          toolInvocationToken: undefined,
        },
      );

      assert.strictEqual(result.content[0], "");
    });

    it("gets commit details", async function () {
      const commit = "a0c2c27201d4a32d65cceba1a0053ffa08530aaf";
      const result = await invokePrivateTool(
        this.globalContext.chromiumRoot,
        lmToolNames.gitShow,
        {
          input: { commit, filename: "chrome/android/junit/BUILD.gn" },
          toolInvocationToken: undefined,
        },
      );

      assert.strictEqual(result.content.length, 1);
      assert.ok(result.content[0] instanceof vscode.LanguageModelTextPart);
      assert.strictEqual(
        result.content[0].value,
        globalThis._testFixtures.tools[lmToolNames.gitShow][0],
      );
    });
  });

  describe(`invoking ${lmToolNames.chromiumGitShow}`, () => {
    it("throws an error if the commit SHA is invalid", async function () {
      const invalidCommit = "invalid-sha";

      await assert.rejects(
        () =>
          invokePrivateTool(
            this.globalContext.chromiumRoot,
            lmToolNames.chromiumGitShow,
            {
              input: { commit: invalidCommit },
              toolInvocationToken: undefined,
            },
          ),
        {
          name: "Error",
          message: `Invalid commit SHA: ${invalidCommit}`,
        },
      );
    });

    it.skip("handles commit not found", async function () {
      const result = await invokePrivateTool(
        this.globalContext.chromiumRoot,
        lmToolNames.chromiumGitShow,
        {
          input: { commit: "deadbeef" },
          toolInvocationToken: undefined,
        },
      );

      assert.strictEqual(result.content[0], "");
    });

    it("gets commit details", async function () {
      const commit = "a0c2c27201d4a32d65cceba1a0053ffa08530aaf";
      const result = await invokePrivateTool(
        this.globalContext.chromiumRoot,
        lmToolNames.chromiumGitShow,
        {
          input: { commit },
          toolInvocationToken: undefined,
        },
      );

      assert.strictEqual(result.content.length, 2);
      assert.ok(result.content[0] instanceof vscode.LanguageModelTextPart);
      assert.ok(result.content[1] instanceof vscode.LanguageModelTextPart);
      assert.strictEqual(
        result.content[0].value + result.content[1].value,
        globalThis._testFixtures.tools[lmToolNames.chromiumGitShow][0],
      );
    });
  });

  describe(`invoking ${lmToolNames.chromiumLog}`, () => {
    const startVersion = "136.0.7064.0";
    const endVersion = "136.0.7067.0";
    const pageSize = 15;

    it("gets the log", async function () {
      const page = 27;
      const result = await invokePrivateTool(
        this.globalContext.chromiumRoot,
        lmToolNames.chromiumLog,
        {
          input: {
            startVersion,
            endVersion,
            page,
            pageSize,
          },
          toolInvocationToken: undefined,
        },
      );

      assert.strictEqual(result.content.length, 2);
      assert.ok(result.content[0] instanceof vscode.LanguageModelTextPart);
      assert.strictEqual(
        result.content[0].value.trim(),
        `This is page ${page} of the log:`,
      );
      assert.ok(result.content[1] instanceof vscode.LanguageModelTextPart);
      assert.strictEqual(
        result.content[1].value,
        globalThis._testFixtures.tools[lmToolNames.chromiumLog][0],
      );
    });

    it("handles no more commits", async function () {
      const result = await invokePrivateTool(
        this.globalContext.chromiumRoot,
        lmToolNames.chromiumLog,
        {
          input: {
            startVersion,
            endVersion,
            page: 999,
            pageSize,
          },
          toolInvocationToken: undefined,
        },
      );

      assert.strictEqual(result.content.length, 1);
      assert.ok(result.content[0] instanceof vscode.LanguageModelTextPart);
      assert.strictEqual(result.content[0].value, "No commits found");
    });

    // TODO - more test cases
  });
});
