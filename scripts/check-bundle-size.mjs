import { mkdir, writeFile } from 'node:fs/promises';
import { brotliCompressSync, gzipSync } from 'node:zlib';
import { join } from 'node:path';
import { build } from 'esbuild';

const root = process.cwd();
const artifacts = join(root, 'artifacts');
const bundlePath = join(artifacts, 'elven-observability.production.js');
const resultsPath = join(artifacts, 'bundle-size.json');
const budgets = {
  rawBytes: 320 * 1024,
  gzipBytes: 85 * 1024,
  brotliBytes: 75 * 1024,
};

async function main() {
  await mkdir(artifacts, { recursive: true });
  const result = await build({
    absWorkingDir: root,
    bundle: true,
    conditions: ['react-native', 'import', 'default'],
    define: { __DEV__: 'false' },
    entryPoints: ['src/index.ts'],
    external: ['react-native'],
    format: 'esm',
    legalComments: 'none',
    mainFields: ['react-native', 'browser', 'module', 'main'],
    metafile: true,
    minify: true,
    outfile: bundlePath,
    platform: 'browser',
    sourcemap: false,
    target: ['es2022'],
    treeShaking: true,
    write: false,
  });

  const output = result.outputFiles?.[0]?.contents;
  if (!output) throw new Error('esbuild did not produce a JavaScript bundle.');
  await writeFile(bundlePath, output);

  const measurements = {
    rawBytes: output.byteLength,
    gzipBytes: gzipSync(output, { level: 9 }).byteLength,
    brotliBytes: brotliCompressSync(output).byteLength,
  };
  const outputMetadata = Object.values(result.metafile.outputs)[0];
  const contributors = Object.entries(outputMetadata?.inputs ?? {})
    .map(([path, value]) => ({ path, bytes: value.bytesInOutput }))
    .sort((left, right) => right.bytes - left.bytes)
    .slice(0, 10);
  const failures = Object.entries(budgets)
    .filter(([name, budget]) => measurements[name] > budget)
    .map(
      ([name, budget]) =>
        `${name}: ${measurements[name]} exceeds ${budget} bytes`
    );
  const report = {
    generatedAt: new Date().toISOString(),
    budgets,
    measurements,
    contributors,
    passed: failures.length === 0,
    failures,
    scope:
      'Minified ESM SDK bundle excluding React Native itself; Metro/Hermes output varies by host app.',
  };

  await writeFile(resultsPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (failures.length > 0) process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(
    `[bundle-size] ${error instanceof Error ? error.stack : String(error)}\n`
  );
  process.exitCode = 1;
});
