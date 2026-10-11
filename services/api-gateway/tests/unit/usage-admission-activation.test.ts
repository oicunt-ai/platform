/**
 * Activation matrix for ENABLE_USAGE_ADMISSION.
 *
 * Policy: explicit true/false only. Production with an unset flag fails
 * startup instead of auto-enabling; an invalid value fails in every
 * environment; anything else defaults to disabled. All cases use config
 * overrides so no test mutates process.env.
 */
import { describe, expect, it } from 'vitest';
import { loadServiceConfig, parseExplicitSwitch } from '../../src/config.js';

describe('usage admission activation', () => {
  it('parses explicit switches strictly', () => {
    expect(parseExplicitSwitch(undefined, 'FLAG')).toBeUndefined();
    expect(parseExplicitSwitch('true', 'FLAG')).toBe(true);
    expect(parseExplicitSwitch(' TRUE ', 'FLAG')).toBe(true);
    expect(parseExplicitSwitch('false', 'FLAG')).toBe(false);
    expect(parseExplicitSwitch('FALSE', 'FLAG')).toBe(false);
    expect(() => parseExplicitSwitch('yes', 'FLAG')).toThrow(/explicitly 'true' or 'false'/);
    expect(() => parseExplicitSwitch('1', 'FLAG')).toThrow();
    expect(() => parseExplicitSwitch('', 'FLAG')).toThrow();
  });

  it('defaults to disabled outside production', () => {
    for (const environment of ['development', 'staging', 'test'] as const) {
      expect(loadServiceConfig({ environment }).enableUsageAdmission).toBe(false);
    }
  });

  it('fails startup when production has no explicit setting', () => {
    expect(() => loadServiceConfig({ environment: 'production' })).toThrow(
      /ENABLE_USAGE_ADMISSION must be explicitly/,
    );
  });

  it('honors explicit false in production (genuinely disabled)', () => {
    const config = loadServiceConfig({
      environment: 'production',
      jwksUri: 'https://auth.oicunt.internal/.well-known/jwks.json',
      jwtIssuer: 'https://auth.oicunt.internal',
      jwtAudience: 'oicunt-platform',
      orchestratorInternalSecret: 'orchestrator-secret',
      usageInternalSecret: 'usage-secret',
      orchestratorBaseUrl: 'http://127.0.0.1:3003',
      usageBaseUrl: 'http://127.0.0.1:8090',
      enableUsageAdmission: false,
    });
    expect(config.enableUsageAdmission).toBe(false);
  });

  it('honors explicit true in production once dependencies validate', () => {
    const config = loadServiceConfig({
      environment: 'production',
      jwksUri: 'https://auth.oicunt.internal/.well-known/jwks.json',
      jwtIssuer: 'https://auth.oicunt.internal',
      jwtAudience: 'oicunt-platform',
      orchestratorInternalSecret: 'orchestrator-secret',
      usageInternalSecret: 'usage-secret',
      orchestratorBaseUrl: 'http://127.0.0.1:3003',
      usageBaseUrl: 'http://127.0.0.1:8090',
      enableUsageAdmission: true,
    });
    expect(config.enableUsageAdmission).toBe(true);
  });

  it('never activates merely because NODE_ENV changes', () => {
    expect(loadServiceConfig({ environment: 'development' }).enableUsageAdmission).toBe(false);
    expect(() => loadServiceConfig({ environment: 'production' })).toThrow();
  });
});
