# Task comment proposals

Read this file completely whenever the user explicitly asks to propose, draft,
or prepare a Trelio task comment or reply, or whenever a substantive accepted
task Run requires its ordinary human-facing update.

## Route the request independently

Treat an explicit proposal request as its own native Trelio operation with or
without an Agent Workspace Run. This remains true when the request arrives as a
follow-up during maintainer work, after context compaction, or while another
operation is already in progress. Preserve it as a pending deliverable and
complete it before the final response; the current route never turns it into a
copywriting-only aside.

Resolve the exact task through the scope procedure when needed. Do not start an
Agent Workspace Run solely to prepare a proposal. A direct exact-task proposal
uses `companySlug`, `projectSlug`, and `taskNumber`; an accepted task Run uses
its exact `runId`.

## Inventory the response before writing

Determine how many interactive task-proposal cards the current assistant
response must show before calling a proposal write tool. Include comment,
whole-task status, control-clear, and checklist proposals for every exact task. If the
total is two or more, read `task-proposal-bundles.md` and use its single bundle
route. Do not call a comment tool first and discover afterward that another
card is needed.

## Prepare one editable draft

When this comment is the sole interactive proposal card and no earlier private
proposal for the same task is known in the current conversation, call
`propose_task_comment` once on the create-only normal path. Its `proposalText`
must already be one standalone publication-ready cumulative update. Never
write it as an addition, correction, strengthening, or update of an earlier
unpublished proposal or the automatic system handoff:

- For a direct exact task, pass its locator and a concise first-person
  `proposalText`; direct proposals do not accept workspace `filePaths`.
- After every substantive accepted task Run, pass the accepted `runId`, one
  concise first-person result, and only useful final/intermediate `filePaths`.
  The system handoff is technical audit and agent-readable context; the
  proposal is the ordinary comment for people.
  Do not attach all workspace files.

The server fences authoring basis and state, so do not make separate context/hash
calls on this sole-card normal path. Skip the compact tool and use
`get_task_comment_proposal_context` followed by
`render_task_comment_proposal` when the current conversation already contains
an earlier proposal for the exact task, or for a sole-card nuanced correction,
comparison with earlier public discussion, or an intentional member mention
whose exact `@username` is not already known. Use only a returned exact
username; never guess one or replace it with a plain display name.

If `propose_task_comment` returns `UNPUBLISHED_DRAFT_REQUIRES_CONTEXT`, do not
retry it. Read context once and use schema v4 `authoringBasis` exclusively:
`publicCommentsSnapshot.comments` contains only actual published human comments;
`pendingHumanUpdateBasis.acceptedRuns` contains uncommunicated Run evidence in
oldest-to-newest order; and `currentDraft.bodyText` is intentionally absent.
Ignore every draft still visible in the conversation. Synthesize one standalone
replacement, letting a later Run supersede conflicting earlier work. Never
concatenate, correct, retract, or narrate private text. If the net result adds
nothing public, dismiss the draft. Otherwise render with the exact revision and
`authoringBasis.snapshotSha256`.

For a multi-card response, always read
`get_task_comment_proposal_context` for this exact target and pass its exact
authoring-basis hash/revision fields plus the proposed text into this card's
`commentProposal` block in the one `render_task_proposals` call. This applies
even to the otherwise-normal accepted-Run comment route. The older
`render_task_comment_proposals` tool remains compatibility for comment-only
clients and is not the default bundle route.

## Keep publication separate

Do not publish automatically. A request to “only propose” reinforces the draft
route; it never means to substitute prose in the assistant response.
Never use `create_comment` as a workaround. In a text-only client, still call
the proposal tool and use its fallback; call `publish_task_comment_proposal`
only after explicit approval of the exact visible text and selected files.
After an explicit decision not to publish, call
`dismiss_task_comment_proposal`.

Missing scope or permissions block only the human proposal, not acceptance
of the durable workspace result. Ordinary task attachments
are created only when the operator publishes.

## Complete before reporting

Before the final response, account for every explicit proposal request. It is
complete only after the proposal tool returns the editable/rendered draft, or
after an exact tool, OAuth, ACL, or target-resolution blocker has been reported.
A quotation, prose block, or promise to suggest text in the final response does
not satisfy the request. Do not silently substitute plain text when the tool
path is blocked.
