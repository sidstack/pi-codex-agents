# pi-codex-agents

A native **Pi extension** for persistent agent sessions across projects. Pi renders
the editor, transcript, tools, widgets, and dialogs itself. Managed agents continue
while you view another session or close your terminal.

Install the published package with Pi's package manager. See
[release instructions](docs/RELEASING.md) for maintainer details.

> Independent community project. **Not affiliated with, endorsed by, or produced by
> OpenAI.** The session UX is modeled on OpenAI Codex's agent dashboard, and that is the
> only connection: Codex is a trademark of OpenAI OpCo, LLC, and this extension neither
> uses nor interoperates with it. See
> [trademarks and affiliation](docs/TRADEMARKS.md).

## Install

Requires Linux, Node 22.19+, and Pi **>=1.3.0 <1.5.0**; 1.4.0 is the tested baseline.

```sh
pi install npm:pi-codex-agents@latest
```

To test an unreleased branch build, install the dist-tag of that branch, or install a
tag straight from GitHub. Every supported `feat/<name>`, `fix/<name>` or
`chore/<name>` branch publishes its own prereleases under
`beta-<type>-<name>`; the name must be a single lowercase kebab-case segment, other
branch names never release. Prereleases published before the automation used the
shared `beta` tag.

```sh
pi install npm:pi-codex-agents@beta-feat-launch-picker
pi install git:github.com/sidstack/pi-codex-agents@v1.2.0-feat-launch-picker-beta.1
```

Restart Pi after installation, or run `/reload` in an open Pi session. The agent host is a
separate long-lived process that keeps running sessions across Pi restarts, so load a new
build there too with `/agents restart`; running sessions are aborted by that swap, settled ones
are restored. `/agents status` marks a host that is still on an older build.

To uninstall, run `pi remove npm:pi-codex-agents`. Uninstalling keeps managed
session history and app state, so they are available if you reinstall later.

## Open your sessions

By default, launching Pi in a directory attaches it to a managed session **for that directory**:
a new session with its own history every time, so each launch starts fresh. Sessions from earlier
launches of that directory stay available in the command center with their history and drafts.
You land in that session's editor, not in the command center. Set `autoAttach: false` to keep
ordinary Pi at startup and enter the host yourself with `/agents` or Left Arrow. Set
`resumeLastSession: true` to reopen the directory's last session on launch instead of starting a
new one.

| Control | Action |
| --- | --- |
| /agents or Ctrl+G | Open the command center |
| Left Arrow, editor empty | Open the command center; drafts retain normal cursor movement |
| Enter | Open selected session; automatically restore inactive sessions |
| Ctrl+N | Create a session in the directory you are viewing |
| Ctrl+P | Create a session in another directory, chosen by fuzzy search over known projects and nearby directories |
| Ctrl+Alt+N / Ctrl+Alt+P | Cycle live views, including over pending dialogs |
| Tab / Shift+Tab | Filter Active, Inactive, All |
| Type | Search sessions and projects |
| Ctrl+X | Abort selected run |
| Ctrl+K | Explicitly stop selected session |
| Ctrl+Q | Quit Pi — the same choices as `/quit`; sessions keep running unless you stop them |
| Ctrl+Z | Leave the command center and return to the Pi editor you launched |

The command center fills the terminal by default (`boardFullscreen: true`). Set it to
`false` for the framed panel, which leaves the surrounding session view visible around it.

Each session has its own native editor and component tree. Switching preserves
drafts, in-flight work, widgets, and dialogs. New sessions inherit the active model,
thinking level, and scope, and load project resources using Pi's trust policy.

Every managed view shows a Pi status line: `sessions 6 · 1 running · 2 needs input ·
1 ready · Ctrl+G`. It adds `failed`, `inactive`, and `unread` groups only when they are
non-zero, and `showStatus: false` hides it.

## Commands in each context

The same `/agents` name works in two places, and each context has its own set.

In ordinary Pi — the editor you launched, with no terminal lent to the host:

