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

test("unified discovery bootstrap avoids a second catalog call and retains old-server compatibility", async () => {
  const catalog = await fs.readFile(path.join(pluginDirectory, "skills/trelio-skill-catalog/SKILL.md"), "utf8");
  const context = await fs.readFile(path.join(pluginDirectory, "skills/trelio-workspace-worker/references/scope-and-context.md"), "utf8");
  assert.match(catalog, /единый `search`/u);
  assert.match(catalog, /После `guidance.status=searched` не вызывай `search_agent_guidance`/u);
  assert.match(catalog, /старый ответ вообще не содержит `guidance`/u);
  assert.match(catalog, /трёх коротких совпадений/u);
  assert.match(context, /лимит материалов независим/u);
  assert.match(catalog, /`unavailable`\/ошибка не означают отсутствия навыка/u);
});

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

const runLoader = async (argumentsList, environment, { timeout = 0, scriptPath = loaderPath } = {}) => await new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [scriptPath, ...argumentsList], {
    env: environment,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    timeout,
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

test("loader runs through a plugin directory alias instead of silently succeeding", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "trelio-loader-alias-"));
  const alias = path.join(home, "plugin");
  const server = createServer((_request, response) => response.writeHead(404).end());
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    // A directory junction needs no administrative symlink privilege on Windows.
    // Only the parent is aliased; the shell and package files remain unchanged.
    await fs.symlink(pluginDirectory, alias, process.platform === "win32" ? "junction" : "dir");
    const environment = {
      ...process.env, HOME: home, USERPROFILE: home,
      LOCALAPPDATA: path.join(home, "AppData", "Local"),
      TRELIO_ORIGIN: `http://127.0.0.1:${server.address().port}`,
      TRELIO_HOST_RUNTIME_DISABLE_AUTO_UPDATE: "1",
    };
    const scriptPath = path.join(alias, "scripts/trelio-host-runtime-loader.mjs");
    const result = await runLoader(["hook"], environment, { scriptPath, timeout: 5_000 });
    assert.equal(result.code, 2, "The real loader must report a blocking bootstrap failure");
    assert.match(result.stderr, /Trelio host runtime loader failed:/u);
    const invalidMode = await runLoader(["invalid-mode"], environment, { scriptPath, timeout: 5_000 });
    assert.equal(invalidMode.code, 1);
    assert.match(invalidMode.stderr, /bridge, hook или mcp/u);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(home, { recursive: true, force: true });
  }
});

