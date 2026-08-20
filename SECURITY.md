# Security and privacy

## Reporting a vulnerability

Do not open a public issue containing an exploitable vulnerability, customer telemetry, credentials, or personal data. Use the repository's private GitHub security advisory flow. Include affected versions, platform, reproduction steps, impact, and any known mitigation.

## Safe defaults

- Production Collector endpoints require HTTPS.
- HTTP trace headers are never propagated unless the destination matches `propagateTraceHeadersTo` by origin and path boundary.
- URL query strings and fragments are dropped by default.
- Request and response bodies are never captured.
- Request and response headers are captured only by explicit header-name allow-list.
- Authorization, cookie, password, secret, token, API key, payment-card, body, email, phone, CPF, and CNPJ-like keys are redacted even if selected elsewhere.
- Common credentials, JWTs, URL user-info, and email addresses embedded in free-form strings are redacted in JS and before native events are queued or persisted.
- User and tenant IDs are pseudonymized by default with a service- and environment-scoped SHA-256 namespace.
- Attribute count, value length, message, stack, event-name, metric-cardinality, queue-item, queue-byte, payload-byte, and age limits are always bounded.
- Collector headers remain in JS memory and are never persisted or emitted.
- Native persistence is private, excluded from backup, atomic, and bounded. iOS uses data protection.
- Diagnostics are off by default, rate-limited, text-redacted, context-bounded, and do not print payloads or Collector headers.

## Mobile authentication

A long-lived static token embedded in JavaScript, Android resources, an iOS bundle, Dockerfile, or Expo public environment variable is extractable and must not be treated as a secret.

Preferred deployment:

1. Send OTLP/HTTP over TLS to a customer-controlled Collector or telemetry gateway.
2. Authenticate the app through an existing short-lived user/device session or an edge control that does not require a reusable app secret.
3. Apply rate limiting, tenant derivation, body limits, and signal validation at the gateway.
4. Keep backend credentials between the Collector and observability backends.

`collector.headers` exists for runtime-provided short-lived headers and non-secret routing metadata. The current configuration is immutable after initialization, so token rotation requires a controlled SDK shutdown and re-initialization. Do not use `EXPO_PUBLIC_*` for a secret.

## Pseudonymization limits

Hashing an identifier does not make it anonymous. Low-entropy or known identifiers may be guessed, and the backend can still link repeated values within the same service and environment. Prefer random opaque application IDs. Obtain any required consent before setting user, tenant, session, business, device, or navigation context.

To prevent collection entirely:

```ts
ElvenObservability.context.setUser(null);
ElvenObservability.context.setTenant(null);
ElvenObservability.context.setSession(null);
ElvenObservability.context.setBusinessContext(null);
```

## Custom redaction

```ts
await ElvenObservability.initialize({
  serviceName: 'mobile-app',
  environment: 'production',
  collector: { endpoint: 'https://otel.example.com' },
  privacy: {
    redactKeys: [/authorization/i, /customer\.document/i, /medical/i],
    urlQueryPolicy: 'drop',
    attributeFilter: (key, value) => {
      if (key.startsWith('internal.')) return undefined;
      return value;
    },
  },
});
```

Supplying `redactKeys` replaces the default list. Include the defaults or use `attributeFilter` when extending policy. A throwing filter is isolated and drops only the affected attribute.

## Query and header policy

Query capture is opt-in and key-scoped:

```ts
privacy: {
  urlQueryPolicy: 'allow-listed',
  allowedUrlQueryKeys: ['page', 'sort'],
}
```

Never allow-list tokens, email, search text, free-form values, or identifiers. Header capture should be limited to low-cardinality protocol metadata such as `content-type`; sensitive names remain redacted.

## Threat boundaries

The SDK protects the host app from telemetry backend and SDK failures. It does not protect against malicious application code running in the same JS or native process, a rooted/jailbroken device, an attacker controlling the Collector endpoint, or arbitrary sensitive text that does not match configured keys and built-in content patterns. Redaction is defense in depth, not a data-classification engine. Backend ingestion must independently authenticate, authorize, rate-limit, sanitize, and enforce tenancy.

## Dependency and release controls

- Runtime dependencies are exact-pinned.
- CI runs lockfile installation, lint, strict typecheck, tests with coverage gates, builds, benchmarks, bundle budgets, native release builds, and package inspection.
- Release publication uses npm provenance and requires CI success.
- Dependency vulnerability scanning is evidence, not proof that an application is secure; findings are reviewed with reachability and runtime context.
