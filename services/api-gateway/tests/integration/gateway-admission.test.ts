import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import { GatewayServiceInstance, JwksTokenVerifier, loadServiceConfig } from '../../src/index.js';
import type { UsageAdmissionPort } from '../../src/application/ports/usage-admission.port.js';
import type { OrchestratorClientPort } from '../../src/application/ports/orchestrator-client.port.js';
import { BadGatewayError, RateLimitedError } from '../../src/domain/index.js';
import { createTestJwtContext, signTestJwt } from '../test-jwt-helper.js';

interface CompletionBody {
  success?: boolean;
  data?: unknown;
  error?: { code?: string; message?: string };
  [key: string]: unknown;
}

function makePostRequest(
  port: number,
  path: string,
  payload: unknown,
  headers: Record<string, string> = {},
): Promise<{ statusCode: number; body: CompletionBody }> {
  return new Promise((resolve, reject) => {
    const payloadStr = JSON.stringify(payload);
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payloadStr),
          ...headers,
        },
      },
      (res) => {
        let rawData = '';
        res.on('data', (chunk) => {
          rawData += chunk;
        });
        res.on('end', () => {
          try {
            resolve({ statusCode: res.statusCode ?? 500, body: JSON.parse(rawData) });
          } catch {
            resolve({ statusCode: res.statusCode ?? 500, body: { raw: rawData } });
          }
        });
      },
    );
    req.on('error', reject);
    req.write(payloadStr);
    req.end();
  });
}

class FakeAdmission implements UsageAdmissionPort {
  public acquires: Array<{ tenantId: string; userId: string; stream: boolean }> = [];
  public releases: Array<{ tenantId: string; userId: string; leaseId: string }> = [];
  public mode: 'allow' | 'deny' | 'fail' = 'allow';

  async acquire(input: {
    tenantId: string;
    userId: string;
    requestId: string;
    correlationId: string;
    stream: boolean;
    signal?: AbortSignal;
  }): Promise<{ leaseId?: string | undefined }> {
    this.acquires.push({ tenantId: input.tenantId, userId: input.userId, stream: input.stream });
    if (this.mode === 'deny') throw new RateLimitedError('quota exhausted', 'RATE_LIMITED');
    if (this.mode === 'fail') throw new BadGatewayError('usage down');
    return input.stream ? { leaseId: 'adm_test_lease_1' } : {};
  }

  async release(input: {
    tenantId: string;
    userId: string;
    requestId: string;
    correlationId: string;
    leaseId: string;
  }): Promise<void> {
    this.releases.push({ tenantId: input.tenantId, userId: input.userId, leaseId: input.leaseId });
  }
}

