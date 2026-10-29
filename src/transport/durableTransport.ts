import { createEventId } from '../core/ids';
import { utf8ByteLength } from '../core/encoding';
import { queueProvenance } from '../core/provenance';
import { LifecycleDeadline } from '../core/lifecycle';
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
  retryNotBefore?: number;
  status?: number;
}

interface AbortControllerLike {
  readonly signal: unknown;
  abort(): void;
}

type AbortControllerConstructor = new () => AbortControllerLike;

const CONTENT_TYPE = 'application/json';
const PERSISTED_SCHEMA_VERSION = 2;

export class DurableTransport {
  private items: QueueItem[] = [];
  private queueBytes = 0;
  private droppedItems = 0;
  private transportFailures = 0;
  private consecutiveFailures = 0;
  private circuitOpenUntil = 0;
  private retryNotBefore: Partial<Record<SignalType, number>> = {};
  private lastSuccessfulExportUnixMillis: number | undefined;
  private mutation = Promise.resolve();
  private flushPromise: Promise<TransportFlushResult> | undefined;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private accepting = true;
  private closed = false;
  private readonly controllers = new Set<AbortControllerLike>();
  private readonly stopWaiters = new Set<() => void>();
  readonly provenance: string;
  private pendingItems = 0;
  private pendingBytes = 0;
  private readonly ready: Promise<void>;

  constructor(
    private readonly config: ResolvedConfig,
    private readonly store: QueueStore,
    private readonly diagnostics: Diagnostics,
    private readonly fetchImplementation: TransportFetch | undefined,
    private readonly now: () => number = Date.now,
    private readonly random: () => number = Math.random,
    readonly ownerGeneration: string = createEventId()
  ) {
    this.provenance = queueProvenance(config);
    this.ready = this.restore().catch(() => {
      this.diagnostics.warn(
        'Durable storage read failed; only the in-memory queue is available.'
      );
    });
  }

