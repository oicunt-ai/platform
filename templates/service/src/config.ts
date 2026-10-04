import {
  type BaseServiceConfig,
  type Environment,
  createBaseConfig,
  resolveEnvironment,
} from '@oicunt/config';

export interface ServiceConfig extends BaseServiceConfig {
  readonly shutdownTimeoutMs: number;
  readonly enableMetrics: boolean;
  readonly logLevel: string;
}

export function loadServiceConfig(overrides?: Partial<ServiceConfig>): ServiceConfig {
  const env: Environment = overrides?.environment ?? resolveEnvironment(process.env['NODE_ENV']);
  const port = overrides?.port ?? Number.parseInt(process.env['PORT'] ?? '3000', 10);
  const host = overrides?.host ?? process.env['HOST'] ?? '0.0.0.0';
  const shutdownTimeoutMs =
    overrides?.shutdownTimeoutMs ??
    Number.parseInt(process.env['SHUTDOWN_TIMEOUT_MS'] ?? '5000', 10);
  const enableMetrics = overrides?.enableMetrics ?? process.env['ENABLE_METRICS'] !== 'false';
  const logLevel = overrides?.logLevel ?? process.env['LOG_LEVEL'] ?? 'info';

  const base = createBaseConfig(overrides?.serviceName ?? 'service-template', {
    environment: env,
    port: Number.isNaN(port) ? 3000 : port,
    host,
    version: overrides?.version ?? '0.1.0',
  });

  return {
    ...base,
    shutdownTimeoutMs: Number.isNaN(shutdownTimeoutMs) ? 5000 : shutdownTimeoutMs,
    enableMetrics,
    logLevel,
  };
}
