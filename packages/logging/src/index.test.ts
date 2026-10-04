import { describe, expect, it } from 'vitest';
import { LOG_LEVEL_PRIORITIES, MemoryLogger, NoopLogger, serializeError } from './index.js';

describe('@oicunt/logging', () => {
  it('should expose prioritized log levels', () => {
    expect(LOG_LEVEL_PRIORITIES.trace).toBeLessThan(LOG_LEVEL_PRIORITIES.debug);
    expect(LOG_LEVEL_PRIORITIES.debug).toBeLessThan(LOG_LEVEL_PRIORITIES.info);
    expect(LOG_LEVEL_PRIORITIES.info).toBeLessThan(LOG_LEVEL_PRIORITIES.warn);
    expect(LOG_LEVEL_PRIORITIES.warn).toBeLessThan(LOG_LEVEL_PRIORITIES.error);
    expect(LOG_LEVEL_PRIORITIES.error).toBeLessThan(LOG_LEVEL_PRIORITIES.fatal);
  });

  it('NoopLogger should execute without throwing', () => {
    const logger = new NoopLogger();
    expect(() => {
      logger.info('test message', { key: 'value' });
      logger.error('failure', new Error('boom'));
      const child = logger.child({ sub: 'module' });
      child.debug('child log');
    }).not.toThrow();
  });

  it('MemoryLogger should capture structured log entries and child context', () => {
    const logger = new MemoryLogger({ service: 'core' });
    logger.info('service starting');

    const child = logger.child({ module: 'worker' });
    child.warn('high load', { queueSize: 42 });

    const entries = (logger as MemoryLogger).getEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.message).toBe('service starting');

    const childEntries = (child as MemoryLogger).getEntries();
    expect(childEntries).toHaveLength(1);
    expect(childEntries[0]?.context).toMatchObject({
      service: 'core',
      module: 'worker',
      queueSize: 42,
    });
  });

  it('serializeError should handle standard Error and non-Error values', () => {
    const err = new Error('Database disconnected');
    const serialized = serializeError(err);
    expect(serialized?.name).toBe('Error');
    expect(serialized?.message).toBe('Database disconnected');
    expect(serialized?.stack).toBeDefined();

    const stringErr = serializeError('simple error');
    expect(stringErr?.name).toBe('UnknownError');
    expect(stringErr?.message).toBe('simple error');
  });
});
