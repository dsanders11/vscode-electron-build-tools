const Module = require("module");
const net = require("net");
const path = require("path");
const readline = require("readline");

// We want to terminate on errors, not show a dialog
process.once("uncaughtException", (err) => {
  console.error(err);
  process.exit(1);
});

// We need the typescript module but it would be 60 MB to bundle it with the
// extension, which doesn't seem like the right thing to do. It's already in
// the Electron source tree, so give access to it by adding to the global path
// This also gives access to Mocha, rather than including it in the extension
Module.globalPaths.push(path.resolve(process.cwd(), "node_modules"));

// However, node_modules resolution works upward from the file path, so once
// inside code outside of this script, we lose access to the extension's
// node_modules, so explicitly inject it in there so any module searches it
Module.globalPaths.push(path.resolve(__dirname, "..", "..", "node_modules"));

// Needed for our custom files
Module.globalPaths.push(path.resolve(__dirname));

// Needed or some imports at the start of test files will fail
Module.globalPaths.push(path.resolve(process.cwd(), "spec", "node_modules"));

const { app } = require("electron");

const { SourceMapConsumer } = require("source-map");
const { retrieveSourceMap } = require("source-map-support");
const { getFileContent } = require("electron-build-tools-typescript");

const sourceMapConsumers = new Map();

function positionAt(content, offset) {
  const lines = Array.from(
    content.slice(0, offset).matchAll(/^(.*)(?:\r\n|$)/gm)
  );
  const lastLine = lines.slice(-1)[0][1];

  return { line: lines.length - 1, character: lastLine.length };
}

function mapFnBodyToSourceRange(file, body) {
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
      const transformedContent = getFileContent(file);
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
          start: { line: sourceStart.line, character: sourceStart.column },
          end: { line: sourceEnd.line, character: sourceEnd.column },
        };
      }
    }
  }

  return { start: null, end: null };
}

function parseTestSuites(suite) {
  const parsedTests = {
    title: suite.title,
    fullTitle: suite.fullTitle(),
    file: suite.file,
    suites: [],
    tests: suite.tests.map((test) => ({
      title: test.title,
      fullTitle: test.fullTitle(),
      file: test.file,
      range: mapFnBodyToSourceRange(test.file, test.body),
    })),
  };

  for (const childSuite of suite.suites) {
    parsedTests.suites.push(parseTestSuites(childSuite));
  }

  return parsedTests;
}

// These are required or there will be a reference error
// while Mocha is processing the tests
global.standardScheme = "app";
global.zoomScheme = "zoom";
global.window = {};

app
  .whenReady()
  .then(async () => {
    // This lets Mocha compile the TypeScript tests on the fly
    require("ts-node/register");

    // Don't load Mocha until after setting up ts-node
    const Mocha = require("mocha");

    const mocha = new Mocha();

    // Use a socket to pass filenames rather than command line
    // arguments since there's a max length on Windows which
    // is annoyingly short, which we'd quickly bump into. Why
    // not just stdin? Because on Windows that also doesn't work,
    // due to Electron being a GUI app, which is why REPL no work
    const socket = net.createConnection(process.argv.slice(-1)[0], () => {
      const rl = readline.createInterface({
        input: socket,
      });

      rl.on("line", async (line) => {
        if (line !== "DONE") {
          mocha.addFile(line);
        } else {
          try {
            await mocha.loadFiles();
            const parsedSuites = parseTestSuites(mocha.suite);
            socket.write(JSON.stringify(parsedSuites, undefined, 4));
            process.exit(0);
          } catch (err) {
            process.stderr.write(err.toString());
            process.exit(1);
          }
        }
      });

      rl.once("close", () => {
        process.exit(1);
      });
    });
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
