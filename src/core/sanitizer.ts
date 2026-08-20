import type { Attributes } from '@opentelemetry/api';
import { REDACTED_VALUE } from './constants';
import { redactTextContent } from './redaction';
import type { AttributeInput, AttributeInputs, ResolvedConfig } from '../types';

const MAX_ATTRIBUTE_KEY_LENGTH = 128;
const MAX_DEPTH = 4;

interface UrlConstructorLike {
  new (input: string): {
    username: string;
    password: string;
    search: string;
    hash: string;
    searchParams: {
      entries(): IterableIterator<[string, string]>;
      delete(name: string): void;
    };
    toString(): string;
  };
}

export class Sanitizer {
  private readonly privacy: ResolvedConfig['privacy'];

  constructor(privacy: ResolvedConfig['privacy']) {
    this.privacy = privacy;
  }

  attributes(
    input: AttributeInputs | Attributes | undefined,
    limit = this.privacy.maxAttributeCount
  ): Attributes {
    if (!input) return {};
    const output: Attributes = {};
    const seen = new WeakSet<object>();
    for (const [key, value] of Object.entries(input)) {
      this.flatten(output, key, value, 0, seen, limit);
      if (Object.keys(output).length >= limit) break;
    }
    return output;
  }

  message(value: unknown): string {
    return this.truncate(
      redactTextContent(this.toDisplayString(value)),
      this.privacy.maxLogMessageLength
    );
  }

  eventName(value: string): string {
    const normalized = redactTextContent(value)
      .trim()
      .replace(/[\r\n\t]/g, ' ');
    return this.truncate(
      normalized || 'unnamed.event',
      this.privacy.maxEventNameLength
    );
  }

