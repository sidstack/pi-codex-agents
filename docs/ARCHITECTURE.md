# Native extension architecture

```text
ordinary Pi + pi-agents extension
  original native view and draft
  /agents → temporary terminal handoff
                 │ private JSONL: input, resize, Terminal methods
                 ▼
         persistent native host
           ├─ Home: SDK runtime + InteractiveMode
           ├─ project A: SDK runtime + InteractiveMode
           └─ project B: inactive managed history + draft
```

The extension connects before suspending Pi's TUI. Attachment lends its Terminal
to the host. Native views produce structured Terminal calls; detach closes the
connection and restarts the original TUI. There is no terminal emulator, RPC agent
worker, replacement chat renderer, or separate executable.

Every runtime has a cwd, normal resource discovery, copied in-memory settings, and
saved trust policy. Exactly one view holds a terminal lease. Hidden writes, titles,
progress, input, and control calls are gated. Requests match by id; JSONL splits
only on LF and decodes UTF-8 across chunks.

## Session lifetime

agent_start sets Running; only agent_settled clears it. Native UI prompts set the
waiting state, shown as Needs Input, and prevent idle eviction. Navigation only changes
terminal ownership. Frontend loss preserves all managed runtimes and pending dialogs.

A hidden ready session unused for the timeout saves its draft and disposes its idle
view/runtime. It becomes Inactive. Enter reopens its own managed file under the host
lock and restores the draft without sending a prompt. Home is retained as the stable
navigation target. Stop and whole-host shutdown are explicit actions.

Each runtime carries its own `running` flag and its own pending-prompt count. They remain independent of the display activity label: restart and automatic-update safety are
computed by inspecting those independent flags per session, and a stop request that must
not interrupt work is refused when any session reports a run or a pending prompt.

Drafts are separate private files under `host/drafts/`, one per session, written under the
same ownership rules as other host state. The registry and status responses carry session
metadata only, never draft text; the text is read back when the session is opened.

An abstract Unix socket serializes startup even after SIGKILL. Lifetime locks record
PID and Linux process start identity. Ownership precedes any managed file open.
Registry writes use a separate lock, fsync, and atomic rename. Crash restoration
does not retry model requests or tools and marks interrupted work failed.

A host shutdown is not a user stop. It aborts runs that were in flight and records those
as Stopped, while settled and failed sessions keep the state a restart restores them
into, so a new host recreates them live from their own managed history. Only Ctrl+K
produces a Stopped session that stays inert until it is opened again.

## Pi contract

Pi 1.3.0 exports InteractiveMode and SDK runtime creation but no public live-view
attachment API. Private UI and shutdown/signal adaptations are scoped to owned mode
instances. Pi's own exit keys (/quit, Ctrl+D, double Ctrl+C) and the command center's Ctrl+Q
reach the host-owned mode, so the host turns them into the same explicit choice and reports
`quitFrontend` to the
frontend, which calls Pi's `ctx.shutdown()` when the user chose to quit. Ctrl+Z and
`/agents leave` are the detach path. The host never
ends the frontend process by itself, and `/agents stop` keeps Pi running. Native
runtime-replacement commands are blocked inside the host because they dispose live
sessions and bypass managed ownership. Use the command center for creation, switching,
and history recovery. /reload retains the fleet.

The frontend handshake enforces `PROTOCOL_VERSION`, not build identity. A host that predates
the current build is replaced automatically only when the host advertises both `safeUpdate` and
`settledStop`, because the replacement is performed by the old host's own shutdown code. The
stop uses `onlyIfSettled`, which the host refuses if a run, prompt, terminal attachment, or incomplete initialization exists at shutdown. A busy,
attached, or capability-less host is reported instead and replaced by the explicit
`/agents restart`; `autoUpdateHost: false` disables the automatic path. An incompatible
protocol is refused with that instruction. Rebuilding therefore never interrupts a session.

Host state lives under `pi-agents/host/`, with drafts under `pi-agents/host/drafts/`.
Ordinary Pi histories appear automatically
as inactive entries. Foreign histories are read-only and fork into new identities;
managed files resume in place in Pi's ordinary session directory. Stop the host
before opening a managed file for writing through ordinary Pi.

Managed runtimes share a process. Native rendering preserves the UI surface RPC
drops, but does not guarantee isolation of third-party module state. The parent Pi
frontend is a separate process. Interactive subprocess stdio and external editors
remain outside the supported Terminal transport.

## Building blocks

