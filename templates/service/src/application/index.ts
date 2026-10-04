import { type Result, ok } from '@oicunt/contracts';
import type { DomainError } from '../domain/index.js';
import type { UseCase } from './ports.js';

export * from './ports.js';

export interface GetServiceHealthInput {
  readonly includeDetails?: boolean;
}

export interface ServiceHealthDTO {
  readonly status: 'healthy' | 'degraded' | 'unhealthy';
  readonly version: string;
  readonly uptimeSeconds: number;
}

export class GetServiceHealthUseCase implements UseCase<GetServiceHealthInput, ServiceHealthDTO> {
  private readonly startTime: number = Date.now();

  constructor(private readonly version: string = '0.1.0') {}

  async execute(_input: GetServiceHealthInput): Promise<Result<ServiceHealthDTO, DomainError>> {
    const uptimeSeconds = Math.floor((Date.now() - this.startTime) / 1000);

    return ok({
      status: 'healthy',
      version: this.version,
      uptimeSeconds,
    });
  }
}
