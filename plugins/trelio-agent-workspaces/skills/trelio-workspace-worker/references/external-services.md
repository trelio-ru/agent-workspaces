# Connected services and Agent Skills

Read this file completely before using a connected service, external system,
assigned Agent Skill, Remote MCP, or signed runtime. Native Trelio reads,
discovery, and Agent Workspace control-plane work do not use this gate.

## Select the current skill

1. In the exact company/project context, call `search_agent_skills` with the
   task and compact concept hints; reserve `list_agent_skills` for explicit inventory.
2. Load `get_agent_skill` once before the first external action in this session. Reuse its complete instructions and exact execution declaration across user turns for up to 12 hours while company/project, skill, implementation and intent stay unchanged. Reload after a new session, lost or compacted full text, 12 hours, route/context change, a resolved setup/access blocker, or once on `AGENT_SKILL_RELEASE_CHANGED`. Do not reread before each subcommand. The trusted host owns the bounded admission cache; never edit it or extend its expiry.
3. The host may reuse an exact admission for at most 12 hours without sliding renewal. Revocation takes effect at refresh; package verification and Remote MCP tool policy remain mandatory.
4. Use the selected skill's exact `runtimeExecution` or
   `remoteMcpExecution`; do not bypass a usable route with browser automation,
   Computer Use, direct HTTP, another MCP, or an improvised script.

If the selected skill or its company/personal connection reports
`setup_required`, `no_access`, or `needs_reconnect`, say that it is currently
unavailable, name the required action, and stop that data request. Outside
formal `integrationRouting`, another source is allowed only after the user sees
the blocker and explicitly chooses it. A catalog/control-plane outage,
timeout, transient failure, or unknown error is not proof that no skill or
access exists.

## Follow formal routing exactly

When relevant catalog items return `integrationRouting`, use only its current
fields; never infer a route from skill IDs, titles, catalog order, prior use,
or an integration-specific tool name.

- Within one `family`, use the sole enabled item or exact returned `role`,
  `primarySkillId`, `selectionRule`, and `priority` semantics.
- Move only to the exact `fallbackSkillId` after the selected implementation
  establishes a reason listed in its own `fallbackWhen`.
- Never carry assignment, connection, credential, local session, or policy
  between skills.
- Missing, malformed, or inconsistent routing metadata, control-plane outage,
  timeout, transient/unknown failure, and
  `ambiguousMutationFallback: forbidden` do not permit fallback or automatic
  retry. Establish the live result or ask the user first.

On `AGENT_SKILL_RELEASE_CHANGED`, read the selected skill once again before
retrying; never force the stale release.

## Execute the typed local action

For a signed runtime call the exact server/tool from
`runtimeExecution.localAction` with its returned arguments. Append only the
skill arguments allowed by the current instruction to `parameters.arguments`;
do not change identity, release, runtime-session, or another field. The local
dispatcher selects this loaded plugin's bridge and Node executable without a
shell or PATH lookup.

If an older response has only `runtimeExecution.command`, read
`setup-and-recovery.md` and use its bounded legacy route. Do not probe PATH or
scan plugin caches.
