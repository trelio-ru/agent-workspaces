---
name: 1c
description: Safely inspect the live 1C publication while preparing the fixed broad read-only business capability registry. This development release is project-scoped and exposes no arbitrary OData surface.
---

# 1С – development inventory release

Use only the signed `runtimeExecution.command` returned by the current
`get_agent_skill` response.

This temporary development release has one command:

`developer-inventory-metadata`

It fetches the fixed `$metadata` path and one bounded structural sample for
business-oriented candidates. It returns only entity/property/type names,
schema SHA-256, scalar value classes and safe error categories. It does not
return raw metadata, record values, arbitrary URLs, entities, fields, filters,
ordering or OData expressions.

The skill must be assigned only to the project
`vkus/avtomatizatsiya-upravleniya` while this release is current.

## Shared connection and credentials

The backend resolves the existing `1c-edo` company connection for this skill:
the same safe config, connection id and `x_odata` Agent Secret binding. The
runtime deliberately uses the existing local namespace:

`<trelio-config-home>/integrations/1c-edo/<company-id>/<member-id>/<connection-id>/`

Do not connect again, copy credential files or ask the user to re-enter a
login/password when `1c-edo` is already connected.

For the inventory command, prepare the existing `x_odata` Agent Secret with
delivery `env`, exact environment name `TRELIO_1C_EDO_X_ODATA` and executable
`trelio-workspace`. Execute the returned `bridge.argvPrefix`, append the
current `runtimeExecution.command` without its first `trelio-workspace` token,
then append `developer-inventory-metadata`.

Never expose the secret, endpoint URL, response body, credentials or local
session files. Do not bypass the signed runtime with a browser, `curl`, direct
HTTP or a locally edited script.
