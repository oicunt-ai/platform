import { createServer, type Server } from 'node:http';
import { loadUsageConfig, type UsageConfig } from './config.js';
import type { UsageRepositoryPort } from './application/ports/usage-repository.port.js';
import type { UsageQueueConsumerPort } from './application/ports/usage-queue-consumer.port.js';
import {
  BatchIngestUsageUseCase,
  CreateReversalUseCase,
  IngestUsageUseCase,
  QueryUsageEventsUseCase,
  QueryUsageSummaryUseCase,
  QueryUsageTimeseriesUseCase,
  RecomputeAggregatesUseCase,
} from './application/use-cases/index.js';
import { DatabasePool } from './infrastructure/database/connection.js';
import { DatabaseMigrator } from './infrastructure/database/migrator.js';
import { JsonLogger } from './infrastructure/logging/logger.js';
import { UsageMetrics } from './infrastructure/observability/metrics.js';
import { InMemoryUsageRepository } from './infrastructure/repositories/in-memory-usage.repository.js';
import { PostgresUsageRepository } from './infrastructure/repositories/postgres-usage.repository.js';
import { RabbitMqUsageConsumer } from './infrastructure/queue/rabbitmq-usage-consumer.js';
import { InMemoryUsageQueue } from './infrastructure/queue/in-memory-usage-queue.js';
import {
  IngestionController,
  QueriesController,
  ReversalsController,
  AdmissionController,
} from './interfaces/http/controllers/index.js';
import { createHttpRouter } from './interfaces/http/router.js';
import { createUsageConsumerHandler } from './interfaces/amqp/usage-consumer-handler.js';

export interface UsageServiceDependencies {
  readonly repository?: UsageRepositoryPort | undefined;
  readonly queueConsumer?: UsageQueueConsumerPort | undefined;
  readonly dbPool?: DatabasePool | undefined;
  readonly logger?: JsonLogger | undefined;
  readonly metrics?: UsageMetrics | undefined;
}

export class UsageService {
  public readonly config: UsageConfig;
  public readonly logger: JsonLogger;
  public readonly metrics: UsageMetrics;

  public readonly dbPool: DatabasePool | null;
  public readonly repository: UsageRepositoryPort;
  public readonly queueConsumer: UsageQueueConsumerPort | null;

  public readonly ingestUsageUseCase: IngestUsageUseCase;
  public readonly batchIngestUsageUseCase: BatchIngestUsageUseCase;
  public readonly queryUsageSummaryUseCase: QueryUsageSummaryUseCase;
  public readonly queryUsageTimeseriesUseCase: QueryUsageTimeseriesUseCase;
  public readonly queryUsageEventsUseCase: QueryUsageEventsUseCase;
  public readonly createReversalUseCase: CreateReversalUseCase;
  public readonly recomputeAggregatesUseCase: RecomputeAggregatesUseCase;

  public readonly ingestionController: IngestionController;
  public readonly queriesController: QueriesController;
  public readonly reversalsController: ReversalsController;

  private server: Server | null = null;
  private isRunning = false;

