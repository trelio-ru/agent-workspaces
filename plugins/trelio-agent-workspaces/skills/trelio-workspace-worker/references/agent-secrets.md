# Agent Secrets

Read this file completely before discovering, creating, configuring, checking
out, filling, revealing, or recording a dependency on an Agent Secret.

Use `list_agent_secrets` only for safe metadata. If access is missing, call
`request_agent_secret_access`; never ask the user to paste a password, token,
private key, TOTP seed, or company encryption key into chat. Values never
belong in prompts, ordinary MCP output, argv, ambient environment, workspace
files, Git, comments, checkpoints, handoffs, or logs.

## Storage contract

Storage follows the company's exact encryption state and is not a user choice:

- a plain company uses `storageMode=trelio`. Trelio Vault encrypts the bundle at
  rest with the server keyring and opens it only inside an authorized
  reveal/checkout;
- an encrypted company uses `storageMode=company_e2ee`. The browser or paired
  bridge seals the value with the company scope key before upload. Trelio
  stores the signed ciphertext and cannot decrypt it.

There is no `local_device` Agent Secret mode, company storage policy, local
secret file, transfer, or adoption command. If the user wants a credential to
remain local only, do not create or configure an Agent Secret and do not send
the value to Trelio. Explain the consequence when relevant: a credential that
is not an Agent Secret cannot use Trelio ACL, reveal, one-use grants,
multi-device access, or unattended Workspace execution.

Before creating a record, call `list_agent_secrets` for the exact target scope
to detect an existing card and read `allowAgentSaveChatSecrets`. Do not ask the
user to choose a storage mode and do not pass one to
`create_agent_secret_placeholder`. MCP placeholder creation is available only
for a plain company. In an encrypted company the user creates the card in
Trelio's protected browser UI, where its name, description, field labels, and
eventual value are encrypted locally.

## Configure a value

Let the user use Trelio's protected browser form when practical. When the
value already exists in a trusted local producer/file, an active Run may send
it straight to the bridge without model-visible transport:

- one field: `PRODUCER | trelio-workspace secret set --secret UUID` or
  `trelio-workspace secret set --secret UUID --file PATH`;
- several fields: send one JSON object with exact string/null field values and
  mandatory `--format fields-json` through stdin or the file form.

Without the format flag, JSON-looking bytes remain one scalar value for
compatibility. Never split one logical multi-field credential into separate
Agent Secrets merely to avoid `--format fields-json`.

`secret set` checks the plugin and fetches a value-free write context before
reading stdin/file. For a plain company the backend encrypts the accepted
value. For an encrypted company the bridge requires a ready company encryption
device, builds a signed `agent_secret.value` payload in memory, and sends only
ciphertext. Because the server cannot merge encrypted fields, every E2EE
rotation is a complete replacement: include every required field; omitted,
empty, or null optional fields are removed. The bridge never writes Agent
Secret values to its private config or Workspace.

## Already-shared chat values

Use `save_known_agent_secret` only when every condition below is true:

- `allowAgentSaveChatSecrets=true` for the exact company;
- the exact value was already supplied in the current conversation and the
  user separately asked to save that value durably; merely sharing it, asking
  to sign in, or asking to use it is not storage consent;
- the target is an existing plain-company `trelio` secret with `manage` and an
  applicable Agent Run is active;
- the call supplies exact `expectedCurrentVersion`, a stable
  `clientRequestId`, and literal
  `userExplicitlyRequestedPersistentStorage=true`.

Tell the user that the original plaintext remains in the chat and may remain
in the AI client's tool history. Send it only in that one sensitive tool input;
never echo or copy it elsewhere. This MCP path cannot save an encrypted-company
secret because MCP has no company key. Use the protected browser form or
`secret set` from an existing local source instead. Never ask for a new value
merely to make the chat exception available.

## Executable checkout

When an authorized executable needs a value, call
`prepare_agent_secret_checkout` for the exact current Run, executable, and
field set, then execute the single returned
`trelio-workspace secret exec --grant ... -- COMMAND`. The bridge consumes the
grant through the authorized stdin, scoped env, or private temporary-file mode.
In an encrypted company the server returns only the ACL-gated ciphertext; the
bridge validates its company/scope/secret/version binding, decrypts it in
memory, selects only the granted fields, and derives a current TOTP code
locally. Never replace the executable with a shell, logger, `env`, `printenv`,
`cat`, or another value-revealing program.

An installation-managed credential is a separate provider contract, not an
Agent Secret. Follow the exact
`prepare_agent_skill_managed_credential_checkout` response: only
`reusePolicy.mode=time_bound` permits reusing the unchanged
`bridge.argvPrefix` in the same Run and release before server `expiresAt`.
Never extend that lease to an Agent Secret, TOTP, browser-fill, or
recovery/setup credential, and never cache the value locally.

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
bridge opens one dedicated window/tab/profile, decrypts E2EE values locally
when needed, and fills automatically only the fields bound by the grant. Never
create separate grants for login and password, ask the user to focus a field,
use the clipboard, read a
value back, or transfer it to a universal browser tool. If a selector is
missing, ambiguous, hidden, disabled, unsupported, cross-origin, or the page
leaves its bound URL/origin, stop the whole session without a fallback window
or value retry.

A user-controlled login is a separate safe handoff. When the user explicitly
prefers it or dedicated fill reports `browser_unavailable`, offer one visible
surface and wait for completion. Codex's in-app Browser is a separate surface;
do not assume that it inherits the system Chrome password manager. System
Chrome/Edge may use its own password manager. Never type, paste, inspect,
screenshot, or read credentials for the user. Afterward verify only
non-sensitive authenticated state.

## Protected reveal

If the user explicitly asks to see a stored value, route them to the protected
Trelio reveal for the exact record. Check safe `canReveal` and request `reveal`
access when absent. When metadata contains `publicUrl`, give that exact
value-free URL to the user but do not open or inspect it with Browser, Chrome,
or Computer Use.

The user performs fresh authentication, selects one or several fields, and
uses any copy action as a direct user gesture. In an encrypted company the
browser opens the ciphertext locally with the company key; Trelio still cannot
read the value. Warn that the OS or clipboard manager may retain copied text
after Trelio's best-effort clear. Never echo plaintext in chat.

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
