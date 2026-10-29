import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';

const example = createRequire(
  new URL('../example/package.json', import.meta.url)
);
const plist = createRequire(example.resolve('@expo/plist/package.json'));
const { DOMParser, XMLSerializer } = plist('@xmldom/xmldom');

const root = process.argv[2];
if (!root) throw new Error('Pass the isolated generated consumer directory.');
const main = path.join(root, 'android/app/src/main');
const manifestPath = path.join(main, 'AndroidManifest.xml');
const document = new DOMParser().parseFromString(
  await readFile(manifestPath, 'utf8'),
  'application/xml'
);
const application = document.getElementsByTagName('application').item(0);
if (!application)
  throw new Error('Generated consumer has no application manifest.');
application.setAttributeNS(
  'http://schemas.android.com/apk/res/android',
  'android:networkSecurityConfig',
  '@xml/elven_probe_network_security'
);
await writeFile(manifestPath, new XMLSerializer().serializeToString(document));
await mkdir(path.join(main, 'res/xml'), { recursive: true });
// Only the isolated emulator's loopback fake collector is cleartext. TLS remains required elsewhere.
await writeFile(
  path.join(main, 'res/xml/elven_probe_network_security.xml'),
  '<network-security-config><base-config cleartextTrafficPermitted="false"/><domain-config cleartextTrafficPermitted="true"><domain>127.0.0.1</domain></domain-config></network-security-config>'
);
const applications = (
  await readdir(path.join(main, 'java'), { recursive: true })
).filter((name) => name.endsWith('MainApplication.kt'));
if (applications.length !== 1)
  throw new Error('Expected one isolated Kotlin MainApplication.');
const applicationPath = path.join(main, 'java', applications[0]);
const source = await readFile(applicationPath, 'utf8');
const marker = 'super.onCreate()';
if (!source.includes(marker))
  throw new Error('Unknown generated MainApplication lifecycle.');
await writeFile(
  applicationPath,
  source.replace(
    marker,
    `${marker}
    com.facebook.react.modules.network.NetworkingModule.setCustomClientBuilder(
      com.facebook.react.modules.network.CustomClientBuilder { builder ->
        builder.addInterceptor { chain ->
          chain.proceed(chain.request().newBuilder().header("X-Elven-Probe-Hook", "preserved").build())
        }
      }
    )`
  )
);
const consumer = JSON.parse(
  await readFile(
    path.join(root, 'node_modules/react-native/package.json'),
    'utf8'
  )
);
const properties = await readFile(
  path.join(root, 'android/gradle.properties'),
  'utf8'
);
if (
  consumer.version === '0.79.2' &&
  properties.includes('newArchEnabled=false')
) {
  const gradlePath = path.join(root, 'android/app/build.gradle');
  const gradle = await readFile(gradlePath, 'utf8');
  const before = 'def enableProguardInReleaseBuilds = false';
  if (!gradle.includes(before))
    throw new Error('Unknown minification setting in isolated consumer.');
  await writeFile(
    gradlePath,
    gradle.replace(before, 'def enableProguardInReleaseBuilds = true')
  );
}
