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
  /** Maximum delivery attempts per event (initial + retries). Defaults to 5. */
  readonly maxAttempts?: number | undefined;
  /** First reconnect delay after connection loss. Defaults to 1000ms. */
  readonly reconnectInitialMs?: number | undefined;
  /** Upper bound for reconnect delays. Defaults to 30000ms. */
  readonly reconnectMaxMs?: number | undefined;
  /** Upper bound for stop() to wait for in-flight messages. Defaults to 10000ms. */
  readonly shutdownTimeoutMs?: number | undefined;
  /** Upper bound for a single broker publish confirmation. Defaults to 10000ms. */
  readonly confirmTimeoutMs?: number | undefined;
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
  publish(
    exchange: string,
    routingKey: string,
    content: Buffer,
    options?: amqplib.Options.Publish,
  ): boolean;
  waitForConfirms(): Promise<void>;
  ack(message: amqplib.Message, allUp?: boolean): void;
  nack(message: amqplib.Message, allUp?: boolean, requeue?: boolean): void;
  close(): Promise<void>;
  on(event: 'return', listener: (msg: AmqpReturnMessage) => void): void;
  on(event: string, listener: () => void): void;
}

export interface AmqpReturnMessage {
  readonly fields?: { readonly replyText?: unknown } | undefined;
  readonly properties?: { readonly messageId?: unknown } | undefined;
}

export interface AmqpConnectionLike {
  createConfirmChannel(): Promise<AmqpChannelLike>;
  close(): Promise<void>;
  on(event: string, listener: (...args: never[]) => void): void;
}

export type AmqpConnectFn = (url: string) => Promise<AmqpConnectionLike>;

/**
 * Header carrying the explicit retry-attempt count on redelivered usage
 * messages. Validated on read: missing or malformed values mean attempt 0
 * (process normally), never a rejection â€” the payload may be billable.
 */
export const RETRY_ATTEMPT_HEADER = 'x-usage-attempts';

export interface RetryTier {
  readonly queue: string;
  readonly ttlMs: number;
}

/**
 * Dead-letter routing key stamped on every retry tier. On TTL expiry the
 * broker republishes to the main exchange with THIS key (not the tier
 * queue name the retry copy was published with). `usage.v1.retry` matches
 * the existing `usage.v1.#` topic binding, so no new bindings are needed
 * for retries to return to `oicunt.usage.events`.
 */
export const RETRY_DEAD_LETTER_ROUTING_KEY = 'usage.v1.retry';

/**
 * Fixed-delay retry tiers. Each tier has ONE uniform TTL, so no queue ever
 * holds mixed per-message TTLs (no head-of-line blocking). Tiers are
 * quorum queues (durable by definition): on TTL expiry the broker moves
 * the message to the main exchange with at-least-once dead-letter
 * semantics, stamped with RETRY_DEAD_LETTER_ROUTING_KEY above. Attempt N
 * uses tier min(N, tiers.length - 1).
 */
export const RETRY_TIERS: readonly RetryTier[] = [
  { queue: 'oicunt.usage.retry.5s', ttlMs: 5000 },
  { queue: 'oicunt.usage.retry.30s', ttlMs: 30000 },
  { queue: 'oicunt.usage.retry.5m', ttlMs: 300000 },
];

/** Guard against a deterministically broken retry-publish path. */
const MAX_CONSECUTIVE_RETRY_PUBLISH_FAILURES = 10;

interface PendingPublish {
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
}

/** Reason recorded on explicitly DLQ-published copies for operator review. */
export type DlqReason =
  'malformed_json' | 'no_handler' | 'validation' | 'retries_exhausted' | 'retry_publish_overflow';

export const DLQ_REASON_HEADER = 'x-usage-dlq-reason';

/**
 * The broker positively refused to route a mandatory-published copy
 * (basic.return). Retrying the identical publish cannot succeed while the
 * destination is missing: callers must fall back, never spin.
 */
export class UsageUnroutableError extends Error {
  public readonly key: string;
  constructor(key: string, replyText: string) {
    super(`Message ${key} was returned unroutable by the broker: ${replyText}`);
    this.name = 'UsageUnroutableError';
    this.key = key;
  }
}

