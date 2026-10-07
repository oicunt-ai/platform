import type { IncomingMessage, ServerResponse } from 'node:http';
import type { BatchIngestUsageUseCase } from '../../../application/use-cases/batch-ingest-usage.use-case.js';
import type { IngestUsageUseCase } from '../../../application/use-cases/ingest-usage.use-case.js';
import type { UsageMetrics } from '../../../infrastructure/observability/metrics.js';
import type { RequestContext } from '../context.js';
import { readJsonBody, sendJsonResponse } from '../middleware.js';

export class IngestionController {
  constructor(
    private readonly ingestUseCase: IngestUsageUseCase,
    private readonly batchIngestUseCase: BatchIngestUsageUseCase,
    private readonly metrics?: UsageMetrics | undefined,
  ) {}

  public async handleIngestEvent(
    req: IncomingMessage,
    res: ServerResponse,
    context: RequestContext,
  ): Promise<void> {
    const body = await readJsonBody(req);
    const result = await this.ingestUseCase.execute(body, {
      authenticatedTenantId: context.tenantId,
      authenticatedService: context.sourceService,
    });

    if (result.status === 'persisted') {
      this.metrics?.incrementIngested();
    } else {
      this.metrics?.incrementDuplicated();
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

  public async handleBatchIngest(
    req: IncomingMessage,
    res: ServerResponse,
    context: RequestContext,
  ): Promise<void> {
    const body = await readJsonBody(req);
    const result = await this.batchIngestUseCase.execute(body, {
      authenticatedTenantId: context.tenantId,
      authenticatedService: context.sourceService,
    });

    if (result.accepted > 0) {
      for (let i = 0; i < result.accepted; i++) {
        this.metrics?.incrementIngested();
      }
    }
    if (result.duplicates > 0) {
      for (let i = 0; i < result.duplicates; i++) {
        this.metrics?.incrementDuplicated();
      }
    }

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
