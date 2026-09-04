---
name: trelio-diagnostics
description: >-
  Diagnose Trelio Agent Workspaces installation, loaded plugin version, hooks,
  MCP/OAuth, bundled bridge, Node.js, Git, pairing, and stale-session failures
  in Codex or Claude Code. Use when the user asks to check or repair Trelio
  setup or reports a hook, MCP, OAuth, bridge, pairing, Git, Node, version, or
  post-update current-task error. Do not use for ordinary Trelio task work or
  working-folder onboarding when no failure or health-check request exists.
---

# Trelio Diagnostics

Diagnose the exact client and loaded plugin before suggesting a repair. Keep
the first pass read-only unless the user explicitly asked to fix the detected
problem. Never print or copy OAuth tokens, bridge device-session tokens,
pairing verifiers or IDs, runtime private keys, cookies, Agent Secrets, local
credential files, or raw hook state.

## Keep the layers separate

Report these as independent checks:

1. **Installed and loaded plugin.** An installed marketplace version can be
   newer than bytes already loaded by the current task.
2. **Hook definition and client approval.** Bundled doctor can prove that the
   loaded `hooks.json` has the expected definition. Only the client can report
   whether the user reviewed and approved that definition.
3. **Remote `trelio` MCP and OAuth.** This is independent of the local stdio
   `trelio-remote-skills` server and local bridge pairing.
4. **Bundled local bridge.** Node.js 22+, standalone Git 2.28+, pairing state
   and runtime-session hygiene do not prove remote OAuth readiness.

Never treat success or failure in one layer as proof about another.

## Run the local diagnostic

Resolve the actual host from host-owned context. Do not infer Claude Code only
from `CLAUDE_PLUGIN_ROOT`, which Codex may provide for compatibility.

Run this loaded plugin's exact bundled bridge through its platform launcher,
without scanning plugin caches or picking another version. On POSIX use:

```text
../../scripts/launch-trelio-node ../../scripts/trelio-workspace.mjs doctor --json
```

On native Windows use the sibling
`../../scripts/launch-trelio-node.cmd` with the same script and arguments. The
launcher accepts only Node.js 22+, prefers host-owned Codex runtime hints and
the deterministic bundled Codex runtime, then falls back to an installed
system Node. An empty `command -v node` result or failed Codex PATH-alias
creation is not a missing-Node diagnosis when this launcher succeeds. If the
launcher cannot find a compatible runtime, use `command -v node` on POSIX or
the bundled `../../scripts/resolve-node.ps1` on native Windows to distinguish
not-found from an installed version below 22 before offering installation.

Interpret its fields literally:

- `plugin.loadedVersion` is the bridge actually executing in this diagnostic;
- `plugin.hooks.status=ready` proves bundled definition integrity, not client
  approval;
- `plugin.hooks.approvalStatus=client_managed_unknown` means doctor cannot see
  the client's trust decision;
- `connection` reports only value-free local bridge pairing state;
- `runtimeSessions` contains counts only and never exposes session IDs or keys;
- top-level `status=action_required` is caused by Node, Git, or corrupted/
  inconsistent loaded plugin files. A missing bridge pairing remains a
  separate connection state because remote Trelio reads may still work.

Do not run `trelio-workspace login` merely because doctor was requested.

## Inspect the exact client

In Codex:

1. Inspect `codex plugin list --json`. Confirm that
   `trelio-agent-workspaces@trelio-plugins` is installed and enabled, and record
   its installed version without reading cache directories.
2. Inspect `codex mcp list --json`. Evaluate remote `trelio` separately from
   local `trelio-remote-skills`. `auth_status: "o_auth"` describes the configured
   scheme; only a successful live read proves the current process has a usable
   bearer.

In Claude Code, use `claude mcp list` and its plugin manager. Never use Codex
commands to diagnose another host's credential store. Plugin-provided server
names are namespaced: the current remote entry is
`plugin:trelio-agent-workspaces:trelio` and the local entry is
`plugin:trelio-agent-workspaces:trelio-remote-skills`. Preserve the exact name
from the list instead of shortening either one. The remote entry must use HTTP
and bundled local paths must resolve from `${CLAUDE_PLUGIN_ROOT}`. A skipped
remote entry whose URL has no `type`, or an `ENOENT` for literal
`./scripts/launch-trelio-node`, proves that Claude loaded an older incompatible
MCP definition; it is not an OAuth, Node.js, Git or pairing failure.

If the user asks to verify hooks end to end, use a read-only protected Trelio
call. Reuse an exact task already supplied; otherwise use Trelio discovery to
find one accessible task and then call `get_task`. Do not create or mutate an
object just to test a hook. If no protected read target is available, report
that live proof was not performed instead of claiming success.

## Interpret hook and version failures exactly

- A successful protected read proves that the approved hook injected a valid
  proof in this task.
- Only when Trelio itself returns `TRELIO_RUNTIME_HOOK_REQUIRED`, tell a Codex
  user: `Откройте настройки плагина Trelio Agent Workspaces, включите Hooks и
  повторите запрос.` In Claude Code/Cowork, ask the user to enable or approve
  this plugin's hooks and retry. Do not initially suggest installing, updating
  or reinstalling the plugin, pairing, login, a new task or an app restart for
  this signal. Escalate only after Hooks are enabled and the retry returns a
  separate exact installation, version, pairing or session error.
