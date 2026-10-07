import type { UsageEventsQuery, UsageEventsResult } from '../../domain/types.js';
import { UsageTenantMismatchError, UsageValidationError } from '../../domain/errors.js';
import { validateIsoDateString } from '../../domain/validation.js';
import type { UsageRepositoryPort } from '../ports/usage-repository.port.js';

export class QueryUsageEventsUseCase {
  constructor(private readonly repository: UsageRepositoryPort) {}

  public async execute(
    query: UsageEventsQuery,
    authenticatedTenantId?: string | undefined,
  ): Promise<UsageEventsResult> {
    if (!query.tenantId || query.tenantId.trim().length === 0) {
      throw new UsageValidationError("Query parameter 'tenantId' is required");
    }

    if (authenticatedTenantId && authenticatedTenantId !== query.tenantId) {
      throw new UsageTenantMismatchError(authenticatedTenantId, query.tenantId);
    }

    let startTime: string | undefined;
    if (query.startTime) {
      startTime = validateIsoDateString(query.startTime, 'startTime');
    }

    let endTime: string | undefined;
    if (query.endTime) {
      endTime = validateIsoDateString(query.endTime, 'endTime');
    }

    if (startTime && endTime && new Date(startTime).getTime() > new Date(endTime).getTime()) {
      throw new UsageValidationError("'startTime' cannot be greater than 'endTime'");
    }

    const limit = query.limit !== undefined ? Math.min(Math.max(1, query.limit), 200) : 50;

    return await this.repository.queryEvents({
      ...query,
      tenantId: query.tenantId.trim(),
      startTime,
      endTime,
      limit,
    });
  }
}
