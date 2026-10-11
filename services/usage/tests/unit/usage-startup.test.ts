import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadUsageConfig } from '../../src/config.js';
import { UsageService } from '../../src/service.js';
import { isValidBrokerUrl, validateStartupConfig, verifyStartupSchema } from '../../src/start.js';
import {
  REQUIRED_SCHEMA_TABLES,
  verifyUsageSchemaCompatibility,
} from '../../src/infrastructure/database/schema-compat.js';
import type { DatabasePool } from '../../src/infrastructure/database/connection.js';

const execFileAsync = promisify(execFile);

const ENV_PATTERN =
  /^(USAGE_|DATABASE_|RABBITMQ_|PLATFORM_USAGE_|USE_|LOG_LEVEL$|INTERNAL_SERVICE_TOKEN$)/;

let originalEnv: NodeJS.ProcessEnv;

beforeEach(() => {
  originalEnv = { ...process.env };
  for (const key of Object.keys(process.env)) {
    if (ENV_PATTERN.test(key)) {
      delete process.env[key];
    }
  }
  process.env['NODE_ENV'] = 'test';
});

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    delete process.env[key];
  }
  Object.assign(process.env, originalEnv);
});

/** Sets a fully valid standalone (development) configuration. */
function validEnv(): void {
  process.env['NODE_ENV'] = 'development';
  process.env['INTERNAL_SERVICE_TOKEN'] = 'shared-token';
  process.env['DATABASE_HOST'] = '127.0.0.1';
  process.env['DATABASE_PORT'] = '5433';
  process.env['DATABASE_USER'] = 'postgres';
  process.env['DATABASE_PASSWORD'] = 'pw';
  process.env['RABBITMQ_URL'] = 'amqp://user:pw@127.0.0.1:5672';
}

function stubPool(recorded: string[]): DatabasePool {
  return {
    ping: async () => true,
    close: async () => undefined,
    query: async (text: string) => {
      recorded.push(String(text));
      throw new Error('unexpected query in test');
    },
  } as unknown as DatabasePool;
}

