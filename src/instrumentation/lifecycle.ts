import { AppState, type AppStateStatus } from 'react-native';
import { SpanStatusCode } from '@opentelemetry/api';
import type { StructuredLogger } from '../core/logger';
import type { MetricRecorder } from '../core/metrics';
import type { ElvenTracer } from '../core/tracer';
import type { NativePlatformContext, ResolvedConfig } from '../types';

export class LifecycleInstrumentation {
  private readonly removeListeners: Array<() => void> = [];
  private previousState: AppStateStatus | null = normalizeAppState(
    AppState.currentState
  );

  constructor(
    private readonly config: ResolvedConfig,
    private readonly platform: NativePlatformContext,
    private readonly tracer: ElvenTracer,
    private readonly logger: StructuredLogger,
    private readonly metrics: MetricRecorder,
    private readonly flush: () => Promise<unknown>
  ) {}

  start(): void {
    const settings = this.config.instrumentations.lifecycle;
    if (!settings.enabled) return;
    this.recordStart();

    const stateSubscription = AppState.addEventListener('change', (nextState) =>
      this.onStateChange(nextState)
    );
    const memorySubscription = AppState.addEventListener('memoryWarning', () =>
      this.onMemoryWarning()
    );
    this.removeListeners.push(
      () => stateSubscription.remove(),
      () => memorySubscription.remove()
    );
  }

  shutdown(): void {
    for (const remove of this.removeListeners.splice(0)) remove();
  }

  private recordStart(): void {
    const now = Date.now();
    const processStart = this.platform.processStartUnixMillis;
    const durationMillis =
      processStart !== undefined && processStart <= now
        ? now - processStart
        : undefined;
    const span = this.tracer.startSpan('app.start', {
      ...(processStart !== undefined
        ? { startTimeUnixMillis: processStart }
        : {}),
      attributes: {
        'app.lifecycle.state': this.previousState ?? 'unknown',
        ...(durationMillis !== undefined
          ? { 'app.start.duration_ms': durationMillis }
          : {}),
      },
    });
    span.setStatus({ code: SpanStatusCode.OK }).end(now);
    this.logger.info(
      'Application started.',
      {
        'app.lifecycle.state': this.previousState ?? 'unknown',
        ...(durationMillis !== undefined
          ? { 'app.start.duration_ms': durationMillis }
          : {}),
      },
      { context: span.context, eventName: 'app.start' }
    );
    this.metrics.counter('app.start.count', 1);
    if (durationMillis !== undefined) {
      this.metrics.histogram(
        'app.start.duration',
        durationMillis / 1_000,
        undefined,
        { unit: 's', context: span.context }
      );
    }
  }

  private onStateChange(nextState: AppStateStatus): void {
    const previous = this.previousState ?? 'unknown';
    if (previous === nextState) return;
    this.previousState = nextState;
    const attributes = {
      'app.lifecycle.from': previous,
      'app.lifecycle.to': nextState,
    };
    const span = this.tracer.startSpan('app.lifecycle.change', { attributes });
    span.setStatus({ code: SpanStatusCode.OK }).end();
    this.logger.info('Application lifecycle changed.', attributes, {
      context: span.context,
      eventName: 'app.lifecycle.change',
    });
    this.metrics.counter('app.lifecycle.change.count', 1, attributes, {
      context: span.context,
    });

    if (
      this.config.instrumentations.lifecycle.flushOnBackground &&
      (nextState === 'background' || nextState === 'inactive')
    ) {
      this.flush().catch(() => undefined);
    }
  }

  private onMemoryWarning(): void {
    const span = this.tracer.startSpan('app.memory.warning');
    span.setStatus({ code: SpanStatusCode.ERROR }).end();
    this.logger.warn('Application received a memory warning.', undefined, {
      context: span.context,
      eventName: 'app.memory.warning',
    });
    this.metrics.counter('app.memory.warning.count', 1, undefined, {
      context: span.context,
    });
  }
}

function normalizeAppState(
  value: string | null | undefined
): AppStateStatus | null {
  return value === 'active' ||
    value === 'background' ||
    value === 'inactive' ||
    value === 'unknown' ||
    value === 'extension'
    ? value
    : null;
}
