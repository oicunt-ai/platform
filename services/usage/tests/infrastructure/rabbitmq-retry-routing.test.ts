/**
 * Delivery-safety tests for retry routing and DLQ transfers.
 *
 * These tests validate the actual exchange / routing-key / binding /
 * declaration contracts instead of assuming broker behavior: the stamped
 * retry dead-letter key must match a declared binding, mandatory publishes
 * must correlate returns, and every DLQ path must positively confirm
 * before the original is acked.
 *
 * Broker-level guarantees that fakes cannot prove (TTL-expiry transfer
 * inside a real broker, quorum at-least-once dead-lettering) are
 * documented in docs/development.md and require live integration tests.
 */
import { describe, expect, it, vi } from 'vitest';
import type amqplib from 'amqplib';
import {
  RETRY_DEAD_LETTER_ROUTING_KEY,
  RETRY_TIERS,
  RabbitMqUsageConsumer,
  type AmqpChannelLike,
  type AmqpConnectionLike,
} from '../../src/infrastructure/queue/rabbitmq-usage-consumer.js';
import { UsageConnectionError, UsageValidationError } from '../../src/domain/errors.js';

/**
 * Minimal topic matcher for the FIXED literal pairs in this suite only.
 * It does not reimplement broker semantics: `*`/`#` handling below covers
 * exactly the asserted cases. Full routing behavior requires a live
 * RabbitMQ integration test.
 */
function topicMatches(binding: string, routingKey: string): boolean {
  const b = binding.split('.');
  const r = routingKey.split('.');
  let bi = 0;
  let ri = 0;
  while (bi < b.length && ri < r.length) {
    if (b[bi] === '#') {
      return true;
    }
    if (b[bi] !== '*' && b[bi] !== r[ri]) {
      return false;
    }
    bi += 1;
    ri += 1;
  }
  if (bi < b.length) {
    return b.slice(bi).every((part) => part === '#');
  }
  return ri === r.length;
}

interface PublishedCopy {
  exchange: string;
  routingKey: string;
  content: Buffer;
  options: Record<string, unknown>;
}

class FakeChannel {
  public published: PublishedCopy[] = [];
  public acks: unknown[] = [];
  public nacks: Array<{ allUp: boolean | undefined; requeue: boolean | undefined }> = [];
  public assertedQueues: Array<{ queue: string; options: Record<string, unknown> }> = [];
  public closed = false;
  public confirmMode: 'auto' | 'manual' | 'never' = 'auto';
  private confirmResolvers: Array<{ resolve: () => void; reject: (error: Error) => void }> = [];
  private readonly listeners = new Map<string, Array<(arg?: unknown) => void>>();

  async assertExchange(): Promise<unknown> {
    return {};
  }

  async assertQueue(queue: string, options?: Record<string, unknown>): Promise<unknown> {
    this.assertedQueues.push({ queue, options: options ?? {} });
    return {};
  }

  async bindQueue(): Promise<unknown> {
    return {};
  }

  async prefetch(): Promise<unknown> {
    return {};
  }

  async consume(
    _queue: string,
    _onMessage: (msg: amqplib.ConsumeMessage | null) => void,
  ): Promise<amqplib.Replies.Consume> {
    return { consumerTag: 'tag-fake' } as amqplib.Replies.Consume;
  }

  publish(
    exchange: string,
    routingKey: string,
    content: Buffer,
    options?: Record<string, unknown>,
  ): boolean {
    if (this.closed) {
      throw new Error('channel closed');
    }
    this.published.push({ exchange, routingKey, content, options: options ?? {} });
    return true;
  }

  async waitForConfirms(): Promise<void> {
    if (this.confirmMode === 'never') {
      await new Promise<never>(() => {
        // Intentionally pending: exercises confirmation timeouts.
      });
    }
    if (this.confirmMode === 'manual') {
      await new Promise<void>((resolve, reject) => {
        this.confirmResolvers.push({ resolve, reject });
      });
    }
  }

  confirmNext(): void {
    this.confirmResolvers.shift()?.resolve();
  }

