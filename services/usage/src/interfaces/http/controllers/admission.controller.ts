import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DatabasePool } from '../../../infrastructure/database/connection.js';
import {
  UsageError,
  UsageTenantMismatchError,
  UsageValidationError,
} from '../../../domain/errors.js';
import type { RequestContext } from '../context.js';
import { readJsonBody, sendJsonResponse } from '../middleware.js';

export interface AdmissionLimits {
  readonly tenantRequestsPerMinute: number;
  readonly userRequestsPerMinute: number;
  readonly tenantConcurrentStreams: number;
  readonly leaseSeconds: number;
}

export class AdmissionController {
  constructor(
    private readonly db: DatabasePool,
    private readonly limits: AdmissionLimits,
  ) {}

  async acquire(req: IncomingMessage, res: ServerResponse, context: RequestContext): Promise<void> {
    const body = await readJsonBody<{ tenantId?: string; userId?: string; stream?: boolean }>(req);
    if (!body.tenantId || !body.userId)
      throw new UsageValidationError('tenantId and userId are required');
    if (context.tenantId && context.tenantId !== body.tenantId) {
      throw new UsageTenantMismatchError(context.tenantId, body.tenantId);
    }
    const leaseId = `adm_${randomUUID()}`;
    const retryAfterSeconds = 60 - new Date().getUTCSeconds();
    await this.db.withTransaction(async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [body.tenantId]);
      await client.query('DELETE FROM oicunt_usage.admission_leases WHERE expires_at <= NOW()');
      await this.incrementWindow(
        client,
        'tenant',
        body.tenantId!,
        this.limits.tenantRequestsPerMinute,
      );
      await this.incrementWindow(
        client,
        'user',
        `${body.tenantId}:${body.userId}`,
        this.limits.userRequestsPerMinute,
      );
      if (body.stream) {
        const active = await client.query<{ count: string }>(
          'SELECT COUNT(*)::text AS count FROM oicunt_usage.admission_leases WHERE tenant_id = $1 AND expires_at > NOW()',
          [body.tenantId],
        );
        if (Number(active.rows[0]?.count ?? 0) >= this.limits.tenantConcurrentStreams) {
          throw new UsageError('Concurrent stream limit reached', 'CONCURRENCY_LIMITED', 429, {
            retryAfterSeconds: this.limits.leaseSeconds,
          });
        }
        await client.query(
          `INSERT INTO oicunt_usage.admission_leases
           (id, tenant_id, user_id, expires_at) VALUES ($1, $2, $3, NOW() + ($4 * INTERVAL '1 second'))`,
          [leaseId, body.tenantId, body.userId, this.limits.leaseSeconds],
        );
      }
    });
    sendJsonResponse(
      res,
      201,
      {
        allowed: true,
        leaseId: body.stream ? leaseId : null,
        retryAfter: retryAfterSeconds,
      },
      context,
    );
  }

  async release(req: IncomingMessage, res: ServerResponse, context: RequestContext): Promise<void> {
    const body = await readJsonBody<{ leaseId?: string; tenantId?: string }>(req);
    if (!body.leaseId || !body.tenantId)
      throw new UsageValidationError('leaseId and tenantId are required');
    if (context.tenantId && context.tenantId !== body.tenantId)
      throw new UsageTenantMismatchError(context.tenantId, body.tenantId);
    await this.db.query(
      'DELETE FROM oicunt_usage.admission_leases WHERE id = $1 AND tenant_id = $2',
      [body.leaseId, body.tenantId],
    );
    sendJsonResponse(res, 200, { released: true }, context);
  }

  private async incrementWindow(
    client: { query: (sql: string, params?: unknown[]) => Promise<{ rowCount: number | null }> },
    scopeType: string,
    scopeId: string,
    limit: number,
  ): Promise<void> {
    const result = await client.query(
      `INSERT INTO oicunt_usage.admission_windows (scope_type, scope_id, window_start, request_count)
       VALUES ($1, $2, date_trunc('minute', NOW()), 1)
       ON CONFLICT (scope_type, scope_id, window_start) DO UPDATE
       SET request_count = oicunt_usage.admission_windows.request_count + 1
       WHERE oicunt_usage.admission_windows.request_count < $3`,
      [scopeType, scopeId, limit],
    );
    if (result.rowCount === 0)
      throw new UsageError('Request rate limit reached', 'RATE_LIMITED', 429, {
        retryAfterSeconds: 60,
      });
  }
}
