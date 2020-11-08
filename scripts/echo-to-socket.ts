import * as childProcess from "child_process";
import * as net from "net";

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
  cp.stdout!.pipe(socket);
});

// We bubble up the exit code as well
cp.on("exit", (exitCode, signal) => {
  process.exit(exitCode || 0);
});

// Send signals down to the wrapped child
process.on("SIGHUP", cp.kill);
process.on("SIGINT", cp.kill);
process.on("SIGTERM", cp.kill);
