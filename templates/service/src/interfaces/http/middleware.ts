import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { HttpStatus, type ApiErrorResponse } from '@oicunt/contracts';
import type { Logger } from '@oicunt/logging';
import {
  DomainError,
  EntityNotFoundError,
  ValidationError,
  ConflictError,
} from '../../domain/index.js';

export interface RequestContext {
  readonly correlationId: string;
  readonly logger: Logger;
  readonly startTime: number;
}

export function extractCorrelationId(req: IncomingMessage): string {
  const header = req.headers['x-correlation-id'];
  if (typeof header === 'string' && header.trim().length > 0) {
    return header.trim();
  }
  if (Array.isArray(header) && header[0]) {
    return header[0].trim();
  }
  return randomUUID();
}

export function createRequestContext(
  req: IncomingMessage,
  res: ServerResponse,
  baseLogger: Logger,
): RequestContext {
  const correlationId = extractCorrelationId(req);
  res.setHeader('X-Correlation-ID', correlationId);

  const logger = baseLogger.child({
    correlationId,
    method: req.method,
    url: req.url,
  });

  return {
    correlationId,
    logger,
    startTime: Date.now(),
  };
}

export function handleHttpError(
  res: ServerResponse,
  error: unknown,
  context: RequestContext,
): void {
  let statusCode: number = HttpStatus.INTERNAL_SERVER_ERROR;
  let code = 'INTERNAL_SERVER_ERROR';
  let message = 'An unexpected error occurred while processing the request';

  if (error instanceof EntityNotFoundError) {
    statusCode = HttpStatus.NOT_FOUND;
    code = error.code;
    message = error.message;
  } else if (error instanceof ValidationError) {
    statusCode = HttpStatus.BAD_REQUEST;
    code = error.code;
    message = error.message;
  } else if (error instanceof ConflictError) {
    statusCode = HttpStatus.CONFLICT;
    code = error.code;
    message = error.message;
  } else if (error instanceof DomainError) {
    statusCode = HttpStatus.UNPROCESSABLE_ENTITY;
    code = error.code;
    message = error.message;
  } else {
    context.logger.error('Unhandled internal server error', error, {
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

  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
  });
  res.end(JSON.stringify(payload));
}
