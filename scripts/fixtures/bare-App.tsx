import { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { ElvenObservability } from 'elven-unified-observability-react-native';

export default function App() {
  const [runtimeStatus, setRuntimeStatus] = useState(
    'Elven native bridge initializing'
  );

  useEffect(() => {
    let mounted = true;

    ElvenObservability.initialize({
      serviceName: 'elven-bare-validation',
      environment: 'validation',
      collector: { endpoint: 'https://collector.example.com' },
    })
      .then(() => {
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
      ElvenObservability.shutdown().catch(() => undefined);
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
