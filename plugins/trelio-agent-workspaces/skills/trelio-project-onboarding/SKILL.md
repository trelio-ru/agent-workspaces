---
name: trelio-project-onboarding
description: Set up Trelio Agent Workspaces in one durable non-Git local context folder in Codex or Claude Code, create or safely extend its AGENTS.md company/project binding and Claude Code import, verify client-specific OAuth and local bridge prerequisites/pairing on macOS or Windows, discover the live Trelio skill catalog when remote content is available, and route encrypted companies to the local bridge without exposing credentials. Use after installing or authorizing the Trelio plugin, when the user asks to connect or configure Trelio in a working folder, when a folder needs its Trelio AGENTS.md block or CLAUDE.md import, or when the user wants to configure the Trelio skills available to them.
---

# Trelio Working-Folder Onboarding

Set up one durable ordinary local context folder in Codex or Claude Code without
starting a disposable Trelio workspace run. The folder is a control-plane entry
point, not a Git-repository association. Resolve work through current company
and project rules, an exact task or workspace, and their Agent Workspaces. Keep
the binding durable in that folder's instruction file. Read live company
metadata from Trelio. Read company-content instructions through
`get_agent_instructions` and follow Trelio's selected provider; encrypted
content stays on the local bridge. Read the current skill catalog only when the
selected company is in ordinary `plain` mode.

Discovery and pairing/session recovery remain available without runtime
admission so setup can be repaired. Protected context/mutation calls receive a
one-use `runtimeSessionProof` from the approved client hook automatically;
never author or copy runtime fields. When Trelio itself returns
`TRELIO_RUNTIME_HOOK_REQUIRED`, stop protected setup and give one host-specific
action. In Codex tell the user only:
`Откройте настройки плагина Trelio Agent Workspaces, включите Hooks и повторите
запрос.` In Claude Code/Cowork tell the user only to enable/approve this
plugin's hooks and retry. Do not initially suggest installing, updating or
reinstalling the plugin, running `trelio-workspace login`, starting a new
task/session, or restarting the app. Escalate only after Hooks are enabled and
a retry still proves that the current session did not load them or returns a
separate, specific version, installation, pairing, or session error.

A `PreToolUse` failure proves that the hook is active. Preserve its exact code
and reason. On `AGENT_WORKSPACE_PLUGIN_UPGRADE_REQUIRED` or
`AGENT_SKILL_RUNTIME_HOST_UPGRADE_REQUIRED`, follow the version recovery under
**Check prerequisites**: update only when the required version is not already
installed, then use a new task/session if the current one cannot reload it.
Never answer that version failure with the missing-Hooks instruction. On
`TRELIO_RUNTIME_HOOK_FAILED`, resolve the stated cause and retry once in the
current task.

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
   The folder may be empty. It is intentionally an ordinary non-Git context
   folder. The standalone Git prerequisite checked later belongs to the local
   bridge and its managed temporary or Run repositories, not to this binding.
2. Treat the selected folder itself as the binding root. Never use a Git root to
   choose or expand it, climb above the client-selected root, or redirect the
   binding to home, a temporary directory, plugin cache, client-internal
   storage, or the nearest convenient repository. A nearby `.trelio-run.json`
   or protected managed-workspace `AGENTS.md` means this is a materialized
   Trelio Agent Workspace, not an onboarding target.
3. If no unambiguous durable folder is available, stop before every setup side
   effect and do not create an arbitrary folder for the user. Say
   `Рабочая папка не найдена. Настройка не начата.` Then give one client-specific
   recovery action: in Codex, open a local project with a primary folder and
   repeat the request in a new task in that project; in Claude Code, open a
   terminal in the intended folder, run `claude`, and repeat the request in that
   new session.
4. Before Trelio discovery, OAuth, prerequisite installation, or an instruction
   file write, classify Git with read-only checks on the selected folder and its
   parents. Continue without cleanup only when the selected folder is not inside
   a Git worktree and is not itself a bare repository or Git directory. Never
   use Git presence, a repository name, or a remote URL as a Trelio
   company/project selector.
