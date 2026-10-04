import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import { ServiceInstance, loadServiceConfig } from '../../src/index.js';

interface TestResponse {
  statusCode: number;
  headers: http.IncomingHttpHeaders;
  body: {
    success?: boolean;
    data?: {
      status?: string;
      serviceName?: string;
      version?: string;
      uptimeSeconds?: number;
    };
    error?: {
      code?: string;
      message?: string;
    };
    meta?: {
      correlationId?: string;
      timestamp?: string;
      executionTimeMs?: number;
    };
    [key: string]: unknown;
  };
}

function makeRequest(
  port: number,
  path: string,
  headers: Record<string, string> = {},
): Promise<TestResponse> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path,
        method: 'GET',
        headers,
      },
      (res) => {
        let rawData = '';
        res.on('data', (chunk) => {
          rawData += chunk;
        });
        res.on('end', () => {
          try {
            const body = JSON.parse(rawData) as Record<string, unknown>;
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

describe('Service Template - Integration HTTP Probes', () => {
  let service: ServiceInstance;
  let boundPort: number;

  beforeAll(async () => {
    const config = loadServiceConfig({
      serviceName: 'integration-test-service',
      port: 0, // OS assigns random free port
      host: '127.0.0.1',
    });

    service = new ServiceInstance({ config });
    boundPort = await service.start();
  });

  afterAll(async () => {
    await service.stop();
  });

  it('GET /healthz returns liveness probe with ApiResponse envelope', async () => {
    const response = await makeRequest(boundPort, '/healthz');

    expect(response.statusCode).toBe(200);
    expect(response.body.success).toBe(true);
    expect(response.body.data?.status).toBe('alive');
    expect(response.body.data?.serviceName).toBe('integration-test-service');
    expect(response.headers['x-correlation-id']).toBeDefined();
  });

  it('GET /readyz returns readiness probe with status ready', async () => {
    const response = await makeRequest(boundPort, '/readyz');

    expect(response.statusCode).toBe(200);
    expect(response.body.success).toBe(true);
    expect(response.body.data?.status).toBe('ready');
  });

  it('GET /api/v1/health returns application status with custom correlation id', async () => {
    const customCorrelationId = 'test-trace-999';
    const response = await makeRequest(boundPort, '/api/v1/health', {
      'x-correlation-id': customCorrelationId,
    });

    expect(response.statusCode).toBe(200);
    expect(response.body.success).toBe(true);
    expect(response.body.data?.status).toBe('healthy');
    expect(response.body.meta?.correlationId).toBe(customCorrelationId);
    expect(response.headers['x-correlation-id']).toBe(customCorrelationId);
  });

  it('GET /unknown-route returns 404 with ApiErrorResponse envelope', async () => {
    const response = await makeRequest(boundPort, '/non-existent-endpoint');

    expect(response.statusCode).toBe(404);
    expect(response.body.success).toBe(false);
    expect(response.body.error?.code).toBe('NOT_FOUND');
  });
});
