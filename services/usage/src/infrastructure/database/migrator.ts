import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DatabasePool } from './connection.js';

export interface MigrationResult {
  readonly applied: readonly string[];
  readonly alreadyApplied: readonly string[];
}

export class DatabaseMigrator {
  /** Deterministic 32-bit positive integer lock identifier for Usage Service */
  public static readonly ADVISORY_LOCK_ID = 852914399;

  constructor(private readonly db: DatabasePool) {}

  public async runMigrations(): Promise<MigrationResult> {
    await this.ensureMigrationTable();

    // Acquire PostgreSQL advisory lock to prevent concurrent migrations
    await this.db.query('SELECT pg_advisory_lock($1)', [DatabaseMigrator.ADVISORY_LOCK_ID]);

    try {
      const appliedSet = await this.getAppliedMigrations();
      const migrationFiles = this.getMigrationFiles();

      const newlyApplied: string[] = [];
      const alreadyApplied: string[] = [];

      for (const file of migrationFiles) {
        if (appliedSet.has(file.name)) {
          alreadyApplied.push(file.name);
          continue;
        }

        await this.db.withTransaction(async (client) => {
          await client.query(file.sql);
          await client.query('INSERT INTO oicunt_usage._migrations (name) VALUES ($1)', [
            file.name,
          ]);
        });

        newlyApplied.push(file.name);
      }

      return {
        applied: Object.freeze(newlyApplied),
        alreadyApplied: Object.freeze(alreadyApplied),
      };
    } finally {
      await this.db.query('SELECT pg_advisory_unlock($1)', [DatabaseMigrator.ADVISORY_LOCK_ID]);
    }
  }

  private async ensureMigrationTable(): Promise<void> {
    await this.db.query('CREATE SCHEMA IF NOT EXISTS oicunt_usage');
    await this.db.query(`
      CREATE TABLE IF NOT EXISTS oicunt_usage._migrations (
        name VARCHAR(255) PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
  }

  private async getAppliedMigrations(): Promise<Set<string>> {
    const result = await this.db.query<{ name: string }>(
      'SELECT name FROM oicunt_usage._migrations ORDER BY name ASC',
    );
    return new Set(result.rows.map((row) => row.name));
  }

  public getMigrationFiles(): readonly { name: string; sql: string }[] {
    const currentDir = dirname(fileURLToPath(import.meta.url));
    const candidatePaths = [
      join(currentDir, 'migrations'),
      join(currentDir, '..', 'src', 'infrastructure', 'database', 'migrations'),
      join(process.cwd(), 'services', 'usage', 'src', 'infrastructure', 'database', 'migrations'),
      join(process.cwd(), 'src', 'infrastructure', 'database', 'migrations'),
    ];

    let migrationsDir: string | null = null;
    for (const candidate of candidatePaths) {
      if (existsSync(candidate)) {
        migrationsDir = candidate;
        break;
      }
    }

    if (!migrationsDir) {
      return [];
    }

    const files = readdirSync(migrationsDir)
      .filter((file) => file.endsWith('.sql'))
      .sort();

    return files.map((fileName) => ({
      name: fileName,
      sql: readFileSync(join(migrationsDir, fileName), 'utf-8'),
    }));
  }
}