5. Automatically detach an incidental host-created Git shell only when every
   condition below is proven:
   - the selected folder is the exact repository top level and its `.git` is a
     real ordinary directory, not a symlink, gitfile, submodule, or linked
     worktree, and no ancestor owns another Git worktree containing this folder;
   - `HEAD` is unborn, and the repository has no commits, remotes, local or
     packed refs, tracked or staged paths, submodules, additional worktrees,
     in-progress operation, non-sample hooks, alternates, or repository-local
     configuration beyond ordinary fresh `git init` metadata;
   - outside `.git`, the folder is empty or contains only regular root
     `AGENTS.md`, `AGENTS.override.md`, and/or `CLAUDE.md` files. Any other entry
     makes the repository ambiguous rather than disposable.

   Make this cleanup recoverable: atomically rename the exact `.git` directory,
   without following links or overwriting a target, to a unique root-level
   `.git.trelio-detached-<UTC-timestamp>` backup. Never use `rm` or discard the
   metadata. Recheck that the selected folder is no longer a Git worktree, then
   immediately tell the user that the empty Git shell was detached and give the
   exact backup path and restore rename. This deterministic cleanup is part of
   folder onboarding and does not need a separate confirmation.
6. For every existing or ambiguous repository—including any parent worktree,
   any commit or remote, a `.git` gitfile, or a no-commit repository that fails
   one strict condition above—do not alter Git and stop before Trelio calls or an
   instruction-file write. Say:
   `Выбрана папка Git-репозитория. Trelio-привязка в неё не записана. Откройте
   отдельную обычную папку проекта без Git и повторите настройку.` Explain that
   Trelio context should come through company/project rules, an exact task or
   workspace, or their Agent Workspace, rather than a persistent binding inside
   the code repository.

## Check prerequisites

1. Require callable Trelio MCP tools, not only this skill text. If tools are
   missing, diagnose the two independent prerequisites once in the current
   task before considering another task:
   - Resolve the actual client from host-owned context; `CLAUDE_PLUGIN_ROOT`
     alone does not prove Claude Code. In Codex, inspect
     `codex mcp list --json` to distinguish an unavailable or unauthenticated
     `trelio` HTTP server from the local `trelio-remote-skills` server. In
     Claude Code, inspect `claude mcp list`; never run `codex` diagnostics or
     login commands there. Claude Code namespaces MCP servers loaded from a
     plugin: the current remote registration is shown as
     `plugin:trelio-agent-workspaces:trelio`, while the local server is
     `plugin:trelio-agent-workspaces:trelio-remote-skills`. Preserve the exact
     name returned by `claude mcp list`; never shorten the remote name to
     `trelio`. Its entry must use HTTP and the bundled launcher paths must
     resolve from `${CLAUDE_PLUGIN_ROOT}`. A skipped URL without `type` or
     literal `./scripts/launch-trelio-node` `ENOENT` is a stale incompatible
     plugin definition: update it through Claude's plugin manager and run
     `/reload-plugins` before retrying. Do not reset OAuth or pairing for this
     signal. The plugin version alone does not prove that either server is
     ready. In particular, Codex `auth_status: "o_auth"` identifies
     the configured authentication scheme; it does not prove that the current
     process attached a bearer. A failed live Trelio read that explicitly
     reports HTTP 401 or a required/missing bearer is an OAuth failure even
     when this status still says `o_auth`.
   - Run this loaded plugin's bundled `../../scripts/trelio-workspace.mjs` with
     `doctor --json` through its exact platform launcher: on POSIX use
     `../../scripts/launch-trelio-node`; on native Windows use
     `../../scripts/launch-trelio-node.cmd`. The launcher requires Node.js 22+,
     prefers host-owned Codex hints and its deterministic bundled runtime, then
     falls back to a system installation. Therefore an empty `command -v node`
     result or failed Codex PATH-alias creation is not proof that Node is
     absent. On Windows the launcher also uses the bundled
     `../../scripts/resolve-node.ps1`, which checks durable machine/user PATH
     values and official Program Files without editing anything. If the
     launcher cannot find Node.js 22+, follow the installation-offer flow under
     **Connect the local component**. A local Node.js problem does not prove
     that Trelio OAuth is invalid.
   - Doctor resolves a standalone Git 2.28+ only from standard
     macOS/Windows locations and durable Windows PATH; arbitrary process-PATH
     executables, including Codex's private runtime, are not candidates. It then
     proves `init → add → commit` in a temporary repository. If Git needs installation
     or upgrade, follow **Connect the local component** immediately. A Git
     problem does not prove that Trelio OAuth is invalid.
   - If the remote `trelio` server needs authentication and an OAuth window is
     already open, let the user finish that one window. If it is not open,
     immediately run the exact client command and wait for it: in Codex use
     `codex mcp login trelio`; in Claude Code use
     `claude mcp login plugin:trelio-agent-workspaces:trelio`, or direct the
     user to `/mcp` and that same exact namespaced server when the installed
     Claude Code version does not expose the CLI login command.
     The authorization URL itself redirects an unauthenticated user through
     Trelio login and back to consent. Never open the Trelio site as a
     preparatory login, use Computer Use to enter credentials, or ask the user
     to report that login finished before starting OAuth. The user personally
     completes login and consent in the single browser flow.
   - After OAuth, refresh the same client's MCP status and retry one low-risk
     Trelio read in this same task. Continue onboarding here as soon as the
     tools are callable. In Claude Code, `claude mcp list` may already show the
     namespaced server as `Connected` while a session opened before OAuth still
     lacks `list_companies` and the other remote tools. That is a stale session,
     not failed OAuth: do not run login again. End it, launch a new `claude`
     session from the same exact working folder, and repeat the setup request.
     Use the equivalent new-task recovery in Codex only when a live retry proves
     the current task still has no refreshed tools; do not assume a static tool
     list. If a retry still explicitly lacks a bearer after the user completed
     this one OAuth flow, do not start another login loop: the already-open
     client process may not have adopted the refreshed credential. Preserve the
     successful authorization.
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
2. In Codex, make approval of this plugin's hooks an explicit user checkpoint
   after confirming that the plugin is installed and before the first protected
   Trelio call. Installing or enabling a plugin does not make its bundled hooks
   trusted automatically. If no `PreToolUse` event from this exact plugin has
   already run in the current task and the user has not just confirmed the
   review, stop setup and give one client-specific action:
   - In Codex Desktop say:
     `Откройте настройки плагина Trelio Agent Workspaces, проверьте раздел Hooks,
     включите их и повторите запрос.`
   - In Codex CLI say:
     `Откройте /hooks, выберите Trelio Agent Workspaces, проверьте текущую
     конфигурацию, разрешите её и повторите запрос.`
   The user performs this review. Never automate trust, use
   `--dangerously-bypass-hook-trust`, or infer approval from an installed/enabled
   plugin, `hooks.json`, `codex plugin list --json`, or doctor output. In
   particular, `approvalStatus=client_managed_unknown` is not a positive or
   negative result. A successful or failed `PreToolUse` event proves that the
   hook is active for this task, so do not repeat this onboarding checkpoint in
   that case. The later `TRELIO_RUNTIME_HOOK_REQUIRED` handling remains the
   end-to-end fail-closed recovery if client trust changes or the hook did not
   load.
