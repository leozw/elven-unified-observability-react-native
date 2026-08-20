import { Diagnostics } from '../core/diagnostics';
import { DurableTransport } from '../transport/durableTransport';
import type { QueueStore } from '../transport/storage';
import type { TransportFetch } from '../transport/types';
import { resolvedConfiguration } from '../__fixtures__/testConfig';

class MemoryStore implements QueueStore {
  readonly persistent = true;
  value: string | undefined;
  clears = 0;

  constructor(value?: string) {
    this.value = value;
  }

  async read(): Promise<string | undefined> {
    return this.value;
  }

  async write(value: string): Promise<boolean> {
    this.value = value;
    return true;
  }

  async clear(): Promise<boolean> {
    this.value = undefined;
    this.clears += 1;
    return true;
  }
}

function diagnostics(messages: string[] = []): Diagnostics {
  return new Diagnostics({
    enabled: true,
    verbose: true,
    sink: (message) => messages.push(message),
  });
}

describe('DurableTransport', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it('delivers the exact signal endpoint without persisting auth headers', async () => {
    const store = new MemoryStore();
    const fetchImplementation = jest.fn<
      ReturnType<TransportFetch>,
      Parameters<TransportFetch>
    >(async () => ({ status: 202 }));
    const config = resolvedConfiguration({
      collector: {
        endpoint: 'https://collector.example.test',
        headers: { authorization: 'Bearer top-secret' },
      },
    });
    const transport = new DurableTransport(
      config,
      store,
      diagnostics(),
      fetchImplementation
    );

    await expect(transport.enqueue('logs', '{"safe":true}', 2)).resolves.toBe(
      true
    );
    expect(store.value).not.toContain('top-secret');
    const result = await transport.flush(true, 1_000);

    expect(result).toEqual({
      delivered: 1,
      dropped: 0,
      pending: 0,
      timedOut: false,
    });
    expect(fetchImplementation).toHaveBeenCalledWith(
      'https://collector.example.test/v1/logs',
      expect.objectContaining({
        method: 'POST',
        body: '{"safe":true}',
        headers: expect.objectContaining({
          'authorization': 'Bearer top-secret',
          'content-type': 'application/json',
        }),
      })
    );
    await transport.shutdown(1_000);
  });

  it('evicts the oldest lowest-priority batch under bounded backpressure', async () => {
    const store = new MemoryStore();
    const transport = new DurableTransport(
      resolvedConfiguration({ queue: { maxItems: 8 } }),
      store,
      diagnostics(),
      undefined,
      () => 1_000,
      () => 0.5
    );
    for (let index = 0; index < 8; index += 1) {
      await transport.enqueue('metrics', `low-${index}`, 0);
    }
    await expect(transport.enqueue('traces', 'critical', 3)).resolves.toBe(
      true
    );

    const persisted = JSON.parse(store.value ?? '{}') as {
      items: Array<{ payload: string }>;
    };
    expect(persisted.items).toHaveLength(8);
    expect(persisted.items.map((item) => item.payload)).not.toContain('low-0');
    expect(persisted.items.map((item) => item.payload)).toContain('critical');
    expect(transport.health().droppedItems).toBe(1);
    await transport.shutdown(1);
  });

  it('drops permanent failures and opens the circuit on repeated transient failures', async () => {
    let status = 400;
    const fetchImplementation: TransportFetch = async () => ({
      status,
      headers: { get: () => null },
    });
    const config = resolvedConfiguration({
      retry: {
        maxAttempts: 4,
        circuitBreakerFailureThreshold: 2,
        circuitBreakerResetMillis: 60_000,
      },
    });
    const transport = new DurableTransport(
      config,
      new MemoryStore(),
      diagnostics(),
      fetchImplementation
    );
    await transport.enqueue('logs', 'invalid');
    expect(await transport.flush(true, 1_000)).toEqual(
      expect.objectContaining({ dropped: 1, pending: 0 })
    );

    status = 503;
    await transport.enqueue('traces', 'retry-me');
    await transport.flush(true, 1_000);
    await transport.flush(true, 1_000);
    expect(transport.health()).toEqual(
      expect.objectContaining({
        queueItems: 1,
        transportFailures: 2,
        circuitOpen: true,
      })
    );
    await transport.shutdown(1_000);
  });

  it('times out an unavailable backend without throwing into the application', async () => {
    const fetchImplementation: TransportFetch = () =>
      new Promise(() => undefined);
    const config = resolvedConfiguration();
    config.collector.timeoutMillis = 500;
    const transport = new DurableTransport(
      config,
      new MemoryStore(),
      diagnostics(),
      fetchImplementation
    );
    await transport.enqueue('logs', 'pending');
    const flush = transport.flush(true, 500);
    await jest.advanceTimersByTimeAsync(500);

    await expect(flush).resolves.toEqual(
      expect.objectContaining({ pending: 1, timedOut: true })
    );
    const shutdown = transport.shutdown(1);
    await jest.advanceTimersByTimeAsync(1);
    await shutdown;
  });

  it('bounds server Retry-After values to the configured retry delay', async () => {
    const store = new MemoryStore();
    const now = 10_000;
    const transport = new DurableTransport(
      resolvedConfiguration({ retry: { maxDelayMillis: 5_000 } }),
      store,
      diagnostics(),
      async () => ({
        status: 429,
        headers: { get: () => '86400' },
      }),
      () => now
    );

    await transport.enqueue('metrics', 'retry-later');
    await transport.flush(true, 1_000);
    const persisted = JSON.parse(store.value ?? '{}') as {
      items: Array<{ nextAttemptUnixMillis: number }>;
    };
    expect(persisted.items[0]?.nextAttemptUnixMillis).toBe(now + 5_000);
    await transport.shutdown(1_000);
  });

  it('discards corrupt persisted state and retains only valid, unexpired items', async () => {
    const messages: string[] = [];
    const store = new MemoryStore('{not-json');
    const transport = new DurableTransport(
      resolvedConfiguration(),
      store,
      diagnostics(messages),
      undefined
    );

    await transport.flush(true, 1);
    expect(store.clears).toBe(1);
    expect(transport.health().queueItems).toBe(0);
    expect(messages.join(' ')).toContain('Corrupt durable telemetry queue');
    await transport.shutdown(1);
  });
});
