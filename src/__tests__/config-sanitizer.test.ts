import { ROOT_CONTEXT, trace } from '@opentelemetry/api';
import { resolveConfig, validateConfiguration } from '../core/config';
import { DynamicTelemetryContext } from '../core/dynamicContext';
import { Sanitizer } from '../core/sanitizer';
import {
  matchesUrl,
  monotonicNow,
  serverAddress,
} from '../instrumentation/url';
import {
  baseConfiguration,
  resolvedConfiguration,
} from '../__fixtures__/testConfig';

describe('configuration', () => {
  it('resolves safe production defaults and exact OTLP signal paths', () => {
    const config = resolveConfig(
      baseConfiguration({
        environment: 'production',
        collector: { endpoint: 'https://collector.example.test/v1/logs' },
      })
    );

    expect(config.collector.endpoint).toBe('https://collector.example.test');
    expect(config.collector.logsEndpoint).toBe(
      'https://collector.example.test/v1/logs'
    );
    expect(config.collector.metricsEndpoint).toBe(
      'https://collector.example.test/v1/metrics'
    );
    expect(config.sampling.traceRatio).toBe(0.1);
    expect(config.sampling.logRatio.error).toBe(1);
    expect(config.sampling.logRatio.debug).toBe(0.05);
    expect(config.queue.maxBytes).toBe(524_288);
  });

  it('rejects cleartext OTLP in production', () => {
    expect(() =>
      resolveConfig(
        baseConfiguration({
          environment: 'production',
          collector: { endpoint: 'http://collector.example.test' },
        })
      )
    ).toThrow('Production telemetry requires HTTPS');
  });

  it('rejects every cleartext signal override in production', () => {
    for (const signal of ['logs', 'metrics', 'traces'] as const) {
      const configuration = baseConfiguration({
        environment: 'production ',
        collector: {
          endpoint: 'HTTPS://collector.example.test',
          [`${signal}Endpoint`]: `http://${signal}.example.test/v1/${signal}`,
        },
      });

      expect(validateConfiguration(configuration)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            level: 'error',
            path: `collector.${signal}Endpoint`,
            message: 'Production telemetry requires HTTPS.',
          }),
        ])
      );
      expect(() => resolveConfig(configuration)).toThrow(
        'Production telemetry requires HTTPS'
      );
    }
  });

  it('rejects unsafe endpoints, header injection, and invalid retry ranges', () => {
    const configuration = baseConfiguration({
      collector: {
        endpoint: 'https://collector.example.test',
        logsEndpoint: 'file:///tmp/logs',
        headers: { authorization: 'Bearer safe\r\nX-Evil: yes' },
      },
      retry: { initialDelayMillis: 10_000, maxDelayMillis: 1_000 },
    });
    const issues = validateConfiguration(configuration);

    expect(issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'collector.logsEndpoint' }),
        expect.objectContaining({
          path: 'collector.headers.authorization',
        }),
        expect.objectContaining({ path: 'retry.initialDelayMillis' }),
      ])
    );
    expect(() => resolveConfig(configuration)).toThrow(
      /Invalid Elven observability configuration/
    );
  });

  it('caps the configured payload budget below the protected native file cap', () => {
    const config = resolvedConfiguration({
      queue: { maxBytes: Number.MAX_SAFE_INTEGER },
    });
    expect(config.queue.maxBytes).toBe(4_194_304);
  });
});

describe('privacy sanitizer', () => {
  const config = resolvedConfiguration({
    privacy: {
      maxAttributeCount: 8,
      maxAttributeValueLength: 64,
      urlQueryPolicy: 'allow-listed',
      allowedUrlQueryKeys: ['page'],
    },
  });
  const sanitizer = new Sanitizer(config.privacy);

  it('flattens bounded attributes and redacts nested sensitive data', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const attributes = sanitizer.attributes({
      profile: {
        email: 'person@example.test',
        displayName: 'A'.repeat(100),
      },
      authorization: 'Bearer secret',
      circular,
      valid: true,
    });

    expect(attributes['profile.email']).toBe('[REDACTED]');
    expect(attributes.authorization).toBe('[REDACTED]');
    expect(String(attributes['profile.displayName'])).toHaveLength(64);
    expect(attributes.valid).toBe(true);
    expect(JSON.stringify(attributes)).not.toContain('person@example.test');
    expect(JSON.stringify(attributes)).not.toContain('Bearer secret');
  });

  it('removes credentials, fragments, and non-allow-listed query values', () => {
    const sanitized = sanitizer.url(
      'https://user:pass@api.example.test/orders/person@example.test?page=2&token=secret#row'
    );
    expect(sanitized).toContain('page=2');
    expect(sanitized).not.toContain('user');
    expect(sanitized).not.toContain('pass');
    expect(sanitized).not.toContain('token');
    expect(sanitized).not.toContain('person@example.test');
    expect(sanitized).not.toContain('#row');
  });

  it('fails closed when a custom attribute filter throws', () => {
    const strict = resolvedConfiguration({
      privacy: {
        attributeFilter: (key, value) => {
          if (key === 'broken') throw new Error('filter failure');
          return value;
        },
      },
    });
    const filtered = new Sanitizer(strict.privacy).attributes({
      broken: 'secret',
      healthy: 'kept',
    });
    expect(filtered).toEqual({ healthy: 'kept' });
  });

  it('redacts credentials and common PII embedded in free-form text', () => {
    const jwt = [
      'eyJhbGciOiJIUzI1NiJ9',
      'eyJzdWIiOiJwZXJzb24ifQ',
      'signature123456',
    ].join('.');
    const message = sanitizer.message(
      `login person@example.test password=hunter2 authorization: Bearer abc.def-123 jwt=${jwt} https://user:pass@api.example.test`
    );
    const attributes = sanitizer.attributes({
      'detail': `api_key='client-secret' owner=person@example.test`,
      'person@example.test': 'identifier in key',
    });
    const exception = sanitizer.exception(
      new Error(`request failed for person@example.test token=${jwt}`)
    );

    for (const output of [
      message,
      JSON.stringify(attributes),
      JSON.stringify(exception),
    ]) {
      expect(output).not.toContain('person@example.test');
      expect(output).not.toContain('hunter2');
      expect(output).not.toContain('abc.def-123');
      expect(output).not.toContain(jwt);
      expect(output).not.toContain('user:pass');
    }
    expect(sanitizer.eventName('event.person@example.test')).not.toContain(
      'person@example.test'
    );
    expect(sanitizer.metricName('person@example.test.login')).not.toContain(
      'person_example.test'
    );
  });
});

