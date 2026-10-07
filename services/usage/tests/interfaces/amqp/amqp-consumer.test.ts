import { beforeEach, describe, expect, it } from 'vitest';
import { IngestUsageUseCase } from '../../../src/application/use-cases/ingest-usage.use-case.js';
import { InMemoryUsageRepository } from '../../../src/infrastructure/repositories/in-memory-usage.repository.js';
import { InMemoryUsageQueue } from '../../../src/infrastructure/queue/in-memory-usage-queue.js';
import { createUsageConsumerHandler } from '../../../src/interfaces/amqp/usage-consumer-handler.js';

describe('AMQP Consumer Handler Integration', () => {
  let repo: InMemoryUsageRepository;
  let ingestUseCase: IngestUsageUseCase;
  let queue: InMemoryUsageQueue;

  beforeEach(() => {
    repo = new InMemoryUsageRepository();
    ingestUseCase = new IngestUsageUseCase(repo);
    queue = new InMemoryUsageQueue();

    const handler = createUsageConsumerHandler(ingestUseCase);
    queue.registerHandler(handler);
    void queue.start();
  });

  const validMessage = {
    eventId: 'amqp-evt-1',
    schemaVersion: '1.0.0',
    tenantId: 'tenant-amqp',
    productId: 'billy',
    sourceService: 'model-gateway',
    operation: 'model.completion',
    resourceId: 'oicunt.model.claude',
    measurements: { 'tokens.input': 1000 },
    dimensions: {},
    lineage: { correlationId: 'c1', requestId: 'r1' },
    idempotencyKey: 'amqp_key_1',
    occurredAt: '2026-10-07T12:00:00.000Z',
  };

  it('acknowledges successfully ingested valid event', async () => {
    await queue.publishRaw(JSON.stringify(validMessage));

    expect(queue.acknowledged).toHaveLength(1);
    expect(queue.deadLettered).toHaveLength(0);

    const summary = await repo.querySummary({
      tenantId: 'tenant-amqp',
      startTime: '2026-10-07T00:00:00.000Z',
      endTime: '2026-10-07T23:59:59.999Z',
    });
    expect(summary.totals['tokens.input']).toBe(1000);
  });

  it('safely acknowledges duplicate events without double-counting', async () => {
    await queue.publishRaw(JSON.stringify(validMessage));
    // Send duplicate
    await queue.publishRaw(JSON.stringify({ ...validMessage, eventId: 'amqp-evt-2' }));

    expect(queue.acknowledged).toHaveLength(2);
    expect(queue.deadLettered).toHaveLength(0);

    const summary = await repo.querySummary({
      tenantId: 'tenant-amqp',
      startTime: '2026-10-07T00:00:00.000Z',
      endTime: '2026-10-07T23:59:59.999Z',
    });
    // Sum is still 1000!
    expect(summary.totals['tokens.input']).toBe(1000);
    expect(summary.eventCount).toBe(1);
  });

  it('routes malformed JSON to dead-letter queue', async () => {
    await queue.publishRaw('{ unparseable json');

    expect(queue.acknowledged).toHaveLength(0);
    expect(queue.deadLettered).toHaveLength(1);
    expect(queue.deadLettered[0]).toEqual({
      raw: '{ unparseable json',
      reason: 'malformed_json',
    });
  });

  it('routes schema validation failures to dead-letter queue', async () => {
    const invalidMessage = {
      ...validMessage,
      tenantId: '', // invalid
    };

    await queue.publishRaw(JSON.stringify(invalidMessage));

    expect(queue.acknowledged).toHaveLength(0);
    expect(queue.deadLettered).toHaveLength(1);
  });
});
