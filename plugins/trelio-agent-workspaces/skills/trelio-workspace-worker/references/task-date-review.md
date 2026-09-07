# Task deadline and control review

Read this file completely after substantive work on an exact task, including partial results,
accepted task Runs, sent replies and scheduled checks, before the first
proposal write, optional follow-up question or final response. A request only
to read, quote or discuss material does not itself require task maintenance.

## Read the current state

Read the exact task core for `dueAt`, status and permissions, and the controls
section through `get_task_sections`. Reuse a fresh post-result read; combine
controls with other needed sections. An unloaded or denied section is unknown,
not empty. Respect server-selected local provider routing and pinned Run rules.
Do not expand access to an unavailable owner task or mutate an archived task.

Compare the deadline and every visible active control with the actual result
and remaining whole-task work. Use the user's timezone for timestamp deadlines;
control dates are calendar dates, not UTC instants. Today or overdue means
assessment is needed, not that a check succeeded or a deadline must move.

## Decide separately

- **Controls:** evaluate each note's actual verification condition. A handled,
  superseded or irrelevant check needs an inferred clear proposal even when
  the task remains in progress. An unmet, still useful check stays active.
  Do not roll a performed check forward just to hide its old date. For a
  concrete remaining external wait, follow `task-controls.md` for an authorized
  create/update and its scheduler follow-up; keep existing visibility.
- **Deadline:** determine whether the remaining required work still fits the
  committed deadline. If today's or overdue, assess whether it still fits.
  If it no longer fits, explain
  the remaining work and recommend a justified exact replacement or ask for
  the missing scheduling decision. Deliberately retaining the date is valid
  when the work still fits or the deadline must remain fixed; explain only
  when relevant. Never move, clear or reset it merely to remove lateness or
  use the next check date as the completion deadline.

For inferred clearing, read `task-controls.md` and
`get_task_control_clear_proposal_context`, then prepare the exact live controls
with private reasons. With other cards, use one `render_task_proposals` bundle.
Reuse an already pending exact decision when its evidence and live snapshots
still match; do not replace it merely because another turn ended.
Acceptance, a comment, or status/checklist approval never applies this decision.
Only an exact user command or decision on the clear proposal authorizes removal.

Deadline changes use the ordinary task mutation only with an exact user decision
or an already applicable instruction authorizing that scheduling choice. A
general request to finish work is insufficient. There is no deadline proposal
card: state the recommendation in prose without inventing a tool or bundle kind.
Reread changed state before mutation and preserve ordinary ACL/conflict checks.

If the whole task is ready, prepare its status proposal independently; do not
invent a new deadline or withhold completion while date decisions are pending.
For a missing deadline, apply the effective `missingTaskDueDateMode`, including
its status/access exclusions. Optional metadata does not create unfinished work.

Report an actionable date risk, required decision or read blocker, but no
ritual “dates unchanged” report. A failed review read does not invalidate saved
work and must never be presented as a successful date check.
