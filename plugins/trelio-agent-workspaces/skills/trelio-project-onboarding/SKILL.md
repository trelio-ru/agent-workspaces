---
name: trelio-project-onboarding
description: Set up Trelio Agent Workspaces in one durable local working folder in Codex or Claude Code, create or safely extend its AGENTS.md company/project binding, verify client-specific OAuth and local bridge prerequisites/pairing on macOS or Windows, discover the live Trelio skill catalog, and guide selected company or personal connections without exposing credentials. Use after installing or authorizing the Trelio plugin, when the user asks to connect or configure Trelio in a working folder, when a folder needs its Trelio AGENTS.md block, or when the user wants to configure the Trelio skills available to them.
---

# Trelio Working-Folder Onboarding

Set up one durable local working folder in Codex or Claude Code without starting
a disposable Trelio workspace run. Keep the binding durable in that folder's
instruction file, but always read the current skill catalog and connection
state from Trelio.

For every non-recovery Trelio MCP call, include exact current
`runtimeAttestation`. Codex/Claude Code use `source=agent_request`,
`evidenceLevel=self_reported`, their real model/effort and a fresh ISO
`observedAt`; rebuild it after a runtime change. Discovery ignores only the
minimum effort, not a model deny. Pairing/session recovery is exempt so setup
can be repaired. Do not infer runtime from plugin env or reuse another model's
declaration.

## Confirm the working folder first

1. Before inspecting or installing plugins, running a package manager, opening
   OAuth, calling Trelio, or making any other setup change, resolve one existing
   writable folder from client-owned project context:
   - In Codex, require a local project with an accessible primary folder
     supplied by the host. A default process working directory in a projectless
     task is not evidence of a selected folder.
   - In Claude Code, require the stable project root supplied as
     `CLAUDE_PROJECT_DIR`, an equivalent MCP root, or the directory from which
     the user launched `claude`. Do not substitute another shell directory after
     the session started.
   The folder may be empty and does not need to be a Git repository.
2. Treat the selected folder itself as the binding root. A Git root may confirm
   it, but never climb above the client-selected root or redirect the binding to
   home, a temporary directory, plugin cache, client-internal storage, or the
   nearest convenient repository. A nearby `.trelio-run.json` or protected
   managed-workspace `AGENTS.md` means this is a materialized Trelio Agent
   Workspace, not an onboarding target.
3. If no unambiguous durable folder is available, stop before every setup side
   effect and do not create an arbitrary folder for the user. Say
   `Рабочая папка не найдена. Настройка не начата.` Then give one client-specific
   recovery action: in Codex, open a local project with a primary folder and
   repeat the request in a new task in that project; in Claude Code, open a
   terminal in the intended folder, run `claude`, and repeat the request in that
   new session.

## Check prerequisites

