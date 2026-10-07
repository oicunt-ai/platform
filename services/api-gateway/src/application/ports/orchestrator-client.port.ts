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
}

export interface OrchestratorClientPort {
  /**
   * Forwards a unary completion request downstream to the AI Orchestrator service
   * injecting trusted internal headers (X-Request-ID, X-Correlation-ID, X-User-ID, X-Tenant-ID).
   */
  forwardCompletion(request: ForwardCompletionRequest): Promise<ForwardCompletionResponse>;
}