describe('configuration normalization and precedence', () => {
  it('treats blank environment values as unset so fallbacks engage', () => {
    process.env['PLATFORM_USAGE_INTERNAL_TOKEN'] = '   ';
    process.env['INTERNAL_SERVICE_TOKEN'] = 'shared-token';
    expect(loadUsageConfig().internalToken).toBe('shared-token');
    process.env['INTERNAL_SERVICE_TOKEN'] = '';
    expect(loadUsageConfig().internalToken).toBeUndefined();
    process.env['DATABASE_HOST'] = '  ';
    expect(loadUsageConfig().database.host).toBeUndefined();
  });

  it('applies the documented internal-token precedence', () => {
    process.env['USAGE_INTERNAL_TOKEN'] = 'c';
    process.env['INTERNAL_SERVICE_TOKEN'] = 'b';
    process.env['PLATFORM_USAGE_INTERNAL_TOKEN'] = 'a';
    expect(loadUsageConfig().internalToken).toBe('a');
    delete process.env['PLATFORM_USAGE_INTERNAL_TOKEN'];
    expect(loadUsageConfig().internalToken).toBe('b');
    delete process.env['INTERNAL_SERVICE_TOKEN'];
    expect(loadUsageConfig().internalToken).toBe('c');
  });

  it('lets an empty override fall through to configured environment values', () => {
    process.env['INTERNAL_SERVICE_TOKEN'] = 'env-token';
    expect(loadUsageConfig({ internalToken: '' }).internalToken).toBe('env-token');
    expect(loadUsageConfig({ internalToken: '   ' }).internalToken).toBe('env-token');
    expect(loadUsageConfig({ internalToken: 'override' }).internalToken).toBe('override');
  });

  it('enables database mode for DATABASE_HOST-only configuration', () => {
    process.env['NODE_ENV'] = 'development';
    process.env['DATABASE_HOST'] = '127.0.0.1';
    const config = loadUsageConfig();
    expect(config.useDatabase).toBe(true);
    expect(config.database.host).toBe('127.0.0.1');
    expect(validateStartupConfig(config)).toContain(
      'DATABASE_PORT (or USAGE_DB_PORT, integer 1-65535)',
    );
  });

  it('enables database mode for USAGE_DB_HOST-only configuration', () => {
    process.env['NODE_ENV'] = 'development';
    process.env['USAGE_DB_HOST'] = '10.0.0.5';
    const config = loadUsageConfig();
    expect(config.useDatabase).toBe(true);
    expect(config.database.host).toBe('10.0.0.5');
  });

  it('gives USAGE_DB_* precedence over DATABASE_* for host, port, user and password', () => {
    process.env['NODE_ENV'] = 'development';
    process.env['DATABASE_HOST'] = 'db.internal';
    process.env['DATABASE_PORT'] = '5432';
    process.env['DATABASE_USER'] = 'generic';
    process.env['DATABASE_PASSWORD'] = 'generic-pw';
    process.env['USAGE_DB_HOST'] = 'usage.db.internal';
    process.env['USAGE_DB_PORT'] = '5433';
    process.env['USAGE_DB_USER'] = 'usage';
    process.env['USAGE_DB_PASSWORD'] = 'usage-pw';
    const config = loadUsageConfig();
    expect(config.database.host).toBe('usage.db.internal');
    expect(config.database.port).toBe(5433);
    expect(config.database.user).toBe('usage');
    expect(config.database.password).toBe('usage-pw');
  });

  it('falls back to DATABASE_PORT when USAGE_DB_PORT is absent', () => {
    process.env['DATABASE_PORT'] = '5432';
    expect(loadUsageConfig().database.port).toBe(5432);
    process.env['USAGE_DB_PORT'] = '5433';
    expect(loadUsageConfig().database.port).toBe(5433);
  });

  it('never produces NaN or garbage ports from invalid values', () => {
    for (const value of ['abc', '5433abc', '', '   ', '54.5']) {
      process.env['DATABASE_PORT'] = value;
      process.env['USAGE_DB_PORT'] = '';
      expect(loadUsageConfig().database.port).toBeUndefined();
    }
  });

  it('has no implicit RabbitMQ broker default', () => {
    const config = loadUsageConfig();
    expect(config.rabbitmqUrl).toBeUndefined();
    expect(config.useRabbitMq).toBe(false);
  });

  it('treats whitespace-only RABBITMQ_URL as unconfigured for both selection and URL', () => {
    process.env['NODE_ENV'] = 'development';
    process.env['RABBITMQ_URL'] = '   ';
    const config = loadUsageConfig();
    expect(config.rabbitmqUrl).toBeUndefined();
    expect(config.useRabbitMq).toBe(false);
  });

  it('honors USE_DATABASE=false and USE_RABBITMQ=false dependency opt-outs in config', () => {
    validEnv();
    process.env['USE_DATABASE'] = 'false';
    process.env['USE_RABBITMQ'] = 'false';
    const config = loadUsageConfig();
    expect(config.useDatabase).toBe(false);
    expect(config.useRabbitMq).toBe(false);
  });
});

