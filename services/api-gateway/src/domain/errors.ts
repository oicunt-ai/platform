export abstract class DomainError extends Error {
  public abstract readonly code: string;
  public abstract readonly statusCode: number;

  constructor(message: string) {
    super(message);
    this.name = this.constructor.name;
  }
}

export class AuthenticationError extends DomainError {
  public readonly code = 'UNAUTHORIZED';
  public readonly statusCode = 401;

  constructor(message: string = 'Authentication credentials are invalid or missing') {
    super(message);
  }
}

export class ForbiddenError extends DomainError {
  public readonly code = 'FORBIDDEN';
  public readonly statusCode = 403;

  constructor(message: string = 'Caller is not authorized to access this resource') {
    super(message);
  }
}

export class ValidationError extends DomainError {
  public readonly code = 'VALIDATION_FAILED';
  public readonly statusCode = 400;

  constructor(
    message: string,
    public readonly field?: string,
  ) {
    super(message);
  }
}

export class EntityNotFoundError extends DomainError {
  public readonly code = 'ENTITY_NOT_FOUND';
  public readonly statusCode = 404;

  constructor(entityName: string, id: string) {
    super(`${entityName} with identifier '${id}' was not found`);
  }
}

export class BadGatewayError extends DomainError {
  public readonly code = 'BAD_GATEWAY';
  public readonly statusCode = 502;

  constructor(message: string = 'Downstream service returned an invalid or failed response') {
    super(message);
  }
}

export class ServiceUnavailableError extends DomainError {
  public readonly code = 'SERVICE_UNAVAILABLE';
  public readonly statusCode = 503;

  constructor(message: string = 'Service is temporarily unavailable') {
    super(message);
  }
}

export class GatewayTimeoutError extends DomainError {
  public readonly code = 'GATEWAY_TIMEOUT';
  public readonly statusCode = 504;

  constructor(message: string = 'Downstream service request timed out') {
    super(message);
  }
}

export class RateLimitedError extends DomainError {
  public readonly code: string;
  public readonly statusCode = 429;

  constructor(message = 'Request limit reached', code = 'RATE_LIMITED') {
    super(message);
    this.code = code;
  }
}
