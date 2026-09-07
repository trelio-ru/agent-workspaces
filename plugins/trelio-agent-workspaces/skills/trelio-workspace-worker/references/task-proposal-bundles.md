# Task proposal bundles

Read this file completely before returning 2+ task proposal cards.

## Return one host result

Inventory the complete response before the first proposal write. When it needs
more than one interactive card, read every matching proposal-kind reference
and call `render_task_proposals` exactly once. Do not call
`propose_task_comment`, `render_task_comment_proposal`,
`render_task_comment_proposals`, `render_task_status_proposal`, or
`render_task_control_clear_proposal`, or `render_task_checklist_proposal` in
that response: a host may display only the last standalone App result.

With local `proposalProvider` or server-selected `providerSelection`, follow
`local-company-context.md`. Reuse an already successful combined review; send
all ordered blocks in one local render with `kind=bundle`, `operation=save`.
Otherwise obtain the needed headless contexts. Each card retains its own later
human decision; never split a bundle into singular render calls.

For a post-result review, prefer one `get_task_review_context` per exact target
with only the needed `proposalKinds`. Its `proposalContexts` and shared top-level
controls/checklists satisfy the matching fresh-context reads below. Preserve the
returned per-kind revision/snapshot fields and do not reread each singular tool.
For a standalone proposal or unsupported combined read, use:

- `get_task_comment_proposal_context` for each `commentProposal` block;
- `get_task_status_proposal_context` for each `statusProposal` block;
- `get_task_control_clear_proposal_context` for each
  `controlClearProposal` block.
- `get_task_checklist_proposal_context` for each `checklistProposal` block.

Carry each target's exact optimistic revision, snapshot/hash, current status,
control ids, checklist/item snapshots, and other fields only into its own block. A Run target uses its
exact `runId`; a direct target uses exact `companySlug`, `projectSlug`, and
`taskNumber`. Never reuse one task's context for a sibling card or create two
cards of the same kind for the same target.

## Preserve card independence

Keep display order, at most 64 blocks and 20 cards; combine adjacent prose in
optional `text` blocks.

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
