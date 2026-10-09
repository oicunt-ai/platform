import { describe, expect, it } from 'vitest';
import {
  extractMetricDeltas,
  getDailyBucketDate,
  getHourlyBucketStart,
} from '../../src/domain/aggregation.js';
import type { UsageEvent } from '../../src/domain/types.js';

describe('Domain Aggregation Utilities', () => {
  it('truncates timestamps accurately into UTC hourly buckets', () => {
    const timestamp1 = '2026-10-07T14:45:32.123Z';
    expect(getHourlyBucketStart(timestamp1)).toBe('2026-10-07T14:00:00.000Z');

    const timestamp2 = '2026-10-07T23:59:59.999Z';
    expect(getHourlyBucketStart(timestamp2)).toBe('2026-10-07T23:00:00.000Z');

    const timestamp3 = '2026-10-08T00:00:00.000Z';
    expect(getHourlyBucketStart(timestamp3)).toBe('2026-10-08T00:00:00.000Z');
  });

  it('truncates timestamps accurately into UTC daily date buckets', () => {
    const timestamp1 = '2026-10-07T14:45:32.123Z';
    expect(getDailyBucketDate(timestamp1)).toBe('2026-10-07');

    const timestamp2 = '2026-10-07T23:59:59.999Z';
    expect(getDailyBucketDate(timestamp2)).toBe('2026-10-07');

    const timestamp3 = '2026-10-08T00:00:00.001Z';
    expect(getDailyBucketDate(timestamp3)).toBe('2026-10-08');
  });

  it('extracts non-null numerical metric deltas correctly', () => {
    const event: UsageEvent = {
      eventId: 'evt-1',
      schemaVersion: '1.0.0',
      tenantId: 'tenant-1',
      productId: 'billy',
      sourceService: 'model-gateway',
      operation: 'model.completion',
      resourceId: 'oicunt.model.catalog-alpha',
      measurements: {
        'tokens.input': 1000,
        'tokens.output': 250,
        ...({ 'tokens.reasoning': undefined } as unknown as Record<string, number>),
      },
      dimensions: {},
      lineage: { correlationId: 'c1', requestId: 'r1' },
      idempotencyKey: 'idemp-1',
      occurredAt: '2026-10-07T10:00:00.000Z',
    };

    const deltas = extractMetricDeltas(event);
    expect(deltas).toHaveLength(2);
    expect(deltas).toEqual([
      { metricName: 'tokens.input', delta: 1000 },
      { metricName: 'tokens.output', delta: 250 },
    ]);
  });
});
