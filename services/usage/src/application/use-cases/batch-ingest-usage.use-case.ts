import type { BatchIngestUsageResult } from '../../domain/types.js';
import { validateUsageEvent } from '../../domain/validation.js';
import { UsageTenantMismatchError, UsageValidationError } from '../../domain/errors.js';
import type { UsageRepositoryPort } from '../ports/usage-repository.port.js';
import type { IngestUsageContext } from './ingest-usage.use-case.js';

export const MAX_USAGE_BATCH_SIZE = 100;

export class BatchIngestUsageUseCase {
  constructor(private readonly repository: UsageRepositoryPort) {}

  public async execute(
    rawEvents: unknown,
    context?: IngestUsageContext | undefined,
  ): Promise<BatchIngestUsageResult> {
    if (!Array.isArray(rawEvents)) {
      throw new UsageValidationError('Batch ingestion payload must be a JSON array of events');
    }

    if (rawEvents.length === 0) {
      throw new UsageValidationError('Batch ingestion payload must contain at least one event');
    }

    if (rawEvents.length > MAX_USAGE_BATCH_SIZE) {
      throw new UsageValidationError(
        `Batch size exceeds maximum limit of ${MAX_USAGE_BATCH_SIZE} events`,
      );
    }

    const validatedEvents = rawEvents.map((raw, index) => {
      try {
        const event = validateUsageEvent(raw);
        if (context?.authenticatedTenantId && context.authenticatedTenantId !== event.tenantId) {
          throw new UsageTenantMismatchError(context.authenticatedTenantId, event.tenantId);
        }
        return event;
      } catch (err) {
        if (err instanceof Error) {
          throw new UsageValidationError(`Event at index ${index} is invalid: ${err.message}`);
        }
        throw err;
      }
    });

    return await this.repository.saveEventsBatch(validatedEvents);
  }
}
