import { afterEach, describe, expect, it, vi } from 'vitest';
import { HttpUsageAdmissionClient } from '../../src/infrastructure/clients/http-usage-admission.client.js';
import { BadGatewayError, GatewayTimeoutError, RateLimitedError } from '../../src/domain/index.js';

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

  it('1. maps connection refusal to BadGatewayError without leaking transport details', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('fetch failed: ECONNREFUSED 127.0.0.1:8090');
      }),
    );

    const client = new HttpUsageAdmissionClient('http://usage.test', 'test-secret');
    const failure = await client.acquire({ ...baseInput, stream: false }).then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(BadGatewayError);
    expect((failure as Error).message).not.toContain('127.0.0.1');
    expect((failure as Error).message).not.toContain('ECONNREFUSED');
    expect((failure as Error).message).not.toContain('test-secret');
  });

  it('2. bounds a hung admission acquire with GatewayTimeoutError', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init: { signal?: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener('abort', () => {
              reject(new DOMException('This operation was aborted', 'AbortError'));
            });
          }),
      ),
    );

    const client = new HttpUsageAdmissionClient('http://usage.test', 'test-secret', 30);
    const started = Date.now();
    await expect(client.acquire({ ...baseInput, stream: false })).rejects.toBeInstanceOf(
      GatewayTimeoutError,
    );
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('3. propagates caller abort without converting it into an admission decision', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init: { signal?: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            if (init.signal?.aborted) {
              reject(new DOMException('This operation was aborted', 'AbortError'));
              return;
            }
            init.signal?.addEventListener('abort', () => {
              reject(new DOMException('This operation was aborted', 'AbortError'));
            });
          }),
      ),
    );

    const client = new HttpUsageAdmissionClient('http://usage.test', 'test-secret', 5000);
    const controller = new AbortController();
    const pending = client.acquire({ ...baseInput, stream: false, signal: controller.signal });
    controller.abort();
    const failure = await pending.then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(DOMException);
    expect(failure).not.toBeInstanceOf(BadGatewayError);
    expect(failure).not.toBeInstanceOf(GatewayTimeoutError);
  });

  it('4. keeps the RateLimitedError contract with expected code', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 429,
        json: async () => ({ error: { code: 'RATE_LIMITED', message: 'slow down' } }),
      })),
    );

    const client = new HttpUsageAdmissionClient('http://usage.test', 'test-secret');
    const failure = await client.acquire({ ...baseInput, stream: false }).then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(RateLimitedError);
    expect((failure as RateLimitedError).code).toBe('RATE_LIMITED');
    expect((failure as { statusCode: number }).statusCode).toBe(429);
  });

  it('5. returns the lease ID granted by a successful acquire', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ data: { allowed: true, leaseId: 'adm_456' } }),
      })),
    );

    const client = new HttpUsageAdmissionClient('http://usage.test', 'test-secret');
    await expect(client.acquire({ ...baseInput, stream: true })).resolves.toEqual({
      leaseId: 'adm_456',
    });
  });

  it('6. preserves successful release behavior', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ data: { released: true } }),
      })),
    );

    const client = new HttpUsageAdmissionClient('http://usage.test', 'test-secret');
    await expect(client.release({ ...baseInput, leaseId: 'adm_123' })).resolves.toBeUndefined();
  });

  it('7. maps non-429 upstream errors to BadGatewayError', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 500,
        json: async () => ({ error: { code: 'INTERNAL', message: 'usage exploded' } }),
      })),
    );

    const client = new HttpUsageAdmissionClient('http://usage.test', 'test-secret');
    const failure = await client.acquire({ ...baseInput, stream: false }).then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(BadGatewayError);
  });

  it('8. never retries after transport uncertainty', async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error('fetch failed: socket hangup');
    });
    vi.stubGlobal('fetch', fetchMock);

    const client = new HttpUsageAdmissionClient('http://usage.test', 'test-secret');
    await expect(client.acquire({ ...baseInput, stream: false })).rejects.toBeInstanceOf(
      BadGatewayError,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('9. bounds release failures instead of hanging the finalizer', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        () =>
          new Promise(() => {
            // Never settles: the client timeout must bound it.
          }),
      ),
    );

    const client = new HttpUsageAdmissionClient('http://usage.test', 'test-secret', 30);
    const started = Date.now();
    await expect(client.release({ ...baseInput, leaseId: 'adm_123' })).rejects.toBeInstanceOf(
      GatewayTimeoutError,
    );
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('10. leaks no credential or transport detail in public errors', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('fetch failed: ECONNREFUSED 127.0.0.1:8090 (token test-secret)');
      }),
    );

    const client = new HttpUsageAdmissionClient('http://usage.test', 'super-secret-value');
    const failure = (await client.acquire({ ...baseInput, stream: false }).then(
      () => null,
      (error: unknown) => error,
    )) as Error;
    expect(failure).toBeInstanceOf(BadGatewayError);
    expect(failure.message).not.toContain('127.0.0.1');
    expect(failure.message).not.toContain('8090');
    expect(failure.message).not.toContain('super-secret-value');
    expect(failure.message).not.toContain('ECONNREFUSED');
  });

  it('11. bounds a stalled response body with GatewayTimeoutError', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: () => new Promise(() => {}),
      })),
    );

    const client = new HttpUsageAdmissionClient('http://usage.test', 'test-secret', 30);
    const started = Date.now();
    await expect(client.acquire({ ...baseInput, stream: false })).rejects.toBeInstanceOf(
      GatewayTimeoutError,
    );
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('12. bounds a stalled release body instead of hanging the finalizer', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: () => new Promise(() => {}),
      })),
    );

    const client = new HttpUsageAdmissionClient('http://usage.test', 'test-secret', 30);
    await expect(client.release({ ...baseInput, leaseId: 'adm_123' })).rejects.toBeInstanceOf(
      GatewayTimeoutError,
    );
  });

  it('13. propagates caller abort during body reading without converting it', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: () => new Promise(() => {}),
      })),
    );

    const client = new HttpUsageAdmissionClient('http://usage.test', 'test-secret', 5000);
    const controller = new AbortController();
    const pending = client.acquire({ ...baseInput, stream: false, signal: controller.signal });
    await new Promise((resolve) => setTimeout(resolve, 10));
    controller.abort();
    const failure = await pending.then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).not.toBeInstanceOf(GatewayTimeoutError);
    expect(failure).not.toBeInstanceOf(BadGatewayError);
    expect(failure).not.toBeInstanceOf(RateLimitedError);
  });

  it('14. performs no dependency operation when already aborted', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ data: { allowed: true } }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    const client = new HttpUsageAdmissionClient('http://usage.test', 'test-secret');
    const controller = new AbortController();
    controller.abort();
    await expect(
      client.acquire({ ...baseInput, stream: false, signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('15. maps successful status with invalid JSON to BadGatewayError', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => {
          throw new Error('unexpected token');
        },
      })),
    );

    const client = new HttpUsageAdmissionClient('http://usage.test', 'test-secret');
    await expect(client.acquire({ ...baseInput, stream: false })).rejects.toBeInstanceOf(
      BadGatewayError,
    );
  });

  it('16. maps successful status with missing allowed flag to BadGatewayError', async () => {
    for (const body of [{}, { data: {} }, { data: { allowed: false } }]) {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => ({ ok: true, status: 200, json: async () => body })),
      );
      const client = new HttpUsageAdmissionClient('http://usage.test', 'test-secret');
      await expect(client.acquire({ ...baseInput, stream: false })).rejects.toBeInstanceOf(
        BadGatewayError,
      );
    }
  });

  it('17. maps stream success without a valid lease to BadGatewayError', async () => {
    for (const body of [
      { data: { allowed: true } },
      { data: { allowed: true, leaseId: '' } },
      { data: { allowed: true, leaseId: 42 } },
    ]) {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => ({ ok: true, status: 200, json: async () => body })),
      );
      const client = new HttpUsageAdmissionClient('http://usage.test', 'test-secret');
      await expect(client.acquire({ ...baseInput, stream: true })).rejects.toBeInstanceOf(
        BadGatewayError,
      );
    }
  });

  it('18. maps release success without confirmation to BadGatewayError', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) })),
    );

    const client = new HttpUsageAdmissionClient('http://usage.test', 'test-secret');
    await expect(client.release({ ...baseInput, leaseId: 'adm_123' })).rejects.toBeInstanceOf(
      BadGatewayError,
    );
  });

  it('19. stays usable after timeouts with no stranded settlement', async () => {
    let hanging = true;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        if (hanging) {
          await new Promise(() => {});
        }
        return { ok: true, status: 200, json: async () => ({ data: { allowed: true } }) };
      }),
    );

    const client = new HttpUsageAdmissionClient('http://usage.test', 'test-secret', 30);
    await expect(client.acquire({ ...baseInput, stream: false })).rejects.toBeInstanceOf(
      GatewayTimeoutError,
    );
    await expect(client.acquire({ ...baseInput, stream: false })).rejects.toBeInstanceOf(
      GatewayTimeoutError,
    );
    hanging = false;
    await expect(client.acquire({ ...baseInput, stream: false })).resolves.toEqual({});
  });
});
