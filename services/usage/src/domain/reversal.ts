import { randomUUID } from 'node:crypto';
import type { CreateReversalParams, UsageEvent, UsageMeasurements } from '@oicunt/contracts';
import { UsageTenantMismatchError, UsageValidationError } from './errors.js';

export function createReversalEvent(
  params: CreateReversalParams,
  originalEvent: UsageEvent,
): UsageEvent {
  if (params.tenantId !== originalEvent.tenantId) {
    throw new UsageTenantMismatchError(originalEvent.tenantId, params.tenantId);
  }

  if (
    originalEvent.operation === 'usage.reversal' ||
    originalEvent.operation === 'usage.adjustment'
  ) {
    throw new UsageValidationError('Cannot reverse a usage event that is already a reversal');
  }

  if (!params.reason || params.reason.trim().length === 0) {
    throw new UsageValidationError("Reversal 'reason' must be a non-empty string");
  }

  const measurementsToReverse: Record<string, number> = {};

  if (params.negativeMeasurements && Object.keys(params.negativeMeasurements).length > 0) {
    for (const [key, val] of Object.entries(params.negativeMeasurements)) {
      if (typeof val === 'number' && Number.isFinite(val)) {
        // Enforce that reversal delta is negative
        measurementsToReverse[key] = val < 0 ? val : -val;
      }
    }
  } else {
    // Reverse 100% of original measurements with negative deltas
    for (const [key, val] of Object.entries(originalEvent.measurements)) {
      if (typeof val === 'number' && Number.isFinite(val)) {
        measurementsToReverse[key] = -Math.abs(val);
      }
    }
  }

  if (Object.keys(measurementsToReverse).length === 0) {
    throw new UsageValidationError(
      'Reversal must contain at least one measurement delta to reverse',
    );
  }

  // Idempotency key is deterministic per original event ID to prevent multiple reversals
  const idempotencyKey = `rev_${originalEvent.eventId}_reversal`;
  const reversalEventId = randomUUID();

  return {
    eventId: reversalEventId,
    schemaVersion: originalEvent.schemaVersion,
    tenantId: originalEvent.tenantId,
    userId: originalEvent.userId,
    actorId: originalEvent.actorId,
    productId: originalEvent.productId,
    sourceService: originalEvent.sourceService,
    operation: 'usage.reversal',
    resourceId: originalEvent.resourceId,
    measurements: measurementsToReverse as UsageMeasurements,
    dimensions: {
      ...originalEvent.dimensions,
      ...(params.dimensions ?? {}),
      reversal_of_event_id: originalEvent.eventId,
      reversal_reason: params.reason.trim(),
    },
    lineage: {
      correlationId: params.correlationId ?? originalEvent.lineage.correlationId,
      requestId: params.requestId ?? originalEvent.lineage.requestId,
      sessionId: originalEvent.lineage.sessionId,
      runId: originalEvent.lineage.runId,
      stepId: originalEvent.lineage.stepId,
      parentEventId: originalEvent.eventId,
    },
    idempotencyKey,
    // Corrections belong to the same accounting period as the event they
    // offset; ingestion time still records when the correction was received.
    occurredAt: originalEvent.occurredAt,
  };
}