describe('context and URL propagation boundaries', () => {
  it('does not match a lookalike origin', () => {
    expect(
      matchesUrl('https://api.example.test.evil.test/orders', [
        'https://api.example.test',
      ])
    ).toBe(false);
    expect(
      matchesUrl('https://api.example.test/v1/orders', [
        'https://api.example.test/v1',
      ])
    ).toBe(true);
    expect(
      matchesUrl('https://api.example.test/v10/orders', [
        'https://api.example.test/v1',
      ])
    ).toBe(false);
  });

  it('matches only explicit URL boundaries and supports reusable regexes', () => {
    expect(
      matchesUrl('https://api.example.test/checkout', [
        'https://api.example.test',
      ])
    ).toBe(true);
    expect(
      matchesUrl('https://api.example.test/v1/orders', [
        'https://api.example.test/v1/',
      ])
    ).toBe(true);
    const matcher = /\/orders$/g;
    expect(matchesUrl('https://api.example.test/orders', [matcher])).toBe(true);
    expect(matchesUrl('https://api.example.test/orders', [matcher])).toBe(true);
    expect(matchesUrl('https://api.example.test/customers', [matcher])).toBe(
      false
    );
  });

  it('uses safe URL and timing fallbacks in constrained runtimes', () => {
    expect(serverAddress('https://api.example.test:8443/orders')).toBe(
      'api.example.test'
    );
    expect(serverAddress('not a URL')).toBeUndefined();
    expect(serverAddress('file:///tmp/telemetry')).toBeUndefined();

    const urlDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'URL');
    const performanceDescriptor = Object.getOwnPropertyDescriptor(
      globalThis,
      'performance'
    );
    Object.defineProperty(globalThis, 'URL', {
      configurable: true,
      value: undefined,
      writable: true,
    });
    Object.defineProperty(globalThis, 'performance', {
      configurable: true,
      value: { now: () => 42 },
      writable: true,
    });
    try {
      expect(matchesUrl('/v1', ['/v1'])).toBe(true);
      expect(matchesUrl('/v1/orders', ['/v1'])).toBe(true);
      expect(matchesUrl('/v1/orders', ['/v1/'])).toBe(true);
      expect(matchesUrl('/v10/orders', ['/v1'])).toBe(false);
      expect(serverAddress('https://fallback.example.test:4318/v1')).toBe(
        'fallback.example.test'
      );
      expect(serverAddress('/relative')).toBeUndefined();
      expect(monotonicNow()).toBe(42);

      Object.defineProperty(globalThis, 'performance', {
        configurable: true,
        value: undefined,
        writable: true,
      });
      expect(monotonicNow()).toBeGreaterThan(0);
    } finally {
      restoreProperty('URL', urlDescriptor);
      restoreProperty('performance', performanceDescriptor);
    }
  });

  it('injects W3C context and keeps high-cardinality identity out of metrics', () => {
    const config = resolvedConfiguration();
    const context = new DynamicTelemetryContext(
      config,
      new Sanitizer(config.privacy)
    );
    const spanContext = {
      traceId: '0123456789abcdef0123456789abcdef',
      spanId: '0123456789abcdef',
      traceFlags: 1,
    };
    const otelContext = trace.setSpanContext(ROOT_CONTEXT, spanContext);
    context.setUser({ id: 'person@example.test' });
    context.setTenant({ id: 'tenant-42' });
    context.setNavigationContext({
      'app.screen.name': 'Checkout',
      'app.screen.id': 'route-instance-123',
      'order.id': 'high-cardinality',
    });

    const carrier = context.inject({}, otelContext);
    expect(carrier.traceparent).toBe(
      '00-0123456789abcdef0123456789abcdef-0123456789abcdef-01'
    );
    expect(context.telemetryAttributes()['enduser.pseudo.id']).toMatch(
      /^sha256:[0-9a-f]{64}$/
    );
    expect(JSON.stringify(context.telemetryAttributes())).not.toContain(
      'person@example.test'
    );
    expect(context.telemetryAttributes()['tenant.id']).toMatch(
      /^sha256:[0-9a-f]{64}$/
    );
    expect(JSON.stringify(context.telemetryAttributes())).not.toContain(
      'tenant-42'
    );
    expect(context.metricAttributes()).toEqual({
      'app.screen.name': 'Checkout',
    });
    context.shutdown();
  });
});

function restoreProperty(
  name: string,
  descriptor: PropertyDescriptor | undefined
): void {
  if (descriptor) {
    Object.defineProperty(globalThis, name, descriptor);
  } else {
    delete (globalThis as Record<string, unknown>)[name];
  }
}
