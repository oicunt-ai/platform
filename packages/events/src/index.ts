import { randomUUID } from 'node:crypto';

export interface EventMetadata {
  readonly eventId: string;
  readonly correlationId: string;
  readonly causationId?: string;
  readonly timestamp: string;
  readonly version: string;
  readonly producer: string;
}

export interface DomainEvent<TPayload = unknown> {
  readonly name: string;
  readonly payload: TPayload;
  readonly metadata: EventMetadata;
}

export interface EventHandler<TEvent extends DomainEvent<unknown> = DomainEvent<unknown>> {
  handle(event: TEvent): Promise<void>;
}

export interface EventPublisher {
  publish<T>(event: DomainEvent<T>): Promise<void>;
  publishBatch<T>(events: readonly DomainEvent<T>[]): Promise<void>;
}

export interface EventSubscriber {
  subscribe<T>(
    eventName: string,
    handler: EventHandler<DomainEvent<T>>,
  ): Promise<() => Promise<void>>;
}

export interface CreateDomainEventParams<TPayload> {
  readonly name: string;
  readonly payload: TPayload;
  readonly producer: string;
  readonly correlationId?: string;
  readonly causationId?: string;
  readonly version?: string;
}

export function createDomainEvent<TPayload>(
  params: CreateDomainEventParams<TPayload>,
): DomainEvent<TPayload> {
  const eventId = randomUUID();
  return {
    name: params.name,
    payload: params.payload,
    metadata: {
      eventId,
      correlationId: params.correlationId ?? eventId,
      ...(params.causationId ? { causationId: params.causationId } : {}),
      timestamp: new Date().toISOString(),
      version: params.version ?? '1.0.0',
      producer: params.producer,
    },
  };
}

export class InMemoryEventBus implements EventPublisher, EventSubscriber {
  private readonly handlers = new Map<string, Set<EventHandler<DomainEvent<unknown>>>>();

  async publish<T>(event: DomainEvent<T>): Promise<void> {
    const registered = this.handlers.get(event.name);
    if (!registered) {
      return;
    }
    const promises: Promise<void>[] = [];
    for (const handler of registered) {
      promises.push(handler.handle(event as DomainEvent<unknown>));
    }
    await Promise.all(promises);
  }

  async publishBatch<T>(events: readonly DomainEvent<T>[]): Promise<void> {
    for (const event of events) {
      await this.publish(event);
    }
  }

  async subscribe<T>(
    eventName: string,
    handler: EventHandler<DomainEvent<T>>,
  ): Promise<() => Promise<void>> {
    let set = this.handlers.get(eventName);
    if (!set) {
      set = new Set();
      this.handlers.set(eventName, set);
    }
    const typedHandler = handler as EventHandler<DomainEvent<unknown>>;
    set.add(typedHandler);

    return async (): Promise<void> => {
      set?.delete(typedHandler);
    };
  }
}