| Command | Action |
| --- | --- |
| `/agents` | Attach this terminal and open the command center |
| `/agents takeover` | Move an attached terminal from another Pi instance to this one |
| `/agents status` | Inspect sessions and the host build without attaching |
| `/agents stop` | Confirm, then stop managed sessions and their host; Pi stays open |
| `/agents restart` | Replace the host; confirm when work, attachment, or older safety capabilities require it |
| `/agents leave` | Nothing to detach: you are already in the Pi you launched, so this is a notice |

In a managed view — the command center or any managed session, whose terminal belongs
to the host:

| Command | Action |
| --- | --- |
| `/agents` | Open the command center for this host |
| `/agents new [directory]` | Create a session here or in another directory |
| `/agents status` | Show session and unsettled-work counts |
| `/agents stop` | Confirm, stop the host and all managed sessions, and return to the original Pi |
| `/agents restart` | Replace the host with the current build in one command |
| `/agents leave` | Detach back to the Pi editor you launched |
| `/agents takeover` | Already attached here, so this is a notice |

Restart safety is decided per runtime: each session tracks its own `running` flag and its
own count of pending prompts independently. A restart asks for confirmation when any
session reports a run in flight or a pending prompt, and aborts only those runs.

New sessions start with the directory name until they have a first message. `autoName`
(default `true`) then names them in two steps: an instant extractive label from the first
message, followed by one model request for a short title (at most the first 2,000 characters
of that message, 256 output tokens on minimal thinking, 45 seconds). The label appears as
soon as the first message is recorded, while the run is still going; the model request waits
for that session's
first completed turn, or starts immediately when the first message is longer than 2,000
characters. A host restart also labels restored sessions that never got a name. It adds no
conversation turn and follows normal provider billing. A failed, cancelled, or hung request is
retried up to three times, 20 seconds apart, and each failed attempt is recorded in `host.log`;
after the third the extractive label stays and one notice reports the reason. Requests are
independent per session, so other sessions starting work never cancel a pending title. Set
`nameModel` to a `"provider/id"` model to title with a cheaper model than the session's own; a
missing or unauthenticated reference stops the requests with a notice and keeps the extractive
label. Names set with `/name` always win, in Home as elsewhere. Set `autoName: false` to keep
directory names without any requests.

History discovery caches unchanged metadata and skips managed files before reading.
Each scan is limited to 10,000 directory entries, 32 MiB total input, 2 MiB per file,
1 MiB per LF record, and 512 KiB of returned history metadata. Partial scans report
issues; large or malformed libraries do not prevent core session operations. A title
stored beyond a file's scan prefix may fall back to its directory and date.

## Inactive sessions

Hidden, settled sessions become **Inactive** after 1 hour. Opening one restores
the same managed history and draft automatically. Running agents and pending dialogs
are never evicted. Home stays loaded for navigation.

`autoInactive: false` keeps settled sessions loaded, and `idleTimeoutMs: 0` disables the
idle timer. Set PI_CODEX_AGENTS_IDLE_MS before starting Pi to change the timeout; it overrides
the file. Restoration does not repeat prompts or tool calls. Live switching
retains component state; inactivity rebuilds the native view from history.

## Optional features

Create `~/.pi/agent/pi-codex-agents/config.json` to override these defaults:

```json
{
  "autoName": true,
  "nameModel": "",
  "historyImport": true,
  "autoAttach": true,
  "resumeLastSession": false,
  "leftArrowEntry": true,
  "commandCenterShortcut": true,
  "sessionCycling": true,
  "showStatus": true,
  "autoInactive": true,
  "autoUpdateHost": true,
  "boardFullscreen": true,
  "idleTimeoutMs": 3600000
}
```

Settings are validated; unknown keys are errors. Restart the host to apply its
configuration and reload ordinary Pi to apply frontend shortcuts. The environment
variable `PI_CODEX_AGENTS_IDLE_MS` overrides `idleTimeoutMs`; `0` disables inactivity.
Disabling history import hides untouched foreign histories and keeps managed copies.
Disabling every optional feature still leaves `/agents`, creation, switching,
restoration, terminal attachment, and explicit stop available.

