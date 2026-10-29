import type { ResolvedConfig } from '../types';
import { sha256Hex } from './hash';

export function queueProvenance(config: ResolvedConfig): string {
  return sha256Hex(
    JSON.stringify([
      config.serviceName,
      config.environment,
      config.collector.logsEndpoint,
      config.collector.metricsEndpoint,
      config.collector.tracesEndpoint,
      Object.entries(config.collector.headers).sort(([a], [b]) =>
        a.localeCompare(b)
      ),
      config.identity?.user?.id ?? null,
      config.identity?.tenant?.id ?? null,
    ])
  );
}
