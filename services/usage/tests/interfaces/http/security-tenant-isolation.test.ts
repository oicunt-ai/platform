import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { UsageService } from '../../../src/service.js';

describe('Usage Security & Tenant Boundary Isolation', () => {
  let service: UsageService;
  let baseUrl: string;
  const validToken = 'super-secret-internal-service-token';

  beforeAll(async () => {
    service = new UsageService({
      port: 0,
      host: '127.0.0.1',
      internalToken: validToken,
      useDatabase: false,
      useRabbitMq: false,
      logLevel: 'silent',
    });
    await service.start();

    const address = service.getHttpServer()?.address();
    if (typeof address === 'object' && address !== null) {
      baseUrl = `http://127.0.0.1:${address.port}`;
    }

    // Seed events for Tenant A
    await service.ingestUsageUseCase.execute({
      eventId: 'evt-tenant-a',
      schemaVersion: '1.0.0',
      tenantId: 'tenant-alpha',
      productId: 'billy',
      sourceService: 'model-gateway',
      operation: 'model.completion',
      resourceId: 'oicunt.model.claude',
      measurements: { 'tokens.input': 5000 },
      dimensions: {},
      lineage: { correlationId: 'c-a', requestId: 'r-a' },
      idempotencyKey: 'k-a',
      occurredAt: '2026-10-07T12:00:00.000Z',
    });
  });

  afterAll(async () => {
    await service.stop();
  });

  it('rejects unauthenticated requests missing internal token with 401', async () => {
    const res = await fetch(
      `${baseUrl}/internal/v1/usage/summary?tenantId=tenant-alpha&startTime=2026-10-07T00:00:00.000Z&endTime=2026-10-07T23:59:59.999Z`,
    );
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('UNAUTHORIZED');
  });

  it('rejects requests with invalid internal token with 401', async () => {
    const res = await fetch(
      `${baseUrl}/internal/v1/usage/summary?tenantId=tenant-alpha&startTime=2026-10-07T00:00:00.000Z&endTime=2026-10-07T23:59:59.999Z`,
      {
        headers: { 'X-Internal-Token': 'wrong-token' },
      },
    );
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('UNAUTHORIZED');
  });

  it('blocks tenant spoofing during event ingestion when header contradicts body tenantId', async () => {
    const res = await fetch(`${baseUrl}/internal/v1/usage/events`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Token': validToken,
        'X-Tenant-ID': 'tenant-alpha', // Authenticated caller belongs to alpha
      },
      body: JSON.stringify({
        eventId: 'evt-spoof-1',
        schemaVersion: '1.0.0',
        tenantId: 'tenant-beta', // Payload claims beta
        productId: 'billy',
        sourceService: 'model-gateway',
        operation: 'model.completion',
        resourceId: 'oicunt.model.claude',
        measurements: { 'tokens.input': 100 },
        dimensions: {},
        lineage: { correlationId: 'c-s', requestId: 'r-s' },
        idempotencyKey: 'k-s',
        occurredAt: '2026-10-07T12:00:00.000Z',
      }),
    });

    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('TENANT_MISMATCH');
  });

  it('blocks cross-tenant summary query when header contradicts query param', async () => {
    const url = new URL(`${baseUrl}/internal/v1/usage/summary`);
    url.searchParams.set('tenantId', 'tenant-alpha');
    url.searchParams.set('startTime', '2026-10-07T00:00:00.000Z');
    url.searchParams.set('endTime', '2026-10-07T23:59:59.999Z');

    const res = await fetch(url.toString(), {
      headers: {
        'X-Internal-Token': validToken,
        'X-Tenant-ID': 'tenant-beta', // Authenticated as Beta trying to read Alpha
      },
    });

    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('TENANT_MISMATCH');
  });

  it('ensures Tenant Beta querying its own data receives zero results from Tenant Alpha', async () => {
    const url = new URL(`${baseUrl}/internal/v1/usage/summary`);
    url.searchParams.set('tenantId', 'tenant-beta');
    url.searchParams.set('startTime', '2026-10-07T00:00:00.000Z');
    url.searchParams.set('endTime', '2026-10-07T23:59:59.999Z');

    const res = await fetch(url.toString(), {
      headers: {
        'X-Internal-Token': validToken,
        'X-Tenant-ID': 'tenant-beta',
      },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { tenantId: string; eventCount: number; totals: Record<string, number> };
    };
    expect(body.data.tenantId).toBe('tenant-beta');
    expect(body.data.eventCount).toBe(0);
    expect(body.data.totals).toEqual({});
  });

  it('blocks cross-tenant timeseries query when header contradicts query param', async () => {
    const url = new URL(`${baseUrl}/internal/v1/usage/timeseries`);
    url.searchParams.set('tenantId', 'tenant-alpha');
    url.searchParams.set('startTime', '2026-10-07T00:00:00.000Z');
    url.searchParams.set('endTime', '2026-10-07T23:59:59.999Z');

    const res = await fetch(url.toString(), {
      headers: {
        'X-Internal-Token': validToken,
        'X-Tenant-ID': 'tenant-beta',
      },
    });

    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('TENANT_MISMATCH');
  });

  it('blocks cross-tenant events query when header contradicts query param', async () => {
    const url = new URL(`${baseUrl}/internal/v1/usage/events`);
    url.searchParams.set('tenantId', 'tenant-alpha');

    const res = await fetch(url.toString(), {
      headers: {
        'X-Internal-Token': validToken,
        'X-Tenant-ID': 'tenant-beta',
      },
    });

    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('TENANT_MISMATCH');
  });

  it('blocks cross-tenant reversal request when header contradicts body tenantId', async () => {
    const res = await fetch(`${baseUrl}/internal/v1/usage/reversals`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Token': validToken,
        'X-Tenant-ID': 'tenant-beta',
      },
      body: JSON.stringify({
        tenantId: 'tenant-alpha',
        originalEventId: 'evt-tenant-a',
        reason: 'Malicious cross-tenant refund',
      }),
    });

    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('TENANT_MISMATCH');
  });

  it('blocks cross-tenant aggregate recomputation when header contradicts body tenantId', async () => {
    const res = await fetch(`${baseUrl}/internal/v1/usage/aggregates/recompute`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Token': validToken,
        'X-Tenant-ID': 'tenant-beta',
      },
      body: JSON.stringify({
        tenantId: 'tenant-alpha',
        startTime: '2026-10-07T00:00:00.000Z',
        endTime: '2026-10-07T23:59:59.999Z',
      }),
    });

    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('TENANT_MISMATCH');
  });
});
