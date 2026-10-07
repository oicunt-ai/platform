import type { IncomingMessage, ServerResponse } from 'node:http';
import type {
  UsageEventsQuery,
  UsageGranularity,
  UsageSummaryQuery,
  UsageTimeseriesQuery,
} from '../../../domain/types.js';
import type { QueryUsageEventsUseCase } from '../../../application/use-cases/query-usage-events.use-case.js';
import type { QueryUsageSummaryUseCase } from '../../../application/use-cases/query-usage-summary.use-case.js';
import type { QueryUsageTimeseriesUseCase } from '../../../application/use-cases/query-usage-timeseries.use-case.js';
import type { UsageMetrics } from '../../../infrastructure/observability/metrics.js';
import type { RequestContext } from '../context.js';
import { sendJsonResponse } from '../middleware.js';

export class QueriesController {
  constructor(
    private readonly querySummaryUseCase: QueryUsageSummaryUseCase,
    private readonly queryTimeseriesUseCase: QueryUsageTimeseriesUseCase,
    private readonly queryEventsUseCase: QueryUsageEventsUseCase,
    private readonly metrics?: UsageMetrics | undefined,
  ) {}

  public async handleGetSummary(
    req: IncomingMessage,
    res: ServerResponse,
    context: RequestContext,
  ): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const query: UsageSummaryQuery = {
      tenantId: url.searchParams.get('tenantId') ?? context.tenantId ?? '',
      startTime: url.searchParams.get('startTime') ?? '',
      endTime: url.searchParams.get('endTime') ?? '',
      productId: url.searchParams.get('productId') ?? undefined,
      resourceId: url.searchParams.get('resourceId') ?? undefined,
      sourceService: url.searchParams.get('sourceService') ?? undefined,
      operation: url.searchParams.get('operation') ?? undefined,
    };

    const result = await this.querySummaryUseCase.execute(query, context.tenantId);
    this.metrics?.incrementQueries();

    sendJsonResponse(
      res,
      200,
      {
        success: true,
        data: result,
      },
      context,
    );
  }

  public async handleGetTimeseries(
    req: IncomingMessage,
    res: ServerResponse,
    context: RequestContext,
  ): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const query: UsageTimeseriesQuery = {
      tenantId: url.searchParams.get('tenantId') ?? context.tenantId ?? '',
      startTime: url.searchParams.get('startTime') ?? '',
      endTime: url.searchParams.get('endTime') ?? '',
      granularity: (url.searchParams.get('granularity') as UsageGranularity) ?? undefined,
      productId: url.searchParams.get('productId') ?? undefined,
      resourceId: url.searchParams.get('resourceId') ?? undefined,
      sourceService: url.searchParams.get('sourceService') ?? undefined,
      metric: url.searchParams.get('metric') ?? undefined,
    };

    const result = await this.queryTimeseriesUseCase.execute(query, context.tenantId);
    this.metrics?.incrementQueries();

    sendJsonResponse(
      res,
      200,
      {
        success: true,
        data: result,
      },
      context,
    );
  }

  public async handleGetEvents(
    req: IncomingMessage,
    res: ServerResponse,
    context: RequestContext,
  ): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const limitParam = url.searchParams.get('limit');
    const limit = limitParam ? Number.parseInt(limitParam, 10) : undefined;

    const query: UsageEventsQuery = {
      tenantId: url.searchParams.get('tenantId') ?? context.tenantId ?? '',
      correlationId: url.searchParams.get('correlationId') ?? undefined,
      resourceId: url.searchParams.get('resourceId') ?? undefined,
      sourceService: url.searchParams.get('sourceService') ?? undefined,
      operation: url.searchParams.get('operation') ?? undefined,
      startTime: url.searchParams.get('startTime') ?? undefined,
      endTime: url.searchParams.get('endTime') ?? undefined,
      limit,
      cursor: url.searchParams.get('cursor') ?? undefined,
    };

    const result = await this.queryEventsUseCase.execute(query, context.tenantId);
    this.metrics?.incrementQueries();

    sendJsonResponse(
      res,
      200,
      {
        success: true,
        data: result,
      },
      context,
    );
  }
}
