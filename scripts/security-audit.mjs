import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const native = spawnSync(
  process.execPath,
  [
    '.yarn/releases/yarn-4.11.0.cjs',
    'npm',
    'audit',
    '--all',
    '--recursive',
    '--severity',
    'high',
  ],
  { encoding: 'utf8', maxBuffer: 10_000_000 }
);
process.stdout.write(native.stdout ?? '');
process.stderr.write(native.stderr ?? '');
try {
  const example = createRequire(resolve('example/package.json'));
  const cli = createRequire(example.resolve('@expo/cli/package.json'));
  const manifest = JSON.parse(readFileSync('package.json', 'utf8'));
  const packages = {};
  for (const [descriptor, source] of Object.entries(
    manifest.resolutions ?? {}
  )) {
    if (typeof source !== 'string' || !source.startsWith('patch:')) continue;
    const separator = descriptor.lastIndexOf('@npm:');
    if (separator < 1)
      throw new Error(`Unsupported patched descriptor: ${descriptor}`);
    const name = descriptor.slice(0, separator);
    const metadata = JSON.parse(
      readFileSync(cli.resolve(`${name}/package.json`), 'utf8')
    );
    packages[metadata.name] = [metadata.version];
  }
  const response = await fetch(
    'https://registry.npmjs.org/-/npm/v1/security/advisories/bulk',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(packages),
      signal: AbortSignal.timeout(15000),
    }
  );
  if (!response.ok)
    throw new Error(`Patched upstream audit returned HTTP ${response.status}`);
  const advisories = await response.json();
  const high = Object.values(advisories)
    .flat()
    .filter((x) => x.severity === 'high' || x.severity === 'critical');
  console.log(
    JSON.stringify({
      source: 'npm registry bulk, patched locators unwrapped',
      fetchedAt: new Date().toISOString(),
      packages,
      advisories,
      remainingHigh: high.length,
      suppressed: false,
    })
  );
  process.exitCode = native.status !== 0 || high.length > 0 ? 1 : 0;
} catch (error) {
  console.error(
    `Patched upstream audit unavailable: ${error instanceof Error ? error.message : String(error)}`
  );
  process.exitCode = 1;
}
