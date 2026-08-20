import { Buffer } from 'node:buffer';
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { build } from 'esbuild';

const root = process.cwd();
const artifacts = join(root, 'artifacts');
const bundlePath = join(artifacts, 'benchmark-sdk.cjs');
const resultsPath = join(artifacts, 'benchmark-results.json');

const budgets = {
  startupP95Millis: 25,
  correlatedEventAverageMillis: 0.25,
  retainedHeapBytes: 4 * 1024 * 1024,
  otlpBytesPerEvent: 2 * 1024,
  maxOtlpRequestBytes: 128 * 1024,
};

async function main() {
  await mkdir(artifacts, { recursive: true });
  await build({
    absWorkingDir: root,
    bundle: true,
    entryPoints: ['src/sdk.ts'],
    format: 'cjs',
    outfile: bundlePath,
    platform: 'node',
    target: ['node22'],
    sourcemap: false,
    plugins: [reactNativeStub()],
  });

  const require = createRequire(join(root, 'scripts', 'benchmark.mjs'));
  const { ElvenObservabilitySdk } = require(bundlePath);

  const requests = [];
  globalThis.fetch = async (endpoint, init = {}) => {
    requests.push({
      endpoint: String(endpoint),
      bodyBytes: Buffer.byteLength(String(init.body ?? ''), 'utf8'),
    });
    return {
      headers: { get: () => null },
      status: 202,
    };
  };

  const configuration = {
    serviceName: 'elven-benchmark',
    version: '1.0.0',
    environment: 'benchmark',
    collector: { endpoint: 'https://collector.benchmark.invalid' },
    sampling: { traceRatio: 1 },
    batch: {
      maxQueueSize: 512,
      maxExportBatchSize: 64,
      scheduledDelayMillis: 60_000,
      metricExportIntervalMillis: 60_000,
      exportTimeoutMillis: 5_000,
    },
    queue: {
      enabled: false,
      maxItems: 128,
      maxBytes: 2 * 1024 * 1024,
      maxItemBytes: 128 * 1024,
    },
    instrumentations: {
      console: false,
      network: false,
      errors: false,
      lifecycle: false,
    },
  };

  const startupDurations = [];
  for (let index = 0; index < 7; index += 1) {
    const sdk = new ElvenObservabilitySdk();
    const startedAt = performance.now();
    await sdk.initialize(configuration);
    startupDurations.push(performance.now() - startedAt);
    await sdk.shutdown(5_000);
  }

  globalThis.gc?.();
  const sdk = new ElvenObservabilitySdk();
  await sdk.initialize(configuration);
  globalThis.gc?.();
  const heapBefore = process.memoryUsage().heapUsed;
  const requestOffset = requests.length;
  const operations = 400;
  const workloadStartedAt = performance.now();

  for (let index = 0; index < operations; index += 1) {
    sdk.event('benchmark.checkout.completed', {
      'checkout.channel': 'mobile',
      'checkout.item_count': index % 4,
    });
  }

  const workloadMillis = performance.now() - workloadStartedAt;
  await sdk.flush(5_000);
  const workloadRequests = requests.slice(requestOffset);
  await sdk.shutdown(5_000);
  globalThis.gc?.();
  const retainedHeapBytes = Math.max(
    0,
    process.memoryUsage().heapUsed - heapBefore
  );
  const otlpBytes = workloadRequests.reduce(
    (total, request) => total + request.bodyBytes,
    0
  );
  const maxOtlpRequestBytes = Math.max(
    0,
    ...workloadRequests.map((request) => request.bodyBytes)
  );

  startupDurations.sort((left, right) => left - right);
  const measurements = {
    startupMedianMillis: percentile(startupDurations, 0.5),
    startupP95Millis: percentile(startupDurations, 0.95),
    correlatedEventAverageMillis: workloadMillis / operations,
    retainedHeapBytes,
    otlpBytesPerEvent: otlpBytes / operations,
    maxOtlpRequestBytes,
    otlpRequestCount: workloadRequests.length,
    operations,
  };
  const failures = Object.entries(budgets)
    .filter(([name, budget]) => measurements[name] > budget)
    .map(
      ([name, budget]) =>
        `${name}: ${format(measurements[name])} exceeds ${format(budget)}`
    );
  const report = {
    generatedAt: new Date().toISOString(),
    runtime: {
      node: process.version,
      platform: `${process.platform}-${process.arch}`,
    },
    budgets,
    measurements,
    passed: failures.length === 0,
    failures,
    scope:
      'Node-hosted JavaScript benchmark with React Native native APIs stubbed; not a device benchmark.',
  };

  await writeFile(resultsPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (failures.length > 0) process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(
    `[benchmark] ${error instanceof Error ? error.stack : String(error)}\n`
  );
  process.exitCode = 1;
});

function percentile(sortedValues, ratio) {
  const index = Math.min(
    sortedValues.length - 1,
    Math.ceil(sortedValues.length * ratio) - 1
  );
  return sortedValues[Math.max(0, index)] ?? 0;
}

function format(value) {
  return Number.isInteger(value) ? String(value) : value.toFixed(3);
}

function reactNativeStub() {
  return {
    name: 'react-native-benchmark-stub',
    setup(builder) {
      builder.onResolve({ filter: /^react-native$/ }, () => ({
        namespace: 'react-native-stub',
        path: 'react-native',
      }));
      builder.onLoad({ filter: /.*/, namespace: 'react-native-stub' }, () => ({
        contents: `
            export const TurboModuleRegistry = { get: () => null };
            export const AppState = {
              currentState: 'active',
              addEventListener: () => ({ remove() {} }),
            };
          `,
        loader: 'js',
      }));
    },
  };
}
