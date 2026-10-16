---
name: pi-worker-implement
description: Implement one bounded change as a supervised local Pi worker.
---

Follow the shared [worker contract](../pi-session-worker/SKILL.md).

Start from the concrete trigger and expected behavior. Read the specified implementation and nearest meaningful checks. Produce a small patch early, then validate it. Keep interfaces and dependency direction intact. Avoid speculative abstractions, unrelated cleanup, new dependencies and mirrored tests. If the requested change spans many modules, send the smallest viable milestone and remaining dependencies to the parent. Do not edit generated output unless explicitly assigned.

For long work, complete one evidence-backed milestone, send the parent a compact
update, and check the inbox before proceeding. Leave a handoff for a fresh context
when needed; do not expand scope or spawn additional agents.
