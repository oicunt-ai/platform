import { describe, expect, it } from 'vitest';
import { DatabaseMigrator } from '../../src/infrastructure/database/migrator.js';
import type { DatabasePool } from '../../src/infrastructure/database/connection.js';

describe('Usage Database Migrations', () => {
  it('discovers 001_initial_usage_schema.sql and verifies valid DDL statements', () => {
    const migrator = new DatabaseMigrator({} as unknown as DatabasePool);
    const files = migrator.getMigrationFiles();

    expect(files.length).toBeGreaterThanOrEqual(1);
    expect(files[0]!.name).toBe('001_initial_usage_schema.sql');
    expect(files[0]!.sql).toContain('CREATE SCHEMA IF NOT EXISTS oicunt_usage');
    expect(files[0]!.sql).toContain('CREATE TABLE IF NOT EXISTS oicunt_usage.usage_events');
    expect(files[0]!.sql).toContain(
      'CONSTRAINT uq_usage_events_idempotency UNIQUE (tenant_id, idempotency_key)',
    );
    expect(files[0]!.sql).toContain(
      'CREATE TABLE IF NOT EXISTS oicunt_usage.usage_aggregates_hourly',
    );
    expect(files[0]!.sql).toContain(
      'CREATE TABLE IF NOT EXISTS oicunt_usage.usage_aggregates_daily',
    );
    expect(files[0]!.sql).toContain('uq_usage_events_reversal_parent');
    expect(files[0]!.sql).toContain('prevent_usage_events_mutation');
    expect(files[0]!.sql).toContain('trg_prevent_usage_events_update');
    expect(files[0]!.sql).toContain('trg_prevent_usage_events_delete');
  });
});
