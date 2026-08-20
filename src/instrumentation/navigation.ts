import { SpanStatusCode } from '@opentelemetry/api';
import type { DynamicTelemetryContext } from '../core/dynamicContext';
import type { StructuredLogger } from '../core/logger';
import type { MetricRecorder } from '../core/metrics';
import type { ElvenSpan, ElvenTracer } from '../core/tracer';
import type {
  NavigationInstrumentation,
  NavigationInstrumentationOptions,
  NavigationRefLike,
  NavigationRouteLike,
} from '../types';

export class ReactNavigationInstrumentation implements NavigationInstrumentation {
  private currentRouteId: string | undefined;
  private currentSpan: ElvenSpan | undefined;

  constructor(
    private readonly navigationRef: NavigationRefLike,
    private readonly options: NavigationInstrumentationOptions,
    private readonly tracer: ElvenTracer,
    private readonly logger: StructuredLogger,
    private readonly metrics: MetricRecorder,
    private readonly context: DynamicTelemetryContext
  ) {}

  onReady(): void {
    this.recordCurrentRoute();
  }

  onStateChange(): void {
    this.recordCurrentRoute();
  }

  shutdown(): void {
    this.currentSpan?.setStatus({ code: SpanStatusCode.OK }).end();
    this.currentSpan = undefined;
    this.currentRouteId = undefined;
    this.context.setNavigationContext(null);
  }

  private recordCurrentRoute(): void {
    const route = this.navigationRef.getCurrentRoute();
    if (!route) return;
    const routeId = route.key ?? route.name;
    if (routeId === this.currentRouteId) return;

    this.currentSpan?.setStatus({ code: SpanStatusCode.OK }).end();
    this.currentRouteId = routeId;
    const customAttributes = safelyResolveAttributes(this.options, route);
    const attributes = {
      'app.screen.name': route.name,
      ...(route.key ? { 'app.screen.id': route.key } : {}),
      ...customAttributes,
    };
    this.context.setNavigationContext(attributes);
    this.currentSpan = this.tracer.startSpan(
      safelyResolveSpanName(this.options, route),
      { attributes }
    );
    this.logger.info('Screen displayed.', attributes, {
      context: this.currentSpan.context,
      eventName: 'app.screen.view',
    });
    this.metrics.counter(
      'app.screen.view.count',
      1,
      {
        'app.screen.name': route.name,
      },
      {
        context: this.currentSpan.context,
      }
    );
  }
}

function safelyResolveAttributes(
  options: NavigationInstrumentationOptions,
  route: NavigationRouteLike
) {
  try {
    return options.attributes?.(route) ?? {};
  } catch {
    return {};
  }
}

function safelyResolveSpanName(
  options: NavigationInstrumentationOptions,
  route: NavigationRouteLike
): string {
  try {
    return options.spanName?.(route) ?? `screen ${route.name}`;
  } catch {
    return `screen ${route.name}`;
  }
}
