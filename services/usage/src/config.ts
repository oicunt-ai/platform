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
  readonly rabbitmqUrl: string;
  readonly useRabbitMq: boolean;
  readonly rabbitmqExchange: string;
  readonly rabbitmqQueue: string;
  readonly rabbitmqDlx: string;
  readonly rabbitmqDlq: string;
  readonly rabbitmqRoutingKeyPattern: string;
  readonly rabbitmqPrefetch: number;
}

export function loadUsageConfig(overrides: Partial<UsageConfig> = {}): UsageConfig {
  const isTest = process.env['NODE_ENV'] === 'test';

  return {
    serviceName: overrides.serviceName ?? 'usage',
    port: overrides.port ?? Number.parseInt(process.env['USAGE_SERVICE_PORT'] ?? '8090', 10),
    host: overrides.host ?? process.env['USAGE_SERVICE_HOST'] ?? '0.0.0.0',
    internalToken:
      overrides.internalToken ??
      process.env['INTERNAL_SERVICE_TOKEN'] ??
      process.env['USAGE_INTERNAL_TOKEN'],
    database: {
      host:
        overrides.database?.host ?? process.env['USAGE_DB_HOST'] ?? process.env['DATABASE_HOST'],
      port:
        overrides.database?.port ??
        (process.env['USAGE_DB_PORT']
          ? Number.parseInt(process.env['USAGE_DB_PORT'], 10)
          : undefined),
      database:
        overrides.database?.database ??
        process.env['USAGE_DB_NAME'] ??
        process.env['DATABASE_NAME'] ??
        'oicunt_usage',
      user:
        overrides.database?.user ?? process.env['USAGE_DB_USER'] ?? process.env['DATABASE_USER'],
      password:
        overrides.database?.password ??
        process.env['USAGE_DB_PASSWORD'] ??
        process.env['DATABASE_PASSWORD'],
      ssl:
        overrides.database?.ssl ??
        (process.env['DATABASE_SSL'] === 'true' ? { rejectUnauthorized: false } : undefined),
    },
    useDatabase:
      overrides.useDatabase ??
      (!isTest && process.env['USE_DATABASE'] !== 'false' && Boolean(process.env['DATABASE_HOST'])),
    logLevel:
      overrides.logLevel ??
      ((process.env['LOG_LEVEL'] as LogLevel) || (isTest ? 'silent' : 'info')),
    rabbitmqUrl:
      overrides.rabbitmqUrl ?? process.env['RABBITMQ_URL'] ?? 'amqp://guest:guest@localhost:5672',
    useRabbitMq:
      overrides.useRabbitMq ??
      (!isTest && process.env['USE_RABBITMQ'] !== 'false' && Boolean(process.env['RABBITMQ_URL'])),
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
  };
}
