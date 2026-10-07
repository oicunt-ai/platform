import type { IncomingMessage, ServerResponse } from 'node:http';
import type { CreateReversalParams } from '../../../domain/types.js';
import type { CreateReversalUseCase } from '../../../application/use-cases/create-reversal.use-case.js';
import type {
  RecomputeAggregatesParams,
  RecomputeAggregatesUseCase,
} from '../../../application/use-cases/recompute-aggregates.use-case.js';
import type { UsageMetrics } from '../../../infrastructure/observability/metrics.js';
import type { RequestContext } from '../context.js';
import { readJsonBody, sendJsonResponse } from '../middleware.js';

export class ReversalsController {
  constructor(
    private readonly createReversalUseCase: CreateReversalUseCase,
    private readonly recomputeAggregatesUseCase: RecomputeAggregatesUseCase,
    private readonly metrics?: UsageMetrics | undefined,
  ) {}

  public async handleCreateReversal(
    req: IncomingMessage,
    res: ServerResponse,
    context: RequestContext,
  ): Promise<void> {
    const body = await readJsonBody<CreateReversalParams>(req);
    const params: CreateReversalParams = {
      ...body,
      tenantId: body.tenantId || context.tenantId || '',
    };
    const result = await this.createReversalUseCase.execute(params, context.tenantId);

    if (result.status === 'persisted') {
      this.metrics?.incrementReversals();
    }

    const statusCode = result.status === 'persisted' ? 201 : 200;
    sendJsonResponse(
      res,
      statusCode,
      {
        success: true,
        data: result,
      },
      context,
    );
  }

  public async handleRecomputeAggregates(
    req: IncomingMessage,
    res: ServerResponse,
    context: RequestContext,
  ): Promise<void> {
    const body = await readJsonBody<RecomputeAggregatesParams>(req);
    const params: RecomputeAggregatesParams = {
      ...body,
      tenantId: body.tenantId || context.tenantId || '',
    };
    const result = await this.recomputeAggregatesUseCase.execute(params, context.tenantId);

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
