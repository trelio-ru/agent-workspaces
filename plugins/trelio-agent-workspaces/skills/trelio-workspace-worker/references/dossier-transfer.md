# Dossier transfer

Read this file completely before moving an existing dossier between project or
company owners. Transfer changes direct reader/management scope; it does not
create another dossier.

1. Resolve the exact `dossierId`, current owner, company, and target project or
   company. Never infer a target from a similar project name.
2. Call `plan_dossier_transfer` before every transfer. The authenticated user
   must independently manage both sides: company scope requires company
   owner/admin; project scope requires project admin or company owner/admin.
   Read inherited from a linked task never satisfies this check.
3. Preserve and inspect the complete plan: source and target, permission
   checks, linked-task count, open-Run count, warnings, and actor-bound
   `expectedStateHash`. Do not implement transfer by copying files, creating a
   replacement dossier, or unlinking tasks.
4. A direct user request identifying the exact dossier and exact target project
   is sufficient to apply the current project-target plan. If the agent
   suggested the move, selected the target, or resolved ambiguity, show the
   complete plan and wait for explicit confirmation.
5. A company target widens direct read to every active company member. Supply a
   concrete `companyScopeReason`, show the plan, and obtain separate explicit
   confirmation before `confirmCompanyWideAccess: true`.
6. Do not apply while the plan reports unfinished `running`,
   `waiting_for_human`, legacy `review`, or claimable `expired` Runs. Do not
   cancel another Run merely to unblock transfer; finish it or obtain explicit
   authority to cancel, then prepare a fresh plan.
7. Call `apply_dossier_transfer` with the exact target, reason when applicable,
   `expectedStateHash`, and a stable `clientRequestId`. Never reuse the hash
   with another actor or target. On `DOSSIER_TRANSFER_OUTDATED`, prepare and
   reassess a fresh plan rather than retry stale state.
8. Verify the returned owner. Dossier UUID, accepted Git history, revisions,
   and task links must remain unchanged. The Workspace must still have no
   implicit material parent; only owner metadata and its ACL change.
