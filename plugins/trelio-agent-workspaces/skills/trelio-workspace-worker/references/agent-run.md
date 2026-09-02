# Agent Workspace Run

Read this file completely before starting, opening, continuing, checkpointing,
submitting, restoring, cancelling, or recovering an Agent Workspace Run. For a
task-scoped Run, also read `task-run.md`, `task-status-proposals.md`,
`task-comment-proposals.md`, and `task-checklist-proposals.md` before opening,
task communication, handoff, submit, or final reporting.

## Contents

- Prepare and open the Run
- Read and use materialized context
- Execute, checkpoint, and submit
- Blockers, restore, concurrency, and cleanup

## Prepare and open the Run

1. Complete `scope-and-context.md` first: resolve one exact task/dossier
   writable target and only materially relevant same-company task/dossier
   contexts. Do not guess IDs, repeat its discovery sequence, inherit
   company/project Workspace context, or use the external Agent Skill catalog
   for native Trelio control-plane work.
2. Call `prepare_agent_workspace_run` once with the exact writable scope and
   optional `relatedWorkspaceIds`. Task work uses task scope; a durable named
   cross-task subject uses dossier scope. The tool rejects company/project
   Workspace scope, ensures the exact task/dossier Workspace and rechecks write
   ACL. By default it returns the initiating user's latest portable draft on
   the current accepted head; otherwise it pins rules/profile/runtime policy,
   validates every related context and starts one fully prepared Run. Use
   `startNewRun=true` only for an intentional independent concurrent branch,
   because ordinary continuation must not discard earlier partial work. Do not separately call
   `get_agent_instructions`, `ensure_agent_workspace`,
   `start_agent_workspace_run` or `attach_agent_workspace_context` on this
   compact path. The legacy tools remain only for continuation/recovery with an
   already exact old Run. An exact company/project Run created before the
   dossier-only migration may still be claimed, checkpointed and finished by
   its existing Run ID; this compatibility never permits preparing or starting
   another legacy-scope Run.
3. Do not add runtime fields to prepare. The approved hook injects proof; the
   returned `open` command carries only server-authored runtime state. Execute
   the command through this loaded plugin's logical launcher. On any hook or
   version error, stop and read `setup-and-recovery.md` before recovery.
4. On `TRELIO_BRIDGE_PAIRING_REQUIRED`, immediately call
   `approve_agent_workspace_bridge_pairing` with exact `pairingId` and
   `deviceName`, then rerun the original bridge command. Do not show a code or
   request a separate chat confirmation. The MCP client's normal approval is
   the only possible user step. After exchange, briefly report that the device
   is connected and continue. Never pass the verifier through MCP/chat. The
   narrow device-session is stored only in private local `credentials.json`,
   not prompts, stdout, workspace, or macOS Keychain. Unsafe owner/ACL/mode/type
   or symlink state fails closed. Persistence failure triggers self-revoke; if
   cleanup fails, report it rather than silently retry. The session carries
   only workspace transport plus secret write/checkout capabilities already
   granted to the primary MCP connection; it never gains
   `mcp:agent-instructions:manage` or secret-metadata read. Do not start another
   OAuth flow or use `--legacy-oauth` during normal setup.
5. Immediately after the exact bridge `open` succeeds for a task-scoped Run,
   perform the one-shot work-start procedure in `task-status-proposals.md`
   before the first substantive work action. It is non-blocking: render only
   when the server returns an eligible `workStartProposal`, then continue the
   Run without waiting for the user's decision. Never repeat this start check
   after a tool action, checkpoint, pause, resumed turn, or later progress
   update.
## Read and use materialized context

1. Work in the path printed by `open`.
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
6. Read `../context/index.json` and selected snapshots under
   `../context/related/<workspace-uuid>` as read-only pinned context. A legacy
   Run may also contain immutable `../context/company` or
   `../context/project`; preserve and read those only for that already-existing
   Run, but never expect or create them for new work. For context selected after
   `open`, use `trelio-workspace context attach --workspace <uuid>`; for an
   MCP-attached workspace use `context sync`.
