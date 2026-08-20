import { ensurePerformanceTimeOrigin } from '../core/runtimeCompatibility';

describe('ensurePerformanceTimeOrigin', () => {
  const original = (globalThis as { performance?: unknown }).performance;

  afterEach(() => {
    Object.defineProperty(globalThis, 'performance', {
      configurable: true,
      value: original,
      writable: true,
    });
  });

  it('derives an epoch origin for a monotonic clock', () => {
    Object.defineProperty(globalThis, 'performance', {
      configurable: true,
      value: { now: () => 250 },
      writable: true,
    });
    expect(ensurePerformanceTimeOrigin()).toBe(true);
    const origin = (
      globalThis as unknown as { performance: { timeOrigin?: number } }
    ).performance.timeOrigin;
    expect(origin).toBeGreaterThan(Date.now() - 1_000);
    expect(origin).toBeLessThanOrEqual(Date.now());
  });

  it('uses zero when a non-conformant clock returns epoch milliseconds', () => {
    Object.defineProperty(globalThis, 'performance', {
      configurable: true,
      value: { now: Date.now },
      writable: true,
    });
    expect(ensurePerformanceTimeOrigin()).toBe(true);
    expect(
      (globalThis as unknown as { performance: { timeOrigin?: number } })
        .performance.timeOrigin
    ).toBe(0);
  });

  it('fails open when the runtime clock is missing or inaccessible', () => {
    Object.defineProperty(globalThis, 'performance', {
      configurable: true,
      value: undefined,
      writable: true,
    });
    expect(ensurePerformanceTimeOrigin()).toBe(false);

    Object.defineProperty(globalThis, 'performance', {
      configurable: true,
      value: {
        now: () => {
          throw new Error('clock unavailable');
        },
      },
      writable: true,
    });
    expect(ensurePerformanceTimeOrigin()).toBe(false);
  });
});
