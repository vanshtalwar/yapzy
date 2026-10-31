/**
 * Runs two gateway nodes (4001 and 4011) to exercise cross-node behaviour locally: the sharded
 * adapter, gw:control kicks and presence. Each child reads the root .env; the port and node id
 * set here win because real environment variables override the file.
 */
import { type ChildProcess, spawn } from 'node:child_process';

const NODES = [
  { port: '4001', nodeId: 'gw-4001' },
  { port: '4011', nodeId: 'gw-4011' },
];

const children: ChildProcess[] = NODES.map(({ port, nodeId }) =>
  spawn('tsx', ['watch', '--clear-screen=false', 'src/server.ts'], {
    stdio: 'inherit',
    env: { ...process.env, GATEWAY_PORT: port, GATEWAY_NODE_ID: nodeId },
  }),
);

let exited = 0;
for (const child of children) {
  child.on('exit', () => {
    exited += 1;
    if (exited === children.length) process.exit(0);
  });
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    // Ctrl-C already reaches the children via the process group; this covers plain `kill`.
    for (const child of children) child.kill('SIGTERM');
  });
}
