---
name: pi-worker-review
description: Critically review a bounded code path as a supervised local Pi worker.
---

Follow the shared [worker contract](../pi-session-worker/SKILL.md).

Trace ownership and asynchronous boundaries, failure handling and observable outcomes. Prefer a reachable interleaving or input over a theoretical concern. Reproduce with a small deterministic barrier or real integration fixture where practical. Report severity, trigger, expected/actual behavior and exact evidence. Separate confirmed bugs, source-supported risks and unknowns. Do not patch implementation unless assigned. No generic refactor wishlist or exhaustive repository browsing.

For long work, complete one evidence-backed milestone, send the parent a compact
update, and check the inbox before proceeding. Leave a handoff for a fresh context
when needed; do not expand scope or spawn additional agents.
