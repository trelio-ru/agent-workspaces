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
for a plain company. Unless the already-shared chat flow below applies, in an
encrypted company the user creates the card in
Trelio's protected browser UI, where its name, description, field labels, and
eventual value are encrypted locally.

## Configure a value

Let the user use Trelio's protected browser form when practical. When the
value already exists in a trusted local producer/file, an active Run may send
it straight to the bridge without model-visible transport:

- for a file, call `continue_trelio_workspace_action` with
  `operation=secret_set_file`, the exact opened `workingDirectory`, and only
  `secretId`, absolute `filePath`, and optional `format=fields-json`;
- for a producer/stdin value, read `setup-and-recovery.md` and use its bounded
  process-only secret-input route. Never put producer output in an MCP call;
- for several fields, the file/producer contains one JSON object with exact
  string/null values and explicit `fields-json` format.

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

Use local `trelio-remote-skills.continue_trelio_local_action` with
`nativeTool=save_known_agent_secret` for both plain and encrypted companies,
only when every condition below is true:

- `allowAgentSaveChatSecrets=true` for the exact company;
- the exact value was already supplied in the current conversation and the
  user directly asked to save that value durably; merely sharing it, asking
  to sign in, or asking to use it is not storage consent;
- the target is an existing secret with `manage` or a new card in an exact
  scope where the user can create secrets, and an applicable Agent Run is active;
- the call supplies exact `expectedCurrentVersion`, a stable
  `clientRequestId`, and literal
  `userExplicitlyRequestedPersistentStorage=true`.

The user's request to save, including a request accompanying the value, is
sufficient: do not ask for another confirmation or manual re-entry. Tell the
user that the original plaintext remains in the chat and may remain
in the AI client's tool history. Send it only in the local sensitive tool input;
never echo or copy it elsewhere.

Pass the exact `companySlug`, `nativeTool`, and an `arguments` object with:

- `secretId` for an existing card, or `newSecret` containing
  `scopeType`, `scopeId`, `name`, optional `publicDescription` and
  `templateType`, and `fields` with exact `key/label/type/required`;
- `runId`, exact `expectedCurrentVersion` (zero for creation), stable
  `clientRequestId`, and `userExplicitlyRequestedPersistentStorage=true`;
- exactly one of `value` (one field) or `values` (named string/null fields).

This local flow replaces the whole bundle in both modes: include all required
fields; omitted, empty, or null optional fields are cleared. The plugin performs
a value-free preflight and locally encrypts E2EE metadata and values before one
atomic server write. Never author internal `localWrite`, use a generic payload
uploader, or turn chat values into shell/stdin/file/clipboard transport.

The loaded local tool must advertise `save_known_agent_secret`. An older
generic local-action tool is not this capability: update the plugin through
the normal compatibility flow or use the protected form.

On an uncertain result, read current safe metadata and retry the exact input
with the same request ID; never invent a new ID to bypass a conflict. Revoked
policy/ACL, stale version, expired Run, and pending device access stop the save.
Follow the normal pairing/device setup route when needed; never request a
company key through chat. Use the protected browser form if company opt-in or
the local capability is unavailable. Legacy direct remote
`save_known_agent_secret` accepts only existing plain-company values and is
not the default flow. Never ask for a new value
merely to make the chat exception available.

## Executable checkout

When an authorized executable needs a value, call
`prepare_agent_secret_checkout` for the exact current Run, executable, and
field set, then execute the single returned `bridge.action` through its exact
local server/tool and opened `workingDirectory`. Append only the intended
child arguments to `parameters.arguments`; never change its executable or grant.
The bridge consumes the
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
action. First open the exact login page in the client's built-in browser using
its ordinary allowed browser tool, inspect only the empty form, and identify
fields plus the login/next button before requesting the grant. A host/tool/site
denial is binding: the native helper must never bypass it.

Call `prepare_agent_secret_browser_fill` with the current Run and ordered steps:

- put username and password on the same page in one step;
- use exact HTTPS URLs and one visible supported top-level field per selector;
- native AX/UIA requires exact `#id` or `[id="..."]` selectors for both fields
  and any `submitSelector`; do not guess or assign ids;
- when the final login button has no supported id (for example, only
  `button[type="submit"]` identifies it), omit the final `submitSelector` and
  use `browser=embedded`. After successful fill, click the button identified
  from the empty form in that same tab with the ordinary browser tool, without
  a snapshot or field read. Embedded-only mode keeps this separate click bound
  to the prepared tab instead of silently filling a different Chrome profile;
- non-final native steps require a supported `submitSelector`. If a field or
  intermediate button has no supported id, choose the declared Chrome flow
  before delivery; do not weaken selectors or split a same-page credential.

Execute exactly one returned `bridge.action` through its declared local
server/tool and exact opened `workingDirectory`. Default `browser=auto` prepares
the already-open embedded Codex/Claude Code browser on macOS/Windows before
one-use consume; it fills automatically through direct native element setters.
E2EE values are decrypted only in bridge memory. No value enters tool arguments,
clipboard, argv, ambient environment, output or field read-back.

Chrome is an automatic fallback only before checkout when native platform,
client, compiler, Accessibility permission, application/tree or selector/step
support is unavailable. A 404 from an older backend's value-free context route
uses the existing Chrome consume flow on the same host. `browser=embedded`
requires the embedded surface; `browser=chrome` explicitly chooses Chrome.
Wrong app identity/URL, missing, ambiguous, hidden or read-only fields and
transport/auth failures stop the operation. After consume or partial fill,
never switch browser, request another grant or retry the value blindly.

`client_unsupported` means the Run has no supported hook-verified client
identity; it does not prove that the installed app lacks a built-in browser.
Use the diagnostics route and preserve the exact reason. Do not enable model
restrictions as a workaround or author runtime metadata/proofs. With a fixed
backend, resume/reopen the Run through the returned action and a fresh approved
hook proof before preparing a new fill; old grants are not repaired in place.

macOS needs the system Swift compiler (Command Line Tools) and user-granted
Accessibility access; Windows needs the system .NET Framework WPF/UIA runtime.
The bridge builds its helper privately without downloads, elevation or granting
permissions. Missing prerequisites produce a safe fallback reason; they do not
justify changing OS permissions automatically.

A successful result means filled fields/explicit submit, not proven login.
Do not snapshot or inspect filled fields. If no final submitSelector was given,
click the button identified before filling, then inspect only non-sensitive
authentication state. Keep the selected browser session/profile across steps.
Never create separate grants for login and password on the same page or ask the
user to focus a field. Native session values are intentionally delivered to the
authorized website; this is not protection against browser telemetry or another
process running as the same OS user.

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

If an older backend returns only a secret command, use the bounded legacy route
in `setup-and-recovery.md`. Never probe PATH or scan plugin caches.
