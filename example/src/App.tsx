import { StatusBar } from 'expo-status-bar';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Image,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import {
  ElvenObservability,
  SpanStatusCode,
  type FlushResult,
  type SdkHealth,
} from 'elven-unified-observability-react-native';

declare const process: {
  env: { EXPO_PUBLIC_OTLP_ENDPOINT?: string };
};

const API_ORIGIN = 'https://jsonplaceholder.typicode.com';
const DEFAULT_ENDPOINT = Platform.select({
  android: 'http://10.0.2.2:4318',
  default: 'http://localhost:4318',
});
const COLLECTOR_ENDPOINT =
  process.env.EXPO_PUBLIC_OTLP_ENDPOINT?.trim() || DEFAULT_ENDPOINT;

type Operation =
  'event' | 'exception' | 'flush' | 'log' | 'metric' | 'network' | 'trace';

export default function App() {
  const [health, setHealth] = useState<SdkHealth>(ElvenObservability.health());
  const [busy, setBusy] = useState<Operation>();
  const [screen, setScreen] = useState('Overview');
  const [lastResult, setLastResult] = useState('SDK starting');
  const [diagnostic, setDiagnostic] = useState('No diagnostics');

  useEffect(() => {
    let mounted = true;
    const start = async () => {
      await ElvenObservability.initialize({
        serviceName: 'elven-react-native-demo',
        version: '1.0.0',
        environment: 'demo',
        collector: {
          endpoint: COLLECTOR_ENDPOINT,
          timeoutMillis: 5_000,
        },
        sampling: { traceRatio: 1 },
        batch: {
          scheduledDelayMillis: 2_000,
          metricExportIntervalMillis: 10_000,
          exportTimeoutMillis: 5_000,
        },
        queue: {
          maxItems: 64,
          maxBytes: 512 * 1024,
          maxItemBytes: 128 * 1024,
          maxAgeMillis: 24 * 60 * 60 * 1_000,
        },
        privacy: {
          hashUserId: true,
          hashTenantId: true,
          urlQueryPolicy: 'drop',
        },
        instrumentations: {
          console: {
            enabled: __DEV__,
            levels: ['warn', 'error'],
            preserveOriginal: true,
          },
          network: {
            enabled: true,
            fetch: true,
            xhr: true,
            propagateTraceHeadersTo: [API_ORIGIN],
          },
          errors: true,
          lifecycle: true,
        },
        diagnostics: __DEV__
          ? {
              enabled: true,
              verbose: false,
              sink: (message) => {
                if (mounted) setDiagnostic(message);
              },
            }
          : false,
      });

      ElvenObservability.context.setSession('demo-session');
      ElvenObservability.context.setUser({ id: 'demo-user-42' });
      ElvenObservability.context.setTenant({ id: 'demo-tenant' });
      ElvenObservability.recordScreen('Overview');
      ElvenObservability.event('demo.started', {
        'demo.platform': Platform.OS,
      });
      if (mounted) {
        setHealth(ElvenObservability.health());
        setLastResult('SDK initialized');
      }
    };

    ignorePromise(start());
    const healthTimer = setInterval(() => {
      if (mounted) setHealth(ElvenObservability.health());
    }, 1_000);

    return () => {
      mounted = false;
      clearInterval(healthTimer);
      ignorePromise(ElvenObservability.shutdown(2_000));
    };
  }, []);

  const execute = useCallback(
    async (operation: Operation, task: () => void | Promise<void>) => {
      if (busy) return;
      setBusy(operation);
      try {
        await task();
      } catch (error) {
        ElvenObservability.captureException(
          error,
          { 'demo.operation': operation },
          { handled: true, mechanism: 'demo.action' }
        );
        setLastResult(
          `${operation}: ${error instanceof Error ? error.message : String(error)}`
        );
      } finally {
        setHealth(ElvenObservability.health());
        setBusy(undefined);
      }
    },
    [busy]
  );

  const runTrace = () =>
    execute('trace', async () => {
      const span = ElvenObservability.traces.startSpan('checkout.confirm', {
        attributes: {
          'checkout.currency': 'BRL',
          'checkout.item_count': 2,
        },
      });
      try {
        span.run(() => {
          ElvenObservability.logs.info(
            'Checkout started',
            { 'checkout.step': 'request' },
            { context: span.context }
          );
          ElvenObservability.metrics.counter(
            'checkout.attempt.count',
            1,
            { 'checkout.channel': 'demo' },
            { context: span.context }
          );
        });

        const response = await span.run(() => fetch(`${API_ORIGIN}/todos/1`));
        if (!response.ok) throw new Error(`HTTP ${response.status}`);

        span.run(() => {
          span.addEvent('checkout.response.received', {
            'http.response.status_code': response.status,
          });
          ElvenObservability.logs.info(
            'Checkout completed',
            { 'checkout.step': 'complete' },
            { context: span.context }
          );
          ElvenObservability.metrics.histogram(
            'checkout.order.value',
            149.9,
            { 'checkout.currency': 'BRL' },
            { context: span.context, unit: 'BRL' }
          );
        });
        span.setStatus({ code: SpanStatusCode.OK });
        setLastResult('Trace, child HTTP span, log and metrics correlated');
      } catch (error) {
        span.recordException(error).setStatus({
          code: SpanStatusCode.ERROR,
          message: error instanceof Error ? error.message : String(error),
        });
        throw error;
      } finally {
        span.end();
      }
    });

  const runNetworkFailure = () =>
    execute('network', async () => {
      try {
        await fetch('https://network-failure.invalid/demo');
      } catch (error) {
        ElvenObservability.logs.warn('Expected demo network failure', {
          'error.type': error instanceof Error ? error.name : 'unknown',
        });
        setLastResult('Failed HTTP request captured without breaking the app');
      }
    });

  const runFlush = () =>
    execute('flush', async () => {
      const result = await ElvenObservability.flush(5_000);
      setLastResult(formatFlush(result));
    });

  const selectScreen = (next: string) => {
    setScreen(next);
    ElvenObservability.recordScreen(next, { 'navigation.source': 'demo-tabs' });
    setLastResult(`Screen context changed to ${next}`);
  };

  const healthRows = useMemo(
    () => [
      ['State', health.state],
      ['Native bridge', health.nativeBridgeAvailable ? 'available' : 'JS only'],
      [
        'Queued',
        `${health.queueItems} items / ${formatBytes(health.queueBytes)}`,
      ],
      ['Dropped', String(health.droppedItems)],
      ['Transport failures', String(health.transportFailures)],
      ['Circuit', health.circuitOpen ? 'open' : 'closed'],
    ],
    [health]
  );

  return (
    <SafeAreaView style={styles.safeArea}>
      <StatusBar style="dark" />
      <ScrollView
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.header}>
          <Image
            accessibilityIgnoresInvertColors
            source={require('../assets/icon.png')}
            style={styles.logo}
          />
          <View style={styles.headerCopy}>
            <Text style={styles.title}>Elven Observability</Text>
            <Text style={styles.subtitle}>React Native production demo</Text>
          </View>
          <View
            accessibilityLabel={`SDK ${health.state}`}
            style={[
              styles.stateDot,
              health.state === 'started'
                ? styles.stateHealthy
                : styles.statePending,
            ]}
          />
        </View>

        <View style={styles.endpointBand}>
          <Text style={styles.eyebrow}>OTLP/HTTP collector</Text>
          <Text numberOfLines={2} selectable style={styles.endpoint}>
            {COLLECTOR_ENDPOINT}
          </Text>
        </View>

        <View style={styles.screenTabs}>
          {['Overview', 'Checkout', 'Profile'].map((value) => (
            <Pressable
              accessibilityRole="tab"
              accessibilityState={{ selected: screen === value }}
              key={value}
              onPress={() => selectScreen(value)}
              style={[
                styles.screenTab,
                screen === value && styles.screenTabSelected,
              ]}
            >
              <Text
                style={[
                  styles.screenTabText,
                  screen === value && styles.screenTabTextSelected,
                ]}
              >
                {value}
              </Text>
            </Pressable>
          ))}
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Signals</Text>
          <Text style={styles.sectionMeta}>Current screen: {screen}</Text>
          <View style={styles.actionGrid}>
            <ActionButton
              busy={busy === 'log'}
              disabled={Boolean(busy)}
              label="Structured log"
              onPress={() =>
                ignorePromise(
                  execute('log', () => {
                    ElvenObservability.logs.info('Customer action', {
                      'action.name': 'demo.log',
                      'cart.item_count': 2,
                    });
                    setLastResult('Structured log recorded');
                  })
                )
              }
            />
            <ActionButton
              busy={busy === 'metric'}
              disabled={Boolean(busy)}
              label="Custom metrics"
              onPress={() =>
                ignorePromise(
                  execute('metric', () => {
                    ElvenObservability.metrics.counter('demo.tap.count');
                    ElvenObservability.metrics.gauge(
                      'demo.cart.items',
                      2,
                      undefined,
                      { unit: '{item}' }
                    );
                    setLastResult('Counter and gauge recorded');
                  })
                )
              }
            />
            <ActionButton
              busy={busy === 'event'}
              disabled={Boolean(busy)}
              label="Business event"
              onPress={() =>
                ignorePromise(
                  execute('event', () => {
                    ElvenObservability.event('checkout.coupon.applied', {
                      'coupon.type': 'percentage',
                      'coupon.value': 10,
                    });
                    setLastResult('Correlated business event recorded');
                  })
                )
              }
            />
            <ActionButton
              busy={busy === 'exception'}
              disabled={Boolean(busy)}
              label="Handled exception"
              onPress={() =>
                ignorePromise(
                  execute('exception', () => {
                    const error = new Error('Demonstration payment validation');
                    ElvenObservability.captureException(
                      error,
                      { 'payment.provider': 'demo' },
                      { handled: true, mechanism: 'validation' }
                    );
                    setLastResult('Handled exception captured');
                  })
                )
              }
            />
          </View>
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Operations</Text>
          <ActionButton
            busy={busy === 'trace'}
            disabled={Boolean(busy)}
            emphasis="primary"
            label="Run correlated checkout"
            onPress={() => ignorePromise(runTrace())}
            wide
          />
          <ActionButton
            busy={busy === 'network'}
            disabled={Boolean(busy)}
            emphasis="danger"
            label="Simulate network failure"
            onPress={() => ignorePromise(runNetworkFailure())}
            wide
          />
          <ActionButton
            busy={busy === 'flush'}
            disabled={Boolean(busy)}
            label="Flush telemetry"
            onPress={() => ignorePromise(runFlush())}
            wide
          />
        </View>

        <View style={styles.healthPanel}>
          <View style={styles.healthHeader}>
            <Text style={styles.sectionTitle}>Runtime health</Text>
            <Text style={styles.healthBadge}>{health.state}</Text>
          </View>
          {healthRows.map(([label, value]) => (
            <View key={label} style={styles.healthRow}>
              <Text style={styles.healthLabel}>{label}</Text>
              <Text style={styles.healthValue}>{value}</Text>
            </View>
          ))}
        </View>

        <View style={styles.resultBand}>
          <Text style={styles.eyebrow}>Last result</Text>
          <Text selectable style={styles.resultText}>
            {lastResult}
          </Text>
          <Text numberOfLines={2} style={styles.diagnosticText}>
            {diagnostic}
          </Text>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

interface ActionButtonProps {
  busy: boolean;
  disabled: boolean;
  emphasis?: 'danger' | 'primary';
  label: string;
  onPress(): void;
  wide?: boolean;
}

function ActionButton({
  busy,
  disabled,
  emphasis,
  label,
  onPress,
  wide = false,
}: ActionButtonProps) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ busy, disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.action,
        wide && styles.actionWide,
        emphasis === 'primary' && styles.actionPrimary,
        emphasis === 'danger' && styles.actionDanger,
        pressed && !disabled && styles.actionPressed,
        disabled && styles.actionDisabled,
      ]}
    >
      {busy ? (
        <ActivityIndicator color={emphasis ? '#ffffff' : '#17201d'} />
      ) : (
        <Text
          style={[styles.actionText, emphasis && styles.actionTextEmphasis]}
        >
          {label}
        </Text>
      )}
    </Pressable>
  );
}