3. Resolve the exact company before `get_agent_instructions` or any local file
   write. Call `list_companies` unless a live response in the current turn has
   already returned the accessible companies. Read each returned company's
   metadata-only `encryptionState`; a legacy item without that field may be
   treated as `plain`.
   - Treat an explicit company slug from the current page, instructions, or the
     user's request as an exact selector, not as a hint. Continue only when the
     returned slug matches it exactly. If that slug is absent, stop and report
     that the requested company is unavailable; never substitute another
     company with a similar name or slug.
   - When the user supplied only a display name, continue only for one unique
     exact display-name match. With no match or more than one exact match, show
     the concise returned `display name (slug)` choices and ask the user.
   - A working-folder name or path, repository name, nearby files, and fuzzy,
     substring, or semantic similarity are never company evidence and cannot
     remove candidates from the user's choice.
   - Without an explicit selector, continue automatically only when exactly one
     company is accessible. If several are accessible, ask the user before any
     scoped read or write. A user correction invalidates the previous candidate
     and requires this resolution again before continuing.
4. Bind a project slug only when the user wants this whole working folder
   restricted to one Trelio project. A company-wide folder must not
   silently acquire a project restriction.
5. For `plain` or `encrypted`, call `get_agent_instructions` for the resolved
   company and optional project before substantive work. The logical method
   does not change with transport:
   - For `plain`, use the native result directly.
   - For `encrypted`, follow the returned `providerSelection` through its exact
     local action after completing bridge pairing and encryption setup below.
     Do not skip or rename `get_agent_instructions`; Trelio changes only the
     transport. Treat the rules as loaded only after the local continuation
     succeeds.
   Follow the effective working rules and authenticated user's personal profile
   without copying either into the local working-folder binding.
   For `encrypting`, `decrypting`, `failed`, or an unknown non-`plain` state, do
   not call `get_agent_instructions` and do not treat the company as ready. The
   folder binding and ordinary bridge pairing may be completed, but stop
   encrypted content work with the exact state and required company-settings
   action. Never create a Run or use plaintext fallback to probe through a
   transitional state.

