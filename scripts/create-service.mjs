import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';

const rootDir = process.cwd();
const serviceName = process.argv[2];

if (!serviceName) {
  console.error('❌ Error: Service name is required.');
  console.log('Usage: node scripts/create-service.mjs <service-name>');
  console.log('Example: node scripts/create-service.mjs notification-service');
  process.exit(1);
}

const isValidName = /^[a-z0-9]+(-[a-z0-9]+)*$/.test(serviceName);
if (!isValidName) {
  console.error(
    `❌ Error: Invalid service name '${serviceName}'. Must be kebab-case (e.g. my-service).`,
  );
  process.exit(1);
}

const templateDir = resolve(rootDir, 'templates/service');
const targetDir = resolve(rootDir, 'services', serviceName);

if (!existsSync(templateDir)) {
  console.error(`❌ Error: Template directory not found at '${templateDir}'`);
  process.exit(1);
}

if (existsSync(targetDir)) {
  console.error(`❌ Error: Service '${serviceName}' already exists at '${targetDir}'`);
  process.exit(1);
}

console.log(`🚀 Scaffolding new service '${serviceName}' from template...`);

// 1. Copy template files
mkdirSync(targetDir, { recursive: true });
cpSync(templateDir, targetDir, { recursive: true });

// 2. Customize package.json
const pkgPath = join(targetDir, 'package.json');
if (existsSync(pkgPath)) {
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
  pkg.name = `@oicunt/service-${serviceName}`;
  pkg.description = `OICUNT platform ${serviceName} microservice`;
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
}

// 3. Customize config default service name
const configPath = join(targetDir, 'src/config.ts');
if (existsSync(configPath)) {
  let configContent = readFileSync(configPath, 'utf-8');
  configContent = configContent.replace("'service-template'", `'${serviceName}'`);
  writeFileSync(configPath, configContent);
}

console.log(`\n✅ Service '${serviceName}' successfully created at 'services/${serviceName}'!`);
console.log('\nNext steps:');
console.log(
  `  1. Add '{ "path": "./services/${serviceName}" }' to the references in root tsconfig.json`,
);
console.log('  2. Run: pnpm install');
console.log('  3. Run: pnpm verify\n');
