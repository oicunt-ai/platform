/**
 * Cross-repository UsageEvent contract test (consumer side).
 *
 * Validates every usage-event.v1 fixture case against the REAL
 * validateUsageEvent() plus real idempotent ingestion. The twin copy
 * lives at ai-platform/services/model-gateway/tests/contract/fixtures/
 * usage-event.v1.json and MUST be byte-identical (same version string);
 * refresh both files in the same change whenever the producer contract
 * test re-derives them. SHA-256 equality across the two copies is the
 * drift detector a human runs at release time; each repo's CI guards its
 * own side on every run.
 *
 * Placeholder identity fields (<event-id>, <idempotency-key>,
 * <occurred-at>) are materialized per case with deterministic concrete
 * values. The derivation RULES they stand for (eventId `usage_<uuid>`,
 * idempotencyKey `model.completion:<completionId>`) are asserted on the
 * producer side; here the values prove acceptance, preservation, and
 * duplicate collapse.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { validateUsageEvent } from '../../src/domain/validation.js';
import { UsageValidationError } from '../../src/domain/errors.js';
import type { UsageEvent } from '../../src/domain/types.js';
import { IngestUsageUseCase } from '../../src/application/use-cases/ingest-usage.use-case.js';
import { InMemoryUsageRepository } from '../../src/infrastructure/repositories/in-memory-usage.repository.js';

interface FixtureDocument {
  readonly version: string;
  readonly cases: ReadonlyArray<{
    readonly name: string;
    readonly expect: 'accept' | 'reject';
    readonly event: Record<string, unknown>;
  }>;
}

function loadFixtures(): FixtureDocument {
  const path = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'usage-event.v1.json');
  return JSON.parse(readFileSync(path, 'utf8')) as FixtureDocument;
}

/** Fill identity placeholders with deterministic per-case values. */
function materialize(name: string, raw: Record<string, unknown>): UsageEvent {
  const text = JSON.stringify(raw)
    .split('<event-id>')
    .join(`usage_contract-${name}`)
    .split('<idempotency-key>')
    .join(`model.completion:contract-${name}`)
    .split('<occurred-at>')
    .join('2026-06-01T12:00:00.000Z');
  return JSON.parse(text) as unknown as UsageEvent;
}