`autoAttach: false` leaves the Pi you launched in ordinary Pi; the host still starts on the
first `/agents`, and every other control above is unchanged.

`resumeLastSession: true` makes a launch reopen the directory's last session — a live one, else
its saved history and draft resumed in place, else a new session — instead of starting a fresh
one. It belongs to the host, so restart the host after changing it; `autoAttach` is read by the
frontend.

## Choosing a directory for a new session

Ctrl+N in the command center starts a session in the directory you are viewing, with no
prompt. Ctrl+P (also Ctrl+Shift+N where the terminal distinguishes it) opens a directory
choice that lists this directory, your recent projects, and completions for what you type:
`~`, a relative path, a partial name, or a full path. ↑/↓ select, Tab completes the
selection into the input, Enter chooses, and Esc cancels without creating anything.
Directories that already hold a session are marked `existing`, so a project is never opened
twice by accident. `/agents new [directory]` does the same thing from the command line.

Typing searches fuzzily. A directory matches on its name first — exact, then prefix, then
substring, then the letters in order — with a match anywhere in the full path as a weaker
fallback, so `scr` still offers `~/work/screenshots`. Sessions you already have outrank
plain directories of equal quality, and the list is capped at 40 rows; type more to narrow
it.

Each picker starts one bounded search of nearby directories in the background and keeps what
it finds in its own snapshot: the directory you opened from, its parent, a shallow pass over
your home directory, then the directories your sessions already know. It goes three levels
deep (two under home), examines at most 3000 entries, gives up after a second, never
traverses the filesystem root, never follows a symlink — a symlinked directory is skipped,
not entered — and skips heavy trees such as `node_modules`, `.git`, `dist`, `build`,
`vendor`, and hidden directories. Typing never restarts that background search: each
keystroke only re-filters the snapshot the search has fed so far. Results arrive in batches
and only merge into the snapshot, and cancelling ends the search.

Typing a path is unchanged: `..`, `~/project`, and absolute paths resolve against the
session the picker was opened from, a directory you type in full is offered first, and a
trailing `/` lists what is inside it. Those per-directory completion listings keep their own
bound (200 entries, a short-lived cache), independent of the background search: the picker
says so when a listing is capped, and the names left out do not come back by typing — type
the directory in full, or a trailing `/` to step into it, instead. An unreadable directory
completes nothing instead of failing. While
results change underneath you, the highlight follows the path you selected rather than its
position in the list.

## Return to Pi and reconnect

Ctrl+Q in the command center, and `/quit`, Ctrl+D, or double Ctrl+C inside a managed view,
open the same menu: **Quit the managed session?** — keep sessions running and quit Pi, stop
all managed sessions and quit Pi, or cancel. A managed view belongs to the host process, so
it cannot end your Pi by itself; the host reports the choice and the extension asks Pi to
shut down.

Ctrl+Z in the command center or `/agents leave` opens **Leave command center?**: keep
sessions running in the background, stop all managed sessions, or cancel. Detaching returns
to the original Pi view and draft.

Closing your terminal detaches it. Open /agents in a new Pi terminal to reconnect
to the same host, or use /agents takeover when another Pi still holds the terminal.

An unexpected socket disconnect reports an error because the frontend cannot tell whether
the host is still alive. Check `/agents status`, then reconnect with `/agents`. A surviving
host retains its runs. If the host itself died, reconnecting restores the persisted conversations and
marks interrupted runs failed without replaying requests; live dialogs do not survive. If you
would rather open a managed history with ordinary Pi, run /agents stop first.

Ordinary Pi /quit after returning still exits that Pi process. The detached managed
host keeps running.

## Storage and ownership

The host owns its managed files and accepts one attached terminal. Kernel and
PID/start-time locks exclude another host writer; registry writes are atomic.
Ordinary Pi histories appear automatically as Inactive. Opening one copies it into
an independent native session; its original file stays unchanged. Managed inactive
or stopped sessions reopen their own file under the host lock.