export function parseRetryAttempts(msg: amqplib.ConsumeMessage): number {
  const raw = msg.properties?.headers?.[RETRY_ATTEMPT_HEADER];
  if (isValidAttemptHeader(raw)) {
    return typeof raw === 'number' ? raw : Number.parseInt(raw.trim(), 10);
  }
  return 0;
}

function isValidAttemptHeader(raw: unknown): raw is number | string {
  if (typeof raw === 'number') {
    return Number.isInteger(raw) && raw >= 0;
  }
  return typeof raw === 'string' && /^\d+$/.test(raw.trim());
}

export function tierForAttempt(attempt: number): RetryTier {
  return RETRY_TIERS[Math.min(attempt, RETRY_TIERS.length - 1)]!;
}

export class RabbitMqUsageConsumer implements UsageQueueConsumerPort {
  /** Undefined when unconfigured: there is no implicit guest@localhost broker. */
  private readonly url: string | undefined;
  private readonly exchange: string;
  private readonly queue: string;
  private readonly dlx: string;
  private readonly dlq: string;
  private readonly routingKeyPattern: string;
  private readonly prefetchCount: number;
  private readonly maxAttempts: number;
  private readonly reconnectInitialMs: number;
  private readonly reconnectMaxMs: number;
  private readonly shutdownTimeoutMs: number;
  private readonly confirmTimeoutMs: number;
  private readonly connectFn: AmqpConnectFn;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;

  private connection: AmqpConnectionLike | null = null;
  private channel: AmqpChannelLike | null = null;
  private consumerTag: string | null = null;
  private isRunning = false;
  private handler: UsageEventHandler | null = null;
  private reconnectAttempt = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private inFlight = 0;
  private consecutiveRetryPublishFailures = 0;
  private readonly injectedConnection: AmqpConnectionLike | null;
  /** Serializes direct publishes so each confirm/return correlates exactly. */
  private publishChain: Promise<void> = Promise.resolve();
  /** Outstanding mandatory publishes awaiting confirm or return, by messageId. */
  private readonly pendingReturns: Map<string, PendingPublish> = new Map();
  /** Fallback correlation ids for copies without a messageId. */
  private publishNonce = 0;

  constructor(
    config: RabbitMqUsageConsumerConfig = {},
    customConnection?: AmqpConnectionLike | undefined,
    private readonly logger?: JsonLogger | undefined,
    dependencies?: {
      readonly connect?: AmqpConnectFn | undefined;
      readonly sleep?: ((ms: number) => Promise<void>) | undefined;
      readonly random?: (() => number) | undefined;
    },
  ) {
    const envUrl = process.env['RABBITMQ_URL']?.trim();
    this.url = config.url ?? (envUrl === undefined || envUrl === '' ? undefined : envUrl);
    this.exchange = config.exchange ?? 'oicunt.usage';
    this.queue = config.queue ?? 'oicunt.usage.events';
    this.dlx = config.dlx ?? 'oicunt.usage.dlx';
    this.dlq = config.dlq ?? 'oicunt.usage.dlq';
    this.routingKeyPattern = config.routingKeyPattern ?? 'usage.v1.#';
    this.prefetchCount = config.prefetch ?? 50;
    this.maxAttempts = config.maxAttempts ?? 5;
    this.reconnectInitialMs = config.reconnectInitialMs ?? 1000;
    this.reconnectMaxMs = config.reconnectMaxMs ?? 30000;
    this.shutdownTimeoutMs = config.shutdownTimeoutMs ?? 10000;
    this.confirmTimeoutMs = config.confirmTimeoutMs ?? 10000;
    this.connectFn =
      dependencies?.connect ??
      (async (url: string) => (await amqplib.connect(url)) as unknown as AmqpConnectionLike);
    this.sleep =
      dependencies?.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.random = dependencies?.random ?? Math.random;

    this.injectedConnection = customConnection ?? null;
    if (customConnection) {
      this.connection = customConnection;
    }
  }

