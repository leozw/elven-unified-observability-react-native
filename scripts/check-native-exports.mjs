import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const specText = await readFile(
  'src/NativeElvenUnifiedObservabilityReactNative.ts',
  'utf8'
);
const spec = ts.createSourceFile(
  'spec.ts',
  specText,
  ts.ScriptTarget.Latest,
  true
);
const methods = spec.statements
  .filter(ts.isInterfaceDeclaration)
  .find((node) => node.name.text === 'Spec')
  .members.filter(ts.isMethodSignature)
  .map((node) => node.name.getText(spec));
const implementation = await readFile(
  'ios/ElvenUnifiedObservabilityReactNative.mm',
  'utf8'
);
const exported = [
  ...implementation.matchAll(/^RCT_EXPORT_METHOD\((\w+)/gm),
].map((match) => match[1]);
assert.deepEqual(
  exported.toSorted(),
  methods.toSorted(),
  'All Turbo spec methods also need Legacy iOS bridge exports.'
);
assert.match(
  implementation,
  /getTurboModule:/,
  'Turbo binding must remain available.'
);
console.log(
  JSON.stringify({
    methods: methods.length,
    legacyExports: exported.length,
    turboBindingRetained: true,
    scope:
      'Static source contract only; fresh Legacy/Turbo native build/runtime proof is separate.',
  })
);
