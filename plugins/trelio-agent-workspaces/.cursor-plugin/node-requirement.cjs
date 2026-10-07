"use strict";

// Cursor's native MCP config has no documented commandWindows override. Start
// the same signed loader through Node on every OS, without relying on a shell
// choosing between the extensionless POSIX launcher and its .cmd sibling.
// This preload runs before loader imports/cache/network access and retains the
// Node 22 prerequisite that Codex/Claude enforce in their unchanged launchers.
const nodeMajor = Number(process.versions.node.split(".")[0]);
if (!Number.isInteger(nodeMajor) || nodeMajor < 22) {
  process.stderr.write("Trelio Cursor Desktop requires Node.js 22 or newer on PATH.\n");
  process.exit(127);
}
