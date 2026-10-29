import { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { ElvenObservability } from 'elven-unified-observability-react-native';

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
        setRuntimeStatus(
          nativeBridgeAvailable
            ? 'Elven native bridge ready'
            : 'Elven native bridge unavailable'
        );
      })
      .catch(() => {
        if (mounted) setRuntimeStatus('Elven initialization failed');
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
