# Task-scoped Run

Read this file completely whenever the writable Agent Workspace Run is scoped
to a task. It supplements `agent-run.md` and governs proposals, handoff,
status outcome, task attachments, submit behavior, and reporting.

## Propose semantic task updates

When a new result, decision, durable material, open question, or participant
action meaningfully changes the task:

1. Call `get_task_comment_proposal_context` for the active Run.
2. Treat `publicCommentsSnapshot` as the factual public baseline reread from
   Trelio immediately before the proposal. Compare the net current result only
   with those published comments after `reviewBaseline`. `currentDraft` has
   `visibility=unpublished`: never retract, correct, negate, or refer to it as a
   previous public statement. Correction wording is allowed only when an exact
   public comment id and body in the snapshot contains the statement being
   corrected. If `hasMoreBefore=true` and older text matters, read the exact
   task activity before continuing.
3. If the operator explicitly says that the current proposal is unnecessary,
   call `dismiss_task_comment_proposal` with its exact id/revision. Dismissal
   creates no task comment or attachment and advances a separate reviewed
   boundary. If undoing unpublished work leaves no public semantic delta, do
   not render a corrective replacement.
4. Otherwise generate one fresh concise net synthesis and call
   `render_task_comment_proposal` with exact `stateRevision`, exact
   `publicCommentsSnapshot.snapshotSha256`, and replacement text. Never
   concatenate old comment or draft wording. Omit `filePaths` until the Run is
   accepted.
5. Do not publish automatically or pause work because the proposal remains
   unpublished. Do not propose intermediate diagnostics, retries, or technical
   noise. A published operator edit covers the whole reviewed range, including
   deliberately removed items; the next synthesis begins later.
6. In clients without MCP Apps, show fallback text and call
   `publish_task_comment_proposal` only after explicit approval of that exact
   text. After an explicit decision not to publish, call
   `dismiss_task_comment_proposal`. Never use `create_comment` for this proposal.
   Missing
   `mcp:comments:create` blocks only proposal render/publication, not handoff or
   submit.

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
trelio-workspace checkpoint --type handoff \
  --summary "Подготовлен план монтажа с ответственными и контрольными точками." \
  --evidence "Исходные требования сопоставлены с планом; критических технических препятствий не обнаружено." \
  --file artifacts/montage-plan.md \
  --next-action "Проверьте подготовленный план монтажа." \
  --task-outcome work_completed
```

When a question remains, include `--question` and use `no_status_change`.

## Submit and refresh the proposal

On accepted task submit, Trelio creates a system comment from immutable handoff
and applies the outcome through the normal task-status service. Status choice
uses semantic kind, permissions, and transition requirements. If transition is
blocked, the accepted workspace result remains valid and the bridge reports
the exact blocker rather than forcing `done`. Consecutive accepted Runs by the
same user are grouped within the company calendar day, while individual Run
details remain available.

After acceptance:

1. Call `get_task_comment_proposal_context` again, reread its actual public
   comments snapshot and refresh with exact `stateRevision` and snapshot hash.
2. Include exact `filePaths` only for important final deliverables and genuinely
   useful intermediate files needed to understand or continue the work. Do not
   attach all workspace files, sources, technical files, or incidental output;
   omit `filePaths` when no file adds value.
3. Let the MCP App show exact removable file cards. Ordinary task attachments
   are created only when the operator publishes.
4. In a text-only client, show proposed files and publish only after explicit
   approval of the exact text and file selection.

Report outcome first, then resulting task status or exact transition blocker,
important validation, saved materials, open questions, and next action. Do not
ask for a separate acceptance step after successful submit.
