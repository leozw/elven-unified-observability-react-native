import {
  ROOT_CONTEXT,
  createTraceState,
  trace,
  type Span,
} from '@opentelemetry/api';
import type { Logger as OtelLogger } from '@opentelemetry/api-logs';
import {
  activeTraceContext,
  toOtelContext,
  toTraceContext,
} from '../core/context';
import { Diagnostics } from '../core/diagnostics';
import type { DynamicTelemetryContext } from '../core/dynamicContext';
import {
  ensureTextEncoder,
  utf8ByteLength,
  utf8BytesToString,
  utf8StringToBytes,
} from '../core/encoding';
import { randomHex } from '../core/ids';
import { StructuredLogger } from '../core/logger';
import { Sanitizer } from '../core/sanitizer';
import { resolvedConfiguration } from '../__fixtures__/testConfig';

describe('UTF-8 compatibility', () => {
  const originalTextEncoder = (
    globalThis as unknown as { TextEncoder?: unknown }
  ).TextEncoder;

  afterEach(() => {
    Object.defineProperty(globalThis, 'TextEncoder', {
      configurable: true,
      value: originalTextEncoder,
      writable: true,
    });
  });

  it('installs a Hermes-safe TextEncoder and handles bounded encodeInto', () => {
    Object.defineProperty(globalThis, 'TextEncoder', {
      configurable: true,
      value: undefined,
      writable: true,
    });
    ensureTextEncoder();
    const Constructor = (
      globalThis as unknown as {
        TextEncoder: new () => {
          encoding: string;
          encode(value: string): Uint8Array;
          encodeInto(
            value: string,
            destination: Uint8Array
          ): { read: number; written: number };
        };
      }
    ).TextEncoder;
    const encoder = new Constructor();
    expect(encoder.encoding).toBe('utf-8');
    expect(Array.from(encoder.encode('Elven'))).toEqual([
      69, 108, 118, 101, 110,
    ]);
    const full = new Uint8Array(8);
    expect(encoder.encodeInto('ação', full)).toEqual({ read: 4, written: 6 });
    const partial = new Uint8Array(2);
    expect(encoder.encodeInto('ação', partial)).toEqual({
      read: 1,
      written: 1,
    });
  });

  it('round-trips one through four-byte UTF-8 code points', () => {
    const value = 'A¢€😀';
    const bytes = utf8StringToBytes(value);
    expect(utf8ByteLength(value)).toBe(bytes.length);
    expect(utf8BytesToString(bytes)).toBe(value);
    expect(utf8BytesToString(Uint8Array.from([0xff]))).toBe('�');
    expect(utf8BytesToString(utf8StringToBytes('\ud800'))).toBe('�');
    expect(utf8BytesToString(Uint8Array.from([0xe2, 0x28, 0xa1]))).toBe('�(�');
  });
});

describe('IDs and diagnostics', () => {
  const originalCrypto = (globalThis as { crypto?: unknown }).crypto;

  afterEach(() => {
    Object.defineProperty(globalThis, 'crypto', {
      configurable: true,
      value: originalCrypto,
      writable: true,
    });
    jest.restoreAllMocks();
  });

  it('uses cryptographic randomness when available and bounded fallback otherwise', () => {
    Object.defineProperty(globalThis, 'crypto', {
      configurable: true,
      value: {
        getRandomValues: (bytes: Uint8Array) => {
          bytes.fill(0xab);
          return bytes;
        },
      },
      writable: true,
    });
    expect(randomHex(2)).toBe('abab');

    Object.defineProperty(globalThis, 'crypto', {
      configurable: true,
      value: undefined,
      writable: true,
    });
    jest.spyOn(Math, 'random').mockReturnValue(0);
    expect(randomHex(2)).toBe('0000');
  });

  it('rate-limits diagnostics and isolates a throwing sink', () => {
    const sink = jest.fn();
    const diagnostics = new Diagnostics({
      enabled: true,
      verbose: true,
      sink,
    });
    for (let index = 0; index < 10; index += 1) {
      diagnostics.debug('same message', { index });
    }
    diagnostics.info('info');
    diagnostics.warn('warn');
    diagnostics.error('error');
    diagnostics.error('failed for person@example.test token=top-secret', {
      error: 'Bearer abc.def-123',
    });
    expect(sink).toHaveBeenCalledTimes(9);
    const lastDiagnostic = JSON.stringify(sink.mock.calls[8]);
    expect(lastDiagnostic).not.toContain('person@example.test');
    expect(lastDiagnostic).not.toContain('top-secret');
    expect(lastDiagnostic).not.toContain('abc.def-123');

    const throwing = new Diagnostics({
      enabled: true,
      verbose: true,
      sink: () => {
        throw new Error('sink failure');
      },
    });
    expect(() => throwing.warn('safe')).not.toThrow();

    const disabledSink = jest.fn();
    const disabled = new Diagnostics({
      enabled: false,
      verbose: false,
      sink: disabledSink,
    });
    disabled.debug('hidden debug');
    disabled.info('hidden info');
    expect(disabledSink).not.toHaveBeenCalled();
  });
});

