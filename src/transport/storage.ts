import type { Diagnostics } from '../core/diagnostics';
import type { NativeBridge } from '../native/bridge';

export interface QueueStore {
  readonly persistent: boolean;
  read(): Promise<string | undefined>;
  write(value: string): Promise<boolean>;
  clear(): Promise<boolean>;
}

export class NativeQueueStore implements QueueStore {
  constructor(
    private readonly bridge: NativeBridge,
    private readonly enabled: boolean,
    private readonly diagnostics: Diagnostics
  ) {}

  get persistent(): boolean {
    return this.enabled && this.bridge.available;
  }

  async read(): Promise<string | undefined> {
    if (!this.persistent) return undefined;
    return this.bridge.readPersistedQueue();
  }

  async write(value: string): Promise<boolean> {
    if (!this.persistent) return false;
    const written = await this.bridge.writePersistedQueue(value);
    if (!written) {
      this.diagnostics.warn(
        'Durable queue persistence is unavailable; the in-memory queue remains active.'
      );
    }
    return written;
  }

  async clear(): Promise<boolean> {
    if (!this.persistent) return false;
    return this.bridge.clearPersistedQueue();
  }
}
