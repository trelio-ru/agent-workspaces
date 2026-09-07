import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, utimes } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import {
  PRE_TOOL_USE_TIMEOUT_SECONDS,
  RUNTIME_REGISTRATION_TIMEOUT_MILLISECONDS,
  RUNTIME_STATE_LOCK_STALE_MILLISECONDS,
  RUNTIME_STATE_LOCK_WAIT_MILLISECONDS,
} from "../scripts/trelio-runtime-session-limits.mjs";
import {
  ensurePrivateDirectory,
  inspectBundledPlugin,
  inspectLocalRuntimeSessions,
  resolveWorkspaceBridgeConfigDirectory,
  writePrivateJsonFile,
} from "../scripts/trelio-workspace.mjs";

const pluginDirectory = fileURLToPath(new URL("..", import.meta.url));
const hookScriptPath = path.join(pluginDirectory, "scripts", "trelio-runtime-session.mjs");
const definition = JSON.parse(await readFile(
  path.join(pluginDirectory, "hooks", "hooks.json"),
  "utf8",
));
const outerTimeoutMilliseconds = definition.hooks.PreToolUse[0].hooks[0].timeout * 1_000;
const compatibilityPath = "/api/agent-workspaces/bridge-compatibility";
const registrationPath = "/api/agent-workspaces/runtime-policy/sessions";

// All credentials, observations, session IDs and HTTP responses below belong
// to a disposable loopback fixture. Run the real hook, including native Windows
// ACL checks; never inspect or modify the developer's installed runtime state.
const createFixture = async (t, { registrationDelayMilliseconds = 0, stallPath = null } = {}) => {
  const temporaryHome = await mkdtemp(path.join(os.tmpdir(), "trelio-hook-budget-"));
  const clientSessionId = crypto.randomUUID();
  const runtimeSessionId = crypto.randomUUID();
  const state = { registrationBody: null, registrationCount: 0, stallPath };
  const server = createServer(async (request, response) => {
    assert.equal(request.headers.authorization, "Bearer synthetic-bridge-session");
    response.setHeader("content-type", "application/json");
    if (request.url === compatibilityPath) {
      if (state.stallPath === compatibilityPath) return;
      response.end(JSON.stringify({ supported: true, minimumVersion: "1.13.3" }));
      return;
    }
    if (request.url === registrationPath) {
      const chunks = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      state.registrationBody = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      state.registrationCount += 1;
      if (state.stallPath === registrationPath) return;
      await delay(registrationDelayMilliseconds);
      response.statusCode = 201;
      response.end(JSON.stringify({
        schemaVersion: 1,
        runtimeSessionId,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        observation: state.registrationBody.observation,
      }));
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ message: "unknown fixture endpoint" }));
  });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(temporaryHome, { recursive: true, force: true });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const environment = {
    ...process.env,
    HOME: temporaryHome,
    USERPROFILE: temporaryHome,
    LOCALAPPDATA: path.join(temporaryHome, "AppData", "Local"),
    CODEX_HOME: path.join(temporaryHome, ".codex"),
    CODEX_THREAD_ID: clientSessionId,
    TRELIO_WORKSPACE_ORIGIN: origin,
    TRELIO_WORKSPACE_DISABLE_KEYCHAIN: "1",
    CLAUDE_CODE_ENTRYPOINT: "",
    CLAUDE_EFFORT: "",
  };
  const configDirectory = resolveWorkspaceBridgeConfigDirectory({
    environment,
    homeDirectory: temporaryHome,
  });
  const stateDigest = crypto.createHash("sha256").update(`${origin}\n${clientSessionId}`).digest("hex");
  const statePath = path.join(configDirectory, "runtime-sessions", `${stateDigest}.json`);
  await ensurePrivateDirectory(configDirectory);
  await writePrivateJsonFile(path.join(configDirectory, "credentials.json"), {
    [origin]: { bridgeSessionToken: "synthetic-bridge-session" },
  });
  const input = {
    hook_event_name: "PreToolUse",
    session_id: clientSessionId,
    model: "gpt-5.6-sol",
    tool_name: "mcp__trelio__get_task",
    tool_input: { companySlug: "example", projectSlug: "first", taskNumber: 2 },
  };

  const run = (coldStartMilliseconds = 0) => new Promise((resolve, reject) => {
    // Delay before importing the production hook, under the same outer clock.
    // A production test-only env switch would change the admission surface.
    // This prelude instead models cold process startup entirely in the harness.
    const prelude = "data:text/javascript," + encodeURIComponent(
      `await new Promise(resolve => setTimeout(resolve, ${coldStartMilliseconds}));`,
    );
    const startedAt = performance.now();
    const child = spawn(process.execPath, ["--import", prelude, hookScriptPath], {
      env: environment,
      stdio: ["pipe", "pipe", "pipe"],
      timeout: outerTimeoutMilliseconds,
      killSignal: "SIGKILL",
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.stdin.once("error", reject);
    child.once("close", (exitCode, signal) => resolve({
      exitCode, signal, stdout, stderr,
      elapsedMilliseconds: performance.now() - startedAt,
    }));
    child.stdin.end(JSON.stringify(input));
  });
  return { state, statePath, configDirectory, input, runtimeSessionId, run };
};

const assertProof = (fixture, result) => {
  assert.equal(result.signal, null, "the host must not kill the hook");
  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(result.stderr, "");
  const output = JSON.parse(result.stdout).hookSpecificOutput;
  assert.equal(output.hookEventName, "PreToolUse");
  assert.equal(output.permissionDecision, "allow");
  const { runtimeSessionProof: proof, ...originalInput } = output.updatedInput;
  assert.deepEqual(originalInput, fixture.input.tool_input);
  assert.equal(proof.runtimeSessionId, fixture.runtimeSessionId);
  const publicKey = crypto.createPublicKey({
    key: Buffer.from(fixture.state.registrationBody.publicKeySpki, "base64url"),
    format: "der",
    type: "spki",
  });
  assert.equal(crypto.verify(
    null,
    Buffer.from([
      "trelio-runtime-proof-v1", fixture.runtimeSessionId, "get_task", proof.issuedAt, proof.nonce,
    ].join("\n")),
    publicKey,
    Buffer.from(proof.signature, "base64url"),
  ), true);
};

test("hook definition and doctor budget cover cold startup, registration and lock cleanup", async () => {
  assert.equal(outerTimeoutMilliseconds, PRE_TOOL_USE_TIMEOUT_SECONDS * 1_000);
  // Seven seconds observed before lock creation, plus a contended lock and
  // the full internal deadline, still leave room for private state and output.
  assert.ok(outerTimeoutMilliseconds >= 7_000
    + RUNTIME_STATE_LOCK_WAIT_MILLISECONDS
    + RUNTIME_REGISTRATION_TIMEOUT_MILLISECONDS
    + 5_000);
  assert.ok(RUNTIME_STATE_LOCK_STALE_MILLISECONDS > outerTimeoutMilliseconds + 5_000);
  const report = await inspectBundledPlugin({ pluginDirectory });
  assert.equal(report.hooks.status, "ready");
  assert.equal(report.hooks.events.PreToolUse.timeout, PRE_TOOL_USE_TIMEOUT_SECONDS);
});

test("cold startup and slow registration produce a proof after the former 15-second cutoff", async (t) => {
  const fixture = await createFixture(t, { registrationDelayMilliseconds: 7_500 });
  const result = await fixture.run(8_500);
  assertProof(fixture, result);
  assert.ok(result.elapsedMilliseconds > 15_000);
  assert.equal(fixture.state.registrationCount, 1);
  await assert.rejects(stat(`${fixture.statePath}.lock`), { code: "ENOENT" });
  const report = await inspectLocalRuntimeSessions({ configDirectory: fixture.configDirectory });
  assert.equal(report.activeCount, 1);
  assert.equal(report.registrationLockCount, 0);
});

for (const stallPath of [compatibilityPath, registrationPath]) {
  test(`cold startup and stalled ${stallPath} abort internally and allow the next hook`, async (t) => {
    const fixture = await createFixture(t, { stallPath });
    const result = await fixture.run(7_000);
    assert.equal(result.signal, null, "internal abort must precede the host kill");
    assert.equal(result.exitCode, 2, result.stderr);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /TRELIO_RUNTIME_HOOK_FAILED:/u);
    assert.doesNotMatch(result.stderr, /TRELIO_RUNTIME_HOOK_REQUIRED|включите Hooks/iu);
    assert.ok(result.elapsedMilliseconds > 15_000);
    await assert.rejects(stat(fixture.statePath), { code: "ENOENT" });
    await assert.rejects(stat(`${fixture.statePath}.lock`), { code: "ENOENT" });

    // Restore the same fixture transport and retry without deleting local
    // state, changing identity, restarting a client or re-pairing credentials.
    fixture.state.stallPath = null;
    assertProof(fixture, await fixture.run());
  });
}