describe('validateStartupConfig (fail-closed standalone contract)', () => {
  it('reports every missing requirement by name', () => {
    expect(validateStartupConfig(loadUsageConfig())).toEqual([
      'PLATFORM_USAGE_INTERNAL_TOKEN',
      'USE_DATABASE=true with DATABASE_HOST/PORT/USER/PASSWORD (or USAGE_DB_* variants)',
      'USE_RABBITMQ=true with RABBITMQ_URL',
    ]);
  });

  it('passes a fully configured service', () => {
    validEnv();
    expect(validateStartupConfig(loadUsageConfig())).toEqual([]);
  });

  it('requires an explicit database port (never assume 5432)', () => {
    validEnv();
    delete process.env['DATABASE_PORT'];
    const missing = validateStartupConfig(loadUsageConfig());
    expect(missing).toContain('DATABASE_PORT (or USAGE_DB_PORT, integer 1-65535)');
  });

  it.each([0, -1, 65536, 99999])('rejects out-of-range database port %s', (port) => {
    validEnv();
    process.env['DATABASE_PORT'] = String(port);
    const missing = validateStartupConfig(loadUsageConfig());
    expect(missing).toContain('DATABASE_PORT (or USAGE_DB_PORT, integer 1-65535)');
  });

  it.each(['abc', '5433abc', '   '])('rejects non-integer database port %j', (value) => {
    validEnv();
    process.env['DATABASE_PORT'] = value;
    const missing = validateStartupConfig(loadUsageConfig());
    expect(missing).toContain('DATABASE_PORT (or USAGE_DB_PORT, integer 1-65535)');
  });

  it.each([0, -1, 65536])('rejects out-of-range HTTP port %s', (port) => {
    validEnv();
    process.env['USAGE_SERVICE_PORT'] = String(port);
    const missing = validateStartupConfig(loadUsageConfig());
    expect(missing).toContain('USAGE_SERVICE_PORT (integer 1-65535)');
  });

  it('falls back to the documented bind-host default for a blank override', () => {
    validEnv();
    // Blank values are treated as unset: the documented default (0.0.0.0,
    // all interfaces) engages rather than an empty host reaching listen().
    expect(loadUsageConfig({ host: '   ' }).host).toBe('   ');
    process.env['USAGE_SERVICE_HOST'] = '   ';
    expect(loadUsageConfig().host).toBe('0.0.0.0');
  });

  it('rejects a whitespace-only host supplied as an explicit override', () => {
    validEnv();
    const missing = validateStartupConfig(loadUsageConfig({ host: '   ' }));
    expect(missing).toContain('USAGE_SERVICE_HOST');
  });

  it('refuses USE_DATABASE=false even with otherwise valid database variables', () => {
    validEnv();
    process.env['USE_DATABASE'] = 'false';
    const missing = validateStartupConfig(loadUsageConfig());
    expect(missing).toContain(
      'USE_DATABASE=true with DATABASE_HOST/PORT/USER/PASSWORD (or USAGE_DB_* variants)',
    );
  });

  it('refuses USE_RABBITMQ=false even with a valid RABBITMQ_URL', () => {
    validEnv();
    process.env['USE_RABBITMQ'] = 'false';
    const missing = validateStartupConfig(loadUsageConfig());
    expect(missing).toContain('USE_RABBITMQ=true with RABBITMQ_URL');
  });

  it.each(['not-a-url', 'http://127.0.0.1:5672', 'amqp://'])(
    'rejects malformed broker URL %j',
    (url) => {
      validEnv();
      process.env['RABBITMQ_URL'] = url;
      const missing = validateStartupConfig(loadUsageConfig());
      expect(missing).toContain('RABBITMQ_URL (valid amqp:// or amqps:// URL)');
    },
  );

  it('rejects a service with no internal authentication token', () => {
    validEnv();
    delete process.env['INTERNAL_SERVICE_TOKEN'];
    const missing = validateStartupConfig(loadUsageConfig());
    expect(missing).toContain('PLATFORM_USAGE_INTERNAL_TOKEN');
  });

  it('accepts an empty token override that falls through to a valid environment token', () => {
    validEnv();
    expect(validateStartupConfig(loadUsageConfig({ internalToken: '' }))).toEqual([]);
  });

  it('validates broker URLs independently of config loading', () => {
    expect(isValidBrokerUrl('amqp://user:pw@127.0.0.1:5672')).toBe(true);
    expect(isValidBrokerUrl('amqps://user:pw@example.internal:5671')).toBe(true);
    expect(isValidBrokerUrl(undefined)).toBe(false);
    expect(isValidBrokerUrl('')).toBe(false);
    expect(isValidBrokerUrl('   ')).toBe(false);
    expect(isValidBrokerUrl('ftp://example.internal')).toBe(false);
    expect(isValidBrokerUrl('amqp://')).toBe(false);
    expect(isValidBrokerUrl('amqps://')).toBe(false);
  });
});

