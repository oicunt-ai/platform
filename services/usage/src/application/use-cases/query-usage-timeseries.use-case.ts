import type { UsageTimeseriesQuery, UsageTimeseriesResult } from '../../domain/types.js';
import { UsageTenantMismatchError, UsageValidationError } from '../../domain/errors.js';
import { validateIsoDateString } from '../../domain/validation.js';
import type { UsageRepositoryPort } from '../ports/usage-repository.port.js';

export class QueryUsageTimeseriesUseCase {
  constructor(private readonly repository: UsageRepositoryPort) {}

  public async execute(
    query: UsageTimeseriesQuery,
    authenticatedTenantId?: string | undefined,
  ): Promise<UsageTimeseriesResult> {
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

    const granularity = query.granularity ?? 'daily';
    if (granularity !== 'hourly' && granularity !== 'daily') {
      throw new UsageValidationError("Parameter 'granularity' must be either 'hourly' or 'daily'");
    }

    return await this.repository.queryTimeseries({
      ...query,
      tenantId: query.tenantId.trim(),
      startTime,
      endTime,
      granularity,
    });
  }
}
