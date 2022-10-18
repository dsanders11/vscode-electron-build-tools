import * as net from "net";
import * as path from "path";
import * as readline from "readline";

import type { default as MochaType, Test, Suite } from "mocha";
import type { ParsedTestSuite } from "../src/tests";

// We want to terminate on errors, not show a dialog
process.once("uncaughtException", (err) => {
  console.error(err);
  process.exit(1);
});

// @ts-ignore
import { app } from "electron";

const { SourceMapConsumer } = require(path.resolve(
  process.cwd(),
  "node_modules",
  "source-map"
));
const { retrieveSourceMap } = require(path.resolve(
  process.cwd(),
  "node_modules",
  "source-map-support"
));
const { getFileContent } = require(path.resolve(
  __dirname,
  "electron-build-tools-typescript"
));

const sourceMapConsumers = new Map<string, any>();

function positionAt(content: string, offset: number) {
  const lines = content.slice(0, offset).split("\n");
  const lastLine = lines.at(-1)!.replace(/\r$/, "");

  return { line: lines.length - 1, character: lastLine.length };
}

function mapFnBodyToSourceRange(file: string, body?: string) {
  if (body) {
    let sourceMap = sourceMapConsumers.get(file);

    if (!sourceMap) {
      // This isn't that cheap - do it once per file
      const urlAndMap = retrieveSourceMap(file);
      if (urlAndMap && urlAndMap.map) {
        sourceMap = new SourceMapConsumer(urlAndMap.map);
        sourceMapConsumers.set(file, sourceMap);
      }
    }

    if (sourceMap) {
      const transformedContent: string = getFileContent(file);

      if (!transformedContent) {
        return null;
      }

      const idx = transformedContent.indexOf(body);

      if (idx !== -1) {
        const start = positionAt(transformedContent, idx);
        const end = positionAt(body, body.length);
        end.line += start.line;

        const sourceStart = sourceMap.originalPositionFor({
          line: start.line + 1,
          column: start.character,
        });
        const sourceEnd = sourceMap.originalPositionFor({
          line: end.line + 1,
          column: end.character,
        });

        return {
          start: { line: sourceStart.line - 1, character: sourceStart.column },
          end: { line: sourceEnd.line - 1, character: sourceEnd.column },
        };
      }
    }
  }

  return null;
}

function parseTestSuites(suite: Suite) {
  const parsedTests: ParsedTestSuite = {
    title: suite.title,
    fullTitle: suite.fullTitle(),
    file: suite.file,
    pending: suite.pending,
    range: suite.file
      ? (mapFnBodyToSourceRange(suite.file, (suite as any)?.body) as any)
      : null,
    suites: [],
    tests: suite.tests.map((test: Test) => ({
      title: test.title,
      fullTitle: test.fullTitle(),
      file: test.file,
      pending: test.pending,
      range: test.file
        ? (mapFnBodyToSourceRange(test.file, test.body) as any)
        : null,
    })),
  };

  for (const childSuite of suite.suites) {
    parsedTests.suites.push(parseTestSuites(childSuite));
  }

  return parsedTests;
}

// These are required or there will be a reference error
// while Mocha is processing the tests
global.serviceWorkerScheme = "sw";
global.standardScheme = "app";
global.zoomScheme = "zoom";
(global as any).window = {};

app
  .whenReady()
  .then(async () => {
    // This lets Mocha compile the TypeScript tests on the fly
    require(path.resolve(process.cwd(), "node_modules", "ts-node/register"));

    // Don't load Mocha until after setting up ts-node
    const Mocha = require(path.resolve(
      process.cwd(),
      "spec",
      "node_modules",
      "mocha"
    ));

    const mocha: MochaType = new Mocha({
      ui: path.resolve(__dirname, "mocha-interface.js"),
    });

    // Use a socket to pass filenames rather than command line
    // arguments since there's a max length on Windows which
    // is annoyingly short, which we'd quickly bump into. Why
    // not just stdin? Because on Windows that also doesn't work,
    // due to Electron being a GUI app, which is why REPL no work
    const socket = net.createConnection(process.argv.slice(-1)[0], () => {
      const rl = readline.createInterface({
        input: socket,
      });

      const files: string[] = [];

      rl.on("line", async (line: string) => {
        if (line !== "DONE") {
          files.push(line);
        } else {
          try {
            // Electron sorts the files before adding them
            files.sort().forEach((file) => {
              mocha.addFile(file);
            });

            // @ts-ignore
            await mocha.loadFiles();
            const parsedSuites = parseTestSuites(mocha.suite);
            socket.write(JSON.stringify(parsedSuites, undefined, 4), () =>
              process.exit(0)
            );
          } catch (err: any) {
            console.error(err);
            process.exit(1);
          }
        }
      });

      rl.once("close", () => {
        process.exit(1);
      });
    });
  })
  .catch((err: any) => {
    console.error(err);
    process.exit(1);
  });
