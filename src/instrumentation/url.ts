import type { UrlMatcher } from '../types';

export function matchesUrl(
  value: string,
  matchers: ReadonlyArray<UrlMatcher>
): boolean {
  return matchers.some((matcher) => {
    if (typeof matcher === 'string') return matchesStringUrl(value, matcher);
    matcher.lastIndex = 0;
    return matcher.test(value);
  });
}

function matchesStringUrl(value: string, matcher: string): boolean {
  const UrlConstructor = (
    globalThis as unknown as {
      URL?: new (url: string) => { origin: string; pathname: string };
    }
  ).URL;
  if (UrlConstructor) {
    try {
      const candidate = new UrlConstructor(value);
      const expected = new UrlConstructor(matcher);
      if (candidate.origin !== expected.origin) return false;
      if (expected.pathname === '/') return true;
      if (expected.pathname.endsWith('/')) {
        return candidate.pathname.startsWith(expected.pathname);
      }
      return (
        candidate.pathname === expected.pathname ||
        candidate.pathname.startsWith(`${expected.pathname}/`)
      );
    } catch {
      // Relative and non-standard URLs use the boundary-aware fallback below.
    }
  }
  if (value === matcher) return true;
  return value.startsWith(matcher.endsWith('/') ? matcher : `${matcher}/`);
}

export function serverAddress(value: string): string | undefined {
  const UrlConstructor = (
    globalThis as unknown as {
      URL?: new (url: string) => { hostname: string };
    }
  ).URL;
  if (UrlConstructor) {
    try {
      return new UrlConstructor(value).hostname || undefined;
    } catch {
      return undefined;
    }
  }
  const match = /^https?:\/\/([^/:?#]+)/i.exec(value);
  return match?.[1];
}

export function monotonicNow(): number {
  const performanceObject = (
    globalThis as unknown as { performance?: { now?(): number } }
  ).performance;
  return performanceObject?.now?.() ?? Date.now();
}
