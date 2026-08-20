import { SpanKind, SpanStatusCode } from '@opentelemetry/api';
import type { Diagnostics } from '../core/diagnostics';
import type { DynamicTelemetryContext } from '../core/dynamicContext';
import type { StructuredLogger } from '../core/logger';
import type { MetricRecorder } from '../core/metrics';
import type { Sanitizer } from '../core/sanitizer';
import type { ElvenSpan, ElvenTracer } from '../core/tracer';
import type { AttributeInputs, ResolvedConfig } from '../types';
import { matchesUrl, monotonicNow, serverAddress } from './url';

type FetchFunction = typeof fetch;
type FetchInput = Parameters<FetchFunction>[0];
type FetchInit = Parameters<FetchFunction>[1];
type HeaderCollection = NonNullable<RequestInit['headers']>;
type XhrBody = Parameters<XMLHttpRequest['send']>[0];

interface XhrState {
  method: string;
  url: string;
  requestHeaders: Record<string, string>;
}

interface HeadersLike {
  get(name: string): string | null;
  has?(name: string): boolean;
  set(name: string, value: string): void;
  forEach?(callback: (value: string, key: string) => void): void;
}

interface RequestLike {
  url?: string;
  method?: string;
  headers?: HeaderCollection;
}

let fetchInvocationDepth = 0;

export class NetworkInstrumentation {
  private restoreFetch: (() => void) | undefined;
  private restoreXhr: (() => void) | undefined;

  constructor(
    private readonly config: ResolvedConfig,
    private readonly tracer: ElvenTracer,
    private readonly logger: StructuredLogger,
    private readonly metrics: MetricRecorder,
    private readonly context: DynamicTelemetryContext,
    private readonly sanitizer: Sanitizer,
    private readonly diagnostics: Diagnostics,
    private readonly originalFetch: FetchFunction | undefined
  ) {}

  start(): void {
    const network = this.config.instrumentations.network;
    if (!network.enabled) return;
    if (network.fetch) this.patchFetch();
    if (network.xhr) this.patchXhr();
  }

  shutdown(): void {
    this.restoreFetch?.();
    this.restoreXhr?.();
    this.restoreFetch = undefined;
    this.restoreXhr = undefined;
  }

  private patchFetch(): void {
    const target = globalThis as unknown as { fetch?: FetchFunction };
    const original = this.originalFetch ?? target.fetch;
    if (!original || !target.fetch) {
      this.diagnostics.warn(
        'Global fetch is unavailable; fetch instrumentation is disabled.'
      );
      return;
    }
    const wrapped: FetchFunction = async (input, init) => {
      const url = requestUrl(input);
      if (!url || this.shouldIgnore(url)) {
        return original(input, init);
      }
      const method = requestMethod(input, init);
      const span = this.startRequestSpan(method, url, init?.headers);
      const nextInit = this.withPropagation(input, init, span);
      const startedAt = monotonicNow();
      let request: Promise<Response>;
      fetchInvocationDepth += 1;
      try {
        request = span.run(() => original(input, nextInit));
      } catch (error) {
        this.finishFailure(span, method, url, startedAt, error);
        throw error;
      } finally {
        fetchInvocationDepth = Math.max(0, fetchInvocationDepth - 1);
      }

      try {
        const response = await request;
        this.finishResponse(
          span,
          method,
          url,
          startedAt,
          response.status,
          response.headers
        );
        return response;
      } catch (error) {
        this.finishFailure(span, method, url, startedAt, error);
        throw error;
      }
    };
    target.fetch = wrapped;
    this.restoreFetch = () => {
      if (target.fetch === wrapped) target.fetch = original;
    };
  }

