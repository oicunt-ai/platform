import { beforeEach, describe, expect, it } from 'vitest';
import { IngestUsageUseCase } from '../../src/application/use-cases/ingest-usage.use-case.js';
import { BatchIngestUsageUseCase } from '../../src/application/use-cases/batch-ingest-usage.use-case.js';
import { InMemoryUsageRepository } from '../../src/infrastructure/repositories/in-memory-usage.repository.js';
import { UsageTenantMismatchError, UsageValidationError } from '../../src/domain/errors.js';

describe('IngestUsageUseCase & BatchIngestUsageUseCase', () => {
  let repo: InMemoryUsageRepository;
  let ingestUseCase: IngestUsageUseCase;
  let batchIngestUseCase: BatchIngestUsageUseCase;

  beforeEach(() => {
    repo = new InMemoryUsageRepository();
    ingestUseCase = new IngestUsageUseCase(repo);
    batchIngestUseCase = new BatchIngestUsageUseCase(repo);
  });

  const validEvent = {
    eventId: 'evt-test-101',
    schemaVersion: '1.0.0',
    tenantId: 'tenant-finance-corp',
    productId: 'billy',
    sourceService: 'model-gateway',
    operation: 'model.completion',
    resourceId: 'oicunt.model.anthropic.claude-3-5-sonnet',
    measurements: {
      'tokens.input': 2500,
      'tokens.output': 800,
      'tokens.total': 3300,
    },
    dimensions: { provider: 'anthropic' },
    lineage: { correlationId: 'c-101', requestId: 'r-101' },
    idempotencyKey: 'mod_r-101_1',
    occurredAt: '2026-10-07T13:00:00.000Z',
  };

  it('persists a new valid usage event successfully', async () => {
    const res = await ingestUseCase.execute(validEvent);
    expect(res.status).toBe('persisted');
    expect(res.eventId).toBe('evt-test-101');
  });

  it('returns duplicate status when ingesting an event with existing tenantId and idempotencyKey', async () => {
    const res1 = await ingestUseCase.execute(validEvent);
    expect(res1.status).toBe('persisted');

    // Re-ingest with different eventId but same idempotencyKey
    const res2 = await ingestUseCase.execute({
      ...validEvent,
      eventId: 'evt-test-102',
    });
    expect(res2.status).toBe('duplicate');
    expect(res2.eventId).toBe('evt-test-101'); // Original event ID returned
  });

  it('enforces tenant boundary when caller context provides an authenticatedTenantId', async () => {
    await expect(
      ingestUseCase.execute(validEvent, {
        authenticatedTenantId: 'tenant-other-corp',
      }),
    ).rejects.toThrow(UsageTenantMismatchError);
  });

  it('rejects events missing tenantId or with synthetic user identities', async () => {
    const { tenantId: _, ...noTenant } = validEvent;
    await expect(ingestUseCase.execute(noTenant)).rejects.toThrow(UsageValidationError);

    await expect(ingestUseCase.execute({ ...validEvent, userId: 'system' })).rejects.toThrow(
      UsageValidationError,
    );
  });

  it('processes batch ingestion idempotently', async () => {
    const batch = [
      { ...validEvent, eventId: 'e-1', idempotencyKey: 'k-1' },
      { ...validEvent, eventId: 'e-2', idempotencyKey: 'k-2' },
      { ...validEvent, eventId: 'e-3', idempotencyKey: 'k-1' }, // duplicate of e-1
    ];

    const result = await batchIngestUseCase.execute(batch);
    expect(result.accepted).toBe(2);
    expect(result.duplicates).toBe(1);
    expect(result.results[0]?.status).toBe('persisted');
    expect(result.results[1]?.status).toBe('persisted');
    expect(result.results[2]?.status).toBe('duplicate');
  });

  it('rejects batch exceeding max batch limit of 100', async () => {
    const largeBatch = Array.from({ length: 101 }, (_, i) => ({
      ...validEvent,
      eventId: `e-${i}`,
      idempotencyKey: `k-${i}`,
    }));

    await expect(batchIngestUseCase.execute(largeBatch)).rejects.toThrow(/exceeds maximum limit/);
  });
});
