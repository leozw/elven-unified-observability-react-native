const fs = require('node:fs/promises');
const path = require('node:path');

const {
  AndroidConfig,
  withAndroidManifest,
  withDangerousMod,
} = require('expo/config-plugins');

const RESOURCE_NAME = 'elven_local_collector_network_security';
const RESOURCE_CONTENT = `<?xml version="1.0" encoding="utf-8"?>
<network-security-config>
  <base-config cleartextTrafficPermitted="false" />
  <domain-config cleartextTrafficPermitted="true">
    <domain includeSubdomains="false">10.0.2.2</domain>
    <domain includeSubdomains="false">localhost</domain>
  </domain-config>
</network-security-config>
`;

function withLocalCollectorManifest(config) {
  return withAndroidManifest(config, (manifestConfig) => {
    const application = AndroidConfig.Manifest.getMainApplicationOrThrow(
      manifestConfig.modResults
    );
    application.$['android:networkSecurityConfig'] = `@xml/${RESOURCE_NAME}`;
    return manifestConfig;
  });
}

function withLocalCollectorResource(config) {
  return withDangerousMod(config, [
    'android',
    async (resourceConfig) => {
      const resourceDirectory = path.join(
        resourceConfig.modRequest.platformProjectRoot,
        'app',
        'src',
        'main',
        'res',
        'xml'
      );
      await fs.mkdir(resourceDirectory, { recursive: true });
      await fs.writeFile(
        path.join(resourceDirectory, `${RESOURCE_NAME}.xml`),
        RESOURCE_CONTENT,
        'utf8'
      );
      return resourceConfig;
    },
  ]);
}

module.exports = function withLocalCollectorNetworkSecurity(config) {
  return withLocalCollectorResource(withLocalCollectorManifest(config));
};
