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
user supplied one canonical task URL or one exact company/project/task
coordinate, call `get_task` directly. If 2-20 distinct exact task locators are
already known or selected together, call `get_tasks` once in the required
order; do not make repeated `get_task` calls. Otherwise:

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
   call `get_task` for one probable task or `get_tasks` for several exact
   probable tasks before a mutation or Run. Exact `fetch`, `get_dossier`,
   `get_project_meta`, and `get_task_create_meta` return their ordinary
   `effectiveInstructions` envelope. Task reads use the normalized contract
   below. Apply loaded instructions before object content outside a prepared
   Agent Workspace Run. Inside a prepared Run, its pinned
   `agent-instructions.md` and `user-profile.md` remain authoritative; current
   revisions from a later exact read must not replace that immutable snapshot.
   If an ordinary exact read says `requires_scope`, use the standard
   `get_agent_instructions` consent/recovery flow. Do not call
   `get_agent_instructions` again after loaded instructions unless the user is
   managing rules, the scope changes without another exact read, or the server
   asks for refresh. Read activity or attachments only as needed to
   distinguish candidates.
5. Treat a candidate as probable only when at least two independent identifiers
   agree. A similar title alone is insufficient. A supplied canonical URL or
   exact coordinates count after successful readback.
6. If several remain, show their direct URLs and differences and ask before a
   mutation or workspace Run.

### Recover a bounded search timeout

`MCP_SEARCH_TIMEOUT` is a structured, server-confirmed read-only search budget
failure, not a transport outage and not evidence of broken OAuth, Hooks, MCP
registration, company access, or a missing object. Do not apply the generic
three network retries and do not repeat the same broad call unchanged.

Retry at most once in the current turn, and only after making the request
strictly narrower:

1. Pass the exact `companySlugs`; never omit company scope on the retry.
2. Keep at most the two strongest independent formulations. Do not concatenate
   synonyms or alternate names into one longer query.
3. When an exact project boundary is already known and task-only refinement is
   sufficient, use one `search_tasks` call with exact `projectSlugs`. Do not add
   a project filter merely to guess around cross-project context.

If no truthful narrower scope exists, or the one narrowed retry returns the
same code, stop and explain which scope is still broad; ask for the missing
company/project discriminator instead of retrying again or switching to
browser, HTTP, another MCP, `list_dossiers`, or a chain of per-query calls. An
HTTP 504 without structured `MCP_SEARCH_TIMEOUT` remains a transport/service
failure and follows the dedicated diagnostics path.

## Resolve task-read instructions

Current `get_task` and `get_tasks` return `schemaVersion: 2` with the complete
payload in `structuredContent`. Every item contains one structured `task`, not
a derived `document.text` copy. Treat text `content` only as a compact summary;
it intentionally does not repeat full task or instruction Markdown.

For every item in `tasks[]` independently:

1. Require `instructionScope.status=loaded` before substantive work. On
   `requires_scope`, complete the standard consent flow for that exact scope.
2. Index `effectiveInstructions.layers` by unique `key`. Resolve every key in
   the item's `instructionScope.orderedLayerKeys`; a missing key or conflicting
   duplicate is an invalid response and must stop work instead of guessing.
3. Apply only the resolved layers, in the returned order, before interpreting
   that task. Never concatenate the whole catalog for every task and never
   apply a company, project, or personal layer to an item that does not
   reference it.
4. Keep `effectiveRevisionKey` as the exact task-scope fingerprint when a later
   step needs to establish whether the effective order changed.

During the ordered plugin-before-backend rollout only, a server that does not
advertise `get_tasks` may still return legacy `get_task` schema v1 with one
leading `effectiveInstructions` envelope and a top-level task. Apply that
loaded envelope exactly as returned. Once `get_tasks` is advertised, always use
the v2 routing above for multiple exact targets; do not voluntarily fall back
to repeated legacy reads.

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

- Each task item returned by `get_task` or `get_tasks` contains accessible
  linked dossiers, task links, and work-case members. Read those explicit
  relations first; they are the cheapest and most reliable context signal.
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
