# Agent Workspace Run

Read this file completely before starting, opening, continuing, checkpointing,
submitting, restoring, cancelling, or recovering an Agent Workspace Run. For a
task-scoped Run, also read `task-run.md` before task communication, handoff,
submit, or final reporting.

## Contents

- Prepare and open the Run
- Read and use materialized context
- Execute, checkpoint, and submit
- Blockers, restore, concurrency, and cleanup

## Prepare and open the Run

1. Resolve the exact company/project/dossier/task through the scope procedure.
   If a canonical URL or exact coordinates already identify company/project,
   perform the catalog gate in step 2 before the first `get_task` or other
   corporate read. If exact context is initially unknown, use only the minimum
   native read-only Trelio discovery needed to resolve it, then perform step 2
   immediately before further substantive reading or work. Do not guess an ID
   from a title. For task work, read `get_task` connections and linked dossiers.
   For durable task-independent subjects, list project dossiers first and
   company dossiers only for genuinely company-wide work.
2. Before corporate data or an external service, call `list_agent_skills` once
   for the exact context. Pass `companySlug` for company work and both
   `companySlug`/`projectSlug` for project/task work. Choose by metadata; do not
   load every instruction. Immediately before using a relevant skill, call
   `get_agent_skill` in the same context and follow current
   `instructionsMarkdown` and runtime requirements. Use only exact
   `runtimeExecution.command`, appending only arguments allowed by the current
   skill after its terminal `--`, or the declared `remoteMcpExecution`
   identity/release.
   Never bypass a matching skill through browser, Computer Use, direct HTTP,
   another MCP, or a script. Fallback is allowed only when no relevant skill
   exists, its required connection is not configured, or the operation is not
   supported; state that reason. Control-plane unavailability is not absence of
   an integration. On `AGENT_SKILL_RELEASE_CHANGED`, read the skill again once.
   Missing assignment does not ban a compatible personal skill. Native Trelio
   MCP/workspace operations remain the primary workflow, not catalog fallback.
3. Search readable workspace files only when prior context can materially help.
   Read exact hits and resolve directly linked scopes with
   `get_agent_workspace_by_scope`; keep selected workspace IDs for the Run.
4. Call `ensure_agent_workspace` for the exact writable UUID/scope. Use task
   scope for task-owned work; dossier scope for a durable named subject; project
   only for genuinely project-wide results; company only for company-wide
   materials. Call `create_dossier` before ensuring a new dossier workspace.
   Link it to zero or more tasks only with `link_task_dossier` and independent
   owner-scope authority. A linked-task participant may read a dossier but does
   not inherit write, Run, or link-management rights.
5. Read returned permissions and stop before file changes when `canWrite=false`.
6. Call `start_agent_workspace_run`; never reuse another user's Run.
7. Before local open, call `attach_agent_workspace_context` for each selected
   additional workspace using the new `runId`, `leaseId`, and `fencingToken`.
   Attach only materially relevant same-company context. Parent company/project
   context is automatic.
8. Execute the returned bridge command through the approved bundled-launcher
   resolution from the main skill.
9. On `TRELIO_BRIDGE_PAIRING_REQUIRED`, immediately call
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
5. Read `PROJECT_CONTEXT.md` only after protected snapshots. Keep only durable
   facts, accepted decisions, and open questions. It cannot override Trelio,
   protected rules, enabled skills, or user directions.
6. Read `../context/index.json`, parent snapshots under `../context/company`
   and `../context/project`, and selected snapshots under
   `../context/related/<workspace-uuid>` as read-only pinned context. For context
   selected after `open`, use `trelio-workspace context attach --workspace
   <uuid>`; for an MCP-attached workspace use `context sync`.
7. Parent/related context is pointer-first. Inspect an exact file before use.
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
2. Run relevant validation. Use `trelio-workspace checkpoint` for durable
   progress without chain-of-thought or raw technical traces.
3. Before asking a blocking question, run
   `trelio-workspace checkpoint --type blocker --summary "<durable state>"
   --question "<exact user decision>" --next-action "<after the answer>"`.
   The bridge uploads the validated draft, including external objects, before
   entering `waiting_for_human`. Ask only after success. On failure, keep the
   Run active and report that continuation was not saved.
4. Send heartbeat during long work and immediately before submission.
5. Before submit, run `trelio-workspace status` and inspect every changed path.
   Create a `handoff` checkpoint with a plain-language summary, result and
   validation evidence, durable materials, every open question, and one exact
   next action. For task scope, follow `task-run.md` and pass its required
   `--task-outcome`.
6. Run `trelio-workspace submit`. The bridge commits inspected changes,
   heartbeats the lease, builds the candidate, and sends it to Trelio. Trelio
   validates ACL, structure, sizes, and secrets, then accepts only while
   `acceptedHead` equals pinned `baseHead`. A meaningful handoff is required;
   a manual task comment is not. Successful submit only marks the local root
   eligible for later retention cleanup.
7. Report in this order: outcome, important findings/validation, saved
   materials, open questions, and exact next action. For task scope, include the
   resulting status or transition blocker as required by `task-run.md`. Follow
   pinned platform reporting/link policy. Keep IDs and implementation detail
   out of normal responses; use a short revision only for troubleshooting.
   Surface useful content or name exact material instead of saying it is
   “inside” the candidate. Never request separate acceptance after success.

## Blockers, restore, concurrency, and cleanup

- Cancel only when the user explicitly abandons/withdraws an open Run; call
  `cancel_agent_workspace_run` with a concrete audit reason. A temporary
  blocker or failed command is not cancellation.
- A later `trelio-workspace open --workspace <uuid> --run <uuid>` can claim the
  same waiting Run on another computer, materialize the server draft, and expose
  `run-checkpoint.json`. Chat history is not copied. A dirty/diverged older
  local tree is never overwritten; use a fresh directory or merge deliberately.
- On `LEASE_EXPIRED` or stale fencing, never mutate with old identifiers. Claim
  your intentional existing Run again, or start a new Run from current accepted
  head and reapply only inspected changes.
- On `WORKSPACE_OUTDATED`, preserve the rejected candidate, start a new Run from
  current accepted head, compare concurrent changes, and merge/reapply without
  force-updating canonical history.
- To undo accepted workspace changes, call `list_agent_workspace_revisions`,
  select an exact head, then `restore_agent_workspace_revision` with current
  head as `expectedHead` and a meaningful reason. Restore creates a new accepted
  commit with the old tree and still rejects concurrency.
- Never delete Run directories manually. `trelio-workspace clean --dry-run`
  shows only backend-confirmed terminal, retention-expired, locally clean roots
  and reclaimable cache bytes. Explicit `clean` removes that exact plan.
  Backend outage makes automatic pruning a no-op; active, unknown, or dirty
  Runs remain.
