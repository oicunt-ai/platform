/**
 * Regression tests for bounded durable retries in RabbitMqUsageConsumer.
 *
 * Transient ingestion failures are republished to fixed-delay retry tiers
 * and acked only after broker confirmation; validation failures go
 * straight to the DLQ. All broker behavior is faked â€” no live RabbitMQ.
 */
import { describe, expect, it, vi } from 'vitest';
import type amqplib from 'amqplib';
import {
  RETRY_ATTEMPT_HEADER,
  RabbitMqUsageConsumer,
  parseRetryAttempts,
  tierForAttempt,
  type AmqpChannelLike,
  type AmqpConnectionLike,
} from '../../src/infrastructure/queue/rabbitmq-usage-consumer.js';
import { UsageConnectionError, UsageValidationError } from '../../src/domain/errors.js';

const NO_SLEEP = async (_ms: number) => {};

function createMockChannel(): AmqpChannelLike & {
  published: Array<{ exchange: string; routingKey: string; options: Record<string, unknown> }>;
} {
  const published: Array<{
    exchange: string;
    routingKey: string;
    options: Record<string, unknown>;
  }> = [];
  return {
    published,
    assertExchange: vi.fn().mockResolvedValue({}),
    assertQueue: vi.fn().mockResolvedValue({}),
    bindQueue: vi.fn().mockResolvedValue({}),
    prefetch: vi.fn().mockResolvedValue({}),
    consume: vi
      .fn()
      .mockResolvedValue({ consumerTag: 'tag-1' } as unknown as amqplib.Replies.Consume),
    publish: vi
      .fn()
      .mockImplementation(
        (
          exchange: string,
          routingKey: string,
          _content: Buffer,
          options?: Record<string, unknown>,
        ) => {
          published.push({ exchange, routingKey, options: options ?? {} });
          return true;
        },
      ),
    waitForConfirms: vi.fn().mockResolvedValue(undefined),
    ack: vi.fn(),
    nack: vi.fn(),
    close: vi.fn().mockResolvedValue(undefined),
    on: vi.fn(),
  };
}

