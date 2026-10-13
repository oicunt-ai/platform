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

  /**
   * Authorize and validate without contacting downstream. The completion
   * controller runs this BEFORE admission acquisition so unauthorized or
   * invalid requests never consume admission quota. execute() reuses the
   * same check (defense in depth).
   */
  checkEligible(identity: IdentityContext, body: unknown): DomainError | null {
    if (!hasScopeOrPermission(identity, 'ai:use')) {
      return new ForbiddenError(
        "Access denied: Caller lacks required 'ai:use' scope or permission",
      );
    }
    return this.validatePayload(body);
  }

  async execute(
    input: ForwardCompletionInput,
  ): Promise<Result<ForwardCompletionResponse, DomainError>> {
    // Authorize ('ai:use') and validate the payload (unary JSON) up front so
    // rejected requests never reach downstream or consume admission quota.
    const preflightError = this.checkEligible(input.identity, input.body);
    if (preflightError) {
      return err(preflightError);
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
