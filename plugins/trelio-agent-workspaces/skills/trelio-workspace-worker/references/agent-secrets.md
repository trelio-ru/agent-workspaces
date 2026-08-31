# Agent Secrets

Read this file completely before discovering, creating, persisting, checking
out, filling, revealing, transferring, or recording a dependency on an Agent
Secret.

Use `list_agent_secrets` only for safe metadata. If access is missing, call
`request_agent_secret_access`; never ask the user to paste a password, token,
private key, or encryption key into chat. Values never belong in prompts, MCP
output, argv, ambient environment, workspace files, Git, comments,
checkpoints, handoffs, or logs.

## Choose storage before creation

Before creating a record or saving an already-known value, call
`list_agent_secrets` for the exact target scope and read its company-level
`storagePolicy` and `allowAgentSaveChatSecrets`. Pass an explicit `storageMode`
to `create_agent_secret_placeholder`:

- `prefer_trelio`: choose `trelio` unless the user explicitly requests local
  storage.
- `contextual`: choose `local_device` only for a personal credential used
  interactively on one paired device with no team, multi-device, or unattended
  need. Choose `trelio` for shared ACL, several devices, background automation,
  or durable device-independent availability. Ask the user before creating the
  immutable record when the context is ambiguous.
- `local_only`: choose only `local_device`.

A direct instruction may specialize `prefer_trelio` or `contextual`, but cannot
override company `local_only`. A policy change never migrates an existing
record.

For a `trelio` record, let the user configure the value in Trelio's protected
browser form. When the value already exists in a local producer/file, an active
Run may send it straight to the bridge without model-visible transport:

- one field: `PRODUCER | trelio-workspace secret set --secret UUID` or
  `trelio-workspace secret set --secret UUID --file PATH`;
- several fields: send one JSON object with exact string/null field values and
  mandatory `--format fields-json`, through stdin or the file form.

Without the format flag, JSON-looking bytes remain a scalar for compatibility.
Never split one logical multi-field credential into separate Agent Secrets
merely to avoid `--format fields-json`.

## Already-shared chat values

Use `save_known_agent_secret` only when every condition below is true:

- the exact-scope metadata returned `allowAgentSaveChatSecrets=true`;
- the value was already supplied in the current conversation and the user
  separately asked to save that exact value durably; merely sharing it, asking
  to sign in, or asking to use it is not storage consent;
- the target is an existing `trelio` secret with `manage`, and an applicable
  Agent Run is active;
- the call supplies exact `expectedCurrentVersion`, a stable
  `clientRequestId`, and literal
  `userExplicitlyRequestedPersistentStorage=true`.

Tell the user that the original plaintext remains in the chat and may remain
in the AI client's tool history. Send it only in that one sensitive tool input;
never echo or copy it elsewhere. Do not use this path for `local_device`, infer
consent from the company flag, or ask the user to provide a new value merely to
make this exception available. If any condition fails, use the protected form
or an existing-local-source bridge flow.

## Local-device records and executable checkout

For `storageMode=local_device`, `secret set` stores the complete structured
container only in the paired bridge's owner-only private config. Trelio receives
version, field, and attestation metadata, never a value or digest. The setup
page cannot launch the bridge; it only shows the latest server-recorded device
confirmation.

To move local records, copy only the `agent-secrets/` subtree from private
config. Never copy device-session data. Pair the replacement computer
separately, open an active Run, then run
`trelio-workspace secret adopt --secret UUID`. Adoption reattests the exact
current version without uploading values; it cannot erase an offline copy from
the old device.

When an authorized executable needs a value, call
`prepare_agent_secret_checkout` for the exact current Run and executable, then
execute the returned
`trelio-workspace secret exec --grant ... -- COMMAND`. The bridge consumes the
value once through the authorized stdin, scoped env, or private temporary-file
mode. Never replace the executable with a shell, logger, `env`, `printenv`,
`cat`, or another value-revealing program.

## Browser authentication

Before requesting checkout or browser fill, use the selected service runtime's
content-free authentication probe when available. If it confirms that the
current session is already authenticated, continue with that session and do
not request or consume the Agent Secret. The dedicated profile keeps provider
session state; do not clear it to force another login. An unavailable or
ambiguous probe is not proof of logout and does not authorize reading fields.

Never pass a named secret field to a literal-text Browser/Chrome/Computer Use
action. Call `prepare_agent_secret_browser_fill` once with the exact current
Run and ordered `steps`:

- put every field on one page, such as username and password, in one step;
- use another step only for a later page, such as TOTP;
- give every step an exact HTTPS URL and every field a precise CSS selector for
  one visible supported top-level `input` or `textarea`.

Execute exactly one returned
`trelio-workspace secret browser-fill --grant ... --target ...` command. The
bridge fills automatically in one dedicated window/tab/profile. Never create
separate grants for login and password, ask the user to focus a field, use the
clipboard, read a value back, or transfer it to a universal browser tool. If a
selector is missing, ambiguous, hidden, disabled, unsupported, cross-origin,
or the page leaves its bound URL/origin, stop the whole session without a
fallback window or value retry.

A user-controlled login is a separate safe handoff. When the user explicitly
prefers it or dedicated fill reports `browser_unavailable`, offer one visible
surface and wait for completion. Codex's in-app Browser is a separate surface;
do not assume that it inherits the system Chrome password manager. System
Chrome/Edge may use its own password manager. Never type, paste, inspect,
screenshot, or read credentials for the user. Afterward verify only
non-sensitive authenticated state. Do not open a second window automatically
after URL/selector/origin failure; explain the failure and let the user choose.

## Protected reveal

If the user explicitly asks to see a Trelio-stored value, route them to the
protected Trelio reveal for the exact record. Check safe `canReveal`; request
`reveal` access when absent. When metadata contains `publicUrl`, give that exact
value-free URL to the user but do not open or inspect it with Browser, Chrome,
or Computer Use.

The user performs fresh authentication, selects one or several fields, and
uses any copy action as a direct user gesture. Warn that the OS or clipboard
manager may retain copied text after Trelio's best-effort clear. Never echo the
plaintext in chat. `local_device` has no browser reveal.

## Durable workspace dependency

Only after a selected secret becomes a real durable dependency, record this
safe reference in `WORKSPACE_CONTEXT.md`:

```markdown
- Agent Secret: `Current safe name` (`secretId: 00000000-0000-4000-8000-000000000000`) — exact purpose.
```

`secretId` is canonical. Refresh the current safe name with
`list_agent_secrets` when revisiting it. Never store the value, version,
checkout grant, setup URL, runtime arguments, or merely discovered but unused
secrets.

Treat a leading `trelio-workspace` in returned secret commands as the logical
launcher of this loaded plugin. Use PATH when available; otherwise replace
only the first token with Node.js 22+ and this skill's bundled
`../../scripts/trelio-workspace.mjs`, preserving every other token. Never scan
plugin caches or run a command merely to discover failure.
