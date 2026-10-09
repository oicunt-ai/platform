import { describe, expect, it } from 'vitest';
import { validateUsageEvent } from '../../src/domain/validation.js';
import { UsageValidationError } from '../../src/domain/errors.js';

describe('UsageEvent Domain Validation', () => {
  const validBaseEvent = {
    eventId: '019182a3-b4c5-7def-8901-23456789abcd',
    schemaVersion: '1.0.0',
    tenantId: 'tenant-acme-corp',
    productId: 'billy',
    sourceService: 'model-gateway',
    operation: 'model.completion',
    resourceId: 'oicunt.model.catalog-alpha',
    measurements: {
      'tokens.input': 1500,
      'tokens.output': 350,
      'tokens.total': 1850,
      'tokens.cached_input': 200,
      'tokens.reasoning': 80,
      'duration.total_ms': 1200,
    },
    dimensions: {
      provider: 'test-provider',
      model_tier: 'tier_flagship',
      stream: true,
    },
    lineage: {
      correlationId: 'corr-12345',
      requestId: 'req-67890',
      sessionId: 'sess-abcde',
    },
    idempotencyKey: 'mod_req-67890_1',
    occurredAt: '2026-10-07T12:00:00.000Z',
  };

  it('validates a complete, compliant usage event without userId and actorId', () => {
    const result = validateUsageEvent(validBaseEvent);
    expect(result.eventId).toBe(validBaseEvent.eventId);
    expect(result.tenantId).toBe('tenant-acme-corp');
    expect(result.userId).toBeUndefined();
    expect(result.actorId).toBeUndefined();
    expect(result.measurements['tokens.input']).toBe(1500);
    expect(result.dimensions['provider']).toBe('test-provider');
  });

  it('accepts optional genuine userId and actorId', () => {
    const eventWithUsers = {
      ...validBaseEvent,
      userId: 'usr_sarah_connor',
      actorId: 'act_engineer_42',
    };
    const result = validateUsageEvent(eventWithUsers);
    expect(result.userId).toBe('usr_sarah_connor');
    expect(result.actorId).toBe('act_engineer_42');
  });

  it('rejects fabricated synthetic identities like "system" or "anonymous"', () => {
    expect(() => validateUsageEvent({ ...validBaseEvent, userId: 'system' })).toThrowError(
      /Fabricated synthetic userId 'system' is forbidden/,
    );

    expect(() => validateUsageEvent({ ...validBaseEvent, actorId: 'anonymous' })).toThrowError(
      /Fabricated synthetic actorId 'anonymous' is forbidden/,
    );

    expect(() => validateUsageEvent({ ...validBaseEvent, userId: 'placeholder' })).toThrowError(
      /Fabricated synthetic userId/,
    );
  });

  it('fails if mandatory tenantId is missing or empty', () => {
    expect(() => validateUsageEvent({ ...validBaseEvent, tenantId: '' })).toThrow(
      UsageValidationError,
    );

    const { tenantId: _, ...withoutTenant } = validBaseEvent;
    expect(() => validateUsageEvent(withoutTenant)).toThrow(UsageValidationError);
  });

  it('fails if eventId or productId or sourceService or operation is missing', () => {
    expect(() => validateUsageEvent({ ...validBaseEvent, eventId: '' })).toThrow(
      UsageValidationError,
    );
    expect(() => validateUsageEvent({ ...validBaseEvent, productId: '' })).toThrow(
      UsageValidationError,
    );
    expect(() => validateUsageEvent({ ...validBaseEvent, sourceService: '' })).toThrow(
      UsageValidationError,
    );
    expect(() => validateUsageEvent({ ...validBaseEvent, operation: '' })).toThrow(
      UsageValidationError,
    );
    expect(() => validateUsageEvent({ ...validBaseEvent, resourceId: '' })).toThrow(
      UsageValidationError,
    );
  });

  it('fails if measurements is empty or non-object', () => {
    expect(() => validateUsageEvent({ ...validBaseEvent, measurements: {} })).toThrow(
      UsageValidationError,
    );
    expect(() => validateUsageEvent({ ...validBaseEvent, measurements: 'invalid' })).toThrow(
      UsageValidationError,
    );
  });

  it('fails if measurements contains non-finite numbers', () => {
    expect(() =>
      validateUsageEvent({
        ...validBaseEvent,
        measurements: { 'tokens.input': NaN },
      }),
    ).toThrow(UsageValidationError);

    expect(() =>
      validateUsageEvent({
        ...validBaseEvent,
        measurements: { 'tokens.input': Infinity },
      }),
    ).toThrow(UsageValidationError);

    expect(() =>
      validateUsageEvent({
        ...validBaseEvent,
        measurements: { 'tokens.input': '1500' as unknown as number },
      }),
    ).toThrow(UsageValidationError);
  });

  it('fails if standard operations contain negative numbers (which are reserved for reversals)', () => {
    expect(() =>
      validateUsageEvent({
        ...validBaseEvent,
        operation: 'model.completion',
        measurements: { 'tokens.input': -50 },
      }),
    ).toThrow(/cannot be negative for standard operation/);
  });

  it('allows negative measurements for usage.reversal operations', () => {
    const reversalEvent = {
      ...validBaseEvent,
      operation: 'usage.reversal',
      measurements: { 'tokens.input': -1500, 'tokens.output': -350 },
    };
    const result = validateUsageEvent(reversalEvent);
    expect(result.measurements['tokens.input']).toBe(-1500);
  });

  it('fails if occurredAt has an invalid date format', () => {
    expect(() => validateUsageEvent({ ...validBaseEvent, occurredAt: 'not-a-valid-date' })).toThrow(
      UsageValidationError,
    );
  });

  it('fails if lineage is missing correlationId or requestId', () => {
    expect(() =>
      validateUsageEvent({
        ...validBaseEvent,
        lineage: { correlationId: '', requestId: 'req-1' },
      }),
    ).toThrow(UsageValidationError);

    expect(() =>
      validateUsageEvent({
        ...validBaseEvent,
        lineage: { correlationId: 'corr-1', requestId: '' },
      }),
    ).toThrow(UsageValidationError);
  });

  it('validates dimensions scalar values and rejects complex objects', () => {
    expect(() =>
      validateUsageEvent({
        ...validBaseEvent,
        dimensions: { nested: { array: [1, 2, 3] } as unknown as string },
      }),
    ).toThrow(UsageValidationError);
  });
});
