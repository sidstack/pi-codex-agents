# Changelog

## [1.3.0-fix-naming-reliability-beta.4](https://github.com/sidstack/pi-codex-agents/compare/v1.3.0-fix-naming-reliability-beta.3...v1.3.0-fix-naming-reliability-beta.4) (2026-10-22)

### Bug Fixes

* **naming:** widen the title budget and report empty model answers ([ad40e82](https://github.com/sidstack/pi-codex-agents/commit/ad40e821746cbaffae0a56d4d8d0a3ab394deb4f))

## [1.3.0-fix-naming-reliability-beta.3](https://github.com/sidstack/pi-codex-agents/compare/v1.3.0-fix-naming-reliability-beta.2...v1.3.0-fix-naming-reliability-beta.3) (2026-10-22)

### Bug Fixes

* **naming:** stop reasoning models from returning an empty title ([365ec9f](https://github.com/sidstack/pi-codex-agents/commit/365ec9f32dc783717688d66d99d18001ab831127))

## [1.3.0-fix-naming-reliability-beta.2](https://github.com/sidstack/pi-codex-agents/compare/v1.3.0-fix-naming-reliability-beta.1...v1.3.0-fix-naming-reliability-beta.2) (2026-10-22)

### Bug Fixes

* **naming:** label the session from the message event and time out hung requests ([5f6e34d](https://github.com/sidstack/pi-codex-agents/commit/5f6e34da8df515cffd6bf27ba20fbeb7ef9b7bcb))

## [1.3.0-fix-naming-reliability-beta.1](https://github.com/sidstack/pi-codex-agents/compare/v1.2.0...v1.3.0-fix-naming-reliability-beta.1) (2026-10-22)

### Features

* **naming:** label sessions immediately and retry title requests ([827c696](https://github.com/sidstack/pi-codex-agents/commit/827c696fdc3214e916af5ab8e8ac20e955cd6bae))

## [1.2.0](https://github.com/sidstack/pi-codex-agents/compare/v1.1.0...v1.2.0) (2026-10-22)

### Features

* support Pi 1.4 and name the package everywhere ([2986255](https://github.com/sidstack/pi-codex-agents/commit/298625504d48446b4fac393bc166fb2dde33f31b))

## [1.2.0-feat-pi-1-4-support-beta.1](https://github.com/sidstack/pi-codex-agents/compare/v1.1.0...v1.2.0-feat-pi-1-4-support-beta.1) (2026-10-22)

### Features

* support Pi 1.4 and name the package everywhere ([2986255](https://github.com/sidstack/pi-codex-agents/commit/298625504d48446b4fac393bc166fb2dde33f31b))

## [1.1.0](https://github.com/sidstack/pi-codex-agents/compare/v1.0.1...v1.1.0) (2026-10-20)

### Features

* automate stable and branch releases ([55a39ad](https://github.com/sidstack/pi-codex-agents/commit/55a39ad93edfadf791f9121ebe7b47827aea4b5b))
* automate stable and branch releases ([#4](https://github.com/sidstack/pi-codex-agents/issues/4)) ([463bda7](https://github.com/sidstack/pi-codex-agents/commit/463bda760795468467e3ae852b784db3cf50b5ef))

### Bug Fixes

* keep hyphen runs in branch release identifiers ([60ffa9b](https://github.com/sidstack/pi-codex-agents/commit/60ffa9b9a25df70f11be334dc1ef985aca225086))
* name the semantic-release git credential GITHUB_TOKEN ([451e100](https://github.com/sidstack/pi-codex-agents/commit/451e1009e03e4abaeb76b6d88ae383ae5952f3de))
* scope release branches and full dependency audit ([454a155](https://github.com/sidstack/pi-codex-agents/commit/454a155a4c6733369ada87da39a05889286753b4))

## [1.1.0-feat-automatic-releases-beta.1](https://github.com/sidstack/pi-codex-agents/compare/v1.0.1...v1.1.0-feat-automatic-releases-beta.1) (2026-10-20)

### Features

* automate stable and branch releases ([55a39ad](https://github.com/sidstack/pi-codex-agents/commit/55a39ad93edfadf791f9121ebe7b47827aea4b5b))

### Bug Fixes

* keep hyphen runs in branch release identifiers ([60ffa9b](https://github.com/sidstack/pi-codex-agents/commit/60ffa9b9a25df70f11be334dc1ef985aca225086))
* name the semantic-release git credential GITHUB_TOKEN ([451e100](https://github.com/sidstack/pi-codex-agents/commit/451e1009e03e4abaeb76b6d88ae383ae5952f3de))
* scope release branches and full dependency audit ([454a155](https://github.com/sidstack/pi-codex-agents/commit/454a155a4c6733369ada87da39a05889286753b4))

## 1.1.0-beta.3 — 2026-10-20

- Launching Pi in a directory now starts a new managed session for that directory with its own
  history every time, instead of resuming the session that directory already had. Sessions from
  earlier launches of that directory stay available in the command center with their history and
  drafts.
- Ctrl+P now chooses a directory by fuzzy search over the directories the session knows plus one
  bounded background scan: the directory opened from, its parent, a shallow pass over home, then
  known session directories. A name matches first (exact, prefix, substring, letters in order), a
  match anywhere in the full path is a weaker fallback, so `scr` still offers
  `~/work/screenshots`; existing sessions outrank equal-quality plain directories and the list is
  capped at 40 rows. The scan goes three levels deep (two under home), examines at most 3000
  entries, gives up after a second, never traverses the filesystem root, never enters a symlinked
  directory, skips heavy trees such as `node_modules`, `.git`, `dist`, `build`, `vendor`, and
  hidden directories, and keeps its results in a snapshot that typing only re-filters.
- Directory completion keeps its previous behavior alongside the search: `..`, `~/project`, and
  absolute paths resolve against the session the picker opened from, a directory typed in full is
  offered first, existing sessions are marked `existing`, a trailing `/` lists inside a directory
  (that listing is capped at 200 entries and says so), an unreadable directory completes nothing
  instead of failing, and the highlight follows the selected path while results change underneath.
- Add `resumeLastSession` (default `false`). A launch in a directory keeps starting a new
  managed session. Set it to `true` to reopen that directory's last session instead: a live one,
  else its saved history and draft resumed in place, else a new session, with an unreachable
  saved history reported and its row marked failed. The host reads it at startup, so restart the
  host after changing it.

## 1.1.0-beta.2 — 2026-10-17

- Complete attachment before waiting for answers to startup dialogs, keeping those dialogs
  visible and interactive. Report failed history resumes in the attached fallback
  session while retaining the failed saved entry.

## 1.1.0-beta.1 — 2026-10-16

- Launch Pi in a directory and it attaches a managed session for that directory: a live
  session is resumed, a saved managed history is restored in place, otherwise one session is
  created. Attaching no longer forces the command center open. `autoAttach: false` restores
  the previous startup, where ordinary Pi waits for `/agents` or Left Arrow.
- Ctrl+N in the command center now starts a session in the directory being viewed with no
  prompt. Ctrl+P (and Ctrl+Shift+N where the terminal distinguishes it) opens a directory
  choice with this directory, recent projects, and bounded filesystem completion, `~` and
  relative path resolution, existing-session markers, Tab completion, and Esc cancel.
- Host-owned dialogs (the board and the directory choice) no longer mark their own session
  as needing input or route their keys through the navigation feature.

## 1.0.1 — 2026-10-16

- Keep the package focused on the native Pi session extension. Remove worker
  delegation tools, worker policy skills, and their host-side feature state.
- Remove the delegation configuration options and document the extension-only
  package contents.

## 1.0.0 — 2026-10-16

- Upgrade the tested SDK to Pi 1.3.0; accept stable 1.3 patch releases through the
  `>=1.3.0 <1.4.0` peer/runtime range while retaining native adapter guards.
- Add optional native worker spawning, bounded durable two-way mail, compact
  status/waits and targeted stop, with two-worker admission and medium thinking.
- Add native worker tools with shared worker guidance and implement, review, test,
  and research role guides.

Initial stable release of the native extension under `pi-codex-agents`.

- Fix disposal/navigation/shutdown races with shared stops, creation ownership,
  handoff reservations, and dialog cancellation before waiting for settlement.
- Isolate failed restoration, preserve unavailable Home history, and retry failed
  sessions after their project is repaired. Startup dialogs remain attachable.
- Bound and cache history discovery, report partial scans, keep draft contents out
  of status, and reject oversized state before replacing the previous usable file.
- Add optional first-message model naming (`autoName: true`), preserving manual
  native titles and Home without adding conversation turns.
- Report unexpected host disconnections honestly; align managed/ordinary command
  behavior, supported Pi installation instructions, and packaged contributor docs.

- Explicit session stop releases disposed runtime, view, mode, and input callback
  references while retaining the history and draft needed for recovery.
- Refused automatic host updates preserve the live connection. Transport loss or
  timeout during an update reports a failure and closes the unusable connection.
- Native Pi session views with persistent execution, terminal reattachment, and
  explicit takeover; detaching restores the original Pi editor and draft.
- Command center filters: Active (ready, running, needs input, failed), Inactive, and
  All, with Active selected on open.
- Native status line summarizing sessions by activity: `sessions N · running · needs
  input · ready`, adding failed, inactive, and unread groups only when non-zero.
- Idle sessions stay loaded for 1 hour by default (`idleTimeoutMs: 3600000`);
  `autoInactive: false` or `idleTimeoutMs: 0` keeps settled sessions loaded.
- Ctrl+Q in the command center mirrors `/quit`: the same quit menu, and Pi ends in one press
  while the host keeps running. Ctrl+Z or `/agents leave` is the detach path back to the Pi
  editor you launched; `/agents exit` is gone.
- The command center fills the terminal by default; `boardFullscreen: false` restores the
  framed panel.
- `/agents restart` works inside a managed view: the host replaces itself and the frontend
  starts the installed build and reconnects, instead of falling through to the usage line.
- A stopped host now always exits. The shutdown timer was unref'd, so a lingering handle
  could keep the process alive after it released its socket and lock; smoke runs leaked
  hosts this way.
- Host updates no longer interrupt sessions: the frontend enforces the IPC protocol only, a
  settled unattached host updates to the installed build on its own, and a busy host is
  reported for `/agents restart` instead. `autoUpdateHost: false` makes every replacement
  manual. Automatic replacement requires the host's `safeUpdate` and `settledStop` capabilities, so an old host
  that would record settled sessions as Stopped on its own shutdown is never replaced silently.
- A host shutdown keeps settled sessions restorable instead of marking them Stopped, so a
  restart recreates them live from their own managed history; Ctrl+K remains the only explicit
  session stop.
- Automatic listing of ordinary Pi histories as inactive entries; selection forks
  foreign histories safely into standard native Pi session files.
- Configurable idle unloading and seamless reopening with preserved drafts.
- Independent optional history, navigation, status, and inactivity feature modules.
- Exclusive host ownership, atomic persistence, bounded IPC, private state files,
  guarded Pi adapters, and crash restoration without replaying model/tool calls.
- Remove the standalone wrapper, RPC workers, custom transcript, and migration paths.
- Fresh-install, native lifecycle, security regression, and packaging checks.

Earlier wrapper development versions were not releases of this package.
