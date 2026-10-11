import type { DatabasePool } from './connection.js';
import { DatabaseMigrator } from './migrator.js';

export interface SchemaCompatibilityReport {
  readonly compatible: boolean;
  /** Human-readable problem descriptions; empty when compatible. */
  readonly problems: readonly string[];
}

/** Tables the running service depends on (see migrations 001/002). */
export const REQUIRED_SCHEMA_TABLES = [
  'usage_events',
  'usage_aggregates_hourly',
  'usage_aggregates_daily',
  'admission_windows',
  'admission_leases',
] as const;

/** Columns per table that current query paths cannot work without. */
export const REQUIRED_SCHEMA_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  usage_events: ['event_id', 'tenant_id', 'idempotency_key', 'occurred_at', 'measurements'],
  admission_leases: ['id', 'tenant_id', 'user_id', 'expires_at'],
};

/**
 * Read-only schema compatibility verification for the Usage service.
 *
 * Confirms that (a) the migration ledger exists, (b) every migration shipped
 * with this build is recorded as applied, and (c) the critical tables/columns
 * the service queries actually exist. Ledger presence alone is deliberately
 * NOT treated as proof of physical schema integrity, so (c) is checked
 * independently against the catalog.
 *
 * This function issues SELECT/catalog queries only: no DDL, no migrations,
 * no writes of any kind. It throws when the database is unreachable, which
 * callers translate into a startup failure.
 */
export async function verifyUsageSchemaCompatibility(
  db: DatabasePool,
  migrationFileNames: readonly string[] = new DatabaseMigrator(db)
    .getMigrationFiles()
    .map((file) => file.name),
): Promise<SchemaCompatibilityReport> {
  const problems: string[] = [];

  // 1. Migration ledger must exist.
  const ledger = await db.query<{ present: boolean }>(
    `SELECT EXISTS (
       SELECT 1
       FROM information_schema.tables
       WHERE table_schema = 'oicunt_usage' AND table_name = '_migrations'
     ) AS present`,
  );
  if (!ledger.rows[0]?.present) {
    return {
      compatible: false,
      problems: [
        "migration ledger 'oicunt_usage._migrations' is missing (run the migrate command)",
      ],
    };
  }

  // 2. Every migration shipped with this build must be recorded as applied.
  const applied = await db.query<{ name: string }>('SELECT name FROM oicunt_usage._migrations');
  const appliedNames = new Set(applied.rows.map((row) => row.name));
  for (const name of migrationFileNames) {
    if (!appliedNames.has(name)) {
      problems.push(`migration '${name}' is not recorded as applied in the ledger`);
    }
  }

  // 3. Physical schema objects required by the current code paths.
  const tables = await db.query<{ table_name: string }>(
    `SELECT table_name
     FROM information_schema.tables
     WHERE table_schema = 'oicunt_usage'`,
  );
  const presentTables = new Set(tables.rows.map((row) => row.table_name));
  const missingTables = REQUIRED_SCHEMA_TABLES.filter((table) => !presentTables.has(table));
  for (const table of missingTables) {
    problems.push(`required table 'oicunt_usage.${table}' is missing`);
  }

  // 4. Critical columns (a table can exist while being structurally wrong).
  const missingColumns: string[] = [];
  for (const [table, columns] of Object.entries(REQUIRED_SCHEMA_COLUMNS)) {
    if (!presentTables.has(table)) {
      continue; // Already reported as a missing table.
    }
    const existing = await db.query<{ column_name: string }>(
      `SELECT column_name
       FROM information_schema.columns
       WHERE table_schema = 'oicunt_usage' AND table_name = $1`,
      [table],
    );
    const presentColumns = new Set(existing.rows.map((row) => row.column_name));
    for (const column of columns) {
      if (!presentColumns.has(column)) {
        missingColumns.push(`oicunt_usage.${table}.${column}`);
      }
    }
  }
  for (const qualified of missingColumns) {
    problems.push(`required column '${qualified}' is missing`);
  }

  return { compatible: problems.length === 0, problems };
}
