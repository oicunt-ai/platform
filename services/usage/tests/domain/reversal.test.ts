import { describe, expect, it } from 'vitest';
import { createReversalEvent } from '../../src/domain/reversal.js';
import { UsageTenantMismatchError, UsageValidationError } from '../../src/domain/errors.js';
import type { UsageEvent } from '../../src/domain/types.js';

describe('Domain Reversal Event Creation', () => {
  const originalEvent: UsageEvent = {
    eventId: 'orig-evt-123',
    schemaVersion: '1.0.0',
    tenantId: 'tenant-omega',
    productId: 'billy',
    sourceService: 'tools',
    operation: 'tool.execution',
    resourceId: 'oicunt.tool.python-interpreter',
    measurements: {
      'units.invocations': 1,
      'duration.compute_ms': 5000,
      'duration.total_ms': 5200,
    },
    dimensions: {
      tool_category: 'code_execution',
    },
    lineage: {
      correlationId: 'corr-orig',
      requestId: 'req-orig',
      sessionId: 'sess-orig',
    },
    idempotencyKey: 'tool_call_999',
    occurredAt: '2026-10-07T08:00:00.000Z',
  };

  it('creates an append-only reversal event negating 100% of original measurements by default', () => {
    const reversal = createReversalEvent(
      {
        tenantId: 'tenant-omega',
        originalEventId: 'orig-evt-123',
        reason: 'Execution timed out downstream',
      },
      originalEvent,
    );

    expect(reversal.operation).toBe('usage.reversal');
    expect(reversal.tenantId).toBe('tenant-omega');
    expect(reversal.measurements['units.invocations']).toBe(-1);
    expect(reversal.measurements['duration.compute_ms']).toBe(-5000);
    expect(reversal.measurements['duration.total_ms']).toBe(-5200);
    expect(reversal.dimensions['reversal_of_event_id']).toBe('orig-evt-123');
    expect(reversal.dimensions['reversal_reason']).toBe('Execution timed out downstream');
    expect(reversal.lineage.parentEventId).toBe('orig-evt-123');
    expect(reversal.idempotencyKey).toContain('rev_orig-evt-123_');
  });

  it('supports partial negative measurements reversal', () => {
    const reversal = createReversalEvent(
      {
        tenantId: 'tenant-omega',
        originalEventId: 'orig-evt-123',
        reason: 'Partial compute credit',
        negativeMeasurements: {
          'duration.compute_ms': -2500,
        },
      },
      originalEvent,
    );

    expect(reversal.measurements['duration.compute_ms']).toBe(-2500);
    expect(reversal.measurements['units.invocations']).toBeUndefined();
  });

  it('automatically forces positive delta inputs into negative deltas for reversal', () => {
    const reversal = createReversalEvent(
      {
        tenantId: 'tenant-omega',
        originalEventId: 'orig-evt-123',
        reason: 'Refund',
        negativeMeasurements: {
          'duration.compute_ms': 2500, // input is positive by mistake
        },
      },
      originalEvent,
    );

    expect(reversal.measurements['duration.compute_ms']).toBe(-2500);
  });

  it('enforces tenant boundary on reversal request', () => {
    expect(() =>
      createReversalEvent(
        {
          tenantId: 'tenant-attacker',
          originalEventId: 'orig-evt-123',
          reason: 'Unauthorized refund',
        },
        originalEvent,
      ),
    ).toThrow(UsageTenantMismatchError);
  });

  it('fails if reason is empty', () => {
    expect(() =>
      createReversalEvent(
        {
          tenantId: 'tenant-omega',
          originalEventId: 'orig-evt-123',
          reason: '',
        },
        originalEvent,
      ),
    ).toThrow(UsageValidationError);
  });

  it('rejects attempt to reverse a reversal event', () => {
    const reversal = createReversalEvent(
      {
        tenantId: 'tenant-omega',
        originalEventId: 'orig-evt-123',
        reason: 'Downstream timeout',
      },
      originalEvent,
    );

    expect(() =>
      createReversalEvent(
        {
          tenantId: 'tenant-omega',
          originalEventId: reversal.eventId,
          reason: 'Reverse the reversal',
        },
        reversal,
      ),
    ).toThrow(UsageValidationError);
  });

  it('produces identical idempotencyKey regardless of reason to prevent double-reversal', () => {
    const rev1 = createReversalEvent(
      {
        tenantId: 'tenant-omega',
        originalEventId: 'orig-evt-123',
        reason: 'Reason A',
      },
      originalEvent,
    );

    const rev2 = createReversalEvent(
      {
        tenantId: 'tenant-omega',
        originalEventId: 'orig-evt-123',
        reason: 'Reason B',
      },
      originalEvent,
    );

    expect(rev1.idempotencyKey).toBe(rev2.idempotencyKey);
    expect(rev1.idempotencyKey).toBe('rev_orig-evt-123_reversal');
  });
});
