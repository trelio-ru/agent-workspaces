# Task-scoped Run

Read this file completely for a writable task-scoped Run. It supplements
`agent-run.md` with whole-task outcome and reporting. The main skill also routes
comment, status and checklist decisions to their dedicated references.

## Choose the handoff outcome

Every task-scoped handoff must pass exactly one `taskOutcome` based on
the readiness of the whole task and semantic status kind, never only the scope
of the latest instruction or a localized name/code. Outcome records a
recommendation; accepted Run does not change task status:

- `work_completed`: the entire task is ready. Recommend the first
  transitionable `review` status, or `done` if no review status exists.
- `review_passed`: only after this Run successfully reviews a task already in
  semantic `review`; recommend `done`.
- `direct_completion`: only when the user explicitly says to skip review, a
  pinned rule permits it, or the same authenticated user created and assigned
  the task to themselves. This recommends `done`; even then prefer
  `work_completed` unless there is a concrete reason to skip review.
- `no_status_change`: partial/informational work, failed review, or a handoff
  with unresolved completion-blocking questions. This is the safe default
  whenever the direct request may be narrower than the full task.

For example, execute the returned `bridge.actions.finish` through
`continue_trelio_workspace_action` with the exact opened `workingDirectory` and
parameters `summary`, `evidence`, `filePaths`, `nextAction`, and
`taskOutcome=work_completed`.

Use `questions` and `no_status_change` only when the answer is required to
complete, verify, or decide the task. Do not manufacture a blocking question
from an unset optional due date, assignee, control, or other metadata field.
When the task requirements and transition policy are satisfied, choose the
ready outcome and leave unrelated optional metadata unchanged. Future
maintenance or a nice-to-have may be the next action without becoming
unfinished task scope.

## Submit and propose

On accepted task submit, Trelio creates a system comment from immutable handoff
and stores the semantic status recommendation without mutating the task.
Consecutive accepted Runs by the same user are grouped within the company
calendar day, while individual Run details remain available.

After acceptance, call `get_task_review_context` once for the exact task or Run,
selecting only needed `proposalKinds` (include `comment` for the required human
update). It returns fresh core/deadline, visible controls, complete checklist and
selected proposal contexts. Use shared top-level controls/checklists with their
proposal state; reuse these snapshots for the matching procedures instead of
repeating `get_task`, sections or singular context reads. A relevant intervening
change or conflict requires a fresh read. If the backend selects a local action,
follow that exact route; do not substitute the mirror or remote plaintext.

Follow `task-comment-proposals.md` for the human update.
Reassess the whole task from the final evidence even
when the recorded outcome is `no_status_change`; it is a recommendation.
Only a ready whole task gets the independent status proposal, before any
optional question. Partial work produces no status proposal.

Apply `task-checklist-proposals.md` to the fresh checklist. Partial work may propose exact satisfied items; unsupported transitions produce no card.
Before any proposal write inventory all cards. For two or more, follow
`task-proposal-bundles.md` and call `render_task_proposals` once, retaining
independent decisions. Missing proposal scope/permissions do not invalidate the
accepted Workspace result.

Report outcome, validation, saved materials, open questions and next action;
state the actual task status and any pending decision. Accepted Run does not
change status. Do not ask for separate Workspace acceptance after success.
