import type { IncomingMessage, ServerResponse } from 'node:http';
import { HttpStatus, type ApiResponse } from '@oicunt/contracts';
import type {
  AuthenticateTokenUseCase,
  GetContextUseCase,
  ContextResponseData,
} from '../../../application/index.js';
import { type GatewayRequestContext, handleHttpError } from '../middleware.js';

export class ContextController {
  constructor(
    private readonly authenticateUseCase: AuthenticateTokenUseCase,
    private readonly getContextUseCase: GetContextUseCase,
  ) {}

  async handleGetContext(
    req: IncomingMessage,
    res: ServerResponse,
    context: GatewayRequestContext,
  ): Promise<void> {
    try {
      const authHeader = req.headers['authorization'];
      const authResult = await this.authenticateUseCase.execute({
        authHeader: typeof authHeader === 'string' ? authHeader : undefined,
      });

      if (!authResult.ok) {
        handleHttpError(res, authResult.error, context);
        return;
      }

      context.identity = authResult.value;

      const contextResult = await this.getContextUseCase.execute(authResult.value);
      if (!contextResult.ok) {
        handleHttpError(res, contextResult.error, context);
        return;
      }

      const responsePayload: ApiResponse<ContextResponseData> = {
        success: true,
        data: contextResult.value,
        meta: {
          timestamp: new Date().toISOString(),
          correlationId: context.correlationId,
          executionTimeMs: Date.now() - context.startTime,
        },
      };

      res.writeHead(HttpStatus.OK, {
        'Content-Type': 'application/json; charset=utf-8',
        'X-Request-ID': context.requestId,
        'X-Correlation-ID': context.correlationId,
      });
      res.end(JSON.stringify(responsePayload));
    } catch (err) {
      handleHttpError(res, err, context);
    }
  }
}