  private patchXhr(): void {
    const XhrConstructor = (
      globalThis as unknown as { XMLHttpRequest?: typeof XMLHttpRequest }
    ).XMLHttpRequest;
    if (!XhrConstructor) {
      this.diagnostics.debug(
        'XMLHttpRequest is unavailable; XHR instrumentation is disabled.'
      );
      return;
    }

    const prototype = XhrConstructor.prototype;
    const originalOpen = prototype.open;
    const originalSend = prototype.send;
    const originalSetRequestHeader = prototype.setRequestHeader;
    const states = new WeakMap<XMLHttpRequest, XhrState>();
    const shouldIgnore = (url: string): boolean => this.shouldIgnore(url);
    const startRequestSpan = (
      method: string,
      url: string,
      headers?: HeaderCollection
    ): ElvenSpan => this.startRequestSpan(method, url, headers);
    const injectXhrHeaders = (
      xhr: XMLHttpRequest,
      state: XhrState,
      span: ElvenSpan
    ): void =>
      this.injectXhrHeaders(xhr, state, span, originalSetRequestHeader);
    const finishFailure = (
      span: ElvenSpan,
      method: string,
      url: string,
      startedAt: number,
      error: unknown
    ): void => this.finishFailure(span, method, url, startedAt, error);
    const finishResponse = (
      span: ElvenSpan,
      method: string,
      url: string,
      startedAt: number,
      status: number,
      headers?: HeadersLike
    ): void =>
      this.finishResponse(span, method, url, startedAt, status, headers);

    function wrappedOpen(
      this: XMLHttpRequest,
      method: string,
      url: string | URL,
      ...rest: ReadonlyArray<unknown>
    ): void {
      states.set(this, {
        method: String(method || 'GET').toUpperCase(),
        url: String(url),
        requestHeaders: {},
      });
      Reflect.apply(originalOpen, this, [method, url, ...rest]);
    }

    function wrappedSetRequestHeader(
      this: XMLHttpRequest,
      name: string,
      value: string
    ): void {
      Reflect.apply(originalSetRequestHeader, this, [name, value]);
      const state = states.get(this);
      if (state) state.requestHeaders[name.toLowerCase()] = value;
    }

    function wrappedSend(this: XMLHttpRequest, body?: XhrBody): void {
      const state = states.get(this);
      if (!state || fetchInvocationDepth > 0 || shouldIgnore(state.url)) {
        Reflect.apply(originalSend, this, [body]);
        return;
      }

      const span = startRequestSpan(
        state.method,
        state.url,
        state.requestHeaders
      );
      injectXhrHeaders(this, state, span);
      const startedAt = monotonicNow();
      let finished = false;
      let failure: unknown;

      const onError = (): void => {
        failure = new Error('XMLHttpRequest network error.');
        finish();
      };
      const onTimeout = (): void => {
        failure = new Error('XMLHttpRequest timed out.');
        finish();
      };
      const onAbort = (): void => {
        failure = new Error('XMLHttpRequest was aborted.');
        finish();
      };
      const onLoadEnd = (): void => finish();
      const finish = (): void => {
        if (finished) return;
        finished = true;
        this.removeEventListener('error', onError);
        this.removeEventListener('timeout', onTimeout);
        this.removeEventListener('abort', onAbort);
        this.removeEventListener('loadend', onLoadEnd);
        if (failure) {
          finishFailure(span, state.method, state.url, startedAt, failure);
          return;
        }
        finishResponse(
          span,
          state.method,
          state.url,
          startedAt,
          safeXhrStatus(this),
          xhrResponseHeaders(this)
        );
      };

      this.addEventListener('error', onError);
      this.addEventListener('timeout', onTimeout);
      this.addEventListener('abort', onAbort);
      this.addEventListener('loadend', onLoadEnd);
      try {
        span.run(() => Reflect.apply(originalSend, this, [body]));
      } catch (error) {
        failure = error;
        finish();
        throw error;
      }
    }

    prototype.open = wrappedOpen as typeof prototype.open;
    prototype.setRequestHeader = wrappedSetRequestHeader;
    prototype.send = wrappedSend;
    this.restoreXhr = () => {
      if (prototype.open === wrappedOpen) prototype.open = originalOpen;
      if (prototype.setRequestHeader === wrappedSetRequestHeader) {
        prototype.setRequestHeader = originalSetRequestHeader;
      }
      if (prototype.send === wrappedSend) prototype.send = originalSend;
    };
  }

