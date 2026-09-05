# Local company context provider

Read only when native `providerSelection` or exact-task `proposalProvider`
selects `local_company_context`. Plain tasks omit it and need no extra read.
Never infer either authoritative route.
If the local tool returns `provider=native_trelio`, stop this route and continue
with the ordinary native tool named by the current operation.

## The first local read performs one bounded sync

Call `trelio-remote-skills.continue_trelio_local_context` with the exact returned
operation: `search`, `list`, `get_task`, `fetch`, `search_workspace_files`, or
`get_workspace_file`. The first mirror-backed call in each MCP host process
automatically syncs the company; there is no agent-facing manual sync.

The host downloads only ACL-filtered canonical projections, resolves E2EE
markers on-device, opens accepted Workspace bundles in private temporary
storage, and publishes one encrypted mirror generation. Decrypted content,
queries, snippets, paths, and keys never go to Trelio.

Sync reuses unchanged revisions/accepted heads and hydrates changed markers in
bounded mirror-wide batches. A short per-company writer lock protects atomic
publication while readers retain the prior immutable generation. Contenders may
wait; they never delete the mirror, widen scope, or create plaintext fallback.
Lock refresh and stale takeover are bounded and owner-checked.

After sync, mirror-backed reads stay local for that process; a later host process
syncs again. The host retries a generation change during build. Do not invent a
refresh before each query.

Every dispatched local write, proposal save/action, restore/cancel, and accepted
encrypted `finish` publishes an owner-private random marker with no content.
Each MCP host checks it before trusting RAM; a change makes the next read run
the normal bounded sync. No manual sync or polling is needed. The marker only
prevents stale reads; server idempotency, revisions, heads, leases and fencing
tokens still resolve simultaneous-chat conflicts.

Disk generations remain encrypted. At most one current generation per company
and its lazy lexical index are plaintext in process memory, with a hard
600-second TTL even while idle. Later access reopens the encrypted generation
without another network sync.

## Search locally and reveal only selected results

Use `search` with one to five faithful formulations and a bounded result count:

```json
{
  "operation":"search",
  "companySlug":"exact-company-slug",
  "queries":["first formulation","independent synonym"],
  "limit":20
}
```

Search covers projects; task number/title/description/checklists, visible active
control notes, custom fields/attachment names/manual comments; workspaces, pages,
contacts, registries, meetings and accepted text. Status/assignee/participants
are excluded. Archive results are marked/read-only; optional domains need scopes.
`context-search-v1`: exact refs > query coverage > field/lexical quality >
true-tie authority > stable key; entity type has no fixed priority. Ranking stays
local. Fetch only a relevant set.

Use `list` only for explicit inventory or a task known by project but not number;
it accepts the documented resource, optional project/offset, and `limit<=100`.
Use `get_task` with exact project slug and positive number. It returns effective
rules/profile and resolves an exact pre-encryption or renamed project slug while
returning only the current canonical slug.

An accepted Workspace search result includes the exact native
`prepare_agent_workspace_read` target. Reading it remains read-only. A writable
task or named workspace still uses the ordinary `prepare_agent_workspace_run` and
bridge commands, with the same per-Workspace leases, fencing tokens,
checkpoints, submit, acceptance, and optimistic head checks as every other
company. Never create a company-wide Run lock: neighboring tasks must remain
independent.

When native `search_agent_workspace_files` selects this provider, repeat its
queries through `operation=search_workspace_files`; the host filters to accepted
Workspace text before applying the bounded top-N, so ordinary task or workspace
matches cannot displace a relevant file. `operation=get_workspace_file` accepts
the exact `workspaceId`, `workspaceHead`, and `filePath` from that result and
preserves the native accepted-head fence. These routes do not start a Run or
expose historical Git bytes to the backend.

## Continue Workspace history locally

On returned `continue_trelio_local_workspace`, keep its exact company/operation:

- `list_revisions`: pass `workspaceId`; select only a head returned by this live
  result.
