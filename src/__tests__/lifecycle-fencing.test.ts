jest.mock('../NativeElvenUnifiedObservabilityReactNative', () => ({
  __esModule: true,
  default: {
    initialize: jest.fn(),
    closeSession: jest.fn(),
    drainEvents: jest.fn(),
    readPersistedQueue: jest.fn(),
    writePersistedQueue: jest.fn(),
    clearPersistedQueue: jest.fn(),
    shutdown: jest.fn(),
    setCurrentTraceContext: jest.fn(),
    setDiagnosticsEnabled: jest.fn(),
  },
}));
import NativeModule from '../NativeElvenUnifiedObservabilityReactNative';
import { Platform } from 'react-native';
import { ElvenObservabilitySdk } from '../sdk';
import { Diagnostics } from '../core/diagnostics';
import { Sanitizer } from '../core/sanitizer';
import { DurableTransport } from '../transport/durableTransport';
import {
  baseConfiguration,
  resolvedConfiguration,
} from '../__fixtures__/testConfig';
import type { UnifiedObservabilityConfig } from '../types';
import { activeOwner, releaseOwner, setGlobalConsent } from '../core/lifecycle';

const native = NativeModule as unknown as Record<string, jest.Mock>;
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const config = (): UnifiedObservabilityConfig =>
  baseConfiguration({
    lifecycleTimeoutMillis: 20,
    signals: { logs: true, traces: false, metrics: false },
    diagnostics: { enabled: true, sink: jest.fn() },
  });
const tick = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve();
};

