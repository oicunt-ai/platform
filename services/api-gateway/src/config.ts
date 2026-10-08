import {
  type BaseServiceConfig,
  type Environment,
  createBaseConfig,
  resolveEnvironment,
} from '@oicunt/config';

export interface GatewayConfig extends BaseServiceConfig {
  readonly shutdownTimeoutMs: number;
  readonly enableMetrics: boolean;
  readonly logLevel: string;
  readonly jwksUri?: string | undefined;
  readonly jwtIssuer?: string | undefined;
  readonly jwtAudience?: string | undefined;
  readonly clockSkewSeconds: number;
  readonly orchestratorBaseUrl: string;
  readonly internalServiceSecret?: string | undefined;
}

export function loadServiceConfig(overrides?: Partial<GatewayConfig>): GatewayConfig {
  const env: Environment = overrides?.environment ?? resolveEnvironment(process.env['NODE_ENV']);
  const port = overrides?.port ?? Number.parseInt(process.env['PORT'] ?? '3000', 10);
  const host = overrides?.host ?? process.env['HOST'] ?? '0.0.0.0';
  const shutdownTimeoutMs =
    overrides?.shutdownTimeoutMs ??
    Number.parseInt(process.env['SHUTDOWN_TIMEOUT_MS'] ?? '5000', 10);
  const enableMetrics = overrides?.enableMetrics ?? process.env['ENABLE_METRICS'] !== 'false';
  const logLevel = overrides?.logLevel ?? process.env['LOG_LEVEL'] ?? 'info';

  const jwksUri = overrides?.jwksUri ?? process.env['JWKS_URI'];
  const jwtIssuer = overrides?.jwtIssuer ?? process.env['JWT_ISSUER'];
  const jwtAudience = overrides?.jwtAudience ?? process.env['JWT_AUDIENCE'] ?? 'oicunt-platform';
  const clockSkewSeconds =
    overrides?.clockSkewSeconds ??
    Number.parseInt(process.env['JWT_CLOCK_SKEW_SECONDS'] ?? '60', 10);
  const orchestratorBaseUrl =
    overrides?.orchestratorBaseUrl ??
    process.env['ORCHESTRATOR_BASE_URL'] ??
    'http://localhost:3001';
  const internalServiceSecret =
    overrides?.internalServiceSecret ??
    process.env['INTERNAL_SERVICE_SECRET'] ??
    process.env['INTERNAL_SERVICE_TOKEN'];

  const base = createBaseConfig(overrides?.serviceName ?? 'api-gateway', {
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
    jwksUri,
    jwtIssuer,
    jwtAudience,
    clockSkewSeconds: Number.isNaN(clockSkewSeconds) ? 60 : clockSkewSeconds,
    orchestratorBaseUrl,
    internalServiceSecret,
  };
}
