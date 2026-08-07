# Alpha Release Process

The npm package, source directory, parent skill, runtime data directory, protocol namespaces, profile paths, and release tags all use `pi-agents-flow`. This Alpha does not migrate data written under earlier project names.

1. Update `CHANGELOG.md` under `Unreleased` and confirm `SUPPORT.md` matches the tested matrix.
2. Run:

```bash
npm ci --ignore-scripts
npm run test:unit
npm run test:integration
npm run test:e2e
npm run smoke:pack
npm audit --omit=dev
npm pack --dry-run --json
```

3. Confirm the version is an Alpha prerelease such as `0.1.0-alpha.1`, the lockfile matches, and the tarball includes all README-linked docs and images.
4. Commit only intended package and root CI files. Create an annotated tag such as `pi-agents-flow-v0.1.0-alpha.1` and a GitHub prerelease with the changelog excerpt.
5. Publish from the tag with npm trusted publishing or:

```bash
npm publish --provenance --tag alpha
```

Never publish with the `latest` tag during Alpha. Verify `npm view pi-agents-flow dist-tags versions` and install the exact published version in a clean directory.

If publication partially fails, inspect npm before retrying. Do not reuse a version already visible on npm. Deprecate a broken release with an explanatory message and publish a new prerelease version.
