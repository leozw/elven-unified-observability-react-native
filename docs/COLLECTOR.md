# Collector integration

The SDK sends standard OTLP/HTTP JSON to:

- `POST /v1/logs`
- `POST /v1/metrics`
- `POST /v1/traces`

Use a Collector or gateway as the public mobile ingestion boundary. Do not point the app directly at Loki, Mimir, Tempo, or a backend credential endpoint.

## Local development

```sh
docker compose -f example/docker-compose.yml up
```

The pinned Collector listens only on host loopback ports `4318` and `13133` and prints all signals with the debug exporter. It has a 128 MiB memory limiter and bounded batch processor. It is for local validation only; it has no TLS or authentication.

Endpoint mapping:

| Runtime                                               | Endpoint                                                           |
| ----------------------------------------------------- | ------------------------------------------------------------------ |
| iOS simulator                                         | `http://localhost:4318`                                            |
| Android emulator                                      | `http://10.0.2.2:4318`                                             |
| Android emulator with `adb reverse tcp:4318 tcp:4318` | `http://localhost:4318`                                            |
| Physical device                                       | `http://<development-host-LAN-IP>:4318` with local firewall access |
| Expo web                                              | `http://localhost:4318` with Collector CORS enabled                |

Local cleartext transport must never be reused for a production environment. Release configuration validation requires HTTPS when `environment` is `production`.

## Production ingress requirements

- TLS with a valid public or enterprise-trusted certificate;
- no reusable static secret embedded in the mobile app;
- request body limits compatible with the configured `maxItemBytes`;
- rate limiting by trustworthy principal and network signals;
- tenant selection at a trusted gateway, not from an unauthenticated client header;
- OTLP signal path validation and content-type validation;
- load shedding and bounded queues;
- PII/sensitive attribute defense in depth at Collector processors;
- backend credentials only on the Collector side;
- retention, regional routing, consent, and deletion policy appropriate to the client;
- monitoring for rejects, throttling, latency, queue saturation, and backend failure.

The Collector OTLP receiver supports HTTP/JSON and CORS configuration. CORS is relevant to web fallback, not native fetch, and should allow exact production origins rather than `*`.

## Example production shape

```yaml
receivers:
  otlp:
    protocols:
      http:
        endpoint: 0.0.0.0:4318

processors:
  memory_limiter:
    check_interval: 1s
    limit_percentage: 75
    spike_limit_percentage: 15
  batch:
    send_batch_size: 1024
    timeout: 2s

service:
  pipelines:
    logs:
      receivers: [otlp]
      processors: [memory_limiter, batch]
      exporters: [your_logs_exporter]
    metrics:
      receivers: [otlp]
      processors: [memory_limiter, batch]
      exporters: [your_metrics_exporter]
    traces:
      receivers: [otlp]
      processors: [memory_limiter, batch]
      exporters: [your_traces_exporter]
```

Authentication, authorization, TLS, redaction, routing, and exporters are deployment-specific and intentionally omitted from this illustrative shape. Use the organization's hardened Collector distribution and secret management.

## Acceptance queries

After triggering one correlated operation:

- find its root span and HTTP child span by `service.name` and operation name;
- find a log carrying the same `trace_id` and `span_id`;
- inspect a metric exemplar for the trace ID without any trace ID label;
- verify `deployment.environment.name`, service version, app build, platform, and screen name;
- verify Collector request recursion is absent;
- verify raw user/tenant values, query strings, headers, and bodies are absent;
- simulate 429/503/timeout and confirm bounded retry/circuit behavior;
- recover connectivity and confirm pending queue drains.
