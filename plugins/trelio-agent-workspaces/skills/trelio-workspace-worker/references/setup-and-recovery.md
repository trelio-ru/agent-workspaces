# Setup and recovery

Read this file completely when Trelio MCP tools are absent, an OAuth scope is
missing, the local bridge reports `TRELIO_GIT_REQUIRED`, or Trelio rejects the
installed plugin version.

## Missing MCP tools

If the workspace skill is available but Trelio MCP tools are absent, treat the
state as incomplete plugin setup rather than a task, ACL, or browser problem.

1. Do not open Trelio in a browser as a substitute and do not continue task
   work without the Agent Workspace control plane.
2. Inspect `codex mcp list --json` and distinguish the remote `trelio` server
   from the local `trelio-remote-skills` stdio server. If remote `trelio` needs
   authentication and the ON_INSTALL OAuth window is not already open, run
   `codex mcp login trelio` immediately and wait for the command. Treat
   `auth_status: "o_auth"` only as the configured authentication scheme, not
   proof that the current process attached its credential: an exact HTTP 401
   or required/missing-bearer result from a live Trelio read still means the
   remote connection needs recovery.
   That single browser flow includes Trelio login when needed and then consent.
   Never ask the user to log in on the site first, report «я вошёл» in chat, or
   let Computer Use enter credentials. If the OAuth window is already open, do
   not start a duplicate flow; let the user finish it.
3. If the `Trelio` marketplace is missing, run the exact command
   `codex plugin marketplace add trelio-ru/agent-workspaces`. It tracks the
   official default branch; refresh an existing snapshot with
   `codex plugin marketplace upgrade`. Then inspect `codex plugin list --json`.
   A registered marketplace is not proof that the plugin is installed. If
   `trelio-agent-workspaces@trelio-plugins` is not installed and enabled, run
   `codex plugin add trelio-agent-workspaces@trelio-plugins` even though the
   marketplace declares `INSTALLED_BY_DEFAULT`; that policy is a host
   optimization, not a CLI readiness check.
4. If a managed ChatGPT/Codex workspace marks the plugin or connection
   unavailable, explain that a workspace admin must enable it for the user's
   role. Do not suggest resetting Trelio credentials before resolving policy.
5. After installation or OAuth, refresh `codex mcp list --json` and retry the
   original low-risk Trelio read once in the current task. Continue there when
   the tool is callable. Start a new task only when this live retry proves the
   current task has not loaded the connection. If that one retry still reports
   a missing bearer after completed OAuth, do not run `codex mcp login trelio`
   again: repeated login creates another credential but cannot repair bearer
   propagation in an already-open process. Use a fresh task/process and keep
   the completed authorization; require a full restart only if the new task
   still lacks tools or reports the old plugin version.

Failure of only `trelio-remote-skills` is not failed Trelio OAuth. Base remote
Trelio and bridge work may continue. Inspect `codex mcp list --json`: the
current plugin definition must launch `./scripts/launch-trelio-node`, not bare
`node`. Run `trelio-workspace.mjs doctor --json` through that loaded plugin's
POSIX launcher or Windows `.cmd`; it prefers the bundled Codex runtime before
system Node and requires version 22+. A missing PATH alias is not a Node
failure when the launcher succeeds. If Codex still shows bare `node`, follow
the normal plugin update/new-task path. Never reset OAuth, reinstall Node, or
repeat restart advice after the launcher has verified a compatible runtime.

Do not claim readiness because skill text is visible. Confirm it with a
successful low-risk MCP read such as `get_my_context` or `get_task`.

## Missing or unusable local Git

Git is a local bridge prerequisite, not proof about Trelio OAuth, MCP ACL, or
plugin installation. On `TRELIO_GIT_REQUIRED`, run this loaded plugin's bundled
`../../scripts/trelio-workspace.mjs doctor --json` through its exact
`../../scripts/launch-trelio-node` launcher (or the sibling `.cmd` on native
Windows). Doctor resolves standalone Git 2.28+ only from standard macOS/
Windows locations and durable Windows PATH and proves a temporary
`init → add → commit`. Arbitrary process-PATH executables are not candidates;
never reuse an undocumented Git private to Codex's marketplace manager.

