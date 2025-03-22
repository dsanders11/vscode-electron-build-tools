import util from "node:util";

import { reporters, MochaOptions, Runner, Test } from "mocha";
import * as vscode from "vscode";

import { outputChannelName } from "../src/constants";

const {
  EVENT_RUN_BEGIN,
  EVENT_RUN_END,
  EVENT_TEST_FAIL,
  EVENT_TEST_PASS,
  EVENT_TEST_PENDING,
  EVENT_SUITE_BEGIN,
  EVENT_SUITE_END,
} = Runner.constants;
const color = reporters.Base.color;

type ExtendedTest = Test & { _continuations?: number };

// Adapted from https://github.com/mochajs/mocha/blob/v11.1.0/lib/reporters/spec.js
export default class ExtendedSpecReporter extends reporters.Base {
  _indents: number = 0;
  _n: number = 0;

  constructor(runner: Runner, options: MochaOptions) {
    super(runner, options);

    const outputChannel = vscode.window.createOutputChannel(
      `${outputChannelName}: LM Tests`,
    );
    outputChannel.show();

    // Redirect mocha output to the output channel (no color, sadly)
    reporters.Base.consoleLog = (...data: unknown[]) => {
      outputChannel.appendLine(data.length > 0 ? util.format(...data) : "");
    };

    runner.on(EVENT_RUN_BEGIN, () => {
      reporters.Base.consoleLog();
    });

    runner.on(EVENT_SUITE_BEGIN, (suite) => {
      this.increaseIndent();
      reporters.Base.consoleLog(
        util.format(color("suite", "%s%s"), this.indent(), suite.title),
      );
    });

    runner.on(EVENT_SUITE_END, () => {
      this.decreaseIndent();
      if (this._indents === 1) {
        reporters.Base.consoleLog();
      }
    });

    runner.on(EVENT_TEST_PENDING, (test) => {
      const fmt = this.indent() + color("pending", "  - %s");
      reporters.Base.consoleLog(util.format(fmt, test.title));
    });

    runner.on(EVENT_TEST_PASS, (test: ExtendedTest) => {
      const continuationText = () => {
        if (test._continuations) {
          if (test._continuations > 1) {
            return ` (${test._continuations} continuations)`;
          } else {
            return ` (${test._continuations} continuation)`;
          }
        }

        return "";
      };

      let fmt: string;
      if (test.speed === "fast") {
        fmt =
          this.indent() +
          color("checkmark", "  " + reporters.Base.symbols.ok) +
          color("pass", " %s") +
          continuationText();
        reporters.Base.consoleLog(util.format(fmt, test.title));
      } else {
        fmt =
          this.indent() +
          color("checkmark", "  " + reporters.Base.symbols.ok) +
          color("pass", " %s") +
          color(test.speed!, " (%dms)") +
          continuationText();
        reporters.Base.consoleLog(util.format(fmt, test.title, test.duration));
      }
    });

    runner.on(EVENT_TEST_FAIL, (test) => {
      reporters.Base.consoleLog(
        util.format(
          this.indent() + color("fail", "  %d) %s"),
          ++this._n,
          test.title,
        ),
      );
    });

    runner.once(EVENT_RUN_END, () => {
      this.epilogue();
    });
  }

  indent() {
    return Array(this._indents).join("  ");
  }

  increaseIndent() {
    this._indents++;
  }

  decreaseIndent() {
    this._indents--;
  }
}
