import http from 'node:http';
import https from 'node:https';
import { URL } from 'node:url';
import { BadGatewayError, GatewayTimeoutError } from '../../domain/index.js';
import type {
  ForwardCompletionRequest,
  ForwardCompletionResponse,
  OrchestratorClientPort,
} from '../../application/ports/orchestrator-client.port.js';

export interface HttpOrchestratorClientOptions {
  readonly orchestratorBaseUrl: string;
  readonly requestTimeoutMs?: number | undefined;
}

export class HttpOrchestratorClient implements OrchestratorClientPort {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(options: HttpOrchestratorClientOptions) {
    this.baseUrl = options.orchestratorBaseUrl.replace(/\/+$/, '');
    this.timeoutMs = options.requestTimeoutMs ?? 60000; // 60s default
  }

  async forwardCompletion(request: ForwardCompletionRequest): Promise<ForwardCompletionResponse> {
    const targetUrl = new URL(`${this.baseUrl}/internal/v1/orchestrator/chat`);
    const isHttps = targetUrl.protocol === 'https:';
    const requester = isHttps ? https.request : http.request;

    const payloadBuffer = Buffer.from(JSON.stringify(request.body), 'utf8');

    const headers: Record<string, string | number> = {
      'Content-Type': 'application/json',
      'Content-Length': payloadBuffer.length,
      'X-Request-ID': request.requestId,
      'X-Correlation-ID': request.correlationId,
      'X-User-ID': request.userId,
      'X-Tenant-ID': request.tenantId,
      'X-Service-Name': 'api-gateway',
    };

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
}
