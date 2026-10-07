import { fileURLToPath } from 'node:url';
import { UsageService } from './service.js';

export * from './config.js';
export * from './service.js';
export * from './domain/index.js';
export * from './application/index.js';
export * from './infrastructure/index.js';
export * from './interfaces/index.js';

// Auto-start if invoked directly
const currentFilePath = fileURLToPath(import.meta.url);
if (process.argv[1] && process.argv[1] === currentFilePath) {
  const service = new UsageService();
  service.start().catch((err) => {
    console.error('Fatal error starting Usage Service:', err);
    process.exit(1);
  });

  const shutdown = async () => {
    await service.stop();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
