# Task status proposals

Read this file completely before opening any task-scoped Run, whenever the user
asks to change a task status, when status readiness is inferred from completed
work, or when an accepted task Run assessed the whole task as ready.

## Keep the two inferred intents separate

Task status is independent from Agent Run lifecycle and the human comment
proposal. Neither opening nor accepting a Run changes status. An inferred
status decision always uses one of these exact intents:

- `work_started` is the one-shot, non-blocking suggestion made immediately
  after a task-scoped bridge `open` succeeds. It can only represent a semantic
  `queue` to `active` transition returned by the server.
- `whole_task_ready` is the completion suggestion made only after the complete
  task is assessed as ready for semantic `review` or `done`.

One task/member has one current status draft. A later `whole_task_ready`
proposal replaces a still-pending `work_started` proposal, so never render two
status cards for the same task. Opening, checkpointing, pausing, accepting, or
commenting never applies either proposal.

## Offer work start once after open

After the exact bridge `open` succeeds and before the first substantive work
action:

1. Call `get_task_status_proposal_context` exactly once with that running task
   Run's `runId`.
2. Inspect only `workStartProposal`. When its `state` is `eligible`, call
   `render_task_status_proposal` with `intent=work_started`, the returned
   `stateRevision`, `expectedStatusId`, exact `targetStatus.code`, and a concise
   reason that work began in the opened Run. Use the server-selected first
   transitionable semantic `active` target; never infer it from a localized
   status name or code.
3. Continue the Run immediately after rendering. Do not wait for the user to
   apply or dismiss the card.

For `run_not_active`, `task_not_queued`,
`no_transitionable_active_status`, `already_pending`,
`whole_task_proposal_pending`, `dismissed_for_current_status`, or
`already_proposed_for_current_status`, render nothing. A durable server marker
keeps an already shown start suppressed even if a completion proposal later
replaces it and is applied or dismissed.

Do not repeat the context read or start proposal after a tool action,
checkpoint, pause, progress update, resumed assistant turn, or another Run for
the same unchanged task status cycle. In particular, never evade dismissal by
using the direct task locator: backend suppression lasts until the task
actually leaves that queue status and later enters a new status epoch.

## Assess completion across the whole task

Completing the immediate agent instruction may cover only part of the task. An
accepted Run and its `taskOutcome` record evidence and a semantic
recommendation; neither authorizes an immediate mutation.

Assess the complete task description, checklists, open questions, relevant
comments, linked context, and actual result. Use `no_status_change` as the safe
handoff default for partial, informational, failed-review, or unresolved work.
After partial work, still prepare the required comment proposal, but do not
create a `whole_task_ready` proposal.

Make this decision before composing the final response or raising a new
follow-up about task metadata. An unset optional due date, assignee, control,
or similar field is not an open task question by itself and must not downgrade
a completed task. It blocks readiness only when the task requirements or the
target transition policy actually require that value. Likewise, future
maintenance or an optional improvement belongs in the next action; do not
invent it as unfinished scope.

After the whole task is ready and the context offers a transitionable semantic
`review` or `done` target, rendering `intent=whole_task_ready` is required
before the final response. A start proposal, comment proposal, accepted Run,
recorded `no_status_change`, or prose question about an optional field is not a
substitute for that separate completion decision.

## Distinguish a direct command from inferred readiness

Use `update_task_status`, a `statusCode` task patch, batch patch, or
`move_task_to_project` only when the user explicitly and unambiguously commands
changing the exact task to the exact status now. Only then set
`userExplicitlyRequestedImmediateStatusChange=true`. Completing work, accepting
a Run, the agent's own assessment, or a conditional instruction such as “when
done move to review” does not satisfy this assertion.

Without that exact direct command, never send `statusCode` through an immediate
mutation. Use the applicable inferred intent above instead. A project move
itself has no inferred status-proposal path; do not call
`move_task_to_project` without the direct command.

## Prepare the editable status decision

1. For completion, call `get_task_status_proposal_context` with the accepted
   task Run `runId` or the exact `companySlug`, `projectSlug`, and `taskNumber`.
   Direct task locators support only `whole_task_ready`; `work_started` always
   requires the exact currently running Run and the one-shot procedure above.
2. Choose one currently transitionable semantic `review` or `done` target
   returned by that context. Use `taskOutcome` only as a recommendation, never
   as authority. If final evidence proves the whole task ready despite an
   over-conservative `no_status_change`, prepare the live proposal.
3. Inventory every interactive comment, status, and control-clear card needed
   in the current assistant response. If this status is the sole card, call
   `render_task_status_proposal` with `intent=whole_task_ready`, the exact
   `stateRevision`, current status id, target status code, and a concise reason
   explaining why the whole task is ready. If the response needs two or more
   cards, read
   `task-proposal-bundles.md` and put these same exact fields in this card's
   `statusProposal` block in the one `render_task_proposals` call.

The rendered card is independent from the comment card. Do not merge one into
the other's text and do not omit the comment proposal after a substantive
accepted task Run. Independence is represented by separate cards inside one
bundle when both are needed. A completion render is allowed to replace the
older start draft. If status changed between the completion read and
render/apply, reread the context; never overwrite the newer task decision.

## Keep apply and dismissal human-controlled

Do not call `apply_task_status_proposal` or
`dismiss_task_status_proposal` merely because the card was rendered. Call one
only after the authenticated user presses the corresponding MCP App action or
explicitly approves/rejects that exact proposal. A text-only fallback still
requires the user's decision; a promise in the final response is not approval.

When no status proposal was rendered, no status-related error affects the work,
and no task-status action is required from the user, do not mention that absence
in progress or final text; continue silently. Otherwise mention task status only
when it is relevant to the user's request or next action: a proposal is actually
awaiting the user, the user asked about status, the user dismissed a proposal in
the current exchange, an exact transition was applied, or a status-related error
or blocker affects the work. Never report Agent Run acceptance as a status
change.