test("a lock inside the host budget stays live; an expired lock is recovered automatically", async (t) => {
  const fixture = await createFixture(t);
  const lockPath = `${fixture.statePath}.lock`;
  await ensurePrivateDirectory(path.dirname(fixture.statePath));
  await mkdir(lockPath, { mode: 0o700 });
  const liveLockTime = new Date(Date.now() - 20_000);
  await utimes(lockPath, liveLockTime, liveLockTime);
  const initialLockMtime = (await stat(lockPath)).mtimeMs;
  const report = await inspectLocalRuntimeSessions({ configDirectory: fixture.configDirectory });
  assert.equal(report.registrationLockCount, 1);
  assert.equal(report.staleRegistrationLockCount, 0);
  const blocked = await fixture.run();
  assert.equal(blocked.exitCode, 2, blocked.stderr);
  assert.match(blocked.stderr, /другая runtime-регистрация не завершилась вовремя/u);
  assert.equal(blocked.stdout, "");
  assert.equal(fixture.state.registrationCount, 0);
  assert.equal((await stat(lockPath)).mtimeMs, initialLockMtime);

  const staleLockTime = new Date(Date.now() - RUNTIME_STATE_LOCK_STALE_MILLISECONDS - 1_000);
  await utimes(lockPath, staleLockTime, staleLockTime);
  const staleReport = await inspectLocalRuntimeSessions({ configDirectory: fixture.configDirectory });
  assert.equal(staleReport.staleRegistrationLockCount, 1);
  assertProof(fixture, await fixture.run());
  assert.equal(fixture.state.registrationCount, 1);
  await assert.rejects(stat(lockPath), { code: "ENOENT" });
});
