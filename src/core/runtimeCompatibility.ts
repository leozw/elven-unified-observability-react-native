interface PerformanceClock {
  now(): number;
  readonly timeOrigin?: number;
}

/** Ensures OpenTelemetry can convert monotonic React Native timestamps to epoch time. */
export function ensurePerformanceTimeOrigin(): boolean {
  const clock = (globalThis as { performance?: PerformanceClock }).performance;
  if (!clock || Number.isFinite(clock.timeOrigin)) return Boolean(clock);
  try {
    const sample = clock.now();
    const timeOrigin =
      Number.isFinite(sample) && sample < Date.now() / 2
        ? Date.now() - sample
        : 0;
    Object.defineProperty(clock, 'timeOrigin', {
      configurable: true,
      enumerable: true,
      value: timeOrigin,
    });
    return true;
  } catch {
    return false;
  }
}
