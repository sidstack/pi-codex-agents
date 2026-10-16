---
name: pi-worker-test
description: Develop focused regressions or measurements as a supervised local Pi worker.
---

Follow the shared [worker contract](../pi-session-worker/SKILL.md).

Test an observable invariant or failure, not source wording or implementation structure. Use deterministic barriers for races and temporary files/local fake providers for integration; no paid calls or real user state. Where possible, prove the regression fails before the fix and passes after it. Record exact commands and outcomes. Keep measurement workloads and limitations explicit; a small heap change is not proof of complete reclamation. Do not broaden production changes to make a test pass.

For long work, complete one evidence-backed milestone, send the parent a compact
update, and check the inbox before proceeding. Leave a handoff for a fresh context
when needed; do not expand scope or spawn additional agents.
