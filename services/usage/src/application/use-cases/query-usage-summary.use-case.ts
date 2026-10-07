import type { UsageSummaryQuery, UsageSummaryResult } from '../../domain/types.js';
import { UsageTenantMismatchError, UsageValidationError } from '../../domain/errors.js';
import { validateIsoDateString } from '../../domain/validation.js';
import type { UsageRepositoryPort } from '../ports/usage-repository.port.js';

export class QueryUsageSummaryUseCase {
  constructor(private readonly repository: UsageRepositoryPort) {}

  public async execute(
    query: UsageSummaryQuery,
    authenticatedTenantId?: string | undefined,
  ): Promise<UsageSummaryResult> {
    if (!query.tenantId || query.tenantId.trim().length === 0) {
      throw new UsageValidationError("Query parameter 'tenantId' is required");
    }

    if (authenticatedTenantId && authenticatedTenantId !== query.tenantId) {
      throw new UsageTenantMismatchError(authenticatedTenantId, query.tenantId);
    }

    const startTime = validateIsoDateString(query.startTime, 'startTime');
    const endTime = validateIsoDateString(query.endTime, 'endTime');

    if (new Date(startTime).getTime() > new Date(endTime).getTime()) {
      throw new UsageValidationError("'startTime' cannot be greater than 'endTime'");
    }

    return await this.repository.querySummary({
      ...query,
      tenantId: query.tenantId.trim(),
      startTime,
      endTime,
    });
  }
}
