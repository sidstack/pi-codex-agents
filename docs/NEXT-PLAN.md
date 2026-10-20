# Next work after the current PR

Status: deferred backlog. Finish and validate the current launch/session and fuzzy
directory picker changes, merge the current PR, then take up these two features.
Fix bugs encountered during that work as they arise. This plan does not add scope
to the current PR.

## 1. Session titles

Problem: sessions currently use directory names as their titles, making several
sessions in the same project hard to distinguish.

Outcome: each session has a useful, persistent title that distinguishes its work;
the directory remains available as context. Preserve session identity, history,
drafts and existing restore behavior when a title changes.

Before implementation, settle the title source (manual, generated, or both), when
titles update, and whether a user-set title prevents automatic replacement.
Existing sessions need a compatible fallback without rewriting conversation
history. Cover multiple sessions in one directory, restart/restore, and title
updates in the command center.

## 2. Optional native MCP control

Outcome: an `enableMcp` configuration toggle exposes an MCP server that other
agents can connect to and use to control this project's native managed sessions.
Keep it disabled by default, with documented setup and cleanup when disabled.
Agree on the transport, API and access boundary before implementation, as required
by the repository guidelines.

Reference: `../pi-codex-subagents`, particularly `docs/ARCHITECTURE.md` and its
tools/service/runtime split. That project currently provides an independent
Unix-socket worker service with a stdio MCP bridge, durable cursor-based mail,
explicit wake, scoped controller ownership, bounded waits, and inspect-before-
retry behavior after uncertain mutations. Its workers own separate runtimes and
export settled history snapshots; they do not control this project's live host.

Use those control semantics as a reference while integrating with the native
host/session lifecycle here. Avoid duplicate runtimes or multiple history writers.
Define the minimal tool set for creating/listing sessions, sending work, observing
status/results and stopping work; decide whether durable inbox/wake semantics are
needed and how callers identify and control their sessions. Preserve interactive
terminal ownership and attachment behavior when external agents act on a session.

Acceptance should include enabled/disabled behavior, connection setup, session
ownership, interactive/external control interaction, disconnect survival, uncertain
mutation outcomes, bounded waits, host restart, and server cleanup. Use isolated
temporary data and fake models. Document the configuration and client setup, and
run the repository's full release checks before submitting a separate PR.

## Working approach

Continue improving worker/supervisor context from observed results: small scoped
assignments, explicit handoffs, independent review, and meaningful validation.
Keep product implementation delegated while the supervisor tracks requirements,
dependencies, evidence and integration. Do not add more feature work beyond these
two items without a new request.
