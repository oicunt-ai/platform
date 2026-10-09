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
      completionId?: string;
      conversationId?: string;
      model?: string;
      message?: { role: string; content: string };
      finishReason?: string;
      usage?: { inputTokens: number; outputTokens: number; totalTokens: number };
    };
    error?: {
      code?: string;
      message?: string;
    };
    [key: string]: unknown;
  };
  rawText?: string;
}

function makePostRequest(
  port: number,
  path: string,
  payload: unknown,
  headers: Record<string, string> = {},
): Promise<TestResponse> {
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
            const body = JSON.parse(rawData);
            resolve({
              statusCode: res.statusCode ?? 500,
              headers: res.headers,
              body,
              rawText: rawData,
            });
          } catch {
            resolve({
              statusCode: res.statusCode ?? 500,
              headers: res.headers,
              body: { raw: rawData },
              rawText: rawData,
            });
          }
        });
      },
    );

    req.on('error', reject);
    req.write(payloadStr);
    req.end();
  });
}

function makeGetRequest(
  port: number,
  path: string,
  headers: Record<string, string> = {},
): Promise<TestResponse> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: '127.0.0.1', port, path, method: 'GET', headers },
      (res) => {
        let rawData = '';
        res.on('data', (chunk) => (rawData += chunk));
        res.on('end', () =>
          resolve({
            statusCode: res.statusCode ?? 500,
            headers: res.headers,
            body: JSON.parse(rawData) as TestResponse['body'],
            rawText: rawData,
          }),
        );
      },
    );
    req.on('error', reject);
    req.end();
  });
}

