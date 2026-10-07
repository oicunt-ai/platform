import type { CreateReversalParams, UsageEvent } from '../../domain/types.js';
import { createReversalEvent } from '../../domain/reversal.js';
import {
  UsageNotFoundError,
  UsageTenantMismatchError,
  UsageValidationError,
} from '../../domain/errors.js';
import type { UsageRepositoryPort } from '../ports/usage-repository.port.js';

export interface CreateReversalResult {
  readonly reversalEvent: UsageEvent;
  readonly status: 'persisted' | 'duplicate';
}

export class CreateReversalUseCase {
  constructor(private readonly repository: UsageRepositoryPort) {}

  public async execute(
    params: CreateReversalParams,
    authenticatedTenantId?: string | undefined,
  ): Promise<CreateReversalResult> {
    if (!params.tenantId || params.tenantId.trim().length === 0) {
      throw new UsageValidationError("Field 'tenantId' is required");
    }

    if (authenticatedTenantId && authenticatedTenantId !== params.tenantId) {
      throw new UsageTenantMismatchError(authenticatedTenantId, params.tenantId);
    }

    if (!params.originalEventId || params.originalEventId.trim().length === 0) {
      throw new UsageValidationError("Field 'originalEventId' is required");
    }

    const originalEvent = await this.repository.findEventById(
      params.tenantId,
      params.originalEventId,
    );
    if (!originalEvent) {
      throw new UsageNotFoundError('usage_event', params.originalEventId);
    }

    if (
      originalEvent.operation === 'usage.reversal' ||
      originalEvent.operation === 'usage.adjustment'
    ) {
      throw new UsageValidationError('Cannot reverse a usage event that is already a reversal');
    }

    const reversalEvent = createReversalEvent(params, originalEvent);
    const { persisted, event } = await this.repository.saveEvent(reversalEvent);

    return {
      reversalEvent: event,
      status: persisted ? 'persisted' : 'duplicate',
    };
  }
}
