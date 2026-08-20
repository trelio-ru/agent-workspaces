# Task-scoped Run

Read this file completely whenever the writable Agent Workspace Run is scoped
to a task. It supplements `agent-run.md` and governs handoff, status outcome,
submit behavior, and reporting. The main skill separately requires
`task-comment-proposals.md` for the human update and conditionally routes
`task-status-proposals.md` for a separate whole-task status decision.

## Choose the handoff outcome

Every task-scoped handoff must pass exactly one `--task-outcome` based on
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
- `no_status_change`: partial/informational work, failed review, or any handoff
  with unresolved questions. This is the safe default whenever the direct
  request may be narrower than the full task.

For example:

```text
trelio-workspace finish \
  --summary "Подготовлен план монтажа с ответственными и контрольными точками." \
  --evidence "Исходные требования сопоставлены с планом; критических технических препятствий не обнаружено." \
  --file artifacts/montage-plan.md \
  --next-action "Проверьте подготовленный план монтажа." \
  --task-outcome work_completed
```

When a question remains, include `--question` and use `no_status_change`.

## Submit and propose

On accepted task submit, Trelio creates a system comment from immutable handoff
and stores the semantic status recommendation without mutating the task.
Consecutive accepted Runs by the same user are grouped within the company
calendar day, while individual Run details remain available.

After acceptance, follow the separately routed task-comment proposal procedure
before final reporting. If and only if the whole task was assessed ready, also
follow `task-status-proposals.md` and prepare an independent status proposal.
Before either proposal write, inventory all interactive cards required in the
same response, including any inferred control-clear proposal. When two or more
cards are needed, read `task-proposal-bundles.md` and return all of them through
one `render_task_proposals` call; never issue the singular comment/status/control
App calls sequentially. Partial work produces no status proposal. The accepted
workspace result remains valid even when any proposal is blocked by missing
scope or permissions.

Report outcome first, then say that accepted Run left task status unchanged and
whether a separate status proposal is awaiting a decision or was applied.
Include important validation, saved materials, open questions, and next action.
Do not ask for a separate workspace acceptance step after successful submit.
