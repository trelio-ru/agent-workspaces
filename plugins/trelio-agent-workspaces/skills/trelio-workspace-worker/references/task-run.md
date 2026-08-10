# Task-scoped Run

Read this file completely whenever the writable Agent Workspace Run is scoped
to a task. It supplements `agent-run.md` and governs proposals, handoff,
status outcome, task attachments, submit behavior, and reporting.

## Prepare the human update

The accepted system handoff is technical audit and agent-readable context.
After every substantive accepted task Run, prepare the ordinary comment for
people:

1. Call `propose_task_comment` once with the accepted `runId`, one concise
   first-person result and only useful final/intermediate `filePaths`. The
   server reads the fresh public-comment snapshot and optimistic proposal state
   internally, so do not make separate context/hash calls on the normal path.
   Do not attach all workspace files.
2. Do not publish automatically. In a text-only client call
   `publish_task_comment_proposal` only after explicit approval of that exact
   text and selected files. After an explicit decision not to publish, call
   `dismiss_task_comment_proposal`.
3. Use the legacy two-step `get_task_comment_proposal_context` →
   `render_task_comment_proposal` only for a nuanced correction, comparison
   with earlier public discussion, or a new member mention whose exact
   `@username` is not already known. `currentDraft` is private/unpublished and
   must never be described as a prior public statement.
4. Missing `mcp:comments:create` blocks only the human proposal, not acceptance
   of the durable workspace result. Never use `create_comment` as a workaround.

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

After acceptance, follow `Prepare the human update` above. Let the MCP App show
exact removable file cards; ordinary task attachments are created only when
the operator publishes. In a text-only client, show proposed files and publish
only after explicit approval of the exact text and file selection.

Report outcome first, then resulting task status or exact transition blocker,
important validation, saved materials, open questions, and next action. Do not
ask for a separate acceptance step after successful submit.
