import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import { GatewayServiceInstance, JwksTokenVerifier, loadServiceConfig } from '../../src/index.js';
import { createTestJwtContext, signTestJwt } from '../test-jwt-helper.js';

interface TestResponse {
  statusCode: number;
  headers: http.IncomingHttpHeaders;
  body: {
    success?: boolean;
    data?: {
      userId?: string;
      tenantId?: string;
      roles?: string[];
      scopes?: string[];
      permissions?: string[];
    };
    error?: {
      code?: string;
      message?: string;
    };
    [key: string]: unknown;
  };
}

function makeRequest(
  port: number,
  path: string,
  method = 'GET',
  headers: Record<string, string> = {},
): Promise<TestResponse> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path,
        method,
        headers,
      },
      (res) => {
        let rawData = '';
        res.on('data', (chunk) => {
          rawData += chunk;
        });
        res.on('end', () => {
          try {
            const body = JSON.parse(rawData);
            resolve({
              statusCode: res.statusCode ?? 500,
              headers: res.headers,
              body,
            });
          } catch {
            resolve({
              statusCode: res.statusCode ?? 500,
              headers: res.headers,
              body: { raw: rawData },
            });
          }
        });
      },
    );

    req.on('error', reject);
    req.end();
  });
}

describe('API Gateway - Identity Context Integration Tests', () => {
  const jwtCtx = createTestJwtContext('gateway-key-1');
  let service: GatewayServiceInstance;
  let boundPort: number;

  beforeAll(async () => {
    const tokenVerifier = new JwksTokenVerifier({
      staticJwks: jwtCtx.jwks,
      issuer: 'https://auth.oicunt.internal',
      audience: 'oicunt-platform',
    });

    const config = loadServiceConfig({
      serviceName: 'api-gateway',
      port: 0,
      host: '127.0.0.1',
    });

    service = new GatewayServiceInstance({ config, tokenVerifier });
    boundPort = await service.start();
  });

  afterAll(async () => {
    await service.stop();
  });

  it('rejects unauthenticated request to /api/v1/context with 401', async () => {
    const response = await makeRequest(boundPort, '/api/v1/context');

    expect(response.statusCode).toBe(401);
    expect(response.body.success).toBe(false);
    expect(response.body.error?.code).toBe('UNAUTHORIZED');
    expect(response.body.error?.message).toMatch(/missing authorization header/i);
  });

  it('rejects invalid Authorization header format with 401', async () => {
    const response = await makeRequest(boundPort, '/api/v1/context', 'GET', {
      Authorization: 'Basic dXNlcjpwYXNz',
    });

    expect(response.statusCode).toBe(401);
    expect(response.body.success).toBe(false);
    expect(response.body.error?.code).toBe('UNAUTHORIZED');
  });

  it('rejects token with invalid signature with 401', async () => {
    const otherKeyCtx = createTestJwtContext('other-key');
    const token = signTestJwt(
      {
        sub: 'user-hacker',
        tenant_id: 'tenant-victim',
        iss: 'https://auth.oicunt.internal',
        aud: 'oicunt-platform',
        exp: Math.floor(Date.now() / 1000) + 3600,
      },
      otherKeyCtx.privateKey,
      { kid: 'gateway-key-1' },
    );

    const response = await makeRequest(boundPort, '/api/v1/context', 'GET', {
      Authorization: `Bearer ${token}`,
    });

    expect(response.statusCode).toBe(401);
    expect(response.body.success).toBe(false);
    expect(response.body.error?.code).toBe('UNAUTHORIZED');
  });

  it('rejects expired token with 401', async () => {
    const token = signTestJwt(
      {
        sub: 'user-expired',
        tenant_id: 'tenant-1',
        iss: 'https://auth.oicunt.internal',
        aud: 'oicunt-platform',
        exp: Math.floor(Date.now() / 1000) - 100, // expired
      },
      jwtCtx.privateKey,
      { kid: 'gateway-key-1' },
    );

    const response = await makeRequest(boundPort, '/api/v1/context', 'GET', {
      Authorization: `Bearer ${token}`,
    });

    expect(response.statusCode).toBe(401);
    expect(response.body.success).toBe(false);
    expect(response.body.error?.code).toBe('UNAUTHORIZED');
    expect(response.body.error?.message).toMatch(/expired/i);
  });

  it('authenticates valid RS256 token, establishes authoritative identity context, and strips spoofed headers', async () => {
    const validClaims = {
      sub: 'user-authoritative-99',
      tenant_id: 'tenant-legit-77',
      iss: 'https://auth.oicunt.internal',
      aud: 'oicunt-platform',
      exp: Math.floor(Date.now() / 1000) + 3600,
      scope: 'ai:use billing:read',
      roles: ['developer', 'team-lead'],
    };

    const token = signTestJwt(validClaims, jwtCtx.privateKey, { kid: 'gateway-key-1' });

    // Client attempts to spoof X-User-ID, X-Tenant-ID, and asserts its own X-Request-ID
    const response = await makeRequest(boundPort, '/api/v1/context', 'GET', {
      Authorization: `Bearer ${token}`,
      'X-User-ID': 'spoofed-evil-user',
      'X-Tenant-ID': 'spoofed-evil-tenant',
      'X-Request-ID': 'client-asserted-request-id',
      'X-Correlation-ID': 'trace-corr-555',
    });

    expect(response.statusCode).toBe(200);
    expect(response.body.success).toBe(true);

    // Verified data matches token claims, NOT spoofed headers
    expect(response.body.data?.userId).toBe('user-authoritative-99');
    expect(response.body.data?.tenantId).toBe('tenant-legit-77');
    expect(response.body.data?.scopes).toContain('ai:use');
    expect(response.body.data?.scopes).toContain('billing:read');
    expect(response.body.data?.roles).toEqual(['developer', 'team-lead']);

    // Raw JWT is never exposed in response
    const jsonStr = JSON.stringify(response.body);
    expect(jsonStr).not.toContain(token);

    // Authoritative X-Request-ID was generated, not client asserted
    expect(response.headers['x-request-id']).toBeDefined();
    expect(response.headers['x-request-id']).not.toBe('client-asserted-request-id');
    expect(response.headers['x-correlation-id']).toBe('trace-corr-555');
  });
});
