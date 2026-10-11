import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { UsageService } from './service.js';
import type { UsageConfig } from './config.js';
import { DatabasePool } from './infrastructure/database/connection.js';
import { verifyUsageSchemaCompatibility } from './infrastructure/database/schema-compat.js';

const SERVICE_NAME = 'usage';
const MIN_PORT = 1;
const MAX_PORT = 65535;

function isValidPort(value: number | undefined): value is number {
  return (
    typeof value === 'number' && Number.isInteger(value) && value >= MIN_PORT && value <= MAX_PORT
  );
}

/** Broker URLs must be explicitly well-formed amqp:// or amqps:// endpoints. */
export function isValidBrokerUrl(value: string | undefined): boolean {
  if (!value || value.trim() === '') {
    return false;
  }
  try {
    const parsed = new URL(value);
    // A scheme alone ('amqp://') parses for non-special schemes, so the
    // broker must also carry an explicit host.
    return (
      (parsed.protocol === 'amqp:' || parsed.protocol === 'amqps:') && parsed.hostname.length > 0
    );
  } catch {
    return false;
  }
}

/**
 * Fail-closed requirements for a real standalone Usage process. Returns
 * the names of missing or invalid configuration; an empty array means
 * startup may proceed. Unit-testable and side-effect free: it only reads
 * the config, and it reads exactly the same normalized fields that
 * UsageService uses to build the PostgreSQL pool and the RabbitMQ
 * consumer, so validation and dependency selection cannot disagree.
 */
export function validateStartupConfig(config: UsageConfig): string[] {
  const missing: string[] = [];

  // Internal authentication must exist; an empty or blank token is treated
  // exactly like a missing one (no fail-open, no hardcoded default).
  if (!config.internalToken || config.internalToken.trim() === '') {
    missing.push('PLATFORM_USAGE_INTERNAL_TOKEN');
  }

  // HTTP listener.
  if (!isValidPort(config.port)) {
    missing.push(`USAGE_SERVICE_PORT (integer ${MIN_PORT}-${MAX_PORT})`);
  }
  if (!config.host || config.host.trim() === '') {
    missing.push('USAGE_SERVICE_HOST');
  }

  // PostgreSQL. USE_DATABASE=false (or absent database configuration) is
  // refused outright: a real standalone process may never fall back to
  // in-memory repositories.
  if (!config.useDatabase) {
    missing.push(
      'USE_DATABASE=true with DATABASE_HOST/PORT/USER/PASSWORD (or USAGE_DB_* variants)',
    );
  } else {
    if (!config.database.host || config.database.host.trim() === '') {
      missing.push('DATABASE_HOST (or USAGE_DB_HOST)');
    }
    if (!isValidPort(config.database.port)) {
      missing.push(`DATABASE_PORT (or USAGE_DB_PORT, integer ${MIN_PORT}-${MAX_PORT})`);
    }
    if (!config.database.user || config.database.user.trim() === '') {
      missing.push('DATABASE_USER (or USAGE_DB_USER)');
    }
    if (!config.database.password || config.database.password === '') {
      missing.push('DATABASE_PASSWORD (or USAGE_DB_PASSWORD)');
    }
  }

  // RabbitMQ. USE_RABBITMQ=false (or absent broker configuration) is
  // refused outright: a real standalone process may never fall back to an
  // in-memory queue, and there is no implicit guest@localhost broker.
  if (!config.useRabbitMq) {
    missing.push('USE_RABBITMQ=true with RABBITMQ_URL');
  } else if (!isValidBrokerUrl(config.rabbitmqUrl)) {
    missing.push('RABBITMQ_URL (valid amqp:// or amqps:// URL)');
  }

  return missing;
}

/**
 * Read-only schema compatibility verification, performed before the HTTP
 * server is allowed to accept traffic. Returns problem descriptions; an
 * empty array means the deployed schema matches this build. Never issues
 * DDL or migrations and never writes: unreachable or incompatible schemas
 * are reported so startup fails closed.
 */
export async function verifyStartupSchema(config: UsageConfig): Promise<string[]> {
  if (!config.useDatabase) {
    return ['database is not configured, so the Usage schema cannot be verified'];
  }
  const pool = new DatabasePool(config.database);
  try {
    const report = await verifyUsageSchemaCompatibility(pool);
    return [...report.problems];
  } catch (err) {
    return [`schema verification failed: ${err instanceof Error ? err.message : String(err)}`];
  } finally {
    await pool.close().catch(() => {
      // Best effort: the verification pool is always released.
    });
  }
}

async function main(): Promise<void> {
  const service = new UsageService();
  const missing = validateStartupConfig(service.config);
  if (missing.length > 0) {
    console.error(
      `[${SERVICE_NAME}] refusing to start with incomplete configuration: ${missing.join(', ')}`,
    );
    process.exit(1);
  }

  // Verify the already-deployed schema without touching it. A missing or
  // incompatible schema prevents startup (and therefore readiness).
  const schemaProblems = await verifyStartupSchema(service.config);
  if (schemaProblems.length > 0) {
    console.error(
      `[${SERVICE_NAME}] refusing to start with an unverifiable schema: ${schemaProblems.join('; ')}`,
    );
    process.exit(1);
  }

  let shuttingDown = false;
  const shutdown = (): void => {
    if (shuttingDown) {
      process.exit(1);
    }
    shuttingDown = true;
    void service
      .stop()
      .then(() => process.exit(0))
      .catch(() => process.exit(1));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  try {
    // start() resolves void; the port comes from the same environment
    // configuration the service itself was constructed with.
    await service.start();
    // Port only: hosts, credentials, and URLs stay out of logs.
    console.log(`[${SERVICE_NAME}] listening on port ${service.config.port}`);
  } catch (error) {
    console.error(
      `[${SERVICE_NAME}] failed to start: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }
}

// Entrypoint only: importing this module (for example from './index.js')
// must never start the service as a side effect.
const invokedPath = process.argv[1] === undefined ? '' : resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) {
  void main();
}