## Create or extend the local instruction file

Read the selected working-folder instruction files before writing:

- If `AGENTS.override.md` exists at the same root, explain that it shadows
  `AGENTS.md` and ask whether to update the override or remove/rename it. Do not
  create an ineffective `AGENTS.md` silently.
- Reject a symlink, directory, device, or other non-regular target.
- Never replace unrelated existing instructions. If the managed markers
  already exist, update only their complete block. Otherwise append the block
  after a blank line or create a new file.
- Also create or safely extend the regular root `CLAUDE.md` so Claude Code loads
  the same binding. For the normal `AGENTS.md` target, a missing file must be
  created with exactly `@AGENTS.md` followed by one newline. If `CLAUDE.md`
  already exists, preserve unrelated instructions and add that standalone
  import only when it is absent. If the user selected `AGENTS.override.md` as
  the effective target, import `@AGENTS.override.md` instead. Never add both
  imports or duplicate one. Reject a symlink, directory, device, or other
  non-regular `CLAUDE.md` target.
- Show the exact proposed block or concise diff before the write. Invoking
  onboarding and choosing the company authorizes this expected,
  reversible local edit; do not add a second ceremonial confirmation unless
  the target file or scope is ambiguous.

Use this block exactly for every ready company, substituting only the verified
display name and slug:

```markdown
<!-- trelio-agent-workspaces:start -->
## Trelio

Папка привязана к компании «Компания» (`company-slug`). Это контекст работы, а не привязка Git-репозитория.

Не создавай рабочие материалы, `tmp/` или `output/` в корне этой папки. Для задачи или именованного воркспейса сначала открой Agent Run и работай только в пути, который вернул bridge. Новый Workspace bridge размещает в `workspaces/<workspace-id>/`; внутри `workspace/` лежат редактируемые файлы, а `context/` и `.trelio-run.json` остаются служебными.

Каждое сообщение обрабатывай в контексте Trelio. Уже загруженные в текущей сессии правила и данные используй повторно, пока тема, объект и требования к актуальности не изменились.

Если нужного контекста нет:

- для точной задачи вызови `get_task`;
- иначе получи правила через `get_agent_instructions`, затем вызови Trelio `search` с `companySlugs: ["company-slug"]`.

До этого не используй WebSearch, WebFetch, другие внешние источники и не отвечай по существу из собственных знаний.

Не решай самостоятельно, что запрос «нерабочий» или не требует Trelio. Пропустить проверку можно только по прямому указанию пользователя в текущем сообщении.

Если Trelio недоступен, сообщи, что контекст не проверен, и не подменяй его догадками.
<!-- trelio-agent-workspaces:end -->
```

For a deliberately project-bound setup, add one sentence before the workflow
sentence:

```markdown
Работа ограничена проектом «Проект» (`project-slug`).
```

Do not write the current skill list, connection state, user credentials, IDs,
tokens, or machine-specific absolute paths into the instruction files. The
canonical relative `workspaces/<workspace-id>/` contract above is intentional;
skills and connections are live Trelio state and may change after these files
are created.

## Connect the local component

The bundled local component requires Node.js 22 or newer and a standalone Git
2.28 or newer. Its canonical executable path is the paired
`../../scripts/launch-trelio-node` / `launch-trelio-node.cmd`, with the target
bundled `.mjs` file as the first argument. In Codex the launcher first checks
host-owned runtime hints and the deterministic bundled runtime; only then does
it inspect a system Node. Do not treat a missing PATH alias as a prerequisite
failure and do not put a machine-specific absolute path into `.mcp.json`.

If the launcher cannot find a compatible runtime, resolve `node` without a
deliberate failing probe and read its version only when an exact executable
exists. On native Windows use the bundled `../../scripts/resolve-node.ps1`
diagnostic. If it returns `ready` with `processPathReady=false`, Node is already
installed: the launcher must use its absolute `nodePath` for the bundled bridge
in this task. Do not reinstall Node, repeat restart advice, or block remote
Trelio OAuth merely because the current client process has a stale PATH. If a
selected `remoteMcpExecution` route remains unavailable, inspect
`codex mcp list --json`: a bare `node` command means the current task still
loaded an older plugin definition and needs the normal update/new-task path.

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
silently. Afterward, rerun the launcher and verify the exact version reported
by doctor. Use the absolute executable immediately for the bundled bridge. Ask
for one full app restart only if a selected `remoteMcpExecution` skill needs
the client-managed local MCP server and a new task still cannot start it. If
the user says they already restarted, do not repeat the same advice: compare
the process PATH with the durable machine/user PATH and report one exact
environment repair or a bounded unsupported-client blocker.

