import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

const source = '4478c5e53d367efd64c11bbde89f6a5d9add045d';
const id = 12930457127;
const expectedDigest =
  'sha256:5835cdd93e7c1f108b41fb306142439fc739220b2624b97e9eb8a3206b6ffc0b';
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
  'Compiled iOS consumer/SDK inputs changed: a fresh native build is required.'
);
if (process.argv[2] === '--inputs-only') {
  console.log('Compiled inputs match the pinned iOS binary source.');
  process.exit(0);
}
// Official GitHub action supplies metadata using its opaque read-only job identity.
// No SDK, registry or human credential is read here.
const url = `https://api.github.com/repos/leozw/elven-unified-observability-react-native/actions/artifacts/${id}`;
assert.ok(process.argv[2], 'Artifact metadata file is required.');
const artifact = JSON.parse(await readFile(process.argv[2], 'utf8'));
assert.equal(artifact.id, id);
assert.equal(artifact.name, 'bare-rn-0792-legacy-ios-release-simulator');
assert.equal(artifact.expired, false);
assert.equal(artifact.digest, expectedDigest);
assert.equal(artifact.workflow_run.head_sha, source);
assert.equal(artifact.workflow_run.id, 40945422501);
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
      metadataUrl: url,
      artifact,
    },
    null,
    2
  )
);
console.log(
  'Pinned iOS artifact/source/digest and identical compiled inputs verified.'
);
