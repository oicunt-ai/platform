export abstract class DomainError extends Error {
  public abstract readonly code: string;

  constructor(message: string) {
    super(message);
    this.name = this.constructor.name;
  }
}

export class EntityNotFoundError extends DomainError {
  public readonly code = 'ENTITY_NOT_FOUND';

  constructor(entityName: string, id: string) {
    super(`${entityName} with identifier '${id}' was not found`);
  }
}

export class ValidationError extends DomainError {
  public readonly code = 'VALIDATION_FAILED';

  constructor(
    message: string,
    public readonly field?: string,
  ) {
    super(message);
  }
}

export class ConflictError extends DomainError {
  public readonly code = 'STATE_CONFLICT';

  constructor(message: string) {
    super(message);
  }
}