  /**
   * Truthful readiness: true only while running with a live channel AND an
   * established broker subscription. Never true before consume() resolves
   * and never stale-true after a drop.
   */
  public isReady(): boolean {
    return this.isRunning && this.channel !== null && this.consumerTag !== null;
  }

  public registerHandler(handler: UsageEventHandler): void {
    this.handler = handler;
  }

  public async start(): Promise<void> {
    if (this.isRunning) {
      return;
    }
    if (!this.connection) {
      if (!this.url) {
        // Fail closed: never guess a broker, and never fall back to a
        // hardcoded guest@localhost endpoint.
        throw new UsageConnectionError(
          'RabbitMQ URL is not configured (set RABBITMQ_URL to an amqp:// or amqps:// URL)',
        );
      }
      this.connection = await this.connectFn(this.url);
      this.watchConnection(this.connection);
    }
    this.isRunning = true;
    this.reconnectAttempt = 0;
    await this.establish();
  }

  /**
   * Establishes channel, topology, and subscription. Called at startup and
   * after every reconnect. Throws on failure so start() stays fail-closed;
   * runtime drops schedule a reconnect instead (see onConnectionLost).
   */
  private async establish(): Promise<void> {
    if (!this.connection) {
      throw new UsageConnectionError('RabbitMQ connection is not available');
    }
    const channel = await this.connection.createConfirmChannel();
    this.channel = channel;
    this.consumerTag = null;
    channel.on('close', () => this.onConnectionLost('channel closed'));
    channel.on('error', () => this.onConnectionLost('channel error'));
    channel.on('return', (returned) => this.onBrokerReturn(returned));
    await channel.prefetch(this.prefetchCount);

    // Dead-Letter Topology (unchanged from the original deployment).
    await channel.assertExchange(this.dlx, 'direct', { durable: true });
    await channel.assertQueue(this.dlq, { durable: true });
    await channel.bindQueue(this.dlq, this.dlx, 'dlq');

    // Primary Exchange & Queue Topology (unchanged).
    await channel.assertExchange(this.exchange, 'topic', { durable: true });
    await channel.assertQueue(this.queue, {
      durable: true,
      deadLetterExchange: this.dlx,
      deadLetterRoutingKey: 'dlq',
    });
    await channel.bindQueue(this.queue, this.exchange, this.routingKeyPattern);

    // Bounded-delay retry tiers. Each tier is a durable quorum queue with
    // ONE fixed TTL (no mixed per-message TTLs, hence no head-of-line
    // blocking). RabbitMQ 3.13 prerequisites for recoverable dead-letter
    // transfer (see docs/development.md): x-queue-type quorum,
    // x-dead-letter-strategy at-least-once (quorum type alone only gives
    // at-most-once), x-overflow reject-publish, a valid dead-letter
    // exchange + routing key, and the broker's stream_queue feature flag.
    // The stamped RETRY_DEAD_LETTER_ROUTING_KEY matches the existing
    // usage.v1.# binding, so retries return to the main queue with no new
    // bindings. These queues are greenfield (first declared by this
    // build): no live queue changes type. Tier queues need no bindings of
    // their own: the consumer publishes to them via the default exchange
    // addressed by queue name.
    for (const tier of RETRY_TIERS) {
      await channel.assertQueue(tier.queue, {
        durable: true,
        messageTtl: tier.ttlMs,
        deadLetterExchange: this.exchange,
        deadLetterRoutingKey: RETRY_DEAD_LETTER_ROUTING_KEY,
        arguments: {
          'x-queue-type': 'quorum',
          'x-dead-letter-strategy': 'at-least-once',
          'x-overflow': 'reject-publish',
        },
      });
    }

    const consumeResult = await channel.consume(
      this.queue,
      (msg) => {
        if (!msg) {
          return;
        }
        void this.processMessageGuarded(msg);
      },
      { noAck: false },
    );
    this.consumerTag = consumeResult.consumerTag;

    this.logger?.info('RabbitMQ usage consumer initialized and listening', {
      exchange: this.exchange,
      queue: this.queue,
      routingKeyPattern: this.routingKeyPattern,
      maxAttempts: this.maxAttempts,
    });
  }

