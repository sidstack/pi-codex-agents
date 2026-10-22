# Security review — 2026-10-16

Scope: extension launcher, persistent host, native runtime adapters, IPC, filesystem
ownership, foreign history, package contents, dependencies, and release automation.
This is a source review with regression/integration checks, not an independent audit.

## Findings addressed

| Finding | Change and evidence |
| --- | --- |
| Symlinked logs or shared state could expose private data | Reject symlinked state paths; log opens use `O_NOFOLLOW`; enforce owned regular files, one hard link, private directory/file modes. Security regression tests cover symlinks, escaped histories, hard links, and permissions. |
| Registry or framing input could consume excessive memory | Private JSON reads/writes have a matching 16 MiB cap, metadata registry writes are capped at 2 MiB before atomic replacement, and drafts are separate private files; JSONL frames are bounded to 1 MiB server / 4 MiB client. Oversized records are rejected, including records arriving entirely in one chunk. Tests cover partial framing and UTF-8 byte limits. |
| Local clients could grow request queues without bound | Limit the host to 32 connections and 64 queued requests per connection; bound frontend pending requests and input records as well; cap socket output backlog at 2 MiB. Disconnected clients cannot execute queued operations. |
| Metadata could inject terminal controls | Strip control sequences from session names, paths, and error metadata shown by the board. Native Pi transcript rendering is retained. Regression checks cover OSC/CSI controls. |
| History recovery could create concurrent writers | Foreign files remain read-only and fork to new native IDs. Managed resumes validate containment/ownership and require the lifetime host lock. Real host tests verify original bytes stay unchanged and resumed IDs remain stable. |
| Detached startup could accidentally require a second SDK installation | Resolve Pi peers from the actual supported Pi installation through a scoped host resolver. Packed-install tests use a separate Pi and no extension-local SDK/compiler. |
| Broken config could throw on every input event | Validate snapshots on host/frontend startup. Optional features are assembled once and cleaned up on close. Unknown options and invalid values are rejected. |
| Releases could ship stale wrapper paths or require a compiler | Build removes old output; Git releases ship generated modules; prepare validates version/source identity without development dependencies. Fresh npm and Git-style preparation checks pass. |
| Publishing could expose credentials or use long-lived tokens | Explicit package allowlist, release identity guard, pinned workflow actions, protected-environment instructions, and OIDC/provenance workflow. Nothing has been published. |

## Evidence

- Unit tests cover ownership, lifecycle, inactive sessions, optional-feature cleanup,
  disabled feature assembly, private files, untrusted metadata, framing, and config.
- Real Pi native tests cover background completion, cwd-bound tools, pending dialogs,
  takeover, crash recovery, simultaneous host starts, idle restoration, and shutdown.
- Fresh packed installation uses an independent real Pi installation and empty
  settings/state. Pi loads the installed package without `-e`. It creates, detaches,
  reconnects, unloads/restores, stops, and uninstalls while preserving native history.
- Git-style `npm install --omit=dev --legacy-peer-deps` validates shipped output
  without a local compiler or SDK peer installation. Remote GitHub installation
  awaits creation of an approved public repository.
- `npm audit --json` reported **0 known vulnerabilities** in the locked tree on the
  review date. This does not cover undisclosed vulnerabilities or installed user
  extensions, and results can change as advisories are published.
- A credential-pattern scan of **240 unique Git history blobs** found no matching
  private-key blocks, GitHub/npm token patterns, AWS access-key IDs, or OpenAI-style
  keys. This is a heuristic scan, not proof that history is safe for publication.
  Old development history contains personal paths and should be reviewed separately.

## Remaining boundaries and MVP limitations

1. **Same user is trusted.** The private Unix socket is local, with mode 0600;
   there is no TCP listener. Processes with the same UID can read host state and
   control sessions. No claim of isolation from same-user malicious processes.
2. **No sandbox.** Native tools and third-party extensions run with the user's
   privileges. Managed runtimes share a process and may share extension globals.
   Pi's trust policy is preserved; it cannot contain arbitrary trusted extension code.
3. **Ordinary Pi cannot honor this host's file ownership automatically.** Stop the
   host before resuming a managed file through ordinary Pi. Read-only listing is
   safe; simultaneous writers outside the managed host are unsupported.
4. **Crash recovery is conservative.** Stored history/drafts return; interrupted
   runs are marked failed. Requests/tools are never replayed. Live dialogs and
   unpersisted extension memory do not survive a host crash or idle disposal.
5. **Private native APIs are version-bound.** Pi >=1.3.0 <1.5.0 is supported, tested with 1.4.0. Guarded
   instance adapters touch UI and shutdown behavior, and choose between the 1.3.x single-dialog
   and 1.4.x dialog-stack layouts at runtime; no global patches are applied.
6. **Transport supports Pi Terminal methods.** Direct process stdio goes to a private
   host log; external editors and inherited-stdio interactive programs are unsupported.
   Native transcript output retains Pi's usual trust and rendering behavior.
7. **Filesystem checks are defense in depth.** Checks do not establish a sandbox
   against races caused by another process running as the same trusted UID.
8. **Package publication uses guarded CI.** Release tags require a clean matching
   version and the npm environment's maintainer review before trusted publishing.

## Critical-review follow-up

The first smoke suite missed blocked-dialog shutdown and update/attachment races.
The critical-review fixes add deliberate cancellation without approval, independent
running/prompt flags, atomic `safeUpdate`/`settledStop` checks, isolated restoration,
bounded cached history discovery, and failure reporting for unexpected socket loss.
The release checks exercise these regressions with focused lifecycle tests and native
integration fixtures. A socket loss does not prove the host is alive.

Automatic naming labels a session from its first message locally, then sends up to 2,000
characters of that message to the selected provider, or to the configured `nameModel`, in at
most three bounded requests per session, subject to normal provider billing/trust. It
adds no tool execution, is cancelled only by that session's own disposal or host close, and
can be disabled with `autoName: false`. The stored label is a short session-name entry, the
same native metadata `/name` writes. No credentials are copied into session metadata.
