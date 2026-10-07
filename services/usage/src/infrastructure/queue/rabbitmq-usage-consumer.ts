import amqplib from 'amqplib';
import { UsageConnectionError, UsageValidationError } from '../../domain/errors.js';
import type {
  UsageEventHandler,
  UsageQueueConsumerPort,
} from '../../application/ports/usage-queue-consumer.port.js';
import type { JsonLogger } from '../logging/logger.js';

export interface RabbitMqUsageConsumerConfig {
  readonly url?: string | undefined;
  readonly exchange?: string | undefined;
  readonly queue?: string | undefined;
  readonly dlx?: string | undefined;
  readonly dlq?: string | undefined;
  readonly routingKeyPattern?: string | undefined;
  readonly prefetch?: number | undefined;
}

export interface AmqpChannelLike {
  assertExchange(
    exchange: string,
    type: string,
    options?: amqplib.Options.AssertExchange,
  ): Promise<unknown>;
  assertQueue(queue: string, options?: amqplib.Options.AssertQueue): Promise<unknown>;
  bindQueue(queue: string, source: string, pattern: string, args?: unknown): Promise<unknown>;
  prefetch(count: number): Promise<unknown>;
  consume(
    queue: string,
    onMessage: (msg: amqplib.ConsumeMessage | null) => void,
    options?: amqplib.Options.Consume,
  ): Promise<amqplib.Replies.Consume>;
  ack(message: amqplib.Message, allUp?: boolean): void;
  nack(message: amqplib.Message, allUp?: boolean, requeue?: boolean): void;
  close(): Promise<void>;
}

export interface AmqpConnectionLike {
  createChannel(): Promise<AmqpChannelLike>;
  close(): Promise<void>;
}

export class RabbitMqUsageConsumer implements UsageQueueConsumerPort {
  private readonly url: string;
  private readonly exchange: string;
  private readonly queue: string;
  private readonly dlx: string;
  private readonly dlq: string;
  private readonly routingKeyPattern: string;
  private readonly prefetchCount: number;

  private connection: AmqpConnectionLike | null = null;
  private channel: AmqpChannelLike | null = null;
  private isRunning = false;
  private handler: UsageEventHandler | null = null;

  constructor(
    config: RabbitMqUsageConsumerConfig = {},
    customConnection?: AmqpConnectionLike | undefined,
    private readonly logger?: JsonLogger | undefined,
  ) {
    this.url = config.url ?? process.env['RABBITMQ_URL'] ?? 'amqp://guest:guest@localhost:5672';
    this.exchange = config.exchange ?? 'oicunt.usage';
    this.queue = config.queue ?? 'oicunt.usage.events';
    this.dlx = config.dlx ?? 'oicunt.usage.dlx';
    this.dlq = config.dlq ?? 'oicunt.usage.dlq';
    this.routingKeyPattern = config.routingKeyPattern ?? 'usage.v1.#';
    this.prefetchCount = config.prefetch ?? 50;

    if (customConnection) {
      this.connection = customConnection;
    }
  }

  public registerHandler(handler: UsageEventHandler): void {
    this.handler = handler;
  }

  public async start(): Promise<void> {
    if (this.isRunning) {
      return;
    }

    try {
      if (!this.connection) {
        this.connection = (await amqplib.connect(this.url)) as unknown as AmqpConnectionLike;
      }

      this.channel = await this.connection.createChannel();
      await this.channel.prefetch(this.prefetchCount);

      // Dead-Letter Topology
      await this.channel.assertExchange(this.dlx, 'direct', { durable: true });
      await this.channel.assertQueue(this.dlq, { durable: true });
      await this.channel.bindQueue(this.dlq, this.dlx, 'dlq');

      // Primary Exchange & Queue Topology
      await this.channel.assertExchange(this.exchange, 'topic', { durable: true });
      await this.channel.assertQueue(this.queue, {
        durable: true,
        deadLetterExchange: this.dlx,
        deadLetterRoutingKey: 'dlq',
      });
      await this.channel.bindQueue(this.queue, this.exchange, this.routingKeyPattern);

      this.isRunning = true;
      this.logger?.info('RabbitMQ usage consumer initialized and listening', {
        exchange: this.exchange,
        queue: this.queue,
        routingKeyPattern: this.routingKeyPattern,
      });

      await this.channel.consume(
        this.queue,
        async (msg) => {
          if (!msg) {
            return;
          }
          await this.processMessage(msg);
        },
        { noAck: false },
      );
    } catch (err) {
      this.logger?.error('Failed to initialize RabbitMQ usage consumer', {
        error: err instanceof Error ? err.message : String(err),
      });
      throw new UsageConnectionError(
        `Failed to start RabbitMQ consumer: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  public async processMessage(msg: amqplib.ConsumeMessage): Promise<void> {
    if (!this.channel) {
      return;
    }

    let parsedContent: unknown;
    try {
      const rawText = msg.content.toString('utf-8');
      parsedContent = JSON.parse(rawText);
    } catch (_err) {
      // Malformed JSON is permanently unprocessable -> route to DLQ
      this.logger?.warn('Rejecting malformed JSON usage message to DLQ');
      this.channel.nack(msg, false, false);
      return;
    }

    try {
      if (!this.handler) {
        throw new Error('No usage handler registered');
      }

      // Handler validates, persists idempotently, and updates rollups
      await this.handler(parsedContent as unknown as import('../../domain/types.js').UsageEvent);

      // Safe acknowledgement on durable persistence or duplicate recognition
      this.channel.ack(msg);
    } catch (err) {
      if (err instanceof UsageValidationError) {
        // Schema or business rule validation error is permanent -> route to DLQ
        this.logger?.warn('Permanent validation error on usage message; rejecting to DLQ', {
          error: err.message,
        });
        this.channel.nack(msg, false, false);
      } else {
        // Transient error (database, network) -> requeue for retry
        this.logger?.error('Transient error processing usage event; requeueing message', {
          error: err instanceof Error ? err.message : String(err),
        });
        this.channel.nack(msg, false, true);
      }
    }
  }

  public async stop(): Promise<void> {
    this.isRunning = false;
    try {
      if (this.channel) {
        await this.channel.close();
        this.channel = null;
      }
      if (this.connection) {
        await this.connection.close();
        this.connection = null;
      }
    } catch {
      // Ignore errors on close
    }
  }
}
