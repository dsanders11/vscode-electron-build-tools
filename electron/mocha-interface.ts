// Modified from upstream https://github.com/mochajs/mocha/blob/v5.2.0/lib/interfaces/bdd.js
// Changes: include `body` property for suites and skipped tests so that range can be extracted

import * as path from "path";

import type { Func, Suite, Test as TestType } from "mocha";
import type { CommonFunctions } from "mocha/lib/interfaces/common";

const Test: typeof TestType = require(
  path.resolve(
    process.env["ELECTRON_ROOT"]!,
    "spec",
    "node_modules",
    "mocha",
    "lib",
    "test",
  ),
);

function Interface(suite: Suite) {
  const suites = [suite];

  suite.on("pre-require", (context, file, mocha) => {
    const common: CommonFunctions = require(
      path.resolve(
        process.env["ELECTRON_ROOT"]!,
        "spec",
        "node_modules",
        "mocha",
        "lib",
        "interfaces",
        "common",
      ),
    )(suites, context, mocha);

    context.before = common.before;
    context.after = common.after;
    context.beforeEach = common.beforeEach;
    context.afterEach = common.afterEach;
    (context.run as any) = mocha.options.delay && common.runWithSuite(suite);

    /**
     * Describe a "suite" with the given `title`
     * and callback `fn` containing nested suites
     * and/or tests.
     */
    (context.describe as any) = (context.context as any) = (
      title: string,
      fn: (this: Suite) => void,
    ) => {
      const suite = common.suite.create({ title, file, fn });

      // NOTE - This differs from upstream, we want the function body for range info
      (suite as any).body = fn.toString();

      return suite;
    };

    /**
     * Pending describe.
     */
    context.xdescribe =
      context.xcontext =
      context.describe.skip =
        (title: string, fn: (this: Suite) => void) => {
          const suite = common.suite.skip({ title, file, fn });

          // NOTE - This differs from upstream, we want the function body for range info
          (suite as any).body = fn.toString();

          return suite;
        };

    /**
     * Exclusive suite.
     */
    (context.describe.only as any) = (
      title: string,
      fn: (this: Suite) => void,
    ) => {
      const suite = common.suite.only({ title, file, fn });

      // NOTE - This differs from upstream, we want the function body for range info
      (suite as any).body = fn.toString();

      return suite;
    };

    /**
     * Describe a specification or test-case
     * with the given `title` and callback `fn`
     * acting as a thunk.
     */
    (context.it as any) = (context.specify as any) = (
      title: string,
      fn?: Func,
    ) => {
      const suite = suites[0];
      if (suite.isPending()) {
        fn = undefined;
      }
      const test = new Test(title, fn);
      test.file = file;
      suite.addTest(test);
      return test;
    };

    /**
     * Exclusive test-case.
     */
    (context.it.only as any) = (title: string, fn?: Func) => {
      return common.test.only(mocha, context.it(title, fn));
    };

    /**
     * Pending test case.
     */
    (context.xit as any) =
      (context.xspecify as any) =
      (context.it.skip as any) =
        (title: string, fn?: Func) => {
          // NOTE - This differs from upstream in that we provide `fn` for range info
          return context.it(title, fn);
        };

    /**
     * Number of attempts to retry.
     */
    context.it.retries = (n: number) => {
      (context as any).retries(n);
    };
  });
}

module.exports = Interface;
