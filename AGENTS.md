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

Use Linux, Node.js 22.19+, and the pinned Pi 1.3.0 development dependencies. Smoke checks require Python 3 and a PTY-capable environment.

- `npm ci`: install dependencies from the lockfile.
- `npm run build`: regenerate `dist/`.
- `npm run typecheck`: check source and test TypeScript.
- `npm test`: run Vitest once; `npm run test:watch` runs interactively.
- `npm run smoke`: exercise sessions, host behavior, compatibility, and extension integration.
- `npm run release:check`: run build, typecheck, tests, smoke checks, and fresh-install validation. Fresh-install checks fetch Pi from npm and use fake local models without paid model calls.

## Coding Style & Naming Conventions

Follow existing TypeScript: two-space indentation, double-quoted strings, semicolons, and ESM imports with `.js` relative paths. Use camelCase for functions and variables, PascalCase for types and classes, and descriptive kebab-case filenames. Strict typing and unused-code checks are enabled; no dedicated formatter or linter is configured.

Keep lifecycle and safety logic separate from optional features. Optional features need a configuration toggle, cleanup, enabled/disabled test coverage, and documentation. Discuss API or dependency changes before implementation.

## Testing Guidelines

Name tests `test/<behavior>.test.ts` and use Vitest `describe`, `it`, and `expect`. Add behavioral regression tests for fixes. Use isolated temporary histories/configuration and fake models. No numeric coverage threshold is configured. Run `npm run release:check` before submitting.

## Commit & Pull Request Guidelines

Recent commits use concise imperative subjects, such as `Document published npm installation`. Follow that convention. PRs should explain the behavior changed, why, and checks run. Include regenerated output when applicable. Never include authentication files, real conversations, or private host logs; use temporary data in bug reports.
