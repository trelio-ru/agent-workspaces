# Accepted Workspace read

Read this file completely before reading, reviewing, summarizing, comparing, or
answering from already accepted Workspace materials without changing them.

## Materialize without a Run

1. Resolve the exact `workspaceId`, or the exact task whose canonical workspace
   is needed, through `scope-and-context.md` unless it is already known. A
   working-folder binding does not prove accepted materials exist.
2. Call `prepare_agent_workspace_read` once with exact `workspaceId`, `taskId`,
   or canonical task URL coordinates. It rechecks read ACL and returns the
   current accepted head plus exact `bridge.action`. If no accepted materials exist,
   report that fact; do not call `ensure_agent_workspace`,
   `prepare_agent_workspace_run`, or `start_agent_workspace_run` to create them.
3. Call the action's exact `server` and `tool` once with its unchanged
   `arguments`; do not convert it to a shell command or probe PATH.
   It creates no Run, lease, checkpoint, task-status proposal, or Trelio mutation.
   For company E2EE it downloads pinned ciphertext and decrypts it only inside
   private bridge state. A tracked symlink, gitlink, or other non-regular file
   blocks inspection rather than exposing a path outside the snapshot.
4. In the printed directory read `../context/agent-instructions.md`, then
   `../context/user-profile.md`, then accepted files. Use
   `../context/index.json` as provenance for the exact head. Keep the snapshot
   read-only; do not edit it, run checkpoint/finish, or use it as a writable
   checkout.
5. For encrypted content use only bounded local file inspection. Never copy a
   query, path, filename, plaintext, snippet, or derived summary into a remote
   Trelio content tool. Answer directly from the local snapshot.

A later request for durable changes is a new writable intent: read the Run
references and call `prepare_agent_workspace_run`. Never reinterpret read intent
as permission to create a Run or ask the user to open Trelio and start one
manually.

If an older backend returns only `bridge.command`, do not execute it directly;
read `setup-and-recovery.md` and use its bounded legacy compatibility route.