  metricName(value: string): string {
    const normalized = redactTextContent(value)
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_.\-/]/g, '_')
      .replace(/_{2,}/g, '_')
      .replace(/^[^a-z]/, 'm_');
    return this.truncate(normalized || 'unnamed_metric', 255);
  }

  exception(error: unknown): Attributes {
    if (error instanceof Error) {
      return {
        'exception.type': this.truncate(
          redactTextContent(error.name || 'Error'),
          this.privacy.maxAttributeValueLength
        ),
        'exception.message': this.truncate(
          redactTextContent(error.message || 'Unknown error'),
          this.privacy.maxLogMessageLength
        ),
        ...(error.stack
          ? {
              'exception.stacktrace': this.truncate(
                redactTextContent(error.stack),
                this.privacy.maxStackTraceLength
              ),
            }
          : {}),
      };
    }
    return {
      'exception.type': typeof error,
      'exception.message': this.message(error),
    };
  }

  url(value: string): string {
    const fallback = this.removeQueryAndFragment(value);
    const UrlConstructor = (globalThis as { URL?: UrlConstructorLike }).URL;
    if (!UrlConstructor) return fallback;
    try {
      const parsed = new UrlConstructor(value);
      parsed.username = '';
      parsed.password = '';
      parsed.hash = '';
      if (this.privacy.urlQueryPolicy === 'drop') {
        parsed.search = '';
      } else {
        const allowed = new Set(
          this.privacy.allowedUrlQueryKeys.map((key) => key.toLowerCase())
        );
        for (const [key] of parsed.searchParams.entries()) {
          if (!allowed.has(key.toLowerCase())) parsed.searchParams.delete(key);
        }
      }
      return this.truncate(
        redactTextContent(parsed.toString()),
        this.privacy.maxAttributeValueLength
      );
    } catch {
      return this.truncate(
        redactTextContent(fallback),
        this.privacy.maxAttributeValueLength
      );
    }
  }

  isRedactedKey(key: string): boolean {
    return this.privacy.redactKeys.some((matcher) =>
      typeof matcher === 'string'
        ? key.toLowerCase().includes(matcher.toLowerCase())
        : resetAndTest(matcher, key)
    );
  }

  private flatten(
    output: Attributes,
    rawKey: string,
    rawValue: unknown,
    depth: number,
    seen: WeakSet<object>,
    limit: number
  ): void {
    if (Object.keys(output).length >= limit) return;
    const key = this.truncate(
      redactTextContent(rawKey.trim()),
      MAX_ATTRIBUTE_KEY_LENGTH
    );
    if (!key || rawValue === undefined || rawValue === null) return;
    if (this.isRedactedKey(key)) {
      output[key] = REDACTED_VALUE;
      return;
    }

    if (isPrimitive(rawValue)) {
      const filtered = this.filter(key, this.sanitizePrimitive(rawValue));
      if (filtered !== undefined && filtered !== null) {
        output[key] = filtered as Attributes[string];
      }
      return;
    }

    if (Array.isArray(rawValue)) {
      const values = rawValue
        .filter(isPrimitive)
        .slice(0, 32)
        .map((value) => this.sanitizePrimitive(value));
      if (values.length > 0) {
        const filtered = this.filter(key, values);
        if (filtered !== undefined && filtered !== null) {
          output[key] = filtered as Attributes[string];
        }
      }
      return;
    }

    if (rawValue instanceof Error) {
      const exception = this.exception(rawValue);
      for (const [exceptionKey, exceptionValue] of Object.entries(exception)) {
        this.flatten(
          output,
          `${key}.${exceptionKey}`,
          exceptionValue,
          depth + 1,
          seen,
          limit
        );
      }
      return;
    }

    if (
      typeof rawValue !== 'object' ||
      depth >= MAX_DEPTH ||
      seen.has(rawValue)
    ) {
      return;
    }
    seen.add(rawValue);
    for (const [childKey, childValue] of Object.entries(rawValue)) {
      this.flatten(
        output,
        `${key}.${childKey}`,
        childValue,
        depth + 1,
        seen,
        limit
      );
      if (Object.keys(output).length >= limit) break;
    }
  }

  private sanitizePrimitive(
    value: string | number | boolean
  ): string | number | boolean {
    if (typeof value === 'string') {
      return this.truncate(
        redactTextContent(value),
        this.privacy.maxAttributeValueLength
      );
    }
    if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
    return value;
  }

  private filter(key: string, value: AttributeInput): AttributeInput {
    if (!this.privacy.attributeFilter) return value;
    try {
      return this.privacy.attributeFilter(key, value);
    } catch {
      return undefined;
    }
  }

  private toDisplayString(value: unknown): string {
    if (typeof value === 'string') return value;
    if (value instanceof Error) return `${value.name}: ${value.message}`;
    if (
      typeof value === 'number' ||
      typeof value === 'boolean' ||
      typeof value === 'bigint'
    ) {
      return String(value);
    }
    if (value === undefined) return 'undefined';
    if (value === null) return 'null';
    try {
      return (
        JSON.stringify(value, this.createSafeJsonReplacer()) ?? String(value)
      );
    } catch {
      return Object.prototype.toString.call(value);
    }
  }

  private removeQueryAndFragment(value: string): string {
    const hashIndex = value.indexOf('#');
    const queryIndex = value.indexOf('?');
    const indexes = [hashIndex, queryIndex].filter((index) => index >= 0);
    const end = indexes.length > 0 ? Math.min(...indexes) : value.length;
    return value.slice(0, end);
  }

  private truncate(value: string, maxLength: number): string {
    if (value.length <= maxLength) return value;
    const marker = '[TRUNCATED]';
    return `${value.slice(0, Math.max(0, maxLength - marker.length))}${marker}`;
  }

  private createSafeJsonReplacer(): (key: string, value: unknown) => unknown {
    const seen = new WeakSet<object>();
    return (key, value) => {
      if (key && this.isRedactedKey(key)) return REDACTED_VALUE;
      if (typeof value === 'bigint') return String(value);
      if (value instanceof Error) {
        return {
          name: this.truncate(value.name, this.privacy.maxAttributeValueLength),
          message: this.truncate(
            value.message,
            this.privacy.maxLogMessageLength
          ),
          ...(value.stack
            ? {
                stack: this.truncate(
                  value.stack,
                  this.privacy.maxStackTraceLength
                ),
              }
            : {}),
        };
      }
      if (typeof value !== 'object' || value === null) {
        return typeof value === 'string'
          ? this.truncate(
              redactTextContent(value),
              this.privacy.maxAttributeValueLength
            )
          : value;
      }
      if (seen.has(value)) return '[Circular]';
      seen.add(value);
      return value;
    };
  }
}

function isPrimitive(value: unknown): value is string | number | boolean {
  return (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  );
}

function resetAndTest(pattern: RegExp, value: string): boolean {
  pattern.lastIndex = 0;
  return pattern.test(value);
}
