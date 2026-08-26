# Task checklist proposals

Read this file completely whenever the user asks to change checklist completion
state, when progress suggests that checklist items may now be satisfied, or after
a substantive task-scoped Run is accepted.

## Separate inferred progress from an immediate command

Checklist completion state is a human decision independent from Agent Run
acceptance, task status, comments, and controls. An accepted result never marks
an item by itself.

Use `complete_checklist_item`, or change an existing item's `isCompleted` through
`update_checklist`, only when the user explicitly and unambiguously commands the
exact item and exact state now. Only then pass
`userExplicitlyRequestedImmediateChecklistStateChange=true`. Do not derive that
assertion from completed work, a handoff, task readiness, or a general request to
keep the task current.

When the state change is inferred, use the proposal flow. Do not work around it
by recreating an item, replacing the checklist, or adding a new completed item.

## Reassess the live checklist after accepted work

After every substantive accepted task Run, call
`get_task_checklist_proposal_context` with the exact accepted `runId` and compare
the accepted result with every live ordinary item. This check is required even
when the whole task is not ready for a status transition.

Propose only completion-state transitions directly supported by the actual
result. Partial work may propose the exact items it satisfied without implying
that the entire checklist or task is complete. A prior completed item may be
proposed as incomplete only when the result directly proves that its requirement
is no longer satisfied.

Do not propose:

- checklist or item text changes;
- additions, deletions, or reordering;
- a no-op target equal to the current state;
- status-driven items linked to subtasks;
- speculative changes justified only by task status or broad progress.

If no item has a directly supported transition, render no checklist card and do
not mention a ritual “checklist unchanged” result.

## Prepare one exact decision

Use only item and checklist snapshots returned by the immediately preceding
context read. For every proposed item, preserve its exact `checklistId`,
`checklistUpdatedAt`, `itemId`, content, position, `expectedIsCompleted`,
`targetIsCompleted`, `updatedAt`, and one concrete private reason.

When this is the sole interactive proposal card, call
`render_task_checklist_proposal`. When any comment, status, control-clear, or
another checklist proposal is also needed, read `task-proposal-bundles.md` and
put the exact fields in one `checklistProposal` block of the single
`render_task_proposals` call. A substantive accepted task Run always also needs
its human comment proposal, so its checklist proposal normally uses the bundle.

The App initially selects the proposed items, but the user may deselect any of
them. Reasons explain the private decision and must not be copied to task
comments, system events, or notifications.

## Keep apply and dismissal human-controlled

Do not call `apply_task_checklist_proposal` or
`dismiss_task_checklist_proposal` because the card was rendered. Call one only
after the authenticated user presses the App action or explicitly decides the
exact visible proposal. In a text-only client, preserve the exact proposal
id/revision and wait for that decision.

Apply sends only the selected item ids. The backend rechecks live task ACL and
every selected snapshot and applies the subset atomically. A stale item blocks
the whole selected batch; reread context and prepare a fresh proposal instead of
partially applying or switching to an immediate mutation. Successful apply
creates the ordinary checklist system events and notifications, never the
private reasons.
