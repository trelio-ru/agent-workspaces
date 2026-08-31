---
name: trelio-private-skill-management
description: Create or publish a company-private Trelio Agent Skill through the guarded local plan/apply flow. Use when a Trelio company owner or administrator asks an agent to create, install, update, or publish a private Markdown skill, declarative Remote MCP skill, or executable .skillpkg release.
---

# Trelio Private Skill Management

Use only the four `trelio-remote-skills` management tools described below. The
authenticated user must be the company owner or an administrator, and the
paired bridge session must include `agent-skill:manage`. If an older connection
lacks it, ask the user to reconnect Trelio in the plugin and retry in a new
task. Do not substitute browser automation, a raw HTTP request, a database
write, or the ordinary company publication form.

## Choose one publication type

- `executionKind=markdown` publishes instructions only.
- `executionKind=remote_mcp` requires a complete provider-neutral Remote MCP
  declaration. Preserve the exact HTTPS endpoint, authentication type,
  headers, credential-help text, and either the exact allowlist or the
  credential-free `all_read_only` policy. The local host validates the same
  declaration again before every execution.
- `executionKind=skillpkg` requires a local `.skillpkg` path. The bridge reads a
  regular non-symlink file, binds a short skill slug to the exact company skill
  identity when necessary, and revalidates every file digest, entrypoint,
  interpreter, capability, size, and portable path before publication.
- On a later release only, `executionKind=reuse_skillpkg` keeps the current
  immutable runtime bytes while publishing new instructions and discovery
  metadata.

An executable package uploaded by a company remains `company_unverified`.
Publication never supplies device consent: before first execution, every user
must separately approve the exact release in the bridge's protected local
window.

## Prepare the exact plan

For a new skill call `plan_company_private_agent_skill_create`. Creation always
publishes version `1.0.0`. Supply the company slug, stable lowercase kebab-case
skill slug, title, description, search terms, category, instructions,
publication summary, change reason, and one execution type.

For an existing private skill call
`plan_company_private_agent_skill_release`. Supply the next `X.Y.Z` version and
the complete new release content. The tool reads the live current release and
binds the plan to its exact release ID; never guess or reuse an earlier plan.

When company E2EE is enabled, the bridge automatically opens the company scope
locally. The user's encryption key is entered only in a loopback page. The
bridge encrypts prose, discovery terms, Remote MCP configuration, runtime
manifest, and `.skillpkg` bytes before the apply request. Raw keys and
plaintext package bytes must never be placed in prompt output, MCP arguments
beyond the user-provided source content/path, environment variables, argv, or
Trelio server logs. If the device is awaiting access, preserve the exact
encryption-settings URL returned by the bridge and ask the owner to grant that
device access there.

Read the complete plan result: operation, company, skill/version, execution
summary, content-protection mode, expected current release, changed fields,
warnings, expiry, `planId`, `planHash`, and `settingsUrl`.

## Always pause for separate confirmation

Planning never authorizes apply, even when the original request directly said
"create" or "publish". Show the material plan, including Remote MCP endpoint,
authentication/tool policy or `.skillpkg` interpreter/capabilities and every
warning. Ask the owner/admin to confirm the exact `planHash`. Do not call an
apply tool in the same assistant turn as its plan.

After an explicit confirmation, call `create_company_private_agent_skill` or
`publish_company_private_agent_skill_release` with the same `planId`, exact
`planHash`, and `confirmed=true`. The bridge owns the stable idempotency key. A
lost response may be retried with the same plan; never prepare a replacement
merely to repeat an ambiguous mutation. If the plan expired, company
encryption state changed, or current release CAS failed, discard it, prepare a
fresh plan, show the changed result, and obtain fresh confirmation.

## Report and link the result

Treat `replayed=true` as the original success. State the published version and
execution type, then give the clickable exact `settingsUrl` returned by apply.
Creation installs the skill but deliberately does not assign or enable it for
the whole company or any project; release publication also leaves assignment
unchanged. Say this directly and use that exact page for human review,
assignment, connection setup, or later management.
