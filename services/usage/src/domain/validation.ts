import type { UsageEvent, UsageMeasurements, UsageEventLineage } from '@oicunt/contracts';
import { UsageValidationError } from './errors.js';

const DISALLOWED_SYNTHETIC_IDENTITIES = new Set([
  'system',
  'anonymous',
  'placeholder',
  'none',
  'unknown',
  'null',
  'undefined',
  'synthetic',
  'fake',
]);

export function isSyntheticIdentity(id: string): boolean {
  const normalized = id.trim().toLowerCase();
  return DISALLOWED_SYNTHETIC_IDENTITIES.has(normalized);
}

export function validateIsoDateString(value: unknown, fieldName: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new UsageValidationError(`Field '${fieldName}' must be a non-empty ISO 8601 string`);
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new UsageValidationError(`Field '${fieldName}' has invalid timestamp format: '${value}'`);
  }
  return date.toISOString();
}

export function validateMeasurements(raw: unknown, operation: string): UsageMeasurements {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new UsageValidationError("Field 'measurements' must be a non-null object");
  }

  const record = raw as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length === 0) {
    throw new UsageValidationError(
      "Field 'measurements' must contain at least one measurement key",
    );
  }

  const isReversalOrAdjustment =
    operation === 'usage.reversal' ||
    operation === 'usage.adjustment' ||
    operation.endsWith('.reversal');

  const validated: Record<string, number> = {};

  for (const [key, value] of Object.entries(record)) {
    if (value === undefined || value === null) {
      continue;
    }
    if (typeof value !== 'number' || !Number.isFinite(value) || Number.isNaN(value)) {
      throw new UsageValidationError(
        `Measurement '${key}' must be a finite number, received '${String(value)}'`,
      );
    }
    if (!isReversalOrAdjustment && value < 0) {
      throw new UsageValidationError(
        `Measurement '${key}' cannot be negative for standard operation '${operation}'`,
      );
    }
    validated[key] = value;
  }

  return validated as UsageMeasurements;
}

export function validateDimensions(raw: unknown): Record<string, string | number | boolean> {
  if (raw === undefined || raw === null) {
    return {};
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new UsageValidationError("Field 'dimensions' must be a key-value object");
  }

  const record = raw as Record<string, unknown>;
  const result: Record<string, string | number | boolean> = {};

  for (const [key, value] of Object.entries(record)) {
    if (value === undefined || value === null) {
      continue;
    }
    const valType = typeof value;
    if (valType !== 'string' && valType !== 'number' && valType !== 'boolean') {
      throw new UsageValidationError(
        `Dimension '${key}' must be a string, number, or boolean scalar; received '${valType}'`,
      );
    }
    result[key] = value as string | number | boolean;
  }

  return result;
}

export function validateLineage(raw: unknown): UsageEventLineage {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new UsageValidationError("Field 'lineage' must be a non-null object");
  }

  const record = raw as Record<string, unknown>;

  if (typeof record['correlationId'] !== 'string' || record['correlationId'].trim().length === 0) {
    throw new UsageValidationError("Lineage 'correlationId' must be a non-empty string");
  }
  if (typeof record['requestId'] !== 'string' || record['requestId'].trim().length === 0) {
    throw new UsageValidationError("Lineage 'requestId' must be a non-empty string");
  }

  return {
    correlationId: record['correlationId'].trim(),
    requestId: record['requestId'].trim(),
    sessionId:
      typeof record['sessionId'] === 'string' && record['sessionId'].trim().length > 0
        ? record['sessionId'].trim()
        : undefined,
    runId:
      typeof record['runId'] === 'string' && record['runId'].trim().length > 0
        ? record['runId'].trim()
        : undefined,
    stepId:
      typeof record['stepId'] === 'string' && record['stepId'].trim().length > 0
        ? record['stepId'].trim()
        : undefined,
    parentEventId:
      typeof record['parentEventId'] === 'string' && record['parentEventId'].trim().length > 0
        ? record['parentEventId'].trim()
        : undefined,
  };
}

