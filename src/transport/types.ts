import type { SignalType } from '../types';

export interface QueueItem {
  id: string;
  signal: SignalType;
  payload: string;
  byteLength: number;
  priority: number;
  enqueuedAtUnixMillis: number;
  attempts: number;
  nextAttemptUnixMillis: number;
}

export interface PersistedQueue {
  schemaVersion: 1;
  items: ReadonlyArray<QueueItem>;
}

export interface TransportResponse {
  status: number;
  headers?: {
    get(name: string): string | null;
  };
}

export interface TransportRequestInit {
  method: 'POST';
  headers: Readonly<Record<string, string>>;
  body: string;
  signal?: unknown;
}

export type TransportFetch = (
  endpoint: string,
  init: TransportRequestInit
) => Promise<TransportResponse>;

export interface TransportFlushResult {
  delivered: number;
  dropped: number;
  pending: number;
  timedOut: boolean;
}

export interface TransportHealth {
  queueItems: number;
  queueBytes: number;
  droppedItems: number;
  transportFailures: number;
  circuitOpen: boolean;
  lastSuccessfulExportUnixMillis?: number;
}
