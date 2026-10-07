import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@oicunt/config': resolve(import.meta.dirname, 'packages/config/src/index.ts'),
      '@oicunt/contracts': resolve(import.meta.dirname, 'packages/contracts/src/index.ts'),
      '@oicunt/events': resolve(import.meta.dirname, 'packages/events/src/index.ts'),
      '@oicunt/logging': resolve(import.meta.dirname, 'packages/logging/src/index.ts'),
      '@oicunt/observability': resolve(import.meta.dirname, 'packages/observability/src/index.ts'),
    },
  },
  test: {
    globals: true,
    environment: 'node',
    include: [
      'packages/*/src/**/*.test.ts',
      'tests/**/*.test.ts',
      'templates/*/tests/**/*.test.ts',
      'services/*/tests/**/*.test.ts',
    ],
    exclude: ['**/node_modules/**', '**/dist/**'],
  },
});
