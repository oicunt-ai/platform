import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { UsageService } from '../../../src/service.js';
import type { DatabasePool } from '../../../src/infrastructure/database/connection.js';
import type { UsageQueueConsumerPort } from '../../../src/application/ports/usage-queue-consumer.port.js';

function stubPool(pingResult: boolean): DatabasePool {
  return {
    ping: async () => pingResult,
    close: async () => undefined,
    query: async () => {
      throw new Error('unexpected query in readiness test');
    },
  } as unknown as DatabasePool;
}

/** Consumer whose readiness follows a mutable flag (simulates disconnects). */
function fakeConsumer(state: { ready: boolean }): UsageQueueConsumerPort {
  return {
    isReady: () => state.ready,
    start: async () => undefined,
    stop: async () => undefined,
    registerHandler: () => undefined,
  };
}

async function baseUrlOf(service: UsageService): Promise<string> {
  const address = service.getHttpServer()?.address();
  if (typeof address === 'object' && address !== null) {
    return `http://127.0.0.1:${address.port}`;
  }
  throw new Error('service did not bind an HTTP server');
}

describe('Usage Health & Readiness Endpoints', () => {
  let service: UsageService;
  let baseUrl: string;

  beforeAll(async () => {
    service = new UsageService({
      port: 0,
      host: '127.0.0.1',
      useDatabase: false,
      useRabbitMq: false,
      logLevel: 'silent',
    });
    await service.start();
    baseUrl = await baseUrlOf(service);
  });

  afterAll(async () => {
    await service.stop();
  });

  it('GET /health/liveness returns 200 without authentication', async () => {
    const res = await fetch(`${baseUrl}/health/liveness`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; service: string };
    expect(body.status).toBe('ok');
    expect(body.service).toBe('usage');
  });

  it('GET /health/readiness reports the database DOWN when no pool exists', async () => {
    const res = await fetch(`${baseUrl}/health/readiness`);
    // A missing pool is never a healthy PostgreSQL dependency.
    expect(res.status).toBe(503);
    const body = (await res.json()) as {
      status: string;
      checks: { database: string; usageQueue: string };
    };
    expect(body.status).toBe('degraded');
    expect(body.checks.database).toBe('down');
  });
});

describe('Usage readiness with mocked real dependencies', () => {
  let service: UsageService;
  let baseUrl: string;
  const queueState = { ready: true };

  beforeAll(async () => {
    service = new UsageService(
      { port: 0, host: '127.0.0.1', logLevel: 'silent' },
      { dbPool: stubPool(true), queueConsumer: fakeConsumer(queueState) },
    );
    await service.start();
    baseUrl = await baseUrlOf(service);
  });

  afterAll(async () => {
    await service.stop();
  });

  it('GET /readyz returns 200 when both dependencies are up', async () => {
    queueState.ready = true;
    const res = await fetch(`${baseUrl}/readyz`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      status: string;
      checks: { database: string; usageQueue: string };
    };
    expect(body.status).toBe('ok');
    expect(body.checks).toEqual({ database: 'up', usageQueue: 'up' });
  });

  it('GET /readyz returns 503 when the queue consumer becomes unready', async () => {
    queueState.ready = false;
    try {
      const res = await fetch(`${baseUrl}/readyz`);
      expect(res.status).toBe(503);
      const body = (await res.json()) as { checks: { usageQueue: string } };
      expect(body.checks.usageQueue).toBe('down');
    } finally {
      queueState.ready = true;
    }
  });
});

describe('Usage readiness when the database ping fails', () => {
  let service: UsageService;
  let baseUrl: string;

  beforeAll(async () => {
    service = new UsageService(
      { port: 0, host: '127.0.0.1', logLevel: 'silent' },
      { dbPool: stubPool(false), queueConsumer: fakeConsumer({ ready: true }) },
    );
    await service.start();
    baseUrl = await baseUrlOf(service);
  });

  afterAll(async () => {
    await service.stop();
  });

  it('GET /readyz returns 503 with database down', async () => {
    const res = await fetch(`${baseUrl}/readyz`);
    expect(res.status).toBe(503);
    const body = (await res.json()) as { checks: { database: string; usageQueue: string } };
    expect(body.checks).toEqual({ database: 'down', usageQueue: 'up' });
  });
});

describe('Usage readiness with a missing queue consumer', () => {
  let service: UsageService;
  let baseUrl: string;

  beforeAll(async () => {
    service = new UsageService(
      { port: 0, host: '127.0.0.1', logLevel: 'silent' },
      {
        dbPool: stubPool(true),
        // Explicitly inject "no consumer": readiness must not fall back to
        // reporting a healthy queue.
        queueConsumer: null as unknown as UsageQueueConsumerPort,
      },
    );
    await service.start();
    baseUrl = await baseUrlOf(service);
  });

  afterAll(async () => {
    await service.stop();
  });

  it('GET /readyz returns 503 with usageQueue down', async () => {
    const res = await fetch(`${baseUrl}/readyz`);
    expect(res.status).toBe(503);
    const body = (await res.json()) as { checks: { database: string; usageQueue: string } };
    expect(body.checks).toEqual({ database: 'up', usageQueue: 'down' });
  });
});