  /**
   * Never lets a handler rejection escape as an unhandled rejection: the
   * broker ignores the returned promise, Node does not.
   */
  private async processMessageGuarded(msg: amqplib.ConsumeMessage): Promise<void> {
    try {
      await this.processMessage(msg);
    } catch (err) {
      this.logger?.error('Usage message processing failed without settlement', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private watchConnection(connection: AmqpConnectionLike): void {
    connection.on('close', () => this.onConnectionLost('connection closed'));
    connection.on('error', () => this.onConnectionLost('connection error'));
  }

  private onConnectionLost(reason: string): void {
    if (this.channel !== null || this.connection !== null) {
      this.logger?.warn(`RabbitMQ usage consumer connection lost: ${reason}`);
    }
    // In-flight direct publishes become uncertain: fail them as retryable
    // now instead of leaving them parked (their confirm waits reject on
    // close as well; single-take settlement below makes double-settlement
    // safe).
    for (const key of [...this.pendingReturns.keys()]) {
      this.settlePending(key, (entry) =>
        entry.reject(new UsageConnectionError(`Broker connection lost during publish: ${reason}`)),
      );
    }
    // In-flight messages stay unacked; the broker requeues them on channel
    // close and redelivers after reconnect (duplicates collapse downstream
    // via the idempotency constraint).
    this.channel = null;
    this.consumerTag = null;
    if (!this.isRunning) {
      return;
    }
    this.scheduleReconnect();
  }

  /** Single-flight reconnect with capped exponential backoff and jitter. */
  private scheduleReconnect(): void {
    if (!this.isRunning || this.reconnectTimer !== null) {
      return;
    }
    this.reconnectAttempt += 1;
    const capped = Math.min(
      this.reconnectMaxMs,
      this.reconnectInitialMs * Math.pow(2, this.reconnectAttempt - 1),
    );
    const delayMs = Math.floor(capped * (0.5 + this.random() * 0.5));
    this.logger?.warn('Scheduling RabbitMQ usage consumer reconnect', {
      attempt: this.reconnectAttempt,
      delayMs,
    });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.isRunning) {
        return;
      }
      void this.reconnect();
    }, delayMs);
    this.reconnectTimer.unref?.();
  }

  private async reconnect(): Promise<void> {
    if (!this.isRunning || !this.url) {
      return;
    }
    try {
      this.connection = await this.connectFn(this.url);
      this.watchConnection(this.connection);
      await this.establish();
      this.reconnectAttempt = 0;
      this.logger?.info('RabbitMQ usage consumer reconnected');
    } catch (err) {
      this.logger?.error('RabbitMQ usage consumer reconnect failed; backing off', {
        error: err instanceof Error ? err.message : String(err),
      });
      this.scheduleReconnect();
    }
  }

  public async processMessage(msg: amqplib.ConsumeMessage): Promise<void> {
    const channel = this.channel;
    if (!channel) {
      // No live channel (mid-reconnect): leave the message unacked so the
      // broker requeues it on close. Never ack or drop what we did not
      // process.
      return;
    }
    this.inFlight += 1;
    try {
      let parsedContent: unknown;
      try {
        const rawText = msg.content.toString('utf-8');
        parsedContent = JSON.parse(rawText);
      } catch (_err) {
        // Malformed JSON is permanently unprocessable -> route to DLQ
        this.logger?.warn('Rejecting malformed JSON usage message to DLQ');
        await this.rejectToDlq(channel, msg, 'malformed_json');
        return;
      }

      try {
        if (!this.handler) {
          // Configuration error, not a transient failure: route directly
          // to the DLQ where it stays visible instead of cycling retries.
          this.logger?.error('No usage handler registered; rejecting message to DLQ');
          await this.rejectToDlq(channel, msg, 'no_handler');
          return;
        }

        // Handler validates, persists idempotently, and updates rollups
        await this.handler(parsedContent as unknown as import('../../domain/types.js').UsageEvent);
        this.consecutiveRetryPublishFailures = 0;

        // Safe acknowledgement on durable persistence or duplicate recognition
        this.settle(() => this.channel?.ack(msg));
      } catch (err) {
        if (err instanceof UsageValidationError) {
          // Schema or business rule validation error is permanent -> route to DLQ
          this.logger?.warn('Permanent validation error on usage message; rejecting to DLQ', {
            error: err.message,
          });
          await this.rejectToDlq(channel, msg, 'validation');
        } else {
          await this.handleTransientFailure(channel, msg, err);
        }
      }
    } finally {
      this.inFlight -= 1;
    }
  }

