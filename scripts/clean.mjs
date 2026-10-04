import { rmSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const rootDir = process.cwd();

const targetDirs = [
  'dist',
  'coverage',
  'packages/config/dist',
  'packages/contracts/dist',
  'packages/events/dist',
  'packages/logging/dist',
  'packages/observability/dist',
  'templates/service/dist',
];

for (const target of targetDirs) {
  const fullPath = resolve(rootDir, target);
  if (existsSync(fullPath)) {
    console.log(`Cleaning ${target}...`);
    rmSync(fullPath, { recursive: true, force: true });
  }
}

console.log('Clean complete.');
