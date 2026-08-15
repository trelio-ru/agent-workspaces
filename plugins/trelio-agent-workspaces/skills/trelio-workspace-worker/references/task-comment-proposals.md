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

## Prepare the editable draft

Call `propose_task_comment` once on the normal path:

- For a direct exact task, pass its locator and a concise first-person
  `proposalText`; direct proposals do not accept workspace `filePaths`.
- After every substantive accepted task Run, pass the accepted `runId`, one
  concise first-person result, and only useful final/intermediate `filePaths`.
  The system handoff is technical audit and agent-readable context; the
  proposal is the ordinary comment for people.
  Do not attach all workspace files.

The server reads the fresh public-comment snapshot and optimistic proposal
state internally, so do not make separate context/hash calls on the normal path.
Use `get_task_comment_proposal_context` followed by
`render_task_comment_proposal` only for a nuanced correction, comparison with
earlier public discussion, or an intentional member mention whose exact
`@username` is not already known. Use only a returned exact username; never
guess one or replace it with a plain display name. Treat `currentDraft` as
private and unpublished, never as an earlier public statement.

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
