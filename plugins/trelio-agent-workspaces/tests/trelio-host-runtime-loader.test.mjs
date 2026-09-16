import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  buildBundledHostRuntimeSelection,
  normalizeHostRuntimeDescriptor,
  verifyHostRuntimeSignature,
} from "../scripts/trelio-host-runtime-loader.mjs";
import { resolveHostRuntimeInvocation } from "../scripts/trelio-host-runtime-entry.mjs";
import {
  BRIDGE_VERSION,
  buildAgentSkillPackage,
} from "../scripts/trelio-workspace.mjs";

const loaderPath = fileURLToPath(new URL(
  "../scripts/trelio-host-runtime-loader.mjs",
  import.meta.url,
));

const runLoader = async (argumentsList, environment) => await new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [loaderPath, ...argumentsList], {
    env: environment,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const stdout = [];
  const stderr = [];
  child.stdout.on("data", (chunk) => stdout.push(chunk));
  child.stderr.on("data", (chunk) => stderr.push(chunk));
  child.once("error", reject);
  child.once("exit", (code, signal) => resolve({
    code,
    signal,
    stdout: Buffer.concat(stdout).toString("utf8"),
    stderr: Buffer.concat(stderr).toString("utf8"),
  }));
});

test("host runtime entrypoint keeps one stable three-mode interface", () => {
  const bridge = resolveHostRuntimeInvocation(["bridge", "doctor", "--json"]);
  assert.equal(path.basename(bridge.entrypointPath), "trelio-workspace.mjs");
  assert.deepEqual(bridge.arguments, ["doctor", "--json"]);
  assert.equal(path.basename(resolveHostRuntimeInvocation(["hook"]).entrypointPath), "trelio-runtime-session.mjs");
  assert.equal(path.basename(resolveHostRuntimeInvocation(["mcp"]).entrypointPath), "trelio-remote-mcp.mjs");
  assert.throws(() => resolveHostRuntimeInvocation(["unknown"]), /bridge, hook/u);
});

test("host runtime descriptor is same-origin, bounded and stable-versioned", () => {
  const descriptor = normalizeHostRuntimeDescriptor({
    schemaVersion: 1,
    runtime: {
      runtimeVersion: "3.4.5",
      minimumRuntimeVersion: "3.4.0",
      minimumPluginVersion: "2.3.0",
      packageSha256: "a".repeat(64),
      packageSizeBytes: 1024,
      packageUrl: "/api/agent-workspaces/host-runtime/artifacts/runtime/package",
      packageSignature: "signature",
      signingPublicKeySpki: "public-key",
    },
  }, "https://trelio.ru");

  assert.equal(descriptor.packageUrl, "https://trelio.ru/api/agent-workspaces/host-runtime/artifacts/runtime/package");
  assert.throws(
    () => normalizeHostRuntimeDescriptor({
      schemaVersion: 1,
      runtime: { ...descriptor, packageUrl: "https://example.com/runtime" },
    }, "https://trelio.ru"),
    /некорректное описание/u,
  );
});

test("host runtime accepts only the exact Ed25519 signature", () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const packageBytes = Buffer.from("signed runtime package", "utf8");
  const descriptor = {
    packageSignature: sign(null, packageBytes, privateKey).toString("base64"),
    signingPublicKeySpki: publicKey.export({ format: "der", type: "spki" }).toString("base64"),
  };

  assert.doesNotThrow(() => verifyHostRuntimeSignature(packageBytes, descriptor));
  assert.throws(
    () => verifyHostRuntimeSignature(Buffer.from("changed", "utf8"), descriptor),
    /signature verification/u,
  );
});

test("host runtime loader has a bundled fail-closed fallback", () => {
  const selected = buildBundledHostRuntimeSelection();
  assert.equal(selected.runtimeVersion, BRIDGE_VERSION);
  assert.match(selected.entrypointPath, /trelio-host-runtime-entry\.mjs$/u);
});

test("host runtime updater verifies, materializes and selects a signed package", async () => {
  const temporaryHome = await fs.mkdtemp(path.join(os.tmpdir(), "trelio-runtime-loader-test-"));
  const sourceDirectory = path.join(temporaryHome, "source");
  const entrypointPath = path.join(sourceDirectory, "scripts", "trelio-host-runtime-entry.mjs");
  await fs.mkdir(path.dirname(entrypointPath), { recursive: true });
  await fs.writeFile(
    entrypointPath,
    "process.stdout.write(JSON.stringify({ mode: process.argv[2], version: process.env.TRELIO_HOST_RUNTIME_VERSION, source: process.env.TRELIO_HOST_RUNTIME_SOURCE }));\n",
    "utf8",
  );

  const runtimeVersion = "9.8.7";
  const packageBytes = await buildAgentSkillPackage({
    skillId: "trelio-host-runtime",
    runtimeVersion,
    sourceDirectory,
    entrypointPath: "scripts/trelio-host-runtime-entry.mjs",
    interpreter: "node",
    capabilities: ["local-session", "network"],
  });
  const packageSha256 = createHash("sha256").update(packageBytes).digest("hex");
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const packageSignature = sign(null, packageBytes, privateKey).toString("base64");
  const signingPublicKeySpki = publicKey
    .export({ format: "der", type: "spki" })
    .toString("base64");

  const server = createServer((request, response) => {
    if (request.url?.startsWith("/api/agent-workspaces/host-runtime/current")) {
      const address = server.address();
      assert.ok(address && typeof address !== "string");
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        schemaVersion: 1,
        runtime: {
          artifactId: "runtime-test",
          runtimeVersion,
          minimumRuntimeVersion: runtimeVersion,
          minimumPluginVersion: BRIDGE_VERSION,
          packageSha256,
          packageSizeBytes: packageBytes.byteLength,
          packageUrl: `http://127.0.0.1:${address.port}/runtime.skillpkg`,
          packageSignature,
          signingPublicKeySpki,
          signingKeyId: "test-ed25519",
        },
      }));
      return;
    }
    if (request.url === "/runtime.skillpkg") {
      response.writeHead(200, {
        "content-type": "application/vnd.trelio.agent-skill-package+json",
        "content-length": String(packageBytes.byteLength),
      });
      response.end(packageBytes);
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const environment = {
      ...process.env,
      HOME: temporaryHome,
      USERPROFILE: temporaryHome,
      LOCALAPPDATA: path.join(temporaryHome, "AppData", "Local"),
      TRELIO_ORIGIN: `http://127.0.0.1:${address.port}`,
    };
    const update = await runLoader(["__update"], environment);
    assert.equal(update.code, 0, update.stderr);

    // Foreground startup selects only a fully verified immutable tree. Neither
    // the agent nor the Codex plugin cache participates in this decision.
    const invocation = await runLoader(["mcp"], {
      ...environment,
      TRELIO_HOST_RUNTIME_DISABLE_AUTO_UPDATE: "1",
    });
    assert.equal(invocation.code, 0, invocation.stderr);
    assert.deepEqual(JSON.parse(invocation.stdout), {
      mode: "mcp",
      version: runtimeVersion,
      source: "downloaded",
    });
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (
      error ? reject(error) : resolve()
    )));
    await fs.rm(temporaryHome, { recursive: true, force: true });
    packageBytes.fill(0);
  }
});
