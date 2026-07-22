---
name: trelio-workspace-worker
description: Work through Trelio company, project, or task Agent Workspaces with MCP and the local Git bridge. Use when the user asks Codex to take, continue, analyze, prepare materials for, complete, or restore work tied to a Trelio company/project/task, and the durable result must be checkpointed and saved with version-conflict protection.
---

# Trelio Workspace Worker

Use Trelio MCP as the control plane and the bundled `scripts/trelio-workspace.mjs` bridge as the local Git data plane. Never place OAuth credentials in prompts, commands, workspace files, Git config, comments, or checkpoints.

Treat Agent Secrets the same way. Use `list_agent_secrets` for safe metadata. If access is missing, call `request_agent_secret_access`; never ask the user to paste a password, token, or private key into chat. Create a new record only with `create_agent_secret_placeholder`. Ask the user to configure its value in Trelio's protected browser form, or, when the value already exists in a local producer/file, write it directly with `PRODUCER | trelio-workspace secret set --secret UUID` or `trelio-workspace secret set --secret UUID --file PATH` inside the current Run. Never place the literal value in argv, a shell variable, prompt, workspace file, comment, checkpoint, or handoff.

When a local tool needs a configured secret, call `prepare_agent_secret_checkout` for the current Run and exact executable, then execute the returned `trelio-workspace secret exec --grant ... -- COMMAND` command. The bridge retrieves the value once and delivers it locally using the server-authorized `stdin`, `env`, or private temporary-file mode. Trelio does not run the command. Never replace the executable with a shell, logger, `env`, `printenv`, `cat`, or another program whose purpose is to reveal the value.

## Execute the work

1. Resolve the requested company, project, or task through Trelio MCP. Do not guess an ID from a title when more than one result matches.
2. Call `ensure_agent_workspace` with the exact scope and UUID. Use task scope for task work, project scope for shared project knowledge, and company scope only for company-wide materials.
3. Read the returned permissions. Stop before changing files if `canWrite` is false.
4. Call `start_agent_workspace_run`. Do not reuse another user's Run.
5. Execute the returned bridge command. If `trelio-workspace` is not on PATH, execute the plugin's `scripts/trelio-workspace.mjs` with Node.js 22+ and the same arguments.
6. If the bridge reports that login is required, tell the user OAuth consent is opening, run `trelio-workspace login`, and continue after consent. This is the only expected interactive setup.
7. Use the path printed by `open` as the working directory. Read its protected `AGENTS.md` completely before edits. Read available parent snapshots under `../context/company` and `../context/project`; treat them as read-only and pinned to the Run.
8. Perform the requested work inside the selected workspace. Preserve sources in `sources/`, intermediate work in `work/`, final materials in `artifacts/`, and agent-extracted representations in `derived/`.
9. Run relevant validation. After bridge `open`, use `trelio-workspace checkpoint` for durable progress without private chain-of-thought or raw technical traces.
10. For task-scoped work, publish a meaningful Trelio task comment through `create_comment` before handoff whenever the work changes task context or produces a result for participants. The comment must say what changed or was prepared, why it matters, what was validated, which questions remain, and what people need to do. Do this without asking the operator to copy or publish a prepared draft. Skip only duplicate/intermediate technical updates with no participant-facing result. If the OAuth token lacks `mcp:comments:create`, record a blocker and explain the missing permission instead of silently leaving the comment unpublished.
11. Before submission run `trelio-workspace status` and inspect every changed path. Then create a `handoff` checkpoint with a plain-language result summary, one or more result/validation items, the durable materials being saved, every open question, and one concrete next action. For task work, pass the `comment.id` returned by `create_comment` as `--task-comment`. For example: `trelio-workspace checkpoint --type handoff --summary "Подготовлен план монтажа с ответственными и контрольными точками." --evidence "Исходные требования сопоставлены с планом; критических технических препятствий не обнаружено." --file artifacts/montage-plan.md --question "Кто подтверждает дату монтажа?" --task-comment <comment-uuid> --next-action "Ответьте, кто подтверждает дату, чтобы продолжить подготовку монтажа."`.
12. Run `trelio-workspace submit`. The bridge commits all inspected changes, heartbeats the lease, creates the candidate bundle, and sends it to Trelio. Trelio validates ACL, structure, sizes and secrets, then atomically accepts the revision only while `acceptedHead` still equals the Run's pinned `baseHead`. Submission still requires a meaningful handoff and, for task work, the linked operator-facing task comment.
13. Report to the operator in this order: outcome, important findings or validations, materials saved in the workspace, open questions, and the exact next action. Keep identifiers and implementation details out of the normal response; mention a short revision only during troubleshooting. Never say merely that useful content is "inside" the candidate—surface the content or name the exact material. Do not ask the operator to perform a separate acceptance step after a successful submit.

## Handle blockers and concurrency

- Send heartbeat during long work and immediately before submission.
- If the user explicitly abandons or withdraws an open Run, call `cancel_agent_workspace_run` with a concrete audit reason. Do not interpret a temporary blocker or a failed local command as cancellation.
- For missing authority, ambiguous input, or a decision only a person can make, create a `blocker` checkpoint with a concrete `nextAction`, then ask the user.
- On `LEASE_EXPIRED` or stale fencing, do not retry mutations with old identifiers. If continuing your own existing Run is intentional, claim it again through `trelio-workspace open --workspace <uuid> --run <uuid>`; otherwise start a new Run from the current accepted head and reapply only inspected local changes.
- On `WORKSPACE_OUTDATED`, preserve the rejected candidate. Start a new Run from the current accepted head, compare the concurrent changes, and merge or reapply deliberately; never force-update the canonical revision.
- When the operator asks to undo workspace changes, call `list_agent_workspace_revisions`, select an exact previously accepted head, and call `restore_agent_workspace_revision` with the current head as `expectedHead` and a meaningful audit reason. Restore creates a new accepted commit with the old tree; it never rewrites history and still rejects concurrent changes.
- Never edit `.trelio/**` or `AGENTS.md`. Never add `.env`, credentials, private keys, symlinks, submodules, or generated dependency trees.

## Register OCR and vision results

Let the agent perform OCR/vision only when the task needs it. Store the result and a sibling `extraction-manifest.json`:

```json
{
  "schemaVersion": 1,
  "source": {
    "path": "sources/contract-scan.pdf",
    "digest": "sha256:<64 lowercase hex characters>"
  },
  "artifact": {
    "path": "derived/contract-scan/extracted-text.md",
    "type": "ocr_text"
  },
  "extraction": {
    "method": "agent-vision",
    "verificationStatus": "machine_extracted"
  },
  "warnings": ["Page 7 is low quality"]
}
```

Use only `machine_extracted` or `agent_visually_checked`. Never claim `human_verified`; Trelio records that only after an authorized person confirms the current accepted artifact. Cite original pages/images for material dates, sums, percentages, signatures, and identifiers.