If doctor reports `not_found`, `upgrade_required`, or `unusable`, immediately
run its exact installation plan without another confirmation question in chat:

- macOS uses `brew install git` when Homebrew is already installed; otherwise
  start `xcode-select --install` and let the user complete Apple's native
  installer window;
- native Windows uses
  `winget install --id Git.Git -e --source winget --accept-source-agreements
  --accept-package-agreements`; without `winget`, immediately open the returned
  official Git for Windows installer URL and let the user complete it.

The client or OS still owns its normal command approval, administrator prompt,
and signed installer UI; do not bypass or approve it for the user. After the
installer finishes, rerun doctor in the same task before repeating the failed
workspace command. Use a newly found absolute Git path immediately even when
the parent Codex process PATH is stale; no app restart is required. If the
installer outcome is ambiguous, check doctor before any retry with side
effects.

## Missing OAuth scopes

If a Trelio MCP tool reports missing `mcp:*` scopes, treat it as a stale grant,
not missing setup or a Trelio ACL denial.

1. Prefer the native OAuth reauthorization card triggered by
   `mcp/www_authenticate`. The user must review and approve the new permissions
   in the browser.
2. After the browser flow, retry the exact low-risk read once in the current
   task. Continue there when it succeeds; do not pre-emptively ask for a new
   task or replace the read with browser access or another integration.
3. If Codex does not surface the card, run `codex mcp login trelio`. Do not log
   out first, request only the newly missing scope, print the authorization
   URL, or inspect/copy stored credentials. The scope-less command requests the
   current complete Trelio grant so existing rights are preserved.
4. Wait while the user completes browser consent, then retry the same read
   once. If the current task still uses the old connection, ask for a new task;
   require a full restart only when that task also keeps the stale grant.
5. Outside Codex, use the host's native reconnect flow. Do not assume Codex CLI
   manages another host's credential store.

## Required plugin version

Trelio rejects a plugin below the live `minimumVersion`. On
`AGENT_WORKSPACE_PLUGIN_UPGRADE_REQUIRED` or
`AGENT_SKILL_RUNTIME_HOST_UPGRADE_REQUIRED`, never retry the old protected
process or bypass the gate. When the code comes from an active `PreToolUse`
failure, it proves that Hooks are enabled; never replace it with the
`TRELIO_RUNTIME_HOOK_REQUIRED` response.

1. When a bridge command reports the code in Codex, let its guarded updater run
   first. It uses the exact official `trelio-plugins` marketplace, bounds
   transient-network retries, validates the installed manifest and entrypoint,
   and can re-dispatch the new bridge in the same task. Do not ask the user to
   update before this path finishes and do not scan plugin caches.
2. When an active Codex `PreToolUse` hook reports the code, inspect
   `codex plugin list --json`. If the required version is already installed and
   enabled, do not update again: the current task retained the old hook, so ask
   only for a new task and repeat the original protected call there. If the
   installed version is still below the returned minimum, run the exact
   official update command from the error or
   `codex plugin marketplace upgrade trelio-plugins`, verify the installed
   version, and then retry once in the current task before moving to a new one.
3. If bridge re-dispatch or that one current-task retry succeeds, continue
   without an update notice.
4. If the plugin updated but the current task cannot reload safely, ask only
   for a new task and preserve any Run directory. There execute the same
   original call or `trelio-workspace open --workspace <uuid> --run <uuid>`
   command.
5. Require a full Codex restart only if the new task still reports the old
   version or lacks MCP tools. If automatic update failed, show the exact
   fallback command returned by the bridge and keep the order: current task,
   new task, full restart.
6. Claude does not use the Codex updater. Refresh `trelio-plugins` through its
   plugin manager, use `/reload-plugins` when available or start a new task,
   and reserve a full restart as the last fallback.

Never bypass the version gate with direct HTTP, another `clientKind`, edited
metadata, or a forged header. Compatibility enforcement complements rather
than replaces server-side ACL and candidate validation.
