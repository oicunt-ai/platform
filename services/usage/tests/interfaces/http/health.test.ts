import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { UsageService } from '../../../src/service.js';

describe('Usage Health & Readiness Endpoints', () => {
  let service: UsageService;
  let baseUrl: string;

  beforeAll(async () => {
    service = new UsageService({
      port: 0,
      host: '127.0.0.1',
      useDatabase: false,
      useRabbitMq: false,
      logLevel: 'silent',
    });
    await service.start();

    const address = service.getHttpServer()?.address();
    if (typeof address === 'object' && address !== null) {
      baseUrl = `http://127.0.0.1:${address.port}`;
    }
  });

  afterAll(async () => {
    await service.stop();
  });

  it('GET /health/liveness returns 200 without authentication', async () => {
    const res = await fetch(`${baseUrl}/health/liveness`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; service: string };
    expect(body.status).toBe('ok');
    expect(body.service).toBe('usage');
  });

  it('GET /health/readiness returns 200 without authentication', async () => {
    const res = await fetch(`${baseUrl}/health/readiness`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; checks: { database: string } };
    expect(body.status).toBe('ok');
    expect(body.checks.database).toBe('up');
  });
});
