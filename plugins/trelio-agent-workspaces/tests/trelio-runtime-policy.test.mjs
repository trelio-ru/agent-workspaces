import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { parseSelfReportedRuntimeAttestationOptions } from "../scripts/trelio-workspace.mjs";

const hookScriptPath = fileURLToPath(
  new URL("../scripts/trelio-runtime-policy.mjs", import.meta.url),
);
const hookManifestPath = fileURLToPath(
  new URL("../hooks/hooks.json", import.meta.url),
);

test("plugin registers no agent hooks", async () => {
  const isMissing = (error) => error?.code === "ENOENT";

  await assert.rejects(access(hookManifestPath), isMissing);
  await assert.rejects(access(hookScriptPath), isMissing);
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

test("bridge represents an unidentified runtime without impersonating a known client", () => {
  const attestation = parseSelfReportedRuntimeAttestationOptions({
    "runtime-client": "other",
    "runtime-observed-at": "2026-08-19T12:34:56.000Z",
  });

  assert.deepEqual(attestation, {
    schemaVersion: 1,
    clientFamily: "other",
    modelId: null,
    effortLevel: null,
    evidenceLevel: "unavailable",
    source: "unknown",
    observedAt: "2026-08-19T12:34:56.000Z",
  });
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