test("platform Node launcher preserves blocking hook failures", async () => {
  const launcher = path.join(
    pluginDirectory,
    "scripts",
    process.platform === "win32" ? "launch-trelio-node.cmd" : "launch-trelio-node",
  );
  const missingEntrypoint = path.join(os.tmpdir(), "trelio-absent-hook-entrypoint.mjs");
  const windowsPowerShell = path.join(
    process.env.SystemRoot || "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  const command = process.platform === "win32"
    ? windowsPowerShell
    : launcher;
  const argumentsList = process.platform === "win32"
    // Use the same PowerShell-to-cmd entrypoint as commandWindows. Encoding
    // avoids cmd /s rewriting the quotes before the launcher even starts.
    ? [
      "-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand",
      Buffer.from(
        `& '${launcher.replaceAll("'", "''")}' '${missingEntrypoint.replaceAll("'", "''")}' hook; exit $LASTEXITCODE`,
        "utf16le",
      ).toString("base64"),
    ]
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
  const [codexManifest, claudeManifest, cursorManifest] = await Promise.all([
    fs.readFile(path.join(pluginDirectory, ".codex-plugin", "plugin.json"), "utf8"),
    fs.readFile(path.join(pluginDirectory, ".claude-plugin", "plugin.json"), "utf8"),
    fs.readFile(path.join(pluginDirectory, ".cursor-plugin", "plugin.json"), "utf8"),
  ]).then((sources) => sources.map(JSON.parse));

  assert.equal(codexManifest.version, PLUGIN_VERSION);
  assert.equal(claudeManifest.version, PLUGIN_VERSION);
  assert.equal(cursorManifest.version, PLUGIN_VERSION);
  const marketplace = JSON.parse(await fs.readFile(new URL("../.claude-plugin/marketplace.json", import.meta.url), "utf8"));
  assert.equal(marketplace.plugins.find((entry) => entry.name === "trelio-agent-workspaces").version, PLUGIN_VERSION);
  const cursorMarketplace = JSON.parse(await fs.readFile(new URL("../.cursor-plugin/marketplace.json", import.meta.url), "utf8"));
  const entry = cursorMarketplace.plugins.find((item) => item.name === "trelio-agent-workspaces");
  assert.equal(entry.version, PLUGIN_VERSION);
  assert.equal(path.resolve(pluginDirectory, "../../", entry.source), path.resolve(pluginDirectory));
});

test("Cursor native manifest isolates OAuth and suppresses incompatible hook discovery", async () => {
  const manifest = JSON.parse(await fs.readFile(path.join(pluginDirectory, ".cursor-plugin/plugin.json"), "utf8"));
  const cursorMcp = JSON.parse(await fs.readFile(path.join(pluginDirectory, manifest.mcpServers), "utf8"));
  const claudeMcp = JSON.parse(await fs.readFile(path.join(pluginDirectory, ".mcp.json"), "utf8"));
  const codex = JSON.parse(await fs.readFile(path.join(pluginDirectory, ".codex-plugin/plugin.json"), "utf8"));
  // A new client-specific manifest is shell-owned: server/runtime updates
  // cannot select Cursor's native auth keys or prevent default hook discovery.
  assert.deepEqual(manifest.hooks, { hooks: {} });
  assert.equal(cursorMcp.mcpServers.trelio.auth.CLIENT_ID, "trelio_cursor_agent_workspaces_v1");
  assert.equal(cursorMcp.mcpServers.trelio.url, codex.mcpServers.trelio.url);
  assert.equal(cursorMcp.mcpServers.trelio.auth.scopes, undefined);
  assert.equal(cursorMcp.mcpServers.trelio.auth.CLIENT_SECRET, undefined);
  assert.equal(codex.mcpServers.trelio.oauth.clientId, "trelio_agent_workspaces_v1");
  assert.equal(claudeMcp.mcpServers.trelio.oauth.clientId, "trelio_agent_workspaces_v1");
  const local = cursorMcp.mcpServers["trelio-remote-skills"];
  assert.equal(local.command, "${CURSOR_PLUGIN_ROOT}/scripts/launch-trelio-node");
  assert.deepEqual(local.args, ["${CURSOR_PLUGIN_ROOT}/scripts/trelio-host-runtime-loader.mjs", "mcp"]);
  assert.equal(local.cwd, "${CURSOR_PLUGIN_ROOT}");
  const validatePath = (relative) => {
    assert.equal(path.isAbsolute(relative), false);
    assert.equal(relative.split("/").includes(".."), false);
    return path.join(pluginDirectory, relative);
  };
  for (const directory of manifest.skills) {
    await fs.access(path.join(validatePath(directory), "SKILL.md"));
    assert.doesNotMatch(directory, /diagnostics|onboarding/u);
  }
  await fs.access(validatePath(manifest.mcpServers));
  const rule = await fs.readFile(validatePath(manifest.rules), "utf8");
  assert.ok(Buffer.byteLength(rule, "utf8") < 4096, "Cursor bootstrap must stay a small host adapter");
  assert.match(rule, /alwaysApply: true/u);
  assert.match(rule, /не выдавай Cursor за другой клиент/u);
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

  let packageRequests = 0;
  let invalidPackage = false;
  const server = createServer((request, response) => {
    if (request.url?.startsWith("/api/agent-workspaces/host-runtime/current")) {
      const address = server.address();
      assert.ok(address && typeof address !== "string");
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        schemaVersion: 1,
        runtime: {
          artifactId: "runtime-test",
          runtimeVersion: invalidPackage ? "9.8.8" : runtimeVersion,
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
      packageRequests += 1;
      if (packageRequests <= 3) {
        // Реальный reset ПОСЛЕ headers должен повторять полный GET, а не
        // оставлять частичный package или переключать current.json.
        response.write(packageBytes.subarray(0, 20));
        setTimeout(() => response.destroy(), 20);
      } else if (invalidPackage) {
        const corrupted = Buffer.from(packageBytes);
        corrupted[corrupted.length - 1] ^= 1;
        response.end(corrupted);
      } else {
        response.end(packageBytes);
      }
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
    assert.equal(packageRequests, 4);
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

    // A verified package may outlive a lost current.json after an interrupted
    // update. Foreground bootstrap must restore the pointer before selecting
    // that same immutable package; successful HTTP responses are insufficient.
    await fs.unlink(path.join(configDirectory, "host-runtimes", "current.json"));
    const recovered = await runLoader(["mcp"], {
      ...environment,
      TRELIO_HOST_RUNTIME_DISABLE_AUTO_UPDATE: "1",
    });
    assert.equal(recovered.code, 0, recovered.stderr);
    assert.deepEqual(JSON.parse(recovered.stdout), {
      mode: "mcp",
      version: runtimeVersion,
    });

    // Signature failure не относится к transport retry. Старый проверенный
    // runtime остаётся выбранным, lock освобождается, новое дерево не появляется.
    invalidPackage = true;
    const beforeFailureRequests = packageRequests;
    const failed = await runLoader(["__update"], environment);
    assert.equal(failed.code, 1);
    assert.match(failed.stderr, /signature verification/u);
    assert.equal(packageRequests, beforeFailureRequests + 1);
    const pointer = JSON.parse(await fs.readFile(path.join(configDirectory, "host-runtimes", "current.json"), "utf8"));
    assert.equal(pointer.runtimeVersion, runtimeVersion);
    await assert.rejects(fs.access(path.join(configDirectory, "host-runtimes", "9.8.8")));
    await assert.rejects(fs.access(path.join(configDirectory, "host-runtimes", "update.lock")));
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (
      error ? reject(error) : resolve()
    )));
    await fs.rm(temporaryHome, { recursive: true, force: true });
    packageBytes.fill(0);
  }
});

// Это regression именно stable shell: lock и HTTP возникают ДО запуска
// signed entrypoint, поэтому исправление внутри host runtime сюда не дойдёт.
// Каждая fixture использует отдельный cache и synthetic Ed25519 package;
// реальные установки, credentials и сервер Trelio в проверке не участвуют.
const createMcpStartupFixture = async () => {
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
  const behavior = { stallMetadata: false, packageDelayMs: 0 };
  const requests = { metadata: 0, package: 0 };
  const timers = new Set();

  const server = createServer((request, response) => {
    const published = releases.get(publishedVersion);
    assert.ok(published);
    if (request.url?.startsWith("/api/agent-workspaces/host-runtime/current")) {
      requests.metadata += 1;
      if (behavior.stallMetadata) return;
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
      requests.package += 1;
      const timer = setTimeout(() => {
        timers.delete(timer);
        response.writeHead(200, {
          "content-type": "application/vnd.trelio.agent-skill-package+json",
          "content-length": String(requested.packageBytes.byteLength),
        });
        response.end(requested.packageBytes);
      }, behavior.packageDelayMs);
      timers.add(timer);
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const environment = {
    ...process.env,
    HOME: temporaryHome,
    USERPROFILE: temporaryHome,
    LOCALAPPDATA: path.join(temporaryHome, "AppData", "Local"),
    TRELIO_ORIGIN: `http://127.0.0.1:${address.port}`,
    // A developer's shell must not silently disable the behavior under test.
    TRELIO_HOST_RUNTIME_DISABLE_AUTO_UPDATE: "0",
  };
  const configDirectory = resolveWorkspaceBridgeConfigDirectory({
    platform: process.platform,
    environment,
    homeDirectory: temporaryHome,
  });
  const runtimeRoot = path.join(configDirectory, "host-runtimes");
  const lockPath = path.join(runtimeRoot, "update.lock");

  return {
    environment, runtimeRoot, lockPath, behavior, requests,
    publish: (version) => { publishedVersion = version; },
    bootstrap: async () => {
      const result = await runLoader(["__update"], environment, { timeout: 10_000 });
      assert.equal(result.code, 0, result.stderr);
    },
    holdLock: async () => {
      await fs.mkdir(lockPath, { recursive: true });
      await fs.writeFile(path.join(lockPath, "owner"), "another updater");
    },
    close: async () => {
      for (const timer of timers) clearTimeout(timer);
      // Stalled responses deliberately never end; abort them before close so
      // a failed assertion cannot leave the suite waiting on a synthetic peer.
      const closed = new Promise((resolve, reject) => server.close((error) => (
        error ? reject(error) : resolve()
      )));
      server.closeAllConnections();
      await closed;
      await fs.rm(temporaryHome, { recursive: true, force: true });
      for (const release of releases.values()) release.packageBytes.fill(0);
    },
  };
};

test("long-lived MCP startup converges before selecting a cached runtime", async () => {
  const fixture = await createMcpStartupFixture();
  try {
    // First materialize the old runtime and its future update throttle. This
    // reproduces the affected Macs: current.json is valid, so the previous
    // loader opened a persistent MCP on 2.4.6 before its detached updater ran.
    await fixture.bootstrap();
    fixture.publish("3.0.2");

    const invocation = await runLoader(["mcp"], fixture.environment);
    assert.equal(invocation.code, 0, invocation.stderr);
    assert.deepEqual(JSON.parse(invocation.stdout), {
      mode: "mcp",
      version: "3.0.2",
    });
  } finally {
    await fixture.close();
  }
});

test("MCP startup shares one deadline across lock wait, retries and first bootstrap", { concurrency: true }, async (t) => {
  // Реальные процессы и реальные 20 секунд проверяют production timeout без
  // test-only override в loader. Сценарии независимы и идут одновременно.
  // Внешние 28 секунд убивают старый 90-секундный путь до client handshake
  // timeout (30 секунд), оставляя запас на spawn и CI scheduling.
  await Promise.all([
    t.test("cached runtime survives a busy lock without stealing it", async () => {
      const fixture = await createMcpStartupFixture();
      try {
        await fixture.bootstrap();
        const statePath = path.join(fixture.runtimeRoot, "update-state.json");
        const previousState = await fs.readFile(statePath, "utf8");
        await fixture.holdLock();
        const invocation = await runLoader(["mcp"], fixture.environment, { timeout: 28_000 });
        assert.equal(invocation.code, 0, `${invocation.signal}: ${invocation.stderr}`);
        assert.deepEqual(JSON.parse(invocation.stdout), { mode: "mcp", version: "2.4.6" });
        assert.equal(fixture.requests.metadata, 1, "no HTTP request before acquiring the lock");
        assert.equal(await fs.readFile(statePath, "utf8"), previousState);
        assert.equal(await fs.readFile(path.join(fixture.lockPath, "owner"), "utf8"), "another updater");
      } finally {
        await fixture.close();
      }
    }),
    t.test("first install fails closed within the same budget when no runtime exists", async () => {
      const fixture = await createMcpStartupFixture();
      try {
        await fixture.holdLock();
        const invocation = await runLoader(["mcp"], fixture.environment, { timeout: 28_000 });
        assert.equal(invocation.code, 1, `${invocation.signal}: ${invocation.stderr}`);
        assert.equal(invocation.stdout, "");
        const diagnostic = JSON.parse(invocation.stderr.trim().replace(/^Trelio host runtime loader failed: /u, ""));
        assert.deepEqual(diagnostic, {
          code: "TRELIO_HOST_RUNTIME_UPDATE_FAILED",
          operation: "host_runtime_update",
          reason: "timeout",
          stage: "update_lock",
          timeoutKind: "total",
          timeoutMs: 20_000,
        });
        assert.equal(fixture.requests.metadata, 0);
        assert.equal(await fs.readFile(path.join(fixture.lockPath, "owner"), "utf8"), "another updater");
        await assert.rejects(fs.access(path.join(fixture.runtimeRoot, "current.json")));
      } finally {
        await fixture.close();
      }
    }),
    t.test("network retries consume only the time left after lock acquisition", async () => {
      const fixture = await createMcpStartupFixture();
      try {
        await fixture.bootstrap();
        fixture.behavior.stallMetadata = true;
        await fixture.holdLock();
        const startedAt = performance.now();
        const invocationPromise = runLoader(["mcp"], fixture.environment, { timeout: 28_000 });
        // Старое поведение получало бы новый network budget после 12 секунд
        // ожидания и не успевало бы до внешнего timeout. Новый путь успевает
        // повторить безопасный GET, но не продлевает общий срок.
        await new Promise((resolve) => setTimeout(resolve, 12_000));
        await fs.rm(fixture.lockPath, { recursive: true });
        const invocation = await invocationPromise;
        assert.equal(invocation.code, 0, `${invocation.signal}: ${invocation.stderr}`);
        assert.ok(performance.now() - startedAt < 28_000);
        assert.deepEqual(JSON.parse(invocation.stdout), { mode: "mcp", version: "2.4.6" });
        assert.ok(fixture.requests.metadata >= 3, "bootstrap plus at least one foreground retry");
        assert.ok(fixture.requests.metadata <= 5, "at most three retries");
        await assert.rejects(fs.access(fixture.lockPath));
      } finally {
        await fixture.close();
      }
    }),
    t.test("timeout rechecks a verified pointer published by another updater", async () => {
      const fixture = await createMcpStartupFixture();
      try {
        await fixture.bootstrap();
        const pointerPath = path.join(fixture.runtimeRoot, "current.json");
        const previousPointer = await fs.readFile(pointerPath, "utf8");
        fixture.publish("3.0.2");
        await fixture.bootstrap();
        const nextPointer = await fs.readFile(pointerPath, "utf8");
        await fs.writeFile(pointerPath, previousPointer);
        await fixture.holdLock();
        const invocationPromise = runLoader(["mcp"], fixture.environment, { timeout: 28_000 });
        await new Promise((resolve) => setTimeout(resolve, 5_000));
        // Публикация нового verified pointer не означает, что сосед уже успел
        // освободить lock. На timeout запускаем новый проверенный runtime.
        const temporaryPointer = `${pointerPath}.next`;
        await fs.writeFile(temporaryPointer, nextPointer);
        await fs.rename(temporaryPointer, pointerPath);
        const invocation = await invocationPromise;
        assert.equal(invocation.code, 0, `${invocation.signal}: ${invocation.stderr}`);
        assert.deepEqual(JSON.parse(invocation.stdout), { mode: "mcp", version: "3.0.2" });
        assert.equal(fixture.requests.metadata, 2);
        assert.equal(await fs.readFile(path.join(fixture.lockPath, "owner"), "utf8"), "another updater");
      } finally {
        await fixture.close();
      }
    }),
  ]);
});

test("concurrent MCP startups share one signed package and all select the new runtime", async () => {
  const fixture = await createMcpStartupFixture();
  try {
    await fixture.bootstrap();
    fixture.publish("3.0.2");
    fixture.behavior.packageDelayMs = 500;
    const invocations = await Promise.all(Array.from({ length: 4 }, () => (
      runLoader(["mcp"], fixture.environment, { timeout: 10_000 })
    )));
    for (const invocation of invocations) {
      assert.equal(invocation.code, 0, `${invocation.signal}: ${invocation.stderr}`);
      assert.deepEqual(JSON.parse(invocation.stdout), { mode: "mcp", version: "3.0.2" });
    }
    assert.equal(fixture.requests.package, 2, "one initial and one new signed package");
    await assert.rejects(fs.access(fixture.lockPath));
    assert.equal((await fs.readdir(fixture.runtimeRoot)).some((name) => name.endsWith(".tmp")), false);
  } finally {
    await fixture.close();
  }
});
