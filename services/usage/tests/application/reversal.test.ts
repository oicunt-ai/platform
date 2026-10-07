import { beforeEach, describe, expect, it } from 'vitest';
import { CreateReversalUseCase } from '../../src/application/use-cases/create-reversal.use-case.js';
import { RecomputeAggregatesUseCase } from '../../src/application/use-cases/recompute-aggregates.use-case.js';
import { InMemoryUsageRepository } from '../../src/infrastructure/repositories/in-memory-usage.repository.js';
import {
  UsageNotFoundError,
  UsageTenantMismatchError,
  UsageValidationError,
} from '../../src/domain/errors.js';
import type { UsageEvent } from '../../src/domain/types.js';

describe('CreateReversalUseCase & RecomputeAggregatesUseCase', () => {
  let repo: InMemoryUsageRepository;
  let reversalUseCase: CreateReversalUseCase;
  let recomputeUseCase: RecomputeAggregatesUseCase;

  beforeEach(() => {
    repo = new InMemoryUsageRepository();
    reversalUseCase = new CreateReversalUseCase(repo);
    recomputeUseCase = new RecomputeAggregatesUseCase(repo);
  });

  const originalEvent: UsageEvent = {
    eventId: 'evt-to-reverse',
    schemaVersion: '1.0.0',
    tenantId: 'tenant-test',
    productId: 'billy',
    sourceService: 'model-gateway',
    operation: 'model.completion',
    resourceId: 'oicunt.model.claude',
    measurements: {
      'tokens.input': 2000,
      'tokens.output': 500,
    },
    dimensions: {},
    lineage: { correlationId: 'c1', requestId: 'r1' },
    idempotencyKey: 'k-orig',
    occurredAt: '2026-10-07T12:00:00.000Z',
  };

  it('creates an append-only reversal event that offsets consumption', async () => {
    await repo.saveEvent(originalEvent);

    const result = await reversalUseCase.execute({
      tenantId: 'tenant-test',
      originalEventId: 'evt-to-reverse',
      reason: 'Stream aborted mid-flight',
    });

    expect(result.status).toBe('persisted');
    expect(result.reversalEvent.operation).toBe('usage.reversal');
    expect(result.reversalEvent.measurements['tokens.input']).toBe(-2000);
    expect(result.reversalEvent.measurements['tokens.output']).toBe(-500);

    // Summary should now be zero net tokens!
    const summary = await repo.querySummary({
      tenantId: 'tenant-test',
      startTime: '2026-10-07T00:00:00.000Z',
      endTime: '2026-10-07T23:59:59.999Z',
    });

    expect(summary.totals['tokens.input']).toBe(0);
    expect(summary.totals['tokens.output']).toBe(0);
    expect(summary.eventCount).toBe(2); // 1 original + 1 reversal
  });

  it('fails if original event is not found', async () => {
    await expect(
      reversalUseCase.execute({
        tenantId: 'tenant-test',
        originalEventId: 'non-existent-id',
        reason: 'Refund',
      }),
    ).rejects.toThrow(UsageNotFoundError);
  });

  it('rejects cross-tenant reversal attempt', async () => {
    await repo.saveEvent(originalEvent);

    await expect(
      reversalUseCase.execute(
        {
          tenantId: 'tenant-test',
          originalEventId: 'evt-to-reverse',
          reason: 'Refund',
        },
        'tenant-impostor',
      ),
    ).rejects.toThrow(UsageTenantMismatchError);
  });

  it('recomputes aggregates cleanly over time window', async () => {
    await repo.saveEvent(originalEvent);

    const res = await recomputeUseCase.execute({
      tenantId: 'tenant-test',
      startTime: '2026-10-07T00:00:00.000Z',
      endTime: '2026-10-07T23:59:59.999Z',
    });

    expect(res.recomputedHours).toBe(1);
    expect(res.recomputedDays).toBe(1);
  });

  it('guarantees reversal safety by deduplicating second reversal of same original event and avoiding double deduction', async () => {
    await repo.saveEvent(originalEvent);

    // First reversal
    const firstResult = await reversalUseCase.execute({
      tenantId: 'tenant-test',
      originalEventId: 'evt-to-reverse',
      reason: 'First reversal reason',
    });
    expect(firstResult.status).toBe('persisted');

    // Second reversal attempt with different reason
    const secondResult = await reversalUseCase.execute({
      tenantId: 'tenant-test',
      originalEventId: 'evt-to-reverse',
      reason: 'Second reversal reason attempting double refund',
    });
    expect(secondResult.status).toBe('duplicate');

    // Verify summary is zero net, NOT negative (no double-counting)
    const summary = await repo.querySummary({
      tenantId: 'tenant-test',
      startTime: '2026-10-07T00:00:00.000Z',
      endTime: '2026-10-07T23:59:59.999Z',
    });
    expect(summary.totals['tokens.input']).toBe(0);
    expect(summary.totals['tokens.output']).toBe(0);
    expect(summary.eventCount).toBe(2); // 1 original + 1 reversal only
  });

  it('prohibits reversing an event that is already a reversal', async () => {
    await repo.saveEvent(originalEvent);

    const firstResult = await reversalUseCase.execute({
      tenantId: 'tenant-test',
      originalEventId: 'evt-to-reverse',
      reason: 'Initial compensation',
    });
    expect(firstResult.status).toBe('persisted');

    // Attempt to reverse the reversal event itself
    await expect(
      reversalUseCase.execute({
        tenantId: 'tenant-test',
        originalEventId: firstResult.reversalEvent.eventId,
        reason: 'Attempt to reverse a reversal',
      }),
    ).rejects.toThrow(UsageValidationError);
  });
});
