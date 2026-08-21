# Scope and related context

Read this file completely before discovering or selecting a Trelio task,
dossier, project, company, writable workspace, relation, work case, or related
read-only context.

Treat company/project mappings in local `AGENTS.md` as control-plane bindings,
not writable Workspace scopes. A Codex project may allow one or several
companies or projects. Keep explicit company boundaries, but never narrow
Workspace context discovery to the current project: relevant material may be
linked across projects. Ask only when ambiguity remains after read-only
discovery.

Discovery calls are intentionally available without runtime admission. Exact
content reads selected from discovery are protected: the approved client hook
injects a fresh one-use `runtimeSessionProof`. Never add or copy that field. If
Trelio itself reports that the hook is unavailable, stop before reading content
and follow the explicit `TRELIO_RUNTIME_HOOK_REQUIRED` recovery steps. An
active `PreToolUse` failure preserves its separate exact code and reason; never
reclassify it as missing Hooks.

## Resolve the work item

Trelio context search is lexical, not semantic. Company/project rules are not
search documents and never compete with tasks or dossiers in ranking. If the
user supplied a canonical task URL or exact company/project/task coordinates,
call `get_task` directly and apply its leading `effectiveInstructions` before
the task content. Otherwise:

1. Build up to five short independent queries: important nouns, synonyms,
   abbreviations, alternate spellings, old names, object/city, counterparty,
   document type, and expected result.
2. Call the canonical unified `search` once with separate `queries` and every
   exact permitted `companySlugs`. Omit company scope only when discovery is
   genuinely cross-company. Never concatenate synonyms into one query.
3. Inspect the mixed result set as one context decision. The same call searches
   projects, active and archived tasks, task descriptions/comments, and
   accepted task/dossier Workspace files. A plausible task must not suppress a
   procedure or prior decision found in a dossier or task Workspace.
4. Prefer results found by several variants. Use returned exact scope metadata
   and `fetch` to inspect up to three material documents or task candidates;
   call `get_task` for the probable task before a mutation or Run. Exact
   `fetch`, `get_task`, `get_dossier`, `get_project_meta`, and
   `get_task_create_meta` return `effectiveInstructions` first. Apply a
   `loaded` envelope before the object content outside a prepared Agent
   Workspace Run. Inside a prepared Run, its pinned `agent-instructions.md`
   and `user-profile.md` remain authoritative; current revisions from a later
   exact read must not replace that immutable snapshot. If an ordinary exact
   read says `requires_scope`, use the standard `get_agent_instructions`
   consent/recovery flow. Do not call `get_agent_instructions` again after a
   loaded envelope unless the user is managing rules, the scope changes
   without another exact read, or the server asks for refresh. Read activity
   or attachments only as needed to distinguish candidates.
5. Treat a candidate as probable only when at least two independent identifiers
   agree. A similar title alone is insufficient. A supplied canonical URL or
   exact coordinates count after successful readback.
6. If several remain, show their direct URLs and differences and ask before a
   mutation or workspace Run.

`search_tasks` and `search_agent_workspace_files` remain optional refinement
tools, not consecutive mandatory procedures. Use `search_tasks` when ambiguity
is specifically task-only and needs more formulations or project filters. Use
`search_agent_workspace_files` when ambiguity is specifically Workspace-only
and needs more file hits. Do not repeat both after a sufficient unified result.

If no task matches, use relevant dossier/task Workspace hits from the same
unified result before creating anything. Do not call `list_dossiers` merely to
discover context: unified search already covers accessible task and dossier
Workspace across projects. Use `list_dossiers` only when the user asks to
browse/manage a known collection or when exact owner-scope enumeration is
itself required. Prefer an existing project dossier for a continuing subject,
or create one when a project is the narrowest owner. Use a company dossier only
for genuinely cross-project context safe for every company member, or after an
explicit company-wide request. Absence of a task never justifies company scope
by itself. Company dossier creation requires a concrete `companyScopeReason`
and explicit `confirmCompanyWideAccess`. Do not create a task without authority.

Use task scope for task-owned work and dossier scope for a durable subject not
owned by one task. Company/project rules remain pinned instruction snapshots,
not material Workspace. If a broad result is durable, store it in a project
dossier by default or an explicitly justified company dossier.

## Discover related context

Discover context when it can materially improve the result; do not crawl every
workspace.

- `get_task` returns accessible linked dossiers, task links, and work-case
  members. Read those explicit relations first; they are the cheapest and most
  reliable context signal.
- A dossier is agent-only and has no standalone browser page. `task_full` from
  a linked task grants only read access; it never exposes the owner project or
  grants dossier write, Run, approval, or link-management rights.
- Creating/removing a task–dossier link requires independent dossier
  owner-scope management plus task edit access. Access inherited from another
  link is insufficient.
- If the exact task was opened directly and more context can materially help,
  call unified `search` once with up to five independent `queries` and the exact
  company scope. It can find cross-project task/dossier material without a
  project filter. Read only material hits that affect the result. Use
  `search_agent_workspace_files` only when the remaining ambiguity is confined
  to Workspace files.
- Use `get_dossier` for metadata and visible task links, and
  `get_agent_workspace_by_scope` when an exact linked UUID is already known.
  Every read reapplies ACL.
- Do not create an unrelated workspace merely to attach it as context.

When ordinary tasks need a direct connection, prefer `create_task_relation`.
Describe `relationType` in precise human language; examples such as
“Блокирует” are not an enum. Set `isDirectional` only when order matters. Use
a work case only when several tasks genuinely represent one shared subject,
and pass a stable unique `clientRequestId` to `create_work_case`. Do not group
merely adjacent tasks.
