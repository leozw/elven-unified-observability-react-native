#!/usr/bin/env bash
set -Eeuo pipefail
app="$(find "${1:?Pass the downloaded simulator artifact directory}" -type d -name '*.app' -print -quit)"
test -n "${app}"
bundle_id="$(/usr/libexec/PlistBuddy -c 'Print CFBundleIdentifier' "${app}/Info.plist")"
executable="$(/usr/libexec/PlistBuddy -c 'Print CFBundleExecutable' "${app}/Info.plist")"
simulator="$(xcrun simctl list devices available --json | node --input-type=module -e 'let s="";for await(const c of process.stdin)s+=c;const d=Object.values(JSON.parse(s).devices).flat().find(x=>x.isAvailable&&x.name.includes("iPhone"));if(!d)process.exit(1);console.log(d.udid);')"
collector_pid=''
cleanup() {
  xcrun simctl terminate "${simulator}" "${bundle_id}" >/dev/null 2>&1 || true
  if [[ -n "${collector_pid}" ]]; then
    kill "${collector_pid}" 2>/dev/null || true
    wait "${collector_pid}" 2>/dev/null || true
  fi
}
trap cleanup EXIT
xcrun simctl boot "${simulator}" || true
xcrun simctl bootstatus "${simulator}" -b
xcrun simctl install "${simulator}" "${app}"
# Start the bounded collector after slow simulator migration/install, not before it.
node scripts/native-http-collector.mjs > native-http-collector.log 2>&1 &
collector_pid=$!
for _attempt in $(seq 1 30); do
  if curl --fail --silent --max-time 2 http://127.0.0.1:4319/stats >/dev/null; then break; fi
  sleep 0.1
done
xcrun simctl launch "${simulator}" "${bundle_id}"
for _attempt in $(seq 1 60); do
  stats="$(curl --fail --silent --max-time 2 http://127.0.0.1:4319/stats || true)"
  if printf '%s' "${stats}" | node --input-type=module -e 'let s="";for await(const c of process.stdin)s+=c;process.exit(JSON.parse(s||"{}").proof==="8388608"?0:1);'; then
    printf '%s\n' "${stats}" > native-http-stats.json
    printf '%s\n' "${stats}"
    echo 'ELVEN_IOS_NATIVE_HTTP_8MIB_BOUNDED_RETRY_ABORT_OK'
    exit 0
  fi
  sleep 2
done
curl --fail --silent --max-time 2 http://127.0.0.1:4319/stats > native-http-stats.json || true
xcrun simctl io "${simulator}" screenshot native-http-probe.png || true
cat native-http-collector.log
xcrun simctl spawn "${simulator}" log show --last 3m --predicate "process == \"${executable}\"" || true
exit 1
