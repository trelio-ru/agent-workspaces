# Instruction management

Read this file completely before proposing or publishing a personal profile,
company rule, or project rule change, including a durable rule identified by
the agent.

1. Never edit `.trelio/**`, managed `AGENTS.md`, managed `CLAUDE.md`, or
   `context/agent-instructions.md`, and never place instructions in
   `WORKSPACE_CONTEXT.md`.
2. Resolve the exact company and optional project/task context. Call
   `get_agent_instructions` to read current scoped and inherited rules plus the
   authenticated user's personal profile.
3. Before drafting a durable rule, identify every scenario whose behavior it
   would govern and, using the route list in the main skill, read each matching
   reference completely. A managed rule may specialize an allowed choice but
   cannot override ACL, secret handling, confirmation, protected runtime, or
   another mandatory boundary. If the literal request conflicts, explain the
   conflict and propose the narrowest compliant wording. For example, a task
   attachment rule must preserve the `task-run.md` limit to important final and
   genuinely useful intermediate files rather than requiring every workspace
   file.
4. Before editing “How the agent should work with me”, assess all five scopes:
   `current_request`, `task`, `personal`, `project`, and `company`. Prefer the
   narrowest scope covering the intended people and duration.
5. Call `plan_my_agent_profile_update` with the complete proposed personal
   replacement, exact context, recommended scope, and concrete rationale. The
   tool prepares a personal diff only for `personal`.
6. For `current_request`, follow the instruction without persistence. For
   `task`, keep it as an ordinary explicit task requirement. Never hide either
   in `WORKSPACE_CONTEXT.md`. If `project` or `company` is correct, explain the
   broader recommendation and ask before switching flows. Never widen a
   personal request silently.
7. For a confirmed `project` or `company` scope, prepare the complete
   replacement and exact diff with `plan_agent_instructions_update`. Show the
   full plan, rationale, and target scope.
8. Do not publish on your own initiative. Call `publish_my_agent_profile` or
   `publish_agent_instructions` only after explicit confirmation of that exact
   diff and scope, using its exact `expectedRevisionId`, an audit summary, and
   a stable idempotency key.
9. Explain that the new revision applies only to future Runs; active Run
   snapshots remain immutable.

Personal profile publication uses the authenticated user's
`mcp:workspaces:write` authority and cannot edit another member's profile.
Company/project publication requires `mcp:agent-instructions:manage` plus the
ordinary admin role. If permission is missing, report the blocker. Do not fall
back to a workspace candidate or conceal the rule in another file.