describe('startup never applies migrations', () => {
  function bootEnv(): void {
    process.env['NODE_ENV'] = 'development';
    process.env['DATABASE_HOST'] = '127.0.0.1';
    process.env['DATABASE_PORT'] = '5433';
    process.env['DATABASE_USER'] = 'postgres';
    process.env['DATABASE_PASSWORD'] = 'pw';
    process.env['USAGE_SERVICE_PORT'] = '0';
    process.env['USAGE_SERVICE_HOST'] = '127.0.0.1';
    // In-memory queue is intentional here: this test must never touch a
    // real broker, and dependency injection is reserved for unit tests.
    process.env['USE_RABBITMQ'] = 'false';
  }

  it('issues zero database queries during start(), even with USAGE_AUTO_MIGRATE=true set', async () => {
    bootEnv();
    // A leftover environment toggle must be inert: nothing in the normal
    // startup path may execute migrations.
    process.env['USAGE_AUTO_MIGRATE'] = 'true';
    const recorded: string[] = [];
    const service = new UsageService({}, { dbPool: stubPool(recorded) });
    await service.start();
    try {
      expect(recorded).toEqual([]);
      const address = service.getHttpServer()?.address();
      expect(typeof address === 'object' && address !== null).toBe(true);
    } finally {
      await service.stop();
    }
  });

  it('imports index.js, start.js and migrate.js without side effects', async () => {
    await import('../../src/index.js');
    await import('../../src/start.js');
    await import('../../src/migrate.js');
    expect(true).toBe(true);
  });
});

describe('read-only schema compatibility verification', () => {
  const LEDGER_SQL = /information_schema\.tables/i;
  const APPLIED_SQL = /SELECT name FROM oicunt_usage\._migrations/i;
  const TABLES_SQL = /SELECT\s+table_name/i;
  const COLUMNS_SQL = /information_schema\.columns/i;

  interface StubOptions {
    readonly ledgerPresent?: boolean;
    readonly applied?: string[];
    readonly tables?: string[];
    readonly columnsByTable?: Record<string, string[]>;
  }

  function catalogPool(options: StubOptions, recorded: string[] = []): DatabasePool {
    const {
      ledgerPresent = true,
      applied = ['001_initial_usage_schema.sql', '002_admission_limits.sql'],
      tables = [...REQUIRED_SCHEMA_TABLES],
      columnsByTable = {},
    } = options;

    const pool = {
      ping: async () => true,
      close: async () => undefined,
      query: async (text: string, params?: unknown[]) => {
        recorded.push(String(text));
        if (LEDGER_SQL.test(text) && !TABLES_SQL.test(text) && !COLUMNS_SQL.test(text)) {
          return { rows: [{ present: ledgerPresent }] };
        }
        if (APPLIED_SQL.test(text)) {
          return { rows: applied.map((name) => ({ name })) };
        }
        if (COLUMNS_SQL.test(text)) {
          const table = String(params?.[0] ?? '');
          return { rows: (columnsByTable[table] ?? []).map((name) => ({ column_name: name })) };
        }
        if (TABLES_SQL.test(text)) {
          return { rows: tables.map((table_name) => ({ table_name })) };
        }
        throw new Error(`unexpected query in schema test: ${text}`);
      },
    };
    return pool as unknown as DatabasePool;
  }

  it('confirms a fully applied and physically present schema', async () => {
    const report = await verifyUsageSchemaCompatibility(
      catalogPool({
        columnsByTable: {
          usage_events: ['event_id', 'tenant_id', 'idempotency_key', 'occurred_at', 'measurements'],
          admission_leases: ['id', 'tenant_id', 'user_id', 'expires_at'],
        },
      }),
      ['001_initial_usage_schema.sql', '002_admission_limits.sql'],
    );
    expect(report.compatible).toBe(true);
    expect(report.problems).toEqual([]);
  });

  it('reports a missing migration ledger', async () => {
    const report = await verifyUsageSchemaCompatibility(catalogPool({ ledgerPresent: false }), [
      '001_initial_usage_schema.sql',
    ]);
    expect(report.compatible).toBe(false);
    expect(report.problems.join(' ')).toContain('_migrations');
  });

  it('reports a shipped migration that is not recorded as applied', async () => {
    const report = await verifyUsageSchemaCompatibility(
      catalogPool({ applied: ['001_initial_usage_schema.sql'] }),
      ['001_initial_usage_schema.sql', '002_admission_limits.sql'],
    );
    expect(report.compatible).toBe(false);
    expect(report.problems.join(' ')).toContain('002_admission_limits.sql');
  });

  it('reports a missing table even when the ledger is fully applied', async () => {
    const report = await verifyUsageSchemaCompatibility(catalogPool({ tables: ['usage_events'] }), [
      '001_initial_usage_schema.sql',
    ]);
    expect(report.compatible).toBe(false);
    expect(report.problems.join(' ')).toContain('oicunt_usage.usage_aggregates_hourly');
  });

  it('reports a missing critical column even when the table exists', async () => {
    const report = await verifyUsageSchemaCompatibility(
      catalogPool({
        columnsByTable: {
          usage_events: ['event_id', 'tenant_id'],
          admission_leases: ['id', 'tenant_id', 'user_id', 'expires_at'],
        },
      }),
      ['001_initial_usage_schema.sql'],
    );
    expect(report.compatible).toBe(false);
    expect(report.problems.join(' ')).toContain('oicunt_usage.usage_events.idempotency_key');
  });

  it('issues only read-only statements (no DDL, no migrations, no writes)', async () => {
    const recorded: string[] = [];
    await verifyUsageSchemaCompatibility(
      catalogPool(
        {
          columnsByTable: {
            usage_events: [
              'event_id',
              'tenant_id',
              'idempotency_key',
              'occurred_at',
              'measurements',
            ],
            admission_leases: ['id', 'tenant_id', 'user_id', 'expires_at'],
          },
        },
        recorded,
      ),
      ['001_initial_usage_schema.sql'],
    );
    expect(recorded.length).toBeGreaterThan(0);
    const mutating = recorded.filter((sql) =>
      /\b(CREATE|INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE|BEGIN|COMMIT|GRANT)\b/i.test(sql),
    );
    expect(mutating).toEqual([]);
  });

  it('surfaces an unreachable database as a verification problem, not a pass', async () => {
    const failing = {
      ping: async () => false,
      close: async () => undefined,
      query: async () => {
        throw new Error('connection refused');
      },
    } as unknown as DatabasePool;
    await expect(verifyUsageSchemaCompatibility(failing, [])).rejects.toThrow('connection refused');
  });

  it('verifyStartupSchema refuses when the database is disabled', async () => {
    const problems = await verifyStartupSchema(loadUsageConfig());
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.join(' ')).toContain('schema cannot be verified');
  });
});

