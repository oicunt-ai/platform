import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { UsageService } from '../../../src/service.js';

describe('Usage HTTP Queries & Reversals API', () => {
  let service: UsageService;
  let baseUrl: string;
  const testToken = 'internal-test-secret-token';

  beforeAll(async () => {
    service = new UsageService({
      port: 0,
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
    }

    // Seed test events
    await service.ingestUsageUseCase.execute({
      eventId: 'evt-seed-1',
      schemaVersion: '1.0.0',
      tenantId: 'tenant-queries-corp',
      productId: 'billy',
      sourceService: 'model-gateway',
      operation: 'model.completion',
      resourceId: 'oicunt.model.catalog-alpha',
      measurements: {
        'tokens.input': 2000,
        'tokens.output': 500,
        'tokens.total': 2500,
      },
      dimensions: { provider: 'test-provider' },
      lineage: { correlationId: 'c-seed', requestId: 'r-seed' },
      idempotencyKey: 'seed_key_1',
      occurredAt: '2026-10-07T12:00:00.000Z',
    });
  });

  afterAll(async () => {
    await service.stop();
  });

  it('GET /internal/v1/usage/summary returns aggregated totals', async () => {
    const url = new URL(`${baseUrl}/internal/v1/usage/summary`);
    url.searchParams.set('tenantId', 'tenant-queries-corp');
    url.searchParams.set('startTime', '2026-10-07T00:00:00.000Z');
    url.searchParams.set('endTime', '2026-10-07T23:59:59.999Z');

    const res = await fetch(url.toString(), {
      headers: { 'X-Internal-Token': testToken },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      success: boolean;
      data: { tenantId: string; totals: Record<string, number> };
    };
    expect(body.success).toBe(true);
    expect(body.data.tenantId).toBe('tenant-queries-corp');
    expect(body.data.totals['tokens.input']).toBe(2000);
    expect(body.data.totals['tokens.output']).toBe(500);
  });

  it('GET /internal/v1/usage/timeseries returns bucketed metrics', async () => {
    const url = new URL(`${baseUrl}/internal/v1/usage/timeseries`);
    url.searchParams.set('tenantId', 'tenant-queries-corp');
    url.searchParams.set('startTime', '2026-10-07T00:00:00.000Z');
    url.searchParams.set('endTime', '2026-10-07T23:59:59.999Z');
    url.searchParams.set('granularity', 'daily');

    const res = await fetch(url.toString(), {
      headers: { 'X-Internal-Token': testToken },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      success: boolean;
      data: { series: Array<{ bucket: string; metrics: Record<string, number> }> };
    };
    expect(body.success).toBe(true);
    expect(body.data.series).toHaveLength(1);
    expect(body.data.series[0]?.bucket).toBe('2026-10-07');
    expect(body.data.series[0]?.metrics['tokens.input']).toBe(2000);
  });

  it('GET /internal/v1/usage/events returns raw paginated events', async () => {
    const url = new URL(`${baseUrl}/internal/v1/usage/events`);
    url.searchParams.set('tenantId', 'tenant-queries-corp');

    const res = await fetch(url.toString(), {
      headers: { 'X-Internal-Token': testToken },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      success: boolean;
      data: { events: Array<{ eventId: string }> };
    };
    expect(body.success).toBe(true);
    expect(body.data.events).toHaveLength(1);
    expect(body.data.events[0]?.eventId).toBe('evt-seed-1');
  });

  it('POST /internal/v1/usage/reversals creates an append-only reversal event', async () => {
    const res = await fetch(`${baseUrl}/internal/v1/usage/reversals`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Token': testToken,
      },
      body: JSON.stringify({
        tenantId: 'tenant-queries-corp',
        originalEventId: 'evt-seed-1',
        reason: 'Service dropped connection',
      }),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      success: boolean;
      data: {
        reversalEvent: {
          operation: string;
          measurements: Record<string, number>;
        };
      };
    };
    expect(body.success).toBe(true);
    expect(body.data.reversalEvent.operation).toBe('usage.reversal');
    expect(body.data.reversalEvent.measurements['tokens.input']).toBe(-2000);

    // Verify summary is zeroed out
    const summaryUrl = new URL(`${baseUrl}/internal/v1/usage/summary`);
    summaryUrl.searchParams.set('tenantId', 'tenant-queries-corp');
    summaryUrl.searchParams.set('startTime', '2026-10-07T00:00:00.000Z');
    summaryUrl.searchParams.set('endTime', '2026-10-07T23:59:59.999Z');

    const sumRes = await fetch(summaryUrl.toString(), {
      headers: { 'X-Internal-Token': testToken },
    });
    const sumBody = (await sumRes.json()) as {
      data: { totals: Record<string, number> };
    };
    expect(sumBody.data.totals['tokens.input']).toBe(0);
  });
});
