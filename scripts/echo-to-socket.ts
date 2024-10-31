import * as childProcess from "node:child_process";
import * as net from "node:net";

import type { IpcMessage } from "../src/common";

const [b64command, socketPath, suppressExitCode] = process.argv.slice(2, 5);

const command = Buffer.from(b64command, "base64").toString();

// Echo the command being run to stderr for easier debugging
process.stderr.write(
  `Executing "\x1b[36m${command}\x1b[0m" in \x1b[35m${process.cwd()}\x1b[0m\r\n`,
);

// Command was base64-encoded to prevent quotes from being mucked with
const cp = childProcess.spawn(command, {
  windowsVerbatimArguments: true,
  shell: true,
});

// Pipe the child process's output out
// our own since we're wrapping it
cp.stdout!.pipe(process.stdout);
cp.stderr!.pipe(process.stderr);

// Encode any newlines so we can use newline as a delimeter
function encodeNewlines(value: string) {
  return value.replace(/%%|\n/g, (match) => {
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

// And also pipe output to the socket
const socket = net.createConnection(socketPath, () => {
  cp.stdout!.on("data", (data: Buffer) => {
    // Send stdout as an IPC message across the socket
    const message: IpcMessage = { stream: "stdout", data: data.toString() };
    socket.write(`${encodeNewlines(JSON.stringify(message))}\n`);
  });
  cp.stderr!.on("data", (data: Buffer) => {
    // Send stderr as an IPC message across the socket
    const message: IpcMessage = { stream: "stderr", data: data.toString() };
    socket.write(`${encodeNewlines(JSON.stringify(message))}\n`);
  });
});

// We bubble up the exit code as well
cp.on("exit", (exitCode) => {
  process.exit(suppressExitCode ? 0 : exitCode || 0);
});
