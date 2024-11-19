# Electron Tests

This extension integrates with [VS Code's Test Explorer](https://code.visualstudio.com/docs/editor/testing)
to provide a rich experience for running and debugging Electron's tests. It provides rich error output and
accurate location information inside test files.

## Design

Code related to running Electron tests lives in the `electron/` directory and `src/tests.ts`. The helper
`electron/spec-runner.ts` is derived from [Electron's `script/spec-runner.js`](https://github.com/electron/electron/blob/v33.2.0/script/spec-runner.js),
extracting the logic for installing modules before running the tests (or in our case, discovering them).
It may be possible to refactor upstream so that the logic can be used directly without duplicating it
here, but for the moment the maintenance burden is low so it's simpler to extract the desired code.

For both test discovery and test running, the invocations of Electron are wrapped in a programmatically
defined [VS Code task](https://code.visualstudio.com/docs/editor/tasks). This allows the user to have
greater visibility into what is running, see the raw output, and easily terminate the task if desired.

### Test Discovery

Test discovery is performed by running Electron with `electron/listMochaTests.ts` as the main script.
The script opens a socket connection which the VS Code extension (the socket address is provided to the
Electron process in the `EBT_SOCKET_PATH` environment variable) and receives the list of test spec files.
Each file is added to Mocha using [the `addFile` API](https://mochajs.org/api/mocha#addFile), and then
the tests are parsed by calling Mocha's `loadFiles` API. The full root test suite is then formatted to
JSON and sent back to the VS Code extension over the socket connection.

Mocha's parsed test suites does not include location information for where each test is inside it's test
file, which is needed to give users a richer experience and show tests results in-editor. To facilitate
this functionality, a custom Mocha interface (`electron/mocha-interface.ts`) is provided in
`electron/listMochaTests.ts` which adds the body of each test (retrieved via
[`Function.prototype.toString()`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Function/toString))
to the parsed test information. This custom interface is based on
[Mocha's built-in `bdd` interface](https://github.com/mochajs/mocha/blob/v5.2.0/lib/interfaces/bdd.js).

Since Electron's test suite is written in TypeScript, and the function body retrieved with
`Function.prototype.toString()` is the post-transpiled function body, we need to source map back to
the original location in the TypeScript file. This is facilitated by providing a
[custom TypeScript compiler](https://typestrong.org/ts-node/docs/compilers) to `ts-node`
(`electron/electron-build-tools-typescript.ts`) via the `TS_NODE_COMPILER` environment variable. This
compiler is a thin wrapper on top of the `typescript-cached-transpile` package which stores the
transpiled output for each file and exposes it via a function named `getFileContent`. When formatting
the Mocha root test suite to JSON, the function body which was added by the custom Mocha interface
is found in the transpiled output of the test file, and using source maps is mapped back to the location
in the TypeScript file. This location information is added when formatting the Mocha root test suite
before sending it back to the VS Code extension, where it is passed along to the Test Explorer, enabling
accurate location information for each test to be displayed in the editor.

### Test Running

Tests are mostly run as usual with `e test`, and when the user selects only some tests or suites to run,
the `-g` flag for `e test` is generated using the full test name.

To facilitate capturing detailed output from Mocha regarding the test run (when each test is running,
the final outcome of each test, if a test was skipped, error details, etc), a custom Mocha reporter
(`electron/mocha-reporter.ts`) is provided by setting the environment variable `MOCHA_REPORTER` to
`"mocha-multi-reporters"` and `MOCHA_MULTI_REPORTERS` is set to inject the custom Mocha reporter ahead
of the default `spec` reporter. This same approach is used in Electron's CI to provide multiple reporters.
Our custom Mocha reporter is based on
[Mocha's built-in `json-stream` reporter](https://github.com/mochajs/mocha/blob/v5.2.0/lib/reporters/json-stream.js).

The custom Mocha reporter writes output to a socket connection which the VS Code extension creates during
each test run (the socket address is provided to the Electron process in the `EBT_SOCKET_PATH` environment
variable). This ensures the task output is the usual output from running `e test`, while the more detailed
output (consumed by this extension) is sent directly to the extension.
