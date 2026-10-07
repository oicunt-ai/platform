import { describe, expect, it } from 'vitest';
import { JwksTokenVerifier, AuthenticationError } from '../../src/index.js';
import { createTestJwtContext, signTestJwt } from '../test-jwt-helper.js';

describe('JwksTokenVerifier - Unit Tests', () => {
  const jwtCtx = createTestJwtContext('key-alpha');

  const baseClaims = {
    sub: 'user-456',
    tenant_id: 'tenant-999',
    iss: 'https://auth.oicunt.internal',
    aud: 'oicunt-platform',
    exp: Math.floor(Date.now() / 1000) + 3600,
    nbf: Math.floor(Date.now() / 1000) - 60,
    scope: 'ai:use read:profile',
    roles: ['engineer'],
  };

  it('should successfully verify a valid RS256 JWT and extract identity context', async () => {
    const verifier = new JwksTokenVerifier({
      staticJwks: jwtCtx.jwks,
      issuer: 'https://auth.oicunt.internal',
      audience: 'oicunt-platform',
    });

    const token = signTestJwt(baseClaims, jwtCtx.privateKey, { kid: 'key-alpha' });
    const identity = await verifier.verifyToken(token);

    expect(identity.userId).toBe('user-456');
    expect(identity.tenantId).toBe('tenant-999');
    expect(identity.scopes).toContain('ai:use');
    expect(identity.scopes).toContain('read:profile');
    expect(identity.roles).toEqual(['engineer']);
  });

  it('should accept tenantId claim alternative to tenant_id', async () => {
    const verifier = new JwksTokenVerifier({
      staticJwks: jwtCtx.jwks,
    });

    const claims = {
      sub: 'user-789',
      tenantId: 'tenant-camel-case',
      exp: Math.floor(Date.now() / 1000) + 3600,
    };

    const token = signTestJwt(claims, jwtCtx.privateKey, { kid: 'key-alpha' });
    const identity = await verifier.verifyToken(token);

    expect(identity.userId).toBe('user-789');
    expect(identity.tenantId).toBe('tenant-camel-case');
  });

  it('should accept audience as array of strings', async () => {
    const verifier = new JwksTokenVerifier({
      staticJwks: jwtCtx.jwks,
      audience: 'oicunt-platform',
    });

    const claims = {
      ...baseClaims,
      aud: ['oicunt-platform', 'other-service'],
    };

    const token = signTestJwt(claims, jwtCtx.privateKey, { kid: 'key-alpha' });
    const identity = await verifier.verifyToken(token);

    expect(identity.userId).toBe('user-456');
  });

  it('should reject signature signed by a different key', async () => {
    const otherKeyCtx = createTestJwtContext('other-key');
    const verifier = new JwksTokenVerifier({
      staticJwks: jwtCtx.jwks,
    });

    // Signed with other key, but header claims kid 'key-alpha'
    const token = signTestJwt(baseClaims, otherKeyCtx.privateKey, { kid: 'key-alpha' });

    await expect(verifier.verifyToken(token)).rejects.toThrow(AuthenticationError);
    await expect(verifier.verifyToken(token)).rejects.toThrow(/cryptographic signature/i);
  });

  it('should reject unsigned token (alg: none)', async () => {
    const verifier = new JwksTokenVerifier({
      staticJwks: jwtCtx.jwks,
    });

    const token = signTestJwt(baseClaims, jwtCtx.privateKey, { alg: 'none' });

    await expect(verifier.verifyToken(token)).rejects.toThrow(AuthenticationError);
    await expect(verifier.verifyToken(token)).rejects.toThrow(/Only 'RS256' is accepted/i);
  });

  it('should reject token with expired exp', async () => {
    const verifier = new JwksTokenVerifier({
      staticJwks: jwtCtx.jwks,
      clockSkewSeconds: 0,
    });

    const claims = {
      ...baseClaims,
      exp: Math.floor(Date.now() / 1000) - 10, // 10 seconds ago
    };

    const token = signTestJwt(claims, jwtCtx.privateKey, { kid: 'key-alpha' });

    await expect(verifier.verifyToken(token)).rejects.toThrow(AuthenticationError);
    await expect(verifier.verifyToken(token)).rejects.toThrow(/expired/i);
  });

  it('should allow token within clock skew window', async () => {
    const verifier = new JwksTokenVerifier({
      staticJwks: jwtCtx.jwks,
      clockSkewSeconds: 60,
    });

    const claims = {
      ...baseClaims,
      exp: Math.floor(Date.now() / 1000) - 10, // 10 seconds ago, but within 60s skew
    };

    const token = signTestJwt(claims, jwtCtx.privateKey, { kid: 'key-alpha' });
    const identity = await verifier.verifyToken(token);

    expect(identity.userId).toBe('user-456');
  });

  it('should reject token with future nbf', async () => {
    const verifier = new JwksTokenVerifier({
      staticJwks: jwtCtx.jwks,
      clockSkewSeconds: 0,
    });

    const claims = {
      ...baseClaims,
      nbf: Math.floor(Date.now() / 1000) + 120, // 2 minutes in future
    };

    const token = signTestJwt(claims, jwtCtx.privateKey, { kid: 'key-alpha' });

    await expect(verifier.verifyToken(token)).rejects.toThrow(AuthenticationError);
    await expect(verifier.verifyToken(token)).rejects.toThrow(/not active yet/i);
  });

  it('should reject token with mismatched issuer', async () => {
    const verifier = new JwksTokenVerifier({
      staticJwks: jwtCtx.jwks,
      issuer: 'https://auth.oicunt.internal',
    });

    const claims = {
      ...baseClaims,
      iss: 'https://rogue-auth.example.com',
    };

    const token = signTestJwt(claims, jwtCtx.privateKey, { kid: 'key-alpha' });

    await expect(verifier.verifyToken(token)).rejects.toThrow(AuthenticationError);
    await expect(verifier.verifyToken(token)).rejects.toThrow(/Invalid JWT issuer/i);
  });

  it('should reject token with mismatched audience', async () => {
    const verifier = new JwksTokenVerifier({
      staticJwks: jwtCtx.jwks,
      audience: 'oicunt-platform',
    });

    const claims = {
      ...baseClaims,
      aud: 'unrelated-audience',
    };

    const token = signTestJwt(claims, jwtCtx.privateKey, { kid: 'key-alpha' });

    await expect(verifier.verifyToken(token)).rejects.toThrow(AuthenticationError);
    await expect(verifier.verifyToken(token)).rejects.toThrow(/Invalid JWT audience/i);
  });

  it('should reject token missing sub', async () => {
    const verifier = new JwksTokenVerifier({
      staticJwks: jwtCtx.jwks,
    });

    const claims = {
      tenant_id: 'tenant-123',
      exp: Math.floor(Date.now() / 1000) + 3600,
    };

    const token = signTestJwt(claims, jwtCtx.privateKey, { kid: 'key-alpha' });

    await expect(verifier.verifyToken(token)).rejects.toThrow(AuthenticationError);
    await expect(verifier.verifyToken(token)).rejects.toThrow(/missing required subject/i);
  });

  it('should reject token missing tenant identifier', async () => {
    const verifier = new JwksTokenVerifier({
      staticJwks: jwtCtx.jwks,
    });

    const claims = {
      sub: 'user-123',
      exp: Math.floor(Date.now() / 1000) + 3600,
    };

    const token = signTestJwt(claims, jwtCtx.privateKey, { kid: 'key-alpha' });

    await expect(verifier.verifyToken(token)).rejects.toThrow(AuthenticationError);
    await expect(verifier.verifyToken(token)).rejects.toThrow(/missing required tenant/i);
  });

  it('should reject malformed token strings', async () => {
    const verifier = new JwksTokenVerifier({
      staticJwks: jwtCtx.jwks,
    });

    await expect(verifier.verifyToken('')).rejects.toThrow(AuthenticationError);
    await expect(verifier.verifyToken('just.two.parts.extra')).rejects.toThrow(AuthenticationError);
    await expect(verifier.verifyToken('not-a-jwt')).rejects.toThrow(AuthenticationError);
  });

  it('should fetch JWKS from remote URI using fetchFn', async () => {
    const mockFetch = async () => {
      return {
        ok: true,
        status: 200,
        json: async () => jwtCtx.jwks,
      } as unknown as Response;
    };

    const verifier = new JwksTokenVerifier({
      jwksUri: 'https://auth.oicunt.internal/.well-known/jwks.json',
      fetchFn: mockFetch as typeof fetch,
    });

    const token = signTestJwt(baseClaims, jwtCtx.privateKey, { kid: 'key-alpha' });
    const identity = await verifier.verifyToken(token);

    expect(identity.userId).toBe('user-456');
    expect(identity.tenantId).toBe('tenant-999');
  });
});
