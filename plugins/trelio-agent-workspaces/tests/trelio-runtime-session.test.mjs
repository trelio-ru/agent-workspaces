import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { detectAgentRuntimeAttestation } from "../scripts/trelio-runtime-attestation.mjs";
import {
  buildRuntimeSessionProof,
  isProtectedTrelioToolName,
  resolveTrelioMcpToolName,
} from "../scripts/trelio-runtime-session.mjs";

const hookScriptPath = fileURLToPath(
  new URL("../scripts/trelio-runtime-session.mjs", import.meta.url),
);

const runHook = (hookInput, environment) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [hookScriptPath], {
    env: { ...process.env, ...environment },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.once("error", reject);
  child.once("close", (exitCode) => resolve({ exitCode, stdout, stderr }));
  child.stdin.end(JSON.stringify(hookInput));
});

const readRequestBody = async (request) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
};

test("Codex hook observes model and current turn effort", async () => {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "trelio-runtime-hook-"));
  const transcriptPath = path.join(temporaryDirectory, "rollout.jsonl");
  try {
    await writeFile(transcriptPath, [
      JSON.stringify({ type: "turn_context", payload: { model: "gpt-5.6-sol", effort: "low" } }),
      JSON.stringify({ type: "turn_context", payload: { model: "gpt-5.6-sol", effort: "high" } }),
    ].join("\n"));
    const result = await detectAgentRuntimeAttestation({
      hookInput: {
        hook_event_name: "PreToolUse",
        model: "gpt-5.6-sol",
        transcript_path: transcriptPath,
      },
      environment: { CODEX_THREAD_ID: "019f9fcd-899a-72b3-91f6-fdf3134381bb" },
    });
    assert.equal(result.clientFamily, "codex");
    assert.equal(result.effortLevel, "high");
    assert.equal(result.source, "codex_hook");
    assert.equal(result.evidenceLevel, "local_observed");
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test("hook protects context and mutation but leaves discovery and recovery open", () => {
  assert.equal(resolveTrelioMcpToolName({ tool_name: "mcp__trelio__get_task" }), "get_task");
  assert.equal(resolveTrelioMcpToolName({ tool_name: "mcp__trelio__list_my_tasks" }), "list_my_tasks");
  assert.equal(resolveTrelioMcpToolName({ tool_name: "exec_command" }), null);
  assert.equal(isProtectedTrelioToolName("get_task"), true);
  assert.equal(isProtectedTrelioToolName("create_task"), true);
  assert.equal(isProtectedTrelioToolName("list_my_tasks"), false);
  assert.equal(isProtectedTrelioToolName("approve_agent_workspace_bridge_pairing"), false);
});

test("hook proof is Ed25519-bound to session, tool, timestamp and nonce", () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const runtimeSessionId = "11111111-1111-4111-8111-111111111111";
  const state = {
    runtimeSessionId,
    privateKeyPkcs8: privateKey.export({ type: "pkcs8", format: "der" }).toString("base64url"),
  };
  const proof = buildRuntimeSessionProof({
    state,
    toolName: "get_task",
    now: new Date("2026-08-19T00:00:00.000Z"),
  });
  const payload = Buffer.from([
    "trelio-runtime-proof-v1",
    runtimeSessionId,
    "get_task",
    proof.issuedAt,
    proof.nonce,
  ].join("\n"));
  assert.equal(
    crypto.verify(null, payload, publicKey, Buffer.from(proof.signature, "base64url")),
    true,
  );
  assert.equal(
    crypto.verify(
      null,
      Buffer.from(payload.toString().replace("get_task", "update_task_status")),
      publicKey,
      Buffer.from(proof.signature, "base64url"),
    ),
    false,
  );
});

test("plugin declares runtime lifecycle hooks without restoring the title hook", async () => {
  const hooksPath = fileURLToPath(new URL("../hooks/hooks.json", import.meta.url));
  const hooks = JSON.parse(await readFile(hooksPath, "utf8"));
  assert.ok(hooks.hooks.SessionStart);
  assert.ok(hooks.hooks.PreToolUse);
  assert.ok(hooks.hooks.SessionEnd);
  assert.match(JSON.stringify(hooks), /trelio-runtime-session\.mjs/u);
  assert.doesNotMatch(JSON.stringify(hooks), /title|rename/u);
});

