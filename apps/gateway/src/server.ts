import { prisma } from '@app/db';
import { createEnv, gatewayEnv } from '@app/env';
import { createLogger } from '@app/logger';

import { createGateway } from './gateway.ts';
import { resolveNodeId } from './node-id.ts';

const FORCE_EXIT_AFTER_MS = 20_000;

const config = createEnv(gatewayEnv, { service: 'gateway' });
const nodeId = resolveNodeId(config.GATEWAY_NODE_ID, config.GATEWAY_PORT);
const logger = createLogger({
  service: 'gateway',
  level: config.LOG_LEVEL,
  nodeEnv: config.NODE_ENV,
}).child({ nodeId });

const gateway = await createGateway({ config, nodeId, prisma, logger });

let stopping = false;
async function stop(reason: NodeJS.Signals | 'uncaught', exitCode = 0): Promise<void> {
  if (stopping) return;
  stopping = true;
  logger.info({ reason }, 'shutting down');
  setTimeout(() => {
    logger.error('shutdown timed out; forcing exit');
    process.exit(1);
  }, FORCE_EXIT_AFTER_MS).unref();
  try {
    await gateway.shutdown();
    await prisma.$disconnect();
    process.exit(exitCode);
  } catch (error) {
    logger.error({ err: error }, 'error during shutdown');
    process.exit(1);
  }
}

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, (received) => {
    void stop(received);
  });
}

// Last line of defence: a bug must not drop every call on this node. Drain like a deploy
// (sessions become `reconnecting` and resume on other nodes, D-046), then exit non-zero so the
// orchestrator restarts the process.
process.on('uncaughtException', (error) => {
  logger.fatal({ err: error }, 'uncaught exception; draining');
  void stop('uncaught', 1);
});
process.on('unhandledRejection', (reason) => {
  logger.fatal({ err: reason }, 'unhandled rejection; draining');
  void stop('uncaught', 1);
});

try {
  const port = await gateway.listen(config.GATEWAY_PORT, config.GATEWAY_HOST);
  logger.info({ port }, 'gateway listening');
} catch (error) {
  logger.fatal({ err: error }, 'failed to start');
  process.exit(1);
}
