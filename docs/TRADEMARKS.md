# Trademarks and affiliation

`pi-codex-agents` is an independent, community-maintained open-source project. It is
**not affiliated with, endorsed by, sponsored by, authorized by, or produced by OpenAI**.
OpenAI has no knowledge of this project and takes no responsibility for it.

**Codex** is a trademark of OpenAI OpCo, LLC (US registration no. 8423912). Pi and its
marks belong to the Pi project. All other trademarks are the property of their respective
owners. They appear here only in plain words, to name what this project draws on and what
it does not connect to. Nothing in this repository licenses any third-party mark.

## What this project is

A native Pi extension that runs Pi's own coding-agent SDK inside a long-lived host
process, plus a keyboard-driven command center for the sessions that process manages.
Its only runtime dependencies are the Pi packages declared as peer dependencies:
`@earendil-works/pi-coding-agent` and `@earendil-works/pi-tui`. Model access comes from
whatever provider your own Pi installation is configured with.

## What this project is not

- Not an OpenAI product, feature, plugin, port, fork, or derivative work.
- Not a client, wrapper, adapter, bridge, or compatibility layer for OpenAI Codex. This
  repository contains no Codex code and never invokes a Codex CLI or SDK. The only process
  the extension starts is its own `dist/host-entry.js`.
- Not connected to any OpenAI service. Nothing here authenticates to OpenAI, reads OpenAI
  credentials, or contacts an OpenAI endpoint on Codex's behalf.
- Not a member of the Codex product line. "agents" here means Pi sessions this extension
  keeps alive; it is not a Codex feature name.

The `openai` npm package appears in `package-lock.json` only as a transitive dependency of
Pi's own `@earendil-works/pi-ai` package. This project neither imports nor configures it.

## Why it is named this

The name records where the interaction design came from: the command center and
drop-in/drop-out session behavior were modeled on the agent dashboard of OpenAI's Codex
product. That reference describes inspiration only. It claims no origin, sponsorship,
endorsement, partnership, or interoperability, and no Codex asset, artwork, or copy is
reproduced anywhere in this project.

If OpenAI or its representatives raise the name with the maintainer, this project will
rename rather than argue. See [Renaming on request](#renaming-on-request).

## Contributor branding rules

Do not add any of the following to code, UI strings, docs, the repository, or its GitHub
description and avatar:

- OpenAI or Codex logos, wordmarks, icons, badges, artwork, fonts, or color treatments.
- Screenshots, mockups, or marketing copy taken from OpenAI materials.
- Wording that implies OpenAI authorship, sponsorship, endorsement, or compatibility:
  `official`, `from OpenAI`, `by OpenAI`, `ported from Codex`, `based on Codex`,
  `Codex-compatible`, `works with Codex`, `Codex for Pi`, `Codex agents`.
- Codex-style feature names in user-visible surfaces. Use this project's own vocabulary:
  managed session, host, command center, active, inactive, draft.

This project ships no image, icon, or font assets. Keep it that way; the notice above is
part of what keeps the naming defensible.

## Renaming on request

The maintainer has no commercial interest in this name. If OpenAI or its representatives
contact the maintainer about it, informally or by formal notice, the maintainer commits to
renaming the npm package, GitHub repository, environment variables, and application
directory, publishing a migration path for existing state and configuration, and
deprecating the old npm package with a pointer to the new one, instead of defending the
name.

## Attribution

Session UX inspired by OpenAI Codex's agent dashboard. Codex is a trademark of OpenAI
OpCo, LLC.
