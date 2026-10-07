import type { IngestUsageResult } from '../../domain/types.js';
import { validateUsageEvent } from '../../domain/validation.js';
import { UsageTenantMismatchError } from '../../domain/errors.js';
import type { UsageRepositoryPort } from '../ports/usage-repository.port.js';

export interface IngestUsageContext {
  readonly authenticatedTenantId?: string | undefined;
  readonly authenticatedService?: string | undefined;
}

export class IngestUsageUseCase {
  constructor(private readonly repository: UsageRepositoryPort) {}

  public async execute(
    rawEvent: unknown,
    context?: IngestUsageContext | undefined,
  ): Promise<IngestUsageResult> {
    const validatedEvent = validateUsageEvent(rawEvent);

    // Enforce tenant boundary if the authenticated caller context specifies a tenant
    if (
      context?.authenticatedTenantId &&
      context.authenticatedTenantId !== validatedEvent.tenantId
    ) {
      throw new UsageTenantMismatchError(context.authenticatedTenantId, validatedEvent.tenantId);
    }

    const { persisted, event } = await this.repository.saveEvent(validatedEvent);

    return {
      eventId: event.eventId,
      status: persisted ? 'persisted' : 'duplicate',
      occurredAt: event.occurredAt,
    };
  }
}
