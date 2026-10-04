import { describe, expect, it } from 'vitest';
import { calculatePagination, err, HttpStatus, isErr, isOk, ok } from './index.js';

describe('@oicunt/contracts', () => {
  it('should support Result pattern ok and err', () => {
    const successResult = ok({ id: '123', name: 'platform' });
    const errorResult = err({ code: 'NOT_FOUND', message: 'Resource not found' });

    expect(isOk(successResult)).toBe(true);
    expect(isErr(successResult)).toBe(false);
    if (isOk(successResult)) {
      expect(successResult.value.name).toBe('platform');
    }

    expect(isOk(errorResult)).toBe(false);
    expect(isErr(errorResult)).toBe(true);
    if (isErr(errorResult)) {
      expect(errorResult.error.code).toBe('NOT_FOUND');
    }
  });

  it('should calculate pagination metadata correctly', () => {
    const pagination = calculatePagination(1, 10, 25);

    expect(pagination).toEqual({
      page: 1,
      pageSize: 10,
      totalItems: 25,
      totalPages: 3,
      hasNextPage: true,
      hasPreviousPage: false,
    });

    const lastPage = calculatePagination(3, 10, 25);
    expect(lastPage.hasNextPage).toBe(false);
    expect(lastPage.hasPreviousPage).toBe(true);
  });

  it('should export canonical HTTP status codes', () => {
    expect(HttpStatus.OK).toBe(200);
    expect(HttpStatus.CREATED).toBe(201);
    expect(HttpStatus.NOT_FOUND).toBe(404);
    expect(HttpStatus.INTERNAL_SERVER_ERROR).toBe(500);
  });
});
