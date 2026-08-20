# Task proposal bundles

Read this file completely before one assistant response prepares two or more
interactive task proposal cards. It governs comment, whole-task status, and
control-clear proposals, whether the cards belong to different tasks, use
different kinds, or repeat one kind.

## Return one host result

Inventory the complete response before the first proposal write. When it needs
more than one interactive card, read every matching proposal-kind reference
and call `render_task_proposals` exactly once. Do not call
`propose_task_comment`, `render_task_comment_proposal`,
`render_task_comment_proposals`, `render_task_status_proposal`, or
`render_task_control_clear_proposal` in that response. Several standalone MCP
App results are not a bundle: a host may persist every server draft while only
one result remains visible to the user.

Read the matching fresh context separately for every exact target:

- `get_task_comment_proposal_context` for each `commentProposal` block;
- `get_task_status_proposal_context` for each `statusProposal` block;
- `get_task_control_clear_proposal_context` for each
  `controlClearProposal` block.

Carry each target's exact optimistic revision, snapshot/hash, current status,
control ids, and other fields only into its own block. A Run target uses its
exact `runId`; a direct target uses exact `companySlug`, `projectSlug`, and
`taskNumber`. Never reuse one task's context for a sibling card or create two
cards of the same kind for the same target.

## Preserve card independence

Pass blocks in the intended display order. Optional `text` blocks may explain
groups or transitions; keep the whole result within 64 blocks and 20 proposal
cards. Combine adjacent prose instead of spending blocks on fragments.

A domain, ACL, conflict, or stale-state error may fail one prepared block while
sibling cards remain usable. Do not hide successful cards because one block
failed, and do not replace a failed card with an immediate mutation. A missing
OAuth scope is a whole-call blocker and follows the standard consent/recovery
flow.

Every card keeps its own publish/apply/dismiss action and optimistic state. An
action on one card never authorizes or decides a sibling card. In a text-only
client, refer to the exact proposal id/revision and wait for an explicit
decision on that card. Never interpret approval of the bundle as approval of
all contained mutations.

After an ambiguous transport failure, first read fresh proposal contexts to
establish which drafts were saved before retrying any mutating bundle call.
