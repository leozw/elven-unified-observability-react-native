import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

const source = '4ef8ee7c8c8721b546e712c7988a4901307a3bf5';
const id = 12936776620;
const digest =
  'sha256:628f41c346d07f70a9c45e754b0dbcfd679a627df8ea28d9ddcd1fa4d53a4fa4';
const inputs = [
  'src',
  'ios',
  'ElvenUnifiedObservabilityReactNative.podspec',
  'package.json',
  'yarn.lock',
  '.yarn',
  '.nvmrc',
  'babel.config.js',
  'babel.config.cjs',
  'tsconfig.json',
  'tsconfig.build.json',
  '.github/workflows/ci.yml',
  '.github/actions/setup',
  'scripts/fixtures/bare-App.tsx',
];
const changed = execFileSync(
  'git',
  ['diff', '--name-only', source, 'HEAD', '--', ...inputs],
  { encoding: 'utf8' }
).trim();
assert.equal(
  changed,
  '',
  'Compiled inputs changed: build a fresh native binary, do not reuse this artifact.'
);
if (process.argv[2] === '--inputs-only') {
  console.log('Compiled inputs match immutable4ef iOS binary.');
  process.exit(0);
}
assert.ok(
  process.argv[2],
  'Official read-only CI artifact metadata file required.'
);
const artifact = JSON.parse(await readFile(process.argv[2], 'utf8'));
assert.equal(artifact.id, id);
assert.equal(artifact.name, 'bare-rn-0792-legacy-ios-release-simulator');
assert.equal(artifact.expired, false);
assert.equal(artifact.digest, digest);
assert.equal(artifact.workflow_run.head_sha, source);
assert.equal(artifact.workflow_run.id, 40959814899);
await mkdir('artifacts', { recursive: true });
await writeFile(
  'artifacts/native-http-artifact-provenance.json',
  JSON.stringify(
    {
      checkedAt: new Date().toISOString(),
      sourceCommit: source,
      driverCommit: execFileSync('git', ['rev-parse', 'HEAD'], {
        encoding: 'utf8',
      }).trim(),
      compiledInputDiff: changed,
      artifact,
    },
    null,
    2
  )
);
console.log(
  'Immutable4ef source, artifact ID/name/digest and compiled inputs verified.'
);
