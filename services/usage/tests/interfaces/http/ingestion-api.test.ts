import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { UsageService } from '../../../src/service.js';

describe('Usage HTTP Ingestion API', () => {
  let service: UsageService;
  let baseUrl: string;
  const testToken = 'internal-test-secret-token';

  beforeAll(async () => {
    service = new UsageService({
      port: 0, // ephemeral port
      host: '127.0.0.1',
      internalToken: testToken,
      useDatabase: false,
      useRabbitMq: false,
      logLevel: 'silent',
    });
    await service.start();

    const address = service.getHttpServer()?.address();
    if (typeof address === 'object' && address !== null) {
      baseUrl = `http://127.0.0.1:${address.port}`;
    } else {
      throw new Error('Failed to obtain server address');
    }
  });

  afterAll(async () => {
    await service.stop();
  });

  const validEvent = {
    eventId: 'evt-http-1',
    schemaVersion: '1.0.0',
    tenantId: 'tenant-http-corp',
    productId: 'billy',
    sourceService: 'model-gateway',
    operation: 'model.completion',
    resourceId: 'oicunt.model.catalog-alpha',
    measurements: {
      'tokens.input': 1200,
      'tokens.output': 300,
      'tokens.total': 1500,
      'units.requests': 1,
    },
    dimensions: { provider: 'test-provider' },
    lineage: { correlationId: 'c-http-1', requestId: 'r-http-1' },
    idempotencyKey: 'http_key_1',
    occurredAt: '2026-10-07T12:00:00.000Z',
  };

  it('POST /internal/v1/usage/events returns 201 on first persistence', async () => {
    const res = await fetch(`${baseUrl}/internal/v1/usage/events`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Token': testToken,
      },
      body: JSON.stringify(validEvent),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      success: boolean;
      data: { status: string; eventId: string };
    };
    expect(body.success).toBe(true);
    expect(body.data.status).toBe('persisted');
    expect(body.data.eventId).toBe('evt-http-1');
  });

  it('POST /internal/v1/usage/events returns 200 on duplicate idempotencyKey', async () => {
    const duplicatePayload = {
      ...validEvent,
      eventId: 'evt-http-2', // new eventId
      // same tenantId and idempotencyKey
    };

    const res = await fetch(`${baseUrl}/internal/v1/usage/events`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Token': testToken,
      },
      body: JSON.stringify(duplicatePayload),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      success: boolean;
      data: { status: string; eventId: string };
    };
    expect(body.success).toBe(true);
    expect(body.data.status).toBe('duplicate');
    expect(body.data.eventId).toBe('evt-http-1'); // returns original event ID
  });

  it('POST /internal/v1/usage/events returns 400 on invalid payload', async () => {
    const invalidPayload = {
      ...validEvent,
      tenantId: '', // missing mandatory tenantId
    };

    const res = await fetch(`${baseUrl}/internal/v1/usage/events`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Token': testToken,
      },
      body: JSON.stringify(invalidPayload),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { success: boolean; error: { code: string } };
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('USAGE_VALIDATION_ERROR');
  });

  it('POST /internal/v1/usage/events/batch ingests a batch idempotently', async () => {
    const batch = [
      { ...validEvent, eventId: 'batch-1', idempotencyKey: 'bk-1' },
      { ...validEvent, eventId: 'batch-2', idempotencyKey: 'bk-2' },
      { ...validEvent, eventId: 'batch-3', idempotencyKey: 'bk-1' }, // duplicate of bk-1
    ];

    const res = await fetch(`${baseUrl}/internal/v1/usage/events/batch`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Token': testToken,
      },
      body: JSON.stringify(batch),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      success: boolean;
      data: { accepted: number; duplicates: number };
    };
    expect(body.success).toBe(true);
    expect(body.data.accepted).toBe(2);
    expect(body.data.duplicates).toBe(1);
  });
});
