import { describe, expect, it, vi } from 'vitest';
import type amqplib from 'amqplib';
import {
  type AmqpChannelLike,
  type AmqpConnectionLike,
  RabbitMqUsageConsumer,
} from '../../src/infrastructure/queue/rabbitmq-usage-consumer.js';
import { UsageConnectionError, UsageValidationError } from '../../src/domain/errors.js';

describe('RabbitMqUsageConsumer', () => {
  const createMockChannel = (): AmqpChannelLike => ({
    assertExchange: vi.fn().mockResolvedValue({}),
    assertQueue: vi.fn().mockResolvedValue({}),
    bindQueue: vi.fn().mockResolvedValue({}),
    prefetch: vi.fn().mockResolvedValue({}),
    consume: vi
      .fn()
      .mockResolvedValue({ consumerTag: 'tag-1' } as unknown as amqplib.Replies.Consume),
    publish: vi.fn().mockReturnValue(true),
    waitForConfirms: vi.fn().mockResolvedValue(undefined),
    ack: vi.fn(),
    nack: vi.fn(),
    close: vi.fn().mockResolvedValue(undefined),
    on: vi.fn(),
  });

  const createMockConnection = (channel: AmqpChannelLike): AmqpConnectionLike => ({
    createConfirmChannel: vi.fn().mockResolvedValue(channel),
    close: vi.fn().mockResolvedValue(undefined),
    on: vi.fn(),
  });

  it('initializes topology and consumes from oicunt.usage.events', async () => {
    const channel = createMockChannel();
    const connection = createMockConnection(channel);
    const consumer = new RabbitMqUsageConsumer({}, connection);

    consumer.registerHandler(vi.fn());
    await consumer.start();

    expect(channel.assertExchange).toHaveBeenCalledWith('oicunt.usage.dlx', 'direct', {
      durable: true,
    });
    expect(channel.assertQueue).toHaveBeenCalledWith('oicunt.usage.dlq', { durable: true });
    expect(channel.assertExchange).toHaveBeenCalledWith('oicunt.usage', 'topic', { durable: true });
    expect(channel.assertQueue).toHaveBeenCalledWith('oicunt.usage.events', {
      durable: true,
      deadLetterExchange: 'oicunt.usage.dlx',
      deadLetterRoutingKey: 'dlq',
    });
    expect(channel.bindQueue).toHaveBeenCalledWith(
      'oicunt.usage.events',
      'oicunt.usage',
      'usage.v1.#',
    );
    // Bounded-delay retry tiers: durable quorum queues, one fixed TTL each,
    // dead-lettering back with the stamped routing key that the existing
    // usage.v1.# binding routes to the main queue.
    expect(channel.assertQueue).toHaveBeenCalledWith('oicunt.usage.retry.5s', {
      durable: true,
      messageTtl: 5000,
      deadLetterExchange: 'oicunt.usage',
      deadLetterRoutingKey: 'usage.v1.retry',
      arguments: {
        'x-queue-type': 'quorum',
        'x-dead-letter-strategy': 'at-least-once',
        'x-overflow': 'reject-publish',
      },
    });
    expect(channel.assertQueue).toHaveBeenCalledWith('oicunt.usage.retry.30s', {
      durable: true,
      messageTtl: 30000,
      deadLetterExchange: 'oicunt.usage',
      deadLetterRoutingKey: 'usage.v1.retry',
      arguments: {
        'x-queue-type': 'quorum',
        'x-dead-letter-strategy': 'at-least-once',
        'x-overflow': 'reject-publish',
      },
    });
    expect(channel.assertQueue).toHaveBeenCalledWith('oicunt.usage.retry.5m', {
      durable: true,
      messageTtl: 300000,
      deadLetterExchange: 'oicunt.usage',
      deadLetterRoutingKey: 'usage.v1.retry',
      arguments: {
        'x-queue-type': 'quorum',
        'x-dead-letter-strategy': 'at-least-once',
        'x-overflow': 'reject-publish',
      },
    });
  });

  it('acks messages on successful durable processing', async () => {
    const channel = createMockChannel();
    const connection = createMockConnection(channel);
    const consumer = new RabbitMqUsageConsumer({}, connection);
    const handler = vi.fn().mockResolvedValue(undefined);

    consumer.registerHandler(handler);
    await consumer.start();

    const sampleMsg = {
      content: Buffer.from(JSON.stringify({ eventId: 'evt-1', tenantId: 'ten-1' })),
    } as unknown as amqplib.ConsumeMessage;

    await consumer.processMessage(sampleMsg);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(channel.ack).toHaveBeenCalledWith(sampleMsg);
    expect(channel.nack).not.toHaveBeenCalled();
  });

  it('publishes malformed JSON to the DLQ with confirmation before ack', async () => {
    const channel = createMockChannel();
    const connection = createMockConnection(channel);
    const consumer = new RabbitMqUsageConsumer({}, connection);
    const handler = vi.fn();

    consumer.registerHandler(handler);
    await consumer.start();

    const malformedMsg = {
      content: Buffer.from('{ not-valid-json: '),
      properties: {},
    } as unknown as amqplib.ConsumeMessage;

    await consumer.processMessage(malformedMsg);

    expect(handler).not.toHaveBeenCalled();
    expect(channel.publish).toHaveBeenCalledTimes(1);
    const [exchange, routingKey, , options] = (channel.publish as ReturnType<typeof vi.fn>).mock
      .calls[0] as [string, string, Buffer, Record<string, unknown>];
    expect(exchange).toBe('');
    expect(routingKey).toBe('oicunt.usage.dlq');
    expect(options['mandatory']).toBe(true);
    expect((options['headers'] as Record<string, unknown>)['x-usage-dlq-reason']).toBe(
      'malformed_json',
    );
    expect(channel.ack).toHaveBeenCalledWith(malformedMsg);
    expect(channel.nack).not.toHaveBeenCalled();
  });

  it('publishes permanent validation errors to the DLQ with confirmation', async () => {
    const channel = createMockChannel();
    const connection = createMockConnection(channel);
    const consumer = new RabbitMqUsageConsumer({}, connection);
    const handler = vi.fn().mockRejectedValue(new UsageValidationError('Invalid tenantId'));

    consumer.registerHandler(handler);
    await consumer.start();

    const invalidMsg = {
      content: Buffer.from(JSON.stringify({ bad: 'event' })),
      properties: {},
    } as unknown as amqplib.ConsumeMessage;

    await consumer.processMessage(invalidMsg);

    expect(channel.publish).toHaveBeenCalledTimes(1);
    const [, routingKey, , options] = (channel.publish as ReturnType<typeof vi.fn>).mock
      .calls[0] as [string, string, Buffer, Record<string, unknown>];
    expect(routingKey).toBe('oicunt.usage.dlq');
    expect((options['headers'] as Record<string, unknown>)['x-usage-dlq-reason']).toBe(
      'validation',
    );
    expect(channel.ack).toHaveBeenCalledWith(invalidMsg);
    expect(channel.nack).not.toHaveBeenCalled();
  });

  it('schedules a delayed retry on transient errors and acks only after confirm', async () => {
    const channel = createMockChannel();
    const connection = createMockConnection(channel);
    const consumer = new RabbitMqUsageConsumer({}, connection);
    const handler = vi
      .fn()
      .mockRejectedValue(new UsageConnectionError('Database connection pool exhausted'));

    consumer.registerHandler(handler);
    await consumer.start();

    const msg = {
      content: Buffer.from(JSON.stringify({ valid: 'payload' })),
      properties: {},
    } as unknown as amqplib.ConsumeMessage;

    await consumer.processMessage(msg);

    // Retry copy published to the first tier with attempt header, confirmed,
    // then the original acknowledged â€” never requeued hot.
    expect(channel.publish).toHaveBeenCalledTimes(1);
    const [exchange, routingKey, content, options] = (channel.publish as ReturnType<typeof vi.fn>)
      .mock.calls[0] as [string, string, Buffer, Record<string, unknown>];
    expect(exchange).toBe('');
    expect(routingKey).toBe('oicunt.usage.retry.5s');
    expect(content).toEqual(msg.content);
    expect(options['persistent']).toBe(true);
    expect(options['mandatory']).toBe(true);
    expect((options['headers'] as Record<string, unknown>)['x-usage-attempts']).toBe(1);
    expect(channel.waitForConfirms).toHaveBeenCalledTimes(1);
    expect(channel.ack).toHaveBeenCalledWith(msg);
    expect(channel.nack).not.toHaveBeenCalled();
  });
});
