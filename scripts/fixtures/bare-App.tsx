import { useEffect } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { ElvenObservability } from 'elven-unified-observability-react-native';

export default function App() {
  useEffect(() => {
    ElvenObservability.initialize({
      serviceName: 'elven-bare-validation',
      environment: 'validation',
      collector: { endpoint: 'https://collector.example.com' },
    }).catch(() => undefined);

    return () => {
      ElvenObservability.shutdown().catch(() => undefined);
    };
  }, []);

  return (
    <View style={styles.container}>
      <Text>Elven bare React Native validation</Text>
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
