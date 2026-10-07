import { UsageTenantMismatchError, UsageValidationError } from '../../domain/errors.js';
import { validateIsoDateString } from '../../domain/validation.js';
import type { UsageRepositoryPort } from '../ports/usage-repository.port.js';

export interface RecomputeAggregatesParams {
  readonly tenantId: string;
  readonly startTime: string;
  readonly endTime: string;
}

export interface RecomputeAggregatesResult {
  readonly tenantId: string;
  readonly window: {
    readonly startTime: string;
    readonly endTime: string;
  };
  readonly recomputedHours: number;
  readonly recomputedDays: number;
}

export class RecomputeAggregatesUseCase {
  constructor(private readonly repository: UsageRepositoryPort) {}

  public async execute(
    params: RecomputeAggregatesParams,
    authenticatedTenantId?: string | undefined,
  ): Promise<RecomputeAggregatesResult> {
    if (!params.tenantId || params.tenantId.trim().length === 0) {
      throw new UsageValidationError("Field 'tenantId' is required");
    }

    if (authenticatedTenantId && authenticatedTenantId !== params.tenantId) {
      throw new UsageTenantMismatchError(authenticatedTenantId, params.tenantId);
    }

    const startTime = validateIsoDateString(params.startTime, 'startTime');
    const endTime = validateIsoDateString(params.endTime, 'endTime');

    if (new Date(startTime).getTime() > new Date(endTime).getTime()) {
      throw new UsageValidationError("'startTime' cannot be greater than 'endTime'");
    }

    const result = await this.repository.recomputeAggregates(
      params.tenantId.trim(),
      startTime,
      endTime,
    );

    return {
      tenantId: params.tenantId.trim(),
      window: { startTime, endTime },
      recomputedHours: result.recomputedHours,
      recomputedDays: result.recomputedDays,
    };
  }
}