export function validateUsageEvent(raw: unknown): UsageEvent {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new UsageValidationError('UsageEvent must be a non-null object');
  }

  const rec = raw as Record<string, unknown>;

  // eventId
  if (typeof rec['eventId'] !== 'string' || rec['eventId'].trim().length === 0) {
    throw new UsageValidationError("Field 'eventId' must be a non-empty string");
  }

  // schemaVersion
  const schemaVersion =
    typeof rec['schemaVersion'] === 'string' && rec['schemaVersion'].trim().length > 0
      ? rec['schemaVersion'].trim()
      : '1.0.0';

  // tenantId (MANDATORY)
  if (typeof rec['tenantId'] !== 'string' || rec['tenantId'].trim().length === 0) {
    throw new UsageValidationError("Field 'tenantId' is mandatory and must be a non-empty string");
  }

  // userId (OPTIONAL, but must not be synthetic if present)
  let userId: string | undefined;
  if (rec['userId'] !== undefined && rec['userId'] !== null) {
    if (typeof rec['userId'] !== 'string' || rec['userId'].trim().length === 0) {
      throw new UsageValidationError("Field 'userId', if provided, must be a non-empty string");
    }
    const trimmedUser = rec['userId'].trim();
    if (isSyntheticIdentity(trimmedUser)) {
      throw new UsageValidationError(
        `Fabricated synthetic userId '${trimmedUser}' is forbidden. userId must be omitted for system workloads.`,
      );
    }
    userId = trimmedUser;
  }

  // actorId (OPTIONAL, but must not be synthetic if present)
  let actorId: string | undefined;
  if (rec['actorId'] !== undefined && rec['actorId'] !== null) {
    if (typeof rec['actorId'] !== 'string' || rec['actorId'].trim().length === 0) {
      throw new UsageValidationError("Field 'actorId', if provided, must be a non-empty string");
    }
    const trimmedActor = rec['actorId'].trim();
    if (isSyntheticIdentity(trimmedActor)) {
      throw new UsageValidationError(
        `Fabricated synthetic actorId '${trimmedActor}' is forbidden. actorId must be omitted for system workloads.`,
      );
    }
    actorId = trimmedActor;
  }

  // productId
  if (typeof rec['productId'] !== 'string' || rec['productId'].trim().length === 0) {
    throw new UsageValidationError("Field 'productId' must be a non-empty string");
  }

  // sourceService
  if (typeof rec['sourceService'] !== 'string' || rec['sourceService'].trim().length === 0) {
    throw new UsageValidationError("Field 'sourceService' must be a non-empty string");
  }

  // operation
  if (typeof rec['operation'] !== 'string' || rec['operation'].trim().length === 0) {
    throw new UsageValidationError("Field 'operation' must be a non-empty string");
  }

  // resourceId
  if (typeof rec['resourceId'] !== 'string' || rec['resourceId'].trim().length === 0) {
    throw new UsageValidationError("Field 'resourceId' must be a non-empty string");
  }

  // idempotencyKey
  if (typeof rec['idempotencyKey'] !== 'string' || rec['idempotencyKey'].trim().length === 0) {
    throw new UsageValidationError("Field 'idempotencyKey' must be a non-empty string");
  }

  // occurredAt
  const occurredAt = validateIsoDateString(rec['occurredAt'], 'occurredAt');

  // ingestedAt
  let ingestedAt: string | undefined;
  if (rec['ingestedAt'] !== undefined && rec['ingestedAt'] !== null) {
    ingestedAt = validateIsoDateString(rec['ingestedAt'], 'ingestedAt');
  }

  // measurements
  const measurements = validateMeasurements(rec['measurements'], rec['operation'].trim());

  // dimensions
  const dimensions = validateDimensions(rec['dimensions']);

  // lineage
  const lineage = validateLineage(rec['lineage']);

  return {
    eventId: rec['eventId'].trim(),
    schemaVersion,
    tenantId: rec['tenantId'].trim(),
    userId,
    actorId,
    productId: rec['productId'].trim(),
    sourceService: rec['sourceService'].trim(),
    operation: rec['operation'].trim(),
    resourceId: rec['resourceId'].trim(),
    measurements,
    dimensions,
    lineage,
    idempotencyKey: rec['idempotencyKey'].trim(),
    occurredAt,
    ingestedAt,
  };
}
