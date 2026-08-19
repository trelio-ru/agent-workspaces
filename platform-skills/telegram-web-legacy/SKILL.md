---
name: telegram-web-legacy
description: Archived signed Telegram Web K runtime retained only for source history and controlled maintenance. Do not select or invoke it for ordinary Telegram work; the active compact browser integration is telegram-web.
---

# Telegram Web Legacy

This skill is an inactive source archive. Do not route Telegram work here, do
not run its script, and do not create a login, consent, browser profile,
connection, assignment, or fallback for it. The active integration is
`telegram-web`, bundled with the current `trelio-agent-workspaces` plugin.

The legacy script and regression remain beside this file only so maintainers can
audit immutable historical releases without rewriting published bytes or losing
their security rationale. A maintainer audit must stay read-only and must not
open a real Telegram session. If operational restoration is ever approved, it
requires a new reviewed release and an explicit reactivation decision; this
archive itself is not an executable recovery path.
