export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';

export const LOG_LEVEL_PRIORITIES: Record<LogLevel, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
};

export type LogContext = Record<string, unknown>;

export interface SerializedError {
  readonly name: string;
  readonly message: string;
  readonly stack?: string;
}

export interface LogEntry {
  readonly level: LogLevel;
  readonly message: string;
  readonly timestamp: string;
  readonly context?: LogContext;
  readonly error?: SerializedError;
}

export interface Logger {
  trace(message: string, context?: LogContext): void;
  debug(message: string, context?: LogContext): void;
  info(message: string, context?: LogContext): void;
  warn(message: string, context?: LogContext): void;
  error(message: string, error?: unknown, context?: LogContext): void;
  fatal(message: string, error?: unknown, context?: LogContext): void;
  child(context: LogContext): Logger;
}

export function serializeError(error: unknown): SerializedError | undefined {
  if (!error) {
    return undefined;
  }
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      ...(error.stack ? { stack: error.stack } : {}),
    };
  }
  return {
    name: 'UnknownError',
    message: String(error),
  };
}

export class NoopLogger implements Logger {
  trace(_message: string, _context?: LogContext): void {}
  debug(_message: string, _context?: LogContext): void {}
  info(_message: string, _context?: LogContext): void {}
  warn(_message: string, _context?: LogContext): void {}
  error(_message: string, _error?: unknown, _context?: LogContext): void {}
  fatal(_message: string, _error?: unknown, _context?: LogContext): void {}
  child(_context: LogContext): Logger {
    return this;
  }
}

export class MemoryLogger implements Logger {
  private readonly entries: LogEntry[] = [];
  private readonly baseContext: LogContext;

  constructor(baseContext: LogContext = {}) {
    this.baseContext = baseContext;
  }

  getEntries(): readonly LogEntry[] {
    return [...this.entries];
  }

  clear(): void {
    this.entries.length = 0;
  }

  private record(level: LogLevel, message: string, context?: LogContext, error?: unknown): void {
    const mergedContext = { ...this.baseContext, ...context };
    const serialized = serializeError(error);

    this.entries.push({
      level,
      message,
      timestamp: new Date().toISOString(),
      ...(Object.keys(mergedContext).length > 0 ? { context: mergedContext } : {}),
      ...(serialized ? { error: serialized } : {}),
    });
  }

  trace(message: string, context?: LogContext): void {
    this.record('trace', message, context);
  }

  debug(message: string, context?: LogContext): void {
    this.record('debug', message, context);
  }

  info(message: string, context?: LogContext): void {
    this.record('info', message, context);
  }

  warn(message: string, context?: LogContext): void {
    this.record('warn', message, context);
  }

  error(message: string, error?: unknown, context?: LogContext): void {
    this.record('error', message, context, error);
  }

  fatal(message: string, error?: unknown, context?: LogContext): void {
    this.record('fatal', message, context, error);
  }

  child(context: LogContext): Logger {
    return new MemoryLogger({ ...this.baseContext, ...context });
  }
}
