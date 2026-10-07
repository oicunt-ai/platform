import type { IncomingMessage, ServerResponse } from 'node:http';
import type {
  AuthenticateTokenUseCase,
  ForwardCompletionUseCase,
} from '../../../application/index.js';
import { type GatewayRequestContext, handleHttpError, parseJsonBody } from '../middleware.js';

export class CompletionController {
  constructor(
    private readonly authenticateUseCase: AuthenticateTokenUseCase,
    private readonly forwardCompletionUseCase: ForwardCompletionUseCase,
  ) {}

  async handleCompletion(
    req: IncomingMessage,
    res: ServerResponse,
    context: GatewayRequestContext,
  ): Promise<void> {
    const abortController = new AbortController();

    res.on('close', () => {
      if (!res.writableEnded) {
        abortController.abort();
      }
    });

    try {
      // 1. Authenticate Bearer JWT
      const authHeader = req.headers['authorization'];
      const authResult = await this.authenticateUseCase.execute({
        authHeader: typeof authHeader === 'string' ? authHeader : undefined,
      });

      if (!authResult.ok) {
        handleHttpError(res, authResult.error, context);
        return;
      }

      context.identity = authResult.value;

      // 2. Parse request JSON body
      const body = await parseJsonBody(req);

      // 3. Authorize ('ai:use') & Forward unary completion to AI Orchestrator
      const forwardResult = await this.forwardCompletionUseCase.execute({
        identity: authResult.value,
        requestId: context.requestId,
        correlationId: context.correlationId,
        body,
        signal: abortController.signal,
      });

      if (!forwardResult.ok) {
        handleHttpError(res, forwardResult.error, context);
        return;
      }

      const forwardRes = forwardResult.value;

      // 4. Return unary JSON response to client
      const responseData =
        typeof forwardRes.bodyData === 'string'
          ? forwardRes.bodyData
          : JSON.stringify(forwardRes.bodyData);

      res.writeHead(forwardRes.statusCode, {
        'Content-Type': 'application/json; charset=utf-8',
        'X-Request-ID': context.requestId,
        'X-Correlation-ID': context.correlationId,
      });
      res.end(responseData);
    } catch (err) {
      if (!res.headersSent) {
        handleHttpError(res, err, context);
      } else if (!res.writableEnded) {
        res.end();
      }
    }
  }
}
