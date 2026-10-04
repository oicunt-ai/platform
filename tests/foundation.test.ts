import { describe, expect, it } from 'vitest';
import { createBaseConfig } from '../packages/config/src/index.js';
import { calculatePagination, HttpStatus, ok } from '../packages/contracts/src/index.js';
import { createDomainEvent, InMemoryEventBus } from '../packages/events/src/index.js';
import { MemoryLogger } from '../packages/logging/src/index.js';
import { NoopTracer } from '../packages/observability/src/index.js';

describe('Platform Foundation Integration', () => {
  it('should integrate shared package boundaries coherently', async () => {
    // 1. Config
    const config = createBaseConfig('platform-core', { port: 4000 });
    expect(config.serviceName).toBe('platform-core');

    // 2. Logging
    const logger = new MemoryLogger({ service: config.serviceName });
    logger.info('Platform foundation initialized');

    // 3. Observability
    const tracer = new NoopTracer();
    const result = await tracer.withSpan('foundation.bootstrap', async () => {
      // 4. Events
      const bus = new InMemoryEventBus();
      const emitted: string[] = [];

      await bus.subscribe('foundation.verified', {
        async handle(event) {
          emitted.push(event.name);
        },
      });

      const event = createDomainEvent({
        name: 'foundation.verified',
        payload: { ready: true },
        producer: config.serviceName,
      });

      await bus.publish(event);

      // 5. Contracts
      const responseData = { status: 'healthy', events: emitted };
      const response = ok(responseData);
      const pagination = calculatePagination(1, 10, 1);

      return {
        statusCode: HttpStatus.OK,
        response,
        pagination,
      };
    });

    expect(result.statusCode).toBe(200);
    expect(result.response.ok).toBe(true);
    expect(result.pagination.totalItems).toBe(1);

    const logEntries = logger.getEntries();
    expect(logEntries).toHaveLength(1);
    expect(logEntries[0]?.message).toBe('Platform foundation initialized');
  });
});
