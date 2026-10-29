#!/usr/bin/env bash

set -Eeuo pipefail

readonly apk_path="${1:-runtime-apk/app-release.apk}"
readonly package_name="com.elvenrn079validation"
readonly expected_status="Elven native bridge ready"
readonly window_dump="/sdcard/elven-window.xml"
node scripts/native-http-collector.mjs > native-http-collector.log 2>&1 &
collector_pid=$!
cleanup() {
  adb reverse --remove tcp:4319 >/dev/null 2>&1 || true
  kill "${collector_pid}" 2>/dev/null || true
  wait "${collector_pid}" 2>/dev/null || true
}
trap cleanup EXIT

show_diagnostics() {
  echo "Expected status was not found: ${expected_status}" >&2
  adb shell cat "${window_dump}" 2>/dev/null || true
  adb logcat -d -t 1000 || true
}

if [[ ! -f "${apk_path}" ]]; then
  echo "Release APK not found: ${apk_path}" >&2
  exit 1
fi

adb wait-for-device
if [[ "$(adb shell getprop ro.kernel.qemu | tr -d '\r')" != "1" ]]; then
  echo "This storage regression probe is restricted to an Android emulator." >&2
  exit 1
fi
adb root
adb wait-for-device
adb reverse tcp:4319 tcp:4319
adb install -r "${apk_path}"
adb logcat -c
adb shell am force-stop "${package_name}"
readonly private_dir="/data/user/0/${package_name}/no_backup"
app_uid="$(adb shell cmd package list packages -U "${package_name}" | sed -n 's/.* uid:\([0-9]*\).*/\1/p' | tr -d '\r')"
if [[ ! "${app_uid}" =~ ^[0-9]+$ ]]; then
  echo "Could not resolve the isolated test application UID." >&2
  exit 1
fi
adb shell mkdir -p "${private_dir}"
adb shell chown "${app_uid}:${app_uid}" "${private_dir}"
for base in elven-observability-queue-v1.json elven-observability-native-crash-v1.json; do
  for suffix in '' .bak .new; do
    adb shell touch "${private_dir}/${base}${suffix}"
    adb shell chown "${app_uid}:${app_uid}" "${private_dir}/${base}${suffix}"
  done
done
adb shell restorecon -R "${private_dir}"
adb shell monkey -p "${package_name}" -c android.intent.category.LAUNCHER 1

for _attempt in $(seq 1 60); do
  adb shell uiautomator dump "${window_dump}" >/dev/null 2>&1 || true
  window_xml="$(adb shell cat "${window_dump}" 2>/dev/null || true)"

  if grep -Fq "${expected_status}" <<<"${window_xml}"; then
    grep -Fq 'HTTP8MiB:8388608 bounded+retry+abort+app-ok' <<<"${window_xml}"
    curl --fail --silent http://127.0.0.1:4319/stats
    curl --fail --silent http://127.0.0.1:4319/stats | node --input-type=module -e 'let s="";for await(const c of process.stdin)s+=c;const p=JSON.parse(s);if(!p.hooks["/bounded/v1/logs"]||!p.hooks["/app-health"])process.exit(1);'
    for base in elven-observability-queue-v1.json elven-observability-native-crash-v1.json; do
      for suffix in '' .bak .new; do
        adb shell test ! -e "${private_dir}/${base}${suffix}"
      done
    done
    echo "React Native 0.79.2 Legacy Hermes lifecycle and cold AtomicFile purge passed."
    echo "ELVEN_ANDROID_NATIVE_HTTP_8MIB_BOUNDED_RETRY_ABORT_OK"
    exit 0
  fi

  sleep 2
done

show_diagnostics
exit 1
