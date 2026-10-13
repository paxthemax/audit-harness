// In-sandbox TCP forwarder: listens on 127.0.0.1:<port> and forwards each connection, byte for byte,
// to the provider broker's UNIX socket, so HTTP agent tools can use
// ANTHROPIC_BASE_URL=http://127.0.0.1:<port>. It adds nothing: the caller sends the grant token
// itself (x-harness-grant, or x-api-key as an SDK API key). The sandbox has no other network.
//
//   node /opt/harness/tools/forward.mjs [port] [socket]   (defaults: 8787, $HARNESS_BROKER_SOCKET)
import { connect, createServer } from 'node:net';

const port = Number(process.argv[2] ?? process.env.HARNESS_FORWARD_PORT ?? 8787);
const socket = process.argv[3] ?? process.env.HARNESS_BROKER_SOCKET ?? '/run/harness/broker.sock';

const server = createServer((client) => {
  const upstream = connect(socket);
  client.pipe(upstream).pipe(client);
  const close = () => {
    client.destroy();
    upstream.destroy();
  };
  client.on('error', close);
  upstream.on('error', close);
});
server.listen(port, '127.0.0.1', () => {
  process.stdout.write(`forwarding 127.0.0.1:${port} -> ${socket}\n`);
});
