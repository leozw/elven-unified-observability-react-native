import type { Attributes } from '@opentelemetry/api';
import { DEFAULT_REDACT_KEYS, REDACTED_VALUE } from './constants';
import { redactTextContent } from './redaction';
import type { AttributeInput, AttributeInputs, ResolvedConfig } from '../types';

const MAX_DEPTH = 4;
const MAX_NODES = 256;
const MAX_INPUT_CHARS = 65_536;
const MAX_TOTAL_CHARS = 262_144;
const OVERSIZE = '[OVERSIZE]';
interface Budget {
  nodes: number;
  chars: number;
  seen: WeakSet<object>;
}
const budget = (): Budget => ({
  nodes: MAX_NODES,
  chars: MAX_TOTAL_CHARS,
  seen: new WeakSet(),
});

export class Sanitizer {
  constructor(private readonly privacy: ResolvedConfig['privacy']) {}

  attributes(
    input: AttributeInputs | Attributes | undefined,
    limit = this.privacy.maxAttributeCount
  ): Attributes {
    const output: Attributes = Object.create(null);
    if (!input || typeof input !== 'object') return output;
    const work = budget();
    const flatten = (object: object, prefix: string, depth: number): void => {
      if (depth > MAX_DEPTH || work.seen.has(object)) return;
      work.seen.add(object);
      for (const key in object) {
        if (--work.nodes < 0 || Object.keys(output).length >= limit) break;
        if (key.length > 128 || prefix.length + key.length > 128) continue;
        const descriptor = Object.getOwnPropertyDescriptor(object, key);
        if (!descriptor || !('value' in descriptor)) continue;
        const name = prefix ? `${prefix}.${key}` : key;
        const safeKey = this.text(name, 128, work).trim();
        const value = descriptor.value as unknown;
        if (value == null) continue;
        if (this.isRedactedKey(name)) {
          output[safeKey] = REDACTED_VALUE;
          continue;
        }
        if (value instanceof Error) {
          flatten(this.exception(value), name, depth + 1);
          continue;
        }
        if (typeof value === 'object' && !Array.isArray(value)) {
          flatten(value, name, depth + 1);
          continue;
        }
        let sanitized = this.primitiveOrArray(value, work);
        if (sanitized === undefined) continue;
        if (this.privacy.attributeFilter) {
          try {
            sanitized = this.primitiveOrArray(
              this.privacy.attributeFilter(name, sanitized as AttributeInput),
              work
            );
          } catch {
            continue;
          }
        }
        if (sanitized !== undefined)
          output[safeKey] = sanitized as Attributes[string];
      }
    };
    try {
      flatten(input, '', 0);
    } catch {
      /* Proxies and custom host objects are untrusted. */
    }
    return output;
  }

  message(value: unknown): string {
    const work = budget();
    if (typeof value === 'string')
      return this.text(value, this.privacy.maxLogMessageLength, work);
    const projected = this.project(value, 0, work);
    try {
      return this.text(
        typeof projected === 'string' ? projected : JSON.stringify(projected),
        this.privacy.maxLogMessageLength,
        budget()
      );
    } catch {
      return '[Unsupported]';
    }
  }

  eventName(value: string): string {
    return (
      this.text(value, this.privacy.maxEventNameLength, budget())
        .trim()
        .replace(/[\r\n\t]/g, ' ') || 'unnamed.event'
    );
  }

