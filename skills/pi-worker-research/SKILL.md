---
name: pi-worker-research
description: Research a specific engineering or product decision as a supervised local Pi worker.
---

Follow the shared [worker contract](../pi-session-worker/SKILL.md).

Bound the question and decision first. Prefer current official documentation and primary repositories; verify changing facts and release dates. Cite direct supporting pages and distinguish evidence from inference. Produce a short comparison and concrete recommendation, including material uncertainty. Do not invent adoption, pricing, benchmarks or compatibility. Avoid unbounded link collection and copied manuals; send a useful initial evidence note before expanding the search.

For long work, complete one evidence-backed milestone, send the parent a compact
update, and check the inbox before proceeding. Leave a handoff for a fresh context
when needed; do not expand scope or spawn additional agents.

Use the available search and page-fetch tools before shell HTTP commands. With
pi-web-access, request `web_search` with `workflow: "none"`, a bounded query and
`numResults: 3`; this returns sources without a curator or summary model call.
Follow primary URLs with `fetch_content`; retrieve stored results with
`get_search_content` only when the search actually returned useful results.
If tools are missing or fail, report the exact blocker to the parent and continue
with local evidence or a known primary URL. Do not loop through guessed curl
commands or repeatedly retrieve an empty/failed curator result. Do not enable
paid providers, change credentials or change search settings on your own.
