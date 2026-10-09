import type { IncomingMessage, ServerResponse } from 'node:http';
import { once } from 'node:events';
import type {
  AuthenticateTokenUseCase,
  ForwardCompletionUseCase,
} from '../../../application/index.js';
import type { UsageAdmissionPort } from '../../../application/ports/usage-admission.port.js';
import { type GatewayRequestContext, handleHttpError, parseJsonBody } from '../middleware.js';
import { normalizePublicAiError } from '../public-ai-error.js';

export class CompletionController {
  constructor(
    private readonly authenticateUseCase: AuthenticateTokenUseCase,
    private readonly forwardCompletionUseCase: ForwardCompletionUseCase,
    private readonly admission?: UsageAdmissionPort,
  ) {}

  async handleCompletion(
    req: IncomingMessage,
    res: ServerResponse,
    context: GatewayRequestContext,
  ): Promise<void> {
    const abortController = new AbortController();

    res.on('close', () => {
      if (!res.writableEnded) {
        abortController.abort();
      }
    });

    let leaseId: string | undefined;
    let identity: { tenantId: string; userId: string } | undefined;
    try {
      // 1. Authenticate Bearer JWT
      const authHeader = req.headers['authorization'];
      const authResult = await this.authenticateUseCase.execute({
        authHeader: typeof authHeader === 'string' ? authHeader : undefined,
      });

      if (!authResult.ok) {
        handleHttpError(res, authResult.error, context);
        return;
      }

      context.identity = authResult.value;
      identity = authResult.value;

      // 2. Parse request JSON body
      const body = await parseJsonBody(req);
      if (this.admission) {
        const admission = await this.admission.acquire({
          tenantId: authResult.value.tenantId,
          userId: authResult.value.userId,
          requestId: context.requestId,
          correlationId: context.correlationId,
          stream: Boolean((body as Record<string, unknown>)['stream']),
          signal: abortController.signal,
        });
        leaseId = admission.leaseId;
      }

      // 3. Authorize ('ai:use') & Forward unary completion to AI Orchestrator
      const forwardResult = await this.forwardCompletionUseCase.execute({
        identity: authResult.value,
        requestId: context.requestId,
        correlationId: context.correlationId,
        body,
        signal: abortController.signal,
      });

      if (!forwardResult.ok) {
        handleHttpError(res, forwardResult.error, context);
        return;
      }

      const forwardRes = forwardResult.value;

      // 4. Handle streaming (SSE) response
      if (forwardRes.stream) {
        res.writeHead(forwardRes.statusCode, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
          'X-Request-ID': context.requestId,
          'X-Correlation-ID': context.correlationId,
        });
        await this.forwardNormalizedStream(forwardRes.stream, res);
        return;
      }

      // 5. Return unary JSON response to client
      const publicBody =
        forwardRes.statusCode >= 400
          ? normalizePublicAiError(forwardRes.statusCode, forwardRes.bodyData)
          : forwardRes.bodyData;
      const responseData = typeof publicBody === 'string' ? publicBody : JSON.stringify(publicBody);

      res.writeHead(forwardRes.statusCode, {
        'Content-Type': 'application/json; charset=utf-8',
        'X-Request-ID': context.requestId,
        'X-Correlation-ID': context.correlationId,
      });
      res.end(responseData);
    } catch (err) {
      if (!res.headersSent) {
        handleHttpError(res, err, context);
      } else if (!res.writableEnded) {
        res.end();
      }
    } finally {
      if (leaseId && identity && this.admission) {
        await this.admission
          .release({
            tenantId: identity.tenantId,
            userId: identity.userId,
            requestId: context.requestId,
            correlationId: context.correlationId,
            leaseId,
          })
          .catch(() => undefined);
      }
    }
  }

  private async forwardNormalizedStream(
    source: NodeJS.ReadableStream,
    res: ServerResponse,
  ): Promise<void> {
    let buffer = '';
    let terminalSeen = false;
    const iterable = source as NodeJS.ReadableStream & AsyncIterable<Buffer | string>;

    try {
      for await (const chunk of iterable) {
        buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
        buffer = buffer.replace(/\r\n/g, '\n');
        while (true) {
          const boundary = buffer.indexOf('\n\n');
          if (boundary < 0) break;
          const frame = buffer.slice(0, boundary).replace(/\r/g, '');
          buffer = buffer.slice(boundary + 2);
          if (!frame.trim()) continue;

          const eventLine = frame.split('\n').find((line) => line.startsWith('event:'));
          const dataLine = frame.split('\n').find((line) => line.startsWith('data:'));
          const event = eventLine?.slice(6).trim();
          if (!event || !dataLine) throw new Error('Malformed upstream SSE frame');
          if (terminalSeen) throw new Error('Upstream emitted data after a terminal event');

          // Reasoning is deliberately not part of the first public contract.
          if (event === 'thinking') continue;
          if (!['token', 'finish', 'error'].includes(event)) {
            throw new Error(`Unsupported upstream SSE event '${event}'`);
          }

          let data: unknown;
          try {
            data = JSON.parse(dataLine.slice(5).trim());
          } catch {
            throw new Error('Malformed upstream SSE JSON payload');
          }
          if (!data || typeof data !== 'object' || Array.isArray(data)) {
            throw new Error('Invalid upstream SSE payload');
          }

          const record = data as Record<string, unknown>;
          if (event === 'token' && typeof record['delta'] !== 'string') {
            throw new Error('Invalid token event payload');
          }
          if (event === 'token') this.assertAllowedFields(record, ['delta']);
          if (event === 'finish') {
            this.assertAllowedFields(record, ['finishReason', 'usage']);
            const usage = this.asRecord(record['usage']);
            if (
              typeof record['finishReason'] !== 'string' ||
              !['promptTokens', 'completionTokens', 'totalTokens'].every(
                (key) => typeof usage[key] === 'number' && Number.isFinite(usage[key]),
              )
            )
              throw new Error('Invalid finish event payload');
            // Project only the public contract fields. Provider-specific
            // measurements (e.g. reasoningTokens, cachedTokens) are valid
            // upstream but must neither leak nor fail the public stream.
            data = {
              finishReason: record['finishReason'],
              usage: {
                promptTokens: usage['promptTokens'],
                completionTokens: usage['completionTokens'],
                totalTokens: usage['totalTokens'],
              },
            };
          }
          if (
            event === 'error' &&
            (typeof record['code'] !== 'string' || typeof record['message'] !== 'string')
          ) {
            throw new Error('Invalid error event payload');
          }
          if (event === 'error') this.assertAllowedFields(record, ['code', 'message']);

          terminalSeen = event === 'finish' || event === 'error';
          const safeData =
            event === 'error'
              ? { code: record['code'], message: 'The response stream could not be completed.' }
              : data;
          if (!res.write(`event: ${event}\ndata: ${JSON.stringify(safeData)}\n\n`)) {
            await once(res, 'drain');
          }
        }
      }
    } catch {
      if (!terminalSeen && !res.writableEnded) {
        terminalSeen = true;
        res.write(
          `event: error\ndata: ${JSON.stringify({ code: 'STREAM_PROTOCOL_ERROR', message: 'The response stream could not be completed.' })}\n\n`,
        );
      }
    }

    if (!terminalSeen && !res.writableEnded) {
      res.write(
        `event: error\ndata: ${JSON.stringify({ code: 'STREAM_INTERRUPTED', message: 'The response stream ended unexpectedly.' })}\n\n`,
      );
    }
    if (!res.writableEnded) res.end();
  }

  private assertAllowedFields(record: Record<string, unknown>, allowed: readonly string[]): void {
    if (Object.keys(record).some((key) => !allowed.includes(key))) {
      throw new Error('Upstream SSE payload contains unsupported fields');
    }
  }

  private asRecord(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('Invalid upstream SSE payload');
    }
    return value as Record<string, unknown>;
  }
}
