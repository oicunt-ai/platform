export * from './errors.js';

export interface AggregateRoot<TId = string> {
  readonly id: TId;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface RepositoryPort<TEntity extends AggregateRoot> {
  findById(id: string): Promise<TEntity | null>;
  save(entity: TEntity): Promise<void>;
  delete(id: string): Promise<boolean>;
}
