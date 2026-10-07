export * from './config.js';
export * from './domain/index.js';
export * from './application/index.js';
export * from './infrastructure/index.js';
export * from './interfaces/index.js';
export * from './service.js';

import { GatewayServiceInstance } from './service.js';
export { GatewayServiceInstance as ServiceInstance };

async function bootstrap() {
  const service = new GatewayServiceInstance();

  const handleShutdown = async (signal: string) => {
    console.log(`Received ${signal}, shutting down gracefully...`);
    try {
      await service.stop();
      process.exit(0);
    } catch (err) {
      console.error('Error during shutdown:', err);
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => void handleShutdown('SIGTERM'));
  process.on('SIGINT', () => void handleShutdown('SIGINT'));

  try {
    await service.start();
  } catch (err) {
    console.error('Failed to start service:', err);
    process.exit(1);
  }
}

// Start if executed directly
if (
  process.argv[1] &&
  (process.argv[1].endsWith('src/index.ts') || process.argv[1].endsWith('dist/index.js'))
) {
  void bootstrap();
}
