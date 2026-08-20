# Releasing

The package follows Semantic Versioning and publishes to npm with provenance.

## Release gates

1. Update `CHANGELOG.md`, compatibility evidence, and version constants.
2. Run `yarn install --immutable` from a clean checkout.
3. Run `yarn validate`.
4. Run Expo prebuild and Android/iOS release builds.
5. Complete the runtime and end-to-end gates in `VALIDATION.md` required for the claimed support level.
6. Inspect `npm pack --dry-run` and the actual tarball contents; scan for secrets and generated development files.
7. Create an annotated `vX.Y.Z` tag from the reviewed commit.
8. Let the protected GitHub release workflow publish with npm trusted publishing/provenance.
9. Verify `npm view elven-unified-observability-react-native@X.Y.Z version dist.integrity` and install the public tarball in a fresh consumer.

Do not publish from a dirty worktree, with `--ignore-scripts`, by weakening gates, or with a reusable npm token committed to repository settings. A failed platform or end-to-end gate remains explicit; it cannot be converted into a support claim by successful publication.

## Version synchronization

The following values must match:

- `package.json` version;
- `src/core/constants.ts` `SDK_VERSION`;
- Git tag;
- `CHANGELOG.md` release heading.

The podspec reads `package.json` automatically.

## First-package bootstrap

npm accepts a trusted-publisher configuration only after the package name exists. Bootstrap a new package without sacrificing provenance on the first stable version:

1. Authenticate an npm package owner interactively with 2FA.
2. Create an isolated detached worktree from the reviewed release commit and temporarily set both the package and SDK versions to an administrative prerelease such as `0.0.0-bootstrap.0`.
3. Run the complete validation and publish that inspected payload with the non-default `bootstrap` dist-tag and provenance disabled. Never assign `latest` to the bootstrap version.
4. Configure `leozw/elven-unified-observability-react-native` with repository `leozw/elven-unified-observability-react-native`, workflow `release.yml`, and publish permission as its GitHub trusted publisher.
5. Push the reviewed stable tag and let the protected release workflow publish through GitHub OIDC with automatic provenance.
6. Verify the public stable tarball and provenance, then remove the administrative bootstrap version and confirm that `latest` still resolves to the stable release.

Do not commit the temporary bootstrap version, reuse its worktree, retain a publish token, or publish the stable version from a workstation. `scripts/publish-or-verify.mjs` accepts an existing stable version only when its registry integrity exactly matches the locally packed release; otherwise it fails closed. All stable versions are published by GitHub OIDC with automatic provenance.

Reference: [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/).
