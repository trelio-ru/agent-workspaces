# Task-scoped Run

Read this file completely whenever the writable Agent Workspace Run is scoped
to a task. It supplements `agent-run.md` and governs handoff, status outcome,
submit behavior, and reporting. The main skill separately requires
`task-comment-proposals.md` for the human update.

## Choose the handoff outcome

Every task-scoped handoff must pass exactly one `--task-outcome` based on
semantic status kind, never localized name/code:

- `work_completed`: normal completed work. Trelio moves the task to the first
  transitionable `review` status, or to `done` if no review status exists.
- `review_passed`: only after this Run successfully reviews a task already in
  semantic `review`; Trelio moves it to `done`.
- `direct_completion`: only when the user explicitly says to skip review, a
  pinned rule permits it, or the same authenticated user created and assigned
  the task to themselves. Even then prefer `work_completed` unless there is a
  concrete reason to skip review.
- `no_status_change`: partial/informational work, failed review, or any handoff
  with unresolved questions.

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
and applies the outcome through the normal task-status service. Status choice
uses semantic kind, permissions, and transition requirements. If transition is
blocked, the accepted workspace result remains valid and the bridge reports
the exact blocker rather than forcing `done`. Consecutive accepted Runs by the
same user are grouped within the company calendar day, while individual Run
details remain available.

After acceptance, follow the separately routed task-comment proposal procedure
before final reporting. The accepted workspace result remains valid even when
the proposal is blocked by missing comment scope or permissions.

Report outcome first, then resulting task status or exact transition blocker,
important validation, saved materials, open questions, and next action. Do not
ask for a separate acceptance step after successful submit.
