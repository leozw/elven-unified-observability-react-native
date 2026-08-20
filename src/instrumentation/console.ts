import type { StructuredLogger } from '../core/logger';
import type { ResolvedConfig, LogLevel } from '../types';

type ConsoleMethod = (...arguments_: ReadonlyArray<unknown>) => void;

interface PatchedConsoleMethod {
  name: 'debug' | 'error' | 'info' | 'log' | 'warn';
  level: LogLevel;
}

const METHODS: ReadonlyArray<PatchedConsoleMethod> = [
  { name: 'debug', level: 'debug' },
  { name: 'info', level: 'info' },
  { name: 'log', level: 'info' },
  { name: 'warn', level: 'warn' },
  { name: 'error', level: 'error' },
];

export class ConsoleInstrumentation {
  private readonly restores: Array<() => void> = [];
  private recording = false;

  constructor(
    private readonly config: ResolvedConfig,
    private readonly logger: StructuredLogger
  ) {}

  start(): void {
    const settings = this.config.instrumentations.console;
    if (!settings.enabled) return;

    for (const method of METHODS) {
      if (!settings.levels.includes(method.level)) continue;
      const target = console as unknown as Record<string, ConsoleMethod>;
      const original = target[method.name];
      if (typeof original !== 'function') continue;
      const wrapped: ConsoleMethod = (...arguments_) => {
        if (settings.preserveOriginal) {
          try {
            original.apply(console, [...arguments_]);
          } catch {
            // A custom console implementation must not break application code.
          }
        }
        if (this.recording || isSdkDiagnostic(arguments_[0])) {
          return;
        }
        this.recording = true;
        try {
          const [message = '', ...additional] = arguments_;
          this.logger.emit(
            method.level,
            message,
            {
              'console.method': method.name,
              ...consoleArguments(additional),
            },
            { eventName: 'console' }
          );
        } catch {
          // Console interception is fail-open by design.
        } finally {
          this.recording = false;
        }
      };
      target[method.name] = wrapped;
      this.restores.push(() => {
        if (target[method.name] === wrapped) target[method.name] = original;
      });
    }
  }

  shutdown(): void {
    for (const restore of this.restores.splice(0)) restore();
  }
}

function consoleArguments(
  values: ReadonlyArray<unknown>
): Record<string, unknown> {
  const attributes: Record<string, unknown> = {};
  values.slice(0, 8).forEach((value, index) => {
    attributes[`console.argument.${index + 1}`] = value;
  });
  if (values.length > 8) attributes['console.arguments.truncated'] = true;
  return attributes;
}

function isSdkDiagnostic(value: unknown): boolean {
  return typeof value === 'string' && value.startsWith('[elven-observability]');
}
