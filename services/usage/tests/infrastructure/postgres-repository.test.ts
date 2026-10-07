import { describe, expect, it, vi } from 'vitest';
import { PostgresUsageRepository } from '../../src/infrastructure/repositories/postgres-usage.repository.js';
import type { DatabasePool } from '../../src/infrastructure/database/connection.js';
import type { UsageEvent } from '../../src/domain/types.js';

describe('PostgresUsageRepository', () => {
  const sampleEvent: UsageEvent = {
    eventId: 'evt-pg-1',
    schemaVersion: '1.0.0',
    tenantId: 'tenant-pg',
    productId: 'billy',
    sourceService: 'model-gateway',
    operation: 'model.completion',
    resourceId: 'oicunt.model.claude',
    measurements: {
      'tokens.input': 1000,
      'tokens.output': 250,
    },
    dimensions: { provider: 'anthropic' },
    lineage: { correlationId: 'c1', requestId: 'r1' },
    idempotencyKey: 'k-pg-1',
    occurredAt: '2026-10-07T12:00:00.000Z',
  };

  it('saves new event in transaction and upserts hourly and daily aggregates', async () => {
    const mockClient = {
      query: vi.fn().mockImplementation((text: string) => {
        if (text.includes('INSERT INTO oicunt_usage.usage_events')) {
          return Promise.resolve({
            rows: [{ event_id: 'evt-pg-1', ingested_at: new Date('2026-10-07T12:00:01.000Z') }],
          });
        }
        if (text.includes('INSERT INTO oicunt_usage.usage_aggregates')) {
          return Promise.resolve({ rowCount: 1, rows: [] });
        }
        return Promise.resolve({ rows: [] });
      }),
    };

    const mockPool = {
      withTransaction: vi
        .fn()
        .mockImplementation((cb: (client: unknown) => Promise<unknown>) => cb(mockClient)),
      query: vi.fn(),
    } as unknown as DatabasePool;

    const repo = new PostgresUsageRepository(mockPool);
    const result = await repo.saveEvent(sampleEvent);

    expect(result.persisted).toBe(true);
    expect(result.event.eventId).toBe('evt-pg-1');
    expect(mockClient.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO oicunt_usage.usage_events'),
      expect.any(Array),
    );
    expect(mockClient.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO oicunt_usage.usage_aggregates_hourly'),
      expect.any(Array),
    );
    expect(mockClient.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO oicunt_usage.usage_aggregates_daily'),
      expect.any(Array),
    );
  });

  it('safely handles duplicate idempotency key on conflict and does not touch aggregates', async () => {
    const mockClient = {
      query: vi.fn().mockImplementation((text: string) => {
        if (text.includes('INSERT INTO oicunt_usage.usage_events')) {
          // Zero rows returned due to ON CONFLICT DO NOTHING
          return Promise.resolve({ rows: [] });
        }
        if (text.includes('SELECT * FROM oicunt_usage.usage_events')) {
          return Promise.resolve({
            rows: [
              {
                event_id: 'evt-pg-1',
                schema_version: '1.0.0',
                tenant_id: 'tenant-pg',
                product_id: 'billy',
                source_service: 'model-gateway',
                operation: 'model.completion',
                resource_id: 'oicunt.model.claude',
                measurements: { 'tokens.input': 1000 },
                dimensions: {},
                lineage: { correlationId: 'c1', requestId: 'r1' },
                idempotency_key: 'k-pg-1',
                occurred_at: new Date('2026-10-07T12:00:00.000Z'),
                ingested_at: new Date('2026-10-07T12:00:01.000Z'),
              },
            ],
          });
        }
        return Promise.resolve({ rows: [] });
      }),
    };

    const mockPool = {
      withTransaction: vi
        .fn()
        .mockImplementation((cb: (client: unknown) => Promise<unknown>) => cb(mockClient)),
      query: vi.fn(),
    } as unknown as DatabasePool;

    const repo = new PostgresUsageRepository(mockPool);
    const result = await repo.saveEvent(sampleEvent);

    expect(result.persisted).toBe(false);
    expect(result.event.eventId).toBe('evt-pg-1');
    // Ensure aggregates were NOT upserted on duplicate!
    expect(mockClient.query).not.toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO oicunt_usage.usage_aggregates_hourly'),
      expect.any(Array),
    );
  });

  it('findEventById queries by tenant_id and event_id', async () => {
    const mockPool = {
      query: vi.fn().mockResolvedValue({
        rows: [
          {
            event_id: 'evt-pg-1',
            schema_version: '1.0.0',
            tenant_id: 'tenant-pg',
            product_id: 'billy',
            source_service: 'model-gateway',
            operation: 'model.completion',
            resource_id: 'oicunt.model.claude',
            measurements: { 'tokens.input': 1000 },
            dimensions: {},
            lineage: { correlationId: 'c1', requestId: 'r1' },
            idempotency_key: 'k-pg-1',
            occurred_at: new Date('2026-10-07T12:00:00.000Z'),
            ingested_at: new Date('2026-10-07T12:00:01.000Z'),
          },
        ],
      }),
    } as unknown as DatabasePool;

    const repo = new PostgresUsageRepository(mockPool);
    const event = await repo.findEventById('tenant-pg', 'evt-pg-1');

    expect(event).not.toBeNull();
    expect(event?.eventId).toBe('evt-pg-1');
    expect(mockPool.query).toHaveBeenCalledWith(
      expect.stringContaining('SELECT * FROM oicunt_usage.usage_events'),
      ['tenant-pg', 'evt-pg-1'],
    );
  });

  it('recomputeAggregates executes transaction deleting and recomputing hourly and daily records', async () => {
    const mockClient = {
      query: vi.fn().mockResolvedValue({ rowCount: 5, rows: [] }),
    };

    const mockPool = {
      withTransaction: vi
        .fn()
        .mockImplementation((cb: (client: unknown) => Promise<unknown>) => cb(mockClient)),
    } as unknown as DatabasePool;

    const repo = new PostgresUsageRepository(mockPool);
    const result = await repo.recomputeAggregates(
      'tenant-pg',
      '2026-10-07T00:00:00.000Z',
      '2026-10-07T23:59:59.999Z',
    );

    expect(result.recomputedHours).toBe(5);
    expect(result.recomputedDays).toBe(5);
    expect(mockClient.query).toHaveBeenCalledWith(
      expect.stringContaining('DELETE FROM oicunt_usage.usage_aggregates_hourly'),
      expect.any(Array),
    );
    expect(mockClient.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO oicunt_usage.usage_aggregates_hourly'),
      expect.any(Array),
    );
  });

  it('guarantees raw usage event immutability by never issuing UPDATE or DELETE on usage_events', async () => {
    const mockClient = {
      query: vi.fn().mockResolvedValue({ rowCount: 1, rows: [] }),
    };
    const mockPool = {
      withTransaction: vi
        .fn()
        .mockImplementation((cb: (client: unknown) => Promise<unknown>) => cb(mockClient)),
      query: vi.fn().mockResolvedValue({ rowCount: 1, rows: [] }),
    } as unknown as DatabasePool;

    const repo = new PostgresUsageRepository(mockPool);
    await repo.recomputeAggregates(
      'tenant-pg',
      '2026-10-07T00:00:00.000Z',
      '2026-10-07T23:59:59.999Z',
    );

    // Verify all executed SQL queries never target usage_events for deletion or update
    for (const call of mockClient.query.mock.calls) {
      const sql = (call[0] as string).toUpperCase();
      expect(sql).not.toContain('DELETE FROM OICUNT_USAGE.USAGE_EVENTS');
      expect(sql).not.toContain('UPDATE OICUNT_USAGE.USAGE_EVENTS');
    }
  });
});
