import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { generateKeyPairSync } from 'node:crypto';

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
  /disabled pending an independent signing review/
);
const forge = cli('node-forge');
assert.equal(cli('node-forge/package.json').version, '1.4.2');
const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 1024,
  publicExponent: 3,
});
const key = forge.pki.privateKeyFromPem(
  privateKey.export({ format: 'pem', type: 'pkcs1' })
);
const pub = forge.pki.setRsaPublicKey(key.n, key.e);
const md = forge.md.sha256.create().update('owned defensive fixture');
const digest = md.digest().getBytes();
assert.equal(pub.verify(digest, key.sign(md)), true);
const a = forge.asn1;
const malformed = a.create(a.Class.UNIVERSAL, a.Type.SEQUENCE, true, [
  a.create(a.Class.UNIVERSAL, a.Type.SEQUENCE, true, [
    a.create(
      a.Class.UNIVERSAL,
      a.Type.OID,
      false,
      a.oidToDer(forge.pki.oids.sha256).getBytes()
    ),
    a.create(a.Class.UNIVERSAL, a.Type.NULL, false, ''),
    a.create(a.Class.UNIVERSAL, a.Type.OCTETSTRING, false, 'extra-element'),
  ]),
  a.create(a.Class.UNIVERSAL, a.Type.OCTETSTRING, false, digest),
]);
const malformedSignature = key.sign(a.toDer(malformed).getBytes(), 'NONE');
assert.throws(() => pub.verify(digest, malformedSignature), /DigestInfo/);
console.log(
  JSON.stringify({
    zodVersion: '3.25.76',
    nodeForgeVersion: '1.4.2',
    nestedDigestInfoRejected: true,
    cjsAndEsmArrayBudget: 'PASS',
    expoSigningEntry: 'BLOCKED_AS_INTENDED',
    advisorySuppression: false,
  })
);