  metricName(value: string): string {
    return (
      this.text(value, 255, budget())
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9_.\-/]/g, '_')
        .replace(/_{2,}/g, '_')
        .replace(/^[^a-z]/, 'm_') || 'unnamed_metric'
    );
  }

  exception(error: unknown): Attributes {
    if (!(error instanceof Error))
      return {
        'exception.type': typeof error,
        'exception.message': this.message(error),
      };
    const work = budget();
    const name = this.dataProperty(error, 'name') ?? 'Error';
    const message = this.dataProperty(error, 'message') ?? 'Unknown error';
    const stack = this.dataProperty(error, 'stack');
    return {
      'exception.type': this.text(
        name,
        this.privacy.maxAttributeValueLength,
        work
      ),
      'exception.message': this.text(
        message,
        this.privacy.maxLogMessageLength,
        work
      ),
      ...(typeof stack === 'string'
        ? {
            'exception.stacktrace': this.text(
              stack,
              this.privacy.maxStackTraceLength,
              work
            ),
          }
        : {}),
    };
  }

  url(value: string): string {
    if (typeof value !== 'string' || value.length > MAX_INPUT_CHARS)
      return OVERSIZE;
    const fallback = this.text(
      value.split(/[?#]/, 1)[0] ?? '',
      this.privacy.maxAttributeValueLength,
      budget()
    );
    try {
      const parsed = new URL(value) as unknown as {
        username: string;
        password: string;
        hash: string;
        search: string;
        searchParams: {
          entries(): IterableIterator<[string, string]>;
          delete(key: string): void;
        };
        toString(): string;
      };
      parsed.username = '';
      parsed.password = '';
      parsed.hash = '';
      if (this.privacy.urlQueryPolicy === 'drop') parsed.search = '';
      else {
        const allowed = new Set(
          this.privacy.allowedUrlQueryKeys
            .slice(0, 64)
            .map((key) => key.toLowerCase())
        );
        const entries = Array.from(parsed.searchParams.entries());
        if (entries.length > MAX_NODES) parsed.search = '';
        else
          for (const [key] of entries)
            if (!allowed.has(key.toLowerCase()) || this.isRedactedKey(key))
              parsed.searchParams.delete(key);
      }
      return this.text(
        parsed.toString(),
        this.privacy.maxAttributeValueLength,
        budget()
      );
    } catch {
      return fallback;
    }
  }

  isRedactedKey(key: string): boolean {
    return [
      ...DEFAULT_REDACT_KEYS,
      ...this.privacy.redactKeys.slice(0, 64),
    ].some((matcher) => {
      if (typeof matcher === 'string')
        return key.toLowerCase().includes(matcher.slice(0, 128).toLowerCase());
      matcher.lastIndex = 0;
      return matcher.test(key);
    });
  }

  private text(value: unknown, length: number, work: Budget): string {
    if (typeof value !== 'string') return '[Unsupported]';
    // Reject before regex/encoding; slicing first could expose a partial credential.
    if (value.length > MAX_INPUT_CHARS || value.length > work.chars)
      return OVERSIZE;
    work.chars -= value.length;
    const safe = redactTextContent(value);
    return safe.length <= length
      ? safe
      : `${safe.slice(0, Math.max(0, length - 11))}[TRUNCATED]`;
  }

  private primitiveOrArray(value: unknown, work: Budget): unknown {
    if (typeof value === 'string')
      return this.text(value, this.privacy.maxAttributeValueLength, work);
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
    if (!Array.isArray(value)) return undefined;
    const output = [];
    for (
      let index = 0;
      index < Math.min(value.length, 32) && --work.nodes >= 0;
      index += 1
    ) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (
        !descriptor ||
        !('value' in descriptor) ||
        typeof descriptor.value === 'object'
      )
        continue;
      const item = this.primitiveOrArray(descriptor.value, work);
      if (item !== undefined) output.push(item);
    }
    return output.length ? output : undefined;
  }

  private project(value: unknown, depth: number, work: Budget): unknown {
    if (--work.nodes < 0 || depth > MAX_DEPTH) return '[TRUNCATED]';
    if (typeof value === 'string')
      return this.text(value, this.privacy.maxAttributeValueLength, work);
    if (
      value === null ||
      typeof value === 'boolean' ||
      typeof value === 'number'
    )
      return value;
    if (typeof value === 'bigint')
      return value < -(2n ** 128n) || value > 2n ** 128n
        ? '[BigInt]'
        : String(value);
    if (value === undefined) return 'undefined';
    if (typeof value !== 'object') return '[Unsupported]';
    if (work.seen.has(value)) return '[Circular]';
    work.seen.add(value);
    if (value instanceof Error) return this.exception(value);
    if (Array.isArray(value)) {
      const result = [];
      for (let i = 0; i < Math.min(value.length, 32) && work.nodes > 0; i += 1)
        result.push(
          this.project(this.dataProperty(value, String(i)), depth + 1, work)
        );
      return result;
    }
    const output: Record<string, unknown> = Object.create(null);
    try {
      for (const key in value) {
        if (work.nodes <= 0) break;
        --work.nodes;
        if (key.length > 128) continue;
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor || !('value' in descriptor)) continue;
        output[key] = this.isRedactedKey(key)
          ? REDACTED_VALUE
          : this.project(descriptor.value, depth + 1, work);
      }
    } catch {
      return '[Unsupported]';
    }
    return output;
  }

  private dataProperty(value: object, key: string): unknown {
    let object: object | null = value;
    for (let depth = 0; object && depth < 4; depth += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(object, key);
      if (descriptor)
        return 'value' in descriptor ? descriptor.value : undefined;
      object = Object.getPrototypeOf(object) as object | null;
    }
    return undefined;
  }
}
