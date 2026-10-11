/**
 * Regression tests for RabbitMqUsageConsumer connection lifecycle.
 *
 * Close/error detection, truthful readiness, bounded reconnect with
 * jitter, topology reassertion, duplicate-subscription prevention, and
 * graceful shutdown — all against controllable fakes. No live RabbitMQ.
 */
import { describe, expect, it, vi } from 'vitest';
import type amqplib from 'amqplib';
import {
  RabbitMqUsageConsumer,
  type AmqpChannelLike,
  type AmqpConnectionLike,
} from '../../src/infrastructure/queue/rabbitmq-usage-consumer.js';
import { UsageConnectionError } from '../../src/domain/errors.js';
import { UsageService } from '../../src/service.js';
import { InMemoryUsageQueue } from '../../src/infrastructure/queue/in-memory-usage-queue.js';

const NO_SLEEP = async (_ms: number) => {};

class FakeChannel {
  public published = 0;
  public acks: unknown[] = [];
  public nacks: Array<{ requeue: boolean | undefined }> = [];
  public closes = 0;
  public assertExchangeCalls: string[] = [];
  public assertQueueCalls: string[] = [];
  public consumeCalls = 0;
  public closed = false;
  private readonly listeners = new Map<string, Array<(...args: never[]) => void>>();

  async assertExchange(exchange: string): Promise<unknown> {
    this.assertExchangeCalls.push(exchange);
    return {};
  }

  async assertQueue(queue: string): Promise<unknown> {
    this.assertQueueCalls.push(queue);
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
    onMessage: (msg: amqplib.ConsumeMessage | null) => void,
  ): Promise<amqplib.Replies.Consume> {
    this.consumeCalls += 1;
    this.onMessage = onMessage;
    return { consumerTag: `tag-${this.consumeCalls}` } as amqplib.Replies.Consume;
  }

  public onMessage: ((msg: amqplib.ConsumeMessage | null) => void) | null = null;

  publish(): boolean {
    if (this.closed) {
      throw new Error('channel closed');
    }
    this.published += 1;
    return true;
  }

  async waitForConfirms(): Promise<void> {}

  ack(msg: unknown): void {
    if (this.closed) {
      throw new Error('channel closed');
    }
    this.acks.push(msg);
  }

  nack(_msg: unknown, _allUp?: boolean, requeue?: boolean): void {
    if (this.closed) {
      throw new Error('channel closed');
    }
    this.nacks.push({ requeue });
  }

  async close(): Promise<void> {
    this.closes += 1;
    if (!this.closed) {
      this.closed = true;
      this.emit('close');
    }
  }

  on(event: string, listener: (...args: never[]) => void): void {
    const list = this.listeners.get(event) ?? [];
    list.push(listener);
    this.listeners.set(event, list);
  }

  emit(event: string): void {
    for (const listener of this.listeners.get(event) ?? []) {
      listener();
    }
  }

  asLike(): AmqpChannelLike {
    return this as unknown as AmqpChannelLike;
  }
}

class FakeConnection {
  public channels: FakeChannel[] = [];
  public closes = 0;
  public failChannelCreation = false;
  private readonly listeners = new Map<string, Array<(...args: never[]) => void>>();

  async createConfirmChannel(): Promise<FakeChannel> {
    if (this.failChannelCreation) {
      throw new Error('channel refused');
    }
    const channel = new FakeChannel();
    this.channels.push(channel);
    return channel;
  }

  async close(): Promise<void> {
    this.closes += 1;
  }

  on(event: string, listener: (...args: never[]) => void): void {
    const list = this.listeners.get(event) ?? [];
    list.push(listener);
    this.listeners.set(event, list);
  }

  emit(event: string): void {
    for (const listener of this.listeners.get(event) ?? []) {
      listener();
    }
  }

  asLike(): AmqpConnectionLike {
    return this as unknown as AmqpConnectionLike;
  }
}

function sequencedConnect(failuresBeforeSuccess: number, made: FakeConnection[]) {
  const calls: string[] = [];
  let failuresLeft = failuresBeforeSuccess;
  return {
    calls,
    connect: async (url: string): Promise<AmqpConnectionLike> => {
      calls.push(url);
      if (failuresLeft > 0) {
        failuresLeft -= 1;
        throw new Error('ECONNREFUSED connect');
      }
      const connection = new FakeConnection();
      made.push(connection);
      return connection.asLike();
    },
  };
}

