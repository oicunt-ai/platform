import { type Result, ok, err } from '@oicunt/contracts';
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
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return new ValidationError('Request body must be a valid JSON object');
    }

    const rec = body as Record<string, unknown>;

    if ('stream' in rec && typeof rec['stream'] !== 'boolean') {
      return new ValidationError("Field 'stream' must be a boolean", 'stream');
    }

    // conversationId
    if (typeof rec['conversationId'] !== 'string' || rec['conversationId'].trim().length === 0) {
      return new ValidationError(
        "Field 'conversationId' is required and must be a non-empty string",
        'conversationId',
      );
    }

    // model
    if (typeof rec['model'] !== 'string' || rec['model'].trim().length === 0) {
      return new ValidationError(
        "Field 'model' is required and must be a non-empty string",
        'model',
      );
    }

    const modelRegex = /^(oicunt\.model\.[a-z0-9_-]+|claude-sonnet)$/;
    if (!modelRegex.test(rec['model'].trim())) {
      return new ValidationError(
        `Field 'model' must follow canonical pattern 'oicunt.model.<tier>' or 'claude-sonnet', received '${rec['model']}'`,
        'model',
      );
    }

    // messages
    if (!Array.isArray(rec['messages']) || rec['messages'].length === 0) {
      return new ValidationError(
        "Field 'messages' is required and must be a non-empty array",
        'messages',
      );
    }

    const validRoles = new Set(['system', 'user', 'assistant']);
    for (let i = 0; i < rec['messages'].length; i++) {
      const msg = rec['messages'][i];
      if (!msg || typeof msg !== 'object') {
        return new ValidationError(`Message at index ${i} must be an object`, `messages[${i}]`);
      }
      if (typeof msg.role !== 'string' || !validRoles.has(msg.role)) {
        return new ValidationError(
          `Message at index ${i} has invalid role '${msg.role}'. Must be 'system', 'user', or 'assistant'`,
          `messages[${i}].role`,
        );
      }
      if (typeof msg.content !== 'string' || msg.content.trim().length === 0) {
        return new ValidationError(
          `Message at index ${i} must have non-empty content`,
          `messages[${i}].content`,
        );
      }
    }

    return null;
  }
}
