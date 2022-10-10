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

// Adapted from https://github.com/mochajs/mocha/blob/v5.2.0/lib/reporters/json-stream.js
function Reporter(runner: Runner) {
  // @ts-ignore
  Base.call(this, runner);

  runner.on("start", () => {
    console.log(JSON.stringify(["start", { total: runner.total }]));
  });

  runner.on("pass", (test) => {
    console.log(JSON.stringify(["pass", clean(test)]));
  });

  runner.on("fail", (test, err) => {
    const output = clean(test);
    (output as any).err = err.message;
    (output as any).stack = err.stack || null;
    console.log(JSON.stringify(["fail", output]));
  });

  runner.once("end", () => {
    // @ts-ignore
    process.stdout.write(JSON.stringify(["end", this.stats]));
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