describe('API Gateway - Admission preflight and safety regression', () => {
  const jwtCtx = createTestJwtContext('gw-adm-key');
  let gatewayPort = 0;
  let gatewayService: GatewayServiceInstance;
  let fakeAdmission: FakeAdmission;
  let forwardCalls = 0;

  const fakeOrchestrator: OrchestratorClientPort = {
    checkHealth: async () => true,
    forwardCompletion: async () => {
      forwardCalls += 1;
      return { statusCode: 200, headers: {}, bodyData: { success: true, data: { ok: true } } };
    },
  };

  const tokenVerifier = new JwksTokenVerifier({
    staticJwks: jwtCtx.jwks,
    issuer: 'https://auth.oicunt.internal',
    audience: 'oicunt-platform',
  });

  function signToken(sub: string, tenant: string, scope: string): string {
    return signTestJwt(
      {
        sub,
        tenant_id: tenant,
        iss: 'https://auth.oicunt.internal',
        aud: 'oicunt-platform',
        exp: Math.floor(Date.now() / 1000) + 3600,
        scope,
      },
      jwtCtx.privateKey,
      { kid: 'gw-adm-key' },
    );
  }

  const validBody = {
    conversationId: 'conv_adm_1',
    model: 'oicunt.model.catalog-alpha',
    messages: [{ role: 'user', content: 'hi' }],
    stream: false,
  };

  beforeAll(async () => {
    fakeAdmission = new FakeAdmission();
    const config = loadServiceConfig({
      serviceName: 'api-gateway',
      port: 0,
      host: '127.0.0.1',
      enableUsageAdmission: true,
    });
    gatewayService = new GatewayServiceInstance({
      config,
      tokenVerifier,
      orchestratorClient: fakeOrchestrator,
      usageAdmissionClient: fakeAdmission,
    });
    gatewayPort = await gatewayService.start();
  });

  afterAll(async () => {
    await gatewayService.stop();
  });

  it('A. rejects callers without ai:use before admission contact', async () => {
    const res = await makePostRequest(gatewayPort, '/api/v1/ai/completions', validBody, {
      Authorization: `Bearer ${signToken('u1', 't1', 'billing:read')}`,
    });
    expect(res.statusCode).toBe(403);
    expect(fakeAdmission.acquires).toHaveLength(0);
    expect(forwardCalls).toBe(0);
  });

  it('B. rejects invalid bodies before admission contact', async () => {
    const res = await makePostRequest(
      gatewayPort,
      '/api/v1/ai/completions',
      { model: '' },
      {
        Authorization: `Bearer ${signToken('u2', 't2', 'ai:use')}`,
      },
    );
    expect(res.statusCode).toBe(400);
    expect(fakeAdmission.acquires).toHaveLength(0);
    expect(forwardCalls).toBe(0);
  });

  it('C. acquires once and forwards valid unary requests', async () => {
    const res = await makePostRequest(gatewayPort, '/api/v1/ai/completions', validBody, {
      Authorization: `Bearer ${signToken('u3', 't3', 'ai:use')}`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(fakeAdmission.acquires).toHaveLength(1);
    expect(fakeAdmission.acquires[0]).toMatchObject({
      tenantId: 't3',
      userId: 'u3',
      stream: false,
    });
    expect(forwardCalls).toBe(1);
  });

  it('D. acquires and releases stream leases in finally', async () => {
    const res = await makePostRequest(
      gatewayPort,
      '/api/v1/ai/completions',
      { ...validBody, stream: true },
      { Authorization: `Bearer ${signToken('u4', 't4', 'ai:use')}` },
    );
    expect(res.statusCode).toBe(200);
    expect(fakeAdmission.acquires).toHaveLength(2);
    expect(fakeAdmission.releases).toHaveLength(1);
    expect(fakeAdmission.releases[0]).toMatchObject({
      tenantId: 't4',
      userId: 'u4',
      leaseId: 'adm_test_lease_1',
    });
    expect(forwardCalls).toBe(2);
  });

  it('E. maps admission denial to 429 without forwarding', async () => {
    fakeAdmission.mode = 'deny';
    try {
      const res = await makePostRequest(gatewayPort, '/api/v1/ai/completions', validBody, {
        Authorization: `Bearer ${signToken('u5', 't5', 'ai:use')}`,
      });
      expect(res.statusCode).toBe(429);
      expect(res.body.success).toBe(false);
      expect(res.body.error?.code).toBe('RATE_LIMITED');
      expect(forwardCalls).toBe(2);
    } finally {
      fakeAdmission.mode = 'allow';
    }
  });

  it('F. preserves the original path with admission disabled', async () => {
    const offConfig = loadServiceConfig({
      serviceName: 'api-gateway',
      port: 0,
      host: '127.0.0.1',
      enableUsageAdmission: false,
    });
    const offService = new GatewayServiceInstance({
      config: offConfig,
      tokenVerifier,
      orchestratorClient: fakeOrchestrator,
    });
    const offPort = await offService.start();
    try {
      const before = fakeAdmission.acquires.length;
      const res = await makePostRequest(offPort, '/api/v1/ai/completions', validBody, {
        Authorization: `Bearer ${signToken('u6', 't6', 'ai:use')}`,
      });
      expect(res.statusCode).toBe(200);
      expect(fakeAdmission.acquires).toHaveLength(before);
      expect(forwardCalls).toBe(3);
    } finally {
      await offService.stop();
    }
  });

  it('G. fails closed with 502 when the admission dependency is down', async () => {
    fakeAdmission.mode = 'fail';
    try {
      const res = await makePostRequest(gatewayPort, '/api/v1/ai/completions', validBody, {
        Authorization: `Bearer ${signToken('u7', 't7', 'ai:use')}`,
      });
      expect(res.statusCode).toBe(502);
      expect(res.body.success).toBe(false);
      expect(forwardCalls).toBe(3);
    } finally {
      fakeAdmission.mode = 'allow';
    }
  });
});
