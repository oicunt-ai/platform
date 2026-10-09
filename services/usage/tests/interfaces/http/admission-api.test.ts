import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { UsageService } from '../../../src/service.js';
import type { DatabasePool } from '../../../src/infrastructure/database/connection.js';
import { InMemoryUsageRepository } from '../../../src/infrastructure/repositories/in-memory-usage.repository.js';
import { createInternalServiceToken } from '../../../../api-gateway/src/infrastructure/jwt/internal-service-token.js';

interface FakeLease {
  id: string;
  tenantId: string;
  userId: string;
  expiresAt: number;
}

/**
 * In-memory stand-in for DatabasePool that emulates exactly the SQL statements
 * issued by AdmissionController (advisory lock, expiry purge, window upserts
 * with limits, lease count/insert/select/delete). No database is touched.
 */
class FakeAdmissionPool {
  public leases = new Map<string, FakeLease>();
  private windows = new Map<string, number>();

  public async query(
    text: string,
    params: unknown[] = [],
  ): Promise<{ rows: any[]; rowCount: number | null }> {
    const sql = text.replace(/\s+/g, ' ');
    if (sql.includes('pg_advisory_xact_lock')) return { rows: [], rowCount: null };
    if (
      sql.includes('DELETE FROM oicunt_usage.admission_leases WHERE expires_at <= NOW()') &&
      !sql.includes('AND tenant_id')
    ) {
      const now = Date.now();
      let removed = 0;
      for (const [id, lease] of this.leases) {
        if (lease.expiresAt <= now) {
          this.leases.delete(id);
          removed += 1;
        }
      }
      return { rows: [], rowCount: removed };
    }
    if (sql.includes('INSERT INTO oicunt_usage.admission_windows')) {
      const [scopeType, scopeId, limit] = params as [string, string, number];
      const key = `${scopeType}|${scopeId}|${Math.floor(Date.now() / 60000)}`;
      const current = this.windows.get(key) ?? 0;
      if (current >= limit) return { rows: [], rowCount: 0 };
      this.windows.set(key, current + 1);
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes('SELECT COUNT(*)') && sql.includes('admission_leases')) {
      const [tenantId] = params as [string];
      const now = Date.now();
      const count = [...this.leases.values()].filter(
        (lease) => lease.tenantId === tenantId && lease.expiresAt > now,
      ).length;
      return { rows: [{ count: String(count) }], rowCount: 1 };
    }
    if (sql.includes('INSERT INTO oicunt_usage.admission_leases')) {
      const [id, tenantId, userId, leaseSeconds] = params as [string, string, string, number];
      this.leases.set(id, {
        id,
        tenantId,
        userId,
        expiresAt: Date.now() + leaseSeconds * 1000,
      });
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes('SELECT user_id, expires_at FROM oicunt_usage.admission_leases')) {
      const [id, tenantId] = params as [string, string];
      const lease = this.leases.get(id);
      if (lease && lease.tenantId === tenantId) {
        return {
          rows: [{ user_id: lease.userId, expires_at: new Date(lease.expiresAt) }],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    }
    if (
      sql.includes('DELETE FROM oicunt_usage.admission_leases WHERE id = $1 AND tenant_id = $2')
    ) {
      const [id, tenantId] = params as [string, string];
      const lease = this.leases.get(id);
      if (lease && lease.tenantId === tenantId) {
        this.leases.delete(id);
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }
    if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
      return { rows: [], rowCount: null };
    }
    if (
      sql.includes('CREATE SCHEMA') ||
      sql.includes('CREATE TABLE') ||
      sql.includes('CREATE INDEX')
    ) {
      // Migration DDL executed by DatabaseMigrator on service start.
      return { rows: [], rowCount: null };
    }
    if (sql.includes('pg_advisory_lock') || sql.includes('pg_advisory_unlock')) {
      return { rows: [{ locked: true }], rowCount: 1 };
    }
    if (sql.includes('FROM oicunt_usage._migrations')) {
      return { rows: [], rowCount: 0 };
    }
    if (sql.includes('INSERT INTO oicunt_usage._migrations')) {
      return { rows: [], rowCount: 1 };
    }
    throw new Error(`FakeAdmissionPool: unexpected statement: ${text}`);
  }

  public async withTransaction<T>(callback: (client: any) => Promise<T>): Promise<T> {
    return callback({ query: (text: string, params?: unknown[]) => this.query(text, params) });
  }

  public async close(): Promise<void> {}
  public async ping(): Promise<boolean> {
    return true;
  }

  public leaseCount(): number {
    return this.leases.size;
  }
}

describe('Usage Admission Lease Ownership', () => {
  let service: UsageService;
  let baseUrl: string;
  const internalToken = 'admission-ownership-test-secret';
  let pool: FakeAdmissionPool;

  const tenant = 'tenant-lease-corp';
  const owner = 'usr_owner';
  const otherUser = 'usr_intruder';
  const otherTenant = 'tenant-other-corp';

  function signedHeaders(
    values: { tenantId?: string; userId?: string; requestId?: string; correlationId?: string },
    overrides?: { secret?: string; serviceName?: string },
  ): Record<string, string> {
    const requestId = values.requestId ?? `req-${values.correlationId ?? 'x'}`;
    const correlationId = values.correlationId ?? 'corr-default';
    const token = createInternalServiceToken({
      serviceName: overrides?.serviceName ?? 'api-gateway',
      audience: 'platform-usage',
      secret: overrides?.secret ?? internalToken,
      tenantId: values.tenantId,
      userId: values.userId,
      requestId,
      correlationId,
    });
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      'X-Service-Name': overrides?.serviceName ?? 'api-gateway',
      'X-Request-ID': requestId,
      'X-Correlation-ID': correlationId,
    };
    if (values.tenantId !== undefined) headers['X-Tenant-ID'] = values.tenantId;
    if (values.userId !== undefined) headers['X-User-ID'] = values.userId;
    return headers;
  }

  async function acquire(
    tenantId: string,
    userId: string,
    correlationId: string,
  ): Promise<{ status: number; leaseId: string | null | undefined }> {
    const res = await fetch(`${baseUrl}/internal/v1/usage/admissions`, {
      method: 'POST',
      headers: signedHeaders({ tenantId, userId, correlationId }),
      body: JSON.stringify({ tenantId, userId, stream: true }),
    });
    const body = (await res.json()) as {
      success: boolean;
      data?: { allowed: boolean; leaseId: string | null };
      error?: { code: string; message: string };
    };
    return { status: res.status, leaseId: body.data?.leaseId };
  }

  async function release(
    input: { leaseId: string; tenantId: string; userId?: string },
    identity: { tenantId?: string; userId?: string },
    correlationId: string,
  ): Promise<{ status: number; code: string | undefined; released: boolean | undefined }> {
    const res = await fetch(`${baseUrl}/internal/v1/usage/admissions/release`, {
      method: 'POST',
      headers: signedHeaders({ ...identity, correlationId }),
      body: JSON.stringify(input),
    });
    const body = (await res.json()) as {
      success: boolean;
      data?: { released: boolean };
      error?: { code: string };
    };
    return { status: res.status, code: body.error?.code, released: body.data?.released };
  }

  beforeAll(async () => {
    pool = new FakeAdmissionPool();
    service = new UsageService(
      {
        port: 0,
        host: '127.0.0.1',
        internalToken,
        useDatabase: false,
        useRabbitMq: false,
        logLevel: 'silent',
      },
      {
        repository: new InMemoryUsageRepository(),
        dbPool: pool as unknown as DatabasePool,
      },
    );
    await service.start();
    const address = service.getHttpServer()?.address();
    if (typeof address !== 'object' || address === null) {
      throw new Error('Failed to obtain server address');
    }
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await service.stop();
  });

  it('lets the rightful owner acquire and release a lease', async () => {
    const acquired = await acquire(tenant, owner, 'corr-owner-ok');
    expect(acquired.status).toBe(201);
    expect(acquired.leaseId).toMatch(/^adm_/);

    // Cross-boundary contract: the Gateway client reads response.data.
    const rawAcquire = (await (
      await fetch(`${baseUrl}/internal/v1/usage/admissions`, {
        method: 'POST',
        headers: signedHeaders({ tenantId: tenant, userId: owner, correlationId: 'corr-envelope' }),
        body: JSON.stringify({ tenantId: tenant, userId: owner, stream: true }),
      })
    ).json()) as { success: boolean; data: { allowed: boolean; leaseId: string | null } };
    expect(rawAcquire.success).toBe(true);
    expect(rawAcquire.data.allowed).toBe(true);
    expect(rawAcquire.data.leaseId).toMatch(/^adm_/);
    const probeCleanup = await release(
      { leaseId: rawAcquire.data.leaseId!, tenantId: tenant, userId: owner },
      { tenantId: tenant, userId: owner },
      'corr-envelope-cleanup',
    );
    expect(probeCleanup.status).toBe(200);

    const result = await release(
      { leaseId: acquired.leaseId!, tenantId: tenant, userId: owner },
      { tenantId: tenant, userId: owner },
      'corr-release-ok',
    );
    expect(result.status).toBe(200);
    expect(result.released).toBe(true);
    expect(pool.leaseCount()).toBe(0);
  });

  it('rejects release by a different user in the same tenant without mutating the lease', async () => {
    const acquired = await acquire(tenant, owner, 'corr-owner-victim');
    expect(acquired.status).toBe(201);

    const result = await release(
      { leaseId: acquired.leaseId!, tenantId: tenant, userId: otherUser },
      { tenantId: tenant, userId: otherUser },
      'corr-intruder',
    );
    expect(result.status).toBe(403);
    expect(result.code).toBe('FORBIDDEN');
    expect(pool.leaseCount()).toBe(1);

    const ownerResult = await release(
      { leaseId: acquired.leaseId!, tenantId: tenant, userId: owner },
      { tenantId: tenant, userId: owner },
      'corr-owner-after',
    );
    expect(ownerResult.status).toBe(200);
    expect(pool.leaseCount()).toBe(0);
  });

  it('rejects release from a different tenant', async () => {
    const acquired = await acquire(tenant, owner, 'corr-owner-tenant');
    expect(acquired.status).toBe(201);

    // Caller authenticated as `tenant` tries to address another tenant's scope.
    const result = await release(
      { leaseId: acquired.leaseId!, tenantId: otherTenant, userId: owner },
      { tenantId: tenant, userId: owner },
      'corr-other-tenant',
    );
    expect(result.status).toBe(403);
    expect(result.code).toBe('TENANT_MISMATCH');
    expect(pool.leaseCount()).toBe(1);

    const ownerResult = await release(
      { leaseId: acquired.leaseId!, tenantId: tenant, userId: owner },
      { tenantId: tenant, userId: owner },
      'corr-owner-tenant-ok',
    );
    expect(ownerResult.status).toBe(200);
  });

  it('rejects release with a mismatched signed user identity', async () => {
    const acquired = await acquire(tenant, owner, 'corr-owner-spoof');
    expect(acquired.status).toBe(201);

    // Body claims the owner, but the signed token belongs to someone else.
    const token = createInternalServiceToken({
      serviceName: 'api-gateway',
      audience: 'platform-usage',
      secret: internalToken,
      tenantId: tenant,
      userId: otherUser,
      requestId: 'req-spoof',
      correlationId: 'corr-spoof',
    });
    const res = await fetch(`${baseUrl}/internal/v1/usage/admissions/release`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        'X-Service-Name': 'api-gateway',
        'X-Tenant-ID': tenant,
        'X-User-ID': otherUser,
        'X-Request-ID': 'req-spoof',
        'X-Correlation-ID': 'corr-spoof',
      },
      body: JSON.stringify({ leaseId: acquired.leaseId!, tenantId: tenant, userId: owner }),
    });
    const body = (await res.json()) as { error?: { code: string } };
    expect(res.status).toBe(403);
    expect(body.error?.code).toBe('FORBIDDEN');
    expect(pool.leaseCount()).toBe(1);

    const ownerResult = await release(
      { leaseId: acquired.leaseId!, tenantId: tenant, userId: owner },
      { tenantId: tenant, userId: owner },
      'corr-owner-spoof-ok',
    );
    expect(ownerResult.status).toBe(200);
  });