  constructor(
    configOverrides: Partial<UsageConfig> = {},
    customDeps: UsageServiceDependencies = {},
  ) {
    this.config = loadUsageConfig(configOverrides);
    this.logger = customDeps.logger ?? new JsonLogger(this.config.logLevel);
    this.metrics = customDeps.metrics ?? new UsageMetrics();

    // Database initialization
    if (customDeps.repository) {
      this.repository = customDeps.repository;
      this.dbPool = customDeps.dbPool ?? null;
    } else if (this.config.useDatabase) {
      this.dbPool = customDeps.dbPool ?? new DatabasePool(this.config.database);
      this.repository = new PostgresUsageRepository(this.dbPool);
    } else {
      this.dbPool = null;
      this.repository = new InMemoryUsageRepository();
    }

    // Queue initialization
    if (customDeps.queueConsumer !== undefined) {
      this.queueConsumer = customDeps.queueConsumer;
    } else if (this.config.useRabbitMq) {
      this.queueConsumer = new RabbitMqUsageConsumer(
        {
          url: this.config.rabbitmqUrl,
          exchange: this.config.rabbitmqExchange,
          queue: this.config.rabbitmqQueue,
          dlx: this.config.rabbitmqDlx,
          dlq: this.config.rabbitmqDlq,
          routingKeyPattern: this.config.rabbitmqRoutingKeyPattern,
          prefetch: this.config.rabbitmqPrefetch,
        },
        undefined,
        this.logger,
      );
    } else {
      this.queueConsumer = new InMemoryUsageQueue();
    }

    // Use cases
    this.ingestUsageUseCase = new IngestUsageUseCase(this.repository);
    this.batchIngestUsageUseCase = new BatchIngestUsageUseCase(this.repository);
    this.queryUsageSummaryUseCase = new QueryUsageSummaryUseCase(this.repository);
    this.queryUsageTimeseriesUseCase = new QueryUsageTimeseriesUseCase(this.repository);
    this.queryUsageEventsUseCase = new QueryUsageEventsUseCase(this.repository);
    this.createReversalUseCase = new CreateReversalUseCase(this.repository);
    this.recomputeAggregatesUseCase = new RecomputeAggregatesUseCase(this.repository);

    // Controllers
    this.ingestionController = new IngestionController(
      this.ingestUsageUseCase,
      this.batchIngestUsageUseCase,
      this.metrics,
    );
    this.queriesController = new QueriesController(
      this.queryUsageSummaryUseCase,
      this.queryUsageTimeseriesUseCase,
      this.queryUsageEventsUseCase,
      this.metrics,
    );
    this.reversalsController = new ReversalsController(
      this.createReversalUseCase,
      this.recomputeAggregatesUseCase,
      this.metrics,
    );
  }

  public async start(): Promise<void> {
    if (this.isRunning) {
      return;
    }

    // 1. Run migrations if PostgreSQL is active
    if (this.dbPool) {
      try {
        const migrator = new DatabaseMigrator(this.dbPool);
        const result = await migrator.runMigrations();
        this.logger.info('Database migrations completed', {
          appliedCount: result.applied.length,
          alreadyAppliedCount: result.alreadyApplied.length,
        });
      } catch (err) {
        this.logger.error('Failed to run database migrations', {
          error: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }
    }

    // 2. Start AMQP queue consumer if enabled
    if (this.queueConsumer) {
      const consumerHandler = createUsageConsumerHandler(
        this.ingestUsageUseCase,
        this.metrics,
        this.logger,
      );
      this.queueConsumer.registerHandler(consumerHandler);
      await this.queueConsumer.start();
      this.logger.info('AMQP usage consumer started');
    }

    // 3. Start HTTP server
    const router = createHttpRouter({
      ingestionController: this.ingestionController,
      queriesController: this.queriesController,
      reversalsController: this.reversalsController,
      admissionController: this.dbPool
        ? new AdmissionController(this.dbPool, {
            tenantRequestsPerMinute: this.config.tenantRequestsPerMinute,
            userRequestsPerMinute: this.config.userRequestsPerMinute,
            tenantConcurrentStreams: this.config.tenantConcurrentStreams,
            leaseSeconds: this.config.admissionLeaseSeconds,
          })
        : undefined,
      dbPool: this.dbPool,
      queueConsumer: this.queueConsumer,
      internalToken: this.config.internalToken,
      logger: this.logger,
    });

    this.server = createServer(router);

    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(this.config.port, this.config.host, () => {
        this.server!.removeListener('error', reject);
        this.logger.info(
          `Usage & Metering Service listening on http://${this.config.host}:${this.config.port}`,
        );
        resolve();
      });
    });

    this.isRunning = true;
  }

  public async stop(): Promise<void> {
    if (!this.isRunning) {
      return;
    }

    this.logger.info('Stopping Usage & Metering Service...');

    // Stop queue consumer
    if (this.queueConsumer) {
      await this.queueConsumer.stop();
    }

    // Close HTTP server
    if (this.server) {
      await new Promise<void>((resolve) => {
        this.server!.close(() => resolve());
      });
      this.server = null;
    }

    // Close database pool
    if (this.dbPool) {
      await this.dbPool.close();
    }

    this.isRunning = false;
    this.logger.info('Usage & Metering Service stopped cleanly');
  }

  public getHttpServer(): Server | null {
    return this.server;
  }
}
