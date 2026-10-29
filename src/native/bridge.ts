import NativeModule from '../NativeElvenUnifiedObservabilityReactNative';
import type {
  NativePlatformContext,
  NativeTelemetryEvent,
  ResolvedConfig,
  TraceContext,
} from '../types';
import type { Diagnostics } from '../core/diagnostics';
import { createEventId } from '../core/ids';
import { queueProvenance } from '../core/provenance';

interface NativeInitializationConfig {
  sessionId: string;
  queueProvenance: string;
  diagnosticsEnabled: boolean;
  maxEventQueueSize: number;
  captureLifecycle: boolean;
  captureNativeCrashes: boolean;
  captureAnr: boolean;
  captureFrozenFrames: boolean;
}

export class NativeBridge {
  readonly sessionId = createEventId();
  private closed = false;
  private purgeRequested = false;
  private closing: Promise<boolean> | undefined;
  private closingWithPurge = false;
  private rejected = false;
  private readonly pending = new Set<Promise<unknown>>();
  constructor(private readonly diagnostics: Diagnostics) {}

  get available(): boolean {
    return (
      NativeModule != null &&
      typeof NativeModule.closeSession === 'function' &&
      !this.closed &&
      !this.rejected
    );
  }

  async initialize(config: ResolvedConfig): Promise<NativePlatformContext> {
    if (!this.available || !NativeModule) {
      if (NativeModule)
        this.diagnostics.warn(
          'Native lifecycle fencing is unavailable; rebuild the app. Native telemetry and persistence are disabled.'
        );
      return { platform: 'unknown' };
    }
    const nativeConfig: NativeInitializationConfig = {
      sessionId: this.sessionId,
      queueProvenance: queueProvenance(config),
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
      const value = await this.track(
        NativeModule.initialize(JSON.stringify(nativeConfig))
      );
      if (this.closed) {
        // A late initialize acknowledgement cannot resurrect its native generation.
        await NativeModule.closeSession(this.sessionId, this.purgeRequested);
        return { platform: 'unknown' };
      }
      if (
        (JSON.parse(value) as { sessionId?: string }).sessionId !==
        this.sessionId
      ) {
        this.rejected = true;
        this.diagnostics.warn(
          'Native telemetry ownership was not acknowledged; native capture and storage are disabled.'
        );
        return { platform: 'unknown' };
      }
      return parsePlatformContext(value);
    } catch (error) {
      this.diagnostics.warn('Native observability initialization failed.', {
        error: toErrorMessage(error),
      });
      return { platform: 'unknown' };
    }
  }

  async drainEvents(): Promise<ReadonlyArray<NativeTelemetryEvent>> {
    if (!this.available || !NativeModule) return [];
    try {
      const values = await this.track(NativeModule.drainEvents());
      if (this.closed) return [];
      return values
        .slice(0, 256)
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
    if (!this.available || !NativeModule) return undefined;
    try {
      const value = await this.track(NativeModule.readPersistedQueue());
      if (this.closed) return undefined;
      return value || undefined;
    } catch (error) {
      this.diagnostics.debug('Could not read the durable telemetry queue.', {
        error: toErrorMessage(error),
      });
      return undefined;
    }
  }

  async writePersistedQueue(value: string): Promise<boolean> {
    if (!this.available || !NativeModule) return false;
    try {
      const written = await this.track(NativeModule.writePersistedQueue(value));
      return !this.closed && written;
    } catch (error) {
      this.diagnostics.debug('Could not persist the durable telemetry queue.', {
        error: toErrorMessage(error),
      });
      return false;
    }
  }

  async clearPersistedQueue(): Promise<boolean> {
    if (!this.available || !NativeModule) return false;
    try {
      return await this.track(NativeModule.clearPersistedQueue());
    } catch (error) {
      this.diagnostics.debug('Could not clear the durable telemetry queue.', {
        error: toErrorMessage(error),
      });
      return false;
    }
  }

  shutdown(): Promise<boolean> {
    return this.close(false);
  }

  close(purge: boolean): Promise<boolean> {
    this.closed = true;
    this.purgeRequested ||= purge;
    if (!NativeModule) return Promise.resolve(true);
    if (typeof NativeModule.closeSession !== 'function')
      return Promise.resolve(false);
    if (!this.closing || (purge && !this.closingWithPurge)) {
      this.closingWithPurge ||= purge;
      const module = NativeModule;
      const outstanding = [...this.pending];
      // Invalidate natively now, but do not release ownership while RPC delivery is outstanding.
      const request = Promise.resolve().then(() =>
        module.closeSession(this.sessionId, this.purgeRequested)
      );
      this.closing = (async () => {
        const acknowledged = await request;
        await Promise.allSettled(outstanding);
        return acknowledged;
      })().catch((error: unknown) => {
        this.diagnostics.warn('Native close/purge was not acknowledged.', {
          error: toErrorMessage(error),
        });
        return false;
      });
    }
    return this.closing;
  }

  private track<T>(operation: Promise<T>): Promise<T> {
    this.pending.add(operation);
    return operation.finally(() => {
      this.pending.delete(operation);
    });
  }

  setCurrentTraceContext(value: TraceContext | undefined): void {
    if (!this.available || !NativeModule) return;
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
    if (!this.available || !NativeModule) return;
    try {
      NativeModule.setDiagnosticsEnabled(enabled);
    } catch {
      // Diagnostics must never affect the host application.
    }
  }
}

function parsePlatformContext(value: string): NativePlatformContext {
  try {
    if (value.length > 16_384) return { platform: 'unknown' };
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
    if (value.length > 131_072) return undefined;
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
