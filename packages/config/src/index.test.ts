import { describe, expect, it } from 'vitest';
import {
  createBaseConfig,
  isEnvironment,
  resolveEnvironment,
  SUPPORTED_ENVIRONMENTS,
} from './index.js';

describe('@oicunt/config', () => {
  it('should identify valid environments', () => {
    for (const env of SUPPORTED_ENVIRONMENTS) {
      expect(isEnvironment(env)).toBe(true);
    }
    expect(isEnvironment('invalid-env')).toBe(false);
    expect(isEnvironment(123)).toBe(false);
  });

  it('should resolve environment with fallback to development', () => {
    expect(resolveEnvironment('production')).toBe('production');
    expect(resolveEnvironment('STAGING')).toBe('staging');
    expect(resolveEnvironment(undefined)).toBe('development');
    expect(resolveEnvironment('unknown')).toBe('development');
  });

  it('should create default base config', () => {
    const config = createBaseConfig('auth-service', {
      port: 8080,
      environment: 'staging',
    });

    expect(config.serviceName).toBe('auth-service');
    expect(config.port).toBe(8080);
    expect(config.environment).toBe('staging');
    expect(config.version).toBe('0.1.0');
    expect(config.host).toBe('0.0.0.0');
  });
});
