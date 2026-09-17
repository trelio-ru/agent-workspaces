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
  normalizeHostRuntimeDescriptor,
  verifyHostRuntimeSignature,
} from "../plugins/trelio-agent-workspaces/scripts/trelio-host-runtime-loader.mjs";
import {
  PLUGIN_VERSION,
} from "../plugins/trelio-agent-workspaces/scripts/trelio-host-runtime-shell.mjs";

const loaderPath = fileURLToPath(new URL(
  "../plugins/trelio-agent-workspaces/scripts/trelio-host-runtime-loader.mjs",
  import.meta.url,
));
const pluginDirectory = fileURLToPath(new URL(
  "../plugins/trelio-agent-workspaces/",
  import.meta.url,
));

const buildSyntheticHostRuntimePackage = ({ runtimeVersion, source }) => {
  const sourceBytes = Buffer.from(source, "utf8");

  // The plugin owns package verification, so this fixture spells out the public
  // package ABI instead of importing the runtime repository's package builder.
  return Buffer.from(`${JSON.stringify({
    format: "trelio-agent-skill-package/v1",
    skill: {
      id: "trelio-host-runtime",
      runtimeVersion,
    },
    entrypoint: {
      path: "scripts/trelio-host-runtime-entry.mjs",
      interpreter: "node",
    },
    capabilities: ["local-session", "network"],
    files: [{
      path: "scripts/trelio-host-runtime-entry.mjs",
      mode: 0o644,
      sha256: createHash("sha256").update(sourceBytes).digest("hex"),
      contentBase64: sourceBytes.toString("base64"),
    }],
  })}\n`, "utf8");
};

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

test("host runtime descriptor is same-origin, bounded and stable-versioned", () => {
  const descriptor = normalizeHostRuntimeDescriptor({
    schemaVersion: 1,
    runtime: {
      runtimeVersion: "3.4.5",
      minimumRuntimeVersion: "3.4.0",
      minimumPluginVersion: "2.3.1",
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

test("stable plugin shell contains no bundled host runtime fallback", async () => {
  const removedBundledEntrypoint = fileURLToPath(new URL(
    "../plugins/trelio-agent-workspaces/scripts/trelio-host-runtime-entry.mjs",
    import.meta.url,
  ));
  await assert.rejects(fs.access(removedBundledEntrypoint));
});

test("plugin manifests and stable shell keep one version", async () => {
  const [codexManifest, claudeManifest] = await Promise.all([
    fs.readFile(path.join(pluginDirectory, ".codex-plugin", "plugin.json"), "utf8"),
    fs.readFile(path.join(pluginDirectory, ".claude-plugin", "plugin.json"), "utf8"),
  ]).then((sources) => sources.map(JSON.parse));

  assert.equal(codexManifest.version, PLUGIN_VERSION);
  assert.equal(claudeManifest.version, PLUGIN_VERSION);
});

test("host runtime updater verifies, materializes and selects a signed package", async () => {
  const temporaryHome = await fs.mkdtemp(path.join(os.tmpdir(), "trelio-runtime-loader-test-"));
  const runtimeVersion = "9.8.7";
  const packageBytes = buildSyntheticHostRuntimePackage({
    runtimeVersion,
    source: "process.stdout.write(JSON.stringify({ mode: process.argv[2], version: process.env.TRELIO_HOST_RUNTIME_VERSION, source: process.env.TRELIO_HOST_RUNTIME_SOURCE }));\n",
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
          minimumPluginVersion: PLUGIN_VERSION,
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
