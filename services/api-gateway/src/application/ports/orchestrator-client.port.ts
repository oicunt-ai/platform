import type { IncomingHttpHeaders } from 'node:http';

export interface ForwardCompletionRequest {
  readonly requestId: string;
  readonly correlationId: string;
  readonly userId: string;
  readonly tenantId: string;
  readonly body: unknown;
  readonly signal?: AbortSignal | undefined;
}

export interface ForwardCompletionResponse {
  readonly statusCode: number;
  readonly headers: IncomingHttpHeaders;
  readonly bodyData?: unknown | undefined;
  readonly stream?: NodeJS.ReadableStream | undefined;
}

export interface OrchestratorClientPort {
  checkHealth?(): Promise<boolean>;
  forwardResource?(request: {
    readonly method: 'GET' | 'POST';
    readonly path: string;
    readonly requestId: string;
    readonly correlationId: string;
    readonly userId: string;
    readonly tenantId: string;
    readonly body?: unknown;
    readonly signal?: AbortSignal | undefined;
  }): Promise<ForwardCompletionResponse>;
  /**
   * Forwards a unary completion request downstream to the AI Orchestrator service
   * injecting trusted internal headers (X-Request-ID, X-Correlation-ID, X-User-ID, X-Tenant-ID).
   */
  forwardCompletion(request: ForwardCompletionRequest): Promise<ForwardCompletionResponse>;
}
