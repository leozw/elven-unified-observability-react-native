import { ElvenObservabilitySdk } from '../sdk';
import { Sanitizer } from '../core/sanitizer';
import { Diagnostics } from '../core/diagnostics';
import { DurableTransport } from '../transport/durableTransport';
import {
  baseConfiguration,
  resolvedConfiguration,
} from '../__fixtures__/testConfig';

const parent = {
  traceId: '0123456789abcdef0123456789abcdef',
  spanId: '0123456789abcdef',
  traceFlags: 1,
};

describe('audit: application callbacks are never replayed', () => {
  const sdk = new ElvenObservabilitySdk();

  beforeAll(async () => {
    await sdk.initialize(
      baseConfiguration({
        signals: { logs: false, metrics: false, traces: false },
        instrumentations: {
          console: false,
          network: false,
          errors: false,
          lifecycle: false,
        },
      })
    );
  });
  afterAll(async () => {
    await sdk.shutdown();
  });

  it.each([undefined, null, false, 0, ''])(
    'preserves callback result %p exactly once',
    (result) => {
      for (const run of [
        (operation: () => unknown) => sdk.context.run(parent, operation),
        (operation: () => unknown) => sdk.traces.restore(parent, operation),
      ]) {
        const operation = jest.fn(() => result);
        expect(run(operation)).toBe(result);
        expect(operation).toHaveBeenCalledTimes(1);
      }
    }
  );

  it('propagates the original application error without rerunning the operation', () => {
    const error = new Error('application failure');
    const operation = jest.fn(() => {
      throw error;
    });
    expect(() => sdk.traces.restore(parent, operation)).toThrow(error);
    expect(operation).toHaveBeenCalledTimes(1);
  });
});

describe('audit: URL privacy boundaries', () => {
  it('removes adjacent denied query keys including duplicates', () => {
    const config = resolvedConfiguration({
      privacy: {
        urlQueryPolicy: 'allow-listed',
        allowedUrlQueryKeys: ['page'],
      },
    });
    const sanitized = new Sanitizer(config.privacy).url(
      'https://api.example.test/?first=private-one&second=private-two&second=private-three&page=2&third=private-four&fourth=private-five'
    );
    expect(sanitized).toBe('https://api.example.test/?page=2');
  });

  it('redacts and bounds fallback URLs when URL is unavailable', () => {
    const original = globalThis.URL;
    const config = resolvedConfiguration({
      privacy: { maxAttributeValueLength: 64 },
    });
    try {
      (globalThis as unknown as { URL: unknown }).URL = undefined;
      const sanitized = new Sanitizer(config.privacy).url(
        'https://user:raw-secret@api.example.test/' +
          'x'.repeat(500) +
          '?private=yes'
      );
      expect(sanitized).not.toContain('raw-secret');
      expect(sanitized.length).toBeLessThanOrEqual(64);
    } finally {
      globalThis.URL = original;
    }
  });
});

describe('audit: durable signal disable', () => {
  it('bounds enqueues waiting for a stalled storage read', async () => {
    let release: (value: undefined) => void = () => undefined;
    const read = new Promise<undefined>((resolve) => {
      release = resolve;
    });
    const transport = new DurableTransport(
      resolvedConfiguration({ queue: { maxItems: 8 } }),
      {
        persistent: true,
        read: () => read,
        write: async () => true,
        clear: async () => true,
      },
      new Diagnostics({ enabled: false, verbose: false }),
      async () => ({ status: 202 })
    );
    let rejected = 0;
    const pending = Array.from({ length: 1000 }, () =>
      transport.enqueue('logs', 'bounded').then((accepted) => {
        if (!accepted) rejected += 1;
      })
    );
    await Promise.resolve();
    expect(rejected).toBe(992);
    release(undefined);
    await Promise.all(pending);
    expect(transport.health().queueItems).toBeLessThanOrEqual(8);
    await transport.shutdown(1000);
  });

  it('does not replay persisted batches for a disabled signal', async () => {
    const fetch = jest.fn(async () => ({ status: 202 }));
    const config = resolvedConfiguration({ signals: { logs: false } });
    const transport = new DurableTransport(
      config,
      {
        persistent: true,
        read: async () =>
          JSON.stringify({
            schemaVersion: 1,
            items: [
              {
                id: 'old-log',
                signal: 'logs',
                payload: '{"private":"stale"}',
                priority: 1,
                enqueuedAtUnixMillis: Date.now(),
                attempts: 0,
                nextAttemptUnixMillis: Date.now(),
              },
            ],
          }),
        write: async () => true,
        clear: async () => true,
      },
      new Diagnostics({ enabled: false, verbose: false }),
      fetch
    );
    try {
      await transport.flush(true);
      expect(fetch).not.toHaveBeenCalled();
      expect(transport.health().queueItems).toBe(0);
    } finally {
      await transport.shutdown(1);
    }
  });
});
