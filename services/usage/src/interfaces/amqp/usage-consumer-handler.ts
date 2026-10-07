import type { IngestUsageUseCase } from '../../application/use-cases/ingest-usage.use-case.js';
import type { UsageEventHandler } from '../../application/ports/usage-queue-consumer.port.js';
import type { JsonLogger } from '../../infrastructure/logging/logger.js';
import type { UsageMetrics } from '../../infrastructure/observability/metrics.js';

export function createUsageConsumerHandler(
  ingestUseCase: IngestUsageUseCase,
  metrics?: UsageMetrics | undefined,
  logger?: JsonLogger | undefined,
): UsageEventHandler {
  return async (rawEvent: unknown): Promise<void> => {
    const result = await ingestUseCase.execute(rawEvent);

    if (result.status === 'persisted') {
      metrics?.incrementIngested();
      logger?.debug('Asynchronously ingested usage event', {
        eventId: result.eventId,
        status: result.status,
      });
    } else {
      metrics?.incrementDuplicated();
      logger?.debug('Recognized duplicate usage event during AMQP ingestion', {
        eventId: result.eventId,
        status: result.status,
      });
    }
  };
}
