# Repository Guidelines

## Project Structure & Module Organization

This repository provides a native Pi extension for persistent agent sessions. Read `docs/ARCHITECTURE.md` before changing lifecycle behavior.

- `src/extension.ts` and `src/host-entry.ts` are the frontend and host entry points.
- `src/core/` manages sessions, storage, terminal ownership, and safety.
- `src/pi/` contains Pi integration; `src/ui/` contains the command center.
- `src/features/` holds optional features; `src/config.ts` defines configuration.
- `test/` contains Vitest tests; `scripts/` contains build and integration checks.
- `dist/` contains generated, shipped JavaScript. Rebuild and commit it after source changes; never edit it directly.

## Build, Test, and Development Commands

Use Linux, Node.js 22.19+, and the pinned Pi 1.4.0 development dependencies. Smoke checks require Python 3 and a PTY-capable environment.

- `npm ci`: install dependencies from the lockfile.
- `npm run build`: regenerate `dist/`.
- `npm run typecheck`: check source and test TypeScript.
- `npm test`: run Vitest once; `npm run test:watch` runs interactively.
- `npm run smoke`: exercise sessions, host behavior, compatibility, and extension integration.
- `npm run release:check`: run build, typecheck, tests, smoke checks, and fresh-install validation. Fresh-install checks fetch Pi from npm and use fake local models without paid model calls.
- `npm run audit:ci`: audit production and development dependencies using the committed, narrowly scoped advisory allowlist. Run this alongside the release checks before submitting.

## Coding Style & Naming Conventions

Follow existing TypeScript: two-space indentation, double-quoted strings, semicolons, and ESM imports with `.js` relative paths. Use camelCase for functions and variables, PascalCase for types and classes, and descriptive kebab-case filenames. Strict typing and unused-code checks are enabled; no dedicated formatter or linter is configured.

Keep lifecycle and safety logic separate from optional features. Optional features need a configuration toggle, cleanup, enabled/disabled test coverage, and documentation. Discuss API or dependency changes before implementation.

## Testing Guidelines

Name tests `test/<behavior>.test.ts` and use Vitest `describe`, `it`, and `expect`. Add behavioral regression tests for fixes. Use isolated temporary histories/configuration and fake models. No numeric coverage threshold is configured. Run `npm run release:check` before submitting.

## Commit & Pull Request Guidelines

Work on a branch based on the latest `main` and submit changes through a pull request targeting `main`. Avoid committing or pushing directly to `main`; reserve direct pushes for explicitly authorized repository maintenance when needed. Preserve existing local changes; use an isolated worktree when another task or dirty checkout would overlap.

Use Conventional Commit subjects for commits and PR titles, for example `feat: add session filtering` or `fix: restore saved drafts`. Scopes are allowed, such as `fix(session): restore saved drafts`. For squash merges, ensure the final squash subject follows this convention; ordinary merge releases also analyze the merged commits. Choose the type for the actual behavior, not to force a release.

- `feat:` requests a minor release; `fix:` requests a patch release.
- A breaking change uses `!` after the type/scope or a `BREAKING CHANGE:` footer and requests a major release. Explain the incompatibility and migration.
- Documentation, tests, maintenance, style, and behavior-preserving refactors use `docs:`, `test:`, `chore:`, `style:`, and `refactor:`. Do not use `feat:` or `fix:` for documentation-only or other non-code updates. These non-releasing types do not normally request a release unless marked breaking. The committed semantic-release configuration and its standard analyzer determine the final version.

Use descriptive release branches under `feat/`, `fix/`, or `chore/`, with a single name segment containing only lowercase letters, digits, and hyphens, for example `feat/session-filter` or `fix/restore-draft`. Dots, underscores, uppercase letters, and additional `/` segments are excluded from automatic branch releases. Branch names choose the prerelease channel; commit types choose the version bump. A `chore/` branch containing only non-releasing commits does not publish a beta.

PRs should explain the behavior changed, why, and checks run. Include regenerated output when applicable. Never include authentication files, real conversations, or private host logs; use temporary data in bug reports.

## Automatic Versioning & Publishing

Read `docs/RELEASING.md` before changing release infrastructure. Use the existing semantic-release setup and standard plugins; do not create a separate versioning engine.

- Pushes to supported branches run checks and publish a prerelease only when there are releasable changes. For example, `feat/session-filter` publishes a version like `1.2.0-feat-session-filter-beta.1` to npm tag `beta-feat-session-filter`; later releases increment the prerelease number. Branch releases never replace `latest`.
- Merging releasable changes into `main` automatically publishes a stable version to npm tag `latest`, creates its Git tag and GitHub release, and commits version metadata, changelog, and rebuilt output. Docs-only or other non-releasing changes can finish successfully without publishing anything.
- Do not manually bump package versions, create release tags, edit generated release notes, or run `npm publish` locally. CI owns releases, trusted publishing, and provenance. Keep `.github/workflows/publish.yml` and its `npm` environment identity compatible with npm's trusted publisher.
- Build and commit `dist/` for source changes before review; automation performs the additional rebuild needed for the release version. Never hand-edit `dist/` or add `[skip ci]` to ordinary work; automation uses it for its own release commits.
- Require successful release checks, generated-output checks, and `npm run audit:ci` before publishing. Do not weaken auditing to omit development dependencies or broaden advisory exceptions; document and time-limit any explicitly justified exception.
- After a requested release, verify the actual Actions conclusion, npm version/channel, and provenance. A merge or successful push alone is not proof of publication. Install `npm:pi-codex-agents@latest` for stable testing, or the specific `beta-<branch>` npm tag for a branch build. Verify the installed version and avoid duplicate extension registrations.
