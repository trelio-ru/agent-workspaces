# Agent Run recovery and history

Read this file completely on a Run/storage/lease/base-head failure, cross-device claim,
explicit cancellation, restore/history or local cleanup request. The ordinary
open/checkpoint/finish procedure remains in `agent-run.md`.

## Blockers, restore, concurrency, and cleanup

- On `COMPANY_STORAGE_BALANCE_REQUIRED`, stop the mutation and do not retry,
  cancel, or create another Run. Tell the user that company balance blocks new
  storage, local files remain intact, and the current Run is preserved. After
  an authorized person replenishes the balance, repeat the exact same
  `checkpoint`, `pause`, `finish`, or `submit` action. Do not convert this
  transport blocker into `waiting_for_human`: a human checkpoint is valid only
  after its draft was durably saved.
- Cancel only when the user explicitly abandons/withdraws an open Run; call
  `cancel_agent_workspace_run` with a concrete audit reason. If it returns
  `providerSelection.tool=continue_trelio_local_workspace`, continue that exact
  `cancel_run` route instead; the host protects the reason locally. A temporary
  blocker or failed command is not cancellation.
- A later exact `open` action for the same workspace and Run can
  claim the waiting Run on another computer, materialize the server draft, and expose
  `run-checkpoint.json`. Chat history is not copied. A dirty/diverged older
  local tree is never overwritten; use a fresh directory or merge deliberately.
- Normal `prepare_agent_workspace_run` also selects the latest own non-empty
  server draft whose base is still current. Opening its returned action claims
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
  operation. Accepted-Run diff/file reads use its matching history operations.
  Restore adds a descendant and rejects concurrency; never improvise encrypted
  Git/HTTP access.
- Never delete Workspace roots manually. Execute `clean` first with explicit
  `dryRun=true`; it lists only roots unused for 30 days,
  backend-terminal, locally clean and not opening, plus cache bytes. A later
  explicit `dryRun=false` deletes that exact local plan, never the
  server revision. Backend outage is a no-op; active, unknown or dirty roots remain.
