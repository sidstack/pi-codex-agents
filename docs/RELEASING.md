# Releasing

The project is published as `pi-codex-agents` on npm and `sidstack/pi-codex-agents`
on GitHub. Releases are automated with semantic-release and publish only from the
publish workflow. Do not bump `package.json` by hand, create `v*` tags, or publish
from a workstation: `publishConfig.provenance: true` requires the CI OIDC context
and npm trusted publishing, so an interactive `npm publish` cannot produce a release.

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
`vVERSION` tag plus a GitHub release. Supported release branches publish
pre-releases as `1.2.0-feat-launch-picker-beta.1`, incrementing the last number on
each releasable push, published to a per-branch npm dist-tag
(`beta-feat-launch-picker`). A branch build never touches `latest`.

Install a branch build with:

```sh
pi install npm:pi-codex-agents@beta-feat-launch-picker
```

## Supported branch names and channels

Only these branches release, and the pattern is enforced in `.releaserc.json` with
micromatch extglobs (`feat/+([a-z0-9-])`, `fix/+([a-z0-9-])`,
`chore/+([a-z0-9-])`):

| Branch                | Version                          | npm dist-tag             |
| --------------------- | -------------------------------- | ------------------------ |
| `main`                | `1.2.0`                          | `latest`                 |
| `feat/launch-picker`  | `1.2.0-feat-launch-picker-beta.1`| `beta-feat-launch-picker`|
| `fix/crash-on-open`   | `1.1.1-fix-crash-on-open-beta.1` | `beta-fix-crash-on-open` |
| `chore/modernise-ci`  | `1.1.1-chore-modernise-ci-beta.1`| `beta-chore-modernise-ci`|

The name part must be a single path segment made only of lowercase letters, digits
and hyphens, that is `+([a-z0-9-])`. Hyphen runs are part of the name and survive
the transform, so `feat/a--b` publishes `1.2.0-feat-a--b-beta.1` on
`beta-feat-a--b` next to `feat/a-b`, which publishes
`1.2.0-feat-a-b-beta.1` on `beta-feat-a-b`.

Anything else is excluded from the release configuration instead of being rewritten
into it: dotted names (`feat/ab.c`), nested names (`feat/a/b`), uppercase
(`feat/Launch`), underscores (`feat/a_b`) and empty names never match. Their
publish run logs that the branch cannot release and exits 0, and they cannot block
`main` or any other branch. That matters because the branch name is embedded in the
pre-release identifier by replacing only the `/` separator with `-`: the transform
never collapses characters, so every matched name maps to exactly one identifier and
one channel, and two branches can only collide if they have the same name. Names
with characters that a semver pre-release identifier cannot carry (`.` or a second
`/`) are excluded by the patterns instead; if they were kept, they would map onto an
existing identifier and semantic-release would abort every release run in the
repository with `EPRERELEASEBRANCHES`. Restricting the pattern keeps the name to
identifier mapping one-to-one, so a malformed branch is ignored rather than turning
into a failed release pipeline. The publish workflow trigger stays broad
(`feat/**`, `fix/**`, `chore/**`) so those pushes still get the normal checks; only
the release step no-ops.

## How a release run works

`.github/workflows/publish.yml` runs on pushes to `main` and to those three branch
families, and can still be dispatched manually. The `check` job runs
`npm run release:check`, verifies that committed `dist/` matches a fresh build, and
audits the full dependency tree with `npm run audit:ci`. Only then the `release`
job, bound to the protected `npm` GitHub environment, runs `semantic-release`, which
writes the new version to `package.json` and `package-lock.json`, prepends generated
notes to `CHANGELOG.md`, rebuilds `dist/`, commits and tags all of it, publishes to
npm with trusted publishing and provenance, and opens the GitHub release.

`prepublishOnly` asserts release identity on the publish path: a clean tree, a
repository URL that is set, `dist/build.json` at the published version, and HEAD
tagged as `vVERSION`. semantic-release creates that tag before it publishes. The
publish workflow sets `PI_AUTOMATED_PUBLISH=true` because its `check` job already
ran the full `release:check` gate on the same commit. Publishing is not a
workstation operation: `publishConfig.provenance: true` alongside `access: public`
makes npm attach provenance through the CI OIDC identity, and credentials come from
npm trusted publishing bound to this repository, workflow filename and environment.

The workflow keeps its exact filename and the `npm` environment because npm's
trusted publisher configuration is bound to the repository, the workflow filename,
and the environment name. The release commit and tag are pushed with the standard
`GITHUB_TOKEN`, and GitHub does not start workflow runs for events caused by that
token, so releases cannot trigger themselves.

## Dependency audit gate

`npm run audit:ci` runs `audit-ci` (pinned devDependency) against the full
dependency tree, production and development, using `audit-ci.json`. It fails on any
moderate, high or critical advisory that is not explicitly allowlisted, so a new
advisory in any dependency, including dev-only ones, breaks the gate. Both the CI
workflow and the publish workflow run it in their `check` job after `npm ci`.

The allowlist holds exactly one record, `GHSA-vfj7-8cjw-p6xm` (`braces` <=3.0.3,
stack exhaustion when expanding deeply nested brace patterns). No fixed version of
`braces` has been published, so no dependency range resolves around it. The only
path in this repository is the dev-only release toolchain
`semantic-release` -> `@semantic-release/commit-analyzer` -> `micromatch` ->
`braces`; the project never expands untrusted glob patterns and devDependencies are
not part of the published npm archive. The record carries that justification and an
`expiry` of `2026-11-20`: audit-ci treats an expired record as inactive, so the gate
starts failing on that advisory after the review date. Before then, check whether
`braces` published a fix or whether `micromatch`/`semantic-release` dropped the
dependency, upgrade, and delete the record; if the exception is still needed,
re-justify it and move the date. Never widen the allowlist to a whole module, a
package family, or a severity level.

## First automated release

History before this automation is not conventional, so nothing is released
retroactively: the last release semantic-release finds is `v1.0.1` and the existing
`v1.1.0-beta.*` tags are treated as already released. The conventional commit that
introduces the automation is therefore the first release and produces `1.1.0`.

## Verify a release without publishing

On a throwaway branch, the same engine decides the version and channel in dry-run
mode (it never publishes):

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
