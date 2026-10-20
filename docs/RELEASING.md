# Releasing

The project is published as `pi-codex-agents` on npm and `sidstack/pi-codex-agents`
on GitHub. Releases are automated with semantic-release. Do not bump `package.json`
by hand, create `v*` tags, or run `npm publish` for a normal release.

## What triggers a release

Commits must follow Conventional Commits, because semantic-release derives the
version and the release notes from commit headers:

- `feat:` is a minor release, `fix:` is a patch, `feat!:`/`fix!:` or a
  `BREAKING CHANGE:` footer is a major.
- `docs:`, `chore:`, `test:`, `refactor:`, `perf:` and `style:` are analysed but
  release nothing, so a run that finds only those commits ends with exit code 0
  and no tag.
- A squash-merged pull request needs a conventional subject line; the merge
  commit header itself is ignored and the merged commits are analysed.

`main` publishes stable versions to the npm `latest` tag and creates a matching
`vVERSION` tag plus a GitHub release. `feat/**`, `fix/**` and `chore/**` publish
pre-releases as `1.2.0-feat-launch-picker-beta.1`, incrementing the last number on
each releasable push, published to a per-branch npm dist-tag
(`beta-feat-launch-picker`). A branch build never touches `latest`.

Install a branch build with:

```sh
pi install npm:pi-codex-agents@beta-feat-launch-picker
```

Branch names must stay `type/name` with single-level kebab-case names using letters,
digits and hyphens only. The name is embedded in the pre-release identifier, so
`feat/ab.c` and `feat/ab-c` would collide. semantic-release detects that before
publishing anything and fails the job with `EPRERELEASEBRANCHES` rather than
inventing a version; rename the branch to fix it.

## How a release run works

`.github/workflows/publish.yml` runs on pushes to `main` and to those three branch
families, and can still be dispatched manually. The `check` job runs
`npm run release:check`, verifies that committed `dist/` matches a fresh build, and
audits the shipped dependency surface. Only then the `release` job, bound to the
protected `npm` GitHub environment, runs `semantic-release`, which writes the new
version to `package.json` and `package-lock.json`, prepends generated notes to
`CHANGELOG.md`, rebuilds `dist/`, commits and tags all of it, publishes to npm with
trusted publishing and provenance, and opens the GitHub release.

`prepublishOnly` asserts release identity: a clean tree, a repository URL that is
set, `dist/build.json` at the published version, and HEAD tagged as `vVERSION`.
semantic-release creates that tag before it publishes, so the same assertion holds
for automated and interactive publishes. The automated run sets
`PI_AUTOMATED_PUBLISH=true` because the `check` job already ran the full
`release:check` gate on the same commit; an interactive publish reruns that gate.

The workflow keeps its exact filename and the `npm` environment because npm's
trusted publisher configuration is bound to the repository, the workflow filename,
and the environment name. The release commit and tag are pushed with the standard
`GITHUB_TOKEN`, and GitHub does not start workflow runs for events caused by that
token, so releases cannot trigger themselves.

The dependency audit gate uses `npm audit --omit=dev`. The release toolchain depends
on `micromatch`, which depends on `braces`; `braces` has an open high-severity
advisory (GHSA-vfj7-8cjw-p6xm, deeply nested brace patterns overflow the stack) with
no published fix, and devDependencies are not part of the published archive.

## First automated release

History before this automation is not conventional, so nothing is released
retroactively: the last release semantic-release finds is `v1.0.1` and the existing
`v1.1.0-beta.*` tags are treated as already released. The conventional commit that
introduces the automation is therefore the first release and produces `1.1.0`.

## Verify a release locally

On a throwaway branch, without publishing anything:

```sh
npx --no-install semantic-release --dry-run --no-ci
```

It prints the version, the npm channel, and the assets it would commit. Review
`npm pack --dry-run` separately to confirm the archive contains compiled modules,
license, and docs, without credentials, histories, or checkout dependencies.

## Install

```sh
pi install npm:pi-codex-agents@latest
```

Or install a release directly from GitHub:

```sh
pi install git:github.com/sidstack/pi-codex-agents@v1.1.0
```

Reload Pi after installation. Uninstall with `pi remove` using the same source
spec; stop the host first. Uninstalling the package keeps native session histories
and app state, allowing later reinstallation.
