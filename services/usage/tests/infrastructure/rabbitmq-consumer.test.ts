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
    ack: vi.fn(),
    nack: vi.fn(),
    close: vi.fn().mockResolvedValue(undefined),
  });

  const createMockConnection = (channel: AmqpChannelLike): AmqpConnectionLike => ({
    createChannel: vi.fn().mockResolvedValue(channel),
    close: vi.fn().mockResolvedValue(undefined),
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

  it('nacks malformed JSON messages without requeue (routes to DLQ)', async () => {
    const channel = createMockChannel();
    const connection = createMockConnection(channel);
    const consumer = new RabbitMqUsageConsumer({}, connection);
    const handler = vi.fn();

    consumer.registerHandler(handler);
    await consumer.start();

    const malformedMsg = {
      content: Buffer.from('{ not-valid-json: '),
    } as unknown as amqplib.ConsumeMessage;

    await consumer.processMessage(malformedMsg);

    expect(handler).not.toHaveBeenCalled();
    expect(channel.nack).toHaveBeenCalledWith(malformedMsg, false, false);
    expect(channel.ack).not.toHaveBeenCalled();
  });

  it('nacks permanent validation errors without requeue (routes to DLQ)', async () => {
    const channel = createMockChannel();
    const connection = createMockConnection(channel);
    const consumer = new RabbitMqUsageConsumer({}, connection);
    const handler = vi.fn().mockRejectedValue(new UsageValidationError('Invalid tenantId'));

    consumer.registerHandler(handler);
    await consumer.start();

    const invalidMsg = {
      content: Buffer.from(JSON.stringify({ bad: 'event' })),
    } as unknown as amqplib.ConsumeMessage;

    await consumer.processMessage(invalidMsg);

    expect(channel.nack).toHaveBeenCalledWith(invalidMsg, false, false);
    expect(channel.ack).not.toHaveBeenCalled();
  });

  it('nacks transient errors with requeue=true for safe retry', async () => {
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
    } as unknown as amqplib.ConsumeMessage;

    await consumer.processMessage(msg);

    expect(channel.nack).toHaveBeenCalledWith(msg, false, true);
    expect(channel.ack).not.toHaveBeenCalled();
  });
});
