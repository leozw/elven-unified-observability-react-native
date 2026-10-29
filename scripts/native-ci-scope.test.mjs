import assert from 'node:assert/strict';
import { nativeScope } from './native-ci-scope.mjs';
assert.deepEqual(nativeScope(['scripts/prepare-native-http-probe.mjs']), {
  'ios': false,
  'android': false,
  'android-fixture': true,
});
assert.equal(nativeScope(['.github/workflows/ci.yml']).ios, true);
for (const file of [
  'src/sdk.ts',
  'src/native/bridge.ts',
  'yarn.lock',
  'package.json',
  'scripts/fixtures/bare-App.tsx',
  'scripts/native-ci-scope.mjs',
  'example/package.json',
]) {
  const scope = nativeScope([file]);
  assert.equal(scope.ios, true, file);
  assert.equal(scope.android, true, file);
}
assert.equal(nativeScope(['ios/ElvenHttpTransport.mm']).ios, true);
assert.equal(nativeScope(['android/consumer-rules.pro']).android, true);
assert.deepEqual(nativeScope(['README.md', 'docs/SAFETY.md']), {
  'ios': false,
  'android': false,
  'android-fixture': false,
});
console.log(
  'Native scope classifier PASS; skipped builds still require preserved-input review.'
);
