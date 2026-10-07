import type { IncomingMessage, ServerResponse } from 'node:http';
import { UsageError, UsageValidationError } from '../../domain/errors.js';
import type { RequestContext } from './context.js';

export async function readJsonBody<T>(
  req: IncomingMessage,
  maxSizeBytes: number = 1024 * 1024,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytesReceived = 0;

    req.on('data', (chunk: Buffer) => {
      bytesReceived += chunk.length;
      if (bytesReceived > maxSizeBytes) {
        req.destroy();
        reject(
          new UsageValidationError(
            `Request payload exceeded maximum size limit of ${maxSizeBytes} bytes`,
          ),
        );
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      if (chunks.length === 0) {
        reject(new UsageValidationError('Request body is empty; expected valid JSON'));
        return;
      }
      const raw = Buffer.concat(chunks).toString('utf-8');
      try {
        const parsed = JSON.parse(raw);
        resolve(parsed as T);
      } catch (_err) {
        reject(new UsageValidationError('Malformed JSON payload'));
      }
    });

    req.on('error', (err) => {
      reject(err);
    });
  });
}

export function sendJsonResponse(
  res: ServerResponse,
  statusCode: number,
  data: unknown,
  context?: RequestContext,
): void {
  if (context) {
    res.setHeader('x-correlation-id', context.correlationId);
    res.setHeader('x-request-id', context.requestId);
  }
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

export function sendErrorResponse(
  res: ServerResponse,
  error: unknown,
  context?: RequestContext,
): void {
  let statusCode = 500;
  let code = 'INTERNAL_ERROR';
  let message = 'An unexpected internal error occurred';
  let details: Record<string, unknown> | undefined;

  if (error instanceof UsageError) {
    statusCode = error.statusCode;
    code = error.code;
    message = error.message;
    details = error.details;
  } else if (error instanceof Error) {
    message = error.message;
  }

  sendJsonResponse(
    res,
    statusCode,
    {
      success: false,
      error: {
        code,
        message,
        details,
      },
    },
    context,
  );
}