  async enqueue(
    signal: SignalType,
    payload: string,
    priority = 1
  ): Promise<boolean> {
    if (!this.accepting || !this.config.signals[signal]) return false;
    if (payload.length > this.config.queue.maxItemBytes) {
      this.droppedItems += 1;
      return false;
    }
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
    if (
      this.pendingItems >= this.config.queue.maxItems ||
      this.pendingBytes + byteLength > this.config.queue.maxBytes
    ) {
      this.droppedItems += 1;
      return false;
    }
    this.pendingItems += 1;
    this.pendingBytes += byteLength;

    const now = this.now();
    if (
      (this.retryNotBefore[signal] ?? 0) >=
      now + this.config.queue.maxAgeMillis
    ) {
      this.pendingItems -= 1;
      this.pendingBytes -= byteLength;
      this.droppedItems += 1;
      return false;
    }
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
      if (!this.accepting) return false;
      if (
        (this.retryNotBefore[signal] ?? 0) >=
        item.enqueuedAtUnixMillis + this.config.queue.maxAgeMillis
      ) {
        this.droppedItems += 1;
        return false;
      }
      this.purgeExpired(now);
      this.items.push(item);
      this.queueBytes += item.byteLength;
      this.enforceLimits();
      const retained = this.items.some((candidate) => candidate.id === item.id);
      await this.persist();
      return retained;
    }).finally(() => {
      this.pendingItems -= 1;
      this.pendingBytes -= byteLength;
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
    if (this.closed) return Promise.resolve(this.result());
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
    const budget = new LifecycleDeadline(timeoutMillis, () => this.stop());
    try {
      return await budget.wait(this.flush(true, budget.remaining()));
    } catch {
      return { ...this.result(), timedOut: true };
    } finally {
      this.stop();
    }
  }

  stop(purge = false): void {
    this.closed = true;
    this.accepting = false;
    this.clearTimer();
    for (const resume of this.stopWaiters) resume();
    this.stopWaiters.clear();
    for (const controller of this.controllers) {
      try {
        controller.abort();
      } catch {
        /* Broken abort implementations cannot reopen the transport. */
      }
    }
    this.controllers.clear();
    if (purge) {
      this.droppedItems += this.items.length;
      this.items = [];
      this.queueBytes = 0;
      this.retryNotBefore = {};
    }
  }

  async purge(): Promise<boolean> {
    this.stop(true);
    return this.store.clear();
  }

  private result(): TransportFlushResult {
    return {
      delivered: 0,
      dropped: 0,
      pending: this.items.length,
      timedOut: false,
    };
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
    if (this.closed) return this.result();
    const deadline = this.now() + Math.max(1, timeoutMillis);
    const attempted = new Set<string>();
    let delivered = 0;
    let dropped = 0;
    let timedOut = false;

    while (!this.closed && this.now() < deadline) {
      const item = await this.withMutation(() => {
        if (this.closed) return undefined;
        this.purgeExpired(this.now());
        if (!force && this.circuitOpenUntil > this.now()) return undefined;
        return this.items.find(
          (candidate) =>
            !attempted.has(candidate.id) &&
            (this.retryNotBefore[candidate.signal] ?? 0) <= this.now() &&
            (force || candidate.nextAttemptUnixMillis <= this.now())
        );
      });
      if (!item || this.closed) break;
      attempted.add(item.id);

      const remaining = Math.max(1, deadline - this.now());
      const result = await this.send(item, remaining);
      if (this.closed) break;
      const update = await this.withMutation(async () => {
        if (this.closed) return { delivered: 0, dropped: 0 };
        let floorDrops = 0;
        if (result.retryNotBefore !== undefined) {
          for (const signal of ['logs', 'metrics', 'traces'] as const) {
            if (
              this.config.collector[`${signal}Endpoint`] ===
              this.config.collector[`${item.signal}Endpoint`]
            )
              this.retryNotBefore[signal] = Math.max(
                this.retryNotBefore[signal] ?? 0,
                result.retryNotBefore
              );
          }
          for (
            let position = this.items.length - 1;
            position >= 0;
            position -= 1
          ) {
            const queued = this.items[position];
            if (
              queued &&
              (this.retryNotBefore[queued.signal] ?? 0) >=
                queued.enqueuedAtUnixMillis + this.config.queue.maxAgeMillis
            ) {
              this.removeAt(position);
              floorDrops += 1;
              this.droppedItems += 1;
            }
          }
        }
        const index = this.items.findIndex(
          (candidate) => candidate.id === item.id
        );
        if (index < 0) {
          await this.persist();
          return { delivered: 0, dropped: floorDrops };
        }

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
          return { delivered: 0, dropped: 1 + floorDrops };
        }

        this.transportFailures += 1;
        this.consecutiveFailures += 1;
        current.nextAttemptUnixMillis = Math.max(
          this.now() +
            Math.min(
              this.config.retry.maxDelayMillis,
              this.retryDelay(current.attempts)
            ),
          this.retryNotBefore[current.signal] ?? 0
        );
        if (
          this.consecutiveFailures >=
          this.config.retry.circuitBreakerFailureThreshold
        ) {
          this.circuitOpenUntil =
            this.now() + this.config.retry.circuitBreakerResetMillis;
        }
        await this.persist();
        return { delivered: 0, dropped: floorDrops };
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
    if (this.closed || !this.fetchImplementation) {
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
    if (controller) this.controllers.add(controller);
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
          try {
            controller?.abort();
          } catch {
            /* A broken platform abort must not escape the timer callback. */
          }
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
      if (controller) this.controllers.delete(controller);
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
    if (this.closed) return;
    if (!serialized) return;
    try {
      if (serialized.length > this.config.queue.maxBytes * 8 + 1_048_576)
        throw new Error('Oversized durable queue.');
      const parsed = JSON.parse(serialized) as Partial<PersistedQueue>;
      if (
        serialized.length > this.config.queue.maxBytes * 8 + 1_048_576 ||
        parsed.schemaVersion !== PERSISTED_SCHEMA_VERSION ||
        parsed.provenance !== this.provenance ||
        !Array.isArray(parsed.items)
      ) {
        throw new Error('Unsupported durable queue schema.');
      }
      const now = this.now();
      if (isRecord(parsed.retryNotBefore)) {
        for (const signal of ['logs', 'metrics', 'traces'] as const) {
          const floor = parsed.retryNotBefore[signal];
          if (
            typeof floor === 'number' &&
            Number.isSafeInteger(floor) &&
            floor > now
          )
            this.retryNotBefore[signal] = floor;
        }
      }
      for (const candidate of parsed.items.slice(
        0,
        this.config.queue.maxItems
      )) {
        if (
          typeof candidate?.payload !== 'string' ||
          candidate.payload.length > this.config.queue.maxItemBytes
        )
          continue;
        const item = validateQueueItem(candidate);
        if (
          item &&
          this.config.signals[item.signal] &&
          now - item.enqueuedAtUnixMillis <= this.config.queue.maxAgeMillis &&
          (this.retryNotBefore[item.signal] ?? 0) <
            item.enqueuedAtUnixMillis + this.config.queue.maxAgeMillis &&
          item.byteLength <= this.config.queue.maxItemBytes
        ) {
          this.items.push(item);
          this.queueBytes += item.byteLength;
        }
      }
      this.enforceLimits();
      await this.persist();
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
      if (!this.closed)
        await new Promise<void>((resolve) => {
          const resume = (): void => {
            this.stopWaiters.delete(resume);
            resolve();
          };
          this.stopWaiters.add(resume);
          this.ready.then(resume, resume);
        });
      return operation();
    });
    this.mutation = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  private async persist(): Promise<void> {
    if (this.closed || !this.store.persistent) return;
    for (const signal of ['logs', 'metrics', 'traces'] as const) {
      if ((this.retryNotBefore[signal] ?? 0) <= this.now())
        delete this.retryNotBefore[signal];
    }
    if (
      this.items.length === 0 &&
      Object.keys(this.retryNotBefore).length === 0
    ) {
      await this.store.clear();
      return;
    }
    const persisted: PersistedQueue = {
      schemaVersion: PERSISTED_SCHEMA_VERSION,
      provenance: this.provenance,
      ownerGeneration: this.ownerGeneration,
      retryNotBefore: this.retryNotBefore,
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
      Math.min(2_147_483_647, Math.max(0, delayMillis))
    );
  }

  private scheduleNextAttempt(): void {
    if (!this.accepting || this.items.length === 0) return;
    const now = this.now();
    const nextItemAt = Math.min(
      ...this.items.map((item) =>
        Math.max(
          item.nextAttemptUnixMillis,
          this.retryNotBefore[item.signal] ?? 0
        )
      )
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
        ? { retryNotBefore: parseRetryAfter(retryAfter, now) }
        : {}),
    };
  }
  return { outcome: 'permanent-failure', status: response.status };
}

function parseRetryAfter(value: string, now: number): number | undefined {
  // Reject oversized/overflowing hints conservatively without scanning or long sleeps.
  if (value.length > 256) return Number.MAX_SAFE_INTEGER;
  const text = value.trim();
  if (/^\d+$/.test(text)) {
    const timestamp = now + Number(text) * 1_000;
    return Number.isSafeInteger(timestamp)
      ? timestamp
      : Number.MAX_SAFE_INTEGER;
  }
  const timestamp = Date.parse(text);
  return Number.isFinite(timestamp) ? Math.max(now, timestamp) : undefined;
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
  if (
    !Number.isFinite(value.enqueuedAtUnixMillis) ||
    !Number.isFinite(value.attempts) ||
    !Number.isFinite(value.nextAttemptUnixMillis)
  )
    return undefined;
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
