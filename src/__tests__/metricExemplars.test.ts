import { ROOT_CONTEXT, trace } from '@opentelemetry/api';
import { resourceFromAttributes } from '@opentelemetry/resources';
import {
  AggregationTemporality,
  DataPointType,
  type ResourceMetrics,
} from '@opentelemetry/sdk-metrics';
import { MetricExemplarRegistry } from '../core/metricExemplars';
import { utf8BytesToString, utf8StringToBytes } from '../core/encoding';

function resourceMetrics(): ResourceMetrics {
  return {
    resource: resourceFromAttributes({ 'service.name': 'test' }),
    scopeMetrics: [
      {
        scope: { name: 'test', version: '1.0.0' },
        metrics: [
          {
            descriptor: {
              name: 'checkout.duration',
              description: '',
              unit: 's',
              valueType: 1,
            },
            aggregationTemporality: AggregationTemporality.CUMULATIVE,
            dataPointType: DataPointType.GAUGE,
            dataPoints: [
              {
                startTime: [1, 0],
                endTime: [2, 0],
                attributes: { route: 'checkout' },
                value: 0.42,
              },
            ],
          },
        ],
      },
    ],
  };
}

describe('MetricExemplarRegistry', () => {
  it('decorates the matching OTLP datapoint with sampled trace identifiers', () => {
    const registry = new MetricExemplarRegistry(16, () => 1_725_000_000_123);
    const context = trace.setSpanContext(ROOT_CONTEXT, {
      traceId: '0123456789abcdef0123456789abcdef',
      spanId: '0123456789abcdef',
      traceFlags: 1,
    });
    registry.record('checkout.duration', 0.42, { route: 'checkout' }, context);
    const payload = utf8StringToBytes(
      JSON.stringify({
        resourceMetrics: [
          {
            scopeMetrics: [
              {
                metrics: [{ gauge: { dataPoints: [{}] } }],
              },
            ],
          },
        ],
      })
    );

    const decorated = registry.decorate(payload, resourceMetrics());
    const parsed = JSON.parse(utf8BytesToString(decorated ?? payload)) as {
      resourceMetrics: Array<{
        scopeMetrics: Array<{
          metrics: Array<{
            gauge: { dataPoints: Array<{ exemplars: unknown[] }> };
          }>;
        }>;
      }>;
    };
    expect(
      parsed.resourceMetrics[0]?.scopeMetrics[0]?.metrics[0]?.gauge
        .dataPoints[0]?.exemplars
    ).toEqual([
      {
        asDouble: 0.42,
        timeUnixNano: '1725000000123000000',
        traceId: '0123456789abcdef0123456789abcdef',
        spanId: '0123456789abcdef',
      },
    ]);
  });

  it('does not create exemplars for unsampled contexts', () => {
    const registry = new MetricExemplarRegistry(16);
    const context = trace.setSpanContext(ROOT_CONTEXT, {
      traceId: '0123456789abcdef0123456789abcdef',
      spanId: '0123456789abcdef',
      traceFlags: 0,
    });
    registry.record('checkout.duration', 1, { route: 'checkout' }, context);
    const payload = utf8StringToBytes('{"resourceMetrics":[]}');
    expect(registry.decorate(payload, resourceMetrics())).toBe(payload);
  });
});
