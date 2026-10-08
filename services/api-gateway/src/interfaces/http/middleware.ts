import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { HttpStatus, type ApiErrorResponse } from '@oicunt/contracts';
import type { Logger } from '@oicunt/logging';
import {
  DomainError,
  AuthenticationError,
  ForbiddenError,
  ValidationError,
  EntityNotFoundError,
  BadGatewayError,
  ServiceUnavailableError,
  GatewayTimeoutError,
  type IdentityContext,
} from '../../domain/index.js';

export interface GatewayRequestContext {
  readonly requestId: string;
  readonly correlationId: string;
  readonly logger: Logger;
  readonly startTime: number;
  identity?: IdentityContext | undefined;
}

export function extractCorrelationId(req: IncomingMessage): string {
  const header = req.headers['x-correlation-id'];
  if (typeof header === 'string' && header.trim().length > 0) {
    return header.trim();
  }
  if (Array.isArray(header) && header[0] && header[0].trim().length > 0) {
    return header[0].trim();
  }
  return randomUUID();
}

/**
 * Creates the gateway request context and enforces perimeter security rules:
 * 1. Generates authoritative X-Request-ID (UUID v4), ignoring any client assertion.
 * 2. Adopts or generates X-Correlation-ID.
 * 3. Strips untrusted client identity headers (X-User-ID, X-Tenant-ID, X-Roles, X-Request-ID)
 *    from req.headers to prevent downstream spoofing.
 */
export function createGatewayRequestContext(
  req: IncomingMessage,
  res: ServerResponse,
  baseLogger: Logger,
): GatewayRequestContext {
  // 1. Authoritative Request ID
  const requestId = randomUUID();

  // 2. Correlation ID
  const correlationId = extractCorrelationId(req);

  // Set standard egress perimeter headers on the response
  res.setHeader('X-Request-ID', requestId);
  res.setHeader('X-Correlation-ID', correlationId);

  // 3. Strip all internal identity, authorization, service-name, and request headers
  const STRIPPED_INTERNAL_HEADERS = new Set([
    'x-user-id',
    'x-tenant-id',
    'x-roles',
    'x-role',
    'x-scopes',
    'x-scope',
    'x-permissions',
    'x-permission',
    'x-service-name',
    'x-request-id',
    'x-internal-token',
  ]);

  for (const headerKey of Object.keys(req.headers)) {
    if (STRIPPED_INTERNAL_HEADERS.has(headerKey.toLowerCase())) {
      delete req.headers[headerKey];
    }
  }

  // Child logger with trace context
  const logger = baseLogger.child({
    requestId,
    correlationId,
    method: req.method,
    url: req.url,
  });

  return {
    requestId,
    correlationId,
    logger,
    startTime: Date.now(),
  };
}

export async function parseJsonBody<T>(
  req: IncomingMessage,
  maxBytes = 10 * 1024 * 1024,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let receivedBytes = 0;

    req.on('data', (chunk: Buffer) => {
      receivedBytes += chunk.length;
      if (receivedBytes > maxBytes) {
        req.destroy();
        reject(
          new ValidationError(`Request payload exceeded maximum size limit of ${maxBytes} bytes`),
        );
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      if (chunks.length === 0) {
        reject(new ValidationError('Request body cannot be empty'));
        return;
      }

      const raw = Buffer.concat(chunks).toString('utf8');
      try {
        const parsed = JSON.parse(raw) as T;
        resolve(parsed);
      } catch {
        reject(new ValidationError('Malformed JSON in request body'));
      }
    });

    req.on('error', (err) => {
      reject(new ValidationError(`Error reading request body: ${err.message}`));
    });
  });
}

export function handleHttpError(
  res: ServerResponse,
  error: unknown,
  context: GatewayRequestContext,
): void {
  let statusCode: number = HttpStatus.INTERNAL_SERVER_ERROR;
  let code = 'INTERNAL_SERVER_ERROR';
  let message = 'An unexpected error occurred while processing the request';

  if (error instanceof AuthenticationError) {
    statusCode = HttpStatus.UNAUTHORIZED;
    code = error.code;
    message = error.message;
  } else if (error instanceof ForbiddenError) {
    statusCode = HttpStatus.FORBIDDEN;
    code = error.code;
    message = error.message;
  } else if (error instanceof ValidationError) {
    statusCode = HttpStatus.BAD_REQUEST;
    code = error.code;
    message = error.message;
  } else if (error instanceof EntityNotFoundError) {
    statusCode = HttpStatus.NOT_FOUND;
    code = error.code;
    message = error.message;
  } else if (error instanceof BadGatewayError) {
    statusCode = HttpStatus.BAD_GATEWAY;
    code = error.code;
    message = error.message;
  } else if (error instanceof ServiceUnavailableError) {
    statusCode = HttpStatus.SERVICE_UNAVAILABLE;
    code = error.code;
    message = error.message;
  } else if (error instanceof GatewayTimeoutError) {
    statusCode = HttpStatus.GATEWAY_TIMEOUT;
    code = error.code;
    message = error.message;
  } else if (error instanceof DomainError) {
    statusCode = error.statusCode;
    code = error.code;
    message = error.message;
  } else {
    context.logger.error('Unhandled internal server error', error, {
      requestId: context.requestId,
      correlationId: context.correlationId,
      executionTimeMs: Date.now() - context.startTime,
    });
  }

  const payload: ApiErrorResponse = {
    success: false,
    error: {
      code,
      message,
    },
    meta: {
      timestamp: new Date().toISOString(),
      correlationId: context.correlationId,
      executionTimeMs: Date.now() - context.startTime,
    },
  };

  if (!res.headersSent) {
    res.writeHead(statusCode, {
      'Content-Type': 'application/json; charset=utf-8',
      'X-Request-ID': context.requestId,
      'X-Correlation-ID': context.correlationId,
    });
  }

  res.end(JSON.stringify(payload));
}
