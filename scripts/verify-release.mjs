import { readFileSync } from 'node:fs';
import process from 'node:process';

const tag = (process.argv[2] ?? process.env.GITHUB_REF_NAME ?? '').trim();
const packageJson = JSON.parse(readFileSync('package.json', 'utf8'));
const changelog = readFileSync('CHANGELOG.md', 'utf8');
const constants = readFileSync('src/core/constants.ts', 'utf8');
const expectedTag = `v${packageJson.version}`;

if (!/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(tag)) {
  fail(`Release tag must be semantic versioned; received ${tag || '<empty>'}.`);
}

if (tag !== expectedTag) {
  fail(
    `Release tag ${tag} does not match package version ${packageJson.version}.`
  );
}

if (!changelog.includes(`## [${packageJson.version}]`)) {
  fail(`CHANGELOG.md has no section for ${packageJson.version}.`);
}

if (!constants.includes(`SDK_VERSION = '${packageJson.version}'`)) {
  fail(`SDK_VERSION does not match package version ${packageJson.version}.`);
}

if (packageJson.private === true) {
  fail('package.json is marked private and cannot be published.');
}

process.stdout.write(`Release metadata is consistent for ${expectedTag}.\n`);

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}
