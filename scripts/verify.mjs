import { execSync } from 'node:child_process';

const steps = [
  { name: 'Format Check', command: 'pnpm format:check' },
  { name: 'Lint', command: 'pnpm lint' },
  { name: 'Build', command: 'pnpm build' },
  { name: 'Type Check', command: 'pnpm type-check' },
  { name: 'Tests', command: 'pnpm test' },
];

console.log('🚀 Running repository verification suite...\n');

for (const step of steps) {
  console.log(`==> [${step.name}] running '${step.command}'...`);
  try {
    execSync(step.command, { stdio: 'inherit' });
    console.log(`✓ [${step.name}] passed\n`);
  } catch (_error) {
    console.error(`\n❌ [${step.name}] failed!`);
    process.exit(1);
  }
}

console.log('✅ All verification checks passed successfully!');
