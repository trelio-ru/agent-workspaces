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
  resolveWorkspaceBridgeConfigDirectory,
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

test("hook bootstrap failure blocks the protected call", async () => {
  const temporaryHome = await fs.mkdtemp(path.join(os.tmpdir(), "trelio-hook-bootstrap-test-"));
  const server = createServer((_request, response) => response.writeHead(404).end());
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const result = await runLoader(["hook"], {
      ...process.env,
      HOME: temporaryHome,
      USERPROFILE: temporaryHome,
      LOCALAPPDATA: path.join(temporaryHome, "AppData", "Local"),
      TRELIO_ORIGIN: `http://127.0.0.1:${address.port}`,
      TRELIO_HOST_RUNTIME_DISABLE_AUTO_UPDATE: "1",
    });

    // A missing signed runtime must surface as a blocking PreToolUse failure,
    // not as a generic loader error that allows an unsigned MCP request.
    assert.equal(result.code, 2);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /Trelio host runtime loader failed:/u);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (
      error ? reject(error) : resolve()
    )));
    await fs.rm(temporaryHome, { recursive: true, force: true });
  }
});

test("platform Node launcher preserves blocking hook failures", async () => {
  const launcher = path.join(
    pluginDirectory,
    "scripts",
    process.platform === "win32" ? "launch-trelio-node.cmd" : "launch-trelio-node",
  );
  const missingEntrypoint = path.join(os.tmpdir(), "trelio-absent-hook-entrypoint.mjs");
  const command = process.platform === "win32"
    ? process.env.ComSpec || "C:\\Windows\\System32\\cmd.exe"
    : launcher;
  const argumentsList = process.platform === "win32"
    // cmd /s strips the surrounding pair, then evaluates the two quoted
    // absolute paths. Without that outer pair it drops the launcher path.
    ? ["/d", "/s", "/c", `""${launcher}" "${missingEntrypoint}" hook"`]
    : [missingEntrypoint, "hook"];
  const result = await new Promise((resolve, reject) => {
    const child = spawn(command, argumentsList, {
      env: { ...process.env, CODEX_MCP_NODE_PATH: process.execPath },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const stderr = [];
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (code) => resolve({
      code,
      stderr: Buffer.concat(stderr).toString("utf8"),
    }));
  });

  assert.equal(result.code, 2, result.stderr);
  assert.match(result.stderr, /trelio-absent-hook-entrypoint\.mjs/u);
});

test("plugin manifests and stable shell keep one version", async () => {
  const [codexManifest, claudeManifest] = await Promise.all([
    fs.readFile(path.join(pluginDirectory, ".codex-plugin", "plugin.json"), "utf8"),
    fs.readFile(path.join(pluginDirectory, ".claude-plugin", "plugin.json"), "utf8"),
  ]).then((sources) => sources.map(JSON.parse));

  assert.equal(codexManifest.version, PLUGIN_VERSION);
  assert.equal(claudeManifest.version, PLUGIN_VERSION);
});

test("private skill management stays a compact router to the live runtime contract", async () => {
  const source = await fs.readFile(path.join(
    pluginDirectory,
    "skills",
    "trelio-private-skill-management",
    "SKILL.md",
  ), "utf8");

  // Этот bundled слой должен переживать новые execution kinds и package limits
  // без plugin release: изменяемая schema приходит от current runtime tools.
  assert.match(source, /management tools `trelio-remote-skills`/u);
  assert.match(source, /отдельного явного подтверждения/u);
  assert.match(source, /`planId`, `planHash` и `confirmed=true`/u);
  assert.match(source, /не обходи этот контур браузером, прямым HTTP, записью в БД или другим MCP/iu);
  assert.equal(source.includes("executionKind="), false);
  assert.equal(source.includes("MiB"), false);
  assert.equal(source.includes("plan_company_private_agent_skill_create"), false);
  assert.equal(source.includes("publish_company_private_agent_skill_release"), false);
  assert.ok(Buffer.byteLength(source, "utf8") <= 4_000);
});

test("bundled recovery instructions report exact legacy-layout blockers", async () => {
  const [recoveryReference, diagnosticsSkill] = await Promise.all([
    fs.readFile(path.join(
      pluginDirectory,
      "skills",
      "trelio-workspace-worker",
      "references",
      "run-recovery.md",
    ), "utf8"),
    fs.readFile(path.join(
      pluginDirectory,
      "skills",
      "trelio-diagnostics",
      "SKILL.md",
    ), "utf8"),
  ]);

  for (const source of [recoveryReference, diagnosticsSkill]) {
    assert.equal(source.includes("TRELIO_WORKSPACE_LAYOUT_MIGRATION_BLOCKED"), true);
    assert.equal(source.includes("details.rootDirectory"), true);
    assert.equal(source.includes("details.blockingEntries"), true);
    assert.equal(source.includes("automaticChangesPerformed"), true);
  }
  assert.equal(recoveryReference.includes("`workingDirectory`"), true);
});

test("bundled recovery distinguishes a missing active Run from legacy migration", async () => {
  const [recoveryReference, agentSecrets, externalServices] = await Promise.all([
    "run-recovery.md",
    "agent-secrets.md",
    "external-services.md",
  ].map((name) => fs.readFile(path.join(
    pluginDirectory,
    "skills",
    "trelio-workspace-worker",
    "references",
    name,
  ), "utf8")));

  for (const source of [recoveryReference, agentSecrets, externalServices]) {
    assert.equal(source.includes("TRELIO_WORKSPACE_ACTIVE_RUN_REQUIRED"), true);
    assert.equal(source.includes("TRELIO_WORKSPACE_LAYOUT_MIGRATION_BLOCKED"), true);
  }
  assert.match(recoveryReference, /READ_ONLY_INSPECTION/u);
  assert.match(recoveryReference, /prepare_agent_workspace_run/u);
  assert.match(recoveryReference, /returned `open`/u);
  assert.match(recoveryReference, /automaticChangesPerformed=false/u);
});

test("Agent Secret reference routes unified and dedicated discovery through one safe contour", async () => {
  const reference = await fs.readFile(path.join(
    pluginDirectory,
    "skills",
    "trelio-workspace-worker",
    "references",
    "agent-secrets.md",
  ), "utf8");

  assert.match(reference, /`search` и `search_agent_secrets` находят только безопасные metadata/u);
  assert.match(reference, /company-wide по всем доступным company\/project\/task/u);
  assert.match(reference, /не вызывай оба поиска автоматически/u);
  assert.match(reference, /один server-selected контур/u);
  assert.match(reference, /никогда не\s+возвращают value, version или field schema/u);
  assert.match(reference, /После выбора вызови `list_agent_secrets` с exact `scopeType`/u);
  assert.match(reference, /не используй plaintext\s+fallback/u);
  assert.match(reference, /`secretType` принимает `opaque\|password\|api_key\|oauth\|ssh_key\|certificate`/u);
  assert.match(reference, /`reason=unsupported_new_secret_field`/u);
  assert.match(reference, /прежними\s+`templateType`, `fields`, `values` и `clientRequestId`/u);
  assert.match(reference, /Не меняй template или\s+схему полей как обход validation error/u);
});

test("bundled worker delegates native domain workflows to current MCP contracts", async () => {
  const workerDirectory = path.join(pluginDirectory, "skills", "trelio-workspace-worker");
  const worker = await fs.readFile(path.join(workerDirectory, "SKILL.md"), "utf8");
  const references = await fs.readdir(path.join(workerDirectory, "references"));

  assert.match(worker, /следуй актуальным `description` и input schema Trelio\s+MCP/u);
  assert.match(worker, /plugin не дублирует методы, поля и подтверждения/u);
  assert.equal(references.includes("regular-work.md"), false);
});

test("Codex direct-routing recovery retries the same chat before a new-chat fallback", async () => {
  const instructionPaths = [
    path.join(pluginDirectory, "skills", "trelio-diagnostics", "SKILL.md"),
    path.join(pluginDirectory, "skills", "trelio-project-onboarding", "SKILL.md"),
    path.join(pluginDirectory, "README.md"),
    path.join(fileURLToPath(new URL("../", import.meta.url)), "README.md"),
    path.join(fileURLToPath(new URL("../", import.meta.url)), "docs", "plugin-setup-and-policies.md"),
  ];

  for (const instructionPath of instructionPaths) {
    const source = await fs.readFile(instructionPath, "utf8");
    assert.match(
      source,
      /(?:этом\s+же\s+чате|этот\s+же\s+чат)/iu,
      `${instructionPath} must retry the existing chat`,
    );
    assert.match(
      source,
      /новый чат того же проекта нужен\s+только/iu,
      `${instructionPath} must keep a new chat as the fallback`,
    );
  }
});

test("host runtime updater verifies, materializes and selects a signed package", async () => {
  const temporaryHome = await fs.mkdtemp(path.join(os.tmpdir(), "trelio-runtime-loader-test-"));
  const runtimeVersion = "9.8.7";
  const packageBytes = buildSyntheticHostRuntimePackage({
    runtimeVersion,
    source: "process.stdout.write(JSON.stringify({ mode: process.argv[2], version: process.env.TRELIO_HOST_RUNTIME_VERSION }));\n",
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
    const configDirectory = resolveWorkspaceBridgeConfigDirectory({
      platform: process.platform,
      environment,
      homeDirectory: temporaryHome,
    });
    const corruptRuntimeDirectory = path.join(
      configDirectory,
      "host-runtimes",
      runtimeVersion,
      packageSha256,
    );
    await fs.mkdir(corruptRuntimeDirectory, { recursive: true });
    await fs.writeFile(path.join(corruptRuntimeDirectory, "stale-partial-file"), "broken");
    await fs.writeFile(
      path.join(corruptRuntimeDirectory, ".trelio-verified.json"),
      `${JSON.stringify({ runtimeVersion, packageSha256, files: [] })}\n`,
    );

    const update = await runLoader(["__update"], environment);
    assert.equal(update.code, 0, update.stderr);
    await assert.rejects(fs.access(path.join(corruptRuntimeDirectory, "stale-partial-file")));

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
    });
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (
      error ? reject(error) : resolve()
    )));
    await fs.rm(temporaryHome, { recursive: true, force: true });
    packageBytes.fill(0);
  }
});

