import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';

export interface RequestContext {
  readonly correlationId: string;
  readonly requestId: string;
  readonly tenantId?: string | undefined;
  readonly actorId?: string | undefined;
  readonly sourceService?: string | undefined;
  readonly deadlineMs?: number | undefined;
  readonly clientIp?: string | undefined;
  readonly startTime: number;
  readonly signal: AbortSignal;
}

export function extractHeader(req: IncomingMessage, name: string): string | undefined {
  const val = req.headers[name.toLowerCase()];
  if (typeof val === 'string' && val.trim().length > 0) {
    return val.trim();
  }
  if (Array.isArray(val) && val[0]) {
    return val[0].trim();
  }
  return undefined;
}

export function extractRequestContext(req: IncomingMessage, res?: ServerResponse): RequestContext {
  const correlationId = extractHeader(req, 'x-correlation-id') ?? randomUUID();
  const requestId = extractHeader(req, 'x-request-id') ?? `req_${randomUUID().replace(/-/g, '')}`;
  const tenantId = extractHeader(req, 'x-tenant-id');
  const actorId = extractHeader(req, 'x-actor-id');
  const sourceService =
    extractHeader(req, 'x-source-service') ?? extractHeader(req, 'x-service-name');

  const deadlineHeader = extractHeader(req, 'x-deadline-ms');
  const deadlineMs = deadlineHeader ? Number.parseInt(deadlineHeader, 10) : undefined;

  const clientIp =
    extractHeader(req, 'x-forwarded-for')?.split(',')[0]?.trim() ?? req.socket.remoteAddress;

  const controller = new AbortController();
  req.on('close', () => {
    if (!req.complete) {
      controller.abort();
    }
  });

  if (res) {
    res.setHeader('x-correlation-id', correlationId);
    res.setHeader('x-request-id', requestId);
  }

  return {
    correlationId,
    requestId,
    tenantId,
    actorId,
    sourceService,
    deadlineMs,
    clientIp,
    startTime: Date.now(),
    signal: controller.signal,
  };
}
