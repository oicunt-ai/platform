import { beforeEach, describe, expect, it } from 'vitest';
import { InMemoryUsageRepository } from '../../src/infrastructure/repositories/in-memory-usage.repository.js';
import type { UsageEvent } from '../../src/domain/types.js';

describe('InMemoryUsageRepository', () => {
  let repo: InMemoryUsageRepository;

  beforeEach(() => {
    repo = new InMemoryUsageRepository();
  });

  const createSampleEvent = (
    id: string,
    key: string,
    tokens: number,
    occurredAt: string,
  ): UsageEvent => ({
    eventId: id,
    schemaVersion: '1.0.0',
    tenantId: 'tenant-test-1',
    productId: 'billy',
    sourceService: 'model-gateway',
    operation: 'model.completion',
    resourceId: 'oicunt.model.anthropic.claude-3-5-sonnet',
    measurements: {
      'tokens.input': tokens,
      'tokens.output': Math.round(tokens / 4),
      'tokens.total': tokens + Math.round(tokens / 4),
      'units.requests': 1,
    },
    dimensions: { provider: 'anthropic' },
    lineage: { correlationId: 'c-1', requestId: 'r-1' },
    idempotencyKey: key,
    occurredAt,
  });

  it('persists a new event and updates rollups', async () => {
    const event = createSampleEvent('e1', 'k1', 1000, '2026-10-07T12:30:00.000Z');
    const result = await repo.saveEvent(event);

    expect(result.persisted).toBe(true);
    expect(result.event.eventId).toBe('e1');

    const summary = await repo.querySummary({
      tenantId: 'tenant-test-1',
      startTime: '2026-10-07T00:00:00.000Z',
      endTime: '2026-10-07T23:59:59.999Z',
    });

    expect(summary.eventCount).toBe(1);
    expect(summary.totals['tokens.input']).toBe(1000);
    expect(summary.totals['tokens.output']).toBe(250);
  });

  it('recognizes duplicate idempotencyKey without creating second record or double-counting aggregates', async () => {
    const event1 = createSampleEvent('e1', 'dup-key', 1000, '2026-10-07T12:30:00.000Z');
    const event2 = createSampleEvent('e2', 'dup-key', 2000, '2026-10-07T12:30:00.000Z');

    const res1 = await repo.saveEvent(event1);
    expect(res1.persisted).toBe(true);

    const res2 = await repo.saveEvent(event2);
    expect(res2.persisted).toBe(false);
    expect(res2.event.eventId).toBe('e1'); // returned the original

    // Check summary totals: must be 1000, NOT 3000!
    const summary = await repo.querySummary({
      tenantId: 'tenant-test-1',
      startTime: '2026-10-07T00:00:00.000Z',
      endTime: '2026-10-07T23:59:59.999Z',
    });

    expect(summary.eventCount).toBe(1);
    expect(summary.totals['tokens.input']).toBe(1000);
  });

  it('handles batch ingestion with mixed new and duplicate events', async () => {
    const event1 = createSampleEvent('e1', 'k1', 500, '2026-10-07T10:00:00.000Z');
    const event2 = createSampleEvent('e2', 'k2', 600, '2026-10-07T11:00:00.000Z');
    const eventDuplicate = createSampleEvent('e3', 'k1', 700, '2026-10-07T10:00:00.000Z');

    const batchRes = await repo.saveEventsBatch([event1, event2, eventDuplicate]);
    expect(batchRes.accepted).toBe(2);
    expect(batchRes.duplicates).toBe(1);
    expect(batchRes.results).toHaveLength(3);
    expect(batchRes.results[2]!.status).toBe('duplicate');
  });

  it('queries timeseries buckets accurately for hourly and daily views', async () => {
    const e1 = createSampleEvent('e1', 'k1', 1000, '2026-10-07T10:15:00.000Z');
    const e2 = createSampleEvent('e2', 'k2', 2000, '2026-10-07T10:45:00.000Z');
    const e3 = createSampleEvent('e3', 'k3', 3000, '2026-10-07T11:20:00.000Z');

    await repo.saveEventsBatch([e1, e2, e3]);

    const hourly = await repo.queryTimeseries({
      tenantId: 'tenant-test-1',
      startTime: '2026-10-07T00:00:00.000Z',
      endTime: '2026-10-07T23:59:59.999Z',
      granularity: 'hourly',
    });

    expect(hourly.series).toHaveLength(2);
    expect(hourly.series[0]?.bucket).toBe('2026-10-07T10:00:00.000Z');
    expect(hourly.series[0]?.metrics['tokens.input']).toBe(3000);
    expect(hourly.series[0]?.eventCount).toBe(2);

    expect(hourly.series[1]?.bucket).toBe('2026-10-07T11:00:00.000Z');
    expect(hourly.series[1]?.metrics['tokens.input']).toBe(3000);
    expect(hourly.series[1]?.eventCount).toBe(1);

    const daily = await repo.queryTimeseries({
      tenantId: 'tenant-test-1',
      startTime: '2026-10-07T00:00:00.000Z',
      endTime: '2026-10-07T23:59:59.999Z',
      granularity: 'daily',
    });

    expect(daily.series).toHaveLength(1);
    expect(daily.series[0]?.bucket).toBe('2026-10-07');
    expect(daily.series[0]?.metrics['tokens.input']).toBe(6000);
    expect(daily.series[0]?.eventCount).toBe(3);
  });

  it('supports raw event querying with pagination and cursor', async () => {
    const events = Array.from({ length: 15 }, (_, i) =>
      createSampleEvent(
        `evt-${i}`,
        `key-${i}`,
        100 * (i + 1),
        `2026-10-07T10:${String(i).padStart(2, '0')}:00.000Z`,
      ),
    );
    await repo.saveEventsBatch(events);

    const page1 = await repo.queryEvents({
      tenantId: 'tenant-test-1',
      limit: 10,
    });

    expect(page1.events).toHaveLength(10);
    expect(page1.totalCount).toBe(15);
    expect(page1.nextCursor).toBeDefined();

    const page2 = await repo.queryEvents({
      tenantId: 'tenant-test-1',
      limit: 10,
      cursor: page1.nextCursor,
    });

    expect(page2.events).toHaveLength(5);
    expect(page2.nextCursor).toBeUndefined();
  });

  it('recomputes derived aggregates deterministically from raw usage events', async () => {
    const e1 = createSampleEvent('e1', 'k1', 1000, '2026-10-07T10:15:00.000Z');
    const e2 = createSampleEvent('e2', 'k2', 2000, '2026-10-07T10:45:00.000Z');
    await repo.saveEventsBatch([e1, e2]);

    const recompute = await repo.recomputeAggregates(
      'tenant-test-1',
      '2026-10-07T00:00:00.000Z',
      '2026-10-07T23:59:59.999Z',
    );

    expect(recompute.recomputedHours).toBe(1);
    expect(recompute.recomputedDays).toBe(1);

    const summary = await repo.querySummary({
      tenantId: 'tenant-test-1',
      startTime: '2026-10-07T00:00:00.000Z',
      endTime: '2026-10-07T23:59:59.999Z',
    });

    expect(summary.totals['tokens.input']).toBe(3000);
  });
});
