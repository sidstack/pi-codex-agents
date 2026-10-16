# Releasing

The project is published as `pi-codex-agents` on npm and `sidstack/pi-codex-agents`
on GitHub. Releases use semver. Stable releases publish with npm's `latest` tag;
prereleases use `beta`.

## Prepare a release

1. Update `package.json`, `package-lock.json`, `CHANGELOG.md`, and installation
   instructions together.
2. Run `npm run release:check` and `npm audit`. Review `npm pack --dry-run` to
   confirm that the archive contains compiled modules, license, and docs, without
   credentials, histories, or checkout dependencies.
3. Rebuild and commit generated `dist/` with the source changes.
4. Create a matching `vVERSION` tag on the reviewed commit. The publish guard
   requires a clean tree and exact matching tag.
5. Push the tag. The protected `npm` GitHub environment requires maintainer review;
   the publish workflow uses npm trusted publishing and provenance.

For the first npm release, npm requires the package to exist before trusted
publishing can be configured. Publish the reviewed tag interactively with
`npm publish` from a clean checkout of that tag and complete npm's 2FA prompt.
Then configure the repository and `npm` environment as a trusted publisher in
the package settings. Later releases can use the GitHub Actions workflow and
provenance without a long-lived npm token.

GitHub Actions checks builds, typechecks, tests, native integration, fresh-install
behavior, generated output, and dependency audit on pull requests and pushes.

## Install

```sh
pi install npm:pi-codex-agents@latest
```

Or install a release directly from GitHub:

```sh
pi install git:github.com/sidstack/pi-codex-agents@v1.0.0
```

Reload Pi after installation. Uninstall with `pi remove` using the same source
spec; stop the host first. Uninstalling the package keeps native session histories
and app state, allowing later reinstallation.
