import { resolveConfig } from '../core/config';
import type { ResolvedConfig, UnifiedObservabilityConfig } from '../types';

export function baseConfiguration(
  overrides: Partial<UnifiedObservabilityConfig> = {}
): UnifiedObservabilityConfig {
  return {
    serviceName: 'mobile-checkout',
    version: '1.2.3',
    environment: 'test',
    collector: { endpoint: 'https://collector.example.test' },
    instrumentations: {
      console: false,
      network: false,
      errors: false,
      lifecycle: false,
    },
    ...overrides,
  };
}

export function resolvedConfiguration(
  overrides: Partial<UnifiedObservabilityConfig> = {}
): ResolvedConfig {
  return resolveConfig(baseConfiguration(overrides));
}
