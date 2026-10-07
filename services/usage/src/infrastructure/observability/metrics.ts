export class UsageMetrics {
  private eventsIngested = 0;
  private eventsDuplicated = 0;
  private eventsRejected = 0;
  private reversalsProcessed = 0;
  private queriesExecuted = 0;

  public incrementIngested(): void {
    this.eventsIngested += 1;
  }

  public incrementDuplicated(): void {
    this.eventsDuplicated += 1;
  }

  public incrementRejected(): void {
    this.eventsRejected += 1;
  }

  public incrementReversals(): void {
    this.reversalsProcessed += 1;
  }

  public incrementQueries(): void {
    this.queriesExecuted += 1;
  }

  public getSnapshot(): Record<string, number> {
    return {
      eventsIngested: this.eventsIngested,
      eventsDuplicated: this.eventsDuplicated,
      eventsRejected: this.eventsRejected,
      reversalsProcessed: this.reversalsProcessed,
      queriesExecuted: this.queriesExecuted,
    };
  }

  public reset(): void {
    this.eventsIngested = 0;
    this.eventsDuplicated = 0;
    this.eventsRejected = 0;
    this.reversalsProcessed = 0;
    this.queriesExecuted = 0;
  }
}
