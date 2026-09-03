# Workspace transfer

Read this file completely before changing the primary project/company owner of
an existing named workspace. Transfer changes governing rules and direct owner
access; it does not create another workspace or remove secondary relations.

1. Resolve the exact `workspaceId`, current owner, company, and target project
   or company. Never infer a target from a similar project name.
2. Call `plan_workspace_transfer` before every transfer. The authenticated user
   must independently manage both sides: company scope requires company
   owner/admin; project scope requires project admin or company owner/admin.
   Access derived from a task/project relation never satisfies this check.
3. Preserve and inspect the complete plan: source and target, permission checks,
   relation counts, unfinished-Run count, warnings, and actor-bound
   `expectedStateHash`. Do not transfer by copying files, creating a replacement
   workspace, or unlinking tasks/projects.
4. A direct user request identifying the exact workspace and target project is
   sufficient to apply the current project-target plan. If the agent suggested
   the move, selected the target, or resolved ambiguity, show the complete plan
   and wait for explicit confirmation.
5. A company target gives every active company member direct read access.
   Supply a concrete `companyScopeReason`, show the plan, and obtain separate
   explicit confirmation before `confirmCompanyWideAccess: true`.
6. Do not apply while the plan reports an unfinished or claimable Run. Do not
   cancel another Run merely to unblock transfer; finish it or obtain explicit
   authority to cancel, then prepare a fresh plan.
7. Call `apply_workspace_transfer` with the exact target, reason when
   applicable, `expectedStateHash`, and a stable `clientRequestId`. Never reuse
   the hash with another actor or target. On `WORKSPACE_TRANSFER_STATE_CHANGED`,
   prepare and reassess a fresh plan instead of retrying stale state.
8. Verify the returned owner. Workspace UUID, accepted Git history, revisions,
   task links, project links, registry links, and other semantic associations
   must remain unchanged. Only primary owner metadata and its governing ACL
   change.
