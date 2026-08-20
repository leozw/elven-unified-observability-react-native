import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const dryRun = process.argv.includes('--dry-run');
const packageJson = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8')
);
const packageSpec = `${packageJson.name}@${packageJson.version}`;
const packDirectory = mkdtempSync(join(tmpdir(), 'elven-release-pack-'));

try {
  publishOrVerify();
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`
  );
  process.exitCode = 1;
} finally {
  rmSync(packDirectory, { recursive: true, force: true });
}

function publishOrVerify() {
  const packResult = readJsonCommand('npm', [
    'pack',
    '--ignore-scripts',
    '--json',
    '--pack-destination',
    packDirectory,
  ]);
  const localIntegrity = packResult[0]?.integrity;
  if (typeof localIntegrity !== 'string') {
    fail('npm pack did not return a dist integrity value.');
  }

  const remote = spawnSync(
    'npm',
    ['view', packageSpec, 'dist.integrity', '--json'],
    { encoding: 'utf8' }
  );

  if (remote.status === 0) {
    const remoteIntegrity = JSON.parse(remote.stdout);
    if (remoteIntegrity !== localIntegrity) {
      fail(
        `${packageSpec} already exists with different integrity: ` +
          `${remoteIntegrity} != ${localIntegrity}.`
      );
    }
    process.stdout.write(
      `${packageSpec} already exists and matches ${localIntegrity}.\n`
    );
    return;
  }

  if (!remote.stderr.includes('E404')) {
    process.stderr.write(remote.stderr);
    fail(`Unable to query ${packageSpec} before publication.`);
  }

  if (dryRun) {
    process.stdout.write(`${packageSpec} is absent and would be published.\n`);
    return;
  }

  const publication = spawnSync('npm', ['publish', '--access', 'public'], {
    encoding: 'utf8',
    stdio: 'inherit',
  });
  if (publication.status !== 0) {
    fail(`npm publish failed for ${packageSpec}.`);
  }
}

function readJsonCommand(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  if (result.status !== 0) {
    process.stderr.write(result.stderr);
    fail(`${command} ${args.join(' ')} failed.`);
  }
  try {
    return JSON.parse(result.stdout);
  } catch {
    fail(`${command} returned invalid JSON.`);
  }
}

function fail(message) {
  throw new Error(message);
}
