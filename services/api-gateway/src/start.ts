import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GatewayServiceInstance } from './service.js';

const SERVICE_NAME = 'api-gateway';

async function main(): Promise<void> {
  const service = new GatewayServiceInstance();
  let shuttingDown = false;
  const shutdown = (): void => {
    if (shuttingDown) {
      process.exit(1);
    }
    shuttingDown = true;
    void service
      .stop()
      .then(() => process.exit(0))
      .catch(() => process.exit(1));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  try {
    const port = await service.start();
    // Port only: hosts, credentials, and URLs stay out of logs.
    console.log(`[${SERVICE_NAME}] listening on port ${port}`);
  } catch (error) {
    console.error(
      `[${SERVICE_NAME}] failed to start: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }
}

// Entrypoint only: importing this module (for example from './index.js')
// must never start the service as a side effect.
const invokedPath = process.argv[1] === undefined ? '' : resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) {
  void main();
}