1. Require callable Trelio MCP tools, not only this skill text. If tools are
   missing, diagnose the two independent prerequisites once in the current
   task before considering another task:
   - Resolve the actual client from host-owned context; `CLAUDE_PLUGIN_ROOT`
     alone does not prove Claude Code. In Codex, inspect
     `codex mcp list --json` to distinguish an unavailable or unauthenticated
     `trelio` HTTP server from the local `trelio-remote-skills` server. In
     Claude Code, inspect `claude mcp list`; never run `codex` diagnostics or
     login commands there. The plugin version alone does not prove that either
     server is ready. In particular, Codex `auth_status: "o_auth"` identifies
     the configured authentication scheme; it does not prove that the current
     process attached a bearer. A failed live Trelio read that explicitly
     reports HTTP 401 or a required/missing bearer is an OAuth failure even
     when this status still says `o_auth`.
   - Resolve Node.js without intentionally executing a missing command. On
     native Windows, run this loaded plugin's bundled
     `../../scripts/resolve-node.ps1`; it checks the current process, durable
     machine/user PATH values and official Program Files location without
     editing anything. On POSIX use `command -v node`. If Node.js is absent or
     older than 22, follow the installation-offer flow under **Connect the
     local component**. A local Node.js problem does not prove that Trelio
     OAuth is invalid.
   - After resolving compatible Node.js, run this loaded plugin's bundled
     `../../scripts/trelio-workspace.mjs doctor --json` through that exact
     executable. Doctor resolves a standalone Git 2.28+ only from standard
     macOS/Windows locations and durable Windows PATH; arbitrary process-PATH
     executables, including Codex's private runtime, are not candidates. It then
     proves `init → add → commit` in a temporary repository. If Git needs installation
     or upgrade, follow **Connect the local component** immediately. A Git
     problem does not prove that Trelio OAuth is invalid.
   - If the remote `trelio` server needs authentication and an OAuth window is
     already open, let the user finish that one window. If it is not open,
     immediately run the exact client command and wait for it: in Codex use
     `codex mcp login trelio`; in Claude Code use
     `claude mcp login trelio`, or direct the user to `/mcp` and the exact
     `trelio` server when the installed Claude Code version does not expose the
     CLI login command.
     The authorization URL itself redirects an unauthenticated user through
     Trelio login and back to consent. Never open the Trelio site as a
     preparatory login, use Computer Use to enter credentials, or ask the user
     to report that login finished before starting OAuth. The user personally
     completes login and consent in the single browser flow.
   - After OAuth, refresh the same client's MCP status and retry one low-risk
     Trelio read in this same task. Continue onboarding here as soon as the
     tools are callable. Ask for a new task or Claude session in the same
     working folder only when that live retry proves the current process still
     has no refreshed tools; do not assume a static tool list. If that retry
     still explicitly lacks a bearer after the user completed this one OAuth
     flow, do not start another login loop: the already-open client process may
     not have adopted the refreshed credential. Preserve the successful
     authorization.
   Require a full app restart only when a live current-process retry and then a
   new task/session in the same folder still lack the tools or report the old
   plugin version. In Claude Code, run `/reload-plugins` before creating the new
   session when the plugin was installed or updated during the current one. In
   Codex, if the marketplace itself is missing, run
   `codex plugin marketplace add trelio-ru/agent-workspaces`. Then inspect
   `codex plugin list --json`: a listed marketplace is not proof that its
   plugin is installed. If `trelio-agent-workspaces@trelio-plugins` is not
   installed and enabled, run
   `codex plugin add trelio-agent-workspaces@trelio-plugins`. Treat
   `INSTALLED_BY_DEFAULT` only as a host optimization, never as a reason to
   skip this live installation check.
2. Resolve the exact company. Reuse an explicit company slug from current
   instructions or the user's request; otherwise call `list_companies`.
   Automatically continue only when one accessible company or one exact match
   remains. Ask the user to choose when several companies are plausible.
3. Bind a project slug only when the user wants this whole working folder
   restricted to one Trelio project. A company-wide folder must not
   silently acquire a project restriction.
4. Call `get_agent_instructions` for the resolved company and optional project
   before making substantive setup changes. Follow the effective working rules
   and authenticated user's personal profile without copying either into the
   local working-folder binding.

## Create or extend the local instruction file

Read the selected working-folder instruction files before writing:

- If `AGENTS.override.md` exists at the same root, explain that it shadows
  `AGENTS.md` and ask whether to update the override or remove/rename it. Do not
  create an ineffective `AGENTS.md` silently.
- Reject a symlink, directory, device, or other non-regular target.
- Never replace unrelated existing instructions. If the managed markers
  already exist, update only their complete block. Otherwise append the block
  after a blank line or create a new file.
- Show the exact proposed block or concise diff before the write. Invoking
  onboarding and choosing the company authorizes this expected,
  reversible local edit; do not add a second ceremonial confirmation unless
  the target file or scope is ambiguous.

Use this block, substituting the verified display name and slug:

```markdown
<!-- trelio-agent-workspaces:start -->
## Контекст Trelio

Эта рабочая папка связана с компанией Trelio «Компания» (`company-slug`).

Для запросов, относящихся к Trelio, используй расширение Trelio Agent
Workspaces. Актуальные правила выбора и ведения рабочего пространства получай
из Trelio.
<!-- trelio-agent-workspaces:end -->
```

