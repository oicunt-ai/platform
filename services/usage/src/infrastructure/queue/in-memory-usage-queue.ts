import type { UsageEvent } from '../../domain/types.js';
import { UsageValidationError } from '../../domain/errors.js';
import type {
  UsageEventHandler,
  UsageQueueConsumerPort,
} from '../../application/ports/usage-queue-consumer.port.js';

export class InMemoryUsageQueue implements UsageQueueConsumerPort {
  private handler: UsageEventHandler | null = null;
  public readonly acknowledged: unknown[] = [];
  public readonly deadLettered: unknown[] = [];
  public readonly requeued: unknown[] = [];
  private isRunning = false;

  public isReady(): boolean {
    return this.isRunning;
  }

  public registerHandler(handler: UsageEventHandler): void {
    this.handler = handler;
  }

  public async start(): Promise<void> {
    this.isRunning = true;
  }

  public async stop(): Promise<void> {
    this.isRunning = false;
  }

  public async publishRaw(rawMessage: string): Promise<void> {
    if (!this.isRunning || !this.handler) {
      throw new Error('Queue is not running or no handler registered');
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawMessage);
    } catch {
      this.deadLettered.push({ raw: rawMessage, reason: 'malformed_json' });
      return;
    }

    try {
      await this.handler(parsed as UsageEvent);
      this.acknowledged.push(parsed);
    } catch (err) {
      if (err instanceof UsageValidationError) {
        this.deadLettered.push({ message: parsed, reason: err.message });
      } else {
        this.requeued.push({ message: parsed, error: err });
        throw err;
      }
    }
  }

  public clear(): void {
    this.acknowledged.length = 0;
    this.deadLettered.length = 0;
    this.requeued.length = 0;
  }
}