test("an active hook failure does not append unrelated setup steps", async () => {
  const temporaryHome = await mkdtemp(path.join(os.tmpdir(), "trelio-runtime-error-"));
  try {
    const result = await runHook({
      hook_event_name: "PreToolUse",
      session_id: "019f9fcd-899a-72b3-91f6-fdf3134381bb",
      tool_name: "mcp__trelio__get_task",
      tool_input: { companySlug: "vkus", projectSlug: "first", taskNumber: 2 },
    }, {
      HOME: temporaryHome,
      USERPROFILE: temporaryHome,
      CODEX_HOME: temporaryHome,
      CODEX_THREAD_ID: "019f9fcd-899a-72b3-91f6-fdf3134381bb",
      CLAUDE_CODE_ENTRYPOINT: "",
      CLAUDE_EFFORT: "",
    });

    assert.equal(result.exitCode, 2);
    assert.match(result.stderr, /активный клиентский hook не смог определить модель/u);
    assert.match(result.stderr, /Устраните указанную причину и повторите запрос/u);
    assert.doesNotMatch(result.stderr, /Установите|обновите|trelio-workspace login/u);
  } finally {
    await rm(temporaryHome, { recursive: true, force: true });
  }
});

test("SessionStart pins the initial model and PreToolUse injects a verifiable proof", async () => {
  const temporaryHome = await mkdtemp(path.join(os.tmpdir(), "trelio-runtime-e2e-"));
  const transcriptPath = path.join(temporaryHome, "rollout.jsonl");
  const configDirectory = path.join(temporaryHome, ".config", "trelio", "workspace-bridge");
  const threadId = "019f9fcd-899a-72b3-91f6-fdf3134381bb";
  const runtimeSessionId = "11111111-1111-4111-8111-111111111111";
  let registrationBody = null;
  const server = createServer(async (request, response) => {
    assert.equal(request.headers.authorization, "Bearer test-bridge-session");
    assert.equal(request.headers["x-trelio-agent-workspaces-version"], "1.10.8");
    response.setHeader("content-type", "application/json");
    if (request.url === "/api/agent-workspaces/bridge-compatibility") {
      response.end(JSON.stringify({ supported: true, minimumVersion: "1.10.8" }));
      return;
    }
    if (request.url === "/api/agent-workspaces/runtime-policy/sessions") {
      registrationBody = await readRequestBody(request);
      response.statusCode = 201;
      response.end(JSON.stringify({
        schemaVersion: 1,
        runtimeSessionId,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        observation: registrationBody.observation,
      }));
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ message: "not found" }));
  });

  try {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const origin = `http://127.0.0.1:${address.port}`;
    await mkdir(configDirectory, { recursive: true, mode: 0o700 });
    await writeFile(
      path.join(configDirectory, "credentials.json"),
      `${JSON.stringify({ [origin]: { bridgeSessionToken: "test-bridge-session" } })}\n`,
      { mode: 0o600 },
    );
    if (process.platform !== "win32") {
      await chmod(configDirectory, 0o700);
      await chmod(path.join(configDirectory, "credentials.json"), 0o600);
    }
    await writeFile(
      transcriptPath,
      `${JSON.stringify({
        type: "turn_context",
        payload: { model: "gpt-5.4", effort: "high" },
      })}\n`,
    );
    const environment = {
      HOME: temporaryHome,
      USERPROFILE: temporaryHome,
      CODEX_THREAD_ID: threadId,
      TRELIO_WORKSPACE_ORIGIN: origin,
      CLAUDE_CODE_ENTRYPOINT: "",
      CLAUDE_EFFORT: "",
    };
    const started = await runHook({
      hook_event_name: "SessionStart",
      source: "startup",
      session_id: threadId,
      model: "gpt-5.6-sol",
      transcript_path: transcriptPath,
    }, environment);
    assert.deepEqual(started, { exitCode: 0, stdout: "", stderr: "" });

    const guarded = await runHook({
      hook_event_name: "PreToolUse",
      session_id: threadId,
      model: "gpt-5.4",
      transcript_path: transcriptPath,
      tool_name: "mcp__trelio__get_task",
      tool_input: { companySlug: "vkus", projectSlug: "first", taskNumber: 2 },
    }, environment);
    assert.equal(guarded.exitCode, 0);
    assert.equal(guarded.stderr, "");
    assert.ok(registrationBody);
    assert.equal(registrationBody.observation.modelId, "gpt-5.6-sol");
    assert.equal(registrationBody.observation.effortLevel, "high");

    const hookOutput = JSON.parse(guarded.stdout);
    const updatedInput = hookOutput.hookSpecificOutput.updatedInput;
    const proof = updatedInput.runtimeSessionProof;
    assert.equal(updatedInput.taskNumber, 2);
    const publicKey = crypto.createPublicKey({
      key: Buffer.from(registrationBody.publicKeySpki, "base64url"),
      format: "der",
      type: "spki",
    });
    assert.equal(crypto.verify(
      null,
      Buffer.from([
        "trelio-runtime-proof-v1",
        runtimeSessionId,
        "get_task",
        proof.issuedAt,
        proof.nonce,
      ].join("\n")),
      publicKey,
      Buffer.from(proof.signature, "base64url"),
    ), true);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(temporaryHome, { recursive: true, force: true });
  }
});