For a deliberately project-bound setup, add one sentence before the workflow
sentence:

```markdown
Работа ограничена проектом «Проект» (`project-slug`).
```

Do not write the current skill list, connection state, user credentials, IDs,
tokens, or local paths into `AGENTS.md`. Skills and connections are live Trelio
state and may change after this file is created.

## Connect the local component

The bundled local component requires Node.js 22 or newer and a standalone Git
2.28 or newer. Resolve `node`
without a deliberate failing probe and read its version only when an exact
executable exists. On native Windows use the bundled
`../../scripts/resolve-node.ps1` diagnostic. If it returns `ready` with
`processPathReady=false`, Node is already installed: use its absolute
`nodePath` for the bundled bridge in this task. Do not reinstall Node, repeat
restart advice, or block remote Trelio OAuth merely because the current client
process has a stale PATH. The plugin's `trelio-remote-skills` stdio server may
still need one later app restart, but mention that only when a skill selected
by the user actually returns `remoteMcpExecution` and the server is unavailable.

If the resolver returns `not_found` or a version older than 22, explain that
this blocks the local bridge and local skill server, then offer installation
instead of merely reporting a missing `PATH` entry:

- On native Windows, offer
  `winget install --id OpenJS.NodeJS.LTS -e`.
- On macOS, offer `brew install node` only when Homebrew is already available;
  otherwise direct the user to the official Node.js LTS installer.
- On other systems, use the platform's normal package manager or the official
  Node.js LTS installer, but require a resulting version of at least 22.

Installing or upgrading Node.js is a separate side effect. Ask one
concise explicit confirmation before running its package manager command and
let the client apply its normal command approval. Never install Node.js
silently. Afterward, rerun the resolver and verify the exact version. Use the
absolute executable immediately for the bundled bridge. Ask for one full app
restart only if a selected `remoteMcpExecution` skill needs the client-managed
local MCP server and that server still cannot start. If the user says they
already restarted, do not repeat the same advice: compare the process PATH with
the durable machine/user PATH and report one exact environment repair or a
bounded unsupported-client blocker.

After compatible Node.js is available, run the bundled
`trelio-workspace.mjs doctor --json` before pairing. When it returns `ready`,
continue through the bundled bridge; the bridge will use `git.gitPath` by
absolute path. `processPathReady=false` is not a reason to restart the app.
Doctor validates a real external Git executable and a temporary
`init → add → commit`, not the private Git that Codex may use to download a
marketplace.

When doctor returns `TRELIO_GIT_REQUIRED`, `not_found`, `upgrade_required`, or
`unusable`, immediately execute its exact installation plan. Do not stop at an
offer and do not ask for a separate confirmation in chat. The client and OS may
still show their ordinary command approval, administrator prompt, or signed
installer window; never bypass or click that approval for the user.

- On macOS with Homebrew, run the returned `brew install git`. Without
  Homebrew, run `xcode-select --install` immediately, let the user finish the
  native Apple installer window, and then rerun doctor without asking them to
  report completion in chat.
- On native Windows with App Installer, run the returned
  `winget install --id Git.Git -e --source winget --accept-source-agreements
  --accept-package-agreements`. If `winget` is genuinely unavailable, open the
  returned official `https://git-scm.com/download/win` installer page
  immediately, let the user finish the signed installer, and rerun doctor.

After installation, rerun doctor in the same task/session and continue as soon
as it returns `ready`. A newly installed Git found in Program Files, Homebrew,
or durable Windows PATH is used by absolute path immediately; do not require an
app restart. Do not retry an installer whose result is ambiguous until
doctor has checked whether Git is already ready.

Run `trelio-workspace login` through the logical launcher of this installed
plugin. Resolve it without executing a failing probe: use the PATH command when
present, otherwise replace only the first token with Node.js 22+ and this
skill's bundled `../../scripts/trelio-workspace.mjs`. Do not install
`trelio-workspace` globally or treat its normally absent `PATH` entry as an
error.

