import { afterEach, describe, expect, it, vi } from 'vitest';
import { HttpUsageAdmissionClient } from '../../src/infrastructure/clients/http-usage-admission.client.js';
import { RateLimitedError } from '../../src/domain/index.js';

describe('HttpUsageAdmissionClient - Unit Tests', () => {
  const baseInput = {
    tenantId: 'tenant-lease-corp',
    userId: 'usr_owner',
    requestId: 'req-1',
    correlationId: 'corr-1',
  };

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends the user ID in the release body so the server can enforce ownership', async () => {
    let capturedUrl = '';
    let capturedBody: unknown;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: { body?: string }) => {
        capturedUrl = url;
        capturedBody = JSON.parse(init.body as string);
        return { ok: true, json: async () => ({ data: { released: true } }) };
      }),
    );

    const client = new HttpUsageAdmissionClient('http://usage.test', 'test-secret');
    await client.release({ ...baseInput, leaseId: 'adm_123' });

    expect(capturedUrl).toBe('http://usage.test/internal/v1/usage/admissions/release');
    expect(capturedBody).toEqual({
      tenantId: 'tenant-lease-corp',
      userId: 'usr_owner',
      leaseId: 'adm_123',
    });
  });

  it('returns the lease ID granted by acquisition', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ data: { allowed: true, leaseId: 'adm_456' } }),
      })),
    );

    const client = new HttpUsageAdmissionClient('http://usage.test', 'test-secret');
    const result = await client.acquire({ ...baseInput, stream: true });
    expect(result).toEqual({ leaseId: 'adm_456' });
  });

  it('maps admission denial to RateLimitedError', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 429,
        json: async () => ({ error: { code: 'RATE_LIMITED', message: 'slow down' } }),
      })),
    );

    const client = new HttpUsageAdmissionClient('http://usage.test', 'test-secret');
    await expect(client.acquire({ ...baseInput, stream: false })).rejects.toBeInstanceOf(
      RateLimitedError,
    );
  });
});