describe('Sanitizer edge cases', () => {
  const config = resolvedConfiguration({
    privacy: {
      maxAttributeCount: 16,
      maxAttributeValueLength: 64,
      maxLogMessageLength: 128,
      maxStackTraceLength: 512,
    },
  });
  const sanitizer = new Sanitizer(config.privacy);

  it('normalizes names, arrays, exceptions, non-finite values, and circular messages', () => {
    const circular: Record<string, unknown> = { safe: true };
    circular.self = circular;
    const attributes = sanitizer.attributes({
      primitives: ['a', 2, true, { ignored: true }],
      failure: new TypeError('typed failure'),
      invalidNumber: Number.POSITIVE_INFINITY,
      nullValue: null,
      undefinedValue: undefined,
    });
    expect(attributes.primitives).toEqual(['a', 2, true]);
    expect(attributes['failure.exception.type']).toBe('TypeError');
    expect(attributes.invalidNumber).toBe(0);
    expect(attributes).not.toHaveProperty('nullValue');
    expect(sanitizer.message(circular)).toContain('[Circular]');
    expect(sanitizer.message(42n)).toBe('42');
    expect(sanitizer.message(undefined)).toBe('undefined');
    expect(sanitizer.message(null)).toBe('null');
    expect(sanitizer.exception('plain failure')).toEqual({
      'exception.type': 'string',
      'exception.message': 'plain failure',
    });
    expect(sanitizer.eventName('  line\nname  ')).toBe('line name');
    expect(sanitizer.eventName('   ')).toBe('unnamed.event');
    expect(sanitizer.metricName('42 Cart Value %')).toBe('m_2_cart_value_');
  });

  it('falls back safely when URL and object serialization are unavailable', () => {
    const originalUrl = (globalThis as { URL?: unknown }).URL;
    Object.defineProperty(globalThis, 'URL', {
      configurable: true,
      value: undefined,
      writable: true,
    });
    expect(sanitizer.url('/orders?token=secret#row')).toBe('/orders');
    Object.defineProperty(globalThis, 'URL', {
      configurable: true,
      value: originalUrl,
      writable: true,
    });

    const value = Object.create(null) as Record<string, unknown>;
    value.bigint = 10n;
    expect(sanitizer.message(value)).toContain('10');
  });
});

describe('StructuredLogger', () => {
  it('supports contextual loggers, correlation, sampling, and fail-open emit', () => {
    const config = resolvedConfiguration();
    const sanitizer = new Sanitizer(config.privacy);
    const emit = jest.fn();
    const contextManager = {
      active: () => ROOT_CONTEXT,
      telemetryAttributes: () => ({ 'session.id': 'session-42' }),
    } as unknown as DynamicTelemetryContext;
    const logger = new StructuredLogger(
      { emit } as unknown as OtelLogger,
      contextManager,
      sanitizer,
      config,
      () => 0
    );
    const context = trace.setSpanContext(ROOT_CONTEXT, {
      traceId: '0123456789abcdef0123456789abcdef',
      spanId: '0123456789abcdef',
      traceFlags: 1,
    });
    const child = logger.child(context, { component: 'checkout' });
    child.debug('debug');
    child.info('info', { step: 1 });
    child.warn('warn');
    child.error('error', undefined, new Error('failure'));
    child.fatal('fatal', undefined, new Error('fatal failure'));
    expect(emit).toHaveBeenCalledTimes(5);
    expect(emit.mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({
        attributes: expect.objectContaining({
          component: 'checkout',
          step: 1,
          trace_id: '0123456789abcdef0123456789abcdef',
          span_id: '0123456789abcdef',
        }),
      })
    );

    const sampledOut = resolvedConfiguration({
      sampling: { logRatio: { debug: 0 } },
    });
    const dropped = new StructuredLogger(
      { emit } as unknown as OtelLogger,
      contextManager,
      sanitizer,
      sampledOut,
      () => 0
    );
    dropped.debug('dropped');
    expect(emit).toHaveBeenCalledTimes(5);

    const throwing = new StructuredLogger(
      {
        emit: () => {
          throw new Error('exporter failure');
        },
      } as unknown as OtelLogger,
      contextManager,
      sanitizer,
      config,
      () => 0
    );
    expect(() => throwing.error('safe')).not.toThrow();
  });
});

describe('trace context conversion', () => {
  const valid = {
    traceId: '0123456789abcdef0123456789abcdef',
    spanId: '0123456789abcdef',
    traceFlags: 1,
  };

  it('converts remote input, preserves contexts, and rejects invalid IDs', () => {
    const converted = toOtelContext(
      { ...valid, traceState: 'vendor=value' },
      ROOT_CONTEXT
    );
    expect(trace.getSpanContext(converted)).toEqual(
      expect.objectContaining({ ...valid, isRemote: true })
    );
    expect(trace.getSpanContext(converted)?.traceState?.serialize()).toBe(
      'vendor=value'
    );
    expect(toOtelContext(undefined, converted)).toBe(converted);
    expect(toOtelContext(ROOT_CONTEXT, converted)).toBe(ROOT_CONTEXT);
    expect(toOtelContext({ ...valid, traceId: 'invalid' }, converted)).toBe(
      converted
    );
  });

  it('extracts direct and span-backed contexts without fabricating active IDs', () => {
    expect(toTraceContext(undefined)).toBeUndefined();
    expect(activeTraceContext()).toBeUndefined();
    expect(toTraceContext(valid)).toEqual(valid);

    const traceState = createTraceState('vendor=value');
    const span = {
      spanContext: () => ({ ...valid, traceState }),
    } as unknown as Span;
    expect(toTraceContext(span)).toEqual({
      ...valid,
      traceState: 'vendor=value',
    });
    expect(toTraceContext({ ...valid, spanId: 'invalid' })).toBeUndefined();
  });
});
