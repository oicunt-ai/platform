import { describe, expect, it } from 'vitest';
import type { UsageEvent, UsageMeasurements } from './index.js';

describe('Usage Contracts', () => {
  it('allows domain-neutral AI measurements with dot-notation keys', () => {
    const aiMeasurements: UsageMeasurements = {
      'tokens.input': 1000,
      'tokens.output': 250,
      'tokens.total': 1250,
      'tokens.cached_input': 200,
      'tokens.reasoning': 64,
      'tool.calls': 2,
      'agent.steps': 5,
      'vectors.dimensions': 1536,
    };

    const aiEvent: UsageEvent = {
      eventId: 'evt-ai-1',
      schemaVersion: '1.0.0',
      tenantId: 'tenant-123',
      productId: 'billy',
      sourceService: 'ai-orchestrator',
      operation: 'chat.completion',
      resourceId: 'conv-123',
      measurements: aiMeasurements,
      dimensions: { model: 'oicunt.model.catalog-alpha', provider: 'test-provider' },
      lineage: { correlationId: 'c-1', requestId: 'r-1' },
      idempotencyKey: 'idemp-ai-1',
      occurredAt: '2026-10-07T12:00:00.000Z',
    };

    expect(aiEvent.measurements['tokens.input']).toBe(1000);
    expect(aiEvent.measurements['tokens.output']).toBe(250);
    expect(aiEvent.measurements['tokens.total']).toBe(1250);
    expect(aiEvent.measurements['tool.calls']).toBe(2);
    expect(aiEvent.measurements['agent.steps']).toBe(5);
  });

  it('allows domain-neutral platform measurements', () => {
    const platformMeasurements: UsageMeasurements = {
      'duration.ms': 450,
      'cpu.ms': 120,
      'memory.bytes': 104857600,
      'storage.bytes': 524288000,
      'bytes.ingested': 4096,
      'bytes.egressed': 8192,
      'requests.count': 1,
      'invocations.count': 1,
    };

    const platformEvent: UsageEvent = {
      eventId: 'evt-plat-1',
      schemaVersion: '1.0.0',
      tenantId: 'tenant-123',
      productId: 'storage-service',
      sourceService: 'blob-storage',
      operation: 'file.upload',
      resourceId: 'file-blob-99',
      measurements: platformMeasurements,
      dimensions: { region: 'us-east-1' },
      lineage: { correlationId: 'c-2', requestId: 'r-2' },
      idempotencyKey: 'idemp-plat-1',
      occurredAt: '2026-10-07T12:00:00.000Z',
    };

    expect(platformEvent.measurements['duration.ms']).toBe(450);
    expect(platformEvent.measurements['cpu.ms']).toBe(120);
    expect(platformEvent.measurements['storage.bytes']).toBe(524288000);
    expect(platformEvent.measurements['requests.count']).toBe(1);
  });
});
