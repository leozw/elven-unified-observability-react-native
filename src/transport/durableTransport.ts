import { createEventId } from '../core/ids';
import { utf8ByteLength } from '../core/encoding';
import type { Diagnostics } from '../core/diagnostics';
import type { ResolvedConfig, SignalType } from '../types';
import type { QueueStore } from './storage';
import type {
  PersistedQueue,
  QueueItem,
  TransportFetch,
  TransportFlushResult,
  TransportHealth,
  TransportResponse,
} from './types';

interface SendResult {
  outcome: 'delivered' | 'permanent-failure' | 'transient-failure';
  retryAfterMillis?: number;
  status?: number;
}

interface AbortControllerLike {
  readonly signal: unknown;
  abort(): void;
}

type AbortControllerConstructor = new () => AbortControllerLike;

const CONTENT_TYPE = 'application/json';
const PERSISTED_SCHEMA_VERSION = 1;

export class DurableTransport {
  private items: QueueItem[] = [];
  private queueBytes = 0;
  private droppedItems = 0;
  private transportFailures = 0;
  private consecutiveFailures = 0;
  private circuitOpenUntil = 0;
  private lastSuccessfulExportUnixMillis: number | undefined;
  private mutation = Promise.resolve();
  private flushPromise: Promise<TransportFlushResult> | undefined;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private accepting = true;
  private readonly ready: Promise<void>;

  constructor(
    private readonly config: ResolvedConfig,
    private readonly store: QueueStore,
    private readonly diagnostics: Diagnostics,
    private readonly fetchImplementation: TransportFetch | undefined,
    private readonly now: () => number = Date.now,
    private readonly random: () => number = Math.random
  ) {
    this.ready = this.restore();
  }

  async enqueue(
    signal: SignalType,
    payload: string,
    priority = 1
  ): Promise<boolean> {
    if (!this.accepting || !this.config.signals[signal]) return false;
    const byteLength = utf8ByteLength(payload);
    if (byteLength === 0 || byteLength > this.config.queue.maxItemBytes) {
      this.droppedItems += 1;
      this.diagnostics.warn(
        'Telemetry batch exceeded the configured item limit.',
        {
          signal,
          byteLength,
          maxItemBytes: this.config.queue.maxItemBytes,
        }
      );
      return false;
    }

    const now = this.now();
    const item: QueueItem = {
      id: createEventId(),
      signal,
      payload,
      byteLength,
      priority: clampPriority(priority),
      enqueuedAtUnixMillis: now,
      attempts: 0,
      nextAttemptUnixMillis: now,
    };

    const accepted = await this.withMutation(async () => {
      this.purgeExpired(now);
      this.items.push(item);
      this.queueBytes += item.byteLength;
      this.enforceLimits();
      const retained = this.items.some((candidate) => candidate.id === item.id);
      await this.persist();
      return retained;
    });

    if (accepted) {
      this.schedule(0);
    } else {
      this.diagnostics.warn(
        'Telemetry batch was evicted by queue backpressure.',
        {
          signal,
        }
      );
    }
    return accepted;
  }

  flush(
    force = false,
    timeoutMillis = this.config.batch.exportTimeoutMillis
  ): Promise<TransportFlushResult> {
    if (this.flushPromise) return this.flushPromise;
    this.clearTimer();
    this.flushPromise = this.runFlush(force, timeoutMillis).finally(() => {
      this.flushPromise = undefined;
      this.scheduleNextAttempt();
    });
    return this.flushPromise;
  }

  async shutdown(timeoutMillis: number): Promise<TransportFlushResult> {
    this.accepting = false;
    this.clearTimer();
    const result = await this.flush(true, timeoutMillis);
    await this.withMutation(() => this.persist());
    return result;
  }

  health(): TransportHealth {
    return {
      queueItems: this.items.length,
      queueBytes: this.queueBytes,
      droppedItems: this.droppedItems,
      transportFailures: this.transportFailures,
      circuitOpen: this.circuitOpenUntil > this.now(),
      ...(this.lastSuccessfulExportUnixMillis !== undefined
        ? {
            lastSuccessfulExportUnixMillis: this.lastSuccessfulExportUnixMillis,
          }
        : {}),
    };
  }