  /**
   * Single-take settlement for an outstanding mandatory publish: exactly
   * one of confirm, return, timeout, or connection loss wins. Returns false
   * when another path already settled the entry.
   */
  private settlePending(key: string, fn: (entry: PendingPublish) => void): boolean {
    const entry = this.pendingReturns.get(key);
    if (!entry) {
      return false;
    }
    this.pendingReturns.delete(key);
    fn(entry);
    return true;
  }

  /**
   * Correlates broker basic.return events to the in-flight mandatory
   * publish with the same messageId. A return is POSITIVE proof of
   * non-delivery: the copy will never arrive, so its waiter rejects
   * immediately instead of waiting out the confirm timeout. Returns for
   * already-settled (or unknown) ids are logged loudly — with serialized
   * publishes they indicate a broker anomaly, never a normal outcome.
   */
  private onBrokerReturn(returned: AmqpReturnMessage): void {
    const rawId = returned.properties?.messageId;
    const key = typeof rawId === 'string' ? rawId : null;
    const replyText =
      typeof returned.fields?.replyText === 'string' ? returned.fields.replyText : 'unroutable';
    if (key === null) {
      this.logger?.error('Broker returned a message without a messageId; cannot correlate', {
        replyText,
      });
      return;
    }
    const settled = this.settlePending(key, (entry) =>
      entry.reject(new UsageUnroutableError(key, replyText)),
    );
    if (!settled) {
      this.logger?.error('Broker return arrived for an already-settled publish', {
        messageId: key,
        replyText,
      });
    }
  }

