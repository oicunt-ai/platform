import type { IncomingMessage, ServerResponse } from 'node:http';
import { validateCreateConversationRequest } from '@oicunt/contracts';
import type { OrchestratorClientPort } from '../../../application/ports/orchestrator-client.port.js';
import type { AuthenticateTokenUseCase } from '../../../application/use-cases/authenticate-token.use-case.js';
import { ForbiddenError, ValidationError, hasScopeOrPermission } from '../../../domain/index.js';
import type { GatewayRequestContext } from '../middleware.js';
import { handleHttpError, parseJsonBody } from '../middleware.js';
import { normalizePublicAiError } from '../public-ai-error.js';

type JsonObject = Record<string, unknown>;

export class ResourcesController {
  constructor(
    private readonly authenticate: AuthenticateTokenUseCase,
    private readonly orchestrator: OrchestratorClientPort,
  ) {}

  async handle(
    req: IncomingMessage,
    res: ServerResponse,
    context: GatewayRequestContext,
    path: string,
  ): Promise<void> {
    try {
      const auth = await this.authenticate.execute({
        authHeader:
          typeof req.headers.authorization === 'string' ? req.headers.authorization : undefined,
      });
      if (!auth.ok) throw auth.error;
      if (!hasScopeOrPermission(auth.value, 'ai:use')) throw new ForbiddenError('Access denied');
      if (!this.orchestrator.forwardResource) throw new Error('Resource API unavailable');
      const method = req.method === 'POST' ? 'POST' : 'GET';
      const body = method === 'POST' ? await parseJsonBody(req) : undefined;
      if (method === 'POST' && path === '/internal/v1/orchestrator/conversations') {
        const errors = validateCreateConversationRequest(body);
        if (errors.length > 0) throw new ValidationError(errors.join('; '));
      }
      const result = await this.orchestrator.forwardResource({
        method,
        path,
        requestId: context.requestId,
        correlationId: context.correlationId,
        userId: auth.value.userId,
        tenantId: auth.value.tenantId,
        body,
      });
      res.writeHead(result.statusCode, {
        'Content-Type': 'application/json; charset=utf-8',
        'X-Request-ID': context.requestId,
        'X-Correlation-ID': context.correlationId,
      });
      const publicBody =
        result.statusCode >= 200 && result.statusCode < 300
          ? this.toPublicResource(path, result.bodyData)
          : normalizePublicAiError(result.statusCode, result.bodyData);
      res.end(typeof publicBody === 'string' ? publicBody : JSON.stringify(publicBody));
    } catch (error) {
      handleHttpError(res, error, context);
    }
  }

  private toPublicResource(path: string, body: unknown): unknown {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return body;
    const envelope = body as JsonObject;
    const data = envelope['data'];

    if (path === '/internal/v1/orchestrator/catalog' && Array.isArray(data)) {
      return { ...envelope, data: data.map((entry) => this.toPublicModel(entry)) };
    }
    if (path === '/internal/v1/orchestrator/conversations') {
      if (Array.isArray((data as JsonObject | undefined)?.['conversations'])) {
        const list = data as JsonObject;
        return {
          ...envelope,
          data: {
            conversations: (list['conversations'] as unknown[]).map((item) =>
              this.toPublicConversation(item),
            ),
            total: list['total'],
            hasMore: list['hasMore'],
          },
        };
      }
      return { ...envelope, data: this.toPublicConversation(data) };
    }
    if (path.endsWith('/messages') && data && typeof data === 'object') {
      const list = data as JsonObject;
      if (Array.isArray(list['messages'])) {
        return {
          ...envelope,
          data: {
            messages: (list['messages'] as unknown[]).map((item) => this.toPublicMessage(item)),
            hasMore: list['hasMore'],
          },
        };
      }
    }
    return body;
  }

  private toPublicModel(value: unknown): JsonObject {
    const model = this.asObject(value);
    const capabilityMap = this.asObject(model['capabilities']);
    return {
      id: model['id'],
      displayName: model['displayName'],
      description: model['description'],
      capabilities: Object.entries(capabilityMap)
        .filter(([, enabled]) => enabled === true)
        .map(([name]) => name),
      status: model['status'],
    };
  }

  private toPublicConversation(value: unknown): JsonObject {
    const conversation = this.asObject(value);
    return {
      id: conversation['id'],
      title: conversation['title'],
      status: conversation['status'],
      messageCount: conversation['messageCount'],
      createdAt: conversation['createdAt'],
      updatedAt: conversation['updatedAt'],
    };
  }

  private toPublicMessage(value: unknown): JsonObject {
    const message = this.asObject(value);
    return {
      id: message['id'],
      conversationId: message['conversationId'],
      turnId: message['turnId'],
      sequenceNumber: message['sequenceNumber'],
      role: message['role'],
      content: message['content'],
      createdAt: message['createdAt'],
    };
  }

  private asObject(value: unknown): JsonObject {
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonObject) : {};
  }
}