  private async runFlush(
    force: boolean,
    timeoutMillis: number
  ): Promise<TransportFlushResult> {
    await this.ready;
    const deadline = this.now() + Math.max(1, timeoutMillis);
    const attempted = new Set<string>();
    let delivered = 0;
    let dropped = 0;
    let timedOut = false;

    while (this.now() < deadline) {
      const item = await this.withMutation(() => {
        this.purgeExpired(this.now());
        if (!force && this.circuitOpenUntil > this.now()) return undefined;
        return this.items.find(
          (candidate) =>
            !attempted.has(candidate.id) &&
            (force || candidate.nextAttemptUnixMillis <= this.now())
        );
      });
      if (!item) break;
      attempted.add(item.id);

      const remaining = Math.max(1, deadline - this.now());
      const result = await this.send(item, remaining);
      const update = await this.withMutation(async () => {
        const index = this.items.findIndex(
          (candidate) => candidate.id === item.id
        );
        if (index < 0) return { delivered: 0, dropped: 0 };

        if (result.outcome === 'delivered') {
          this.removeAt(index);
          this.consecutiveFailures = 0;
          this.circuitOpenUntil = 0;
          this.lastSuccessfulExportUnixMillis = this.now();
          await this.persist();
          return { delivered: 1, dropped: 0 };
        }

        const current = this.items[index];
        if (!current) return { delivered: 0, dropped: 0 };
        current.attempts += 1;
        if (
          result.outcome === 'permanent-failure' ||
          current.attempts >= this.config.retry.maxAttempts
        ) {
          this.removeAt(index);
          this.droppedItems += 1;
          await this.persist();
          return { delivered: 0, dropped: 1 };
        }

        this.transportFailures += 1;
        this.consecutiveFailures += 1;
        const requestedDelay =
          result.retryAfterMillis ?? this.retryDelay(current.attempts);
        current.nextAttemptUnixMillis =
          this.now() +
          Math.min(
            this.config.retry.maxDelayMillis,
            Math.max(0, requestedDelay)
          );
        if (
          this.consecutiveFailures >=
          this.config.retry.circuitBreakerFailureThreshold
        ) {
          this.circuitOpenUntil =
            this.now() + this.config.retry.circuitBreakerResetMillis;
        }
        await this.persist();
        return { delivered: 0, dropped: 0 };
      });
      delivered += update.delivered;
      dropped += update.dropped;

      if (!force && this.circuitOpenUntil > this.now()) break;
    }

    if (this.now() >= deadline && this.items.length > 0) timedOut = true;
    return {
      delivered,
      dropped,
      pending: this.items.length,
      timedOut,
    };
  }

