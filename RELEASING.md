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

npm trusted publishing can be configured only after the package exists. For the first version, an npm package owner must authenticate interactively, run the same gates, publish the inspected tarball once, and immediately configure `leozw/elven-unified-observability-react-native` with workflow `release.yml` as its GitHub trusted publisher. Do not commit or retain a reusable token.

After bootstrap, pushing the matching tag runs the complete reusable CI. `scripts/publish-or-verify.mjs` accepts an existing version only when its registry integrity exactly matches the locally packed release; otherwise it fails closed. All later versions are published by GitHub OIDC with automatic provenance.

Reference: [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/).