describe('API Gateway - AI Completions Ingress Integration Tests', () => {
  const jwtCtx = createTestJwtContext('gw-comp-key');
  let gatewayService: GatewayServiceInstance;
  let gatewayPort: number;

  // Mock Orchestrator Service
  let mockOrchestratorServer: http.Server;
  let mockOrchestratorPort: number;
  let lastOrchestratorRequestHeaders: http.IncomingHttpHeaders | null = null;
  let lastOrchestratorRequestBody: Record<string, unknown> | null = null;
  let orchestratorMode:
    | 'unary'
    | 'error'
    | 'stream'
    | 'unsupported-effort'
    | 'stream-extra-usage'
    | 'stream-malformed-usage' = 'unary';

  beforeAll(async () => {
    // 1. Start mock AI Orchestrator
    mockOrchestratorServer = http.createServer((req, res) => {
      lastOrchestratorRequestHeaders = req.headers;

      let bodyData = '';
      req.on('data', (chunk) => {
        bodyData += chunk;
      });

      req.on('end', () => {
        try {
          lastOrchestratorRequestBody = JSON.parse(bodyData) as Record<string, unknown>;
        } catch {
          lastOrchestratorRequestBody = null;
        }

        if (req.url === '/internal/v1/orchestrator/catalog') {
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(
            JSON.stringify({
              success: true,
              data: [
                {
                  id: 'oicunt.model.catalog-alpha',
                  displayName: 'General',
                  description: 'General assistant',
                  family: 'general',
                  capabilities: { streaming: true, tools: false },
                  status: 'available',
                  pricing: { costPerMillionInputTokens: 1 },
                  targets: [{ provider: 'test-provider', upstreamModelId: 'secret-upstream' }],
                },
              ],
            }),
          );
          return;
        }

        if (orchestratorMode === 'stream') {
          res.writeHead(200, {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
          });
          res.write('event: token\ndata: {"delta":"Hello"}\n\n');
          res.write('event: token\ndata: {"delta":" world"}\n\n');
          res.write(
            'event: finish\ndata: {"finishReason":"stop","usage":{"promptTokens":10,"completionTokens":2,"totalTokens":12}}\n\n',
          );
          res.end();
          return;
        }

        if (orchestratorMode === 'unary') {
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(
            JSON.stringify({
              success: true,
              data: {
                completionId: 'cmpl_test_999',
                conversationId: lastOrchestratorRequestBody?.['conversationId'],
                model: lastOrchestratorRequestBody?.['model'],
                message: {
                  role: 'assistant',
                  content: 'Mocked completion response from internal orchestrator.',
                },
                finishReason: 'stop',
                usage: { inputTokens: 10, outputTokens: 8, totalTokens: 18 },
              },
            }),
          );
          return;
        }

        if (orchestratorMode === 'error') {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              success: false,
              error: { code: 'INTERNAL_ERROR', message: 'Orchestrator failure' },
            }),
          );
          return;
        }

        if (orchestratorMode === 'stream-extra-usage') {
          res.writeHead(200, {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
          });
          res.write('event: token\ndata: {"delta":"Hello"}\n\n');
          res.write(
            'event: finish\ndata: {"finishReason":"stop","usage":{"promptTokens":10,"completionTokens":2,"totalTokens":12,"reasoningTokens":4,"cachedTokens":1}}\n\n',
          );
          res.end();
          return;
        }

        if (orchestratorMode === 'stream-malformed-usage') {
          res.writeHead(200, {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
          });
          res.write('event: token\ndata: {"delta":"Hello"}\n\n');
          res.write(
            'event: finish\ndata: {"finishReason":"stop","usage":{"promptTokens":"ten","completionTokens":2}}\n\n',
          );
          res.end();
          return;
        }

        if (orchestratorMode === 'unsupported-effort') {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              success: false,
              error: {
                code: 'UNSUPPORTED_EFFORT_LEVEL',
                message:
                  "Model 'oicunt.model.catalog-beta' does not support reasoning effort 'high'.",
              },
            }),
          );
          return;
        }
      });
    });

    await new Promise<void>((resolve) => {
      mockOrchestratorServer.listen(0, '127.0.0.1', () => {
        const address = mockOrchestratorServer.address();
        mockOrchestratorPort = typeof address === 'object' && address ? address.port : 0;
        resolve();
      });
    });

    // 2. Start Gateway pointed at mock orchestrator
    const tokenVerifier = new JwksTokenVerifier({
      staticJwks: jwtCtx.jwks,
      issuer: 'https://auth.oicunt.internal',
      audience: 'oicunt-platform',
    });

    const config = loadServiceConfig({
      serviceName: 'api-gateway',
      port: 0,
      host: '127.0.0.1',
      orchestratorBaseUrl: `http://127.0.0.1:${mockOrchestratorPort}`,
    });

    gatewayService = new GatewayServiceInstance({ config, tokenVerifier });
    gatewayPort = await gatewayService.start();
  });

  afterAll(async () => {
    await gatewayService.stop();
    await new Promise<void>((resolve) => mockOrchestratorServer.close(() => resolve()));
  });

  const validAiPayload = {
    conversationId: 'conv_session_101',
    model: 'oicunt.model.catalog-alpha',
    messages: [{ role: 'user', content: 'What is the speed of light?' }],
  };

  it('rejects unauthenticated request with 401', async () => {
    const res = await makePostRequest(gatewayPort, '/api/v1/ai/completions', validAiPayload);

    expect(res.statusCode).toBe(401);
    expect(res.body.success).toBe(false);
    expect(res.body.error?.code).toBe('UNAUTHORIZED');
  });

  it('rejects authenticated request lacking ai:use scope with 403 Forbidden', async () => {
    const tokenWithoutAiUse = signTestJwt(
      {
        sub: 'user-standard',
        tenant_id: 'tenant-standard',
        iss: 'https://auth.oicunt.internal',
        aud: 'oicunt-platform',
        exp: Math.floor(Date.now() / 1000) + 3600,
        scope: 'billing:read',
      },
      jwtCtx.privateKey,
      { kid: 'gw-comp-key' },
    );

    const res = await makePostRequest(gatewayPort, '/api/v1/ai/completions', validAiPayload, {
      Authorization: `Bearer ${tokenWithoutAiUse}`,
    });

    expect(res.statusCode).toBe(403);
    expect(res.body.success).toBe(false);
    expect(res.body.error?.code).toBe('FORBIDDEN');
    expect(res.body.error?.message).toMatch(/ai:use/i);
  });

  it('rejects malformed payload with 400 Bad Request', async () => {
    const tokenWithAiUse = signTestJwt(
      {
        sub: 'user-standard',
        tenant_id: 'tenant-standard',
        iss: 'https://auth.oicunt.internal',
        aud: 'oicunt-platform',
        exp: Math.floor(Date.now() / 1000) + 3600,
        scope: 'ai:use',
      },
      jwtCtx.privateKey,
      { kid: 'gw-comp-key' },
    );

    const invalidPayload = {
      conversationId: 'conv_1',
      model: '',
      messages: [{ role: 'user', content: 'hello' }],
    };

    const res = await makePostRequest(gatewayPort, '/api/v1/ai/completions', invalidPayload, {
      Authorization: `Bearer ${tokenWithAiUse}`,
    });

    expect(res.statusCode).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error?.code).toBe('VALIDATION_FAILED');
  });

  it('forwards streaming completion request with SSE response headers and chunks in Step 5', async () => {
    orchestratorMode = 'stream';

    const tokenWithAiUse = signTestJwt(
      {
        sub: 'usr_streamer',
        tenant_id: 'tnt_streamer',
        iss: 'https://auth.oicunt.internal',
        aud: 'oicunt-platform',
        exp: Math.floor(Date.now() / 1000) + 3600,
        scope: 'ai:use',
      },
      jwtCtx.privateKey,
      { kid: 'gw-comp-key' },
    );

    const streamingPayload = {
      ...validAiPayload,
      stream: true,
    };

    const res = await makePostRequest(gatewayPort, '/api/v1/ai/completions', streamingPayload, {
      Authorization: `Bearer ${tokenWithAiUse}`,
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    expect(res.rawText).toContain('event: token\ndata: {"delta":"Hello"}');
    expect(res.rawText).toContain('event: token\ndata: {"delta":" world"}');
    expect(res.rawText).toContain('event: finish');
    expect(lastOrchestratorRequestBody?.['stream']).toBe(true);
    expect(lastOrchestratorRequestHeaders?.['x-user-id']).toBe('usr_streamer');
    expect(lastOrchestratorRequestHeaders?.['x-tenant-id']).toBe('tnt_streamer');
  });

  it('forwards effort and exposeReasoning options to the orchestrator', async () => {
    orchestratorMode = 'unary';

    const tokenWithAiUse = signTestJwt(
      {
        sub: 'usr_options',
        tenant_id: 'tnt_options',
        iss: 'https://auth.oicunt.internal',
        aud: 'oicunt-platform',
        exp: Math.floor(Date.now() / 1000) + 3600,
        scope: 'ai:use',
      },
      jwtCtx.privateKey,
      { kid: 'gw-comp-key' },
    );

    const res = await makePostRequest(
      gatewayPort,
      '/api/v1/ai/completions',
      { ...validAiPayload, effort: 'high', exposeReasoning: true },
      { Authorization: `Bearer ${tokenWithAiUse}` },
    );

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(lastOrchestratorRequestBody?.['effort']).toBe('high');
    expect(lastOrchestratorRequestBody?.['exposeReasoning']).toBe(true);
  });

  it('maps downstream unsupported-effort errors to VALIDATION_ERROR', async () => {
    orchestratorMode = 'unsupported-effort';

    const tokenWithAiUse = signTestJwt(
      {
        sub: 'usr_options',
        tenant_id: 'tnt_options',
        iss: 'https://auth.oicunt.internal',
        aud: 'oicunt-platform',
        exp: Math.floor(Date.now() / 1000) + 3600,
        scope: 'ai:use',
      },
      jwtCtx.privateKey,
      { kid: 'gw-comp-key' },
    );

    const res = await makePostRequest(
      gatewayPort,
      '/api/v1/ai/completions',
      { ...validAiPayload, effort: 'high' },
      { Authorization: `Bearer ${tokenWithAiUse}` },
    );

    expect(res.statusCode).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error?.code).toBe('VALIDATION_ERROR');
    orchestratorMode = 'unary';
  });

  it('normalizes provider-specific finish usage fields instead of failing the stream', async () => {
    orchestratorMode = 'stream-extra-usage';

    const tokenWithAiUse = signTestJwt(
      {
        sub: 'usr_stream_extra',
        tenant_id: 'tnt_stream_extra',
        iss: 'https://auth.oicunt.internal',
        aud: 'oicunt-platform',
        exp: Math.floor(Date.now() / 1000) + 3600,
        scope: 'ai:use',
      },
      jwtCtx.privateKey,
      { kid: 'gw-comp-key' },
    );

    const res = await makePostRequest(
      gatewayPort,
      '/api/v1/ai/completions',
      { ...validAiPayload, stream: true },
      { Authorization: `Bearer ${tokenWithAiUse}` },
    );

    expect(res.statusCode).toBe(200);
    expect(res.rawText).toContain('event: token\ndata: {"delta":"Hello"}');
    expect(res.rawText).toContain('event: finish');
    expect(res.rawText).not.toContain('STREAM_PROTOCOL_ERROR');
    expect(res.rawText).not.toContain('reasoningTokens');
    expect(res.rawText).not.toContain('cachedTokens');
    expect(res.rawText).toContain(
      'data: {"finishReason":"stop","usage":{"promptTokens":10,"completionTokens":2,"totalTokens":12}}',
    );
    orchestratorMode = 'unary';
  });

  it('still rejects finish frames with malformed supported usage fields', async () => {
    orchestratorMode = 'stream-malformed-usage';

    const tokenWithAiUse = signTestJwt(
      {
        sub: 'usr_stream_malformed',
        tenant_id: 'tnt_stream_malformed',
        iss: 'https://auth.oicunt.internal',
        aud: 'oicunt-platform',
        exp: Math.floor(Date.now() / 1000) + 3600,
        scope: 'ai:use',
      },
      jwtCtx.privateKey,
      { kid: 'gw-comp-key' },
    );

    const res = await makePostRequest(
      gatewayPort,
      '/api/v1/ai/completions',
      { ...validAiPayload, stream: true },
      { Authorization: `Bearer ${tokenWithAiUse}` },
    );

    expect(res.statusCode).toBe(200);
    expect(res.rawText).toContain('event: token');
    expect(res.rawText).not.toContain('event: finish');
    expect(res.rawText).toContain('STREAM_PROTOCOL_ERROR');
    orchestratorMode = 'unary';
  });

  it('authenticates, checks ai:use, strips spoofed headers, and forwards unary completion to orchestrator', async () => {
    orchestratorMode = 'unary';

    const tokenWithAiUse = signTestJwt(
      {
        sub: 'usr_legitimate_42',
        tenant_id: 'tnt_legitimate_88',
        iss: 'https://auth.oicunt.internal',
        aud: 'oicunt-platform',
        exp: Math.floor(Date.now() / 1000) + 3600,
        scope: 'ai:use documents:read',
      },
      jwtCtx.privateKey,
      { kid: 'gw-comp-key' },
    );

    // Client attempts to spoof all internal identity and authorization headers
    const clientHeaders = {
      Authorization: `Bearer ${tokenWithAiUse}`,
      'X-User-ID': 'spoofed-attacker-identity',
      'X-Tenant-ID': 'spoofed-victim-identity',
      'X-Roles': 'spoofed-root-role',
      'X-Scopes': 'spoofed-admin-scope',
      'X-Permissions': 'spoofed-super-permission',
      'X-Service-Name': 'spoofed-orchestrator-identity',
      'X-Request-ID': 'spoofed-request-assertion',
      'X-Correlation-ID': 'trace-corr-e2e-1',
    };

    const res = await makePostRequest(
      gatewayPort,
      '/api/v1/ai/completions',
      validAiPayload,
      clientHeaders,
    );

    // 1. Gateway response checks
    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data?.completionId).toBe('cmpl_test_999');
    expect(res.headers['x-request-id']).toBeDefined();
    expect(res.headers['x-request-id']).not.toBe('spoofed-request-assertion');
    expect(res.headers['x-correlation-id']).toBe('trace-corr-e2e-1');

    // 2. Orchestrator received checks - security perimeter enforcement
    expect(lastOrchestratorRequestHeaders).toBeDefined();
    expect(lastOrchestratorRequestHeaders?.['x-user-id']).toBe('usr_legitimate_42');
    expect(lastOrchestratorRequestHeaders?.['x-tenant-id']).toBe('tnt_legitimate_88');
    expect(lastOrchestratorRequestHeaders?.['x-service-name']).toBe('api-gateway');
    expect(lastOrchestratorRequestHeaders?.['x-roles']).toBeUndefined();
    expect(lastOrchestratorRequestHeaders?.['x-scopes']).toBeUndefined();
    expect(lastOrchestratorRequestHeaders?.['x-permissions']).toBeUndefined();
    expect(lastOrchestratorRequestHeaders?.['x-correlation-id']).toBe('trace-corr-e2e-1');
    expect(lastOrchestratorRequestHeaders?.['x-request-id']).toBe(res.headers['x-request-id']);
  });

  it('projects the model catalog to safe public canonical metadata', async () => {
    const token = signTestJwt(
      {
        sub: 'usr_catalog',
        tenant_id: 'tnt_catalog',
        iss: 'https://auth.oicunt.internal',
        aud: 'oicunt-platform',
        exp: Math.floor(Date.now() / 1000) + 3600,
        scope: 'ai:use',
      },
      jwtCtx.privateKey,
      { kid: 'gw-comp-key' },
    );

    const response = await makeGetRequest(gatewayPort, '/api/v1/ai/models', {
      Authorization: `Bearer ${token}`,
    });
    expect(response.statusCode).toBe(200);
    const models = response.body.data as unknown as Array<Record<string, unknown>>;
    expect(models[0]).toEqual({
      id: 'oicunt.model.catalog-alpha',
      displayName: 'General',
      description: 'General assistant',
      capabilities: ['streaming'],
      status: 'available',
    });
    expect(response.rawText).not.toContain('test-provider');
    expect(response.rawText).not.toContain('upstreamModelId');
    expect(response.rawText).not.toContain('pricing');
  });

  it('returns 502 Bad Gateway when downstream orchestrator is unreachable', async () => {
    // Configure gateway pointing at a dead port
    const unreachableConfig = loadServiceConfig({
      serviceName: 'api-gateway',
      port: 0,
      host: '127.0.0.1',
      orchestratorBaseUrl: 'http://127.0.0.1:54321', // Unreachable port
    });

    const tokenVerifier = new JwksTokenVerifier({
      staticJwks: jwtCtx.jwks,
      issuer: 'https://auth.oicunt.internal',
      audience: 'oicunt-platform',
    });

    const failingGateway = new GatewayServiceInstance({
      config: unreachableConfig,
      tokenVerifier,
    });
    const failingPort = await failingGateway.start();

    try {
      const tokenWithAiUse = signTestJwt(
        {
          sub: 'usr_failing',
          tenant_id: 'tnt_failing',
          iss: 'https://auth.oicunt.internal',
          aud: 'oicunt-platform',
          exp: Math.floor(Date.now() / 1000) + 3600,
          scope: 'ai:use',
        },
        jwtCtx.privateKey,
        { kid: 'gw-comp-key' },
      );

      const res = await makePostRequest(failingPort, '/api/v1/ai/completions', validAiPayload, {
        Authorization: `Bearer ${tokenWithAiUse}`,
      });

      expect(res.statusCode).toBe(502);
      expect(res.body.success).toBe(false);
      expect(res.body.error?.code).toBe('BAD_GATEWAY');
    } finally {
      await failingGateway.stop();
    }
  });

  it('accepts and forwards canonical model oicunt.model.catalog-alpha to orchestrator', async () => {
    const token = signTestJwt(
      {
        sub: 'usr_catalog_user',
        tenant_id: 'tnt_catalog_tenant',
        iss: 'https://auth.oicunt.internal',
        aud: 'oicunt-platform',
        exp: Math.floor(Date.now() / 1000) + 3600,
        scope: 'ai:use',
      },
      jwtCtx.privateKey,
      { kid: 'gw-comp-key' },
    );

    const res = await makePostRequest(
      gatewayPort,
      '/api/v1/ai/completions',
      {
        conversationId: 'conv-catalog-test',
        model: 'oicunt.model.catalog-alpha',
        messages: [{ role: 'user', content: 'Explain quantum computing in one sentence.' }],
      },
      {
        Authorization: `Bearer ${token}`,
        'X-Correlation-ID': 'corr-oicunt.model.catalog-alpha-1',
      },
    );

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(lastOrchestratorRequestBody).toBeDefined();
    expect(lastOrchestratorRequestBody?.['model']).toBe('oicunt.model.catalog-alpha');
    expect(lastOrchestratorRequestHeaders?.['x-user-id']).toBe('usr_catalog_user');
    expect(lastOrchestratorRequestHeaders?.['x-tenant-id']).toBe('tnt_catalog_tenant');
  });
});
