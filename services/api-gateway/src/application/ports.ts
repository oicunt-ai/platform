import type { DomainEvent } from '@oicunt/events';
import type { Result } from '@oicunt/contracts';
import type { DomainError } from '../domain/index.js';

export interface UseCase<TInput, TOutput> {
  execute(input: TInput): Promise<Result<TOutput, DomainError>>;
}

export interface EventPublisherPort {
  publish<T>(event: DomainEvent<T>): Promise<void>;
}

export * from './ports/token-verifier.port.js';
export * from './ports/orchestrator-client.port.js';
export * from './ports/usage-admission.port.js';
