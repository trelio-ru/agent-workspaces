import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { resolveInitialChatTitleReminder } from "../scripts/trelio-runtime-policy.mjs";
import { parseSelfReportedRuntimeAttestationOptions } from "../scripts/trelio-workspace.mjs";

const hookScriptPath = fileURLToPath(
  new URL("../scripts/trelio-runtime-policy.mjs", import.meta.url),
);
const hookManifestPath = fileURLToPath(
  new URL("../hooks/hooks.json", import.meta.url),
);

const runSessionHook = async (hookInput, environment = {}) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [hookScriptPath], {
    env: { ...process.env, ...environment },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const stdout = [];
  const stderr = [];

  child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
  child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
  child.once("error", reject);
  child.once("exit", (exitCode) => resolve({
    exitCode,
    stdout: Buffer.concat(stdout).toString("utf8"),
    stderr: Buffer.concat(stderr).toString("utf8"),
  }));
  child.stdin.end(JSON.stringify(hookInput));
});

test("plugin keeps only the unrelated SessionStart reminder hook", async () => {
  const manifest = JSON.parse(await readFile(hookManifestPath, "utf8"));

  assert.deepEqual(Object.keys(manifest.hooks), ["SessionStart"]);
  assert.equal(manifest.hooks.PreToolUse, undefined);
  assert.match(manifest.description, /backend-ом Trelio/u);
});

test("new Codex task receives the one-time title reminder", async () => {
  const hookInput = {
    hook_event_name: "SessionStart",
    source: "startup",
  };
  const environment = {
    CODEX_THREAD_ID: "019f9fcd-899a-72b3-91f6-fdf3134381bb",
  };
  const reminder = resolveInitialChatTitleReminder({ hookInput, environment });
  const result = await runSessionHook(hookInput, environment);

  assert.match(reminder, /первый ход нового основного чата/u);
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, `${reminder}\n`);
  assert.equal(result.stderr, "");
});

test("hook never blocks or inspects PreToolUse", async () => {
  const result = await runSessionHook({
    hook_event_name: "PreToolUse",
    tool_name: "mcp__trelio__get_task",
    tool_input: { companySlug: "vkus" },
    model: "gpt-5.6-luna",
    effort: { level: "low" },
  });

  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
});

test("bridge reconstructs a Codex self-attestation only from explicit MCP argv", () => {
  const attestation = parseSelfReportedRuntimeAttestationOptions({
    "runtime-client": "codex",
    "runtime-model": "gpt-5.6-sol",
    "runtime-effort": "high",
    "runtime-observed-at": "2026-08-19T12:34:56.000Z",
  });

  assert.deepEqual(attestation, {
    schemaVersion: 1,
    clientFamily: "codex",
    modelId: "gpt-5.6-sol",
    effortLevel: "high",
    evidenceLevel: "self_reported",
    source: "agent_request",
    observedAt: "2026-08-19T12:34:56.000Z",
  });
});

test("bridge accepts Claude Code self-attestation in cloud-compatible argv", () => {
  const attestation = parseSelfReportedRuntimeAttestationOptions({
    "runtime-client": "claude-code",
    "runtime-model": "claude-opus-5-20260801",
    "runtime-effort": "max",
    "runtime-observed-at": "2026-08-19T12:34:56+00:00",
  });

  assert.equal(attestation.clientFamily, "claude-code");
  assert.equal(attestation.source, "agent_request");
  assert.equal(attestation.evidenceLevel, "self_reported");
});

test("bridge rejects partial or shell-shaped runtime declarations", () => {
  assert.throws(
    () => parseSelfReportedRuntimeAttestationOptions({
      "runtime-model": "gpt-5.6-sol",
    }),
    /runtime-client/u,
  );
  assert.throws(
    () => parseSelfReportedRuntimeAttestationOptions({
      "runtime-client": "codex",
      "runtime-model": "gpt-5.6-sol$(touch bad)",
      "runtime-observed-at": "2026-08-19T12:34:56.000Z",
    }),
    /безопасный model id/u,
  );
});
