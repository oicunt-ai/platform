import type { IncomingMessage } from 'node:http';
import { verifyInternalServiceToken } from '../../infrastructure/security/internal-service-token.js';
import { UsageUnauthorizedError, UsageValidationError } from '../../domain/errors.js';
import type { RequestContext } from './context.js';
import { extractHeader } from './context.js';

export function isHealthCheckPath(pathname: string): boolean {
  return (
    pathname === '/healthz' ||
    pathname === '/readyz' ||
    pathname === '/health/liveness' ||
    pathname === '/health/readiness'
  );
}

export function validateInternalToken(req: IncomingMessage, internalToken?: string): void {
  if (!internalToken || internalToken.trim().length === 0) {
    if (process.env['NODE_ENV'] === 'production') {
      throw new UsageUnauthorizedError(
        'Production environment requires internal authentication token',
      );
    }
    return;
  }

  const authHeader = extractHeader(req, 'authorization');
  const tokenHeader = extractHeader(req, 'x-internal-token');

  let providedToken: string | undefined;
  if (authHeader && authHeader.toLowerCase().startsWith('bearer ')) {
    providedToken = authHeader.slice(7).trim();
  } else if (tokenHeader) {
    providedToken = tokenHeader.trim();
  }

  const claims = providedToken
    ? verifyInternalServiceToken(providedToken, internalToken.trim())
    : null;
  const rawAllowed = process.env['NODE_ENV'] === 'test' && providedToken === internalToken.trim();
  if (!providedToken || (!claims && !rawAllowed)) {
    throw new UsageUnauthorizedError('Missing or invalid service authorization token');
  }
  if (claims) {
    for (const [header, claim] of [
      ['x-tenant-id', claims['tenantId']],
      ['x-user-id', claims['userId']],
      ['x-request-id', claims['requestId']],
      ['x-correlation-id', claims['correlationId']],
    ] as const) {
      if (claim !== req.headers[header]) {
        throw new UsageUnauthorizedError('Signed request context mismatch');
      }
    }
  }
}

export function validateTenantHeader(context: RequestContext): string {
  if (!context.tenantId || context.tenantId.trim().length === 0) {
    throw new UsageValidationError('Missing mandatory X-Tenant-ID header');
  }
  return context.tenantId.trim();
}