`src/core/` owns runtimes, lifecycle, terminal leases, persistence, and safety.
`src/pi/` adapts the physical frontend terminal and host connection. `src/ui/` renders
the picker. The extension and host entry points assemble these components.

The picker offers three filters: **Active** (ready, running, waiting, and failed sessions
that still hold a runtime), **Inactive** (unloaded after the idle timeout or explicitly
stopped history), and **All**. Active is selected when the command center opens.

The board owns its keys: Ctrl+N creates a session in the directory being viewed with no
prompt, and Ctrl+P (Ctrl+Shift+N where the terminal distinguishes it) opens a separate
directory choice. That choice lists this directory, the projects the fleet and history
discovery already know, and completions for what the user types, resolving `~` and relative
paths against the session it was opened from. Listings are bounded (200 entries, a short
cache) and an unreadable directory completes nothing instead of failing. Cancelling it
creates nothing. Every host-owned dialog, the board and this picker alike, is counted so it
never reports its own session as needing input or routes its keys to a feature.

The `/agents` command is registered twice, once per context, and each registration offers
only the commands that context can honor. The frontend registration in `src/extension.ts`
runs in ordinary Pi: open, `takeover`, `status`, `stop`, and `restart`; `leave` reports that
this Pi is already detached. The host-side registration inside every managed view offers
open, `new [directory]`, `status`, `stop` (which stops the host and returns the original Pi),
`restart`, `leave`, and reports `takeover` as already attached. Session creation and terminal handoff use the core lifecycle operations.

Attaching shows a session; the command center is a separate, explicit request. An attach can
carry the frontend's own directory, and the host then makes that directory's session the
foreground one: a live session for it, otherwise a saved managed history resumed in place,
otherwise a new session. It never adds a duplicate for a directory that already has one. A
directory whose history is unreachable is marked failed and a usable session starts instead,
and the frontend reports the failure rather than attaching silently. The frontend attaches
on Pi startup when `autoAttach` is enabled (default), once per frontend process and only for
its first session, so a later `/new`, resume, or `/reload` in ordinary Pi keeps that Pi's
terminal. `autoAttach` is frontend configuration only: the host serves the same attach
whether a frontend asked for it or the user pressed `/agents`.

Optional behavior implements `SessionFeature` in `src/features/contracts.ts`.
`configuredFeatures` is the single assembly point. The core accepts a feature list
and imports only its type contract; it never imports concrete feature modules.
Features use public core operations and do not depend on each other:

| Feature | Responsibility | Configuration |
| --- | --- | --- |
| History | Read ordinary Pi histories and add inactive entries | `historyImport` |
| Navigation | Extra entry keys and live view cycling | `leftArrowEntry`, `commandCenterShortcut`, `sessionCycling` |
| Status | Native status line counts | `showStatus` |
| Inactivity | Schedule protected core unload operation | `autoInactive`, `idleTimeoutMs` |

Host configuration is a validated snapshot. Feature startup owns its cleanup;
closing the host removes feature timers before disposing runtimes. With an empty
feature list, core creation, navigation through `/agents`, managed restoration,
terminal ownership, and explicit stop remain available. No dynamic code loading or
new third-party plugin system is introduced.

The optional naming feature listens only to new `agent_settled` events, never restoration.
It queues one bounded title request through the context's public model registry, owns its
abort controller and timeout, and cancels on new work or host close. Native manual names
are checked before and after generation. No agent prompt or tool execution is used.

History discovery uses one scanner per feature/host. Cache keys include canonical
path, mtime and size; managed files are excluded before parsing. Streaming reads
cap directory entries (10,000), total bytes (32 MiB), per-file bytes (2 MiB), record
bytes (1 MiB), and returned history metadata (512 KiB). Errors and truncation
produce partial results and changed-issue notices. Untouched foreign rows are
refreshed/removed with discovery; owned managed copies are retained. Cache state
is released on host close, including a scan completing after cleanup.

Private JSON reader/writer limits match at 16 MiB. The registry's metadata budget
is tighter (2 MiB), excluding drafts and untouched foreign histories. Draft files
are keyed by hashed session ID; oversized writes preserve previous state and
name the affected session/path. Frontend records are bounded to 1 MiB outbound
and 4 MiB inbound; socket backlog is bounded to 2 MiB and pending requests to 64.
The host permits at most 32 connections. A limit-induced socket loss is an error,
never a claim that background execution succeeded.

The tested SDK is now Pi 1.3.0. Peers and bootstrap/runtime checks accept stable
1.3 patch releases (>=1.3.0 <1.4.0); private adapter method guards remain in force.
Development and fresh-install tests pin a reproducible baseline.
