import http from 'node:http';
import https from 'node:https';
import { URL } from 'node:url';
import { BadGatewayError, GatewayTimeoutError } from '../../domain/index.js';
import type {
  ForwardCompletionRequest,
  ForwardCompletionResponse,
  OrchestratorClientPort,
} from '../../application/ports/orchestrator-client.port.js';

import { createInternalServiceToken } from '../jwt/internal-service-token.js';

export interface HttpOrchestratorClientOptions {
  readonly orchestratorBaseUrl: string;
  readonly requestTimeoutMs?: number | undefined;
  readonly internalServiceSecret?: string | undefined;
}

export class HttpOrchestratorClient implements OrchestratorClientPort {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly internalServiceSecret?: string | undefined;

  constructor(options: HttpOrchestratorClientOptions) {
    this.baseUrl = options.orchestratorBaseUrl.replace(/\/+$/, '');
    this.timeoutMs = options.requestTimeoutMs ?? 60000; // 60s default
    this.internalServiceSecret = options.internalServiceSecret;
  }

  async checkHealth(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/health/readiness`, {
        signal: AbortSignal.timeout(Math.min(this.timeoutMs, 5000)),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  async forwardCompletion(request: ForwardCompletionRequest): Promise<ForwardCompletionResponse> {
    const targetUrl = new URL(`${this.baseUrl}/internal/v1/orchestrator/chat`);
    const isHttps = targetUrl.protocol === 'https:';
    const requester = isHttps ? https.request : http.request;

    const payloadBuffer = Buffer.from(JSON.stringify(request.body), 'utf8');

    const isStream =
      typeof request.body === 'object' &&
      request.body !== null &&
      (request.body as Record<string, unknown>)['stream'] === true;

    const headers: Record<string, string | number> = {
      'Content-Type': 'application/json',
      Accept: isStream ? 'text/event-stream, application/json' : 'application/json',
      'Content-Length': payloadBuffer.length,
      'X-Request-ID': request.requestId,
      'X-Correlation-ID': request.correlationId,
      'X-User-ID': request.userId,
      'X-Tenant-ID': request.tenantId,
      'X-Service-Name': 'api-gateway',
    };

    if (this.internalServiceSecret) {
      const token = createInternalServiceToken({
        issuer: 'api-gateway',
        audience: 'ai-orchestrator',
        secret: this.internalServiceSecret,
        expiresInSeconds: 300,
        tenantId: request.tenantId,
        userId: request.userId,
        requestId: request.requestId,
        correlationId: request.correlationId,
      });
      headers['Authorization'] = `Bearer ${token}`;
    }

    return new Promise((resolve, reject) => {
      const clientReq = requester(
        targetUrl,
        {
          method: 'POST',
          headers,
          signal: request.signal,
          timeout: this.timeoutMs,
        },
        (res) => {
          const statusCode = res.statusCode ?? 502;
          const resHeaders = res.headers;
          const contentType = res.headers['content-type'] ?? '';

          if (contentType.includes('text/event-stream')) {
            resolve({
              statusCode,
              headers: resHeaders,
              stream: res,
            });
            return;
          }

          // Buffer unary response body
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => {
            chunks.push(chunk);
          });

          res.on('end', () => {
            const rawBody = Buffer.concat(chunks).toString('utf8');
            let bodyData: unknown = rawBody;
            if (contentType.includes('application/json')) {
              try {
                bodyData = JSON.parse(rawBody);
              } catch {
                bodyData = rawBody;
              }
            }

            resolve({
              statusCode,
              headers: resHeaders,
              bodyData,
            });
          });

          res.on('error', (err) => {
            reject(
              new BadGatewayError(`Error receiving orchestrator response body: ${err.message}`),
            );
          });
        },
      );

      clientReq.on('timeout', () => {
        clientReq.destroy();
        reject(new GatewayTimeoutError(`Orchestrator request timed out after ${this.timeoutMs}ms`));
      });

      clientReq.on('error', (err: NodeJS.ErrnoException) => {
        if (err.name === 'AbortError') {
          reject(new GatewayTimeoutError('Client or gateway aborted the request'));
          return;
        }
        reject(
          new BadGatewayError(
            `Failed to connect to AI Orchestrator at ${this.baseUrl}: ${err.message}`,
          ),
        );
      });

      clientReq.write(payloadBuffer);
      clientReq.end();
    });
  }

  async forwardResource(request: {
    readonly method: 'GET' | 'POST';
    readonly path: string;
    readonly requestId: string;
    readonly correlationId: string;
    readonly userId: string;
    readonly tenantId: string;
    readonly body?: unknown;
    readonly signal?: AbortSignal;
  }): Promise<ForwardCompletionResponse> {
    const targetUrl = new URL(`${this.baseUrl}${request.path}`);
    const requester = targetUrl.protocol === 'https:' ? https.request : http.request;
    const payload =
      request.body === undefined ? undefined : Buffer.from(JSON.stringify(request.body));
    const headers: Record<string, string | number> = {
      Accept: 'application/json',
      'X-Request-ID': request.requestId,
      'X-Correlation-ID': request.correlationId,
      'X-User-ID': request.userId,
      'X-Tenant-ID': request.tenantId,
      'X-Service-Name': 'api-gateway',
    };
    if (payload) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = payload.length;
    }
    if (this.internalServiceSecret) {
      headers['Authorization'] = `Bearer ${createInternalServiceToken({
        issuer: 'api-gateway',
        audience: 'ai-orchestrator',
        secret: this.internalServiceSecret,
        tenantId: request.tenantId,
        userId: request.userId,
        requestId: request.requestId,
        correlationId: request.correlationId,
      })}`;
    }

    return new Promise((resolve, reject) => {
      const clientReq = requester(
        targetUrl,
        { method: request.method, headers, signal: request.signal, timeout: this.timeoutMs },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => {
            const raw = Buffer.concat(chunks).toString('utf8');
            try {
              resolve({
                statusCode: res.statusCode ?? 502,
                headers: res.headers,
                bodyData: JSON.parse(raw),
              });
            } catch {
              resolve({ statusCode: res.statusCode ?? 502, headers: res.headers, bodyData: raw });
            }
          });
        },
      );
      clientReq.on('timeout', () => clientReq.destroy(new Error('Orchestrator request timed out')));
      clientReq.on('error', (error) => reject(new BadGatewayError(error.message)));
      if (payload) clientReq.write(payload);
      clientReq.end();
    });
  }
}
