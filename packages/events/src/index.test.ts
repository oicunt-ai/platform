import { describe, expect, it } from 'vitest';
import { createDomainEvent, InMemoryEventBus } from './index.js';

describe('@oicunt/events', () => {
  it('should create domain events with metadata and uuid', () => {
    const event = createDomainEvent({
      name: 'platform.system.initialized',
      payload: { system: 'platform', status: 'ready' },
      producer: 'bootstrap',
      correlationId: 'trace-123',
    });

    expect(event.name).toBe('platform.system.initialized');
    expect(event.payload.system).toBe('platform');
    expect(event.metadata.producer).toBe('bootstrap');
    expect(event.metadata.correlationId).toBe('trace-123');
    expect(typeof event.metadata.eventId).toBe('string');
    expect(event.metadata.eventId.length).toBeGreaterThan(0);
    expect(event.metadata.version).toBe('1.0.0');
  });

  it('should publish and subscribe through InMemoryEventBus', async () => {
    const bus = new InMemoryEventBus();
    const received: string[] = [];

    const unsubscribe = await bus.subscribe('test.event', {
      async handle(event) {
        received.push(event.name);
      },
    });

    const testEvent = createDomainEvent({
      name: 'test.event',
      payload: {},
      producer: 'test-runner',
    });

    await bus.publish(testEvent);
    expect(received).toEqual(['test.event']);

    await unsubscribe();
    await bus.publish(testEvent);
    expect(received).toHaveLength(1);
  });
});