test("long-lived MCP startup converges before selecting a cached runtime", async () => {
  const temporaryHome = await fs.mkdtemp(path.join(os.tmpdir(), "trelio-runtime-mcp-convergence-test-"));
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const signingPublicKeySpki = publicKey
    .export({ format: "der", type: "spki" })
    .toString("base64");
  const releases = new Map();

  for (const runtimeVersion of ["2.4.6", "3.0.2"]) {
    const packageBytes = buildSyntheticHostRuntimePackage({
      runtimeVersion,
      source: `process.stdout.write(JSON.stringify({ mode: process.argv[2], version: process.env.TRELIO_HOST_RUNTIME_VERSION }));\n`,
    });
    releases.set(runtimeVersion, {
      runtimeVersion,
      packageBytes,
      packageSha256: createHash("sha256").update(packageBytes).digest("hex"),
      packageSignature: sign(null, packageBytes, privateKey).toString("base64"),
    });
  }
  let publishedVersion = "2.4.6";

  const server = createServer((request, response) => {
    const published = releases.get(publishedVersion);
    assert.ok(published);
    if (request.url?.startsWith("/api/agent-workspaces/host-runtime/current")) {
      const address = server.address();
      assert.ok(address && typeof address !== "string");
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        schemaVersion: 1,
        runtime: {
          artifactId: `runtime-${published.runtimeVersion}`,
          runtimeVersion: published.runtimeVersion,
          minimumRuntimeVersion: published.runtimeVersion,
          minimumPluginVersion: PLUGIN_VERSION,
          packageSha256: published.packageSha256,
          packageSizeBytes: published.packageBytes.byteLength,
          packageUrl: `http://127.0.0.1:${address.port}/${published.runtimeVersion}.skillpkg`,
          packageSignature: published.packageSignature,
          signingPublicKeySpki,
        },
      }));
      return;
    }
    const requested = [...releases.values()].find((release) => (
      request.url === `/${release.runtimeVersion}.skillpkg`
    ));
    if (requested) {
      response.writeHead(200, {
        "content-type": "application/vnd.trelio.agent-skill-package+json",
        "content-length": String(requested.packageBytes.byteLength),
      });
      response.end(requested.packageBytes);
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

    // First materialize the old runtime and its future update throttle. This
    // reproduces the affected Macs: current.json is valid, so the previous
    // loader opened a persistent MCP on 2.4.6 before its detached updater ran.
    const initialUpdate = await runLoader(["__update"], environment);
    assert.equal(initialUpdate.code, 0, initialUpdate.stderr);
    publishedVersion = "3.0.2";

    const invocation = await runLoader(["mcp"], environment);
    assert.equal(invocation.code, 0, invocation.stderr);
    assert.deepEqual(JSON.parse(invocation.stdout), {
      mode: "mcp",
      version: "3.0.2",
    });
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (
      error ? reject(error) : resolve()
    )));
    await fs.rm(temporaryHome, { recursive: true, force: true });
    for (const release of releases.values()) release.packageBytes.fill(0);
  }
});
