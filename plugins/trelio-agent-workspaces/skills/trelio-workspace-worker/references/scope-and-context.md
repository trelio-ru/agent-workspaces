# Scope and related context

Read this file completely before discovering or selecting a Trelio task,
project, company, writable workspace, relation, work case, or related read-only
context.

Treat company/project mappings in local `AGENTS.md` as control-plane bindings,
not writable Workspace scopes. A Codex project may allow one or several
companies or projects. Keep exact company boundaries, but never narrow
Workspace discovery to one project when a workspace may be explicitly linked
to several projects. Ask only when ambiguity remains after read-only discovery.

Discovery calls are intentionally available without runtime admission. Exact
content reads selected from discovery are protected: the approved client hook
injects a fresh one-use `runtimeSessionProof`. Never add or copy that field. If
Trelio itself reports that the hook is unavailable, stop before reading content
and follow the explicit `TRELIO_RUNTIME_HOOK_REQUIRED` recovery steps. An
active `PreToolUse` failure preserves its separate exact code and reason; never
reclassify it as missing Hooks.

## Resolve the work item

Trelio context search is lexical, not semantic. Company/project rules are not
search documents and never compete with tasks or workspaces in ranking. If the
user supplied one canonical task URL or one exact company/project/task
coordinate, call `get_task` directly. If 2–20 distinct exact task locators are
already known or selected together, call `get_tasks` once in the required
order; do not make repeated `get_task` calls. Otherwise:

1. Build up to five short independent queries: important nouns, synonyms,
   abbreviations, alternate spellings, old names, object/city, counterparty,
   document type, and expected result.
2. Call the canonical unified `search` once with separate `queries` and every
   exact permitted `companySlugs`. Omit company scope only when discovery is
   genuinely cross-company. Do not concatenate synonyms into one query.
3. Inspect the mixed result set as one context decision. The same call searches
   first-class workspaces, projects, active and archived tasks, task
   descriptions/comments, and accepted Workspace files. A plausible task must
   not suppress a procedure or prior decision found in another workspace.
4. Prefer results found by several variants. Use returned exact metadata and
   `fetch` to inspect up to three material documents or task candidates. Call
   `get_workspace` for a first-class workspace, `get_task` for one probable
   task, or `get_tasks` for several probable tasks before a mutation or Run.
   `fetch`, `get_workspace`, `get_project_meta`, and `get_task_create_meta`
   return their ordinary `effectiveInstructions` envelope. Apply loaded
   instructions before object content outside a prepared Agent Workspace Run.
   Inside a prepared Run, its pinned `agent-instructions.md` and
   `user-profile.md` remain authoritative; a later exact read cannot replace
   that immutable snapshot. If an exact read says `requires_scope`, use the
   standard `get_agent_instructions` consent/recovery flow. Do not call
   `get_agent_instructions` again after loaded instructions unless the user is managing rules, the
   scope changes without another exact read, or the server asks for refresh.
5. Treat a candidate as probable only when at least two independent identifiers
   agree. A similar title alone is insufficient. A supplied canonical URL or
   exact coordinates count after successful readback.
6. If several candidates remain, show their direct URLs or identifying fields
   and ask before a mutation or Run.

### Recover a bounded search timeout

`MCP_SEARCH_TIMEOUT` is a structured, server-confirmed read-only search budget
failure, not a transport outage and not evidence of broken OAuth, Hooks, MCP
registration, company access, or a missing object. Do not apply generic network
retries or repeat the same broad call unchanged.

Retry at most once in the current turn, and only with a strictly narrower
request:

1. Pass exact `companySlugs`.
2. Keep at most the two strongest independent formulations.
3. When an exact project boundary is known and task-only refinement is enough,
   use one `search_tasks` call with exact `projectSlugs`.

If no truthful narrower scope exists, or that retry returns the same code, stop
and ask for the missing company/project discriminator. Do not switch to a
browser, HTTP, another MCP, `list_workspaces`, or a chain of per-query calls.
An HTTP 504 without structured `MCP_SEARCH_TIMEOUT` remains a transport/service
failure and follows the diagnostics path.

## Resolve task-read instructions

Current `get_task` and `get_tasks` return `schemaVersion: 3` with a compact task
core. Each item has one structured `task`; Text `content` is only a summary.

For every item in `tasks[]` independently:

1. Require `instructionScope.status=loaded` before substantive work. On
   `requires_scope`, complete the standard consent flow for that exact scope.
