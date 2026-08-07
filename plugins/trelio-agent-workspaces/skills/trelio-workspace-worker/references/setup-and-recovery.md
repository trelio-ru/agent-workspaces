# Setup and recovery

Read this file completely when Trelio MCP tools are absent, an OAuth scope is
missing, or Trelio rejects the installed plugin version.

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
3. If the `Trelio` marketplace or plugin is missing, give the exact command
   `codex plugin marketplace add trelio-ru/agent-workspaces`. It tracks the
   official default branch; refresh an existing snapshot with
   `codex plugin marketplace upgrade`. `INSTALLED_BY_DEFAULT` installs the
   plugin, so do not add a redundant `codex plugin add` step.
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
Trelio and bridge work may continue. Diagnose Node through the project
onboarding skill's bundled Windows resolver and use an already installed
Node.js 22+ executable by absolute path for the bridge. Discuss restarting the
local stdio server only when an exact selected skill needs
`remoteMcpExecution`; never reinstall Node or repeat restart advice after a
verified compatible absolute executable has been found.

Do not claim readiness because skill text is visible. Confirm it with a
successful low-risk MCP read such as `get_my_context` or `get_task`.

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

Trelio requires the latest published stable plugin for bridge operations. On
`AGENT_WORKSPACE_PLUGIN_UPGRADE_REQUIRED`, never retry the old network process
or bypass the gate.

1. In Codex, let the bridge update first. It uses the exact official
   `trelio-plugins` marketplace, bounds transient-network retries, validates the
   installed manifest and entrypoint, and can re-dispatch the new bridge in the
   same task. Do not ask the user to update before this path finishes and do
   not scan plugin caches.
2. If re-dispatch succeeds, continue without an update notice.
3. If the bridge updated but the current task cannot reload safely, ask only
   for a new task and preserve the Run directory. There execute the same
   `trelio-workspace open --workspace <uuid> --run <uuid>` command.
4. Require a full Codex restart only if the new task still reports the old
   version or lacks MCP tools. If automatic update failed, show the exact
   fallback command returned by the bridge and keep the order: current task,
   new task, full restart.
5. Claude does not use the Codex updater. Refresh `trelio-plugins` through its
   plugin manager, use `/reload-plugins` when available or start a new task,
   and reserve a full restart as the last fallback.

Never bypass the version gate with direct HTTP, another `clientKind`, edited
metadata, or a forged header. Compatibility enforcement complements rather
than replaces server-side ACL and candidate validation.