function testMessage(): amqplib.ConsumeMessage {
  return {
    content: Buffer.from(JSON.stringify({ eventId: 'evt-1', tenantId: 'ten-1' })),
    fields: { routingKey: 'usage.v1.model.completion' },
    properties: { headers: {} },
  } as unknown as amqplib.ConsumeMessage;
}

async function waitFor(condition: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 200 && !condition(); i++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  expect(condition(), label).toBe(true);
}

describe('consumer lifecycle and readiness', () => {
  it('is not ready before subscription is established', async () => {
    const channel = new FakeChannel();
    const conn = {
      createConfirmChannel: vi.fn().mockResolvedValue(channel.asLike()),
      close: vi.fn(),
      on: vi.fn(),
    };
    const consumer = new RabbitMqUsageConsumer({ url: 'amqp://test' }, conn, undefined, {
      sleep: NO_SLEEP,
    });
    expect(consumer.isReady()).toBe(false);
    consumer.registerHandler(vi.fn().mockResolvedValue(undefined));
    await consumer.start();
    expect(consumer.isReady()).toBe(true);
    await consumer.stop();
    expect(consumer.isReady()).toBe(false);
  });

  it('prevents duplicate subscriptions across repeated starts', async () => {
    const channel = new FakeChannel();
    const conn = {
      createConfirmChannel: vi.fn().mockResolvedValue(channel.asLike()),
      close: vi.fn(),
      on: vi.fn(),
    };
    const consumer = new RabbitMqUsageConsumer({ url: 'amqp://test' }, conn, undefined, {
      sleep: NO_SLEEP,
    });
    consumer.registerHandler(vi.fn().mockResolvedValue(undefined));
    await consumer.start();
    await consumer.start();
    await consumer.start();
    expect(channel.consumeCalls).toBe(1);
    await consumer.stop();
  });

  it('refuses to start without a broker URL when no connection is injected', async () => {
    const consumer = new RabbitMqUsageConsumer({}, undefined, undefined, { sleep: NO_SLEEP });
    await expect(consumer.start()).rejects.toBeInstanceOf(UsageConnectionError);
    expect(consumer.isReady()).toBe(false);
  });

  it('performs zero I/O at construction time', async () => {
    const connect = vi.fn();
    const consumer = new RabbitMqUsageConsumer({ url: 'amqp://test' }, undefined, undefined, {
      connect,
      sleep: NO_SLEEP,
    });
    expect(connect).not.toHaveBeenCalled();
    expect(consumer.isReady()).toBe(false);
    await consumer.stop();
  });

  it('reconnects after connection loss and reasserts topology', async () => {
    const made: FakeConnection[] = [];
    const connector = sequencedConnect(0, made);
    const consumer = new RabbitMqUsageConsumer(
      { url: 'amqp://test', reconnectInitialMs: 5, reconnectMaxMs: 10 },
      undefined,
      undefined,
      { connect: connector.connect, sleep: NO_SLEEP, random: () => 0.5 },
    );
    consumer.registerHandler(vi.fn().mockResolvedValue(undefined));
    await consumer.start();
    expect(consumer.isReady()).toBe(true);

    made[0]?.emit('close');
    expect(consumer.isReady()).toBe(false);
    await waitFor(() => consumer.isReady(), 'consumer reconnects');
    expect(connector.calls).toEqual(['amqp://test', 'amqp://test']);
    expect(made).toHaveLength(2);
    expect(made[1]?.channels).toHaveLength(1);
    expect(made[1]?.channels[0]?.consumeCalls).toBe(1);
    expect(made[1]?.channels[0]?.assertExchangeCalls).toContain('oicunt.usage');
    expect(made[1]?.channels[0]?.assertQueueCalls).toContain('oicunt.usage.events');
    expect(made[1]?.channels[0]?.assertQueueCalls).toContain('oicunt.usage.retry.5s');
    await consumer.stop();
  });

  it('backs off across consecutive reconnect failures, then recovers', async () => {
    const made: FakeConnection[] = [];
    const calls: string[] = [];
    let failuresLeft = 0;
    let started = false;
    const connect = async (url: string): Promise<AmqpConnectionLike> => {
      calls.push(url);
      if (started && failuresLeft > 0) {
        failuresLeft -= 1;
        throw new Error('ECONNREFUSED connect');
      }
      const connection = new FakeConnection();
      made.push(connection);
      return connection.asLike();
    };
    const consumer = new RabbitMqUsageConsumer(
      { url: 'amqp://test', reconnectInitialMs: 5, reconnectMaxMs: 10 },
      undefined,
      undefined,
      { connect, sleep: NO_SLEEP, random: () => 0.5 },
    );
    consumer.registerHandler(vi.fn().mockResolvedValue(undefined));
    await consumer.start();
    started = true;
    failuresLeft = 2;
    made[0]?.emit('error');
    await waitFor(() => consumer.isReady(), 'consumer recovers after backoff');
    // Initial connect + 2 failed reconnects + 1 success.
    expect(calls).toHaveLength(4);
    await consumer.stop();
  });

  it('stops reconnecting after stop()', async () => {
    const made: FakeConnection[] = [];
    const calls: string[] = [];
    let brokerDown = false;
    const connect = async (url: string): Promise<AmqpConnectionLike> => {
      calls.push(url);
      if (brokerDown) {
        throw new Error('ECONNREFUSED connect');
      }
      const connection = new FakeConnection();
      made.push(connection);
      return connection.asLike();
    };
    const consumer = new RabbitMqUsageConsumer(
      { url: 'amqp://test', reconnectInitialMs: 5, reconnectMaxMs: 10 },
      undefined,
      undefined,
      { connect, sleep: NO_SLEEP, random: () => 0.5 },
    );
    consumer.registerHandler(vi.fn().mockResolvedValue(undefined));
    await consumer.start();
    const callsAfterStart = calls.length;
    brokerDown = true;
    made[0]?.emit('close');
    await consumer.stop();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(calls.length).toBe(callsAfterStart);
    await consumer.stop();
  });

  it('swallows settlement on a dead channel without rejecting', async () => {
    const channel = new FakeChannel();
    const conn = {
      createConfirmChannel: vi.fn().mockResolvedValue(channel.asLike()),
      close: vi.fn(),
      on: vi.fn(),
    };
    const consumer = new RabbitMqUsageConsumer({ url: 'amqp://test' }, conn, undefined, {
      sleep: NO_SLEEP,
    });
    consumer.registerHandler(vi.fn().mockResolvedValue(undefined));
    await consumer.start();
    channel.closed = true;
    await expect(consumer.processMessage(testMessage())).resolves.toBeUndefined();
    expect(channel.acks).toHaveLength(0);
    await consumer.stop();
  });

  it('waits for in-flight messages on shutdown, bounded', async () => {
    const channel = new FakeChannel();
    const conn = {
      createConfirmChannel: vi.fn().mockResolvedValue(channel.asLike()),
      close: vi.fn(),
      on: vi.fn(),
    };
    const consumer = new RabbitMqUsageConsumer(
      { url: 'amqp://test', shutdownTimeoutMs: 1000 },
      conn,
      undefined,
      {
        sleep: NO_SLEEP,
      },
    );
    let releaseHandler!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseHandler = resolve;
    });
    consumer.registerHandler(vi.fn().mockImplementation(() => gate));
    await consumer.start();

    const processing = consumer.processMessage(testMessage());
    const stopping = consumer.stop();
    releaseHandler();
    await processing;
    await stopping;
    expect(channel.acks).toHaveLength(1);
    expect(channel.closes).toBe(1);
  });

  it('uses an injected connection without ever dialing the broker', async () => {
    const injected = new FakeConnection();
    const connect = vi.fn();
    const consumer = new RabbitMqUsageConsumer({}, injected.asLike(), undefined, {
      connect,
      sleep: NO_SLEEP,
    });
    consumer.registerHandler(vi.fn().mockResolvedValue(undefined));
    await consumer.start();
    expect(connect).not.toHaveBeenCalled();
    expect(consumer.isReady()).toBe(true);
    await consumer.stop();
    // Injected connections are owned by their provider: never closed here.
    expect(injected.closes).toBe(0);
  });

  it('keeps the in-memory queue when publishing is disabled', () => {
    const service = new UsageService(
      { useRabbitMq: false, useDatabase: false, port: 0, logLevel: 'silent' },
      {},
    );
    expect(service.queueConsumer).toBeInstanceOf(InMemoryUsageQueue);
  });
});
