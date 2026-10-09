import { type Result, ok, err, validateCreateCompletionRequest } from '@oicunt/contracts';
import {
  type DomainError,
  type IdentityContext,
  ForbiddenError,
  ValidationError,
  hasScopeOrPermission,
} from '../../domain/index.js';
import type {
  OrchestratorClientPort,
  ForwardCompletionResponse,
} from '../ports/orchestrator-client.port.js';

export interface ForwardCompletionInput {
  readonly identity: IdentityContext;
  readonly requestId: string;
  readonly correlationId: string;
  readonly body: unknown;
  readonly signal?: AbortSignal | undefined;
}

export class ForwardCompletionUseCase {
  constructor(private readonly orchestratorClient: OrchestratorClientPort) {}

  async execute(
    input: ForwardCompletionInput,
  ): Promise<Result<ForwardCompletionResponse, DomainError>> {
    // 1. Authorize: check required 'ai:use' permission or scope
    if (!hasScopeOrPermission(input.identity, 'ai:use')) {
      return err(
        new ForbiddenError("Access denied: Caller lacks required 'ai:use' scope or permission"),
      );
    }

    // 2. Validate payload structure (unary JSON only in Step 1)
    const validationError = this.validatePayload(input.body);
    if (validationError) {
      return err(validationError);
    }

    // 3. Forward to orchestrator with authoritative identity & correlation context
    try {
      const response = await this.orchestratorClient.forwardCompletion({
        requestId: input.requestId,
        correlationId: input.correlationId,
        userId: input.identity.userId,
        tenantId: input.identity.tenantId,
        body: input.body,
        signal: input.signal,
      });

      return ok(response);
    } catch (error) {
      if (error instanceof Error && 'statusCode' in error) {
        return err(error as DomainError);
      }
      return err(
        new ValidationError(
          error instanceof Error ? error.message : 'Failed to forward request to orchestrator',
        ),
      );
    }
  }

  private validatePayload(body: unknown): ValidationError | null {
    const errors = validateCreateCompletionRequest(body);
    return errors.length > 0 ? new ValidationError(errors.join('; ')) : null;
  }
}
