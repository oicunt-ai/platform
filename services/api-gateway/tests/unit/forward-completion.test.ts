import { describe, expect, it } from 'vitest';
import {
  ForwardCompletionUseCase,
  createIdentityContext,
  ForbiddenError,
  ValidationError,
  type OrchestratorClientPort,
  type ForwardCompletionRequest,
} from '../../src/index.js';

describe('ForwardCompletionUseCase - Unit Tests', () => {
  const validIdentityWithAiUse = createIdentityContext({
    userId: 'user-001',
    tenantId: 'tenant-abc',
    scopes: ['ai:use'],
  });

  const validIdentityWithoutAiUse = createIdentityContext({
    userId: 'user-002',
    tenantId: 'tenant-abc',
    scopes: ['other:read'],
  });

  const validAiPayload = {
    conversationId: 'conv_123',
    model: 'oicunt.model.catalog-alpha',
    messages: [{ role: 'user', content: 'Hello AI' }],
  };

  it('should reject request when caller lacks ai:use scope', async () => {
    let called = false;
    const mockClient: OrchestratorClientPort = {
      async forwardCompletion() {
        called = true;
        return { statusCode: 200, headers: {} };
      },
    };

    const useCase = new ForwardCompletionUseCase(mockClient);
    const result = await useCase.execute({
      identity: validIdentityWithoutAiUse,
      requestId: 'req-1',
      correlationId: 'corr-1',
      body: validAiPayload,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(ForbiddenError);
      expect(result.error.statusCode).toBe(403);
      expect(result.error.message).toMatch(/ai:use/);
    }
    expect(called).toBe(false);
  });

  it('should accept stream: true payload in Step 5', async () => {
    let called = false;
    const mockClient: OrchestratorClientPort = {
      async forwardCompletion() {
        called = true;
        return { statusCode: 200, headers: {} };
      },
    };

    const useCase = new ForwardCompletionUseCase(mockClient);
    const result = await useCase.execute({
      identity: validIdentityWithAiUse,
      requestId: 'req-1',
      correlationId: 'corr-1',
      body: {
        ...validAiPayload,
        stream: true,
      },
    });

    expect(result.ok).toBe(true);
    expect(called).toBe(true);
  });

  it('should forward effort and exposeReasoning options without dropping them', async () => {
    let forwardedBody: unknown;
    const mockClient: OrchestratorClientPort = {
      async forwardCompletion(request) {
        forwardedBody = request.body;
        return { statusCode: 200, headers: {} };
      },
    };

    const useCase = new ForwardCompletionUseCase(mockClient);
    const result = await useCase.execute({
      identity: validIdentityWithAiUse,
      requestId: 'req-1',
      correlationId: 'corr-1',
      body: {
        ...validAiPayload,
        effort: 'medium',
        exposeReasoning: false,
      },
    });

    expect(result.ok).toBe(true);
    expect(forwardedBody).toMatchObject({ effort: 'medium', exposeReasoning: false });
  });

  it('should reject malformed effort and exposeReasoning with ValidationError', async () => {
    let called = false;
    const mockClient: OrchestratorClientPort = {
      async forwardCompletion() {
        called = true;
        return { statusCode: 200, headers: {} };
      },
    };

    const useCase = new ForwardCompletionUseCase(mockClient);
    for (const body of [
      { ...validAiPayload, effort: 42 },
      { ...validAiPayload, effort: '' },
      { ...validAiPayload, exposeReasoning: 'yes' },
    ]) {
      const result = await useCase.execute({
        identity: validIdentityWithAiUse,
        requestId: 'req-1',
        correlationId: 'corr-1',
        body,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(ValidationError);
        expect(result.error.statusCode).toBe(400);
      }
    }
    expect(called).toBe(false);
  });

  it('should reject non-boolean stream field with ValidationError', async () => {
    let called = false;
    const mockClient: OrchestratorClientPort = {
      async forwardCompletion() {
        called = true;
        return { statusCode: 200, headers: {} };
      },
    };

    const useCase = new ForwardCompletionUseCase(mockClient);
    const result = await useCase.execute({
      identity: validIdentityWithAiUse,
      requestId: 'req-1',
      correlationId: 'corr-1',
      body: {
        ...validAiPayload,
        stream: 'not-a-bool' as unknown as boolean,
      },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(ValidationError);
      expect(result.error.statusCode).toBe(400);
      expect(result.error.message).toMatch(/stream must be a boolean/);
    }
    expect(called).toBe(false);
  });

  it('should validate conversationId is non-empty string', async () => {
    const mockClient: OrchestratorClientPort = {
      async forwardCompletion() {
        return { statusCode: 200, headers: {} };
      },
    };

    const useCase = new ForwardCompletionUseCase(mockClient);
    const result = await useCase.execute({
      identity: validIdentityWithAiUse,
      requestId: 'req-1',
      correlationId: 'corr-1',
      body: {
        ...validAiPayload,
        conversationId: '',
      },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(ValidationError);
      expect(result.error.statusCode).toBe(400);
      expect(result.error.message).toMatch(/conversationId/);
    }
  });

  it('should defer canonical model authority to the Model Registry', async () => {
    const mockClient: OrchestratorClientPort = {
      async forwardCompletion() {
        return { statusCode: 200, headers: {} };
      },
    };

    const useCase = new ForwardCompletionUseCase(mockClient);

    // The gateway validates the OICUNT namespace; the Registry authoritatively
    // accepts or rejects the individual catalog entry.
    const result = await useCase.execute({
      identity: validIdentityWithAiUse,
      requestId: 'req-1',
      correlationId: 'corr-1',
      body: {
        ...validAiPayload,
        model: 'oicunt.model.unregistered-catalog-entry',
      },
    });

    expect(result.ok).toBe(true);
  });

  it('should validate messages array', async () => {
    const mockClient: OrchestratorClientPort = {
      async forwardCompletion() {
        return { statusCode: 200, headers: {} };
      },
    };

    const useCase = new ForwardCompletionUseCase(mockClient);

    const emptyMsgs = await useCase.execute({
      identity: validIdentityWithAiUse,
      requestId: 'req-1',
      correlationId: 'corr-1',
      body: {
        ...validAiPayload,
        messages: [],
      },
    });
    expect(emptyMsgs.ok).toBe(false);

    const invalidRole = await useCase.execute({
      identity: validIdentityWithAiUse,
      requestId: 'req-1',
      correlationId: 'corr-1',
      body: {
        ...validAiPayload,
        messages: [{ role: 'hacker', content: 'test' }],
      },
    });
    expect(invalidRole.ok).toBe(false);

    const emptyContent = await useCase.execute({
      identity: validIdentityWithAiUse,
      requestId: 'req-1',
      correlationId: 'corr-1',
      body: {
        ...validAiPayload,
        messages: [{ role: 'user', content: '   ' }],
      },
    });
    expect(emptyContent.ok).toBe(false);
  });

  it('should forward valid payload with authoritative context headers to orchestrator client', async () => {
    let capturedRequest: ForwardCompletionRequest | null = null;
    const mockClient: OrchestratorClientPort = {
      async forwardCompletion(req) {
        capturedRequest = req;
        return {
          statusCode: 200,
          headers: { 'content-type': 'application/json' },
          bodyData: { success: true },
        };
      },
    };

    const useCase = new ForwardCompletionUseCase(mockClient);
    const result = await useCase.execute({
      identity: validIdentityWithAiUse,
      requestId: 'auth-req-456',
      correlationId: 'corr-789',
      body: validAiPayload,
    });

    expect(result.ok).toBe(true);
    expect(capturedRequest).not.toBeNull();
    const captured = capturedRequest as unknown as ForwardCompletionRequest;
    expect(captured.requestId).toBe('auth-req-456');
    expect(captured.correlationId).toBe('corr-789');
    expect(captured.userId).toBe('user-001');
    expect(captured.tenantId).toBe('tenant-abc');
  });
});
