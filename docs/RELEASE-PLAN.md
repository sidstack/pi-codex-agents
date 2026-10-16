# Fresh-user MVP and OSS release plan

Status: reviewed first public source snapshot prepared for `0.1.0-beta.1` after
release checks on Node 22.19 and 24.

1. **Fresh start (completed)** — stop only verified pi-agents-owned hosts/workers; preserve
   useful app histories as ordinary Pi session files; remove old app-owned state.
2. **Product cleanup (completed)** — one clean host directory; no experiment discovery or
   migration branches; ordinary Pi histories appear inactive automatically, with optional features
   assembled separately from the usable session core.
3. **Security review and fixes (completed locally)** — review local IPC, filesystem boundaries, lock
   ownership, untrusted history, child startup, dependencies, and published content.
   Add adversarial regression checks and document remaining trust boundaries.
4. **Fresh-install integration (completed locally)** — pack the actual distributable, install through
   Pi with empty agent/config directories and no checkout dependency tree, exercise
   native entry, session creation, inactivity, return/reconnect, stop, and uninstall.
5. **Versioning and OSS preparation (completed)** — package manifest, MIT license,
   contributor and security policies, CI, release checks, version/tag validation,
   and npm/GitHub installation instructions.
6. **Release review (completed)** — validate the reviewed source snapshot and
   prerelease artifact against the selected package and repository identities.

Public identity: `pi-codex-agents@0.1.0-beta.1`, MIT, in the
`sidstack/pi-codex-agents` repository. The initial public repository uses a reviewed
source snapshot without the earlier development history. See [security review](SECURITY-REVIEW.md)
and [release instructions](RELEASING.md).

The current tested SDK is Pi 1.3.0. Peers/runtime accept stable 1.3 patches
(>=1.3.0 <1.4.0); new minors require adapter validation.
Do not replace the production host to apply this build while it owns work.
