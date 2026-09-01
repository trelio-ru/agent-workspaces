# Local company context provider

Read this reference only after native Trelio returns the exact
`providerSelection.provider=local_company_context` route. That field is an
authoritative runtime decision made from live company state. Do not infer the
provider from task wording, an earlier session, a failed search, or convenience.
If the local tool returns `provider=native_trelio`, stop this route and continue
with the ordinary native tool named by the current operation.

## The first local read performs one bounded sync

Call `trelio-remote-skills.continue_trelio_local_context` for the requested
`search`, `list`, `get_task`, or `fetch` operation. On the first local content
call in a new MCP host process, the trusted host automatically performs the
fresh company sync before answering; this is not an agent choice and there is
no manual mirror-sync operation for the agent to remember.

The trusted host downloads only canonical projections that passed the current
user's ordinary company/project/task/dossier ACL, resolves their E2EE markers
on the device, opens accepted Workspace bundles in private temporary storage,
and publishes one encrypted local mirror generation. It never sends decrypted
content, search queries, snippets, paths, or private keys to Trelio.

Sync is incremental. Unchanged task revisions and accepted Workspace heads are
reused. The host resolves E2EE markers from all changed task/domain projections
in bounded mirror-wide batches; transport request count does not grow one-for-one
with the number of tasks. One short per-company writer lock protects publication,
while readers keep using an immutable prior generation. A second process may wait
for that writer; it must not delete the mirror, create a plaintext fallback, or
broaden the scope. A live writer refreshes its lock. Stale-lock takeover is bounded
and owner-checked.

After the automatic sync, `search`, `list`, `get_task`, and `fetch` read the
encrypted mirror locally. In the same MCP host process those queries remain
available without a network freshness call. A later MCP host process
automatically syncs again. A generation change during the bounded build is
retried by the host; do not invent a refresh call before every query.

The immutable generation stays encrypted on disk. The host decrypts at most
one current generation per company into process memory and builds its lexical
index lazily. That plaintext mirror and index have a hard 600-second residency
TTL; expiry removes the strong references even when the host is idle. A later
operation reopens the encrypted local generation without another network sync.

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

Search spans every currently accessible project, task detail, dossier,
knowledge-base page, contact, registry, private meeting, and safe text file
from accepted task/dossier Workspaces in the company mirror. Each optional
domain is included only when the bridge's source OAuth grant carries its normal
read scope.
Ranking and previews are computed locally. Treat result IDs as opaque. Call
`fetch` only for the small relevant set; never paste or load the whole mirror
into the model context.

Use `list` only for explicit inventory or when an exact task is known by
project but not number. It accepts
`resource=projects|tasks|dossiers|knowledge_pages|contacts|registries|meetings`,
optional `projectSlug`, `offset`, and a maximum `limit` of 100. Use `get_task` with exact
`projectSlug` and positive `taskNumber`. These calls return the effective
company/project instructions and personal profile with the selected task.
The local provider resolves both the current project slug and an exact historical
slug from a pre-encryption or renamed project URL; the returned task and opaque
result IDs continue to use the current canonical project slug.

An accepted Workspace search result includes the exact native
`prepare_agent_workspace_read` target. Reading it remains read-only. A writable
task or dossier still uses the ordinary `prepare_agent_workspace_run` and
bridge commands, with the same per-Workspace leases, fencing tokens,
checkpoints, submit, acceptance, and optimistic head checks as every other
company. Never create a company-wide Run lock: neighboring tasks must remain
independent.

## Use the same proposal lifecycle

When a native comment/status/control/checklist proposal tool returns the local
proposal route, call `continue_trelio_local_proposal`. It has three operations:

- `context`: pass `kind` and `payload.target`, where target is exactly one
  `runId` or `projectSlug` plus `taskNumber`.
- `save`: pass the same target, plaintext draft text/reasons, and every exact
  revision/snapshot field from the immediately preceding context response.
  The trusted host encrypts prose locally, uploads only signed ciphertext, and
  sends opaque markers into the existing proposal service.
- `action`: after a separate explicit user decision, pass exact `proposalId`,
  `expectedRevision`, `action`, `confirmed=true`, and the selected open IDs.
  Comment publication also passes the reviewed plaintext `bodyText`; the host
  encrypts it before the request. Never set `confirmed=true` merely because a
  Run finished or a proposal was rendered.

Kinds are `comment`, `status`, `control_clear`, and `checklist`. Preserve the
normal proposal references' semantic rules: unpublished drafts are not public
history, comment and whole-task status decisions are independent, and
checklist/control decisions remain item-specific. Context/save/action reuse the
same server-side ACL, advisory locks, optimistic state revisions, public-comment
snapshot hashes, and idempotent apply/dismiss/publication behavior as native
Trelio.

The returned `reviewUrl` opens the exact task. If the client cannot show an MCP
App, present the hydrated editable proposal and ask for the same explicit
publish/apply/dismiss decision; do not silently convert a proposal into a direct
mutation.

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