  /**
   * Direct mandatory publish (retry tiers, DLQ) serialized through one
   * promise chain so each broker confirm/return correlates to exactly one
   * copy. Resolves only after the broker CONFIRMS; rejects with
   * UsageUnroutableError on basic.return (permanent) or UsageConnectionError
   * on timeout/close/failure (retryable, original identity preserved).
   */
  private async publishDirect(
    channel: AmqpChannelLike,
    routingKey: string,
    msg: amqplib.ConsumeMessage,
    extraHeaders: Record<string, unknown>,
  ): Promise<void> {
    const run = this.publishChain.then(() =>
      this.publishOne(channel, routingKey, msg, extraHeaders),
    );
    // The chain itself must never reject, or later publishes stall forever.
    this.publishChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async publishOne(
    channel: AmqpChannelLike,
    routingKey: string,
    msg: amqplib.ConsumeMessage,
    extraHeaders: Record<string, unknown>,
  ): Promise<void> {
    const rawId = msg.properties?.messageId;
    const key =
      typeof rawId === 'string' && rawId !== '' ? rawId : `noid-${(this.publishNonce += 1)}`;
    const publishOptions: amqplib.Options.Publish = {
      persistent: true,
      contentType: msg.properties?.contentType ?? 'application/json',
      headers: { ...(msg.properties?.headers ?? {}), ...extraHeaders },
      mandatory: true,
    };
    // Optional properties are set only when present: exactOptionalPropertyTypes
    // forbids explicit undefined, and messageId absence is preserved (the
    // fallback nonce above is correlation-only, never written back).
    if (typeof rawId === 'string') {
      publishOptions.messageId = rawId;
    }
    const correlationId = msg.properties?.correlationId;
    if (typeof correlationId === 'string') {
      publishOptions.correlationId = correlationId;
    }
    return new Promise<void>((resolve, reject) => {
      this.pendingReturns.set(key, { resolve, reject });
      let published: boolean;
      try {
        published = channel.publish('', routingKey, msg.content, publishOptions);
      } catch (error) {
        this.settlePending(key, (entry) =>
          entry.reject(
            new UsageConnectionError(
              `Retry publish call failed: ${error instanceof Error ? error.message : String(error)}`,
            ),
          ),
        );
        return;
      }
      if (!published) {
        this.settlePending(key, () =>
          reject(new UsageConnectionError('Retry publish buffer is full')),
        );
        return;
      }
      const timer = setTimeout(() => {
        this.settlePending(key, () =>
          reject(
            new UsageConnectionError(
              `Broker confirmation timed out after ${this.confirmTimeoutMs}ms (delivery uncertain)`,
            ),
          ),
        );
      }, this.confirmTimeoutMs);
      // Never hold the process open for a confirmation wait: explicit
      // close() and bounded shutdown own lifecycle instead.
      timer.unref?.();
      void channel.waitForConfirms().then(
        () => {
          clearTimeout(timer);
          this.settlePending(key, (entry) => entry.resolve());
        },
        (error: unknown) => {
          clearTimeout(timer);
          this.settlePending(key, (entry) =>
            entry.reject(
              new UsageConnectionError(
                `Broker confirmation failed: ${error instanceof Error ? error.message : String(error)}`,
              ),
            ),
          );
        },
      );
    });
  }

  /**
   * Verifiable DLQ transfer: publishes the byte-identical message directly
   * to the durable DLQ with mandatory routing and waits for the broker
   * confirm before acking the original. The classic main queue's ordinary
   * DLX hop is deliberately NOT used as a fallback: a classic-queue
   * dead-letter transfer is not guaranteed at-least-once, so an
   * unconfirmed fallback would claim preservation it cannot prove.
   *
   * If confirmed DLQ publication fails (unroutable destination, timeout,
   * channel loss), the original is NEVER acked and NEVER permanently
   * rejected: preserveForRedelivery closes the channel so the broker
   * requeues it, and bounded reconnect/backoff paces redelivery without
   * hot loops. Consumer health degrades (isReady false) until recovery,
   * with loud error logs. When the DLQ destination becomes available
   * again (operator fix, or the reconnect's topology reassertion healing
   * a deleted DLQ), the redelivered message completes the transfer.
   * A duplicate DLQ copy after a timed-out-but-delivered publish is
   * acceptable: the DLQ is an operator-review queue, not a billing input.
   */
  private async rejectToDlq(
    channel: AmqpChannelLike,
    msg: amqplib.ConsumeMessage,
    reason: DlqReason,
  ): Promise<void> {
    try {
      await this.publishDirect(channel, this.dlq, msg, { [DLQ_REASON_HEADER]: reason });
    } catch (err) {
      this.logger?.error(
        'Confirmed DLQ publication failed; preserving message for redelivery instead of an unverifiable dead-letter hop',
        {
          reason,
          error: err instanceof Error ? err.message : String(err),
        },
      );
      await this.preserveForRedelivery(channel, reason, err);
      return;
    }
    this.settle(() => this.channel?.ack(msg));
  }

  /**
   * Preservation path for messages that cannot be verifiably delivered to
   * the DLQ. Closes the channel so the broker requeues every unacked
   * message (including this one, byte-identical with its original
   * identity), then relies on the bounded reconnect loop: redelivery is
   * paced by reconnect backoff, never a hot loop, and the reconnect's
   * topology reassertion heals a deleted destination automatically.
   * Degraded health is reported via isReady (false until resubscribed).
   */
  private async preserveForRedelivery(
    channel: AmqpChannelLike,
    reason: DlqReason,
    error: unknown,
  ): Promise<void> {
    this.logger?.error(
      'DLQ destination unavailable; closing channel to preserve message for redelivery',
      {
        reason,
        error: error instanceof Error ? error.message : String(error),
      },
    );
    try {
      await channel.close();
    } catch {
      // Already gone: the close event (or its absence on a dead channel)
      // converges on the same outcome — unacked messages requeue.
    }
    // Ensure recovery is scheduled even if the close event never fires
    // (dead channel object): scheduleReconnect is single-flight guarded.
    this.scheduleReconnect();
  }

  /**
   * Bounded durable retry: republish the byte-identical payload to the tier
   * queue for this attempt, wait for the broker confirm, then ack the
   * original. The original is NEVER acked before the retry copy confirms.
   */
  private async handleTransientFailure(
    channel: AmqpChannelLike,
    msg: amqplib.ConsumeMessage,
    err: unknown,
  ): Promise<void> {
    const attempts = parseRetryAttempts(msg);
    if (
      msg.properties?.headers?.[RETRY_ATTEMPT_HEADER] !== undefined &&
      !isValidAttemptHeader(msg.properties.headers[RETRY_ATTEMPT_HEADER])
    ) {
      this.logger?.warn('Ignoring malformed retry-attempt header; treating as first attempt');
    }
    if (attempts >= this.maxAttempts) {
      this.logger?.error('Usage message exhausted retries; rejecting to DLQ', {
        attempts,
        error: err instanceof Error ? err.message : String(err),
      });
      await this.rejectToDlq(channel, msg, 'retries_exhausted');
      return;
    }

    const tier = tierForAttempt(attempts);
    const nextAttempts = attempts + 1;
    try {
      // Mandatory publish with confirm/return correlation: resolves only
      // after the broker confirms the retry copy (or rejects unroutable).
      await this.publishDirect(channel, tier.queue, msg, {
        [RETRY_ATTEMPT_HEADER]: nextAttempts,
      });
    } catch (publishErr) {
      // The retry copy is NOT confirmed: never ack or discard the original.
      this.consecutiveRetryPublishFailures += 1;
      if (this.consecutiveRetryPublishFailures > MAX_CONSECUTIVE_RETRY_PUBLISH_FAILURES) {
        // Deterministically broken retry path: make it visible in the DLQ
        // instead of hot-looping redeliveries against a dead tier.
        this.logger?.error('Retry publication repeatedly unconfirmable; rejecting message to DLQ', {
          consecutiveFailures: this.consecutiveRetryPublishFailures,
          error: publishErr instanceof Error ? publishErr.message : String(publishErr),
        });
        await this.rejectToDlq(channel, msg, 'retry_publish_overflow');
        return;
      }
      this.logger?.error('Transient error processing usage event; requeueing message', {
        error: err instanceof Error ? err.message : String(err),
      });
      this.settle(() => this.channel?.nack(msg, false, true));
      return;
    }
    this.consecutiveRetryPublishFailures = 0;
    this.logger?.info('Usage message scheduled for delayed retry', {
      retryQueue: tier.queue,
      attempts: nextAttempts,
    });
    this.settle(() => this.channel?.ack(msg));
  }

  /**
   * Best-effort settlement: the channel may have died mid-processing (its
   * close requeues our unacked message automatically). Never let a dead
   * channel turn settlement into an unhandled rejection.
   */
  private settle(settleFn: () => void): void {
    try {
      settleFn();
    } catch (err) {
      this.logger?.warn('Broker settlement failed; message remains unacked for redelivery', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  public async stop(): Promise<void> {
    this.isRunning = false;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    // Graceful shutdown: stop claiming (consume already halted via channel
    // close below) and let in-flight handlers settle, bounded, before
    // releasing the connection. Unacked leftovers are requeued by the
    // broker on channel close.
    const deadline = Date.now() + this.shutdownTimeoutMs;
    while (this.inFlight > 0 && Date.now() < deadline) {
      await this.sleep(50);
    }
    if (this.inFlight > 0) {
      this.logger?.warn('Stopping usage consumer with in-flight messages', {
        inFlight: this.inFlight,
      });
    }
    const channel = this.channel;
    const connection = this.connection;
    this.channel = null;
    this.consumerTag = null;
    try {
      await channel?.close();
    } catch {
      // Already gone; the broker requeues unacked messages on close.
    }
    // Only close a connection we established ourselves: an injected
    // connection (tests, or a shared connection) is owned by its provider.
    if (connection !== null && connection !== this.injectedConnection) {
      await connection.close().catch(() => undefined);
      this.connection = null;
    }
  }
}
