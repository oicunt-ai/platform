export const AI_PUBLIC_CONTRACT_VERSION = '1.1.0' as const;
export const OICUNT_MODEL_ID_PATTERN = /^oicunt\.model\.[a-z0-9][a-z0-9._-]{0,47}$/;

export type PublicAiErrorCode =
  | 'VALIDATION_ERROR'
  | 'AUTHENTICATION_ERROR'
  | 'FORBIDDEN'
  | 'RATE_LIMITED'
  | 'CONCURRENCY_LIMITED'
  | 'MODEL_UNAVAILABLE'
  | 'PROVIDER_UNAVAILABLE'
  | 'TIMEOUT'
  | 'CANCELLED'
  | 'PERSISTENCE_FAILURE'
  | 'INTERNAL_ERROR';

export type PublicChatRole = 'system' | 'user' | 'assistant';

export interface PublicChatMessage {
  readonly role: PublicChatRole;
  readonly content: string;
}

export interface CreateCompletionRequest {
  readonly conversationId: string;
  readonly model: string;
  readonly messages: readonly PublicChatMessage[];
  readonly stream?: boolean | undefined;
  readonly timeoutMs?: number | undefined;
  /**
   * Optional model reasoning effort hint (for example 'low', 'medium' or
   * 'high'). Whether a value is supported depends on the selected model and
   * is enforced against authoritative Registry metadata downstream; the
   * public boundary only checks that a usable value was supplied.
   */
  readonly effort?: string | undefined;
  /**
   * Opt-in exposure of model reasoning content. Omitted or false keeps
   * reasoning hidden; only an explicit true may expose it, subject to
   * downstream enforcement.
   */
  readonly exposeReasoning?: boolean | undefined;
  readonly parameters?:
    | {
        readonly maxTokens?: number | undefined;
        readonly temperature?: number | undefined;
        readonly topP?: number | undefined;
        readonly stopSequences?: readonly string[] | undefined;
      }
    | undefined;
}

export interface PublicModelCatalogEntry {
  readonly id: string;
  readonly displayName: string;
  readonly description?: string | undefined;
  readonly capabilities: readonly string[];
  readonly status: string;
}

export interface PublicConversation {
  readonly id: string;
  readonly title: string | null;
  readonly status: string;
  readonly messageCount: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateConversationRequest {
  readonly title?: string | undefined;
}

export interface PublicConversationMessage {
  readonly id: string;
  readonly conversationId: string;
  readonly turnId: string;
  readonly sequenceNumber: number;
  readonly role: PublicChatRole;
  readonly content: string | readonly Record<string, unknown>[];
  readonly createdAt: string;
}

export type PublicStreamEvent =
  | { readonly event: 'token'; readonly data: { readonly delta: string } }
  | {
      readonly event: 'finish';
      readonly data: {
        readonly finishReason: string;
        readonly usage: {
          readonly promptTokens: number;
          readonly completionTokens: number;
          readonly totalTokens: number;
        };
      };
    }
  | { readonly event: 'error'; readonly data: { readonly code: string; readonly message: string } };

export function validateCreateCompletionRequest(value: unknown): readonly string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return ['Request body must be a JSON object'];
  }
  const body = value as Record<string, unknown>;
  const errors: string[] = [];
  const allowedFields = new Set([
    'conversationId',
    'model',
    'messages',
    'stream',
    'timeoutMs',
    'effort',
    'exposeReasoning',
    'parameters',
  ]);
  for (const key of Object.keys(body)) {
    if (!allowedFields.has(key)) errors.push(`${key} is not supported by the v1 BILLY contract`);
  }
  if (typeof body['conversationId'] !== 'string' || !body['conversationId'].trim()) {
    errors.push('conversationId must be a non-empty string');
  }
  if (typeof body['model'] !== 'string' || !OICUNT_MODEL_ID_PATTERN.test(body['model'])) {
    errors.push('model must be a valid OICUNT catalog model identifier');
  }
  if ('stream' in body && typeof body['stream'] !== 'boolean') {
    errors.push('stream must be a boolean');
  }
  if (
    'effort' in body &&
    (typeof body['effort'] !== 'string' || !body['effort'].trim() || body['effort'].length > 64)
  ) {
    errors.push('effort must be a non-empty string');
  }
  if ('exposeReasoning' in body && typeof body['exposeReasoning'] !== 'boolean') {
    errors.push('exposeReasoning must be a boolean');
  }
  if (
    'timeoutMs' in body &&
    (typeof body['timeoutMs'] !== 'number' ||
      !Number.isInteger(body['timeoutMs']) ||
      body['timeoutMs'] <= 0)
  )
    errors.push('timeoutMs must be a positive integer');
  if (!Array.isArray(body['messages']) || body['messages'].length === 0) {
    errors.push('messages must be a non-empty array');
  } else {
    body['messages'].forEach((message, index) => {
      if (!message || typeof message !== 'object' || Array.isArray(message)) {
        errors.push(`messages[${index}] must be an object`);
        return;
      }
      const item = message as Record<string, unknown>;
      if (Object.keys(item).some((key) => !['role', 'content'].includes(key))) {
        errors.push(`messages[${index}] contains unsupported fields`);
      }
      if (!['system', 'user', 'assistant'].includes(String(item['role']))) {
        errors.push(`messages[${index}].role is invalid`);
      }
      if (typeof item['content'] !== 'string' || !item['content'].trim()) {
        errors.push(`messages[${index}].content must be a non-empty string`);
      }
    });
  }
  if ('parameters' in body) {
    if (
      !body['parameters'] ||
      typeof body['parameters'] !== 'object' ||
      Array.isArray(body['parameters'])
    ) {
      errors.push('parameters must be an object');
    } else {
      const parameters = body['parameters'] as Record<string, unknown>;
      if (
        Object.keys(parameters).some(
          (key) => !['maxTokens', 'temperature', 'topP', 'stopSequences'].includes(key),
        )
      ) {
        errors.push('parameters contains unsupported fields');
      }
      if (
        'maxTokens' in parameters &&
        (typeof parameters['maxTokens'] !== 'number' ||
          !Number.isInteger(parameters['maxTokens']) ||
          parameters['maxTokens'] <= 0)
      ) {
        errors.push('parameters.maxTokens must be a positive integer');
      }
      for (const key of ['temperature', 'topP'] as const) {
        if (
          key in parameters &&
          (typeof parameters[key] !== 'number' || !Number.isFinite(parameters[key]))
        ) {
          errors.push(`parameters.${key} must be a finite number`);
        }
      }
      if (
        'stopSequences' in parameters &&
        (!Array.isArray(parameters['stopSequences']) ||
          parameters['stopSequences'].some((item) => typeof item !== 'string'))
      ) {
        errors.push('parameters.stopSequences must be an array of strings');
      }
    }
  }
  return errors;
}

export function validateCreateConversationRequest(value: unknown): readonly string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return ['Request body must be a JSON object'];
  }
  const body = value as Record<string, unknown>;
  const errors = Object.keys(body)
    .filter((key) => key !== 'title')
    .map((key) => `${key} is not supported by the v1 conversation contract`);
  if ('title' in body && (typeof body['title'] !== 'string' || !body['title'].trim())) {
    errors.push('title must be a non-empty string when provided');
  }
  return errors;
}
