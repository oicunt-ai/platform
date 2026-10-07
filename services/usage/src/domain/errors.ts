export class UsageError extends Error {
  public readonly code: string;
  public readonly statusCode: number;
  public readonly details?: Record<string, unknown> | undefined;

  constructor(
    message: string,
    code: string = 'USAGE_ERROR',
    statusCode: number = 500,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'UsageError';
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class UsageValidationError extends UsageError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'USAGE_VALIDATION_ERROR', 400, details);
    this.name = 'UsageValidationError';
  }
}

export class UsageUnauthorizedError extends UsageError {
  constructor(message: string = 'Unauthorized access to Usage Service') {
    super(message, 'UNAUTHORIZED', 401);
    this.name = 'UsageUnauthorizedError';
  }
}

export class UsageForbiddenError extends UsageError {
  constructor(message: string = 'Forbidden operation on Usage Service') {
    super(message, 'FORBIDDEN', 403);
    this.name = 'UsageForbiddenError';
  }
}

export class UsageTenantMismatchError extends UsageError {
  constructor(expectedTenantId: string, providedTenantId: string) {
    super(
      `Tenant boundary violation: authenticated tenant '${expectedTenantId}' does not match requested tenant '${providedTenantId}'`,
      'TENANT_MISMATCH',
      403,
      { expectedTenantId, providedTenantId },
    );
    this.name = 'UsageTenantMismatchError';
  }
}

export class UsageNotFoundError extends UsageError {
  constructor(resource: string, identifier: string) {
    super(`Resource '${resource}' identified by '${identifier}' was not found`, 'NOT_FOUND', 404, {
      resource,
      identifier,
    });
    this.name = 'UsageNotFoundError';
  }
}

export class UsageDuplicateEventError extends UsageError {
  public readonly eventId: string;
  public readonly idempotencyKey: string;

  constructor(eventId: string, idempotencyKey: string) {
    super(
      `Duplicate usage event detected with idempotency key '${idempotencyKey}'`,
      'USAGE_DUPLICATE_EVENT',
      409,
      { eventId, idempotencyKey },
    );
    this.name = 'UsageDuplicateEventError';
    this.eventId = eventId;
    this.idempotencyKey = idempotencyKey;
  }
}

export class UsageConnectionError extends UsageError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'USAGE_CONNECTION_ERROR', 503, details);
    this.name = 'UsageConnectionError';
  }
}

export class UsageInternalError extends UsageError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'INTERNAL_ERROR', 500, details);
    this.name = 'UsageInternalError';
  }
}
