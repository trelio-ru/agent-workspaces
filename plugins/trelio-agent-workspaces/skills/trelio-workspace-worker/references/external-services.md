# Connected services and Agent Skills

Read this file completely before using a connected service, external system,
assigned Agent Skill, Remote MCP, or signed runtime. Native Trelio reads,
discovery, and Agent Workspace control-plane work do not use this gate.

## Select the current skill

1. In the exact company/project context, call `search_agent_skills` with the
   task and compact concept hints. Choose a ranked result, then call
   `get_agent_skill` once before the first external action in the current user
   turn.
2. That successful read covers the related uninterrupted operation while the
   exact context, skill, implementation, and user intent stay unchanged. Do
   not repeat it immediately or before each subcommand.
3. Read it again in a later user turn, after the exact route changes, after a
   returned setup/access blocker is resolved, or once on
   `AGENT_SKILL_RELEASE_CHANGED`. Reserve `list_agent_skills` for explicit
   catalog inventory.
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
