# Task controls

Read this file completely before creating, updating, changing visibility of,
or clearing a task control.

`get_task` returns all visible active shared controls and only the authenticated
user's personal controls. These date-only controls are repeatable check points,
not extra deadlines.

1. Use `create_task_control`, `update_task_control`, or `clear_task_control`
   only when the request, task, or pinned rule calls for a concrete future
   check. Do not manufacture one because an Agent Workspace Run exists.
2. Choose `personal` when only the authenticated user should see the check.
   Choose `shared` only when everyone with task access should see it. Never
   widen personal to shared from inference; obtain clear authority.
3. Put the exact verification action in `note`. If later communication is
   needed, record the check result in an ordinary task comment; controls have
   no result field.
4. Reaching `controlDate` never sends a notification. Dashboard filters show
   the nearest visible date across deadline and active controls.
5. Shared create/update/visibility/clear actions produce system comments.
   Clearing a shared control also notifies the task audience, including the
   creator when someone else clears it. Personal controls and changes never
   enter shared comments or notifications.
6. Do not clear a control because the Run completed or task status changed.
   Clear only the exact handled check or when the user explicitly asks.
