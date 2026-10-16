import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import { GatewayServiceInstance, JwksTokenVerifier, loadServiceConfig } from '../../src/index.js';
import { createTestJwtContext, signTestJwt } from '../test-jwt-helper.js';

interface TestResponse {
  statusCode: number;
  body: {
    success?: boolean;
    data?: Record<string, unknown>;
    error?: { code?: string; message?: string };
  };
}

function makeRequest(
  port: number,
  method: string,
  path: string,
  payload: unknown,
  headers: Record<string, string> = {},
): Promise<TestResponse> {
  return new Promise((resolve, reject) => {
    const payloadStr = payload === undefined ? undefined : JSON.stringify(payload);
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path,
        method,
        headers: {
          ...(payloadStr === undefined
            ? {}
            : {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(payloadStr),
              }),
          ...headers,
        },
      },
      (res) => {
        let rawData = '';
        res.on('data', (chunk) => (rawData += chunk));
        res.on('end', () => {
          resolve({
            statusCode: res.statusCode ?? 500,
            body: JSON.parse(rawData) as TestResponse['body'],
          });
        });
      },
    );
    req.on('error', reject);
    if (payloadStr !== undefined) req.write(payloadStr);
    req.end();
  });
}

describe('API Gateway - Conversation Management Integration Tests', () => {
  const jwtCtx = createTestJwtContext('gw-conv-key');
  let gatewayService: GatewayServiceInstance;
  let gatewayPort: number;

  let mockOrchestratorServer: http.Server;
  let mockOrchestratorPort: number;
  let lastMethod: string | null = null;
  let lastPath: string | null = null;
  let lastBody: Record<string, unknown> | null = null;
  let upstreamDenied = false;

  const storedConversation = {
    id: 'conv_1',
    title: 'Pinned chat',
    status: 'active',
    messageCount: 3,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
    metadata: { pinned: true },
  };

  function respond(res: http.ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(body));
  }

  beforeAll(async () => {
    mockOrchestratorServer = http.createServer((req, res) => {
      lastMethod = req.method ?? null;
      lastPath = req.url ?? null;

      let bodyData = '';
      req.on('data', (chunk) => (bodyData += chunk));
      req.on('end', () => {
        try {
          lastBody = bodyData === '' ? null : (JSON.parse(bodyData) as Record<string, unknown>);
        } catch {
          lastBody = null;
        }

        if (upstreamDenied) {
          respond(res, 403, {
            success: false,
            error: { code: 'USER_MISMATCH', message: 'Conversation belongs to another user' },
          });
          return;
        }

        if (lastPath === '/internal/v1/orchestrator/conversations' && lastMethod === 'GET') {
          respond(res, 200, {
            success: true,
            data: {
              conversations: [
                storedConversation,
                { ...storedConversation, id: 'conv_2', title: null, metadata: {} },
              ],
              total: 2,
              hasMore: false,
            },
          });
          return;
        }

        if (
          lastPath === '/internal/v1/orchestrator/conversations/conv_1' &&
          lastMethod === 'PATCH'
        ) {
          respond(res, 200, {
            success: true,
            data: {
              ...storedConversation,
              ...(lastBody?.['title'] === undefined ? {} : { title: lastBody['title'] }),
              ...(lastBody?.['metadata'] === undefined ? {} : { metadata: lastBody['metadata'] }),
            },
          });
          return;
        }

        if (
          lastPath === '/internal/v1/orchestrator/conversations/conv_1' &&
          lastMethod === 'DELETE'
        ) {
          respond(res, 200, {
            success: true,
            data: { deleted: true, conversationId: 'conv_1', hard: false },
          });
          return;
        }

        respond(res, 404, {
          success: false,
          error: { code: 'NOT_FOUND', message: `Unhandled ${lastMethod} ${lastPath}` },
        });
      });
    });

    await new Promise<void>((resolve) => {
      mockOrchestratorServer.listen(0, '127.0.0.1', () => {
        const address = mockOrchestratorServer.address();
        mockOrchestratorPort = typeof address === 'object' && address ? address.port : 0;
        resolve();
      });
    });

    const config = loadServiceConfig({
      serviceName: 'api-gateway',
      port: 0,
      host: '127.0.0.1',
      orchestratorBaseUrl: `http://127.0.0.1:${mockOrchestratorPort}`,
    });

    gatewayService = new GatewayServiceInstance({
      config,
      tokenVerifier: new JwksTokenVerifier({
        staticJwks: jwtCtx.jwks,
        issuer: 'https://auth.oicunt.internal',
        audience: 'oicunt-platform',
      }),
    });
    gatewayPort = await gatewayService.start();
  });

  afterAll(async () => {
    await gatewayService.stop();
    await new Promise<void>((resolve) => mockOrchestratorServer.close(() => resolve()));
  });

  function token(scope: string): string {
    return signTestJwt(
      {
        sub: 'user-conv',
        tenant_id: 'tenant-conv',
        iss: 'https://auth.oicunt.internal',
        aud: 'oicunt-platform',
        exp: Math.floor(Date.now() / 1000) + 3600,
        scope,
      },
      jwtCtx.privateKey,
      { kid: 'gw-conv-key' },
    );
  }

  it('requires authentication on the conversation list', async () => {
    const res = await makeRequest(gatewayPort, 'GET', '/api/v1/ai/conversations', undefined);
    expect(res.statusCode).toBe(401);
  });

  it('rejects conversation management without the ai:use scope', async () => {
    const res = await makeRequest(
      gatewayPort,
      'DELETE',
      '/api/v1/ai/conversations/conv_1',
      undefined,
      { Authorization: `Bearer ${token('billing:read')}` },
    );
    expect(res.statusCode).toBe(403);
    expect(res.body.error?.code).toBe('FORBIDDEN');
  });

  it('projects authoritative pin state and hides conversation metadata', async () => {
    const res = await makeRequest(gatewayPort, 'GET', '/api/v1/ai/conversations', undefined, {
      Authorization: `Bearer ${token('ai:use')}`,
    });

    expect(res.statusCode).toBe(200);
    const conversations = (res.body.data?.['conversations'] ?? []) as Record<string, unknown>[];
    expect(conversations[0]?.['pinned']).toBe(true);
    expect(conversations[1]?.['pinned']).toBe(false);
    expect(conversations[0]).not.toHaveProperty('metadata');
  });

  it('renames a conversation and forwards only the title', async () => {
    const res = await makeRequest(
      gatewayPort,
      'PATCH',
      '/api/v1/ai/conversations/conv_1',
      { title: 'Roadmap' },
      { Authorization: `Bearer ${token('ai:use')}` },
    );

    expect(res.statusCode).toBe(200);
    expect(lastMethod).toBe('PATCH');
    expect(lastPath).toBe('/internal/v1/orchestrator/conversations/conv_1');
    expect(lastBody).toEqual({ title: 'Roadmap' });
    expect(res.body.data?.['title']).toBe('Roadmap');
    expect(res.body.data?.['pinned']).toBe(true);
  });

  it('maps public pinned to authoritative conversation metadata', async () => {
    const res = await makeRequest(
      gatewayPort,
      'PATCH',
      '/api/v1/ai/conversations/conv_1',
      { pinned: false },
      { Authorization: `Bearer ${token('ai:use')}` },
    );

    expect(res.statusCode).toBe(200);
    expect(lastBody).toEqual({ metadata: { pinned: false } });
    expect(res.body.data?.['pinned']).toBe(false);
  });

  it('rejects invalid update bodies without calling the orchestrator', async () => {
    lastPath = null;
    const res = await makeRequest(
      gatewayPort,
      'PATCH',
      '/api/v1/ai/conversations/conv_1',
      { metadata: {} },
      { Authorization: `Bearer ${token('ai:use')}` },
    );

    expect(res.statusCode).toBe(400);
    expect(res.body.error?.code).toBe('VALIDATION_FAILED');
    expect(lastPath).toBeNull();

    const empty = await makeRequest(
      gatewayPort,
      'PATCH',
      '/api/v1/ai/conversations/conv_1',
      {},
      { Authorization: `Bearer ${token('ai:use')}` },
    );
    expect(empty.statusCode).toBe(400);
  });

  it('deletes a conversation and reports the authoritative result', async () => {
    const res = await makeRequest(
      gatewayPort,
      'DELETE',
      '/api/v1/ai/conversations/conv_1',
      undefined,
      { Authorization: `Bearer ${token('ai:use')}` },
    );

    expect(res.statusCode).toBe(200);
    expect(lastMethod).toBe('DELETE');
    expect(lastPath).toBe('/internal/v1/orchestrator/conversations/conv_1');
    expect(res.body.data?.['deleted']).toBe(true);
    expect(res.body.data?.['conversationId']).toBe('conv_1');
  });

  it('propagates upstream ownership denial on conversation mutations', async () => {
    upstreamDenied = true;
    try {
      const res = await makeRequest(
        gatewayPort,
        'DELETE',
        '/api/v1/ai/conversations/conv_1',
        undefined,
        { Authorization: `Bearer ${token('ai:use')}` },
      );

      expect(res.statusCode).toBe(403);
      expect(res.body.error?.code).toBe('FORBIDDEN');
    } finally {
      upstreamDenied = false;
    }
  });
});
