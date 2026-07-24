import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  BRIDGE_VERSION,
  buildRunContextSpecifications,
  buildBridgeRequestHeaders,
  inspectWorkspaceFile,
  isProtectedWorkspaceControlPath,
  parseWorkspaceObjectPointer,
} from "../scripts/trelio-workspace.mjs";

const execFileAsync = promisify(execFile);
const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const pluginDirectory = path.resolve(testDirectory, "..");
const bridgePath = path.resolve(testDirectory, "../scripts/trelio-workspace.mjs");
const runId = "11111111-1111-4111-8111-111111111111";
const companyWorkspaceId = "22222222-2222-4222-8222-222222222222";
const relatedWorkspaceId = "33333333-3333-4333-8333-333333333333";
const companyHead = "a".repeat(40);
const relatedHead = "b".repeat(40);

const runGit = (workingDirectory, args, options = {}) => execFileAsync(
  "git",
  ["-c", "core.hooksPath=/dev/null", "-c", "init.templateDir=", ...args],
  {
    cwd: workingDirectory,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
    },
    ...options,
  },
);

const readRequestBody = async (request) => {
  const chunks = [];

  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return Buffer.concat(chunks);
};

const writeTestCredential = async (homeDirectory, origin) => {
  const credentialDirectory = path.join(
    homeDirectory,
    ".config",
    "trelio",
    "workspace-bridge",
  );
  await mkdir(credentialDirectory, { recursive: true });
  await writeFile(
    path.join(credentialDirectory, "credentials.json"),
    `${JSON.stringify({ [origin]: { accessToken: "integration-token" } }, null, 2)}\n`,
    { mode: 0o600 },
  );
};

const createExportBundle = async (temporaryDirectory, files) => {
  const repositoryDirectory = path.join(temporaryDirectory, "repository");
  const bundlePath = path.join(temporaryDirectory, "workspace.bundle");
  await mkdir(repositoryDirectory, { recursive: true });
  await runGit(repositoryDirectory, ["init", "--initial-branch=main"]);
  await runGit(repositoryDirectory, ["config", "user.name", "Trelio Bridge Test"]);
  await runGit(repositoryDirectory, ["config", "user.email", "bridge-test@trelio.local"]);

  for (const [relativePath, contents] of Object.entries(files)) {
    const filePath = path.join(repositoryDirectory, relativePath);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, contents);
  }

  await runGit(repositoryDirectory, ["add", "--all"]);
  await runGit(repositoryDirectory, ["commit", "-m", "Test workspace"]);
  const head = (await runGit(repositoryDirectory, ["rev-parse", "HEAD"])).stdout.trim();
  await runGit(repositoryDirectory, ["update-ref", `refs/trelio/exports/${head}`, head]);
  await runGit(repositoryDirectory, [
    "bundle",
    "create",
    bundlePath,
    `refs/trelio/exports/${head}`,
  ]);

  return { bundle: await readFile(bundlePath), head };
};

const pathExists = async (filePath) => {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
};

test("bridge maps parent and related contexts to stable read-only paths", () => {
  const contexts = buildRunContextSpecifications(runId, {
    company: { workspaceId: companyWorkspaceId, head: companyHead },
    related: [{
      workspaceId: relatedWorkspaceId,
      head: relatedHead,
      scopeType: "task",
      scopeKey: "task:with/slash",
    }],
  });

  assert.equal(contexts.length, 2);
  assert.deepEqual(contexts.map((context) => context.dependencyKind), ["company", "related"]);
  assert.equal(contexts[0].relativeDirectory, path.join("context", "company"));
  assert.equal(
    contexts[1].relativeDirectory,
    path.join("context", "related", relatedWorkspaceId),
    "untrusted scopeKey must not become a local path segment",
  );
  assert.equal(
    contexts[1].endpoint,
    `/api/agent-workspaces/runs/${runId}/context/related/${relatedWorkspaceId}/bundle`,
  );
});

