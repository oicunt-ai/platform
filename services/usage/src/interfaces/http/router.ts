import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DatabasePool } from '../../infrastructure/database/connection.js';
import type { JsonLogger } from '../../infrastructure/logging/logger.js';
import type { UsageQueueConsumerPort } from '../../application/ports/usage-queue-consumer.port.js';
import { isHealthCheckPath, validateInternalToken } from './auth.js';
import { extractRequestContext } from './context.js';
import { handleLiveness, handleReadiness } from './health.js';
import { sendErrorResponse } from './middleware.js';
import type {
  IngestionController,
  QueriesController,
  ReversalsController,
  AdmissionController,
} from './controllers/index.js';

export interface RouterDependencies {
  readonly ingestionController: IngestionController;
  readonly queriesController: QueriesController;
  readonly reversalsController: ReversalsController;
  readonly admissionController?: AdmissionController | undefined;
  readonly dbPool: DatabasePool | null;
  readonly queueConsumer?: UsageQueueConsumerPort | null | undefined;
  readonly internalToken?: string | undefined;
  readonly logger?: JsonLogger | undefined;
}

export function createHttpRouter(deps: RouterDependencies) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const pathname = url.pathname;
    const method = req.method?.toUpperCase();

    // Health endpoints bypass authentication
    if (isHealthCheckPath(pathname)) {
      if (pathname === '/healthz' || pathname === '/health/liveness') {
        await handleLiveness(res);
        return;
      }
      if (pathname === '/readyz' || pathname === '/health/readiness') {
        await handleReadiness(res, deps.dbPool, deps.queueConsumer?.isReady?.() ?? true);
        return;
      }
    }

    const context = extractRequestContext(req, res);

    try {
      validateInternalToken(req, deps.internalToken);

      if (method === 'POST' && pathname === '/internal/v1/usage/admissions') {
        if (!deps.admissionController) throw new Error('Admission control requires PostgreSQL');
        await deps.admissionController.acquire(req, res, context);
        return;
      }

      if (method === 'POST' && pathname === '/internal/v1/usage/admissions/release') {
        if (!deps.admissionController) throw new Error('Admission control requires PostgreSQL');
        await deps.admissionController.release(req, res, context);
        return;
      }

      // Ingestion routes
      if (method === 'POST' && pathname === '/internal/v1/usage/events') {
        await deps.ingestionController.handleIngestEvent(req, res, context);
        return;
      }

      if (method === 'POST' && pathname === '/internal/v1/usage/events/batch') {
        await deps.ingestionController.handleBatchIngest(req, res, context);
        return;
      }

      // Query routes
      if (method === 'GET' && pathname === '/internal/v1/usage/summary') {
        await deps.queriesController.handleGetSummary(req, res, context);
        return;
      }

      if (method === 'GET' && pathname === '/internal/v1/usage/timeseries') {
        await deps.queriesController.handleGetTimeseries(req, res, context);
        return;
      }

      if (method === 'GET' && pathname === '/internal/v1/usage/events') {
        await deps.queriesController.handleGetEvents(req, res, context);
        return;
      }

      // Reversal and aggregate maintenance routes
      if (method === 'POST' && pathname === '/internal/v1/usage/reversals') {
        await deps.reversalsController.handleCreateReversal(req, res, context);
        return;
      }

      if (method === 'POST' && pathname === '/internal/v1/usage/aggregates/recompute') {
        await deps.reversalsController.handleRecomputeAggregates(req, res, context);
        return;
      }

      // 404 for unknown endpoints
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          success: false,
          error: {
            code: 'NOT_FOUND',
            message: `Route '${method} ${pathname}' not found`,
          },
        }),
      );
    } catch (err: unknown) {
      deps.logger?.error('Error handling Usage HTTP request', {
        error: err instanceof Error ? err.message : String(err),
        pathname,
        method,
        correlationId: context.correlationId,
      });
      sendErrorResponse(res, err, context);
    }
  };
}
