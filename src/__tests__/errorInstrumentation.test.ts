import { ErrorInstrumentation } from '../instrumentation/errors';
import { Diagnostics } from '../core/diagnostics';
import { resolvedConfiguration } from '../__fixtures__/testConfig';

interface ErrorUtilsMock {
  current?: (error: Error, fatal?: boolean) => void;
  getGlobalHandler(): ((error: Error, fatal?: boolean) => void) | undefined;
  setGlobalHandler(handler: (error: Error, fatal?: boolean) => void): void;
}

describe('ErrorInstrumentation', () => {
  const original = (globalThis as { ErrorUtils?: unknown }).ErrorUtils;
  const originalAddEventListener = Object.getOwnPropertyDescriptor(
    globalThis,
    'addEventListener'
  );
  const originalRemoveEventListener = Object.getOwnPropertyDescriptor(
    globalThis,
    'removeEventListener'
  );
  const originalUnhandledRejection = Object.getOwnPropertyDescriptor(
    globalThis,
    'onunhandledrejection'
  );

  afterEach(() => {
    (globalThis as { ErrorUtils?: unknown }).ErrorUtils = original;
    restoreGlobalProperty('addEventListener', originalAddEventListener);
    restoreGlobalProperty('removeEventListener', originalRemoveEventListener);
    restoreGlobalProperty('onunhandledrejection', originalUnhandledRejection);
  });

  it('captures once, preserves the host fatal handler, and restores it', () => {
    const previous = jest.fn();
    const errorUtils: ErrorUtilsMock = {
      current: previous,
      getGlobalHandler() {
        return this.current;
      },
      setGlobalHandler(handler) {
        this.current = handler;
      },
    };
    (globalThis as { ErrorUtils?: unknown }).ErrorUtils = errorUtils;
    const capture = jest.fn();
    const instrumentation = new ErrorInstrumentation(
      resolvedConfiguration({
        instrumentations: {
          errors: { enabled: true, unhandledRejections: false },
        },
      }),
      capture,
      new Diagnostics({ enabled: false, verbose: false })
    );
    instrumentation.start();
    const failure = new Error('fatal');

    errorUtils.current?.(failure, true);
    errorUtils.current?.(failure, true);
    expect(capture).toHaveBeenCalledTimes(1);
    expect(previous).toHaveBeenCalledTimes(2);

    instrumentation.shutdown();
    expect(errorUtils.current).toBe(previous);
  });

  it('does not swallow behavior from the previous fatal handler', () => {
    const expected = new Error('host fatal path');
    const previous = (): never => {
      throw expected;
    };
    const errorUtils: ErrorUtilsMock = {
      current: previous,
      getGlobalHandler() {
        return this.current;
      },
      setGlobalHandler(handler) {
        this.current = handler;
      },
    };
    (globalThis as { ErrorUtils?: unknown }).ErrorUtils = errorUtils;
    const instrumentation = new ErrorInstrumentation(
      resolvedConfiguration({
        instrumentations: {
          errors: { enabled: true, unhandledRejections: false },
        },
      }),
      jest.fn(),
      new Diagnostics({ enabled: false, verbose: false })
    );
    instrumentation.start();

    expect(() => errorUtils.current?.(new Error('application'), true)).toThrow(
      expected
    );
    instrumentation.shutdown();
  });

  it('skips global interception when React Native cannot preserve its fatal path', () => {
    const messages: string[] = [];
    const diagnostics = new Diagnostics({
      enabled: true,
      verbose: true,
      sink: (message) => messages.push(message),
    });
    (globalThis as { ErrorUtils?: unknown }).ErrorUtils = undefined;
    new ErrorInstrumentation(
      resolvedConfiguration({
        instrumentations: {
          errors: { enabled: true, unhandledRejections: false },
        },
      }),
      jest.fn(),
      diagnostics
    ).start();

    (globalThis as { ErrorUtils?: unknown }).ErrorUtils = {
      getGlobalHandler: () => undefined,
      setGlobalHandler: jest.fn(),
    } satisfies ErrorUtilsMock;
    new ErrorInstrumentation(
      resolvedConfiguration({
        instrumentations: {
          errors: { enabled: true, unhandledRejections: false },
        },
      }),
      jest.fn(),
      diagnostics
    ).start();

    expect(messages.join(' ')).toContain('ErrorUtils is unavailable');
    expect(messages.join(' ')).toContain('interception was skipped');
  });

  it('captures and removes browser-style unhandled rejection listeners', () => {
    let listener: ((event: { reason?: unknown }) => unknown) | undefined;
    const addEventListener = jest.fn(
      (_type: string, candidate: typeof listener) => {
        listener = candidate;
      }
    );
    const removeEventListener = jest.fn();
    Object.defineProperty(globalThis, 'addEventListener', {
      configurable: true,
      value: addEventListener,
      writable: true,
    });
    Object.defineProperty(globalThis, 'removeEventListener', {
      configurable: true,
      value: removeEventListener,
      writable: true,
    });
    const capture = jest.fn();
    const instrumentation = new ErrorInstrumentation(
      resolvedConfiguration({
        instrumentations: {
          errors: {
            enabled: true,
            javascriptErrors: false,
            unhandledRejections: true,
          },
        },
      }),
      capture,
      new Diagnostics({ enabled: false, verbose: false })
    );

    instrumentation.start();
    const failure = new Error('rejected');
    listener?.({ reason: failure });
    listener?.({ reason: failure });
    expect(capture).toHaveBeenCalledTimes(1);
    expect(capture).toHaveBeenCalledWith(failure, {
      source: 'javascript.unhandled_rejection',
      fatal: false,
      unhandled: true,
    });
    instrumentation.shutdown();
    expect(removeEventListener).toHaveBeenCalledWith(
      'unhandledrejection',
      listener
    );
  });

  it('chains the fallback rejection handler and isolates capture failures', () => {
    Object.defineProperty(globalThis, 'addEventListener', {
      configurable: true,
      value: undefined,
      writable: true,
    });
    Object.defineProperty(globalThis, 'removeEventListener', {
      configurable: true,
      value: undefined,
      writable: true,
    });
    const previous = jest.fn(() => 'host-result');
    Object.defineProperty(globalThis, 'onunhandledrejection', {
      configurable: true,
      value: previous,
      writable: true,
    });
    const capture = jest.fn(() => {
      throw new Error('capture failed');
    });
    const instrumentation = new ErrorInstrumentation(
      resolvedConfiguration({
        instrumentations: {
          errors: {
            enabled: true,
            javascriptErrors: false,
            unhandledRejections: true,
          },
        },
      }),
      capture,
      new Diagnostics({ enabled: false, verbose: false })
    );

    instrumentation.start();
    const chained = (
      globalThis as unknown as {
        onunhandledrejection?: (event: { reason?: unknown }) => unknown;
      }
    ).onunhandledrejection;
    expect(chained?.({ reason: 'primitive rejection' })).toBe('host-result');
    expect(chained?.({ reason: 'primitive rejection' })).toBe('host-result');
    expect(capture).toHaveBeenCalledTimes(1);
    expect(previous).toHaveBeenCalledTimes(2);

    instrumentation.shutdown();
    expect(
      (
        globalThis as unknown as {
          onunhandledrejection?: (event: { reason?: unknown }) => unknown;
        }
      ).onunhandledrejection
    ).toBe(previous);
  });
});

function restoreGlobalProperty(
  name: string,
  descriptor: PropertyDescriptor | undefined
): void {
  if (descriptor) {
    Object.defineProperty(globalThis, name, descriptor);
  } else {
    delete (globalThis as Record<string, unknown>)[name];
  }
}
