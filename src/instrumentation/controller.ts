import type { Diagnostics } from '../core/diagnostics';
import type { TelemetryProviders } from '../core/providers';
import type { Sanitizer } from '../core/sanitizer';
import type { NativeBridge } from '../native/bridge';
import type { NativePlatformContext, ResolvedConfig } from '../types';
import { ConsoleInstrumentation } from './console';
import { ErrorInstrumentation, type CapturedErrorHandler } from './errors';
import { LifecycleInstrumentation } from './lifecycle';
import { NativeEventProcessor } from './nativeEvents';
import { NetworkInstrumentation } from './network';

type FetchFunction = typeof fetch;

export class AutomaticInstrumentationController {
  private readonly consoleInstrumentation: ConsoleInstrumentation;
  private readonly errorInstrumentation: ErrorInstrumentation;
  private readonly lifecycleInstrumentation: LifecycleInstrumentation;
  private readonly networkInstrumentation: NetworkInstrumentation;
  private readonly nativeEvents: NativeEventProcessor;
  private readonly nativeEventsEnabled: boolean;
  private readonly nativePollIntervalMillis: number;
  private nativePollTimer: ReturnType<typeof setInterval> | undefined;

  constructor(
    config: ResolvedConfig,
    platform: NativePlatformContext,
    providers: TelemetryProviders,
    bridge: NativeBridge,
    sanitizer: Sanitizer,
    diagnostics: Diagnostics,
    originalFetch: FetchFunction | undefined,
    captureError: CapturedErrorHandler,
    flush: () => Promise<unknown>
  ) {
    this.consoleInstrumentation = new ConsoleInstrumentation(
      config,
      providers.logger
    );
    this.errorInstrumentation = new ErrorInstrumentation(
      config,
      captureError,
      diagnostics
    );
    this.lifecycleInstrumentation = new LifecycleInstrumentation(
      config,
      platform,
      providers.tracer,
      providers.logger,
      providers.metrics,
      flush
    );
    this.networkInstrumentation = new NetworkInstrumentation(
      config,
      providers.tracer,
      providers.logger,
      providers.metrics,
      providers.context,
      sanitizer,
      diagnostics,
      originalFetch
    );
    this.nativeEvents = new NativeEventProcessor(
      bridge,
      providers.tracer,
      providers.logger,
      providers.metrics,
      diagnostics
    );
    this.nativeEventsEnabled =
      bridge.available &&
      ((config.instrumentations.lifecycle.enabled &&
        config.instrumentations.lifecycle.nativeEvents) ||
        (config.instrumentations.errors.enabled &&
          config.instrumentations.errors.nativeCrashes));
    this.nativePollIntervalMillis =
      config.instrumentations.lifecycle.nativePollIntervalMillis;
  }

  start(): void {
    if (this.nativeEventsEnabled) {
      this.nativePollTimer = setInterval(() => {
        this.nativeEvents.drain().catch(() => undefined);
      }, this.nativePollIntervalMillis);
    }
    this.networkInstrumentation.start();
    this.errorInstrumentation.start();
    this.lifecycleInstrumentation.start();
    this.consoleInstrumentation.start();
    if (this.nativeEventsEnabled) {
      this.nativeEvents.drain().catch(() => undefined);
    }
  }

  async shutdown(): Promise<void> {
    if (this.nativePollTimer) clearInterval(this.nativePollTimer);
    this.nativePollTimer = undefined;
    this.consoleInstrumentation.shutdown();
    this.lifecycleInstrumentation.shutdown();
    this.errorInstrumentation.shutdown();
    this.networkInstrumentation.shutdown();
    if (this.nativeEventsEnabled) await this.nativeEvents.drain();
  }
}
