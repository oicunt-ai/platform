import { describe, expect, it } from 'vitest';
import {
  createInternalServiceToken,
  verifyInternalServiceToken,
} from '../../src/infrastructure/jwt/internal-service-token.js';

describe('InternalServiceToken (platform)', () => {
  const secret = 'super-secure-internal-secret-for-tests';

  it('valid service credential succeeds with verified claims', () => {
    const token = createInternalServiceToken({
      issuer: 'api-gateway',
      audience: 'ai-orchestrator',
      secret,
      expiresInSeconds: 60,
    });

    const result = verifyInternalServiceToken(token, {
      secret,
      expectedAudience: 'ai-orchestrator',
      allowedServiceIdentities: ['api-gateway', 'platform-api-gateway'],
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.serviceName).toBe('api-gateway');
      expect(result.claims.aud).toBe('ai-orchestrator');
      expect(result.claims.iss).toBe('api-gateway');
      expect(result.claims.sub).toBe('api-gateway');
      expect(result.claims.exp).toBeGreaterThan(Math.floor(Date.now() / 1000));
    }
  });

  it('rejects missing or empty token with 401', () => {
    const resultEmpty = verifyInternalServiceToken('', { secret });
    expect(resultEmpty.success).toBe(false);
    if (!resultEmpty.success) {
      expect(resultEmpty.statusCode).toBe(401);
      expect(resultEmpty.errorCode).toBe('AUTHENTICATION_ERROR');
    }

    const resultNull = verifyInternalServiceToken(null as unknown as string, { secret });
    expect(resultNull.success).toBe(false);
    if (!resultNull.success) {
      expect(resultNull.statusCode).toBe(401);
    }
  });

  it('rejects invalid signature or tampered token with 401', () => {
    const token = createInternalServiceToken({
      issuer: 'api-gateway',
      audience: 'ai-orchestrator',
      secret: 'different-secret',
    });

    const result = verifyInternalServiceToken(token, {
      secret,
      expectedAudience: 'ai-orchestrator',
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.statusCode).toBe(401);
      expect(result.errorCode).toBe('AUTHENTICATION_ERROR');
      expect(result.message).toContain('signature');
    }

    const malformed = 'not.a-valid-token';
    const resultMalformed = verifyInternalServiceToken(malformed, { secret });
    expect(resultMalformed.success).toBe(false);
    if (!resultMalformed.success) {
      expect(resultMalformed.statusCode).toBe(401);
    }
  });

  it('rejects expired credential with 401', () => {
    // Generate token that expired 10 seconds ago
    const expiredToken = createInternalServiceToken({
      issuer: 'api-gateway',
      audience: 'ai-orchestrator',
      secret,
      expiresInSeconds: -10,
    });

    const result = verifyInternalServiceToken(expiredToken, {
      secret,
      expectedAudience: 'ai-orchestrator',
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.statusCode).toBe(401);
      expect(result.errorCode).toBe('AUTHENTICATION_ERROR');
      expect(result.message).toContain('Expired');
    }
  });

  it('rejects wrong audience with 403', () => {
    const token = createInternalServiceToken({
      issuer: 'api-gateway',
      audience: 'inference', // Wrong audience (intended for inference, not ai-orchestrator)
      secret,
    });

    const result = verifyInternalServiceToken(token, {
      secret,
      expectedAudience: 'ai-orchestrator',
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.statusCode).toBe(403);
      expect(result.errorCode).toBe('FORBIDDEN');
      expect(result.message).toContain('audience');
    }
  });

  it('rejects calling service that is not in allowed identities with 403', () => {
    const token = createInternalServiceToken({
      issuer: 'unauthorized-external-caller',
      audience: 'ai-orchestrator',
      secret,
    });

    const result = verifyInternalServiceToken(token, {
      secret,
      expectedAudience: 'ai-orchestrator',
      allowedServiceIdentities: ['api-gateway', 'platform-api-gateway'],
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.statusCode).toBe(403);
      expect(result.errorCode).toBe('FORBIDDEN');
      expect(result.message).toContain('not authorized');
    }
  });
});