7. Related and legacy context is pointer-first. Inspect an exact file before use.
   If it is the five-line `https://trelio.ru/spec/workspace-object/v1` pointer,
   run `trelio-workspace context fetch --path <exact-path>` before reading it.
   Fetch only needed files; never bulk hydrate. Backend reauthorizes Run,
   dependency workspace, pinned head, and path for every fetch.

## Execute, checkpoint, and submit

1. Work only inside the writable workspace. Keep sources in `sources/`,
   intermediates in `work/`, final materials in `artifacts/`, and extracted
   representations in `derived/`. Large/binary writable files remain locally
   materialized; submit streams them to private object storage and stages exact
   Git pointers.
2. Run relevant validation. After every coherent material file change, run
   `trelio-workspace checkpoint --type draft --summary "<durable state and next
   step>"`. The bridge validates and uploads the complete delta; this is what
   lets `prepare_agent_workspace_run` in a later agent continue the same work.
   Checkpoint before waiting, a turn/session boundary, context compaction or a
   handoff to another agent. Do not checkpoint a half-written file or create an
   empty checkpoint without a meaningful delta. A clean working tree after a
   successful draft checkpoint is normal: `finish` uses the saved candidate
   delta and must not manufacture another file edit solely to finalize the Run.
3. Before a blocking question with meaningful local changes, run
   `trelio-workspace pause --summary "<durable state>" --question "<exact user
   decision>" --next-action "<after the answer>"`. It validates the delta,
   uploads the draft including external objects and records the blocker. Ask
   only after success. If the Run is still clean and the question is merely
   preparatory, ask directly without creating an empty Git draft.
4. Long-running local work may use heartbeat, but never send a separate
   heartbeat immediately before finalization: `finish` owns it.
5. Finalize once with `trelio-workspace finish --summary ... --evidence ...
   --file ... --next-action ...`. The command computes and prints the complete
   candidate changed-path manifest relative to the pinned base, including an
   already saved draft checkpoint, creates the handoff checkpoint, heartbeats,
   prepares the candidate and submits it. A truly empty Run still fails. For
   task scope pass one `--task-outcome` from the options returned by
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

## Blockers, restore, concurrency, and cleanup

- Cancel only when the user explicitly abandons/withdraws an open Run; call
  `cancel_agent_workspace_run` with a concrete audit reason. If it returns
  `providerSelection.tool=continue_trelio_local_workspace`, continue that exact
  `cancel_run` route instead; the host protects the reason locally. A temporary
  blocker or failed command is not cancellation.
- A later `trelio-workspace open --workspace <uuid> --run <uuid>` can claim the
  same waiting Run on another computer, materialize the server draft, and expose
  `run-checkpoint.json`. Chat history is not copied. A dirty/diverged older
  local tree is never overwritten; use a fresh directory or merge deliberately.
- Normal `prepare_agent_workspace_run` also selects the latest own non-empty
  server draft whose base is still current. Opening its returned command claims
  that Run and fences the older lease. Use `startNewRun=true` only when an
  independent concurrent branch is genuinely intended.
- On `LEASE_EXPIRED` or stale fencing, never mutate with old identifiers. Claim
  your intentional existing Run again, or start a new Run from current accepted
  head and reapply only inspected changes.
- On `WORKSPACE_OUTDATED`, preserve the rejected candidate, start a new Run from
  current accepted head, compare concurrent changes, and merge/reapply without
  force-updating canonical history.
- To undo accepted changes, list revisions, select an exact head, then restore
  with current `expectedHead` and a meaningful reason. If either native call
  selects `continue_trelio_local_workspace`, use its matching list/restore
  operation. Restore adds a descendant and rejects concurrency; never improvise
  encrypted Git/HTTP history access.
- Never delete Workspace roots manually. `trelio-workspace clean --dry-run`
  lists only roots unused for 30 days, backend-terminal, locally clean and not
  opening, plus cache bytes. `clean` deletes that exact local plan, never the
  server revision. Backend outage is a no-op; active, unknown or dirty roots remain.