After compatible Node.js is available, run the bundled `trelio-workspace.mjs`
with `doctor --json` through the launcher before pairing. When it returns `ready`,
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
plugin: use the platform `launch-trelio-node` script with this skill's bundled
`../../scripts/trelio-workspace.mjs login`. Do not install `trelio-workspace`
globally or treat its normally absent `PATH` entry as an error.

If login reports a one-time pairing request, immediately call
`approve_agent_workspace_bridge_pairing` with its exact `pairingId` and
`deviceName`, then repeat the same login command. Never show a pairing code or
verifier. Do not open a company workspace, start a work run, or create and
cancel a disposable result merely to test the connection.

For exact `encrypted`, successful bridge login proves only the ordinary local
device session. Immediately run this loaded plugin's bundled bridge through
the same `launch-trelio-node` launcher with:

```text
trelio-workspace encryption setup --company <exact-slug> --json
```

This is the mandatory encrypted-device onboarding step. It may open a protected
`127.0.0.1` form; the user enters the key only there, never in chat, MCP, argv,
environment, stdin, clipboard, or a Workspace. The command creates or reuses
the local encryption/signing identity, registers its fingerprint, opens the
exact company envelope, and round-trips a random local canary through the
production `TRELIOE1` codec. It creates no Workspace, Agent Run, lease,
checkpoint, task status change, or server content row.

On `status=ready`, require `encryptionState=encrypted` and
`selfTest.status=passed` before reporting encrypted Workspace access ready. On
`access_pending`, show the returned fingerprint and settings URL and tell the
user that the company owner must grant that exact Agent Workspaces device;
after the grant, repeat the same setup command rather than starting a Run. On
`status=not_required`, the state changed to `plain`: repeat `list_companies` and
the ordinary instruction/catalog route before completion. Any transitional,
unknown, envelope, scope, or self-test error blocks encrypted content work
without a plaintext fallback.

## Offer the live Trelio skills

This onboarding step is an explicit whole-catalog inventory; it does not
replace `search_agent_skills` as the standard route for an ordinary task.

For every non-`plain` company, skip this entire section: do not call
`list_agent_skills`, do not present a blocked response as an empty catalog, and
do not offer remote integrations that require company plaintext. State instead
that encrypted Workspace content is handled by the local bridge and that skill
catalog readiness was not queried in this onboarding.

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
5. Before configuring each selected skill, call `get_agent_skill` once with the
   same exact scope and follow its current `instructionsMarkdown`,
   `runtimeExecution`, or `remoteMcpExecution`. That read covers the complete
   uninterrupted configure/doctor sequence for this skill; do not repeat it
   before each subcommand. Read it again after a user handoff resumes in a
   later turn, after the exact route changes, or on
   `AGENT_SKILL_RELEASE_CHANGED`. Configure and verify one selected skill at a
   time so an incomplete login cannot be mistaken for another skill's
   readiness.

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
2. that the folder is not a Git worktree and, if an incidental empty shell was
   detached, its exact backup path and restore rename;
3. whether the local component is connected;
4. each offered skill as ready, awaiting personal setup, or
   `требуется настройка администратором компании`;
5. the exact next action for every incomplete item.

For a non-`plain` company, include its current encryption state and say that
the remote skill catalog was intentionally not queried. For exact `encrypted`,
report bridge pairing and encrypted-device readiness separately, including the
local self-test result; never call the device ready before the setup command
returns its complete `ready` result. For transitional states, report the exact
blocker. Do not present the company as absent merely because a content tool is
unavailable.

If `AGENTS.md`, `AGENTS.override.md`, or `CLAUDE.md` changed, tell the user that
future tasks or Claude sessions opened in this folder will use the binding
automatically and that a new task/session is required for the instruction files
to become active. The current onboarding process may still finish connection
checks because this skill already carries the explicit setup scope. Do not
describe the instruction files as uncommitted or suggest committing them: the
binding folder is non-Git by contract.
