#!/usr/bin/env bash
set -Eeuo pipefail
app="$(find "${1:?Pass the downloaded simulator artifact directory}" -type d -name '*.app' -print -quit)"
test -n "${app}"
bundle_id="$(/usr/libexec/PlistBuddy -c 'Print CFBundleIdentifier' "${app}/Info.plist")"
simulator="$(xcrun simctl list devices available --json | node --input-type=module -e 'let s="";for await(const c of process.stdin)s+=c;const d=Object.values(JSON.parse(s).devices).flat().find(x=>x.isAvailable&&x.name.includes("iPhone"));if(!d)process.exit(1);console.log(d.udid);')"
node scripts/native-http-collector.mjs > native-http-collector.log 2>&1 &
collector_pid=$!
cleanup() {
  xcrun simctl terminate "${simulator}" "${bundle_id}" >/dev/null 2>&1 || true
  kill "${collector_pid}" 2>/dev/null || true
  wait "${collector_pid}" 2>/dev/null || true
}
trap cleanup EXIT
xcrun simctl boot "${simulator}" || true
xcrun simctl bootstatus "${simulator}" -b
xcrun simctl install "${simulator}" "${app}"
xcrun simctl launch "${simulator}" "${bundle_id}"
for _attempt in $(seq 1 60); do
  stats="$(curl --fail --silent http://127.0.0.1:4319/stats || true)"
  if printf '%s' "${stats}" | node --input-type=module -e 'let s="";for await(const c of process.stdin)s+=c;process.exit(JSON.parse(s||"{}").proof==="8388608"?0:1);'; then
    printf '%s\n' "${stats}"
    echo 'ELVEN_IOS_NATIVE_HTTP_8MIB_BOUNDED_RETRY_ABORT_OK'
    exit 0
  fi
  sleep 2
done
cat native-http-collector.log
xcrun simctl spawn "${simulator}" log show --last 3m --predicate 'process == "ElvenRn079Validation"' || true
exit 1