If login reports a one-time pairing request, immediately call
`approve_agent_workspace_bridge_pairing` with its exact `pairingId` and
`deviceName`, then repeat the same login command. Never show a pairing code or
verifier. Do not open a company workspace, start a work run, or create and
cancel a disposable result merely to test the connection.

## Offer the live Trelio skills

1. Call `list_agent_skills` once for the exact effective scope. Use only
   `companySlug` for a company-wide working folder; include `projectSlug` for a
   deliberately project-bound setup. Do not scan every visible project to
   collect strict project-only skills. The company-wide response already
   includes every portable project assignment granted through the current
   member's participation in a selected project. Such an item normally has
   `enabledThroughProjectMembership=true` and `sources` containing
   `project_membership`; treat it as available in the current company scope
   and offer it now. Do not misclassify it as strict project-only merely
   because `enabledAtCompany=false`. A strict project-only skill is absent
   from this company-wide response and is discovered just in time only after
   a concrete project or task supplies the narrower scope.
2. Use catalog metadata only to prepare a concise checklist. Do not call
   `get_agent_skill` for every item and do not claim that a personal local
   session is ready before its own doctor succeeds.
3. Separate availability from readiness:
   - Show an enabled skill with a ready company connection as available, while
     noting that personal setup may still be required.
   - When an enabled skill has `connection.configured=false`, show exactly
     `требуется настройка администратором компании`. Do not ask for the user's
     personal 1C login or other local credential until that company blocker is
     resolved.
   - Show every enabled 1C skill as a separate company connection. Never merge
     their administrator blockers or reuse config, Agent Secret, connection id
     or personal local credentials from another 1C skill.
   - If `minPluginVersion` or the runtime host requires a newer plugin, stop
     setup for that item. In Codex, let the bridge attempt its quiet official
     update first and continue in the same task after successful re-dispatch.
     In Claude Code, use its plugin manager and `/reload-plugins`. Otherwise
     use a new task/session in the same folder, and require a full restart only
     if that fresh process still sees the old version.
4. Briefly ask which available skills the user wants to configure. Do not
   connect everything automatically. In a company-wide setup, include
   portable `project_membership` skills returned by the catalog in this first
   checklist. Explain that only strict project-only skills missing from the
   company-wide response will be offered just in time when a concrete Trelio
   project or task is selected.
5. Immediately before configuring each selected skill, call
   `get_agent_skill` with the same exact scope and follow its current
   `instructionsMarkdown`, `runtimeExecution`, or `remoteMcpExecution`.
   Configure and verify one selected skill at a time so an incomplete login
   cannot be mistaken for another skill's readiness.

## Protect personal credentials

- Never ask the user to paste a password, PAT, API key, `api_hash`, login code,
  2FA value, cookie, session, authorization header, or credential file into
  chat, a prompt, `AGENTS.md`, a workspace, or a shell argument.
- Use the skill's protected local `127.0.0.1` connection flow or exact trusted
  runtime command. A declarative Remote MCP credential is usable only after its
  local doctor succeeds.
- Treat local credential entry as browser-first. Do not substitute a native OS
  dialog. Use terminal input only through an explicit runtime fallback in a
  visible TTY. Explain that a browser copy is unnecessary because the runtime
  saves the verified connection separately on this device, and tell the user
  to decline any password-manager prompt. Never claim that `autocomplete=off`
  disables that policy.
- A missing company value belongs in the protected Trelio company connection
  form and requires an administrator. A personal session belongs only to the
  current member's private local integration directory.
- Leave communication send policy at `confirm` unless the user directly asks
  for `read-only` or `autonomous`. Company policy may forbid autonomous mode
  but never enables it for the user.

## Finish

Summarize:

1. the working folder and its bound company and optional Trelio project;
2. whether the local component is connected;
3. each offered skill as ready, awaiting personal setup, or
   `требуется настройка администратором компании`;
4. the exact next action for every incomplete item.

If `AGENTS.md` or `AGENTS.override.md` changed, tell the user that future tasks
or Claude sessions opened in this folder will use the binding automatically
and that a new task/session is required for the instruction file to become
active. The current onboarding process may still finish connection checks
because this skill already carries the explicit setup scope.
