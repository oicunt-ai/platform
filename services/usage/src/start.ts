import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { UsageService } from './service.js';

const SERVICE_NAME = 'usage';

async function main(): Promise<void> {
  const service = new UsageService();
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
    // start() resolves void; the port comes from the same environment
    // configuration the service itself was constructed with.
    await service.start();
    // Port only: hosts, credentials, and URLs stay out of logs.
    console.log(`[${SERVICE_NAME}] listening on port ${service.config.port}`);
  } catch (error) {
    console.error(
      `[${SERVICE_NAME}] failed to start: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }
}

// Entrypoint only: importing this module (for example from './index.js')
// must never start the service as a side effect.
// NOTE: starting Usage runs database migrations (see service.ts); never
// launch it without explicit migration authorization.
const invokedPath = process.argv[1] === undefined ? '' : resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) {
  void main();
}