test("bridge rejects duplicate workspace ids and malformed pinned heads", () => {
  assert.throws(() => buildRunContextSpecifications(runId, {
    company: { workspaceId: companyWorkspaceId, head: companyHead },
    related: [{ workspaceId: companyWorkspaceId, head: relatedHead, scopeType: "company" }],
  }), /повторяется/);
  assert.throws(() => buildRunContextSpecifications(runId, {
    related: [{ workspaceId: relatedWorkspaceId, head: "main", scopeType: "task" }],
  }), /Git head/);
});

test("bridge open keeps a large parent context pointer-first and downloads zero object bytes", {
  timeout: 15_000,
}, async () => {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "trelio-bridge-lazy-open-"));
  const homeDirectory = path.join(temporaryDirectory, "home");
  const rootDirectory = path.join(temporaryDirectory, "materialized-run");
  const writableWorkspaceId = "44444444-4444-4444-8444-444444444444";
  const largeDigest = "d".repeat(64);
  const largePointer = [
    "version https://trelio.ru/spec/workspace-object/v1",
    `oid sha256:${largeDigest}`,
    `size ${757 * 1024 * 1024}`,
    "content-type application/pdf",
    "",
  ].join("\n");
  const [baseExport, companyExport] = await Promise.all([
    createExportBundle(path.join(temporaryDirectory, "base"), {
      "AGENTS.md": "# Test rules\n",
      "CLAUDE.md": "@AGENTS.md\n",
      "PROJECT_CONTEXT.md": "# Task context\n",
    }),
    createExportBundle(path.join(temporaryDirectory, "company"), {
      "PROJECT_CONTEXT.md": "# Company context\n",
      "sources/large-parent.pdf": largePointer,
    }),
  ]);
  const seenUrls = [];
  let serverError = null;

  const server = createServer(async (request, response) => {
    try {
      seenUrls.push(request.url || "");
      assert.equal(request.headers["x-trelio-agent-workspaces-version"], BRIDGE_VERSION);
      assert.equal(request.headers.authorization, "Bearer integration-token");

      if (request.url === "/api/agent-workspaces/bridge-compatibility") {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ supported: true, minimumVersion: BRIDGE_VERSION }));
        return;
      }

      if (
        request.method === "POST"
        && request.url === `/api/agent-workspaces/workspaces/${writableWorkspaceId}/runs`
      ) {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({
          run: {
            id: runId,
            leaseId: "55555555-5555-4555-8555-555555555555",
            fencingToken: 1,
            baseHead: baseExport.head,
            contextHeadsJson: {
              company: {
                workspaceId: companyWorkspaceId,
                head: companyExport.head,
                scopeType: "company",
                scopeKey: "company",
              },
            },
            agentInstructionsSnapshotJson: {
              schemaVersion: 1,
              company: null,
              project: null,
              compiledMarkdown: "# Рабочие правила агентов Trelio\n",
            },
          },
          workspace: { id: writableWorkspaceId },
        }));
        return;
      }

      if (request.url === `/api/agent-workspaces/runs/${runId}/bundle`) {
        response.setHeader("content-type", "application/octet-stream");
        response.end(baseExport.bundle);
        return;
      }

      if (request.url === `/api/agent-workspaces/runs/${runId}/context/company/bundle`) {
        response.setHeader("content-type", "application/octet-stream");
        response.end(companyExport.bundle);
        return;
      }

      if (request.url?.includes("/objects/") || request.url?.includes("/context-objects/")) {
        throw new Error(`open must not request external object bytes: ${request.url}`);
      }

      response.statusCode = 404;
      response.end();
    } catch (error) {
      serverError = error;
      response.statusCode = 500;
      response.end(error instanceof Error ? error.message : String(error));
    }
  });

  try {
    await mkdir(homeDirectory, { recursive: true });
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const serverAddress = server.address();
    assert.ok(serverAddress && typeof serverAddress === "object");
    const origin = `http://127.0.0.1:${serverAddress.port}`;
    await writeTestCredential(homeDirectory, origin);

    const opened = await execFileAsync(
      process.execPath,
      [
        bridgePath,
        "open",
        "--origin",
        origin,
        "--workspace",
        writableWorkspaceId,
        "--dir",
        rootDirectory,
      ],
      {
        cwd: temporaryDirectory,
        encoding: "utf8",
        timeout: 10_000,
        env: { ...process.env, HOME: homeDirectory },
      },
    );

    assert.equal(opened.stdout.trim(), path.join(rootDirectory, "workspace"));
    assert.equal(
      await readFile(
        path.join(rootDirectory, "context", "company", "sources", "large-parent.pdf"),
        "utf8",
      ),
      largePointer,
    );
    assert.equal(
      seenUrls.filter((url) => url.includes("/objects/") || url.includes("/context-objects/")).length,
      0,
    );
    assert.ifError(serverError);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    if (process.platform !== "win32") {
      await execFileAsync("chmod", ["-R", "u+w", temporaryDirectory]).catch(() => undefined);
    }
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test("context fetch downloads one exact path, reuses verified cache and rejects tampered cache", {
  timeout: 15_000,
}, async () => {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "trelio-bridge-context-fetch-"));
  const homeDirectory = path.join(temporaryDirectory, "home");
  const objectBytes = Buffer.from("exact lazy workspace object bytes", "utf8");
  const objectDigest = createHash("sha256").update(objectBytes).digest("hex");
  const pointer = [
    "version https://trelio.ru/spec/workspace-object/v1",
    `oid sha256:${objectDigest}`,
    `size ${objectBytes.byteLength}`,
    "content-type application/octet-stream",
    "",
  ].join("\n");
  const runIds = [
    runId,
    "66666666-6666-4666-8666-666666666666",
    "77777777-7777-4777-8777-777777777777",
  ];
  let authorizationRequests = 0;
  let objectDownloads = 0;
  let serverError = null;

  const server = createServer(async (request, response) => {
    try {
      if (request.url?.startsWith("/api/agent-workspaces/runs/")) {
        authorizationRequests += 1;
        const url = new URL(request.url, "http://127.0.0.1");
        assert.equal(url.searchParams.get("head"), companyHead);
        assert.equal(url.searchParams.get("path"), "sources/exact.bin");
        assert.equal(url.searchParams.get("sha256"), objectDigest);
        assert.equal(url.searchParams.get("sizeBytes"), String(objectBytes.byteLength));
        assert.match(
          url.pathname,
          new RegExp(`/context-objects/${companyWorkspaceId}$`),
        );
        const address = server.address();
        assert.ok(address && typeof address === "object");
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({
          workspaceId: companyWorkspaceId,
          workspaceHead: companyHead,
          filePath: "sources/exact.bin",
          sha256: objectDigest,
          sizeBytes: objectBytes.byteLength,
          contentType: "application/octet-stream",
          url: `http://127.0.0.1:${address.port}/signed-object`,
        }));
        return;
      }

      if (request.url === "/signed-object") {
        objectDownloads += 1;
        response.setHeader("content-type", "application/octet-stream");
        response.end(objectBytes);
        return;
      }

      response.statusCode = 404;
      response.end();
    } catch (error) {
      serverError = error;
      response.statusCode = 500;
      response.end(error instanceof Error ? error.message : String(error));
    }
  });

  const createMaterializedRun = async (origin, currentRunId, suffix) => {
    const rootDirectory = path.join(temporaryDirectory, `run-${suffix}`);
    const workspaceDirectory = path.join(rootDirectory, "workspace");
    const contextDirectory = path.join(rootDirectory, "context", "company");
    const objectPath = path.join(contextDirectory, "sources", "exact.bin");
    await mkdir(workspaceDirectory, { recursive: true });
    await mkdir(path.dirname(objectPath), { recursive: true });
    await writeFile(objectPath, pointer, "utf8");
    await writeFile(
      path.join(rootDirectory, ".trelio-run.json"),
      `${JSON.stringify({
        schemaVersion: 3,
        origin,
        pluginVersion: BRIDGE_VERSION,
        workspaceId: "44444444-4444-4444-8444-444444444444",
        runId: currentRunId,
        workspaceDirectory,
        contexts: [{
          dependencyKind: "company",
          workspaceId: companyWorkspaceId,
          head: companyHead,
          directory: contextDirectory,
        }],
        objects: [],
      }, null, 2)}\n`,
      { mode: 0o600 },
    );
    return { rootDirectory, workspaceDirectory, objectPath };
  };

  try {
    await mkdir(homeDirectory, { recursive: true });
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const serverAddress = server.address();
    assert.ok(serverAddress && typeof serverAddress === "object");
    const origin = `http://127.0.0.1:${serverAddress.port}`;
    await writeTestCredential(homeDirectory, origin);

    const firstRun = await createMaterializedRun(origin, runIds[0], "first");
    const firstFetch = await execFileAsync(
      process.execPath,
      [bridgePath, "context", "fetch", "--path", firstRun.objectPath],
      {
        cwd: firstRun.rootDirectory,
        encoding: "utf8",
        env: { ...process.env, HOME: homeDirectory },
      },
    );
    assert.match(firstFetch.stdout, /Trelio object storage/);
    assert.deepEqual(await readFile(firstRun.objectPath), objectBytes);
    assert.equal(authorizationRequests, 1);
    assert.equal(objectDownloads, 1);

    const secondRun = await createMaterializedRun(origin, runIds[1], "second");
    const secondFetch = await execFileAsync(
      process.execPath,
      [bridgePath, "context", "fetch", "--path", secondRun.objectPath],
      {
        cwd: secondRun.rootDirectory,
        encoding: "utf8",
        env: { ...process.env, HOME: homeDirectory },
      },
    );
    assert.match(secondFetch.stdout, /локальный cache/);
    assert.deepEqual(await readFile(secondRun.objectPath), objectBytes);
    assert.equal(authorizationRequests, 2, "every Run still requires exact backend authorization");
    assert.equal(objectDownloads, 1, "the second Run must not redownload verified bytes");

    const cachePath = path.join(
      homeDirectory,
      ".cache",
      "trelio",
      "workspace-bridge",
      "objects",
      objectDigest.slice(0, 2),
      objectDigest,
    );
    await writeFile(cachePath, Buffer.alloc(objectBytes.byteLength, 0x78));
    const thirdRun = await createMaterializedRun(origin, runIds[2], "third");
    const thirdFetch = await execFileAsync(
      process.execPath,
      [bridgePath, "context", "fetch", "--path", thirdRun.objectPath],
      {
        cwd: thirdRun.rootDirectory,
        encoding: "utf8",
        env: { ...process.env, HOME: homeDirectory },
      },
    );
    assert.match(thirdFetch.stdout, /Trelio object storage/);
    assert.deepEqual(await readFile(thirdRun.objectPath), objectBytes);
    assert.equal(authorizationRequests, 3);
    assert.equal(objectDownloads, 2, "tampered cache bytes must be discarded and downloaded again");
    assert.ifError(serverError);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    if (process.platform !== "win32") {
      await execFileAsync("chmod", ["-R", "u+w", temporaryDirectory]).catch(() => undefined);
    }
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test("clean lists exact reclaimable roots and never removes active, unknown or dirty Runs", {
  timeout: 15_000,
}, async () => {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "trelio-bridge-clean-"));
  const homeDirectory = path.join(temporaryDirectory, "home");
  const configDirectory = path.join(homeDirectory, ".config", "trelio", "workspace-bridge");
  const workspaceId = "44444444-4444-4444-8444-444444444444";
  const acceptedRunId = runId;
  const dirtyRunId = "66666666-6666-4666-8666-666666666666";
  const activeRunId = "77777777-7777-4777-8777-777777777777";
  const unknownRunId = "88888888-8888-4888-8888-888888888888";
  const roots = new Map();
  let serverError = null;

  const createLocalRunRoot = async (origin, name, currentRunId, dirty = false) => {
    const rootDirectory = path.join(temporaryDirectory, name);
    const workspaceDirectory = path.join(rootDirectory, "workspace");
    await mkdir(workspaceDirectory, { recursive: true });
    await runGit(workspaceDirectory, ["init", "--initial-branch=trelio-candidate"]);
    await runGit(workspaceDirectory, ["config", "user.name", "Trelio Bridge Test"]);
    await runGit(workspaceDirectory, ["config", "user.email", "bridge-test@trelio.local"]);
    await writeFile(path.join(workspaceDirectory, "README.md"), "# Clean test\n", "utf8");
    await runGit(workspaceDirectory, ["add", "README.md"]);
    await runGit(workspaceDirectory, ["commit", "-m", "Clean base"]);

    if (dirty) {
      await writeFile(path.join(workspaceDirectory, "local-draft.md"), "Do not delete\n", "utf8");
    }

    await writeFile(
      path.join(rootDirectory, ".trelio-run.json"),
      `${JSON.stringify({
        schemaVersion: 3,
        origin,
        pluginVersion: BRIDGE_VERSION,
        workspaceId,
        runId: currentRunId,
        workspaceDirectory,
        objects: [],
        contextObjects: [],
      }, null, 2)}\n`,
      { mode: 0o600 },
    );
    roots.set(name, rootDirectory);
    return rootDirectory;
  };

  const server = createServer(async (request, response) => {
    try {
      assert.equal(request.headers["x-trelio-agent-workspaces-version"], BRIDGE_VERSION);
      assert.equal(request.headers.authorization, "Bearer integration-token");

      if (request.url === "/api/agent-workspaces/bridge-compatibility") {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ supported: true, minimumVersion: BRIDGE_VERSION }));
        return;
      }

      if (request.url === `/api/agent-workspaces/workspaces/${workspaceId}`) {
        const oldTimestamp = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({
          runs: [
            { id: acceptedRunId, status: "accepted", acceptedAt: oldTimestamp },
            { id: dirtyRunId, status: "accepted", acceptedAt: oldTimestamp },
            { id: activeRunId, status: "active", updatedAt: oldTimestamp },
          ],
        }));
        return;
      }

      response.statusCode = 404;
      response.end();
    } catch (error) {
      serverError = error;
      response.statusCode = 500;
      response.end(error instanceof Error ? error.message : String(error));
    }
  });

  try {
    await mkdir(homeDirectory, { recursive: true });
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const serverAddress = server.address();
    assert.ok(serverAddress && typeof serverAddress === "object");
    const origin = `http://127.0.0.1:${serverAddress.port}`;
    await writeTestCredential(homeDirectory, origin);
    const acceptedRoot = await createLocalRunRoot(origin, "accepted-clean", acceptedRunId);
    const dirtyRoot = await createLocalRunRoot(origin, "accepted-dirty", dirtyRunId, true);
    const activeRoot = await createLocalRunRoot(origin, "active", activeRunId);
    const unknownRoot = await createLocalRunRoot(origin, "unknown", unknownRunId);
    await mkdir(configDirectory, { recursive: true });
    await writeFile(
      path.join(configDirectory, "settings.json"),
      `${JSON.stringify({
        terminalRunRetentionDays: 1,
        objectCacheMaxAgeDays: 30,
        objectCacheMaxBytes: 10 * 1024 * 1024 * 1024,
      }, null, 2)}\n`,
      { mode: 0o600 },
    );
    await writeFile(
      path.join(configDirectory, "runs.json"),
      `${JSON.stringify({
        schemaVersion: 1,
        roots: [acceptedRoot, dirtyRoot, activeRoot, unknownRoot],
      }, null, 2)}\n`,
      { mode: 0o600 },
    );

    const preview = await execFileAsync(
      process.execPath,
      [bridgePath, "clean", "--dry-run", "--origin", origin],
      {
        cwd: temporaryDirectory,
        encoding: "utf8",
        env: { ...process.env, HOME: homeDirectory },
      },
    );
    assert.match(preview.stdout, /Terminal Run roots: 1/);
    assert.match(preview.stdout, /accepted-clean/);
    assert.doesNotMatch(preview.stdout, /accepted-dirty/);
    assert.equal(await pathExists(acceptedRoot), true, "dry-run must not delete candidates");

    const cleaned = await execFileAsync(
      process.execPath,
      [bridgePath, "clean", "--origin", origin],
      {
        cwd: temporaryDirectory,
        encoding: "utf8",
        env: { ...process.env, HOME: homeDirectory },
      },
    );
    assert.match(cleaned.stdout, /Очистка завершена/);
    assert.equal(await pathExists(acceptedRoot), false);
    assert.equal(await pathExists(dirtyRoot), true);
    assert.equal(await pathExists(activeRoot), true);
    assert.equal(await pathExists(unknownRoot), true);
    assert.ifError(serverError);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test("bridge release version stays synchronized across executable and manifests", async () => {
  const codexManifest = JSON.parse(await readFile(
    path.join(pluginDirectory, ".codex-plugin", "plugin.json"),
    "utf8",
  ));
  const claudeManifest = JSON.parse(await readFile(
    path.join(pluginDirectory, ".claude-plugin", "plugin.json"),
    "utf8",
  ));
  const claudeMarketplace = JSON.parse(await readFile(
    path.resolve(pluginDirectory, "..", "..", ".claude-plugin", "marketplace.json"),
    "utf8",
  ));
  const claudeMarketplaceEntry = claudeMarketplace.plugins.find(
    (plugin) => plugin.name === "trelio-agent-workspaces",
  );

  assert.equal(BRIDGE_VERSION, "1.3.9");
  assert.equal(codexManifest.version, BRIDGE_VERSION);
  assert.equal(claudeManifest.version, BRIDGE_VERSION);
  assert.equal(claudeMarketplaceEntry?.version, BRIDGE_VERSION);
});

test("workspace worker discovers the live skill catalog before substantive work", async () => {
  const workerSkill = await readFile(
    path.join(pluginDirectory, "skills", "trelio-workspace-worker", "SKILL.md"),
    "utf8",
  );
  const catalogSkill = await readFile(
    path.join(pluginDirectory, "skills", "trelio-skill-catalog", "SKILL.md"),
    "utf8",
  );

  assert.match(workerSkill, /Call `list_agent_skills` once for the exact resolved context/);
  assert.match(workerSkill, /Do not load every skill instruction speculatively/);
  assert.match(workerSkill, /Immediately before using a relevant Trelio-provided skill, call `get_agent_skill`/);
  assert.match(catalogSkill, /Call `list_agent_skills` once for the effective work context/);
  assert.match(catalogSkill, /project-scoped response already contains the additive union/);
});

test("bridge adds its release version and bearer credential to every API request", () => {
  const headers = buildBridgeRequestHeaders("oauth-token", { accept: "application/json" });
  assert.equal(headers.get("x-trelio-agent-workspaces-version"), BRIDGE_VERSION);
  assert.equal(headers.get("authorization"), "Bearer oauth-token");
  assert.equal(headers.get("accept"), "application/json");
});

test("bridge submit external object writes the pointer through stdin without hanging", {
  timeout: 15_000,
}, async () => {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "trelio-bridge-submit-test-"));
  const homeDirectory = path.join(temporaryDirectory, "home");
  const runDirectory = path.join(temporaryDirectory, "run");
  const workspaceDirectory = path.join(runDirectory, "workspace");
  const objectDirectory = path.join(workspaceDirectory, "sources");
  const binaryBytes = Buffer.from([0, 1, 2]);
  const binaryDigest = createHash("sha256").update(binaryBytes).digest("hex");
  const expectedPointer = [
    "version https://trelio.ru/spec/workspace-object/v1",
    `oid sha256:${binaryDigest}`,
    `size ${binaryBytes.byteLength}`,
    "content-type application/octet-stream",
    "",
  ].join("\n");
  const seenRequests = [];
  let serverError = null;

  const server = createServer(async (request, response) => {
    try {
      const body = await readRequestBody(request);
      seenRequests.push({ method: request.method, url: request.url, body });
      assert.equal(request.headers["x-trelio-agent-workspaces-version"], BRIDGE_VERSION);
      assert.equal(request.headers.authorization, "Bearer integration-token");

      if (request.url?.endsWith("/heartbeat")) {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ leaseExpiresAt: new Date(Date.now() + 60_000).toISOString() }));
        return;
      }

      if (request.url?.endsWith("/objects/register")) {
        const registration = JSON.parse(body.toString("utf8"));
        assert.equal(registration.filePath, "sources/archive.bin");
        assert.equal(registration.sha256, binaryDigest);
        assert.equal(registration.sizeBytes, binaryBytes.byteLength);
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ uploadRequired: true }));
        return;
      }

      if (request.method === "PUT" && request.url?.includes(`/objects/${binaryDigest}/content`)) {
        assert.deepEqual(body, binaryBytes);
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ uploadRequired: false, pointer: expectedPointer }));
        return;
      }

      if (request.url?.endsWith("/candidate")) {
        assert.ok(body.byteLength > 0, "candidate bundle must reach the server");
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({
          run: { status: "accepted" },
          projection: { status: "projected" },
        }));
        return;
      }

      response.statusCode = 404;
      response.end();
    } catch (error) {
      serverError = error;
      response.statusCode = 500;
      response.end(error instanceof Error ? error.message : String(error));
    }
  });

  try {
    await mkdir(objectDirectory, { recursive: true });
    await mkdir(homeDirectory, { recursive: true });
    await runGit(workspaceDirectory, ["init", "--initial-branch=trelio-candidate"]);
    await runGit(workspaceDirectory, ["config", "user.name", "Trelio Bridge Test"]);
    await runGit(workspaceDirectory, ["config", "user.email", "bridge-test@trelio.local"]);
    await writeFile(path.join(workspaceDirectory, "README.md"), "# Base\n", "utf8");
    await runGit(workspaceDirectory, ["add", "README.md"]);
    await runGit(workspaceDirectory, ["commit", "-m", "Base"]);
    const baseHead = (await runGit(workspaceDirectory, ["rev-parse", "HEAD"])).stdout.trim();
    await writeFile(path.join(objectDirectory, "archive.bin"), binaryBytes);

    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const serverAddress = server.address();
    assert.ok(serverAddress && typeof serverAddress === "object");
    const origin = `http://127.0.0.1:${serverAddress.port}`;
    const credentialDirectory = path.join(
      homeDirectory,
      ".config",
      "trelio",
      "workspace-bridge",
    );
    await mkdir(credentialDirectory, { recursive: true });
    await writeFile(
      path.join(credentialDirectory, "credentials.json"),
      `${JSON.stringify({ [origin]: { accessToken: "integration-token" } }, null, 2)}\n`,
      { mode: 0o600 },
    );
    await writeFile(
      path.join(runDirectory, ".trelio-run.json"),
      `${JSON.stringify({
        schemaVersion: 3,
        origin,
        pluginVersion: BRIDGE_VERSION,
        workspaceId: "44444444-4444-4444-8444-444444444444",
        runId,
        leaseId: "55555555-5555-4555-8555-555555555555",
        fencingToken: 7,
        baseHead,
        workspaceDirectory,
        contextHeads: {},
        contexts: [],
        objects: [],
      }, null, 2)}\n`,
      "utf8",
    );

    const submitted = await execFileAsync(
      process.execPath,
      [bridgePath, "submit", "--message", "Проверить external object"],
      {
        cwd: workspaceDirectory,
        encoding: "utf8",
        timeout: 8_000,
        env: {
          ...process.env,
          HOME: homeDirectory,
        },
      },
    );

    assert.match(submitted.stdout, /Статус: принят автоматически/);
    assert.ifError(serverError);
    assert.equal(
      seenRequests.filter((request) => request.url?.endsWith("/heartbeat")).length,
      2,
    );
    assert.equal(
      seenRequests.some((request) => request.url?.endsWith("/objects/register")),
      true,
    );
    assert.equal(
      seenRequests.some((request) => request.url?.endsWith("/candidate")),
      true,
    );
    assert.equal(
      (await runGit(workspaceDirectory, ["show", "HEAD:sources/archive.bin"])).stdout,
      expectedPointer,
    );
    assert.deepEqual(await readFile(path.join(objectDirectory, "archive.bin")), binaryBytes);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test("bridge help advertises the related context sync command", async () => {
  const result = await execFileAsync(process.execPath, [bridgePath, "help"], { encoding: "utf8" });
  assert.match(result.stdout, /Bridge 1\.3\.9/);
  assert.match(result.stdout, /trelio-workspace context sync/);
  assert.match(result.stdout, /trelio-workspace context attach --workspace UUID/);
  assert.match(result.stdout, /trelio-workspace context fetch --path/);
  assert.match(result.stdout, /trelio-workspace clean --dry-run/);
});

test("bridge recognizes exact object pointers and classifies binary bytes", async () => {
  const digest = "a".repeat(64);
  const pointer = [
    "version https://trelio.ru/spec/workspace-object/v1",
    `oid sha256:${digest}`,
    "size 3",
    "content-type application/octet-stream",
    "",
  ].join("\n");
  assert.deepEqual(parseWorkspaceObjectPointer(pointer), {
    sha256: digest,
    sizeBytes: 3,
    contentType: "application/octet-stream",
  });
  assert.equal(parseWorkspaceObjectPointer(`${pointer}\n`), null);

  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "trelio-bridge-object-test-"));
  const textPath = path.join(temporaryDirectory, "small.md");
  const binaryPath = path.join(temporaryDirectory, "small.bin");

  try {
    await writeFile(textPath, "# Небольшой текст\n", "utf8");
    await writeFile(binaryPath, Buffer.from([0, 1, 2]));
    assert.deepEqual(await inspectWorkspaceFile(textPath), {
      external: false,
      sizeBytes: Buffer.byteLength("# Небольшой текст\n"),
    });
    const binary = await inspectWorkspaceFile(binaryPath);
    assert.equal(binary.external, true);
    assert.equal(binary.sizeBytes, 3);
    assert.match(binary.sha256, /^[0-9a-f]{64}$/);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test("bridge keeps AGENTS.md, CLAUDE.md and .trelio as protected inline control files", () => {
  assert.equal(isProtectedWorkspaceControlPath("AGENTS.md"), true);
  assert.equal(isProtectedWorkspaceControlPath("CLAUDE.md"), true);
  assert.equal(isProtectedWorkspaceControlPath(".trelio/workspace.json"), true);
  assert.equal(isProtectedWorkspaceControlPath("PROJECT_CONTEXT.md"), false);
  assert.equal(isProtectedWorkspaceControlPath("work/CLAUDE.md"), false);
});
