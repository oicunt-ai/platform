import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabasePool } from './infrastructure/database/connection.js';
import { loadUsageConfig } from './config.js';
import { DatabaseMigrator } from './infrastructure/database/migrator.js';

/**
 * Explicit Usage database migration entrypoint: `pnpm --filter usage migrate`.
 *
 * Applies pending migrations from dist/infrastructure/database/migrations
 * and exits. This is the ONLY supported way to change the Usage schema;
 * routine service startup never migrates (see service start()).
 */
async function main(): Promise<void> {
  const config = loadUsageConfig();
  if (!config.useDatabase) {
    console.error(
      '[usage] refusing to migrate without database configuration ' +
        '(set DATABASE_HOST/PORT/USER/PASSWORD or USAGE_DB_* variants)',
    );
    process.exit(1);
  }
  const pool = new DatabasePool(config.database);
  try {
    const result = await new DatabaseMigrator(pool).runMigrations();
    // Counts only: never log schema contents or credentials.
    console.log(
      `[usage] migrations applied=${result.applied.length} ` +
        `already-applied=${result.alreadyApplied.length}`,
    );
  } catch (error) {
    console.error(
      `[usage] migration failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  } finally {
    await pool.close().catch(() => {
      // Best effort during shutdown.
    });
  }
}

// Entrypoint only: importing this module must never migrate as a side effect.
const invokedPath = process.argv[1] === undefined ? '' : resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) {
  void main();
}
