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

## Resolve the work item

Trelio task search is lexical, not semantic. If the user supplied a canonical
task URL or exact company/project/task coordinates, call `get_task` directly.
Otherwise:

1. Build 5–12 short independent queries: important nouns, synonyms,
   abbreviations, alternate spellings, old names, object/city, counterparty,
   document type, and expected result.
2. Call `search_tasks` once with separate `queries` and every permitted
   `companySlugs`; pass `projectSlugs` only when the request or local rules
   actually restrict them. Never concatenate synonyms into one query.
3. Prefer matches found by several variants, but verify up to three material
   candidates with `get_task`. Read activity or attachments only as needed to
   distinguish them.
4. Treat a candidate as probable only when at least two independent identifiers
   agree. A similar title alone is insufficient. A supplied canonical URL or
   exact coordinates count after successful readback.
5. If several remain, show their direct URLs and differences and ask before a
   mutation or workspace Run.

If no task matches and durable context is still needed, search readable
Workspace files and metadata for the subject. Do not call `list_dossiers`
merely to discover context: global search already covers accessible task and
dossier Workspace across projects. Use `list_dossiers` only when the user asks
to browse/manage a known collection or when exact owner-scope enumeration is
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
- Use one `search_agent_workspace_files` call with up to five independent
  `queries` for concepts, names, decisions, old names, or prior materials
  across every readable Workspace. Do not pass a project filter. Search is
  ACL-aware and can find cross-project relations; read only exact material hits
  with `get_agent_workspace_file`.
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
