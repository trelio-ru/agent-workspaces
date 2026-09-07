# Task controls

Read this file completely before creating, updating, changing visibility of,
or clearing a task control.
For the mandatory post-result assessment, first read `task-date-review.md`;
do not wait for an explicit request to inspect controls after substantive work.

Schema-v3 `get_task` keeps controls deferred. Read
`get_task_sections.sections.controls` for the exact task; it contains all
visible active shared controls and only the authenticated user's personal
controls. Do not look for a schema-v2 inline controls array: plugin `1.14.2`
requires the schema-v3 section contract.
These date-only controls are repeatable check points, not extra deadlines.

1. Use `create_task_control` or `update_task_control`
   only when the request, task, or pinned rule calls for a concrete future
   check. Do not manufacture one because an Agent Workspace Run exists.
2. For a new control, choose `shared` by default when the check records an
   objective task state, expected external response, date checkpoint, or next
   step useful to the task audience. Choose `personal` only for an explicitly
   private working check that should not become task-wide. Monitoring another
   person's action does not make the control personal when that action gates
   the next task step.
3. When updating an existing control, keep its current visibility unless the
   user explicitly asks to change it. The creation default never widens an
   existing personal control. If the task needs a shared control but current
   ACL does not permit one, do not silently create a personal substitute;
   report the mismatch or ask whether a private fallback is acceptable.
4. Put the exact verification action in `note`. If later communication is
   needed, record the check result in an ordinary task comment; controls have
   no result field.
5. Reaching `controlDate` never sends a notification. Dashboard filters show
   the nearest visible date across deadline and active controls.
6. Shared create/update/visibility/clear actions produce system comments.
   Clearing a shared control also notifies the task audience, including the
   creator when someone else clears it. Personal controls and changes never
   enter shared comments or notifications.
7. Do not clear a control because the Run completed or task status changed.
   Clear only the exact handled check or when the user explicitly asks.

Use `clear_task_control` only for an exact immediate user command, with
`userExplicitlyRequestedImmediateControlClear=true`.

When clearing one or more controls is an inferred recommendation rather than
an exact immediate command, first call
`get_task_control_clear_proposal_context` and preserve one concrete private
reason per proposed control. If this is the sole interactive proposal card in
the current response, use `render_task_control_clear_proposal`. If any comment,
status, checklist, or another task's control-clear card is also needed, read
`task-proposal-bundles.md` and put the exact context revision and control items
in one `controlClearProposal` block of the single `render_task_proposals` call.
Never emit several single-card App calls. Proposal reasons remain private and
must not enter task comments, shared-control audit events, or notifications.
Only the user's App action or explicit decision on the exact proposal may
apply or dismiss it.