  private async send(
    item: QueueItem,
    remainingMillis: number
  ): Promise<SendResult> {
    if (!this.fetchImplementation) {
      return { outcome: 'transient-failure' };
    }

    const endpoint = this.config.collector[`${item.signal}Endpoint`];
    const timeoutMillis = Math.min(
      remainingMillis,
      this.config.collector.timeoutMillis
    );
    const AbortControllerValue = (
      globalThis as unknown as { AbortController?: AbortControllerConstructor }
    ).AbortController;
    const controller = AbortControllerValue
      ? new AbortControllerValue()
      : undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;

    try {
      const request = this.fetchImplementation(endpoint, {
        method: 'POST',
        headers: {
          ...this.config.collector.headers,
          'content-type': CONTENT_TYPE,
        },
        body: item.payload,
        ...(controller ? { signal: controller.signal } : {}),
      });
      const timeoutPromise = new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          controller?.abort();
          reject(new Error('Telemetry export timed out.'));
        }, timeoutMillis);
      });
      const response = await Promise.race([request, timeoutPromise]);
      return classifyResponse(response, this.now());
    } catch (error) {
      this.diagnostics.debug('Telemetry export failed and will be retried.', {
        signal: item.signal,
        error: error instanceof Error ? error.message : String(error),
      });
      return { outcome: 'transient-failure' };
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  private retryDelay(attempts: number): number {
    const exponential = Math.min(
      this.config.retry.maxDelayMillis,
      this.config.retry.initialDelayMillis * 2 ** Math.max(0, attempts - 1)
    );
    const jitter = exponential * this.config.retry.jitterRatio;
    return Math.max(
      0,
      Math.round(exponential - jitter + this.random() * jitter * 2)
    );
  }

  private async restore(): Promise<void> {
    const serialized = await this.store.read();
    if (!serialized) return;
    try {
      const parsed = JSON.parse(serialized) as Partial<PersistedQueue>;
      if (
        parsed.schemaVersion !== PERSISTED_SCHEMA_VERSION ||
        !Array.isArray(parsed.items)
      ) {
        throw new Error('Unsupported durable queue schema.');
      }
      const now = this.now();
      for (const candidate of parsed.items) {
        const item = validateQueueItem(candidate);
        if (
          item &&
          now - item.enqueuedAtUnixMillis <= this.config.queue.maxAgeMillis &&
          item.byteLength <= this.config.queue.maxItemBytes
        ) {
          this.items.push(item);
          this.queueBytes += item.byteLength;
        }
      }
      this.enforceLimits();
      this.scheduleNextAttempt();
    } catch (error) {
      this.items = [];
      this.queueBytes = 0;
      await this.store.clear();
      this.diagnostics.warn('Corrupt durable telemetry queue was discarded.', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private withMutation<T>(operation: () => Promise<T> | T): Promise<T> {
    const result = this.mutation.then(async () => {
      await this.ready;
      return operation();
    });
    this.mutation = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  private async persist(): Promise<void> {
    if (!this.store.persistent) return;
    if (this.items.length === 0) {
      await this.store.clear();
      return;
    }
    const persisted: PersistedQueue = {
      schemaVersion: PERSISTED_SCHEMA_VERSION,
      items: this.items,
    };
    await this.store.write(JSON.stringify(persisted));
  }

  private purgeExpired(now: number): void {
    const oldestAllowed = now - this.config.queue.maxAgeMillis;
    for (let index = this.items.length - 1; index >= 0; index -= 1) {
      const item = this.items[index];
      if (item && item.enqueuedAtUnixMillis < oldestAllowed) {
        this.removeAt(index);
        this.droppedItems += 1;
      }
    }
  }

  private enforceLimits(): void {
    while (
      this.items.length > this.config.queue.maxItems ||
      this.queueBytes > this.config.queue.maxBytes
    ) {
      const index = findEvictionIndex(this.items);
      if (index < 0) break;
      this.removeAt(index);
      this.droppedItems += 1;
    }
  }

  private removeAt(index: number): void {
    const [removed] = this.items.splice(index, 1);
    if (removed)
      this.queueBytes = Math.max(0, this.queueBytes - removed.byteLength);
  }

  private schedule(delayMillis: number): void {
    if (!this.accepting || this.retryTimer || this.flushPromise) return;
    this.retryTimer = setTimeout(
      () => {
        this.retryTimer = undefined;
        this.flush().catch((error: unknown) => {
          this.diagnostics.debug('Background telemetry flush failed.', {
            error: error instanceof Error ? error.message : String(error),
          });
        });
      },
      Math.max(0, delayMillis)
    );
  }

  private scheduleNextAttempt(): void {
    if (!this.accepting || this.items.length === 0) return;
    const now = this.now();
    const nextItemAt = Math.min(
      ...this.items.map((item) => item.nextAttemptUnixMillis)
    );
    const nextAt = Math.max(nextItemAt, this.circuitOpenUntil);
    this.schedule(Math.max(0, nextAt - now));
  }

  private clearTimer(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
  }
}

function classifyResponse(
  response: TransportResponse,
  now: number
): SendResult {
  if (response.status >= 200 && response.status < 300) {
    return { outcome: 'delivered', status: response.status };
  }
  if (
    response.status === 408 ||
    response.status === 425 ||
    response.status === 429 ||
    response.status >= 500
  ) {
    const retryAfter = response.headers?.get('retry-after');
    return {
      outcome: 'transient-failure',
      status: response.status,
      ...(retryAfter
        ? { retryAfterMillis: parseRetryAfter(retryAfter, now) }
        : {}),
    };
  }
  return { outcome: 'permanent-failure', status: response.status };
}

function parseRetryAfter(value: string, now: number): number {
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - now) : 0;
}

function validateQueueItem(value: unknown): QueueItem | undefined {
  if (!isRecord(value)) return undefined;
  if (
    typeof value.id !== 'string' ||
    !isSignal(value.signal) ||
    typeof value.payload !== 'string' ||
    typeof value.priority !== 'number' ||
    typeof value.enqueuedAtUnixMillis !== 'number' ||
    typeof value.attempts !== 'number' ||
    typeof value.nextAttemptUnixMillis !== 'number'
  ) {
    return undefined;
  }
  const actualByteLength = utf8ByteLength(value.payload);
  return {
    id: value.id,
    signal: value.signal,
    payload: value.payload,
    byteLength: actualByteLength,
    priority: clampPriority(value.priority),
    enqueuedAtUnixMillis: value.enqueuedAtUnixMillis,
    attempts: Math.max(0, Math.floor(value.attempts)),
    nextAttemptUnixMillis: value.nextAttemptUnixMillis,
  };
}

function findEvictionIndex(items: ReadonlyArray<QueueItem>): number {
  let selected = -1;
  for (let index = 0; index < items.length; index += 1) {
    const current = items[index];
    const candidate = selected >= 0 ? items[selected] : undefined;
    if (
      current &&
      (!candidate ||
        current.priority < candidate.priority ||
        (current.priority === candidate.priority &&
          current.enqueuedAtUnixMillis < candidate.enqueuedAtUnixMillis))
    ) {
      selected = index;
    }
  }
  return selected;
}

function clampPriority(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.min(3, Math.max(0, Math.floor(value)));
}

function isSignal(value: unknown): value is SignalType {
  return value === 'logs' || value === 'metrics' || value === 'traces';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
