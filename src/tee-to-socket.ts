import * as net from "net";

process.stdin.pipe(process.stdout);

const socket = net.createConnection(process.argv[2], () => {
  process.stdin.pipe(socket);
});
