import * as childProcess from "child_process";
import * as net from "net";

import { IpcMessage } from "../src/common";

const [command, socketPath] = process.argv.slice(2, 4);

// Command was base64-encoded to prevent quotes from being mucked with
const cp = childProcess.spawn(Buffer.from(command, "base64").toString(), {
  windowsVerbatimArguments: true,
  shell: true,
});

// Pipe the child process's output out
// our own since we're wrapping it
cp.stdout!.pipe(process.stdout);
cp.stderr!.pipe(process.stderr);

// And also pipe stdout to the socket
const socket = net.createConnection(socketPath, () => {
  cp.stdout!.on("data", (data: Buffer) => {
    // Send stdout as an IPC message across the socket
    const message: IpcMessage = { stream: "stdout", data: data.toString() };
    socket.write(JSON.stringify(message));
  });
});

// We bubble up the exit code as well
cp.on("exit", (exitCode, signal) => {
  process.exit(exitCode || 0);
});

// Send signals down to the wrapped child
process.on("SIGHUP", cp.kill);
process.on("SIGINT", cp.kill);
process.on("SIGTERM", cp.kill);
