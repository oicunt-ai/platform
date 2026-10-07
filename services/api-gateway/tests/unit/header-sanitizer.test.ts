import { describe, expect, it } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { MemoryLogger } from '@oicunt/logging';
import { createGatewayRequestContext } from '../../src/index.js';

describe('Header Sanitizer Middleware - Unit Tests', () => {
  const logger = new MemoryLogger({ service: 'api-gateway' });

  it('should strip all internal identity, authorization, service-name, and request headers', () => {
    const fakeReq = {
      method: 'POST',
      url: '/api/v1/ai/completions',
      headers: {
        'x-user-id': 'spoofed-attacker-id',
        'x-tenant-id': 'spoofed-target-tenant',
        'x-roles': 'super-admin,root',
        'x-scopes': 'ai:admin,ai:all',
        'x-permissions': 'all:grant',
        'x-service-name': 'ai-orchestrator',
        'x-request-id': 'spoofed-request-id',
        'x-correlation-id': 'client-correlation-789',
        'content-type': 'application/json',
      },
    } as unknown as IncomingMessage;

    const setHeaders: Record<string, string> = {};
    const fakeRes = {
      setHeader(name: string, value: string) {
        setHeaders[name.toLowerCase()] = value;
      },
    } as unknown as ServerResponse;

    const ctx = createGatewayRequestContext(fakeReq, fakeRes, logger);

    // 1. All spoofed internal headers must be stripped from req.headers
    expect(fakeReq.headers['x-user-id']).toBeUndefined();
    expect(fakeReq.headers['x-tenant-id']).toBeUndefined();
    expect(fakeReq.headers['x-roles']).toBeUndefined();
    expect(fakeReq.headers['x-scopes']).toBeUndefined();
    expect(fakeReq.headers['x-permissions']).toBeUndefined();
    expect(fakeReq.headers['x-service-name']).toBeUndefined();
    expect(fakeReq.headers['x-request-id']).toBeUndefined();

    // 2. Authoritative X-Request-ID generated
    expect(ctx.requestId).toBeDefined();
    expect(ctx.requestId).not.toBe('spoofed-request-id');
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    expect(ctx.requestId).toMatch(uuidRegex);

    // 3. Client X-Correlation-ID adopted
    expect(ctx.correlationId).toBe('client-correlation-789');

    // 4. Egress response headers populated with authoritative values
    expect(setHeaders['x-request-id']).toBe(ctx.requestId);
    expect(setHeaders['x-correlation-id']).toBe('client-correlation-789');
  });

  it('should generate a new X-Correlation-ID when client does not supply one', () => {
    const fakeReq = {
      method: 'GET',
      url: '/api/v1/context',
      headers: {},
    } as unknown as IncomingMessage;

    const setHeaders: Record<string, string> = {};
    const fakeRes = {
      setHeader(name: string, value: string) {
        setHeaders[name.toLowerCase()] = value;
      },
    } as unknown as ServerResponse;

    const ctx = createGatewayRequestContext(fakeReq, fakeRes, logger);

    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    expect(ctx.correlationId).toMatch(uuidRegex);
    expect(setHeaders['x-correlation-id']).toBe(ctx.correlationId);
  });
});
