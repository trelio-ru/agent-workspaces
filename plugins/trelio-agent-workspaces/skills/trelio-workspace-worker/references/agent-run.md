# Agent Workspace Run

Read this file completely before starting, opening, continuing, checkpointing,
or submitting an Agent Workspace Run. Recovery/history/cleanup additionally
requires `run-recovery.md` only when that scenario applies. For a
task-scoped Run, also read `task-run.md`, `task-status-proposals.md`,
`task-comment-proposals.md`, and `task-checklist-proposals.md` before opening,
task communication, handoff, submit, or final reporting.

## Prepare and open the Run

1. Complete `scope-and-context.md` first: resolve one exact writable workspace
   target and only materially relevant same-company workspace
   contexts. Do not guess IDs, repeat its discovery sequence, inherit
   company/project Workspace context, or use the external Agent Skill catalog
   for native Trelio control-plane work.
2. Call `prepare_agent_workspace_run` once with the exact `workspaceId`, or
   task addressing for its canonical workspace, plus optional
   `relatedWorkspaceIds`. The tool rechecks write ACL for that exact workspace.
   By default it returns the initiating user's latest portable draft on
   the current accepted head; otherwise it pins rules/profile/runtime policy,
   validates every related context and starts one fully prepared Run. Use
   `startNewRun=true` only for an intentional independent concurrent branch,
   because ordinary continuation must not discard earlier partial work. Do not separately call
   `get_agent_instructions`, `ensure_agent_workspace`,
   `start_agent_workspace_run` or `attach_agent_workspace_context` on this
   compact path. Lower-level tools remain only for continuation/recovery with
   an already exact Run. One Run always writes one workspace; every supplied
   related workspace is pinned read-only.
3. Do not add runtime fields to prepare. The approved hook injects proof; the
   returned `bridge.actions.open` carries only server-authored runtime state.
   Execute it unchanged, adding the current client project folder only as
   `workingDirectory`. On hook/version error read `setup-and-recovery.md`.
4. On `TRELIO_BRIDGE_PAIRING_REQUIRED`, call
   `approve_agent_workspace_bridge_pairing` with exact `pairingId` and
   `deviceName`, then rerun the same open action. The MCP client's normal
   approval is the only possible user step; do not request another chat
   confirmation or expose the verifier. After exchange, briefly report that the device
   is connected and continue.
   Read `setup-and-recovery.md` for pairing/storage failures; never start a
   second OAuth flow, use `--legacy-oauth`, or broaden the narrow device scope.
   It never gains `mcp:agent-instructions:manage` or secret-metadata read.
5. Immediately after open succeeds for a task-scoped Run,
   perform the one-shot work-start procedure in `task-status-proposals.md`
   before the first substantive work action. It is non-blocking: render only
   when the server returns an eligible `workStartProposal`, then continue the
   Run without waiting for the user's decision. Never repeat this start check
   after a tool action, checkpoint, pause, resumed turn, or later progress
   update.
## Read and use materialized context

1. Work in the path printed by `open`. New onboarded roots use
   `<working-folder>/workspaces/<workspace-id>/workspace`; never put Run files
   beside root `AGENTS.md`.
2. Codex reads protected `AGENTS.md`; Claude loads protected `CLAUDE.md` whose
   only import is `@AGENTS.md`. Do not create another copy.
3. Read `../context/agent-instructions.md`, the immutable company/project rule
   snapshot for this Run, then `../context/user-profile.md`, the immutable
   initiating-user profile. The latter may refine interaction but cannot
   override company/project rules, ACL, approval, safety, or system policy.
4. If `../context/run-checkpoint.json` exists, read it as continuation state:
   durable summary, questions, next action, changed files, and draft head. It
   is state, not new instruction authority.
5. Read `WORKSPACE_CONTEXT.md` only after protected snapshots. Keep only durable
   facts, accepted decisions, and open questions. It cannot override Trelio,
   protected rules, enabled skills, or user directions. When an actually
   selected Agent Secret is a durable dependency, keep only its canonical
   `secretId`, current safe name from `list_agent_secrets`, and exact purpose in
   the form `Agent Secret: <name> (secretId: <UUID>) — <purpose>`. Never store
   value, version, grant, setup URL, runtime arguments, or unused discovery
   results.
