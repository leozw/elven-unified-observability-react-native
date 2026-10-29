import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const example = createRequire(resolve('example/package.json'));
const cliRoot = dirname(example.resolve('@expo/cli/package.json'));
const cli = createRequire(join(cliRoot, 'package.json'));
const zodRoot = dirname(cli.resolve('zod/package.json'));
const zodCjs = cli('zod');
const zodEsm = await import(pathToFileURL(join(zodRoot, 'v3/index.js')).href);
assert.equal(cli('zod/package.json').version, '3.25.76');

for (const z of [zodCjs, zodEsm]) {
  assert.deepEqual(z.array(z.string()).parse(['safe', 'input']), [
    'safe',
    'input',
  ]);
  const large = new Array(5000);
  Object.defineProperty(large, '0', {
    get() {
      throw new Error('Oversized input was inspected');
    },
  });
  const result = z.array(z.string()).safeParse(large);
  assert.equal(result.success, false);
  assert.equal(result.error.issues.length, 1);
  const nested = await z
    .array(z.array(z.number()))
    .safeParseAsync(Array.from({ length: 100 }, () => new Array(100).fill(1)));
  assert.equal(nested.success, false);
  assert.ok(nested.error.issues.length <= 100);
}

const signing = cli(join(cliRoot, 'build/src/run/ios/codeSigning/Security.js'));
await assert.rejects(
  signing.getCertificateForSigningIdAsync('not-a-real-identity'),
  /disabled pending a reviewed node-forge fix/
);
console.log(
  JSON.stringify({
    zodVersion: '3.25.76',
    cjsAndEsmArrayBudget: 'PASS',
    expoSigningEntry: 'BLOCKED_AS_INTENDED',
    advisorySuppression: false,
  })
);
