export * from './config.js';
export * from './service.js';
export * from './domain/index.js';
export * from './application/index.js';
export * from './infrastructure/index.js';
export * from './interfaces/index.js';

// NOTE: this module is a side-effect-free library barrel. It deliberately
// does NOT auto-start the service when executed directly
// (`node dist/index.js`): the only supported way to run a real Usage
// process is `node dist/start.js`, which enforces fail-closed startup
// validation and read-only schema verification before listening.
export const USAGE_SERVICE_ENTRYPOINT = 'dist/start.js';