  private startRequestSpan(
    method: string,
    url: string,
    headers?: HeaderCollection
  ): ElvenSpan {
    return this.tracer.startSpan(`HTTP ${method}`, {
      kind: SpanKind.CLIENT,
      attributes: {
        'http.request.method': method,
        'url.full': this.sanitizer.url(url),
        ...addressAttributes(url),
        ...this.captureHeaders(
          headers,
          this.config.instrumentations.network.captureRequestHeaders,
          'http.request.header'
        ),
      },
    });
  }

  private finishResponse(
    span: ElvenSpan,
    method: string,
    url: string,
    startedAt: number,
    status: number,
    headers?: HeadersLike
  ): void {
    const durationSeconds = Math.max(0, monotonicNow() - startedAt) / 1_000;
    span.setAttributes({
      'http.response.status_code': status,
      ...this.captureHeaders(
        headers,
        this.config.instrumentations.network.captureResponseHeaders,
        'http.response.header'
      ),
    });
    if (status >= 400 || status === 0) {
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: status === 0 ? 'Network request failed.' : `HTTP ${status}`,
      });
    } else {
      span.setStatus({ code: SpanStatusCode.OK });
    }
    this.recordNetworkMetrics(method, url, status, durationSeconds, span);
    span.end();
  }

  private finishFailure(
    span: ElvenSpan,
    method: string,
    url: string,
    startedAt: number,
    error: unknown
  ): void {
    const durationSeconds = Math.max(0, monotonicNow() - startedAt) / 1_000;
    span.recordException(error).setStatus({
      code: SpanStatusCode.ERROR,
      message:
        error instanceof Error ? error.message : 'Network request failed.',
    });
    this.recordNetworkMetrics(method, url, 0, durationSeconds, span, error);
    this.logger.error(
      'Network request failed.',
      {
        'http.request.method': method,
        'url.full': this.sanitizer.url(url),
        ...addressAttributes(url),
      },
      { context: span.context, error, eventName: 'network.request.failed' }
    );
    span.end();
  }

  private recordNetworkMetrics(
    method: string,
    url: string,
    status: number,
    durationSeconds: number,
    span: ElvenSpan,
    error?: unknown
  ): void {
    const attributes: AttributeInputs = {
      'http.request.method': method,
      'http.response.status_code': status,
      ...addressAttributes(url),
      ...(error
        ? {
            'error.type': error instanceof Error ? error.name : typeof error,
          }
        : {}),
    };
    const options = { context: span.context };
    this.metrics.counter('http.client.request.count', 1, attributes, options);
    this.metrics.histogram(
      'http.client.request.duration',
      durationSeconds,
      attributes,
      { ...options, unit: 's' }
    );
  }

  private withPropagation(
    input: FetchInput,
    init: FetchInit,
    span: ElvenSpan
  ): FetchInit {
    const url = requestUrl(input);
    if (
      !matchesUrl(
        url,
        this.config.instrumentations.network.propagateTraceHeadersTo
      )
    ) {
      return init;
    }
    const headers = cloneHeaders(requestHeaders(input), init?.headers);
    const carrier = this.context.inject({}, span.context);
    for (const [key, value] of Object.entries(carrier)) {
      setHeader(headers, key, value);
    }
    return { ...init, headers };
  }

  private injectXhrHeaders(
    xhr: XMLHttpRequest,
    state: XhrState,
    span: ElvenSpan,
    originalSetRequestHeader: typeof XMLHttpRequest.prototype.setRequestHeader
  ): void {
    if (
      !matchesUrl(
        state.url,
        this.config.instrumentations.network.propagateTraceHeadersTo
      )
    ) {
      return;
    }
    const carrier = this.context.inject({}, span.context);
    for (const [key, value] of Object.entries(carrier)) {
      if (state.requestHeaders[key.toLowerCase()] === undefined) {
        Reflect.apply(originalSetRequestHeader, xhr, [key, value]);
      }
    }
  }

  private captureHeaders(
    headers: HeaderCollection | HeadersLike | undefined,
    allowList: ReadonlyArray<string>,
    prefix: string
  ): AttributeInputs {
    if (!headers || allowList.length === 0) return {};
    const output: Record<string, string> = {};
    for (const rawName of allowList) {
      const name = rawName.toLowerCase();
      const value = readHeader(headers, name);
      if (value !== undefined) {
        output[`${prefix}.${name.replace(/[^a-z0-9_-]/g, '_')}`] = value;
      }
    }
    return output;
  }

  private shouldIgnore(url: string): boolean {
    return matchesUrl(url, this.config.instrumentations.network.ignoreUrls);
  }
}

