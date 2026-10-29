#!/usr/bin/env bash
set -Eeuo pipefail

device_id="$(xcrun simctl list devices available --json | node -e 'let s="";process.stdin.on("data",x=>s+=x);process.stdin.on("end",()=>{const d=Object.entries(JSON.parse(s).devices).filter(([k])=>k.includes("iOS")).flatMap(([,v])=>v).find(x=>x.isAvailable);if(!d)process.exit(1);process.stdout.write(d.udid)})')"
if ! xcrun simctl list devices booted | grep -Fq "$device_id"; then
  xcrun simctl boot "$device_id"
fi
xcrun simctl bootstatus "$device_id" -b
sdk="$(xcrun --sdk iphonesimulator --show-sdk-path)"
arch="$(uname -m)"
mkdir -p artifacts/ios-lifecycle
xcrun --sdk iphonesimulator clang++ -fobjc-arc -isysroot "$sdk" -target "$arch-apple-ios15.1-simulator" \
  -framework Foundation -framework UIKit -framework QuartzCore -framework MetricKit \
  ios/ElvenNativeRuntime.mm scripts/ios-lifecycle-probe.mm -o artifacts/ios-lifecycle/probe
xcrun simctl spawn "$device_id" "$(pwd)/artifacts/ios-lifecycle/probe"
