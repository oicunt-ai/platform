import type { UsageEvent } from '../../domain/types.js';

export type UsageEventHandler = (event: UsageEvent) => Promise<void>;

export interface UsageQueueConsumerPort {
  /**
   * Starts the AMQP consumer listening for events on oicunt.usage.events.
   */
  start(): Promise<void>;

  /**
   * Gracefully stops the consumer.
   */
  stop(): Promise<void>;

  /**
   * Registers the application handler invoked on each incoming event.
   */
  registerHandler(handler: UsageEventHandler): void;
}
