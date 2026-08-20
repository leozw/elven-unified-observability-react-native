import NativeModule from '../NativeElvenUnifiedObservabilityReactNative';
import type {
  NativePlatformContext,
  NativeTelemetryEvent,
  ResolvedConfig,
  TraceContext,
} from '../types';
import type { Diagnostics } from '../core/diagnostics';

interface NativeInitializationConfig {
  diagnosticsEnabled: boolean;
  maxEventQueueSize: number;
  captureLifecycle: boolean;
  captureNativeCrashes: boolean;
  captureAnr: boolean;
  captureFrozenFrames: boolean;
}

export class NativeBridge {
  constructor(private readonly diagnostics: Diagnostics) {}

  get available(): boolean {
    return NativeModule !== null;
  }

  async initialize(config: ResolvedConfig): Promise<NativePlatformContext> {
    if (!NativeModule) return { platform: 'unknown' };
    const nativeConfig: NativeInitializationConfig = {
      diagnosticsEnabled: config.diagnostics.enabled,
      maxEventQueueSize: Math.min(config.queue.maxItems, 256),
      captureLifecycle:
        config.instrumentations.lifecycle.enabled &&
        config.instrumentations.lifecycle.nativeEvents,
      captureNativeCrashes:
        config.instrumentations.errors.enabled &&
        config.instrumentations.errors.nativeCrashes,
      captureAnr:
        config.instrumentations.lifecycle.enabled &&
        config.instrumentations.lifecycle.nativeEvents &&
        config.instrumentations.lifecycle.anr,
      captureFrozenFrames:
        config.instrumentations.lifecycle.enabled &&
        config.instrumentations.lifecycle.nativeEvents &&
        config.instrumentations.lifecycle.frozenFrames,
    };

    try {
      const value = await NativeModule.initialize(JSON.stringify(nativeConfig));
      return parsePlatformContext(value);
    } catch (error) {
      this.diagnostics.warn('Native observability initialization failed.', {
        error: toErrorMessage(error),
      });
      return { platform: 'unknown' };
    }
  }

  async drainEvents(): Promise<ReadonlyArray<NativeTelemetryEvent>> {
    if (!NativeModule) return [];
    try {
      const values = await NativeModule.drainEvents();
      return values
        .map(parseNativeEvent)
        .filter((event): event is NativeTelemetryEvent => event !== undefined);
    } catch (error) {
      this.diagnostics.debug('Could not drain native telemetry events.', {
        error: toErrorMessage(error),
      });
      return [];
    }
  }

  async readPersistedQueue(): Promise<string | undefined> {
    if (!NativeModule) return undefined;
    try {
      const value = await NativeModule.readPersistedQueue();
      return value || undefined;
    } catch (error) {
      this.diagnostics.debug('Could not read the durable telemetry queue.', {
        error: toErrorMessage(error),
      });
      return undefined;
    }
  }

  async writePersistedQueue(value: string): Promise<boolean> {
    if (!NativeModule) return false;
    try {
      return await NativeModule.writePersistedQueue(value);
    } catch (error) {
      this.diagnostics.debug('Could not persist the durable telemetry queue.', {
        error: toErrorMessage(error),
      });
      return false;
    }
  }

  async clearPersistedQueue(): Promise<boolean> {
    if (!NativeModule) return false;
    try {
      return await NativeModule.clearPersistedQueue();
    } catch (error) {
      this.diagnostics.debug('Could not clear the durable telemetry queue.', {
        error: toErrorMessage(error),
      });
      return false;
    }
  }

  async shutdown(): Promise<boolean> {
    if (!NativeModule) return false;
    try {
      return await NativeModule.shutdown();
    } catch (error) {
      this.diagnostics.debug('Native observability shutdown failed.', {
        error: toErrorMessage(error),
      });
      return false;
    }
  }

  setCurrentTraceContext(value: TraceContext | undefined): void {
    if (!NativeModule) return;
    try {
      NativeModule.setCurrentTraceContext(
        value?.traceId ?? '',
        value?.spanId ?? ''
      );
    } catch {
      // Context propagation across the native boundary is best effort.
    }
  }

  setDiagnosticsEnabled(enabled: boolean): void {
    if (!NativeModule) return;
    try {
      NativeModule.setDiagnosticsEnabled(enabled);
    } catch {
      // Diagnostics must never affect the host application.
    }
  }
}

function parsePlatformContext(value: string): NativePlatformContext {
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    const platform =
      parsed.platform === 'android' || parsed.platform === 'ios'
        ? parsed.platform
        : 'unknown';
    return {
      platform,
      ...optionalString(parsed, 'osVersion'),
      ...optionalString(parsed, 'deviceModel'),
      ...optionalString(parsed, 'appVersion'),
      ...optionalString(parsed, 'appBuild'),
      ...optionalString(parsed, 'appBundleId'),
      ...optionalBoolean(parsed, 'isEmulator'),
      ...optionalNumber(parsed, 'processStartUnixMillis'),
    };
  } catch {
    return { platform: 'unknown' };
  }
}

function parseNativeEvent(value: string): NativeTelemetryEvent | undefined {
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    if (
      typeof parsed.id !== 'string' ||
      !isNativeEventType(parsed.type) ||
      typeof parsed.name !== 'string' ||
      typeof parsed.timestampUnixMillis !== 'number' ||
      !Number.isFinite(parsed.timestampUnixMillis)
    ) {
      return undefined;
    }
    return {
      id: parsed.id,
      type: parsed.type,
      name: parsed.name,
      timestampUnixMillis: parsed.timestampUnixMillis,
      ...optionalNumber(parsed, 'durationMillis'),
      ...(isRecord(parsed.attributes) ? { attributes: parsed.attributes } : {}),
      ...optionalString(parsed, 'traceId'),
      ...optionalString(parsed, 'spanId'),
    };
  } catch {
    return undefined;
  }
}

function isNativeEventType(
  value: unknown
): value is NativeTelemetryEvent['type'] {
  return (
    value === 'crash' ||
    value === 'error' ||
    value === 'lifecycle' ||
    value === 'performance' ||
    value === 'memory'
  );
}

function optionalString(
  source: Record<string, unknown>,
  key: string
): Record<string, string> {
  const value = source[key];
  return typeof value === 'string' && value.length > 0 ? { [key]: value } : {};
}

function optionalNumber(
  source: Record<string, unknown>,
  key: string
): Record<string, number> {
  const value = source[key];
  return typeof value === 'number' && Number.isFinite(value)
    ? { [key]: value }
    : {};
}

function optionalBoolean(
  source: Record<string, unknown>,
  key: string
): Record<string, boolean> {
  const value = source[key];
  return typeof value === 'boolean' ? { [key]: value } : {};
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toErrorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}
