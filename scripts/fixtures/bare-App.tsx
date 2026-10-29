import { useEffect, useState } from 'react';
import { DeviceEventEmitter, StyleSheet, Text, View } from 'react-native';
import { ElvenObservability } from 'elven-unified-observability-react-native';

async function probeNativeHttp(): Promise<string> {
  const endpoint = 'http://127.0.0.1:4319';
  const baselineIds = new Set<number>();
  let baselineBytes = 0;
  const headers = DeviceEventEmitter.addListener(
    'didReceiveNetworkResponse',
    (event: unknown[]) => {
      if (event[3] === `${endpoint}/baseline`)
        baselineIds.add(event[0] as number);
    }
  );
  const body = DeviceEventEmitter.addListener(
    'didReceiveNetworkData',
    (event: unknown[]) => {
      if (!baselineIds.has(event[0] as number)) return;
      const value = event[1];
      baselineBytes =
        typeof value === 'string'
          ? value.length
          : Number((value as { size?: number })?.size ?? 0);
    }
  );
  try {
    // Intentionally read status only, like the previous SDK export adapter.
    const baseline = await fetch(`${endpoint}/baseline`);
    if (baseline.status !== 200 || baselineBytes !== 8 * 1024 * 1024)
      throw new Error(`Baseline native body not observed: ${baselineBytes}`);
  } finally {
    headers.remove();
    body.remove();
  }
  const configuration = {
    serviceName: 'elven-native-http-probe',
    environment: 'validation',
    consent: 'granted' as const,
    lifecycleTimeoutMillis: 3000,
    strictInitialization: true,
    collector: { endpoint: `${endpoint}/bounded`, timeoutMillis: 3000 },
    signals: { logs: true, metrics: false, traces: false },
    instrumentations: {
      console: false,
      network: false,
      errors: false,
      lifecycle: false,
    },
  };
  await ElvenObservability.initialize(configuration);
  ElvenObservability.logs.error('native bounded response probe');
  const result = await ElvenObservability.flush(3000);
  const deliveredHealth = ElvenObservability.health();
  const deliveryStats = (await (await fetch(`${endpoint}/stats`)).json()) as {
    payloadSeen: Record<string, boolean>;
    cancelled: Record<string, boolean>;
  };
  // Background flush can win the race. Require actual collector payload + SDK ACK,
  // no pending/dropped batches, and early response cancellation, not a per-flush counter guess.
  if (
    !deliveredHealth.lastSuccessfulExportUnixMillis ||
    result.pending !== 0 ||
    deliveredHealth.droppedItems !== 0 ||
    !deliveryStats.payloadSeen['/bounded/v1/logs'] ||
    !deliveryStats.cancelled['/bounded/v1/logs']
  )
    throw new Error(
      `Bounded native export not acknowledged: ${JSON.stringify({ result, health: deliveredHealth, deliveryStats })}`
    );
  await ElvenObservability.reconfigure(
    {
      ...configuration,
      collector: { ...configuration.collector, endpoint: `${endpoint}/retry` },
    },
    3000
  );
  ElvenObservability.logs.error('native retry floor probe');
  await ElvenObservability.flush(3000);
  await ElvenObservability.flush(3000);
  await ElvenObservability.reconfigure(
    {
      ...configuration,
      collector: { ...configuration.collector, endpoint: `${endpoint}/hang` },
    },
    3000
  );
  ElvenObservability.logs.error('native abort probe');
  const flushing = ElvenObservability.flush(3000);
  type Stats = {
    requests: Record<string, number>;
    cancelled: Record<string, boolean>;
  };
  let stats: Stats | undefined;
  for (let attempt = 0; attempt < 50; attempt++) {
    stats = (await (await fetch(`${endpoint}/stats`)).json()) as Stats;
    if (stats.requests['/hang/v1/logs']) break;
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
  if (!stats?.requests['/hang/v1/logs'])
    throw new Error('Native hang request not observed');
  const revoked = await ElvenObservability.setConsent(false, 3000);
  if (!revoked.purged) throw new Error('Native HTTP purge not acknowledged');
  await flushing;
  // SDK cancellation must leave an unrelated application request usable.
  if (
    (await (await fetch(`${endpoint}/app-health`)).text()) !==
    'app-network-still-works'
  )
    throw new Error('Application networking was damaged');
  stats = (await (await fetch(`${endpoint}/stats`)).json()) as Stats;
  if (
    !stats.cancelled['/bounded/v1/logs'] ||
    !stats.cancelled['/retry/v1/logs'] ||
    !stats.cancelled['/hang/v1/logs'] ||
    stats.requests['/retry/v1/logs'] !== 1
  )
    throw new Error(
      `Native HTTP bounds/floor/abort failed: ${JSON.stringify(stats)}`
    );
  await fetch(`${endpoint}/probe-complete?baseline=${baselineBytes}`);
  return `HTTP8MiB:${baselineBytes} bounded+retry+abort+app-ok`;
}

export default function App() {
  const [runtimeStatus, setRuntimeStatus] = useState(
    'Elven native bridge initializing'
  );

  useEffect(() => {
    let mounted = true;
    const configuration = {
      serviceName: 'elven-bare-validation',
      environment: 'validation',
      lifecycleTimeoutMillis: 3000,
      collector: { endpoint: 'http://127.0.0.1:1', timeoutMillis: 500 },
      signals: { logs: true, metrics: false, traces: false },
      instrumentations: { console: false, network: false, errors: false },
    };

    ElvenObservability.initialize({ ...configuration, consent: 'denied' })
      .then(async () => {
        if (!mounted) return;
        const coldPurge = await ElvenObservability.setConsent(false, 3000);
        if (!coldPurge.purged)
          throw new Error('Cold native purge not acknowledged');
        await ElvenObservability.setConsent(true, 3000);
        if (!mounted) return;
        if (
          !(globalThis as unknown as { HermesInternal?: unknown })
            .HermesInternal
        )
          throw new Error('Hermes runtime unavailable');
        if (!ElvenObservability.health().nativeBridgeAvailable)
          throw new Error('Native fence is unavailable');
        ElvenObservability.logs.error('native storage lifecycle probe');
        await ElvenObservability.flush(2000);
        if (!mounted) return;
        const revoked = await ElvenObservability.setConsent(false, 3000);
        if (!revoked.purged) throw new Error('Native purge not acknowledged');
        if (!mounted) return;
        await ElvenObservability.setConsent(true, 3000);
        if (!mounted) return;
        await ElvenObservability.setIdentity(
          { user: { id: 'runtime-probe' }, tenant: { id: 'runtime-probe' } },
          3000
        );
        if (!mounted) return;
        const nativeBridgeAvailable =
          ElvenObservability.health().nativeBridgeAvailable;
        const finalPurge = await ElvenObservability.setConsent(false, 3000);
        if (!finalPurge.purged)
          throw new Error('Final native purge not acknowledged');
        const httpProof = await probeNativeHttp();
        if (!mounted) return;
        setRuntimeStatus(
          nativeBridgeAvailable
            ? `Elven native bridge ready ${httpProof}`
            : 'Elven native bridge unavailable'
        );
      })
      .catch((error: unknown) => {
        if (mounted)
          setRuntimeStatus(`Elven initialization failed: ${String(error)}`);
      });

    return () => {
      mounted = false;
      ElvenObservability.setConsent(false, 3000).catch(() => undefined);
    };
  }, []);

  return (
    <View style={styles.container}>
      <Text>Elven bare React Native validation</Text>
      <Text accessibilityLiveRegion="polite">{runtimeStatus}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    alignItems: 'center',
    flex: 1,
    justifyContent: 'center',
  },
});
