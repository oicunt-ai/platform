export type Environment = 'development' | 'staging' | 'production' | 'test';

export const SUPPORTED_ENVIRONMENTS: readonly Environment[] = [
  'development',
  'staging',
  'production',
  'test',
] as const;

export interface BaseServiceConfig {
  readonly serviceName: string;
  readonly environment: Environment;
  readonly version: string;
  readonly port: number;
  readonly host: string;
}

export interface ConfigValidationSuccess<T> {
  readonly success: true;
  readonly config: T;
}

export interface ConfigValidationFailure {
  readonly success: false;
  readonly errors: readonly string[];
}

export type ConfigValidationResult<T> = ConfigValidationSuccess<T> | ConfigValidationFailure;

export interface ConfigProvider<T> {
  get(): T;
  validate(): ConfigValidationResult<T>;
}

export function isEnvironment(value: unknown): value is Environment {
  return typeof value === 'string' && SUPPORTED_ENVIRONMENTS.includes(value as Environment);
}

export function resolveEnvironment(raw?: string): Environment {
  if (!raw) {
    return 'development';
  }
  const normalized = raw.trim().toLowerCase();
  if (isEnvironment(normalized)) {
    return normalized;
  }
  return 'development';
}

export function createBaseConfig(
  serviceName: string,
  overrides?: Partial<BaseServiceConfig>,
): BaseServiceConfig {
  return {
    serviceName,
    environment: overrides?.environment ?? resolveEnvironment(process.env['NODE_ENV']),
    version: overrides?.version ?? '0.1.0',
    port: overrides?.port ?? 3000,
    host: overrides?.host ?? '0.0.0.0',
  };
}