function requestUrl(input: FetchInput): string {
  if (typeof input === 'string') return input;
  const value = input as RequestLike;
  return value.url ? String(value.url) : String(input);
}

function requestMethod(input: FetchInput, init: FetchInit): string {
  const value = input as RequestLike;
  return String(init?.method ?? value.method ?? 'GET').toUpperCase();
}

function requestHeaders(input: FetchInput): HeaderCollection | undefined {
  return (input as RequestLike).headers;
}

function cloneHeaders(
  base: HeaderCollection | undefined,
  override: HeaderCollection | undefined
): HeaderCollection {
  const HeadersConstructor = (
    globalThis as unknown as { Headers?: typeof Headers }
  ).Headers;
  if (HeadersConstructor) {
    const headers = new HeadersConstructor(base);
    if (override) {
      const overrides = new HeadersConstructor(override);
      overrides.forEach((value, key) => headers.set(key, value));
    }
    return headers;
  }

  const values: Record<string, string> = {};
  appendHeaders(values, base);
  appendHeaders(values, override);
  return values;
}

function appendHeaders(
  target: Record<string, string>,
  headers: HeaderCollection | undefined
): void {
  if (!headers) return;
  if (Array.isArray(headers)) {
    for (const [key, value] of headers) target[key.toLowerCase()] = value;
    return;
  }
  const source = headers as HeadersLike;
  if (source.forEach) {
    source.forEach((value, key) => {
      target[key.toLowerCase()] = value;
    });
    return;
  }
  for (const [key, value] of Object.entries(headers)) {
    target[key.toLowerCase()] = String(value);
  }
}

function setHeader(
  headers: HeaderCollection,
  name: string,
  value: string
): void {
  const target = headers as HeadersLike;
  if (typeof target.set === 'function') {
    target.set(name, value);
    return;
  }
  (headers as Record<string, string>)[name.toLowerCase()] = value;
}

function readHeader(
  headers: HeaderCollection | HeadersLike,
  name: string
): string | undefined {
  const source = headers as HeadersLike;
  if (source.get) return source.get(name) ?? undefined;
  if (Array.isArray(headers)) {
    return headers.find(([key]) => key.toLowerCase() === name)?.[1];
  }
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === name) return String(value);
  }
  return undefined;
}

function addressAttributes(url: string): AttributeInputs {
  const address = serverAddress(url);
  return address ? { 'server.address': address } : {};
}

function safeXhrStatus(xhr: XMLHttpRequest): number {
  try {
    return Number.isFinite(xhr.status) ? xhr.status : 0;
  } catch {
    return 0;
  }
}

function xhrResponseHeaders(xhr: XMLHttpRequest): HeadersLike {
  return {
    get: (name) => {
      try {
        return xhr.getResponseHeader(name);
      } catch {
        return null;
      }
    },
    set: () => undefined,
  };
}
