import { describe, expect, it } from 'vitest';
import {
  GetServiceHealthUseCase,
  EntityNotFoundError,
  ValidationError,
  ConflictError,
  InMemoryRepository,
  loadServiceConfig,
  type AggregateRoot,
} from '../../src/index.js';

interface TestItem extends AggregateRoot {
  readonly title: string;
}

describe('Service Template - Unit Tests', () => {
  describe('Domain Errors', () => {
    it('should format EntityNotFoundError with code and message', () => {
      const err = new EntityNotFoundError('Order', 'ord-99');
      expect(err.code).toBe('ENTITY_NOT_FOUND');
      expect(err.message).toBe("Order with identifier 'ord-99' was not found");
      expect(err.name).toBe('EntityNotFoundError');
    });

    it('should format ValidationError with field metadata', () => {
      const err = new ValidationError('Value must be positive', 'amount');
      expect(err.code).toBe('VALIDATION_FAILED');
      expect(err.field).toBe('amount');
    });

    it('should format ConflictError', () => {
      const err = new ConflictError('Unique key exists');
      expect(err.code).toBe('STATE_CONFLICT');
    });
  });

  describe('Application Use Case', () => {
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
  });

  describe('Infrastructure In-Memory Repository', () => {
    it('should perform CRUD operations on AggregateRoot entities', async () => {
      const repo = new InMemoryRepository<TestItem>();
      const item: TestItem = {
        id: 'item-1',
        title: 'Canonical Template Item',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      await repo.save(item);
      const found = await repo.findById('item-1');
      expect(found).toEqual(item);

      const deleted = await repo.delete('item-1');
      expect(deleted).toBe(true);

      const missing = await repo.findById('item-1');
      expect(missing).toBeNull();
    });
  });

  describe('Configuration Loading', () => {
    it('should apply fallback defaults and handle overrides', () => {
      const config = loadServiceConfig({
        serviceName: 'test-custom-service',
        port: 9090,
        shutdownTimeoutMs: 12000,
        environment: 'staging',
      });

      expect(config.serviceName).toBe('test-custom-service');
      expect(config.port).toBe(9090);
      expect(config.shutdownTimeoutMs).toBe(12000);
      expect(config.environment).toBe('staging');
    });
  });
});
