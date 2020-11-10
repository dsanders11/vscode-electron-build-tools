import * as childProcess from "child_process";
import * as net from "net";

const [command, args, socketPath] = process.argv.slice(2, 5);

// Command was base64-encoded to prevent quotes from being mucked with
const cp = childProcess.execFile(command, [
  Buffer.from(args, "base64").toString(),
]);

// Pipe the child process's output out
// our own since we're wrapping it
cp.stdout!.pipe(process.stdout);
cp.stderr!.pipe(process.stderr);

// And also pipe stdout to the socket
const socket = net.createConnection(socketPath, () => {
  cp.stdout!.pipe(socket);

  socket.once("data", (data) => {
    const message = data.toString().trim();

    if (message === "SIGINT") {
      if (process.platform === "win32") {
        windowsGracefulInterrupt();
      } else {
        cp.kill("SIGINT");
      }
    }
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

function windowsGracefulInterrupt() {
  const { K } = require("win32-api");
  const CTRL_C_EVENT = 0;

  const kernel32 = K.load();

  // Sending this to process group 0 means send it to
  // everyone sharing the console. It's a way to send
  // it to all child processes basically
  kernel32.GenerateConsoleCtrlEvent(CTRL_C_EVENT, 0);
}
