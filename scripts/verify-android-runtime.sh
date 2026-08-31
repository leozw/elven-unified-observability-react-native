#!/usr/bin/env bash

set -Eeuo pipefail

readonly apk_path="${1:-runtime-apk/app-release.apk}"
readonly package_name="com.elvenrn079validation"
readonly expected_status="Elven native bridge ready"
readonly window_dump="/sdcard/elven-window.xml"

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
adb install -r "${apk_path}"
adb logcat -c
adb shell am force-stop "${package_name}"
adb shell monkey -p "${package_name}" -c android.intent.category.LAUNCHER 1

for _attempt in $(seq 1 60); do
  adb shell uiautomator dump "${window_dump}" >/dev/null 2>&1 || true
  window_xml="$(adb shell cat "${window_dump}" 2>/dev/null || true)"

  if grep -Fq "${expected_status}" <<<"${window_xml}"; then
    echo "React Native 0.79.2 Legacy native bridge is ready."
    exit 0
  fi

  sleep 2
done

show_diagnostics
exit 1
