import assert from "node:assert/strict";

import * as vscode from "vscode";

import { invokePrivateTool } from "../src/chat/tools";
import { lmToolNames } from "../src/constants";

describe("invokePrivateTool", () => {
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
        lmToolNames.chromiumGitShow,
        {
          input: { commit, filename: "chrome/android/junit/BUILD.gn" },
          toolInvocationToken: undefined,
        },
      );

      assert.strictEqual(result.content.length, 1);
      assert.ok(result.content[0] instanceof vscode.LanguageModelTextPart);
      assert.ok(result.content[0].value.startsWith(`commit ${commit}`));
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

      assert.strictEqual(result.content.length, 1);
      assert.ok(result.content[0] instanceof vscode.LanguageModelTextPart);
      assert.strictEqual(
        result.content[0].value,
        globalThis._testFixtures.tools[lmToolNames.chromiumGitShow][0],
      );
    });
  });

  describe(`invoking ${lmToolNames.chromiumLog}`, () => {
    it("gets the log", async function () {
      const page = 27;
      const result = await invokePrivateTool(
        this.globalContext.chromiumRoot,
        lmToolNames.chromiumLog,
        {
          input: {
            startVersion: "136.0.7064.0",
            endVersion: "136.0.7067.0",
            page,
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
            startVersion: "136.0.7064.0",
            endVersion: "136.0.7067.0",
            page: 999,
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
