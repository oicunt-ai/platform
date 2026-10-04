import type { DomainEvent, EventPublisher } from '@oicunt/events';
import type { AggregateRoot, RepositoryPort } from '../domain/index.js';
import type { EventPublisherPort } from '../application/index.js';

export class InMemoryRepository<TEntity extends AggregateRoot> implements RepositoryPort<TEntity> {
  private readonly storage = new Map<string, TEntity>();

  async findById(id: string): Promise<TEntity | null> {
    return this.storage.get(id) ?? null;
  }

  async save(entity: TEntity): Promise<void> {
    this.storage.set(entity.id, entity);
  }

  async delete(id: string): Promise<boolean> {
    return this.storage.delete(id);
  }

  clear(): void {
    this.storage.clear();
  }
}

export class EventPublisherAdapter implements EventPublisherPort {
  constructor(private readonly publisher: EventPublisher) {}

  async publish<T>(event: DomainEvent<T>): Promise<void> {
    await this.publisher.publish(event);
  }
}