  failPendingConfirms(error: Error): void {
    const parked = this.confirmResolvers.splice(0);
    for (const entry of parked) {
      entry.reject(error);
    }
  }

  ack(msg: unknown): void {
    if (this.closed) {
      throw new Error('channel closed');
    }
    this.acks.push(msg);
  }

  nack(_msg: unknown, allUp?: boolean, requeue?: boolean): void {
    if (this.closed) {
      throw new Error('channel closed');
    }
    this.nacks.push({ allUp, requeue });
  }

  async close(): Promise<void> {
    this.closed = true;
    this.failPendingConfirms(new Error('channel closed'));
    for (const listener of this.listeners.get('close') ?? []) {
      listener();
    }
  }

  on(event: string, listener: (arg?: unknown) => void): void {
    const list = this.listeners.get(event) ?? [];
    list.push(listener);
    this.listeners.set(event, list);
  }

  emitReturn(messageId: string, replyText = 'NO_ROUTE'): void {
    for (const listener of this.listeners.get('return') ?? []) {
      listener({ fields: { replyText }, properties: { messageId } });
    }
  }

  asLike(): AmqpChannelLike {
    return this as unknown as AmqpChannelLike;
  }
}

function fakeConnection(channel: FakeChannel): AmqpConnectionLike {
  return {
    createConfirmChannel: vi.fn().mockResolvedValue(channel.asLike()),
    close: vi.fn().mockResolvedValue(undefined),
    on: vi.fn(),
  };
}

function testMessage(headers?: Record<string, unknown>): amqplib.ConsumeMessage {
  return {
    content: Buffer.from(JSON.stringify({ eventId: 'evt-1', tenantId: 'ten-1' })),
    fields: { routingKey: 'usage.v1.model.completion' },
    properties: {
      messageId: 'evt-1',
      correlationId: 'corr-1',
      contentType: 'application/json',
      headers: headers ?? {},
    },
  } as unknown as amqplib.ConsumeMessage;
}

function consumerWith(
  channel: FakeChannel,
  handler: () => Promise<void>,
  options?: { maxAttempts?: number; confirmTimeoutMs?: number },
): RabbitMqUsageConsumer {
  const consumer = new RabbitMqUsageConsumer(
    { maxAttempts: options?.maxAttempts ?? 5, confirmTimeoutMs: options?.confirmTimeoutMs },
    fakeConnection(channel),
    undefined,
    { sleep: async () => undefined },
  );
  consumer.registerHandler(handler);
  return consumer;
}

const transientHandler = () => Promise.reject(new UsageConnectionError('db is down'));

describe('retry routing contract', () => {
  it('stamps a dead-letter key that the existing topic binding routes', () => {
    expect(RETRY_DEAD_LETTER_ROUTING_KEY).toBe('usage.v1.retry');
    // The stamped key must match the main queue binding — no new bindings.
    expect(topicMatches('usage.v1.#', RETRY_DEAD_LETTER_ROUTING_KEY)).toBe(true);
    // And the model-gateway key keeps matching too (binding serves both).
    expect(topicMatches('usage.v1.#', 'usage.v1.model.completion')).toBe(true);
    // Guard against regressing to the tier queue name, which matches nothing.
    expect(topicMatches('usage.v1.#', 'oicunt.usage.retry.5s')).toBe(false);
  });

  it('declares every tier with quorum at-least-once dead-lettering', async () => {
    const channel = new FakeChannel();
    const consumer = consumerWith(channel, transientHandler);
    await consumer.start();

    // RabbitMQ 3.13 prerequisites for recoverable dead-letter transfer
    // (see docs/development.md): quorum type ALONE is insufficient —
    // at-least-once requires the explicit strategy plus reject-publish
    // overflow, a valid DLX + routing key, and the stream_queue flag.
    expect(RETRY_TIERS).toHaveLength(3);
    for (const tier of RETRY_TIERS) {
      const declared = channel.assertedQueues.find((q) => q.queue === tier.queue);
      expect(declared).toBeDefined();
      expect(declared?.options['durable']).toBe(true);
      expect(declared?.options['messageTtl']).toBe(tier.ttlMs);
      expect(declared?.options['deadLetterExchange']).toBe('oicunt.usage');
      expect(declared?.options['deadLetterRoutingKey']).toBe(RETRY_DEAD_LETTER_ROUTING_KEY);
      const args = declared?.options['arguments'] as Record<string, unknown> | undefined;
      expect(args?.['x-queue-type']).toBe('quorum');
      expect(args?.['x-dead-letter-strategy']).toBe('at-least-once');
      expect(args?.['x-overflow']).toBe('reject-publish');
    }
    await consumer.stop();
  });

  it('publishes retry copies mandatory with preserved identity', async () => {
    const channel = new FakeChannel();
    const consumer = consumerWith(channel, transientHandler);
    await consumer.start();

    await consumer.processMessage(testMessage());

    expect(channel.published).toHaveLength(1);
    const copy = channel.published[0]!;
    expect(copy.exchange).toBe('');
    expect(copy.routingKey).toBe('oicunt.usage.retry.5s');
    expect(copy.options['mandatory']).toBe(true);
    expect(copy.options['persistent']).toBe(true);
    expect(copy.options['messageId']).toBe('evt-1');
    expect(copy.options['correlationId']).toBe('corr-1');
    expect(copy.content).toEqual(testMessage().content);
    expect(channel.acks).toHaveLength(1);
    expect(channel.nacks).toHaveLength(0);
    await consumer.stop();
  });
});

