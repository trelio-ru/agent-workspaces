---
name: trelio-project-onboarding
description: Set up Trelio Agent Workspaces in the current Codex project, create or safely extend its durable AGENTS.md company/project binding, verify OAuth and local bridge pairing, discover the live Trelio skill catalog, and guide selected company or personal connections without exposing credentials. Use after installing or authorizing the Trelio plugin, when the user asks to connect or configure Trelio for a project, when a project needs its Trelio AGENTS.md block, or when the user wants to configure the Trelio skills available to them.
---

# Trelio Project Onboarding

Set up one local Codex project without starting a disposable Trelio workspace
run. Keep the project binding durable in the local instruction file, but always
read the current skill catalog and connection state from Trelio.

## Check prerequisites

1. Require callable Trelio MCP tools, not only this skill text. If tools are
   missing, ask the user to open `Plugins -> Trelio Agent Workspaces`, complete
   Trelio OAuth, and start a new task. Require a full Codex restart only if that
   new task still lacks the tools or reports the old plugin version. If the
   marketplace itself is missing, use
   `codex plugin marketplace add trelio-ru/agent-workspaces`; its
   `INSTALLED_BY_DEFAULT` policy makes a separate plugin-add command
   unnecessary.
2. Resolve the current local project root from the active workspace. Prefer
   the Git root when the project is a repository. Do not place this binding
   inside a materialized Trelio Agent Workspace: a nearby `.trelio-run.json`
   or the protected managed-workspace `AGENTS.md` means the user must return to
   their ordinary Codex project first.
3. Resolve the exact company. Reuse an explicit company slug from current
   instructions or the user's request; otherwise call `list_companies`.
   Automatically continue only when one accessible company or one exact match
   remains. Ask the user to choose when several companies are plausible.
4. Bind a project slug only when the user wants this whole Codex project
   restricted to one Trelio project. A company-wide Codex project must not
   silently acquire a project restriction.
5. Call `get_agent_instructions` for the resolved company and optional project
   before making substantive setup changes. Follow the effective working rules
   and authenticated user's personal profile without copying either into the
   local project binding.

## Create or extend the local instruction file

Read the project-root instruction files before writing:

- If `AGENTS.override.md` exists at the same root, explain that it shadows
  `AGENTS.md` and ask whether to update the override or remove/rename it. Do not
  create an ineffective `AGENTS.md` silently.
- Reject a symlink, directory, device, or other non-regular target.
- Never replace unrelated existing instructions. If the managed markers
  already exist, update only their complete block. Otherwise append the block
  after a blank line or create a new file.
- Show the exact proposed block or concise diff before the write. Selecting
  the starter prompt and choosing the company authorizes this expected,
  reversible local edit; do not add a second ceremonial confirmation unless
  the target file or scope is ambiguous.

Use this block, substituting the verified display name and slug:

```markdown
<!-- trelio-agent-workspaces:start -->
## Контекст Trelio

Этот Codex-проект связан с компанией Trelio «Компания» (`company-slug`).

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

Run `trelio-workspace login` through the logical launcher of this installed
plugin. Resolve it without executing a failing probe: use the PATH command when
present, otherwise replace only the first token with Node.js 22+ and this
skill's bundled `../../scripts/trelio-workspace.mjs`.

If login reports a one-time pairing request, immediately call
`approve_agent_workspace_bridge_pairing` with its exact `pairingId` and
`deviceName`, then repeat the same login command. Never show a pairing code or
verifier. Do not open a company workspace, start a work run, or create and
cancel a disposable result merely to test the connection.

## Offer the live Trelio skills

1. Call `list_agent_skills` once for the exact effective scope. Use only
   `companySlug` for a company-wide Codex project; include `projectSlug` for a
   deliberately project-bound setup. Do not scan every visible project to
   collect project-only skills.
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
   - Deduplicate skills that reuse the same provider connection. For example,
     consumers of the `1c-edo` connection share its administrator blocker and
     must not look like separate company connections.
   - If `minPluginVersion` or the runtime host requires a newer plugin, stop
     setup for that item and let the bridge attempt its quiet official Codex
     update first. Continue in the same task after successful re-dispatch;
     otherwise use a new task, and require a full restart only if the new task
     still sees the old version.
4. Briefly ask which available skills the user wants to configure. Do not
   connect everything automatically. In a company-wide setup, explain that
   project-only skills will be offered just in time when a concrete Trelio
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
- A missing company value belongs in the protected Trelio company connection
  form and requires an administrator. A personal session belongs only to the
  current member's private local integration directory.
- Leave communication send policy at `confirm` unless the user directly asks
  for `read-only` or `autonomous`. Company policy may forbid autonomous mode
  but never enables it for the user.

## Finish

Summarize:

1. the company and optional project bound to the local Codex project;
2. whether the local component is connected;
3. each offered skill as ready, awaiting personal setup, or
   `требуется настройка администратором компании`;
4. the exact next action for every incomplete item.

If `AGENTS.md` or `AGENTS.override.md` changed, tell the user that future tasks
will load the binding automatically and that a new task is required for the
new instruction file to become active. The current onboarding task may still
finish connection checks because this skill already carries the explicit
setup scope.
