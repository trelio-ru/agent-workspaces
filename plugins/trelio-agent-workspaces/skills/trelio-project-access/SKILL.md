---
name: trelio-project-access
description: Manage one existing Trelio company member's direct role in one project through the guarded MCP plan/apply flow. Use when a company owner or administrator asks to add, remove, promote, demote, or otherwise change a project's moderator, participant, or observer, or when an agent proposes such an access change.
---

# Trelio Project Access

Use only the dedicated Trelio MCP tools. This flow changes one active company
member's direct membership in one project; it does not invite people to the
company, edit groups, or perform bulk membership replacement.

## Check authority and connection

1. Require callable Trelio MCP tools. If the tools are missing, ask the user to
   open `Plugins -> Trelio Agent Workspaces`, complete Trelio OAuth, and start
   a new task. Do not use the browser or a broad project settings request as a
   substitute.
2. The authenticated user must be the company owner or a company
   administrator. A project moderator cannot initiate this MCP operation, even
   in a project they manage through the web interface.
3. The OAuth token must contain `mcp:project-access:manage` together with
   `mcp:read`. Existing connections do not acquire the new scope
   automatically. If the scope is missing, ask the user to reconnect Trelio
   OAuth and retry in a new task.
4. Never attempt to change the authenticated user's own direct project role
   through this flow.

## Resolve exact identities

1. Resolve the exact company and project from a canonical URL, explicit slugs,
   or read-only discovery. Do not guess when several projects match.
2. Call `get_agent_instructions` for the resolved company and project before
   substantive work. Follow the effective company/project rules and the
   authenticated user's personal profile.
3. Call `get_project_meta` or `resolve_user` and select one exact active
   `memberId`. A display name, username, or email-like text is discovery input,
   never the mutation identity.
4. If several people match, ask the user to choose. If nobody matches, explain
   that this flow only manages existing company members; do not invent an
   invite or placeholder workflow.
5. Map the requested direct project role exactly:
   - `admin` – модератор;
   - `member` – участник;
   - `watcher` – наблюдатель;
   - `null` – удалить прямое участие в проекте.

## Always prepare a plan

Call `plan_project_access_change` for the exact company, project, `memberId`,
and requested role before every mutation.

Read and preserve all returned fields that affect the decision:

- `action` and `canApply`;
- current and requested direct roles;
- group role and effective role before and after;
- company-wide owner/administrator access;
- task-scoped full access that will remain;
- `warnings`;
- `confirmationRequired`, `confirmationReasons`, and
  `confirmationMessages`;
- `expectedStateHash`.

If `canApply=false`, report that the requested direct role is already set and
do not call apply.

## Decide whether to pause

An exact direct user command naming the project, person, and participant or
observer role – or explicitly asking to remove that person – authorizes apply
after the plan when `confirmationRequired=false`. Do not ask a ceremonial
second question.

Show the complete plan and wait for explicit confirmation when any of these is
true:

- the agent suggested or inferred the change;
- the person, project, role, or intended removal is ambiguous;
- the user asked only for analysis or a recommendation;
- the plan reports `confirmationRequired=true`.

Granting or revoking moderator rights always has
`confirmationRequired=true`. A direct command such as “сделай Ивана
модератором” is not the second confirmation: show the resolved plan and ask
the user to confirm that exact grant or revocation. Set `confirmed=true` only
after that reply.

Do not hide warnings. In particular, explain when company-wide, group, or
task-scoped access remains after removing the direct role, and when the project
will have no direct moderator.

## Apply exactly once

1. Call `apply_project_access_change` with the same company, project,
   `targetMemberId`, requested role, and exact `expectedStateHash` returned by
   the current plan.
2. Create one stable `clientRequestId` for this exact intended change. Reuse it
   when retrying after a lost response; never reuse it for another person,
   project, role, or confirmation state.
3. Pass `confirmed=true` only under the confirmation rule above. Omit it or
   pass `false` for a direct participant/observer change that does not require
   confirmation.
4. If the server says the project access changed after the plan, discard the
   stale hash and prepare a fresh plan. Show the new plan and obtain a fresh
   confirmation whenever its sensitive result or warnings require one.
5. Treat a replayed success as the original success. Do not create a new
   request merely because the first response was lost.

## Report the result

State the project, exact person, previous direct role, new direct role, and
effective access after the change. Include every remaining-access warning.
Mention that the target receives the ordinary Trelio project membership
notification and that the action is recorded as an MCP company activity event.

Never work around this contract with a full project PATCH, a group edit,
several single-member calls presented as an unreviewed bulk action, direct
database access, or the authenticated user's own membership.