2. Index `effectiveInstructions.layers` by unique `key`. Resolve every key in
   the item's `instructionScope.orderedLayerKeys`; a missing key or conflicting duplicate
   is an invalid response and stops work.
3. Apply only the resolved layers, in returned order. Never apply a company,
   project, or personal layer to a task that does not reference it.
4. Keep `effectiveRevisionKey` when a later step must verify that the effective
   order did not change.

Then inspect `task.deferredSections`. Call `get_task_sections` once with the same
locator and only the needed subset; do not repeat `get_task` or request all
sections by default. `itemCount: 0` means known-empty; `null` means not counted.
Attachments are metadata, not bytes. The supplement rechecks ACL without
repeating effective instructions, core fields, connections, or related
workspaces.

Schema v1/v2 is unsupported and indicates a plugin/backend mismatch. Use the
normal upgrade path instead of interpreting the old payload.

`search_tasks` and `search_agent_workspace_files` are optional refinements, not
mandatory consecutive stages. Use the former for task-only ambiguity and the
latter for Workspace-file ambiguity.

If no task matches, use relevant workspace hits from the unified result before
creating anything. Do not call `list_workspaces` merely to discover context:
unified search already covers first-class workspaces and accepted files across
projects. Use `list_workspaces` only for explicit inventory/management of one
known owner scope. Prefer an existing project workspace for a continuing
subject, or `create_workspace` when one project is the narrowest sufficient
owner. Create a company workspace only for genuinely cross-project context safe
for every active company member, or after an explicit company-wide request.
Absence of a task never justifies company scope. Company workspace creation
requires a concrete `companyScopeReason` and `confirmCompanyWideAccess=true`.

Every task has at most one canonical task-owned workspace. Durable context not
owned by one task uses a named workspace whose primary owner is one project or
the company. A named workspace may additionally link to any number of projects
and tasks in the same company; these links do not change the primary project or
the rules pinned by new Runs.

## Access and related context

Workspace access is the union of its owner and all explicit task/project links:

- A task reader may read its canonical workspace and every linked workspace.
  A user who may edit that exact task may also write and run those workspaces.
- A project reader, including an observer, may read linked workspaces. A
  project member or moderator may write and run them.
- Every active company member may read a company-owned workspace; only company
  owners and administrators may write or run it through the owner scope.
- Relation-derived access never grants link management, resharing, transfer, or
  access to the workspace's primary project. Manage a relation only with
  independent authority over the workspace and the exact task/project target.
- Archived workspaces are read-only. Cross-company relations are forbidden.
- Registry, contact, and meeting associations are semantic references only;
  they never grant Workspace access by themselves.

This read/write distinction follows the source object rather than introducing
a separate manual Workspace ACL. It preserves read-only project observers and
other users who can see but cannot edit the task/project.

Read `relatedWorkspaces` from exact task responses before searching more widely.
Use `get_workspace` for current metadata, visible relations and accepted
material coordinates; every read reapplies ACL. Use
`prepare_agent_workspace_read` with `workspaceId`, or with task addressing for
the canonical task workspace, before local read-only materialization.

### Persist task and project relations

- A task–workspace link is durable and exposes the whole accepted workspace to
  current and future task readers. Task readers get read; task editors get
  write/Run without relation-management authority. After exact reads, call
  `link_workspace_task` without a ceremonial confirmation only when one durable
  match has at least two stable independent identifiers and the whole workspace
  suits the task audience. Report what was linked, why, and the resulting
  access. Add no comment or notification unless separately asked.
- Multiple candidates, one identifier, temporary relevance, or unclear
  whole-workspace disclosure require a question. A weak hit is ignored; a
  partial fit uses narrower pinned context for one Run.
- Use `link_workspace_project` when the same durable material genuinely belongs
  in several projects. Project readers then gain read access and project
  editors gain write/Run access. The primary project and governing rules stay
  unchanged. Use `unlink_workspace_project` only for a secondary project; move
  the primary owner through the guarded transfer flow first.
- `unlink_workspace_task` and `unlink_workspace_project` remove only the exact
  relation. They never delete either object or rewrite Git history.

When ordinary tasks need a direct task-to-task connection, prefer
`create_task_relation`. Describe `relationType` in precise human language and
set `isDirectional` only when order matters. Use a work case only when several
tasks genuinely represent one shared subject, with a stable unique
`clientRequestId`.
