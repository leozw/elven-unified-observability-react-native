import type { Diagnostics } from '../core/diagnostics';
import type { ResolvedConfig } from '../types';

export interface CapturedErrorDetails {
  source: 'javascript.global' | 'javascript.unhandled_rejection';
  fatal: boolean;
  unhandled: boolean;
}

export type CapturedErrorHandler = (
  error: unknown,
  details: CapturedErrorDetails
) => void;

interface ErrorUtilsLike {
  getGlobalHandler?(): ((error: Error, isFatal?: boolean) => void) | undefined;
  setGlobalHandler?(handler: (error: Error, isFatal?: boolean) => void): void;
}

interface RejectionEventLike {
  reason?: unknown;
}

type RejectionHandler = (event: RejectionEventLike) => unknown;

interface RejectionTarget {
  addEventListener?(
    type: 'unhandledrejection',
    listener: RejectionHandler
  ): void;
  removeEventListener?(
    type: 'unhandledrejection',
    listener: RejectionHandler
  ): void;
  onunhandledrejection?: RejectionHandler | null;
}

export class ErrorInstrumentation {
  private readonly restores: Array<() => void> = [];
  private readonly seenObjects = new WeakSet<object>();
  private readonly recentFingerprints = new Map<string, number>();

  constructor(
    private readonly config: ResolvedConfig,
    private readonly capture: CapturedErrorHandler,
    private readonly diagnostics: Diagnostics
  ) {}

  start(): void {
    const settings = this.config.instrumentations.errors;
    if (!settings.enabled) return;
    if (settings.javascriptErrors) this.installGlobalErrorHandler();
    if (settings.unhandledRejections) this.installUnhandledRejectionHandler();
  }

  shutdown(): void {
    for (const restore of this.restores.splice(0).reverse()) restore();
  }

  private installGlobalErrorHandler(): void {
    const errorUtils = (
      globalThis as unknown as { ErrorUtils?: ErrorUtilsLike }
    ).ErrorUtils;
    if (!errorUtils?.setGlobalHandler) {
      this.diagnostics.debug(
        'React Native ErrorUtils is unavailable; global JS errors are not auto-captured.'
      );
      return;
    }
    const previous = errorUtils.getGlobalHandler?.();
    if (!previous) {
      this.diagnostics.debug(
        'React Native did not expose its previous global error handler; JS error interception was skipped to preserve fatal behavior.'
      );
      return;
    }
    const handler = (error: Error, isFatal = false): void => {
      this.captureOnce(error, {
        source: 'javascript.global',
        fatal: isFatal,
        unhandled: true,
      });
      previous(error, isFatal);
    };
    errorUtils.setGlobalHandler(handler);
    this.restores.push(() => {
      if (errorUtils.getGlobalHandler?.() === handler) {
        errorUtils.setGlobalHandler?.(previous);
      }
    });
  }

  private installUnhandledRejectionHandler(): void {
    const target = globalThis as unknown as RejectionTarget;
    const handler: RejectionHandler = (event) => {
      this.captureOnce(event.reason, {
        source: 'javascript.unhandled_rejection',
        fatal: false,
        unhandled: true,
      });
    };

    if (target.addEventListener && target.removeEventListener) {
      target.addEventListener('unhandledrejection', handler);
      this.restores.push(() => {
        target.removeEventListener?.('unhandledrejection', handler);
      });
      return;
    }

    const previous = target.onunhandledrejection;
    const chained: RejectionHandler = (event) => {
      handler(event);
      return previous?.(event);
    };
    target.onunhandledrejection = chained;
    this.restores.push(() => {
      if (target.onunhandledrejection === chained) {
        target.onunhandledrejection = previous;
      }
    });
  }

  private captureOnce(error: unknown, details: CapturedErrorDetails): void {
    try {
      if (typeof error === 'object' && error !== null) {
        if (this.seenObjects.has(error)) return;
        this.seenObjects.add(error);
      }
      const fingerprint = errorFingerprint(error, details.source);
      const now = Date.now();
      const previous = this.recentFingerprints.get(fingerprint);
      if (previous !== undefined && now - previous < 2_000) return;
      this.recentFingerprints.set(fingerprint, now);
      if (this.recentFingerprints.size > 64) {
        const oldest = this.recentFingerprints.keys().next().value;
        if (oldest !== undefined) this.recentFingerprints.delete(oldest);
      }
      this.capture(error, details);
    } catch {
      // Error handling must never throw into React Native's fatal path.
    }
  }
}

function errorFingerprint(error: unknown, source: string): string {
  if (error instanceof Error) {
    return `${source}:${error.name}:${error.message}:${error.stack?.slice(0, 256) ?? ''}`;
  }
  return `${source}:${typeof error}:${String(error).slice(0, 256)}`;
}
