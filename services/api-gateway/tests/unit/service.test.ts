import { describe, expect, it } from 'vitest';
import {
  GetServiceHealthUseCase,
  GetContextUseCase,
  EntityNotFoundError,
  ValidationError,
  AuthenticationError,
  ForbiddenError,
  BadGatewayError,
  createIdentityContext,
  loadServiceConfig,
} from '../../src/index.js';

describe('Gateway Service - Unit Tests', () => {
  describe('Domain Errors', () => {
    it('should format EntityNotFoundError with code and message', () => {
      const err = new EntityNotFoundError('Model', 'oicunt.model.custom');
      expect(err.code).toBe('ENTITY_NOT_FOUND');
      expect(err.statusCode).toBe(404);
      expect(err.message).toBe("Model with identifier 'oicunt.model.custom' was not found");
    });

    it('should format ValidationError with field metadata', () => {
      const err = new ValidationError('Value must be positive', 'temperature');
      expect(err.code).toBe('VALIDATION_FAILED');
      expect(err.statusCode).toBe(400);
      expect(err.field).toBe('temperature');
    });

    it('should format AuthenticationError', () => {
      const err = new AuthenticationError('Token expired');
      expect(err.code).toBe('UNAUTHORIZED');
      expect(err.statusCode).toBe(401);
    });

    it('should format ForbiddenError', () => {
      const err = new ForbiddenError('Missing permission');
      expect(err.code).toBe('FORBIDDEN');
      expect(err.statusCode).toBe(403);
    });

    it('should format BadGatewayError', () => {
      const err = new BadGatewayError('Downstream failure');
      expect(err.code).toBe('BAD_GATEWAY');
      expect(err.statusCode).toBe(502);
    });
  });

  describe('Application Use Cases', () => {
    it('GetServiceHealthUseCase should return healthy Result dto', async () => {
      const useCase = new GetServiceHealthUseCase('1.2.3');
      const result = await useCase.execute({});

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.status).toBe('healthy');
        expect(result.value.version).toBe('1.2.3');
        expect(typeof result.value.uptimeSeconds).toBe('number');
      }
    });

    it('GetContextUseCase should return sanitized identity without exposing private claims', async () => {
      const identity = createIdentityContext({
        userId: 'usr_abc',
        tenantId: 'tnt_xyz',
        roles: ['developer'],
        scopes: ['ai:use'],
        permissions: ['chat:create'],
      });

      const useCase = new GetContextUseCase();
      const result = await useCase.execute(identity);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toEqual({
          userId: 'usr_abc',
          tenantId: 'tnt_xyz',
          roles: ['developer'],
          scopes: ['ai:use'],
          permissions: ['chat:create'],
        });
      }
    });
  });

  describe('Configuration Loading', () => {
    it('should apply fallback defaults and handle overrides', () => {
      const config = loadServiceConfig({
        serviceName: 'custom-api-gateway',
        port: 8080,
        shutdownTimeoutMs: 12000,
        environment: 'staging',
        orchestratorBaseUrl: 'http://orchestrator.internal:3001',
      });

      expect(config.serviceName).toBe('custom-api-gateway');
      expect(config.port).toBe(8080);
      expect(config.shutdownTimeoutMs).toBe(12000);
      expect(config.environment).toBe('staging');
      expect(config.orchestratorBaseUrl).toBe('http://orchestrator.internal:3001');
    });
  });
});