describe('returned and unroutable publications', () => {
  it('requeues (never acks) when a retry copy is returned unroutable', async () => {
    const channel = new FakeChannel();
    channel.confirmMode = 'manual';
    const consumer = consumerWith(channel, transientHandler);
    await consumer.start();

    const processing = consumer.processMessage(testMessage());
    for (let i = 0; i < 50 && channel.published.length !== 1; i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    channel.emitReturn('evt-1', 'NO_ROUTE');
    await processing;

    expect(channel.acks).toHaveLength(0);
    expect(channel.nacks).toHaveLength(1);
    expect(channel.nacks[0]?.requeue).toBe(true);
    await consumer.stop();
  });

  it('ignores late returns for already-confirmed publishes', async () => {
    const channel = new FakeChannel();
    const consumer = consumerWith(channel, transientHandler);
    await consumer.start();

    await consumer.processMessage(testMessage());
    expect(channel.acks).toHaveLength(1);
    // A duplicate/late return after confirmation must not unsettle anything.
    channel.emitReturn('evt-1', 'NO_ROUTE');
    expect(channel.acks).toHaveLength(1);
    expect(channel.nacks).toHaveLength(0);
    await consumer.stop();
  });

  it('ignores returns for unknown message ids', async () => {
    const channel = new FakeChannel();
    channel.confirmMode = 'manual';
    const consumer = consumerWith(channel, transientHandler);
    await consumer.start();

    const processing = consumer.processMessage(testMessage());
    for (let i = 0; i < 50 && channel.published.length !== 1; i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    channel.emitReturn('some-other-id', 'NO_ROUTE');
    channel.confirmNext();
    await processing;

    expect(channel.acks).toHaveLength(1);
    expect(channel.nacks).toHaveLength(0);
    await consumer.stop();
  });

  it('serializes concurrent publishes so confirms correlate exactly', async () => {
    const channel = new FakeChannel();
    channel.confirmMode = 'manual';
    const consumer = consumerWith(channel, transientHandler);
    await consumer.start();

    const first = consumer.processMessage(testMessage());
    const second = consumer.processMessage(testMessage());
    for (let i = 0; i < 50 && channel.published.length !== 2; i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    // Second publish starts only after the first settles: resolve in order.
    channel.confirmNext();
    await first;
    channel.confirmNext();
    await second;

    expect(channel.published).toHaveLength(2);
    expect(channel.acks).toHaveLength(2);
    expect(channel.nacks).toHaveLength(0);
    await consumer.stop();
  });
});

describe('explicit DLQ transfer', () => {
  it('publishes validation failures to the DLQ with reason and confirms first', async () => {
    const channel = new FakeChannel();
    const consumer = consumerWith(channel, () =>
      Promise.reject(new UsageValidationError('bad tenant')),
    );
    await consumer.start();

    await consumer.processMessage(testMessage());

    expect(channel.published).toHaveLength(1);
    const copy = channel.published[0]!;
    expect(copy.exchange).toBe('');
    expect(copy.routingKey).toBe('oicunt.usage.dlq');
    expect(copy.options['mandatory']).toBe(true);
    expect(copy.options['persistent']).toBe(true);
    expect(copy.options['messageId']).toBe('evt-1');
    expect(copy.content).toEqual(testMessage().content);
    expect((copy.options['headers'] as Record<string, unknown>)['x-usage-dlq-reason']).toBe(
      'validation',
    );
    expect(channel.acks).toHaveLength(1);
    expect(channel.nacks).toHaveLength(0);
    await consumer.stop();
  });

  it('routes retry exhaustion through the explicit DLQ publish', async () => {
    const channel = new FakeChannel();
    const consumer = consumerWith(channel, transientHandler, { maxAttempts: 2 });
    await consumer.start();

    await consumer.processMessage(testMessage({ 'x-usage-attempts': 2 }));

    expect(channel.published).toHaveLength(1);
    expect(channel.published[0]?.routingKey).toBe('oicunt.usage.dlq');
    expect(
      (channel.published[0]?.options['headers'] as Record<string, unknown>)['x-usage-attempts'],
    ).toBe(2);
    expect(
      (channel.published[0]?.options['headers'] as Record<string, unknown>)['x-usage-dlq-reason'],
    ).toBe('retries_exhausted');
    expect(channel.acks).toHaveLength(1);
    expect(channel.nacks).toHaveLength(0);
    await consumer.stop();
  });

  it('preserves the original when DLQ publication cannot confirm', async () => {
    const channel = new FakeChannel();
    channel.confirmMode = 'never';
    const consumer = consumerWith(
      channel,
      () => Promise.reject(new UsageValidationError('bad tenant')),
      { confirmTimeoutMs: 30 },
    );
    await consumer.start();

    await consumer.processMessage(testMessage());

    // Explicit publish unconfirmable: NEVER ack, NEVER permanently reject
    // through the unverifiable classic DLX hop. The channel closes so the
    // broker requeues the message for redelivery.
    expect(channel.published).toHaveLength(1);
    expect(channel.published[0]?.routingKey).toBe('oicunt.usage.dlq');
    expect(channel.acks).toHaveLength(0);
    expect(channel.nacks).toHaveLength(0);
    expect(channel.closed).toBe(true);
    await consumer.stop();
  });

  it('preserves the original when the DLQ copy is returned unroutable', async () => {
    const channel = new FakeChannel();
    channel.confirmMode = 'manual';
    const consumer = consumerWith(channel, () =>
      Promise.reject(new UsageValidationError('bad tenant')),
    );
    await consumer.start();

    const processing = consumer.processMessage(testMessage());
    for (let i = 0; i < 50 && channel.published.length !== 1; i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    channel.emitReturn('evt-1', 'NO_ROUTE');
    await processing;

    expect(channel.acks).toHaveLength(0);
    expect(channel.nacks).toHaveLength(0);
    expect(channel.closed).toBe(true);
    await consumer.stop();
  });

  it('treats confirmation timeouts as uncertain: requeue, never ack', async () => {
    const channel = new FakeChannel();
    channel.confirmMode = 'never';
    const consumer = consumerWith(channel, transientHandler, { confirmTimeoutMs: 30 });
    await consumer.start();

    await consumer.processMessage(testMessage());

    // Tier copy unconfirmable: original requeued (counter path), never acked.
    expect(channel.published).toHaveLength(1);
    expect(channel.published[0]?.routingKey).toBe('oicunt.usage.retry.5s');
    expect(channel.nacks).toHaveLength(1);
    expect(channel.nacks[0]).toEqual({ allUp: false, requeue: true });
    expect(channel.acks).toHaveLength(0);
    await consumer.stop();
  });

  it('fails uncertain on channel loss during retry publish, preserving identity', async () => {
    const channel = new FakeChannel();
    channel.confirmMode = 'manual';
    const consumer = consumerWith(channel, transientHandler);
    await consumer.start();

    const processing = consumer.processMessage(testMessage());
    for (let i = 0; i < 50 && channel.published.length !== 1; i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    // Broker drops the channel mid-confirm: the copy may or may not have
    // landed, so the original is requeued (never acked) with identity
    // intact; downstream deduplication absorbs any duplicate.
    await channel.close();
    await processing;

    expect(channel.published).toHaveLength(1);
    expect(channel.published[0]?.options['messageId']).toBe('evt-1');
    expect(channel.acks).toHaveLength(0);
    await consumer.stop();
  });

  it('recovers the preserved message after reconnect with identity intact', async () => {
    const first = new FakeChannel();
    first.confirmMode = 'never';
    const second = new FakeChannel();
    const channels = [first, second];
    let channelIndex = 0;
    const connect = async (): Promise<AmqpConnectionLike> => ({
      createConfirmChannel: async () => {
        const channel = channels[channelIndex]!;
        channelIndex += 1;
        return channel.asLike();
      },
      close: async () => {},
      on: () => {},
    });
    const consumer = new RabbitMqUsageConsumer(
      {
        url: 'amqp://test',
        reconnectInitialMs: 5,
        reconnectMaxMs: 10,
        confirmTimeoutMs: 30,
      },
      undefined,
      undefined,
      { connect, sleep: async () => undefined, random: () => 0.5 },
    );
    consumer.registerHandler(() => Promise.reject(new UsageValidationError('bad tenant')));
    await consumer.start();

    // Phase 1: DLQ destination unavailable — the message is preserved via
    // channel closure, never acked, never permanently rejected.
    await consumer.processMessage(testMessage());
    expect(first.closed).toBe(true);
    expect(first.acks).toHaveLength(0);

    // Broker recovers (reconnect reasserts topology, including the DLQ).
    for (let i = 0; i < 100 && !consumer.isReady(); i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(consumer.isReady()).toBe(true);

    // Phase 2: the redelivered message — same identity — completes the
    // verified DLQ transfer and is acked exactly once.
    await consumer.processMessage(testMessage());
    expect(second.published).toHaveLength(1);
    expect(second.published[0]?.routingKey).toBe('oicunt.usage.dlq');
    expect(second.published[0]?.options['messageId']).toBe('evt-1');
    expect(second.acks).toHaveLength(1);
    expect(second.nacks).toHaveLength(0);
    await consumer.stop();
  });

  it('paces repeated preservation cycles with reconnect backoff, never hot', async () => {
    const made: FakeChannel[] = [];
    const calls: string[] = [];
    const connect = async (url: string): Promise<AmqpConnectionLike> => {
      calls.push(url);
      const fresh = new FakeChannel();
      fresh.confirmMode = 'never';
      made.push(fresh);
      return {
        createConfirmChannel: async () => fresh.asLike(),
        close: async () => {},
        on: () => {},
      };
    };
    const consumer = new RabbitMqUsageConsumer(
      { url: 'amqp://test', reconnectInitialMs: 5, reconnectMaxMs: 10, confirmTimeoutMs: 30 },
      undefined,
      undefined,
      { connect, sleep: async () => undefined, random: () => 0.5 },
    );
    consumer.registerHandler(() => Promise.reject(new UsageValidationError('bad tenant')));
    await consumer.start();

    // Three consecutive unconfirmable DLQ publications: each preserves via
    // exactly one channel closure and one paced reconnect — bounded
    // recovery attempts, never a spin, never an ack or permanent reject.
    for (let cycle = 0; cycle < 3; cycle++) {
      for (let i = 0; i < 100 && !consumer.isReady(); i++) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      await consumer.processMessage(testMessage());
    }
    // The third preservation also schedules exactly one reconnect.
    for (let i = 0; i < 100 && calls.length < 4; i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(made).toHaveLength(4);
    expect(calls).toHaveLength(4);
    for (const channel of made.slice(0, 3)) {
      expect(channel.closed).toBe(true);
      expect(channel.acks).toHaveLength(0);
    }
    await consumer.stop();
  });
});