  it('rejects release without authentication', async () => {
    const res = await fetch(`${baseUrl}/internal/v1/usage/admissions/release`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ leaseId: 'adm_missing', tenantId: tenant, userId: owner }),
    });
    expect(res.status).toBe(401);
  });

  it('returns 404 for unknown lease IDs', async () => {
    const result = await release(
      { leaseId: 'adm_does_not_exist', tenantId: tenant, userId: owner },
      { tenantId: tenant, userId: owner },
      'corr-unknown',
    );
    expect(result.status).toBe(404);
    expect(result.code).toBe('NOT_FOUND');
  });

  it('returns 404 on duplicate release after a successful release', async () => {
    const acquired = await acquire(tenant, owner, 'corr-dup');
    expect(acquired.status).toBe(201);

    const first = await release(
      { leaseId: acquired.leaseId!, tenantId: tenant, userId: owner },
      { tenantId: tenant, userId: owner },
      'corr-dup-first',
    );
    expect(first.status).toBe(200);

    const second = await release(
      { leaseId: acquired.leaseId!, tenantId: tenant, userId: owner },
      { tenantId: tenant, userId: owner },
      'corr-dup-second',
    );
    expect(second.status).toBe(404);
    expect(second.code).toBe('NOT_FOUND');
  });

  it('rejects release bodies missing the user ID', async () => {
    const res = await fetch(`${baseUrl}/internal/v1/usage/admissions/release`, {
      method: 'POST',
      headers: signedHeaders({ tenantId: tenant, userId: owner, correlationId: 'corr-nouser' }),
      body: JSON.stringify({ leaseId: 'adm_x', tenantId: tenant }),
    });
    expect(res.status).toBe(400);
  });

  it('rejects acquire when the signed user does not match the requested user', async () => {
    const token = createInternalServiceToken({
      serviceName: 'api-gateway',
      audience: 'platform-usage',
      secret: internalToken,
      tenantId: tenant,
      userId: otherUser,
      requestId: 'req-acq-spoof',
      correlationId: 'corr-acq-spoof',
    });
    const res = await fetch(`${baseUrl}/internal/v1/usage/admissions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        'X-Service-Name': 'api-gateway',
        'X-Tenant-ID': tenant,
        'X-User-ID': otherUser,
        'X-Request-ID': 'req-acq-spoof',
        'X-Correlation-ID': 'corr-acq-spoof',
      },
      body: JSON.stringify({ tenantId: tenant, userId: owner, stream: false }),
    });
    expect(res.status).toBe(403);
  });
});
