import { createInternalServiceToken } from '../jwt/internal-service-token.js';
import type { UsageAdmissionPort } from '../../application/ports/usage-admission.port.js';
import { BadGatewayError, RateLimitedError } from '../../domain/index.js';

export class HttpUsageAdmissionClient implements UsageAdmissionPort {
  constructor(
    private readonly baseUrl: string,
    private readonly secret?: string,
  ) {}

  async checkHealth(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl.replace(/\/+$/, '')}/health/readiness`, {
        signal: AbortSignal.timeout(5000),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  async acquire(
    input: Parameters<UsageAdmissionPort['acquire']>[0],
  ): Promise<{ leaseId?: string }> {
    const response = await this.call(
      '/internal/v1/usage/admissions',
      input,
      {
        tenantId: input.tenantId,
        userId: input.userId,
        stream: input.stream,
      },
      input.signal,
    );
    const data = (response as { data?: { leaseId?: string | null; allowed?: boolean } }).data;
    if (data?.allowed !== true) throw new RateLimitedError('Usage admission was not granted');
    return data?.leaseId ? { leaseId: data.leaseId } : {};
  }

  async release(input: Parameters<UsageAdmissionPort['release']>[0]): Promise<void> {
    await this.call('/internal/v1/usage/admissions/release', input, {
      tenantId: input.tenantId,
      userId: input.userId,
      leaseId: input.leaseId,
    });
  }

  private async call(
    path: string,
    context: { tenantId: string; userId: string; requestId: string; correlationId: string },
    body: unknown,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-Service-Name': 'api-gateway',
      'X-Tenant-ID': context.tenantId,
      'X-User-ID': context.userId,
      'X-Request-ID': context.requestId,
      'X-Correlation-ID': context.correlationId,
    };
    if (this.secret)
      headers.Authorization = `Bearer ${createInternalServiceToken({
        issuer: 'api-gateway',
        audience: 'platform-usage',
        secret: this.secret,
        tenantId: context.tenantId,
        userId: context.userId,
        requestId: context.requestId,
        correlationId: context.correlationId,
      })}`;
    const response = await fetch(`${this.baseUrl.replace(/\/+$/, '')}${path}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      ...(signal ? { signal } : {}),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = payload as { error?: { code?: string; message?: string } };
      if (response.status === 429) {
        throw new RateLimitedError(error.error?.message, error.error?.code);
      }
      throw new BadGatewayError(error.error?.message ?? 'Usage admission service rejected request');
    }
    return payload;
  }
}