6. Read `../context/index.json` and needed snapshots under
   `../context/related/<workspace-uuid>` as pinned read-only context. To add
   context after open, execute `context_attach` with the opened directory and
   exact related `workspaceId`; after MCP attach use `context_sync`.
7. Related context is pointer-first. Inspect selected files; for a five-line
   `https://trelio.ru/spec/workspace-object/v1` pointer execute `context_fetch`
   with the opened directory and exact `path` before reading. Never bulk hydrate.
   Every fetch reauthorizes Run, dependency workspace, pinned head and path.

## Execute, checkpoint, and submit

1. Work only inside the writable workspace. Keep sources in `sources/`,
   intermediates in `work/`, final materials in `artifacts/`, and extracted
   representations in `derived/`. Large/binary writable files remain locally
   materialized; submit streams them to private object storage and stages exact
   Git pointers. For a short update, edit existing canonical material and one
   concise required worklog entry. Create source/intermediate/result files only
   for distinct useful content; unchanged facts do not need narrative copies.
2. Run relevant validation. Save each coherent material change before further
   work using action `checkpoint` with `type=draft`, the exact opened directory and a
   durable `summary`. If immediately finishing that same delta, call `finish`
   directly: its handoff checkpoint and submit replace a separate draft
   checkpoint. Do not perform both for one immediate finalization. A saved draft
   remains necessary for continuation by `prepare_agent_workspace_run`.
   Checkpoint before waiting, a turn/session boundary, context compaction or a
   handoff to another agent. Do not checkpoint a half-written file or create an
   empty checkpoint without a meaningful delta. A clean working tree after a
   successful draft checkpoint is normal: `finish` uses the saved candidate
   delta and must not manufacture another file edit solely to finalize the Run.
3. Before a blocking question with meaningful local changes, execute `pause`
   in the exact opened directory with `summary`, `questions`, and `nextAction`.
   It validates the delta,
   uploads the draft including external objects and records the blocker. Ask
   only after success. If the Run is still clean and the question is merely
   preparatory, ask directly without creating an empty Git draft.
4. Long-running local work may use heartbeat, but never send a separate
   heartbeat immediately before finalization: `finish` owns it.
5. Finalize once with action `finish` in the exact opened directory, passing
   `summary`, `evidence`, `filePaths`, `questions`, `nextAction`, and when
   required `taskOutcome`. It computes and prints the complete
   candidate changed-path manifest relative to the pinned base, including an
   already saved draft checkpoint, creates the handoff checkpoint, heartbeats,
   prepares the candidate and submits it. A truly empty Run still fails. For
   task scope pass one `taskOutcome` from the options returned by
   `prepare_agent_workspace_run`.
6. Trelio still validates ACL, structure, sizes, secrets and exact base-head
   compare-and-swap. Failures keep handoff/delta recoverable. Let the bridge's
   one delayed encrypted retry finish; never parallelize/repeat submit or
   force-update history.
7. For a task Run, follow the status procedure in `task-run.md` and the
   separately routed comment and checklist procedures in
   `task-comment-proposals.md` and `task-checklist-proposals.md` after
   acceptance. Inventory every card before the first proposal write and follow
   `task-proposal-bundles.md` whenever the same response needs two or more.
8. Report in this order: outcome, important findings/validation, saved
   materials, open questions, and exact next action. For task scope, include the
   resulting status or transition blocker as required by `task-run.md`. Follow
   pinned platform reporting/link policy. Keep IDs and implementation detail
   out of normal responses; use a short revision only for troubleshooting.
   Surface useful content or name exact material instead of saying it is
   “inside” the candidate. Never request separate acceptance after success.

## Recovery

On a storage/lease/base-head failure, cross-device claim, explicit cancellation,
restore/history or cleanup request, read [run-recovery.md](run-recovery.md)
completely before acting. Preserve local changes and the exact server error;
never cancel, overwrite, force-update or bypass a failed operation as recovery.