describe('generation fencing, consent and one lifecycle budget', () => {
  // HTTP here exercises the JS adapter; native HTTP ownership has separate tests/runtime probes.
  const originalPlatform = Platform.OS;
  beforeAll(() => {
    Object.assign(Platform, { OS: 'web' });
  });
  afterAll(() => {
    Object.assign(Platform, { OS: originalPlatform });
  });
  let file: string | undefined;
  let current = '';
  const closed = new Set<string>();
  const originalFetch = globalThis.fetch;
  beforeEach(() => {
    setGlobalConsent(true);
    jest.useFakeTimers();
    jest.resetAllMocks();
    file = undefined;
    current = '';
    closed.clear();
    native.initialize!.mockImplementation(async (raw: string) => {
      const { sessionId } = JSON.parse(raw) as { sessionId: string };
      if (closed.has(sessionId)) return '{}';
      current = sessionId;
      return JSON.stringify({ platform: 'android', sessionId });
    });
    native.closeSession!.mockImplementation(
      async (id: string, purge: boolean) => {
        closed.add(id);
        if (current && current !== id) return false;
        current = '';
        if (purge) file = undefined;
        return true;
      }
    );
    native.readPersistedQueue!.mockImplementation(async () => file ?? '');
    native.writePersistedQueue!.mockImplementation(async (raw: string) => {
      if (JSON.parse(raw).ownerGeneration !== current) return false;
      file = raw;
      return true;
    });
    native.clearPersistedQueue!.mockImplementation(async () => {
      file = undefined;
      return true;
    });
    native.drainEvents!.mockResolvedValue([]);
    globalThis.fetch = jest.fn(async () => ({
      status: 202,
      headers: { get: () => null },
    })) as unknown as typeof fetch;
  });
  afterEach(() => {
    jest.useRealTimers();
    globalThis.fetch = originalFetch;
  });

  it('bounds a hung initializer and cleans its late completion before another owner can start', async () => {
    const gate = deferred<string>();
    native.initialize!.mockImplementationOnce(() => gate.promise);
    const sdk = new ElvenObservabilitySdk();
    const starting = sdk.initialize(config());
    await jest.advanceTimersByTimeAsync(20);
    await starting;
    expect(sdk.health().state).toBe('stopped');
    const blocked = new ElvenObservabilitySdk();
    await blocked.initialize(config());
    expect(blocked.health().disabledReason).toContain('another-owner');
    gate.resolve('{}');
    await tick();
    expect(native.closeSession).toHaveBeenCalled();
    await blocked.initialize(config());
    expect(blocked.health().state).toBe('started');
    await blocked.shutdown(20, { flush: false, purge: true });
  });

  it('uses the same deadline for storage, provider flush and shutdown; late reads cannot send or persist', async () => {
    const gate = deferred<string>();
    native.readPersistedQueue!.mockReturnValueOnce(gate.promise);
    const sdk = new ElvenObservabilitySdk();
    await sdk.initialize(config());
    sdk.logs.error('old data');
    const stopping = sdk.shutdown(20);
    await jest.advanceTimersByTimeAsync(20);
    expect((await stopping).timedOut).toBe(true);
    const writes = native.writePersistedQueue!.mock.calls.length;
    gate.resolve('');
    await tick();
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(native.writePersistedQueue!.mock.calls.length).toBe(writes);
    expect(sdk.health().state).toBe('stopped');
    await tick();
  });

  it('does not release a timed-out initializer lease when native cleanup rejects ownership', async () => {
    const gate = deferred<string>();
    native.initialize!.mockReturnValueOnce(gate.promise);
    native.closeSession!.mockResolvedValue(false);
    const sdk = new ElvenObservabilitySdk();
    try {
      const starting = sdk.initialize(config());
      await jest.advanceTimersByTimeAsync(20);
      await starting;
      gate.resolve('{}');
      await tick();
      const replacement = new ElvenObservabilitySdk();
      await replacement.initialize(config());
      expect(replacement.health().disabledReason).toContain('another-owner');
      expect(native.initialize).toHaveBeenCalledTimes(1);
    } finally {
      // Test-only reset: production deliberately quarantines unacknowledged cleanup.
      const owner = activeOwner();
      if (owner) releaseOwner(owner);
    }
  });

  it('shares a configuration-transition budget across purge and replacement initialization', async () => {
    const sdk = new ElvenObservabilitySdk();
    await sdk.initialize(config());
    native.closeSession!.mockImplementationOnce(
      (id: string) =>
        new Promise<boolean>((resolve) => {
          setTimeout(() => {
            closed.add(id);
            current = '';
            file = undefined;
            resolve(true);
          }, 12);
        })
    );
    const gate = deferred<string>();
    native.initialize!.mockReturnValueOnce(gate.promise);
    let finished = false;
    const transition = sdk.reconfigure(config(), 20).then(() => {
      finished = true;
    });
    await jest.advanceTimersByTimeAsync(19);
    expect(finished).toBe(false);
    await jest.advanceTimersByTimeAsync(1);
    await transition;
    expect(sdk.health().state).toBe('stopped');
    gate.resolve('{}');
    await tick();
  });

  it('revokes consent without a final send, purges storage, and requires explicit grant to restart', async () => {
    const sdk = new ElvenObservabilitySdk();
    await sdk.initialize(config());
    sdk.logs.error('private before revoke');
    const result = await sdk.setConsent(false, 20);
    expect(result.purged).toBe(true);
    expect(file).toBeUndefined();
    const sends = (globalThis.fetch as jest.Mock).mock.calls.length;
    await sdk.initialize(config());
    sdk.logs.error('private after revoke');
    await sdk.flush();
    await jest.advanceTimersByTimeAsync(1000);
    expect((globalThis.fetch as jest.Mock).mock.calls.length).toBe(sends);
    expect(sdk.health().state).toBe('stopped');
    await sdk.setConsent(true);
    expect(sdk.health().state).toBe('started');
    await sdk.shutdown(20, { flush: false, purge: true });
  });

  it('allows repeated cold denial without retaining a lease from an already-closed bridge', async () => {
    const sdk = new ElvenObservabilitySdk();
    await sdk.initialize({ ...config(), consent: 'denied' });
    expect((await sdk.setConsent(false, 20)).purged).toBe(true);
    expect(activeOwner()).toBeUndefined();
    await sdk.setConsent(true, 20);
    expect(sdk.health().state).toBe('started');
    await sdk.setConsent(false, 20);
    expect((await sdk.setConsent(false, 20)).purged).toBe(true);
    expect(activeOwner()).toBeUndefined();
  });

  it('aborts an in-flight request on revoke and ignores its late successful completion', async () => {
    const gate = deferred<Response>();
    let signal: AbortSignal | undefined;
    globalThis.fetch = jest.fn((_input, init) => {
      signal = init?.signal as AbortSignal;
      return gate.promise;
    });
    const sdk = new ElvenObservabilitySdk();
    await sdk.initialize(config());
    sdk.logs.error('private in flight');
    const flushing = sdk.flush(100);
    await tick();
    await jest.advanceTimersByTimeAsync(0);
    expect(globalThis.fetch).toHaveBeenCalled();
    const revoking = sdk.setConsent(false, 20);
    await jest.advanceTimersByTimeAsync(20);
    await revoking;
    expect(signal?.aborted).toBe(true);
    const sends = (globalThis.fetch as jest.Mock).mock.calls.length;
    gate.resolve({
      status: 202,
      headers: { get: () => null },
    } as unknown as Response);
    await tick();
    await flushing;
    await tick();
    expect(file).toBeUndefined();
    expect((globalThis.fetch as jest.Mock).mock.calls.length).toBe(sends);
    expect(sdk.health().state).toBe('stopped');
  });

  it('fences a native write whose completion arrives after consent purge', async () => {
    const gate = deferred<void>();
    native.writePersistedQueue!.mockImplementationOnce(async (raw: string) => {
      await gate.promise;
      const owner = (JSON.parse(raw) as { ownerGeneration: string })
        .ownerGeneration;
      if (closed.has(owner)) return false;
      file = raw;
      return true;
    });
    const sdk = new ElvenObservabilitySdk();
    await sdk.initialize(config());
    sdk.logs.error('late private write');
    const flushing = sdk.flush(100);
    await tick();
    expect(native.writePersistedQueue).toHaveBeenCalled();
    const revoke = sdk.setConsent(false, 20);
    await jest.advanceTimersByTimeAsync(20);
    expect((await revoke).purged).toBe(false);
    gate.resolve();
    await tick();
    await flushing;
    await tick();
    expect(file).toBeUndefined();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('upgrades a graceful shutdown to no-send purge within the revocation budget', async () => {
    const gate = deferred<string>();
    native.readPersistedQueue!.mockReturnValueOnce(gate.promise);
    const sdk = new ElvenObservabilitySdk();
    await sdk.initialize(config());
    sdk.logs.error('private');
    const graceful = sdk.shutdown(1000);
    const revoke = sdk.setConsent(false, 20);
    await jest.advanceTimersByTimeAsync(20);
    expect((await revoke).timedOut).toBe(true);
    gate.resolve('');
    await tick();
    await graceful;
    await tick();
    expect(file).toBeUndefined();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('shares revocation across copies/instances and purges while initially denied', async () => {
    const owner = new ElvenObservabilitySdk();
    const other = new ElvenObservabilitySdk();
    await owner.initialize(config());
    expect((await other.setConsent(false, 20)).purged).toBe(true);
    expect(owner.health().state).toBe('stopped');
    await other.initialize(config());
    expect(other.health().state).toBe('stopped');
    file = 'stale previous process data';
    const fresh = new ElvenObservabilitySdk();
    await fresh.initialize({ ...config(), consent: 'denied' });
    expect(file).toBeUndefined();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('enforces one owner and rotates identity/destination with no old generation replay', async () => {
    const a = new ElvenObservabilitySdk();
    const b = new ElvenObservabilitySdk();
    await a.initialize(config());
    await b.initialize(config());
    expect(native.initialize).toHaveBeenCalledTimes(1);
    expect(b.health().disabledReason).toContain('another-owner');
    a.logs.error('old private');
    await a.setIdentity({
      user: { id: 'new-user' },
      tenant: { id: 'new-tenant' },
    });
    expect(a.health().state).toBe('started');
    await a.reconfigure({
      ...config(),
      collector: { endpoint: 'https://other.example.test' },
    });
    expect(a.health().state).toBe('started');
    expect(
      JSON.stringify((globalThis.fetch as jest.Mock).mock.calls)
    ).not.toContain('old private');
    await a.shutdown(20, { flush: false, purge: true });
    await b.initialize(config());
    expect(b.health().state).toBe('started');
    await b.shutdown(20, { flush: false, purge: true });
  });
});

describe('durable provenance and bounded input work', () => {
  it('cannot flush or schedule old sends after shutdown or purge', async () => {
    const fetch = jest.fn(async () => ({ status: 503 }));
    const store = {
      persistent: false,
      read: async () => undefined,
      write: async () => true,
      clear: async () => true,
    };
    const transport = new DurableTransport(
      resolvedConfiguration(),
      store,
      new Diagnostics({ enabled: false, verbose: false }),
      fetch
    );
    await transport.enqueue('logs', 'private');
    await transport.shutdown(10);
    const calls = fetch.mock.calls.length;
    await transport.flush(true);
    await transport.purge();
    await transport.flush(true);
    expect(fetch).toHaveBeenCalledTimes(calls);
    expect(await transport.enqueue('logs', 'later')).toBe(false);
    expect(transport.health().queueItems).toBe(0);
  });
  it.each(['collector', 'headers', 'user', 'tenant', 'legacy'])(
    'drops durable data for a changed %s',
    async (change) => {
      let file: string | undefined;
      const store = {
        persistent: true,
        read: async () => file,
        write: async (value: string) => {
          file = value;
          return true;
        },
        clear: async () => {
          file = undefined;
          return true;
        },
      };
      const settings = resolvedConfiguration();
      const diagnostics = new Diagnostics({ enabled: false, verbose: false });
      const first = new DurableTransport(
        settings,
        store,
        diagnostics,
        undefined
      );
      await first.enqueue('logs', 'private old');
      first.stop();
      const next = resolvedConfiguration(
        change === 'collector'
          ? { collector: { endpoint: 'https://other.example.test' } }
          : change === 'headers'
            ? {
                collector: {
                  endpoint: 'https://collector.example.test',
                  headers: { authorization: 'Bearer new' },
                },
              }
            : change === 'user'
              ? { identity: { user: { id: 'new-user' } } }
              : change === 'tenant'
                ? { identity: { tenant: { id: 'new-tenant' } } }
                : {}
      );
      if (change === 'legacy') file = '{"schemaVersion":1,"items":[]}';
      const fetch = jest.fn(async () => ({ status: 202 }));
      const second = new DurableTransport(next, store, diagnostics, fetch);
      await second.flush(true);
      expect(fetch).not.toHaveBeenCalled();
      expect(file).toBeUndefined();
      second.stop();
    }
  );

  it('does not call getters/toJSON, rejects huge text before redaction, and bounds inspected children', () => {
    const sanitizer = new Sanitizer(resolvedConfiguration().privacy);
    const getter = jest.fn(() => {
      throw new Error('must not execute');
    });
    const input = {
      toJSON: getter,
      safe: 'ok',
      nested: { password: 'secret' },
    };
    Object.defineProperty(input, 'computed', { enumerable: true, get: getter });
    expect(sanitizer.message(input)).not.toContain('secret');
    expect(getter).not.toHaveBeenCalled();
    expect(sanitizer.message('token=' + 'x'.repeat(1000000))).toBe(
      '[OVERSIZE]'
    );
    let reads = 0;
    const values = new Proxy(new Array(100000), {
      getOwnPropertyDescriptor(target, key) {
        reads++;
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
    });
    sanitizer.attributes({ values });
    expect(reads).toBeLessThanOrEqual(32);
    expect(
      new Sanitizer(
        resolvedConfiguration({ privacy: { redactKeys: [] } }).privacy
      ).attributes({ password: 'secret' }).password
    ).toBe('[REDACTED]');
  });
});
