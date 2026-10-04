import { describe, expect, it } from 'vitest';
import { NoopMetricsRecorder, NoopSpan, NoopTracer, type Span } from './index.js';

describe('@oicunt/observability', () => {
  it('NoopSpan should provide dummy context and accept attributes without errors', () => {
    const span = new NoopSpan();
    expect(span.context().traceId).toBe('00000000000000000000000000000000');
    expect(span.context().spanId).toBe('0000000000000000');

    expect(() => {
      span.setAttribute('test.key', 'test.value');
      span.setAttributes({ count: 10, enabled: true });
      span.setStatus('ok');
      span.end();
    }).not.toThrow();
  });

  it('NoopTracer should start span and execute withSpan closure', async () => {
    const tracer = new NoopTracer();
    const span = tracer.startSpan('operation.name');
    expect(span).toBeDefined();

    const result = await tracer.withSpan('traced.work', async (activeSpan: Span) => {
      activeSpan.setAttribute('executed', true);
      return 'work-done';
    });

    expect(result).toBe('work-done');
  });

  it('NoopMetricsRecorder should record metrics without error', () => {
    const recorder = new NoopMetricsRecorder();
    expect(() => {
      recorder.incrementCounter('http.requests.total', 1, { path: '/health' });
      recorder.recordGauge('process.memory.heap', 1024, { unit: 'bytes' });
      recorder.recordHistogram('http.request.duration', 12.5, { status: 200 });
    }).not.toThrow();
  });
});
