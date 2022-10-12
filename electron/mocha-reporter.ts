const net = require("net");
const path = require("path");

const Base = require(path.resolve(
  process.env["ELECTRON_ROOT"],
  "spec",
  "node_modules",
  "mocha",
  "lib",
  "reporters",
  "base"
));

import type { Runner, Test } from "mocha";

// Encode any newlines so we can use newline as a delimeter
function encodeNewlines(value: string) {
  return value.replace(/%|\n/g, (match) => {
    switch (match) {
      case "%%":
        return "%25";
      case "\n":
        return "%0A";
      default:
        throw new Error("Unreachable");
    }
  });
}

// Adapted from https://github.com/mochajs/mocha/blob/v5.2.0/lib/reporters/json-stream.js
function Reporter(runner: Runner) {
  // @ts-ignore
  Base.call(this, runner);

  const socket = net.createConnection(process.env["EBT_SOCKET_PATH"], () => {
    const writeToSocket = (value: string) => {
      socket.write(`${encodeNewlines(value)}\n`);
    };

    runner.on("start", () => {
      writeToSocket(
        JSON.stringify({
          stream: "mocha-test-results",
          data: ["start", { total: runner.total }],
        })
      );
    });

    runner.on("test", (test) => {
      writeToSocket(
        JSON.stringify({
          stream: "mocha-test-results",
          data: ["test-start", clean(test)],
        })
      );
    });

    runner.on("test end", (test) => {
      writeToSocket(
        JSON.stringify({
          stream: "mocha-test-results",
          data: ["test-end", clean(test)],
        })
      );
    });

    runner.on("pass", (test) => {
      writeToSocket(
        JSON.stringify({
          stream: "mocha-test-results",
          data: ["pass", clean(test)],
        })
      );
    });

    runner.on("pending", (test) => {
      writeToSocket(
        JSON.stringify({
          stream: "mocha-test-results",
          data: ["pending", clean(test)],
        })
      );
    });

    runner.on("fail", (test, err) => {
      const output = clean(test);
      (output as any).err = err;
      (output as any).stack = err.stack || null;
      writeToSocket(
        JSON.stringify({ stream: "mocha-test-results", data: ["fail", output] })
      );
    });

    runner.once("end", () => {
      writeToSocket(
        JSON.stringify({
          stream: "mocha-test-results",
          // @ts-ignore
          data: ["end", this.stats],
        })
      );
    });
  });
}

function clean(test: Test) {
  return {
    title: test.title,
    fullTitle: test.fullTitle(),
    duration: test.duration,
    // @ts-ignore
    currentRetry: test.currentRetry(),
  };
}

module.exports = Reporter;
