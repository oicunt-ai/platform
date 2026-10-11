import type { DatabasePoolConfig } from './infrastructure/database/connection.js';
import type { LogLevel } from './infrastructure/logging/logger.js';

export interface UsageConfig {
  readonly serviceName: string;
  readonly port: number;
  readonly host: string;
  readonly internalToken?: string | undefined;
  readonly database: DatabasePoolConfig;
  readonly useDatabase: boolean;
  readonly logLevel: LogLevel;
  /** Broker URL. Undefined when unconfigured: never defaulted, never guessed. */
  readonly rabbitmqUrl: string | undefined;
  readonly useRabbitMq: boolean;
  readonly rabbitmqExchange: string;
  readonly rabbitmqQueue: string;
  readonly rabbitmqDlx: string;
  readonly rabbitmqDlq: string;
  readonly rabbitmqRoutingKeyPattern: string;
  readonly rabbitmqPrefetch: number;
  readonly tenantRequestsPerMinute: number;
  readonly userRequestsPerMinute: number;
  readonly tenantConcurrentStreams: number;
  readonly admissionLeaseSeconds: number;
}

export function loadUsageConfig(overrides: Partial<UsageConfig> = {}): UsageConfig {
  const isTest = process.env['NODE_ENV'] === 'test';

  // Blank environment values are treated as unset so that documented
  // fallbacks engage instead of silently locking in empty strings (which
  // previously bypassed token checks and pointed clients at wrong hosts).
  const clean = (value: string | undefined): string | undefined => {
    if (value === undefined) {
      return undefined;
    }
    const trimmed = value.trim();
    return trimmed === '' ? undefined : trimmed;
  };

  // Strict integer parsing: '5433', ' 5433 ' parse; '5433abc', 'abc' and
  // '' become undefined so startup validation can reject them explicitly
  // instead of handing NaN to the driver.
  const parseInteger = (value: string | undefined): number | undefined => {
    const text = clean(value);
    if (text === undefined) {
      return undefined;
    }
    const parsed = Number(text);
    return Number.isInteger(parsed) ? parsed : undefined;
  };

  const config: UsageConfig = {
    serviceName: overrides.serviceName ?? 'usage',
    port: overrides.port ?? parseInteger(process.env['USAGE_SERVICE_PORT']) ?? 8090,
    // Bind host: defaults to ALL interfaces (0.0.0.0). Operators who want a
    // loopback-only service MUST set USAGE_SERVICE_HOST=127.0.0.1; this is
    // documented in .env.example and docs/development.md. Never silently
    // changed here, because callers depend on the historical default.
    host: overrides.host ?? clean(process.env['USAGE_SERVICE_HOST']) ?? '0.0.0.0',
    internalToken:
      clean(overrides.internalToken) ??
      clean(process.env['PLATFORM_USAGE_INTERNAL_TOKEN']) ??
      clean(process.env['INTERNAL_SERVICE_TOKEN']) ??
      clean(process.env['USAGE_INTERNAL_TOKEN']),
    database: {
      host:
        overrides.database?.host ??
        clean(process.env['USAGE_DB_HOST']) ??
        clean(process.env['DATABASE_HOST']),
      port:
        overrides.database?.port ??
        parseInteger(process.env['USAGE_DB_PORT']) ??
        parseInteger(process.env['DATABASE_PORT']),
      database:
        overrides.database?.database ??
        clean(process.env['USAGE_DB_NAME']) ??
        clean(process.env['DATABASE_NAME']) ??
        'oicunt_usage',
      user:
        overrides.database?.user ??
        clean(process.env['USAGE_DB_USER']) ??
        clean(process.env['DATABASE_USER']),
      password:
        overrides.database?.password ??
        clean(process.env['USAGE_DB_PASSWORD']) ??
        clean(process.env['DATABASE_PASSWORD']),
      ssl:
        overrides.database?.ssl ??
        (process.env['DATABASE_SSL'] === 'true' ? { rejectUnauthorized: false } : undefined),
    },
    // Dependency selection reads the SAME normalized values that
    // validateStartupConfig() and the PostgreSQL pool consume, so a
    // configuration can never validate against one host/port and connect
    // with another (USAGE_DB_* always wins over DATABASE_*).
    useDatabase:
      overrides.useDatabase ??
      (!isTest &&
        process.env['USE_DATABASE'] !== 'false' &&
        Boolean(clean(process.env['USAGE_DB_HOST']) ?? clean(process.env['DATABASE_HOST']))),
    logLevel:
      overrides.logLevel ??
      ((process.env['LOG_LEVEL'] as LogLevel) || (isTest ? 'silent' : 'info')),
    // No hardcoded guest@localhost fallback: an absent or blank broker URL
    // stays undefined so validateStartupConfig() refuses standalone boot.
    rabbitmqUrl: overrides.rabbitmqUrl ?? clean(process.env['RABBITMQ_URL']),
    useRabbitMq:
      overrides.useRabbitMq ??
      (!isTest &&
        process.env['USE_RABBITMQ'] !== 'false' &&
        Boolean(clean(process.env['RABBITMQ_URL']))),
    rabbitmqExchange:
      overrides.rabbitmqExchange ?? process.env['USAGE_RABBITMQ_EXCHANGE'] ?? 'oicunt.usage',
    rabbitmqQueue:
      overrides.rabbitmqQueue ?? process.env['USAGE_RABBITMQ_QUEUE'] ?? 'oicunt.usage.events',
    rabbitmqDlx: overrides.rabbitmqDlx ?? process.env['USAGE_RABBITMQ_DLX'] ?? 'oicunt.usage.dlx',
    rabbitmqDlq: overrides.rabbitmqDlq ?? process.env['USAGE_RABBITMQ_DLQ'] ?? 'oicunt.usage.dlq',
    rabbitmqRoutingKeyPattern:
      overrides.rabbitmqRoutingKeyPattern ??
      process.env['USAGE_RABBITMQ_ROUTING_KEY'] ??
      'usage.v1.#',
    rabbitmqPrefetch:
      overrides.rabbitmqPrefetch ??
      Number.parseInt(process.env['USAGE_RABBITMQ_PREFETCH'] ?? '50', 10),
    tenantRequestsPerMinute:
      overrides.tenantRequestsPerMinute ??
      Number.parseInt(process.env['TENANT_REQUESTS_PER_MINUTE'] ?? '120', 10),
    userRequestsPerMinute:
      overrides.userRequestsPerMinute ??
      Number.parseInt(process.env['USER_REQUESTS_PER_MINUTE'] ?? '30', 10),
    tenantConcurrentStreams:
      overrides.tenantConcurrentStreams ??
      Number.parseInt(process.env['TENANT_CONCURRENT_STREAMS'] ?? '20', 10),
    admissionLeaseSeconds:
      overrides.admissionLeaseSeconds ??
      Number.parseInt(process.env['ADMISSION_LEASE_SECONDS'] ?? '300', 10),
  };

  if (process.env['NODE_ENV'] === 'production') {
    const missing = [
      ['PLATFORM_USAGE_INTERNAL_TOKEN', config.internalToken],
      ['DATABASE_HOST', config.database.host],
      [
        'DATABASE_PORT',
        config.database.port === undefined ? undefined : String(config.database.port),
      ],
      ['DATABASE_USER', config.database.user],
      ['DATABASE_PASSWORD', config.database.password],
      ['RABBITMQ_URL', config.rabbitmqUrl],
    ].filter(([, value]) => !value || value.trim().length === 0);
    if (!config.useDatabase) missing.push(['USE_DATABASE', 'true']);
    if (!config.useRabbitMq) missing.push(['USE_RABBITMQ', 'true']);
    if (missing.length > 0) {
      throw new Error(
        `Usage production configuration is incomplete: ${missing.map(([name]) => name).join(', ')}`,
      );
    }
  }

  return config;
}