function createMockConnection(channel: AmqpChannelLike): AmqpConnectionLike {
  return {
    createConfirmChannel: vi.fn().mockResolvedValue(channel),
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

function transientConsumer(connection: AmqpConnectionLike) {
  const consumer = new RabbitMqUsageConsumer({ maxAttempts: 5 }, connection, undefined, {
    sleep: NO_SLEEP,
    random: () => 0.5,
  });
  consumer.registerHandler(vi.fn().mockRejectedValue(new UsageConnectionError('db is down')));
  return consumer;
}

describe('retry tiers and attempt headers', () => {
  it('maps attempts to fixed-delay tiers without mixed TTLs', () => {
    expect(tierForAttempt(0)).toEqual({ queue: 'oicunt.usage.retry.5s', ttlMs: 5000 });
    expect(tierForAttempt(1)).toEqual({ queue: 'oicunt.usage.retry.30s', ttlMs: 30000 });
    expect(tierForAttempt(2)).toEqual({ queue: 'oicunt.usage.retry.5m', ttlMs: 300000 });
    expect(tierForAttempt(99)).toEqual({ queue: 'oicunt.usage.retry.5m', ttlMs: 300000 });
  });

  it('parses attempt headers strictly, defaulting to zero', () => {
    expect(parseRetryAttempts(testMessage())).toBe(0);
    expect(parseRetryAttempts(testMessage({ [RETRY_ATTEMPT_HEADER]: 2 }))).toBe(2);
    expect(parseRetryAttempts(testMessage({ [RETRY_ATTEMPT_HEADER]: '3' }))).toBe(3);
    expect(parseRetryAttempts(testMessage({ [RETRY_ATTEMPT_HEADER]: 'abc' }))).toBe(0);
    expect(parseRetryAttempts(testMessage({ [RETRY_ATTEMPT_HEADER]: -1 }))).toBe(0);
    expect(parseRetryAttempts(testMessage({ [RETRY_ATTEMPT_HEADER]: 2.5 }))).toBe(0);
    expect(parseRetryAttempts(testMessage({ [RETRY_ATTEMPT_HEADER]: null }))).toBe(0);
  });
});

describe('bounded durable retries', () => {
  it('routes each attempt to its tier preserving identity and payload', async () => {
    for (const [attempts, tier, next] of [
      [0, 'oicunt.usage.retry.5s', 1],
      [1, 'oicunt.usage.retry.30s', 2],
      [2, 'oicunt.usage.retry.5m', 3],
    ] as const) {
      const channel = createMockChannel();
      const consumer = transientConsumer(createMockConnection(channel));
      await consumer.start();

      await consumer.processMessage(
        testMessage(attempts === 0 ? {} : { [RETRY_ATTEMPT_HEADER]: attempts }),
      );

      expect(channel.published).toHaveLength(1);
      const copy = channel.published[0]!;
      expect(copy.routingKey).toBe(tier);
      expect(copy.exchange).toBe('');
      expect(copy.options['persistent']).toBe(true);
      expect(copy.options['messageId']).toBe('evt-1');
      expect(copy.options['correlationId']).toBe('corr-1');
      expect((copy.options['headers'] as Record<string, unknown>)[RETRY_ATTEMPT_HEADER]).toBe(next);
      expect(channel.ack).toHaveBeenCalledTimes(1);
      expect(channel.nack).not.toHaveBeenCalled();
      await consumer.stop();
    }
  });

  it('increases backoff across redeliveries without any hot requeue', async () => {
    const channel = createMockChannel();
    const consumer = transientConsumer(createMockConnection(channel));
    await consumer.start();

    // Simulate a database outage: each redelivered copy fails again and is
    // republished to the next tier with an incremented header.
    const tiers: string[] = [];
    let headers: Record<string, unknown> = {};
    for (let round = 0; round < 3; round++) {
      await consumer.processMessage(testMessage(headers));
      const copy = channel.published[channel.published.length - 1]!;
      tiers.push(copy.routingKey);
      headers = copy.options['headers'] as Record<string, unknown>;
      (channel.ack as ReturnType<typeof vi.fn>).mockClear();
    }

    expect(tiers).toEqual([
      'oicunt.usage.retry.5s',
      'oicunt.usage.retry.30s',
      'oicunt.usage.retry.5m',
    ]);
    expect(headers[RETRY_ATTEMPT_HEADER]).toBe(3);
    // Immediate requeue is never used on this path: no hot redelivery loop.
    for (const call of (channel.nack as ReturnType<typeof vi.fn>).mock.calls) {
      expect(call[2]).not.toBe(true);
    }
    await consumer.stop();
  });

  it('routes retry exhaustion through the explicit DLQ publish', async () => {
    const channel = createMockChannel();
    const consumer = transientConsumer(createMockConnection(channel));
    await consumer.start();

    await consumer.processMessage(testMessage({ [RETRY_ATTEMPT_HEADER]: 5 }));

    // Verifiable DLQ copy first, then ack — never a blind broker-hop nack.
    expect(channel.published).toHaveLength(1);
    expect(channel.published[0]?.routingKey).toBe('oicunt.usage.dlq');
    expect(channel.published[0]?.options['mandatory']).toBe(true);
    expect(
      (channel.published[0]?.options['headers'] as Record<string, unknown>)['x-usage-dlq-reason'],
    ).toBe('retries_exhausted');
    expect(channel.ack).toHaveBeenCalledTimes(1);
    expect(channel.nack).not.toHaveBeenCalled();
    await consumer.stop();
  });

  it('requeues (never acks) when the retry copy cannot be confirmed', async () => {
    const channel = createMockChannel();
    (channel.waitForConfirms as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('confirm lost'),
    );
    const consumer = transientConsumer(createMockConnection(channel));
    await consumer.start();

    await consumer.processMessage(testMessage());

    expect(channel.nack).toHaveBeenCalledWith(expect.anything(), false, true);
    expect(channel.ack).not.toHaveBeenCalled();
    await consumer.stop();
  });

  it('requeues when publish itself throws, guarding a broken retry path', async () => {
    const channel = createMockChannel();
    (channel.publish as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error('channel exploded');
    });
    const consumer = transientConsumer(createMockConnection(channel));
    await consumer.start();

    await consumer.processMessage(testMessage());

    expect(channel.nack).toHaveBeenCalledWith(expect.anything(), false, true);
    expect(channel.ack).not.toHaveBeenCalled();
    await consumer.stop();
  });

  it('treats a full write buffer as an unconfirmed retry publish', async () => {
    const channel = createMockChannel();
    (channel.publish as ReturnType<typeof vi.fn>).mockReturnValue(false);
    const consumer = transientConsumer(createMockConnection(channel));
    await consumer.start();

    await consumer.processMessage(testMessage());

    expect(channel.nack).toHaveBeenCalledWith(expect.anything(), false, true);
    expect(channel.ack).not.toHaveBeenCalled();
    await consumer.stop();
  });

  it('preserves (never DLQ-rejects) when retries are deterministically broken', async () => {
    const channel = createMockChannel();
    (channel.publish as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error('tier queue gone');
    });
    const consumer = transientConsumer(createMockConnection(channel));
    await consumer.start();

    for (let i = 0; i < 10; i++) {
      await consumer.processMessage(testMessage());
      expect(channel.nack).toHaveBeenLastCalledWith(expect.anything(), false, true);
    }
    // 11th consecutive failure: instead of an unverifiable broker-hop DLQ
    // reject, the consumer attempts the verified DLQ publish (which also
    // throws here) and then preserves the message via channel closure for
    // broker redelivery — never acked, never permanently rejected.
    await consumer.processMessage(testMessage());
    expect(channel.close).toHaveBeenCalled();
    expect(channel.ack).not.toHaveBeenCalled();
    for (const call of (channel.nack as ReturnType<typeof vi.fn>).mock.calls) {
      expect(call[2]).not.toBe(false);
    }
    await consumer.stop();
  });

  it('resets the failure guard after a successful retry publication', async () => {
    const channel = createMockChannel();
    const publish = channel.publish as ReturnType<typeof vi.fn>;
    const consumer = new RabbitMqUsageConsumer({}, createMockConnection(channel), undefined, {
      sleep: NO_SLEEP,
    });
    let shouldFail = true;
    consumer.registerHandler(
      vi.fn().mockImplementation(() => {
        if (shouldFail) {
          return Promise.reject(new UsageConnectionError('db is down'));
        }
        return Promise.resolve(undefined);
      }),
    );
    await consumer.start();

    // One failed publication arms the guard (counter = 1) ...
    publish.mockImplementationOnce(() => {
      throw new Error('one-off broker hiccup');
    });
    await consumer.processMessage(testMessage());
    expect(channel.nack).toHaveBeenLastCalledWith(expect.anything(), false, true);

    // ... a successful publication resets it ...
    shouldFail = false;
    await consumer.processMessage(testMessage());
    expect(channel.ack).toHaveBeenCalledTimes(1);

    // ... so nine further consecutive failures still requeue (counter runs
    // 1..9 again, never reaching the DLQ threshold of 10 without a reset).
    shouldFail = true;
    for (let i = 0; i < 9; i++) {
      publish.mockImplementationOnce(() => {
        throw new Error('still hiccuping');
      });
      await consumer.processMessage(testMessage());
      expect(channel.nack).toHaveBeenLastCalledWith(expect.anything(), false, true);
    }
    expect(channel.ack).toHaveBeenCalledTimes(1);
    await consumer.stop();
  });

  it('keeps validation failures on the explicit DLQ path', async () => {
    const channel = createMockChannel();
    const consumer = new RabbitMqUsageConsumer({}, createMockConnection(channel), undefined, {
      sleep: NO_SLEEP,
    });
    consumer.registerHandler(vi.fn().mockRejectedValue(new UsageValidationError('nope')));

    await consumer.start();
    await consumer.processMessage(testMessage());

    expect(channel.published).toHaveLength(1);
    expect(channel.published[0]?.routingKey).toBe('oicunt.usage.dlq');
    expect(channel.ack).toHaveBeenCalledTimes(1);
    expect(channel.nack).not.toHaveBeenCalled();
    await consumer.stop();
  });

  it('routes a missing handler through the explicit DLQ publish', async () => {
    const channel = createMockChannel();
    const consumer = new RabbitMqUsageConsumer({}, createMockConnection(channel), undefined, {
      sleep: NO_SLEEP,
    });

    await consumer.start();
    await consumer.processMessage(testMessage());

    expect(channel.published).toHaveLength(1);
    expect(channel.published[0]?.routingKey).toBe('oicunt.usage.dlq');
    expect(channel.ack).toHaveBeenCalledTimes(1);
    expect(channel.nack).not.toHaveBeenCalled();
    await consumer.stop();
  });

  it('never acknowledges or drops a message without a live channel', async () => {
    const channel = createMockChannel();
    const consumer = transientConsumer(createMockConnection(channel));
    consumer.registerHandler(vi.fn().mockResolvedValue(undefined));
    // Never started: no channel, so processMessage must leave it unacked.
    await consumer.processMessage(testMessage());

    expect(channel.ack).not.toHaveBeenCalled();
    expect(channel.nack).not.toHaveBeenCalled();
    expect(channel.published).toHaveLength(0);
  });
});
