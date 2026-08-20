import type { DiagnosticsConfig } from '../types';
import { redactTextContent } from './redaction';

type DiagnosticLevel = 'debug' | 'error' | 'info' | 'warn';

const RATE_LIMIT_WINDOW_MILLIS = 60_000;
const RATE_LIMIT_PER_KEY = 5;
const MAX_DIAGNOSTIC_CONTEXT_ENTRIES = 16;
const MAX_DIAGNOSTIC_VALUE_LENGTH = 1_024;

export class Diagnostics {
  private readonly counters = new Map<
    string,
    { count: number; resetAt: number }
  >();

  constructor(
    private readonly config: Required<Omit<DiagnosticsConfig, 'sink'>> &
      Pick<DiagnosticsConfig, 'sink'>
  ) {}

  debug(message: string, context?: Readonly<Record<string, unknown>>): void {
    if (this.config.verbose) this.emit('debug', message, context);
  }

  info(message: string, context?: Readonly<Record<string, unknown>>): void {
    this.emit('info', message, context);
  }

  warn(message: string, context?: Readonly<Record<string, unknown>>): void {
    this.emit('warn', message, context);
  }

  error(message: string, context?: Readonly<Record<string, unknown>>): void {
    this.emit('error', message, context);
  }

  private emit(
    level: DiagnosticLevel,
    message: string,
    context?: Readonly<Record<string, unknown>>
  ): void {
    if (!this.config.enabled || !this.allow(`${level}:${message}`)) return;

    try {
      const safeMessage = redactTextContent(message);
      const safeContext = sanitizeDiagnosticContext(context);
      if (this.config.sink) {
        this.config.sink(`[${level}] ${safeMessage}`, safeContext);
        return;
      }
      const target = console[level] ?? console.log;
      target.call(
        console,
        `[elven-observability] ${safeMessage}`,
        safeContext ?? ''
      );
    } catch {
      // Diagnostics are deliberately fail-open.
    }
  }

  private allow(key: string): boolean {
    const now = Date.now();
    const current = this.counters.get(key);
    if (!current || current.resetAt <= now) {
      this.counters.set(key, {
        count: 1,
        resetAt: now + RATE_LIMIT_WINDOW_MILLIS,
      });
      return true;
    }
    if (current.count >= RATE_LIMIT_PER_KEY) return false;
    current.count += 1;
    return true;
  }
}

function sanitizeDiagnosticContext(
  context: Readonly<Record<string, unknown>> | undefined
): Readonly<Record<string, unknown>> | undefined {
  if (!context) return undefined;
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(context).slice(
    0,
    MAX_DIAGNOSTIC_CONTEXT_ENTRIES
  )) {
    if (value === undefined || value === null) continue;
    if (typeof value === 'number' || typeof value === 'boolean') {
      output[key] = value;
      continue;
    }
    const text =
      typeof value === 'string'
        ? value
        : value instanceof Error
          ? `${value.name}: ${value.message}`
          : Object.prototype.toString.call(value);
    output[key] = redactTextContent(text).slice(0, MAX_DIAGNOSTIC_VALUE_LENGTH);
  }
  return output;
}
