import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';

export function nativeScope(files) {
  const shared = files.some((file) =>
    /^(src\/|cpp\/|example\/|package\.json$|yarn\.lock$|\.nvmrc$|\.yarn\/|babel\.config\.|tsconfig|scripts\/(fixtures\/bare-App\.tsx$|native-ci-scope|native-http-collector)|\.github\/actions\/setup\/)/.test(
      file
    )
  );
  const buildWorkflow = files.some((file) =>
    file.startsWith('.github/workflows/')
  );
  return {
    'ios':
      shared ||
      buildWorkflow ||
      files.some((file) =>
        /^(ios\/|.*\.podspec$|scripts\/(verify-ios|ios-lifecycle))/.test(file)
      ),
    'android':
      shared ||
      buildWorkflow ||
      files.some((file) => file.startsWith('android/')),
    'android-fixture': files.some((file) =>
      /scripts\/(prepare-native-http-probe|verify-android-runtime|native-http-collector)/.test(
        file
      )
    ),
  };
}

if (process.argv[1]?.endsWith('native-ci-scope.mjs')) {
  let files;
  try {
    const base = process.env.SCOPE_BASE;
    const head = process.env.SCOPE_HEAD;
    if (
      !/^[a-f0-9]{40}$/.test(base ?? '') ||
      !/^[a-f0-9]{40}$/.test(head ?? '')
    )
      throw new Error('No prior source');
    files = execFileSync('git', ['diff', '--name-only', base, head], {
      encoding: 'utf8',
    })
      .trim()
      .split('\n')
      .filter(Boolean);
  } catch {
    files = ['src/unknown-input'];
  }
  const scope = nativeScope(files);
  console.log(
    JSON.stringify({
      base: process.env.SCOPE_BASE,
      head: process.env.SCOPE_HEAD,
      files,
      scope,
      limitation:
        'Skipped native lanes are not a green exact-head build. Parent must compare preserved input hashes and original job/artifact provenance.',
    })
  );
  if (process.env.GITHUB_OUTPUT)
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      Object.entries(scope)
        .map(([key, value]) => `${key}=${value}`)
        .join('\n') + '\n'
    );
}
