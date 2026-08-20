import process from 'node:process';

const baseUrl = process.env.OTEL_SMOKE_ENDPOINT ?? 'http://127.0.0.1:4318';
const healthUrl = process.env.OTEL_HEALTH_ENDPOINT ?? 'http://127.0.0.1:13133';
const nowNanos = String(BigInt(Date.now()) * 1_000_000n);
const laterNanos = String(BigInt(Date.now() + 5) * 1_000_000n);
const traceId = '0123456789abcdef0123456789abcdef';
const spanId = '0123456789abcdef';
const resource = {
  attributes: [
    { key: 'service.name', value: { stringValue: 'elven-collector-smoke' } },
    { key: 'deployment.environment.name', value: { stringValue: 'ci' } },
  ],
};
const scope = { name: 'elven.collector.smoke', version: '1.0.0' };

await waitForHealth();
await post('/v1/traces', {
  resourceSpans: [
    {
      resource,
      scopeSpans: [
        {
          scope,
          spans: [
            {
              traceId,
              spanId,
              name: 'collector.smoke',
              kind: 1,
              startTimeUnixNano: nowNanos,
              endTimeUnixNano: laterNanos,
              status: { code: 1 },
            },
          ],
        },
      ],
    },
  ],
});
await post('/v1/logs', {
  resourceLogs: [
    {
      resource,
      scopeLogs: [
        {
          scope,
          logRecords: [
            {
              timeUnixNano: nowNanos,
              severityNumber: 9,
              severityText: 'INFO',
              body: { stringValue: 'collector smoke' },
              traceId,
              spanId,
            },
          ],
        },
      ],
    },
  ],
});
await post('/v1/metrics', {
  resourceMetrics: [
    {
      resource,
      scopeMetrics: [
        {
          scope,
          metrics: [
            {
              name: 'elven.collector.smoke',
              unit: '1',
              gauge: { dataPoints: [{ timeUnixNano: nowNanos, asDouble: 1 }] },
            },
          ],
        },
      ],
    },
  ],
});

process.stdout.write(
  'Collector accepted correlated traces, logs, and metrics.\n'
);

async function waitForHealth() {
  for (let attempt = 1; attempt <= 30; attempt += 1) {
    try {
      const response = await fetch(healthUrl, {
        signal: globalThis.AbortSignal.timeout(1_000),
      });
      if (response.ok) return;
    } catch {
      // The collector may still be starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(
    `Collector health endpoint did not become ready: ${healthUrl}`
  );
}

async function post(path, body) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: globalThis.AbortSignal.timeout(5_000),
  });
  if (!response.ok) {
    throw new Error(`${path} returned HTTP ${response.status}.`);
  }
}
