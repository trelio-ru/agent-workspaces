# Task status proposals

Read this file completely whenever the user asks to change a task status,
status readiness is inferred from completed work, or an accepted task Run
assessed the whole task as ready.

## Separate the whole-task decision

Treat task status as independent from both Agent Run acceptance and the human
comment proposal. Completing the immediate agent instruction may cover only
part of the task. An accepted Run and its `taskOutcome` record evidence and a
semantic recommendation; neither changes status or authorizes an immediate
mutation.

Assess the complete task description, checklists, open questions, relevant
comments, linked context, and actual result. Use `no_status_change` as the safe
handoff default for partial, informational, failed-review, or unresolved work.
After partial work, still prepare the required comment proposal, but do not
create a status proposal.

## Distinguish a direct command from inferred readiness

Use `update_task_status`, a `statusCode` task patch, batch patch, or
`move_task_to_project` only when the user explicitly and unambiguously commands
changing the exact task to the exact status now. Only then set
`userExplicitlyRequestedImmediateStatusChange=true`. Completing work, accepting
a Run, the agent's own assessment, or a conditional instruction such as “when
done move to review” does not satisfy this assertion.

Without that exact direct command, never send `statusCode` through an immediate
mutation. If the whole task is genuinely ready, use the separate proposal flow
below. A project move itself has no inferred-readiness proposal path; do not
call `move_task_to_project` without the direct command.

## Prepare the editable status decision

1. Call `get_task_status_proposal_context` with the accepted task Run `runId`
   or the exact `companySlug`, `projectSlug`, and `taskNumber`.
2. Choose one currently transitionable target returned by that context. Use
   the semantic `taskOutcome` only as a recommendation, never as authority.
3. Call `render_task_status_proposal` with the exact `stateRevision`, current
   status id, target status code, and a concise reason explaining why the whole
   task is ready.

The rendered card is independent from the comment card. Do not merge one into
the other and do not omit the comment proposal after a substantive accepted
task Run. If status changed between read and render/apply, reread the context;
never overwrite the newer decision.

## Keep apply and dismissal human-controlled

Do not call `apply_task_status_proposal` or
`dismiss_task_status_proposal` merely because the card was rendered. Call one
only after the authenticated user presses the corresponding MCP App action or
explicitly approves/rejects that exact proposal. A text-only fallback still
requires the user's decision; a promise in the final response is not approval.

Before reporting completion, state honestly whether no status proposal was
needed, a separate proposal is awaiting the user, it was dismissed, or its
exact transition was applied. Never report Agent Run acceptance as a status
change.