describe('UsageEvent contract fixtures (consumer side)', () => {
  it('is versioned as usage-event-v1, matching the producer copy', () => {
    expect(loadFixtures().version).toBe('usage-event-v1');
  });

  it.each([
    'success-provider-usage',
    'success-unknown-usage',
    'success-zero-confirmed',
    'failure-provider-usage',
    'failure-unknown-usage',
    'identities-omitted',
    'retry-stability',
    'actor-omitted',
    'billing-parity',
  ])('accepts the %s event with preserved values', (name) => {
    const found = loadFixtures().cases.find((c) => c.name === name);
    expect(found?.expect).toBe('accept');
    const validated = validateUsageEvent(materialize(name, found!.event));
    const expectedTenant = name === 'billing-parity' ? 'tnt_dev_local' : 'tnt_contract';
    expect(validated.tenantId).toBe(expectedTenant);
    expect(validated.resourceId).toBe('oicunt.model.catalog-alpha');
    expect(validated.operation).toBe('model.completion');
    expect(validated.sourceService).toBe('model-gateway');
    expect(validated.lineage.correlationId).toBe('corr-contract');
    expect(validated.lineage.requestId).toBe('req-contract');
  });

  it('accepts provider-confirmed zero tokens as measurements, not unknown', () => {
    const found = loadFixtures().cases.find((c) => c.name === 'success-zero-confirmed')!;
    const validated = validateUsageEvent(materialize(found.name, found.event));
    expect(validated.measurements['tokens.total']).toBe(0);
    expect(validated.measurements['units.requests']).toBe(1);
    expect(validated.dimensions['usageSource']).toBe('provider');
  });

  it('accepts unknown usage with units.requests and no token keys', () => {
    const found = loadFixtures().cases.find((c) => c.name === 'failure-unknown-usage')!;
    const validated = validateUsageEvent(materialize(found.name, found.event));
    expect(validated.measurements).toEqual({ 'units.requests': 1 });
    expect(validated.dimensions['usageSource']).toBe('unknown');
  });

  it('accepts omitted identities without fabrication', () => {
    const omitted = loadFixtures().cases.find((c) => c.name === 'identities-omitted')!;
    const validatedOmitted = validateUsageEvent(materialize(omitted.name, omitted.event));
    expect(validatedOmitted.userId).toBeUndefined();
    expect(validatedOmitted.lineage.sessionId).toBeUndefined();
    const actorOmitted = loadFixtures().cases.find((c) => c.name === 'actor-omitted')!;
    const validatedActor = validateUsageEvent(materialize(actorOmitted.name, actorOmitted.event));
    expect(validatedActor.actorId).toBeUndefined();
    expect(validatedActor.userId).toBe('usr_contract');
  });

  it('accepts the live BILLY-chain identity shape', () => {
    const found = loadFixtures().cases.find((c) => c.name === 'billing-parity')!;
    const validated = validateUsageEvent(materialize(found.name, found.event));
    expect(validated.tenantId).toBe('tnt_dev_local');
    expect(validated.userId).toBe('usr_dev_local');
    expect(validated.actorId).toBe('api-gateway');
    expect(validated.lineage.sessionId).toBe('conv_dev_local');
    expect(validated.measurements['tokens.total']).toBe(20);
  });

  it('rejects the synthetic actorId event', () => {
    const found = loadFixtures().cases.find((c) => c.name === 'synthetic-actor')!;
    expect(found.expect).toBe('reject');
    expect(() => validateUsageEvent(materialize(found.name, found.event))).toThrow(
      UsageValidationError,
    );
    expect(() => validateUsageEvent(materialize(found.name, found.event))).toThrow(/synthetic/i);
  });

  it('rejects missing and invalid required identity', () => {
    const base = materialize(
      'success-provider-usage',
      loadFixtures().cases.find((c) => c.name === 'success-provider-usage')!.event,
    );
    expect(() => validateUsageEvent({ ...base, tenantId: '' })).toThrow(UsageValidationError);
    const { eventId: _dropped, ...withoutId } = base;
    expect(() => validateUsageEvent(withoutId)).toThrow(UsageValidationError);
    expect(() =>
      validateUsageEvent({ ...base, lineage: { correlationId: '', requestId: 'req-contract' } }),
    ).toThrow(UsageValidationError);
  });

  it('ingests every accepted event idempotently with correct aggregates', async () => {
    const repo = new InMemoryUsageRepository();
    const ingest = new IngestUsageUseCase(repo);
    const acceptCases = loadFixtures().cases.filter((c) => c.expect === 'accept');

    let persisted = 0;
    for (const c of acceptCases) {
      const result = await ingest.execute(materialize(c.name, c.event));
      expect(result.status).toBe('persisted');
      persisted += 1;
    }
    expect(persisted).toBe(acceptCases.length);

    // Replay every event: all recognized as duplicates, nothing double-counted.
    for (const c of acceptCases) {
      const result = await ingest.execute(materialize(c.name, c.event));
      expect(result.status).toBe('duplicate');
    }

    const summary = await repo.querySummary({
      tenantId: 'tnt_contract',
      startTime: '2026-06-01T00:00:00.000Z',
      endTime: '2026-06-01T23:59:59.999Z',
    });
    expect(summary.eventCount).toBe(acceptCases.length - 1);
    // Token totals for tnt_contract: 30 + 9 + 0 + 10 + 2 + 4 + 5 = 60
    // across the seven token-bearing cases; the unknown-usage case
    // contributes no tokens.
    expect(summary.totals['tokens.total']).toBe(60);
    expect(summary.totals['units.requests']).toBe(acceptCases.length - 1);
    // The live-parity tenant is accounted separately with its own identity.
    const parity = await repo.querySummary({
      tenantId: 'tnt_dev_local',
      startTime: '2026-06-01T00:00:00.000Z',
      endTime: '2026-06-01T23:59:59.999Z',
    });
    expect(parity.eventCount).toBe(1);
    expect(parity.totals['tokens.total']).toBe(20);
  });
});
