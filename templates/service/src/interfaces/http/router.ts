import type { IncomingMessage, ServerResponse } from 'node:http';
import { HttpStatus, type ApiResponse } from '@oicunt/contracts';
import type { Logger } from '@oicunt/logging';
import type { Tracer } from '@oicunt/observability';
import { GetServiceHealthUseCase } from '../../application/index.js';
import { sendLivenessResponse, sendReadinessResponse } from './health.js';
import { createRequestContext, handleHttpError } from './middleware.js';

export interface RouterOptions {
  readonly serviceName: string;
  readonly version: string;
  readonly isReady: () => boolean;
  readonly logger: Logger;
  readonly tracer: Tracer;
}

export function createHttpRouter(options: RouterOptions) {
  const healthUseCase = new GetServiceHealthUseCase(options.version);

  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const context = createRequestContext(req, res, options.logger);
    const url = req.url ?? '/';
    const method = req.method ?? 'GET';

    context.logger.info(`HTTP ${method} ${url} received`);

    try {
      // 1. Liveness Probe
      if (url === '/healthz' || url === '/health/liveness') {
        sendLivenessResponse(res, options.serviceName, options.version);
        return;
      }

      // 2. Readiness Probe
      if (url === '/readyz' || url === '/health/readiness') {
        sendReadinessResponse(res, options.isReady(), options.serviceName, options.version);
        return;
      }

      // 3. API V1 Service Status Route
      if (url === '/api/v1/health' && method === 'GET') {
        await options.tracer.withSpan('http.get_health', async () => {
          const result = await healthUseCase.execute({});
          if (!result.ok) {
            handleHttpError(res, result.error, context);
            return;
          }

          const responsePayload: ApiResponse<typeof result.value> = {
            success: true,
            data: result.value,
            meta: {
              timestamp: new Date().toISOString(),
              correlationId: context.correlationId,
              executionTimeMs: Date.now() - context.startTime,
            },
          };

          res.writeHead(HttpStatus.OK, {
            'Content-Type': 'application/json; charset=utf-8',
          });
          res.end(JSON.stringify(responsePayload));
        });
        return;
      }

      // 4. Route Not Found
      res.writeHead(HttpStatus.NOT_FOUND, {
        'Content-Type': 'application/json; charset=utf-8',
      });
      res.end(
        JSON.stringify({
          success: false,
          error: {
            code: 'NOT_FOUND',
            message: `Route '${url}' not found`,
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
