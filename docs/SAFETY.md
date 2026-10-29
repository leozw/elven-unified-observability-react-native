# Lifecycle And Storage Contract

The authoritative integration documentation is [docs.elven.works](https://docs.elven.works), with source at [elvenworks-ps/docs.elven.works](https://github.com/elvenworks-ps/docs.elven.works). This document describes the additive package APIs and security tradeoffs, not customer acceptance.

## Consent And Identity

`consent: 'granted'` is the compatibility default. Applications must supply their own persisted consent decision on each process launch. Runtime denial is shared by all copies/instances of this SDK. A second instance cannot silently patch globals or bypass a runtime denial. An explicit grant is required after denial.

```ts
await sdk.initialize({
  serviceName: 'mobile',
  collector: { endpoint: 'https://ingest.example.test' },
  consent: 'denied',
});
// After the host application's consent decision:
await sdk.setConsent(true);
await sdk.setIdentity({
  user: { id: 'opaque-user-id' },
  tenant: { id: 'opaque-tenant-id' },
});
const result = await sdk.setConsent(false, 2000);
if (result.purged !== true) {
  // Keep consent denied. Erasure was not acknowledged within this budget.
}
```

Revocation and identity/destination changes synchronously close collection and transport before awaiting storage. They do not flush old data. Batches already handed to the platform network stack are aborted when possible, but transmitted bytes cannot be recalled. Immutable JS strings/platform buffers are not guaranteed cryptographically zeroized. `purged` refers to acknowledged SDK queue/file removal, not backend deletion.

`setIdentity` and `reconfigure` are awaitable transitions. Existing void context identity setters initiate the same transition and remain callable; events during the transition are intentionally dropped. This privacy-related data loss is preferable to sending previous-user batches under new credentials. `context.clear()` now uses a no-send identity transition. Reconfigure headers for token renewal; there is no automatic 401 refresh.

401 and other permanent HTTP failures drop the affected batch. Retries use bounded attempts, exponential jitter and a circuit breaker. `retry.maxDelayMillis` caps client backoff, never the server's `Retry-After` minimum (delta-seconds or HTTP date). Forced/background flush and shutdown may bypass client backoff/circuit delays, but not that minimum. Signals sharing an exact endpoint share its floor, including newly queued batches. If a batch expires before the floor, it is dropped. Only up to three timestamps are retained; an empty cooldown creates no long sleep/timer. Oversized or overflowing hints conservatively block the endpoint until purge/reconfigure instead of retrying early. Invalid short hints use ordinary client backoff. Wall-clock/OS scheduling is not a synchronized server clock guarantee.

## One Deadline And Owner

The default lifecycle budget is 5000ms, capped at 30000ms, configurable through `lifecycleTimeoutMillis`. An explicit flush/shutdown timeout uses one budget across provider, native and storage phases, not a fresh timeout per phase. JS event-loop/OS scheduling delays and application callbacks cannot be preempted by a timer.

Deadline expiry closes export, aborts current requests and removes automatic collection. Native `closeSession` invalidates the generation before completing file work. Late reads, initializes, writes and fetch completions are fenced. Actual native cleanup remains tracked; another owner cannot start while it is unresolved. This intentionally fails closed for telemetry while application work continues. `health().disabledReason` and diagnostics distinguish another owner from a consent denial.

Native binaries without the fenced lifecycle API are not used for persistence or native capture. Rebuild the application; an OTA-only JS update cannot add the native method. The new API is additive, but neither old/new binary interoperability nor an untested RN line is implied.

New public `ResolvedConfig.identity` and `lifecycleTimeoutMillis` fields are optional. Previously hand-constructed configurations remain assignable; omitted identity is empty and lifecycle timeout defaults to 5000ms internally. No existing named export/member or default metric dimension is removed. Review the full migration before a new minor release; the package version is not changed by this audit.

## Native HTTP

The previous mobile JS fetch adapter only read status, but RN's XHR networking may first materialize the entire response in native memory (including native Blob storage). Node fetch and mocked responses do not validate that behavior. CI probes use an 8 MiB ASCII loopback response, not an OOM experiment, and separate standard fetch from the candidate's public export API. Simulator/emulator proof is not physical-device RSS/soak proof.

Android clones the effective RN `NetworkingModule` OkHttp client and reapplies its per-request `CustomClientBuilder`, retaining TLS, trust/pinning, proxy and host interceptors. It disables cookie/cache use only on its own POST client, cancels its own `Call` at headers, then closes the response without reading it. RN has no public getter for these security hooks: the adapter uses guarded fields `mClient`/`client` and `customClientBuilder`, preserved by library consumer rules. Missing/changed access fails closed for telemetry with diagnostics, not a fresh weaker client. RN's newer response-handler API receives an already materialized byte array and is intentionally not used.

iOS selects the host's actual `RCTNetworking` URL request handler through the version-qualified `handlerForRequest:` selector and a private SDK delegate. The delegate cancels at native headers and never accumulates data, including late chunks. It does not use `RCTNetworkTask`'s response accumulator or replace `NSURLSession`/TLS delegates. A missing/non-cancellable handler fails closed. Both platforms bound ownership to four requests and reject stale sessions; close/revocation cancels only their own requests. Header metadata returned to JS is status and at most 257 characters of `Retry-After`, not arbitrary response bodies/headers.

These internal RN hooks require exact-version native build/runtime qualification and independent review. A host-provided interceptor/handler can still buffer data before SDK callbacks, or implement nonstandard security/cancellation semantics; qualify such integrations separately. Mobile export with an older/missing native adapter is deferred, not silently redirected through full-body fetch. Rebuild before enabling this candidate. Web retains fetch; custom proxy/TLS integrations, minified Android consumers and physical devices remain explicit acceptance dimensions. Loopback HTTP allowance exists only in the isolated CI consumer; production HTTPS validation and privacy masks remain enabled.

## Durable Data

Queues use schema 2, an opaque SHA-256 provenance of service/environment, exact signal destinations, sorted header values and user/tenant IDs, plus the current native owner generation. Raw credentials and IDs are not added to the queue envelope. Hashes are pseudonymous fingerprints, not anonymization or authorization.

Schema 1, malformed, expired, oversized, disabled-signal or mismatched-provenance data is dropped. There is no unsafe migration/relabeling of existing telemetry. Provide initial identity configuration to restore a queue for a known identity. Normal shutdown attempts a final export and can preserve retryable data only for matching provenance. Revocation/purge removes it without sending. A failed/expired purge must remain unacknowledged; caller-side consent must stay denied.

Schema 2 optionally persists retry floors even when no payload remains, so restart does not immediately retry a throttled endpoint. Rollback to an older SDK cannot reconstruct server hints it never understood. Purge deliberately discards queue/cooldown state; changing collector credentials or identity starts a separate provenance rather than replaying old data. Hosts must keep gateway limits in place and avoid using repeated reconfiguration as a retry loop.

Android next-launch crashes also carry the provenance hash. Old crash formats and a previous identity's crashes are discarded; an already-running old crash handler cannot recreate its file after an acknowledged purge. MetricKit history beginning before the current native consent session is dropped. Only fixed numeric summaries/counts from up to 16 payloads are collected, not raw JSON diagnostic payloads. Historical/crash detail coverage is therefore intentionally reduced; real MetricKit delivery remains a physical-device acceptance gate.

Sanitization bounds SDK traversal/output, skips accessors/toJSON and rejects strings over 65536 characters before regex work. A linear pre-scan also rejects any field containing a non-whitespace token over 1024 characters: the prior URL/email regexes could repeatedly scan a 64 KiB punctuation-heavy token despite the traversal budget. Whole-field replacement, rather than cutting a token, avoids exposing fragments of quoted credentials. Legitimate long URLs/identifiers and diagnostic detail can consequently be dropped. Built-in masks remain active even with custom masks. Engine property enumeration still scales with the width of caller-owned objects; applications must bound that input too. Custom filters/regexes/Proxy traps are trusted application extensions and can execute arbitrary application code; no universal CPU or zero-overhead guarantee is made.

Exception stacks are collected only when represented as bounded data properties. Opaque/accessor stacks are omitted rather than executing a potentially user-defined formatter/getter; names/messages remain available. This is an intentional diagnostic-detail tradeoff, not proof that every runtime exposes identical stacks.

## Development Supply Chain

Compatible patch/minor re-resolution updates xmldom, brace-expansion, compression, js-yaml, shell-quote, source-map-js, undici and compatible zod 4 consumers. Babel remains major 7. No forced zod 3-to-4 override is used.

Expo CLI 57.0.17 previously resolved node-forge 1.4.0: [GHSA-86w9-cpqp-85rv / CVE-2026-85393](https://github.com/advisories/GHSA-86w9-cpqp-85rv). The advisory still has a null first-patched-version field, but npm already offers 1.4.2 outside its affected range. The compatible lockfile update now resolves 1.4.2, whose canonical DigestInfo check rejects the nested-extra-element regression using an owned test key while accepting a valid signature. A null advisory field was not sufficient evidence that no fix existed.

The local Expo CLI patch additionally rejects `getCertificateForSigningIdAsync` before invoking node-forge, pending independent signing qualification. Device signing through this workspace's Expo helper is intentionally disabled; unsigned Xcode simulator release builds remain allowed. This is defense in depth for that entry point, not a claim of proven release-workflow exploitation or a complete cryptographic audit. Release CI uses `CODE_SIGNING_ALLOWED=NO`; no signing identity is imported.

Expo's zod 3.25.76 has a local guard limiting array validation to 4096 total elements per parse, before allocating per-element validation results, in both CJS/ESM v3 entry points. This mitigates [GHSA-mrhx-c7xc-m3w5 / CVE-2023-54404](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5) for the actual Expo v3 imports; it is not a claim that upstream 3.25.76 is fixed. The registry lists 4.6.6 as patched. Oversized legitimate CLI input can now be rejected. The audit remains enabled and reports the unresolved upstream Zod version advisory; no ignore/exception or fabricated version is used.

The `.yarn/patches` mitigations are development-workspace patches, not additions to the public mobile production graph. Tests exercise their actual resolved import paths. Yarn's native audit can omit patched locators, so `security:audit` also queries the registry for their actual upstream name/version and fails on remaining high advisories. It does not treat a patch as an advisory suppression. Parent security/release review remains required.
