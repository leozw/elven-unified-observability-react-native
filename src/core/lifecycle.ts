function elapsedClock(): () => number {
  const clock = (
    globalThis as unknown as { performance?: { now?: () => number } }
  ).performance;
  const read = clock?.now?.bind(clock);
  const origin = read?.() ?? 0;
  const wallOrigin = Date.now();
  let elapsed = 0;
  return () => {
    const sample = read?.() ?? 0;
    elapsed = Math.max(
      elapsed,
      Number.isFinite(sample) && Number.isFinite(origin) ? sample - origin : 0,
      Date.now() - wallOrigin
    );
    return elapsed;
  };
}

export class LifecycleTimeout extends Error {
  constructor() {
    super('Telemetry lifecycle deadline expired.');
  }
}

/** One budget across every async phase, including waits already in progress. */
export class LifecycleDeadline {
  private readonly expiresAt: number;
  private readonly now = elapsedClock();
  expired = false;

  constructor(
    timeoutMillis: number,
    private readonly expire: () => void
  ) {
    const duration = Number.isFinite(timeoutMillis)
      ? Math.min(30_000, Math.max(1, timeoutMillis))
      : 5_000;
    this.expiresAt = this.now() + duration;
  }

  remaining(): number {
    return Math.max(0, this.expiresAt - this.now());
  }

  wait<T>(operation: Promise<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      let settled = false;
      if (this.remaining() <= 0) {
        this.expired = true;
        this.expire();
        operation.catch(() => undefined);
        reject(new LifecycleTimeout());
        return;
      }
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        this.expired = true;
        this.expire();
        reject(new LifecycleTimeout());
      }, this.remaining());
      operation.then(
        (value) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(value);
        },
        (error: unknown) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(error);
        }
      );
    });
  }
}

interface OwnerRegistry {
  owner?: object;
  consent?: boolean;
}
const OWNER_KEY = Symbol.for('works.elven.mobile.telemetry.owner.v1');

function registry(): OwnerRegistry {
  const target = globalThis as unknown as Record<symbol, OwnerRegistry>;
  return (target[OWNER_KEY] ??= {});
}

export function acquireOwner(owner: object): boolean {
  const state = registry();
  if (state.owner && state.owner !== owner) return false;
  state.owner = owner;
  return true;
}

export function releaseOwner(owner: object): void {
  const state = registry();
  if (state.owner === owner) delete state.owner;
}

export function activeOwner(): object | undefined {
  return registry().owner;
}
export function globalConsentGranted(): boolean {
  return registry().consent ?? true;
}
export function setGlobalConsent(granted: boolean): void {
  registry().consent = granted;
}