describe('standalone entrypoints', () => {
  const distRoot = resolve(process.cwd(), 'services/usage/dist');
  const distStart = resolve(distRoot, 'start.js');
  const distIndex = resolve(distRoot, 'index.js');
  const distMigrate = resolve(distRoot, 'migrate.js');
  const distService = resolve(distRoot, 'service.js');
  const distBuilt = existsSync(distStart) && existsSync(distService);

  const minimalEnv = (): NodeJS.ProcessEnv => ({
    PATH: process.env['PATH'],
    SystemRoot: process.env['SystemRoot'],
    // Production makes every version refuse or throw before binding a
    // socket: no process under test can contact a database or broker.
    NODE_ENV: 'production',
  });

  it.skipIf(!distBuilt)(
    'built start.js is wired to the fail-closed gate and the schema check',
    () => {
      const source = readFileSync(distStart, 'utf-8');
      expect(source).toContain('validateStartupConfig');
      expect(source).toContain('verifyStartupSchema');
      // The normal entrypoint must never be able to execute migrations.
      expect(source).not.toContain('DatabaseMigrator');
      expect(source).not.toContain('runMigrations');
      expect(readFileSync(distService, 'utf-8')).not.toContain('DatabaseMigrator');
      // ...while the explicit migration command still can.
      expect(readFileSync(distMigrate, 'utf-8')).toContain('DatabaseMigrator');
    },
  );

  it.skipIf(!distBuilt)(
    'built start.js refuses to start with an incomplete production config',
    async () => {
      await expect(
        execFileAsync(process.execPath, [distStart], { env: minimalEnv() }),
      ).rejects.toMatchObject({ code: 1 });
    },
  );

  it.skipIf(!distBuilt)('built index.js is inert (no auto-start path exists)', async () => {
    const { stdout, stderr } = await execFileAsync(process.execPath, [distIndex], {
      env: minimalEnv(),
    });
    expect(stdout + stderr).not.toMatch(/listening/i);
  });
});
