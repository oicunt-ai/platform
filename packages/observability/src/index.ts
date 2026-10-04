export type MetricType = 'counter' | 'gauge' | 'histogram';

export type MetricValue = number;

export type MetricAttributes = Record<string, string | number | boolean>;

export type SpanStatus = 'ok' | 'error' | 'unset';

export interface SpanContext {
  readonly traceId: string;
  readonly spanId: string;
  readonly traceFlags?: number;
}

export interface Span {
  context(): SpanContext;
  setAttribute(key: string, value: string | number | boolean): void;
  setAttributes(attributes: MetricAttributes): void;
  setStatus(status: SpanStatus, description?: string): void;
  end(): void;
}

export interface Tracer {
  startSpan(name: string, attributes?: MetricAttributes): Span;
  withSpan<T>(name: string, fn: (span: Span) => Promise<T>): Promise<T>;
}

export interface MetricsRecorder {
  incrementCounter(name: string, value?: number, attributes?: MetricAttributes): void;
  recordGauge(name: string, value: number, attributes?: MetricAttributes): void;
  recordHistogram(name: string, value: number, attributes?: MetricAttributes): void;
}

export class NoopSpan implements Span {
  private readonly spanContext: SpanContext = {
    traceId: '00000000000000000000000000000000',
    spanId: '0000000000000000',
  };

  context(): SpanContext {
    return this.spanContext;
  }

  setAttribute(_key: string, _value: string | number | boolean): void {}
  setAttributes(_attributes: MetricAttributes): void {}
  setStatus(_status: SpanStatus, _description?: string): void {}
  end(): void {}
}

export class NoopTracer implements Tracer {
  private readonly defaultSpan = new NoopSpan();

  startSpan(_name: string, _attributes?: MetricAttributes): Span {
    return this.defaultSpan;
  }

  async withSpan<T>(_name: string, fn: (span: Span) => Promise<T>): Promise<T> {
    return fn(this.defaultSpan);
  }
}

export class NoopMetricsRecorder implements MetricsRecorder {
  incrementCounter(_name: string, _value?: number, _attributes?: MetricAttributes): void {}
  recordGauge(_name: string, _value: number, _attributes?: MetricAttributes): void {}
  recordHistogram(_name: string, _value: number, _attributes?: MetricAttributes): void {}
}