function formatFlush(result: FlushResult): string {
  return `Flush delivered ${result.delivered}, pending ${result.pending}, dropped ${result.dropped}${result.timedOut ? ' (timeout)' : ''}`;
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  return `${(value / 1024).toFixed(1)} KiB`;
}

function ignorePromise(promise: Promise<unknown>): void {
  promise.catch(() => undefined);
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: '#f5f6f4',
  },
  content: {
    width: '100%',
    maxWidth: 720,
    alignSelf: 'center',
    paddingHorizontal: 18,
    paddingTop: 18,
    paddingBottom: 40,
  },
  header: {
    minHeight: 58,
    flexDirection: 'row',
    alignItems: 'center',
  },
  logo: {
    width: 42,
    height: 42,
    borderRadius: 8,
  },
  headerCopy: {
    flex: 1,
    marginLeft: 12,
  },
  title: {
    color: '#17201d',
    fontSize: 21,
    fontWeight: '700',
  },
  subtitle: {
    color: '#69716d',
    fontSize: 13,
    marginTop: 2,
  },
  stateDot: {
    width: 11,
    height: 11,
    borderRadius: 6,
    borderWidth: 2,
    borderColor: '#ffffff',
  },
  stateHealthy: {
    backgroundColor: '#16845b',
  },
  statePending: {
    backgroundColor: '#d2922c',
  },
  endpointBand: {
    marginTop: 18,
    paddingVertical: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderColor: '#cdd2cf',
  },
  eyebrow: {
    color: '#69716d',
    fontSize: 11,
    fontWeight: '700',
    textTransform: 'uppercase',
  },
  endpoint: {
    color: '#17201d',
    fontFamily: Platform.select({ ios: 'Menlo', default: 'monospace' }),
    fontSize: 12,
    lineHeight: 18,
    marginTop: 4,
  },
  screenTabs: {
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 18,
    padding: 3,
    backgroundColor: '#e6e9e7',
    borderRadius: 7,
  },
  screenTab: {
    minHeight: 38,
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 5,
  },
  screenTabSelected: {
    backgroundColor: '#ffffff',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#cdd2cf',
  },
  screenTabText: {
    color: '#69716d',
    fontSize: 13,
    fontWeight: '600',
  },
  screenTabTextSelected: {
    color: '#17201d',
  },
  section: {
    marginTop: 28,
  },
  sectionTitle: {
    color: '#17201d',
    fontSize: 16,
    fontWeight: '700',
  },
  sectionMeta: {
    color: '#69716d',
    fontSize: 12,
    marginTop: 4,
  },
  actionGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
    marginTop: 10,
    rowGap: 10,
  },
  action: {
    width: '48.5%',
    minHeight: 48,
    paddingHorizontal: 12,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 6,
    borderWidth: 1,
    borderColor: '#bcc4c0',
    backgroundColor: '#ffffff',
  },
  actionWide: {
    width: '100%',
    marginTop: 10,
  },
  actionPrimary: {
    backgroundColor: '#176b50',
    borderColor: '#176b50',
  },
  actionDanger: {
    backgroundColor: '#a8473f',
    borderColor: '#a8473f',
  },
  actionPressed: {
    opacity: 0.78,
  },
  actionDisabled: {
    opacity: 0.55,
  },
  actionText: {
    color: '#17201d',
    fontSize: 13,
    fontWeight: '700',
    textAlign: 'center',
  },
  actionTextEmphasis: {
    color: '#ffffff',
  },
  healthPanel: {
    marginTop: 28,
    padding: 16,
    borderRadius: 7,
    borderWidth: 1,
    borderColor: '#cdd2cf',
    backgroundColor: '#ffffff',
  },
  healthHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingBottom: 8,
  },
  healthBadge: {
    color: '#176b50',
    fontSize: 11,
    fontWeight: '700',
    textTransform: 'uppercase',
  },
  healthRow: {
    minHeight: 34,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderTopWidth: StyleSheet.hairlineWidth,
    borderColor: '#e0e4e1',
  },
  healthLabel: {
    color: '#69716d',
    flex: 1,
    fontSize: 12,
  },
  healthValue: {
    color: '#17201d',
    flex: 1,
    fontSize: 12,
    fontWeight: '600',
    textAlign: 'right',
  },
  resultBand: {
    marginTop: 20,
    paddingVertical: 14,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderColor: '#cdd2cf',
  },
  resultText: {
    color: '#17201d',
    fontSize: 13,
    lineHeight: 19,
    marginTop: 5,
  },
  diagnosticText: {
    color: '#818984',
    fontSize: 11,
    lineHeight: 16,
    marginTop: 7,
  },
});