- `get_revision_diff`: pass the original native arguments under `arguments`.
  Omit `filePath` first; a later patch path must come from that manifest.
- `read_revision_file`: pass original native arguments, using a manifest path.
  Binary pointers return metadata; use accepted derived/OCR text instead.
- `restore_revision`: pass workspace, current/target heads, meaningful plaintext
  reason and returned runtime session. The host encrypts the reason, preserves
  current controls, normalizes legacy context and submits a new descendant.
  `filesChanged` comes from its actual delta; an ambiguous prepare gets one exact
  marker read-back, never a speculative second Run.
- `cancel_run`: pass `runId` and concrete reason. The host protects it; only
  transport/5xx or malformed success can retry, bounded and with the same marker.

History plaintext stays in a temporary Git root deleted before return; controls
stay hidden. Never reproduce bridge steps or repeat an unconfirmed restore.

## Use the same proposal lifecycle

Use the exact task `proposalProvider`, preserve its Run `runId`, and never
preflight a native proposal tool. Its routes are:

- `get_trelio_local_proposal_context`: headless `kind` and `payload.target` –
  either `runId` or `projectSlug` plus `taskNumber`.
- `render_trelio_local_proposal`, `operation=save`: the same target, plaintext
  draft/reasons, and exact revision/snapshot fields from that context response.
  The host uploads only locally encrypted, signed ciphertext.

App buttons use hidden tools. Text-only `operation=action` requires a decision
plus exact
`proposalId`, `expectedRevision`, `action`, `confirmed=true`, and open IDs.
Comment publish passes reviewed `bodyText` and verifies persisted hydrated text.
Run completion or rendering is never confirmation.

Kinds are `comment`, `status`, `control_clear`, and `checklist`. Preserve the
normal proposal references' semantic rules: unpublished drafts are not public
history, comment and whole-task status decisions are independent, and
checklist/control decisions remain item-specific. Context/save/action reuse the
same server-side ACL, advisory locks, optimistic state revisions, public-comment
snapshot hashes, and idempotent apply/dismiss/publication behavior as native
Trelio.

The v8 App puts a one-hour, revision-bound opaque capability in model-hidden
metadata. Saved v5 cards retain their old app tools.

When one response needs two or more cards and native
`render_task_proposals` or compatibility `render_task_comment_proposals`
selects this local route, make one `render_trelio_local_proposal` call with
`kind=bundle`, `operation=save`, and `payload.blocks` copied from the intended
native bundle. All direct task blocks must name this same exact company; Run
blocks are checked server-side against it. The host preserves text/card order,
canonicalizes historical project slugs, encrypts every card through its normal
kind-specific save path, and returns one bundle whose per-card conflicts remain
independent. Context reads and final publish/apply/dismiss actions stay separate
per card. After an ambiguous transport result, reread every affected context
before retrying; do not repeat the whole bundle blindly.

The returned `reviewUrl` opens the exact task. If the client cannot show an MCP
App, present the hydrated editable proposal and ask for the same explicit
publish/apply/dismiss decision; do not silently convert a proposal into a direct
mutation.

## Continue ordinary actions

Pass native arguments once. For `upload_attachment`, use absolute
`localFilePath` only for an exact user-selected or agent-created file; omit
base64/size/hash. The host privately streams it, encrypting if needed. On
ambiguity reread attachments before reusing the key. Archived rows require
exact include flags.

## Fail closed

Let the bridge own local unlock and materialization. Never request an encryption
key through chat, MCP arguments, shell input, environment, stdin, clipboard, or
workspace files. On `access_pending`, stop content work until the owner grants
the displayed device. Do not use server search, plaintext caches, browser
scraping, another connector, or improvised HTTP as fallback.

Local mirror generations are encrypted at rest with the company scope key.
Decrypted Workspace files exist only in owner-private temporary directories and
are deleted before a search document is returned in memory. Do not edit mirror
files or `.trelio/**`. The process-only decrypted generation/search index is
never persisted and expires after 600 seconds. A read-only snapshot is not a
Run and cannot be edited, checkpointed, or submitted.
