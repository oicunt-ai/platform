export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';

export interface LogContext {
  readonly service?: string | undefined;
  readonly tenantId?: string | undefined;
  readonly correlationId?: string | undefined;
  readonly requestId?: string | undefined;
  readonly eventId?: string | undefined;
  readonly operation?: string | undefined;
  readonly sourceService?: string | undefined;
  readonly [key: string]: unknown;
}

const SENSITIVE_KEY_PATTERNS = [
  /token/i,
  /secret/i,
  /key/i,
  /password/i,
  /auth/i,
  /prompt/i,
  /completion/i,
  /argument/i,
  /output/i,
  /payload/i,
];

function sanitizeContext(context?: Record<string, unknown>): Record<string, unknown> {
  if (!context) {
    return {};
  }
  const clean: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(context)) {
    if (SENSITIVE_KEY_PATTERNS.some((pattern) => pattern.test(key))) {
      clean[key] = '[REDACTED]';
    } else if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      clean[key] = sanitizeContext(value as Record<string, unknown>);
    } else {
      clean[key] = value;
    }
  }
  return clean;
}

export class JsonLogger {
  private readonly minLevel: LogLevel;
  private readonly defaultContext: LogContext;

  private static readonly LEVEL_ORDER: Record<LogLevel, number> = {
    debug: 10,
    info: 20,
    warn: 30,
    error: 40,
    silent: 100,
  };

  constructor(minLevel: LogLevel = 'info', defaultContext: LogContext = {}) {
    this.minLevel = minLevel;
    this.defaultContext = { service: 'usage', ...defaultContext };
  }

  public child(extraContext: LogContext): JsonLogger {
    return new JsonLogger(this.minLevel, { ...this.defaultContext, ...extraContext });
  }

  public debug(message: string, context?: LogContext): void {
    this.log('debug', message, context);
  }

  public info(message: string, context?: LogContext): void {
    this.log('info', message, context);
  }

  public warn(message: string, context?: LogContext): void {
    this.log('warn', message, context);
  }

  public error(message: string, context?: LogContext): void {
    this.log('error', message, context);
  }

  private log(level: LogLevel, message: string, context?: LogContext): void {
    if (JsonLogger.LEVEL_ORDER[level] < JsonLogger.LEVEL_ORDER[this.minLevel]) {
      return;
    }

    const merged = {
      timestamp: new Date().toISOString(),
      level: level.toUpperCase(),
      message,
      ...sanitizeContext({ ...this.defaultContext, ...context }),
    };

    const line = JSON.stringify(merged);
    if (level === 'error') {
      process.stderr.write(`${line}\n`);
    } else {
      process.stdout.write(`${line}\n`);
    }
  }
}
