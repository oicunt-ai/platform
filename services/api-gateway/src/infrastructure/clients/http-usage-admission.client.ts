import { createInternalServiceToken } from '../jwt/internal-service-token.js';
import type { UsageAdmissionPort } from '../../application/ports/usage-admission.port.js';
import { BadGatewayError, GatewayTimeoutError, RateLimitedError } from '../../domain/index.js';

/** Default upper bound for one admission dependency call (matches health check). */
const DEFAULT_ADMISSION_TIMEOUT_MS = 5000;

export class HttpUsageAdmissionClient implements UsageAdmissionPort {
  private readonly timeoutMs: number;

  constructor(
    private readonly baseUrl: string,
    private readonly secret?: string,
    timeoutMs?: number,
  ) {
    this.timeoutMs = timeoutMs ?? DEFAULT_ADMISSION_TIMEOUT_MS;
  }

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
    // Strict success contract: HTTP 200 must carry an explicit allowed=true
    // decision. Anything else (missing data, wrong types, allowed:false) is
    // a malformed dependency response, never a rate-limit denial — denials
    // arrive as HTTP 429 and are mapped in call().
    const data: unknown = (response as { data?: unknown }).data;
    if (typeof data !== 'object' || data === null) {
      throw new BadGatewayError('Usage admission returned an invalid response');
    }
    const decision = data as { allowed?: unknown; leaseId?: unknown };
    if (decision.allowed !== true) {
      throw new BadGatewayError('Usage admission returned an invalid response');
    }
    if (input.stream === true) {
      if (typeof decision.leaseId !== 'string' || decision.leaseId.trim() === '') {
        throw new BadGatewayError('Usage admission returned an invalid stream lease');
      }
      return { leaseId: decision.leaseId };
    }
    return {};
  }

  async release(input: Parameters<UsageAdmissionPort['release']>[0]): Promise<void> {
    const response = await this.call('/internal/v1/usage/admissions/release', input, {
      tenantId: input.tenantId,
      userId: input.userId,
      leaseId: input.leaseId,
    });
    const data: unknown = (response as { data?: unknown }).data;
    if (
      typeof data !== 'object' ||
      data === null ||
      (data as { released?: unknown }).released !== true
    ) {
      throw new BadGatewayError('Usage admission returned an invalid response');
    }
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
    // Already cancelled: never start a dependency operation.
    if (signal?.aborted === true) {
      throw signal.reason;
    }
    // One bounded dependency deadline covers response headers AND the full
    // body read, composed with caller cancellation. A stalled Usage service
    // must fail fast rather than hold the completion. Only the transport
    // itself is guarded here: HTTP status and response-contract mapping
    // below run outside the try so intentional errors are never converted
    // into a generic failure.
    const controller = new AbortController();
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeoutGate = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
        reject(new GatewayTimeoutError('Usage admission request timed out'));
      }, this.timeoutMs);
      if (typeof timer.unref === 'function') {
        timer.unref();
      }
    });
    let callerReject: ((reason?: unknown) => void) | null = null;
    const callerGate = signal
      ? new Promise<never>((_resolve, reject) => {
          callerReject = reject;
        })
      : null;
    const onCallerAbort = (): void => {
      controller.abort();
      callerReject?.(signal?.reason);
    };
    if (signal) {
      signal.addEventListener('abort', onCallerAbort, { once: true });
    }
    const settle = (): void => {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      if (signal) {
        signal.removeEventListener('abort', onCallerAbort);
      }
    };
    // Read live on every call: AbortSignal state mutates externally, so it
    // must never be captured by control-flow narrowing at a single point.
    const isCallerAborted = (): boolean => signal?.aborted === true;
    let response: Response;
    try {
      const racers: Array<Promise<unknown>> = [
        fetch(`${this.baseUrl.replace(/\/+$/, '')}${path}`, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal: controller.signal,
        }),
        timeoutGate,
      ];
      if (callerGate !== null) {
        racers.push(callerGate);
      }
      response = (await Promise.race(racers)) as Response;
    } catch (error) {
      settle();
      if (isCallerAborted() && !timedOut) {
        // Caller cancelled first: propagate without converting, and never
        // treat the outcome as an admission decision.
        throw error;
      }
      if (timedOut) {
        throw new GatewayTimeoutError('Usage admission request timed out');
      }
      // Transport failures carry host/port details: never leak them.
      throw new BadGatewayError('Usage admission service is unavailable');
    }
    let payload: unknown;
    try {
      const readers: Array<Promise<unknown>> = [response.json().catch(() => ({})), timeoutGate];
      if (callerGate !== null) {
        readers.push(callerGate);
      }
      payload = await Promise.race(readers);
    } catch (error) {
      settle();
      if (isCallerAborted() && !timedOut) {
        throw error;
      }
      if (timedOut) {
        throw new GatewayTimeoutError('Usage admission request timed out');
      }
      throw new BadGatewayError('Usage admission service is unavailable');
    }
    settle();
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
