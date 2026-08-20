import type {
  Counter,
  Gauge,
  Histogram,
  Meter,
  UpDownCounter,
} from '@opentelemetry/api';
import type { Diagnostics } from './diagnostics';
import type { DynamicTelemetryContext } from './dynamicContext';
import type { MetricExemplarRegistry } from './metricExemplars';
import type { Sanitizer } from './sanitizer';
import { toOtelContext } from './context';
import type { AttributeInputs, MetricOptions, ResolvedConfig } from '../types';

type Instrument = Counter | Gauge | Histogram | UpDownCounter;
type InstrumentKind = 'counter' | 'gauge' | 'histogram' | 'up-down-counter';

const MAX_INSTRUMENTS = 128;

export class MetricRecorder {
  private readonly instruments = new Map<string, Instrument>();

  constructor(
    private readonly meter: Meter,
    private readonly contextManager: DynamicTelemetryContext,
    private readonly sanitizer: Sanitizer,
    private readonly diagnostics: Diagnostics,
    private readonly config: ResolvedConfig,
    private readonly exemplars: MetricExemplarRegistry
  ) {}

  counter(
    name: string,
    value = 1,
    attributes?: AttributeInputs,
    options?: MetricOptions
  ): void {
    if (!this.config.signals.metrics) return;
    if (!Number.isFinite(value) || value < 0) {
      this.diagnostics.warn(
        'Counter measurements must be finite and non-negative.',
        {
          name,
        }
      );
      return;
    }
    const instrument = this.instrument('counter', name, options) as
      Counter | undefined;
    if (!instrument) return;
    const measurement = this.measurement(name, value, attributes, options);
    instrument.add(value, measurement.attributes, measurement.context);
  }

  upDownCounter(
    name: string,
    value: number,
    attributes?: AttributeInputs,
    options?: MetricOptions
  ): void {
    if (!this.config.signals.metrics) return;
    if (!Number.isFinite(value)) return;
    const instrument = this.instrument('up-down-counter', name, options) as
      UpDownCounter | undefined;
    if (!instrument) return;
    const measurement = this.measurement(name, value, attributes, options);
    instrument.add(value, measurement.attributes, measurement.context);
  }

  gauge(
    name: string,
    value: number,
    attributes?: AttributeInputs,
    options?: MetricOptions
  ): void {
    if (!this.config.signals.metrics) return;
    if (!Number.isFinite(value)) return;
    const instrument = this.instrument('gauge', name, options) as
      Gauge | undefined;
    if (!instrument) return;
    const measurement = this.measurement(name, value, attributes, options);
    instrument.record(value, measurement.attributes, measurement.context);
  }

  histogram(
    name: string,
    value: number,
    attributes?: AttributeInputs,
    options?: MetricOptions
  ): void {
    if (!this.config.signals.metrics) return;
    if (!Number.isFinite(value) || value < 0) return;
    const instrument = this.instrument('histogram', name, options) as
      Histogram | undefined;
    if (!instrument) return;
    const measurement = this.measurement(name, value, attributes, options);
    instrument.record(value, measurement.attributes, measurement.context);
  }

  private instrument(
    kind: InstrumentKind,
    rawName: string,
    options?: MetricOptions
  ): Instrument | undefined {
    if (!this.config.signals.metrics) return undefined;
    const name = this.sanitizer.metricName(rawName);
    const key = `${kind}:${name}`;
    const existing = this.instruments.get(key);
    if (existing) return existing;
    if (this.instruments.size >= MAX_INSTRUMENTS) {
      this.diagnostics.warn('Metric instrument limit reached.', {
        maxInstruments: MAX_INSTRUMENTS,
      });
      return undefined;
    }
    const metadata = {
      ...(options?.description
        ? { description: this.sanitizer.message(options.description) }
        : {}),
      ...(options?.unit ? { unit: this.sanitizer.message(options.unit) } : {}),
    };
    const created = createInstrument(this.meter, kind, name, metadata);
    this.instruments.set(key, created);
    return created;
  }

  private metricAttributes(attributes?: AttributeInputs) {
    return {
      ...this.contextManager.metricAttributes(),
      ...this.sanitizer.attributes(attributes),
    };
  }

  private measurement(
    rawName: string,
    value: number,
    attributes: AttributeInputs | undefined,
    options: MetricOptions | undefined
  ) {
    const metricName = this.sanitizer.metricName(rawName);
    const metricAttributes = this.metricAttributes(attributes);
    const context = toOtelContext(
      options?.context,
      this.contextManager.active()
    );
    this.exemplars.record(metricName, value, metricAttributes, context);
    return { attributes: metricAttributes, context };
  }
}

function createInstrument(
  meter: Meter,
  kind: InstrumentKind,
  name: string,
  options: { description?: string; unit?: string }
): Instrument {
  switch (kind) {
    case 'counter':
      return meter.createCounter(name, options);
    case 'gauge':
      return meter.createGauge(name, options);
    case 'histogram':
      return meter.createHistogram(name, options);
    case 'up-down-counter':
      return meter.createUpDownCounter(name, options);
  }
}
