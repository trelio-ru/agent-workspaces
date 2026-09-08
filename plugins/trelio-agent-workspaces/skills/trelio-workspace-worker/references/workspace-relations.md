# Durable workspace and task relations

Read this file completely before linking/unlinking workspaces, changing project relations,
or creating direct task relations/work cases. Resolve both exact targets and
apply the access boundary in `scope-and-context.md` first.

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