Host state lives in `~/.pi/agent/pi-codex-agents/host/`; managed conversations live in Pi's
ordinary `~/.pi/agent/sessions/` directory. Each draft is its own private file under
`host/drafts/`, so draft text never travels through the registry or a status response:
status contains session metadata only, and a draft is read back into the editor when its
session is opened. If the extension is unavailable, stop its
host before opening a managed history with ordinary Pi's session picker. Never open
the same file for writing in Pi and a live host simultaneously.

`PI_CODEX_AGENTS_NATIVE_DIR` overrides host state; `PI_CODEX_AGENTS_DIR` overrides the app root.
`PI_CODING_AGENT_DIR` selects Pi's agent directory. The shorter `PI_AGENTS_*` spellings are still
accepted, and an older build of this package still exports them, so a frontend and a host from
different builds keep working together.

State used to live in `~/.pi/agent/pi-agents`. The first start moves it to
`~/.pi/agent/pi-codex-agents` and says so once. The move is skipped while a host still owns the
old directory (`/agents stop`, then restart Pi to finish it), never touches a directory an
environment variable selected, and never merges two directories that both exist.

Updating source does not disturb a running host. The frontend only requires the IPC protocol
to match. A host that predates the current build is replaced automatically only when the
host advertises both `safeUpdate` and `settledStop`, and atomically verifies no running run,
no pending prompt, no attached terminal, and completed startup. The old host performs its own
replacement stop. A host that is busy, attached, or too old to shut down without marking
settled sessions Stopped is reported instead, and `/agents restart` replaces it after a
confirmation; `autoUpdateHost: false` makes every replacement manual.
A host shutdown aborts runs that were in flight and keeps settled sessions restorable, so a
restart brings them back live from their own history; only a session you stopped with Ctrl+K
stays Stopped.

## Limits

Managed runtimes share one host process. After a host crash, persisted conversations
return and interrupted runs are marked failed; requests are never replayed. Live
dialogs do not survive a host crash.

Pi 1.3.x and 1.4.x require guarded, instance-local private UI/shutdown adapters. Global Pi
code is never patched. Pi 1.4.x moved extension dialogs into a stack, and the editor
cancellation adapter reads either layout. Third-party extensions may share globals across managed
runtimes; isolation and different per-session themes/providers need care.
Direct process-stdio output goes to the host log. External editors and interactive
subprocesses inheriting stdio are not supported by this Terminal transport.

## Local development

Clone the extension and install its development dependencies:

```sh
git clone https://github.com/sidstack/pi-codex-agents.git
cd pi-codex-agents
npm ci
npm run build
```

Load the built extension for one Pi process with `pi -e "$PWD/dist/extension.js"`,
or install this checkout with `pi install "$PWD"` and restart Pi (or run `/reload`).
There is no separate `pi-codex-agents` executable.

## Development checks

```sh
npm run build
npm run typecheck
npm test
npm run smoke
```

Smoke checks use real Pi views, temporary state, and a deterministic local provider:
no paid calls or user configuration changes. See [architecture](docs/ARCHITECTURE.md).

Optional behavior lives in independent feature modules; contributor conventions
and dependency boundaries are in [CONTRIBUTING.md](CONTRIBUTING.md) and
[architecture](docs/ARCHITECTURE.md). Generated `dist/` is shipped
for Git installs without a compiler. Run `npm run release:check` for the full
installed-package check. See [security](SECURITY.md) for trust boundaries.

## Credits and trademarks

The command center and drop-in/drop-out session behavior are modeled on the agent
dashboard of OpenAI's Codex product. This project is not an OpenAI product and contains
no Codex code: it talks only to Pi, starts only its own host process, and contacts no
OpenAI service.

Codex is a trademark of OpenAI OpCo, LLC. Pi and its marks belong to the Pi project.
See [trademarks and affiliation](docs/TRADEMARKS.md) for the full notice, the reason for
this name, and the branding rules contributors follow.