- A `PreToolUse` failure proves that the hook ran. Preserve its exact
  structured code and reason. Never reclassify it as
  `TRELIO_RUNTIME_HOOK_REQUIRED` or tell the user to enable Hooks.
- On `TRELIO_RUNTIME_HOOK_FAILED`, fix the stated local cause and retry once in
  the current task.
- On `AGENT_WORKSPACE_PLUGIN_UPGRADE_REQUIRED` or
  `AGENT_SKILL_RUNTIME_HOST_UPGRADE_REQUIRED`, compare the required version,
  `plugin.loadedVersion`, and the client-reported installed version. If the
  installed version already satisfies the requirement but the loaded version
  does not, do not update again: start one new task/session and repeat the
  original call there. A full restart is justified only if that fresh task
  still loads the old version or lacks MCP tools.
- If the installed version is actually old, use only the official plugin
  manager update path, verify the new installed version, and retry once in the
  current task before asking for a new one. Never edit a version file, forge a
  header, scan caches, or bypass admission through HTTP, browser or another MCP.

The current hook definition scopes `PreToolUse` to Trelio MCP while leaving
lifecycle matchers forward-compatible. It must launch through the bundled
`launch-trelio-node` on macOS/Linux and expose the quote-free `commandWindows`
override that reaches `launch-trelio-node.cmd` on Windows. Bare `node` in the
loaded hook command is a stale, incompatible definition: update the official
plugin, approve the changed definition once, and start one new task. Do not ask
the user to install Node merely because the desktop process PATH lacks it.
Later behavior-only fixes in the runtime script do not require another
`hooks.json` change or trust review.

## Apply only the matching repair

- Missing Codex marketplace: add the official
  `trelio-ru/agent-workspaces` marketplace, then inspect plugin state.
- Plugin absent or disabled: install/enable
  `trelio-agent-workspaces@trelio-plugins`; a listed marketplace alone is not
  proof of installation.
- Remote Trelio reports explicit HTTP 401 or missing bearer: run the exact
  host's Trelio MCP login once. In Codex it is `codex mcp login trelio`; in
  Claude Code it is
  `claude mcp login plugin:trelio-agent-workspaces:trelio`, using the exact
  namespaced name confirmed by `claude mcp list`. Let the user complete browser
  login and consent, then retry one low-risk read. Do not loop login if the
  current process did not adopt a successfully refreshed credential; use a
  fresh task or Claude session first.
- Claude Code's namespaced remote server is `Connected`, but a session opened
  before OAuth still has no `list_companies` or other remote tools: do not
  reauthorize. End that stale session, launch a new `claude` session from the
  same exact working folder, and retry the original request there.
- Only `trelio-remote-skills` fails: inspect its exact client-owned command. In
  Codex, `codex mcp list --json` must show `./scripts/launch-trelio-node` with a
  plugin-root `cwd`; a still-loaded bare `node` command needs the normal plugin
  update/new-task path. In Claude Code, `claude mcp list` must resolve the
  launcher from `${CLAUDE_PLUGIN_ROOT}`; a literal relative-path `ENOENT` needs
  the Claude plugin update plus `/reload-plugins`, not a cwd-dependent manual
  launch. Run the bundled launcher diagnostic above before classifying a
  Node.js/runtime prerequisite. Do not reset remote Trelio OAuth.
- Doctor reports Node below 22: offer the platform's normal Node.js LTS install
  path and obtain explicit confirmation before running a package-manager
  command.
- Doctor reports `TRELIO_GIT_REQUIRED`: follow its exact install plan, then
  rerun doctor before retrying a workspace action. Do not use an undocumented
  Git private to the client.
- `connection.status=not_configured` blocks an action that needs the local
  bridge: run the bundled pairing flow. Pairing approval remains a guarded MCP
  action and no token or pairing code is shown in chat.
- `runtimeSessions.status=attention` alone is not proof that hooks, OAuth or the
  plugin are broken. Current hooks recover expired state and stale registration
  locks; report counts and retest one read before proposing any cleanup.
- Structured `MCP_SEARCH_TIMEOUT` proves that remote MCP reached Trelio and the
  backend deliberately cancelled a read-only search statement before the
  reverse-proxy deadline. It is not a 504, OAuth failure, missing Hooks, stale
  plugin cache, or permission denial. Do not run login, reinstall the plugin,
  or make three identical network retries. Retry at most once with exact
  `companySlugs`, no more than two strongest independent queries, and exact
  `projectSlugs` only when that boundary is already known. If the narrowed
  retry times out, report the search scope as the failing layer.

For transient network failures, make three bounded safe retries with a short
increasing delay. Before repeating a request with side effects, verify whether
it already succeeded. Treat explicit 401 and 403 differently from DNS,
timeout, reset, 429 and 5xx responses. A bare HTTP 504 remains in this transport
category; never reinterpret it as `MCP_SEARCH_TIMEOUT` without the structured
tool error.

## Report the result

Lead with the exact failing layer and one next action. Include the installed
version and loaded version when they differ. State whether hook integrity,
client approval and a live protected read were actually verified; do not merge
them into a generic “hooks work” claim. Omit healthy detail unless it explains
why a proposed repair is unnecessary.
