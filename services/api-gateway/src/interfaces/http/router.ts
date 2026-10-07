import type { IncomingMessage, ServerResponse } from 'node:http';
import { HttpStatus } from '@oicunt/contracts';
import type { Logger } from '@oicunt/logging';
import type { Tracer } from '@oicunt/observability';
import type { ContextController } from './controllers/context.controller.js';
import type { CompletionController } from './controllers/completion.controller.js';
import { sendLivenessResponse, sendReadinessResponse } from './health.js';
import { createGatewayRequestContext, handleHttpError } from './middleware.js';

export interface RouterOptions {
  readonly serviceName: string;
  readonly version: string;
  readonly isReady: () => boolean;
  readonly logger: Logger;
  readonly tracer: Tracer;
  readonly contextController: ContextController;
  readonly completionController: CompletionController;
}

export function createHttpRouter(options: RouterOptions) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    // 1. Establish authoritative request context (stripping spoofed client headers)
    const context = createGatewayRequestContext(req, res, options.logger);
    const parsedUrl = new URL(req.url ?? '/', 'http://127.0.0.1');
    const pathname = parsedUrl.pathname;
    const method = (req.method ?? 'GET').toUpperCase();

    context.logger.info(`Incoming HTTP ${method} ${pathname}`);

    try {
      // 2. Health & Readiness Probes
      if (method === 'GET' && (pathname === '/healthz' || pathname === '/health/liveness')) {
        sendLivenessResponse(res, options.serviceName, options.version);
        return;
      }

      if (method === 'GET' && (pathname === '/readyz' || pathname === '/health/readiness')) {
        sendReadinessResponse(res, options.isReady(), options.serviceName, options.version);
        return;
      }

      // 3. User Identity Context Route: GET /api/v1/context
      if (pathname === '/api/v1/context') {
        if (method !== 'GET') {
          res.writeHead(HttpStatus.BAD_REQUEST, {
            'Content-Type': 'application/json; charset=utf-8',
            'X-Request-ID': context.requestId,
            'X-Correlation-ID': context.correlationId,
          });
          res.end(
            JSON.stringify({
              success: false,
              error: {
                code: 'METHOD_NOT_ALLOWED',
                message: `Method ${method} not allowed for /api/v1/context. Expected GET`,
              },
            }),
          );
          return;
        }

        await options.tracer.withSpan('gateway.get_context', async () => {
          await options.contextController.handleGetContext(req, res, context);
        });
        return;
      }

      // 4. AI Completion Ingress Route: POST /api/v1/ai/completions
      if (pathname === '/api/v1/ai/completions') {
        if (method !== 'POST') {
          res.writeHead(HttpStatus.BAD_REQUEST, {
            'Content-Type': 'application/json; charset=utf-8',
            'X-Request-ID': context.requestId,
            'X-Correlation-ID': context.correlationId,
          });
          res.end(
            JSON.stringify({
              success: false,
              error: {
                code: 'METHOD_NOT_ALLOWED',
                message: `Method ${method} not allowed for /api/v1/ai/completions. Expected POST`,
              },
            }),
          );
          return;
        }

        await options.tracer.withSpan('gateway.ai_completion', async () => {
          await options.completionController.handleCompletion(req, res, context);
        });
        return;
      }

      // 5. Route Not Found
      res.writeHead(HttpStatus.NOT_FOUND, {
        'Content-Type': 'application/json; charset=utf-8',
        'X-Request-ID': context.requestId,
        'X-Correlation-ID': context.correlationId,
      });
      res.end(
        JSON.stringify({
          success: false,
          error: {
            code: 'NOT_FOUND',
            message: `Route '${pathname}' not found`,
          },
          meta: {
            timestamp: new Date().toISOString(),
            correlationId: context.correlationId,
            executionTimeMs: Date.now() - context.startTime,
          },
        }),
      );
    } catch (error) {
      handleHttpError(res, error, context);
    }
  };
}
