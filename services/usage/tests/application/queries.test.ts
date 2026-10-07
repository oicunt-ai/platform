import { beforeEach, describe, expect, it } from 'vitest';
import { QueryUsageSummaryUseCase } from '../../src/application/use-cases/query-usage-summary.use-case.js';
import { QueryUsageTimeseriesUseCase } from '../../src/application/use-cases/query-usage-timeseries.use-case.js';
import { QueryUsageEventsUseCase } from '../../src/application/use-cases/query-usage-events.use-case.js';
import { InMemoryUsageRepository } from '../../src/infrastructure/repositories/in-memory-usage.repository.js';
import { UsageTenantMismatchError, UsageValidationError } from '../../src/domain/errors.js';
import type { UsageEvent } from '../../src/domain/types.js';

describe('Usage Query Use Cases', () => {
  let repo: InMemoryUsageRepository;
  let summaryUseCase: QueryUsageSummaryUseCase;
  let timeseriesUseCase: QueryUsageTimeseriesUseCase;
  let eventsUseCase: QueryUsageEventsUseCase;

  beforeEach(() => {
    repo = new InMemoryUsageRepository();
    summaryUseCase = new QueryUsageSummaryUseCase(repo);
    timeseriesUseCase = new QueryUsageTimeseriesUseCase(repo);
    eventsUseCase = new QueryUsageEventsUseCase(repo);
  });

  const sampleEvent: UsageEvent = {
    eventId: 'evt-q-1',
    schemaVersion: '1.0.0',
    tenantId: 'tenant-acme',
    productId: 'billy',
    sourceService: 'model-gateway',
    operation: 'model.completion',
    resourceId: 'oicunt.model.claude',
    measurements: {
      'tokens.input': 1000,
      'tokens.output': 250,
      'tokens.total': 1250,
    },
    dimensions: {},
    lineage: { correlationId: 'c1', requestId: 'r1' },
    idempotencyKey: 'k1',
    occurredAt: '2026-10-07T12:00:00.000Z',
  };

  it('queries summary for a tenant within a valid window', async () => {
    await repo.saveEvent(sampleEvent);

    const summary = await summaryUseCase.execute({
      tenantId: 'tenant-acme',
      startTime: '2026-10-07T00:00:00.000Z',
      endTime: '2026-10-07T23:59:59.999Z',
    });

    expect(summary.tenantId).toBe('tenant-acme');
    expect(summary.eventCount).toBe(1);
    expect(summary.totals['tokens.input']).toBe(1000);
  });

  it('rejects cross-tenant summary query when authenticated tenantId does not match', async () => {
    await expect(
      summaryUseCase.execute(
        {
          tenantId: 'tenant-acme',
          startTime: '2026-10-07T00:00:00.000Z',
          endTime: '2026-10-07T23:59:59.999Z',
        },
        'tenant-rival', // authenticated caller
      ),
    ).rejects.toThrow(UsageTenantMismatchError);
  });

  it('validates time windows (startTime <= endTime)', async () => {
    await expect(
      summaryUseCase.execute({
        tenantId: 'tenant-acme',
        startTime: '2026-10-08T00:00:00.000Z',
        endTime: '2026-10-07T00:00:00.000Z',
      }),
    ).rejects.toThrow(UsageValidationError);
  });

  it('queries timeseries buckets with valid granularity', async () => {
    await repo.saveEvent(sampleEvent);

    const timeseries = await timeseriesUseCase.execute({
      tenantId: 'tenant-acme',
      startTime: '2026-10-07T00:00:00.000Z',
      endTime: '2026-10-07T23:59:59.999Z',
      granularity: 'hourly',
    });

    expect(timeseries.granularity).toBe('hourly');
    expect(timeseries.series).toHaveLength(1);
    expect(timeseries.series[0]?.metrics['tokens.input']).toBe(1000);
  });

  it('queries raw usage events with pagination limits', async () => {
    await repo.saveEvent(sampleEvent);

    const eventsResult = await eventsUseCase.execute({
      tenantId: 'tenant-acme',
      limit: 10,
    });

    expect(eventsResult.events).toHaveLength(1);
    expect(eventsResult.totalCount).toBe(1);
  });

  it('guarantees resource-specific query correctness for summary and timeseries without returning other resources', async () => {
    await repo.saveEvent(sampleEvent); // oicunt.model.claude: 1000 input, 250 output

    const secondResourceEvent: UsageEvent = {
      eventId: 'evt-q-2',
      schemaVersion: '1.0.0',
      tenantId: 'tenant-acme',
      productId: 'billy',
      sourceService: 'model-gateway',
      operation: 'model.completion',
      resourceId: 'oicunt.model.gpt-4',
      measurements: {
        'tokens.input': 3000,
        'tokens.output': 800,
      },
      dimensions: {},
      lineage: { correlationId: 'c2', requestId: 'r2' },
      idempotencyKey: 'k2',
      occurredAt: '2026-10-07T12:30:00.000Z',
    };
    await repo.saveEvent(secondResourceEvent);

    // 1. Query summary filtered by resourceId 'oicunt.model.claude'
    const claudeSummary = await summaryUseCase.execute({
      tenantId: 'tenant-acme',
      startTime: '2026-10-07T00:00:00.000Z',
      endTime: '2026-10-07T23:59:59.999Z',
      resourceId: 'oicunt.model.claude',
    });
    expect(claudeSummary.eventCount).toBe(1);
    expect(claudeSummary.totals['tokens.input']).toBe(1000);
    expect(claudeSummary.totals['tokens.output']).toBe(250);

    // 2. Query summary filtered by resourceId 'oicunt.model.gpt-4'
    const gptSummary = await summaryUseCase.execute({
      tenantId: 'tenant-acme',
      startTime: '2026-10-07T00:00:00.000Z',
      endTime: '2026-10-07T23:59:59.999Z',
      resourceId: 'oicunt.model.gpt-4',
    });
    expect(gptSummary.eventCount).toBe(1);
    expect(gptSummary.totals['tokens.input']).toBe(3000);
    expect(gptSummary.totals['tokens.output']).toBe(800);

    // 3. Query total summary across all resources (no resourceId)
    const totalSummary = await summaryUseCase.execute({
      tenantId: 'tenant-acme',
      startTime: '2026-10-07T00:00:00.000Z',
      endTime: '2026-10-07T23:59:59.999Z',
    });
    expect(totalSummary.eventCount).toBe(2);
    expect(totalSummary.totals['tokens.input']).toBe(4000);
    expect(totalSummary.totals['tokens.output']).toBe(1050);

    // 4. Query timeseries filtered by resourceId 'oicunt.model.claude'
    const claudeTimeseries = await timeseriesUseCase.execute({
      tenantId: 'tenant-acme',
      startTime: '2026-10-07T00:00:00.000Z',
      endTime: '2026-10-07T23:59:59.999Z',
      granularity: 'hourly',
      resourceId: 'oicunt.model.claude',
    });
    expect(claudeTimeseries.series).toHaveLength(1);
    expect(claudeTimeseries.series[0]?.metrics['tokens.input']).toBe(1000);

    // 5. Query timeseries across all resources
    const totalTimeseries = await timeseriesUseCase.execute({
      tenantId: 'tenant-acme',
      startTime: '2026-10-07T00:00:00.000Z',
      endTime: '2026-10-07T23:59:59.999Z',
      granularity: 'hourly',
    });
    expect(totalTimeseries.series).toHaveLength(1);
    expect(totalTimeseries.series[0]?.metrics['tokens.input']).toBe(4000);
  });
});
