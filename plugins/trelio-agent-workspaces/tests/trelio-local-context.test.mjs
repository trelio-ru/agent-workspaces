import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  canonicalizeProposalTargetFromMirror,
  TRELIO_LOCAL_MIRROR_MEMORY_TTL_SECONDS,
  TRELIO_LOCAL_CONTEXT_TOOL,
  TRELIO_LOCAL_PROPOSAL_TOOL,
  TRELIO_LOCAL_WORKSPACE_TOOL,
  buildEncryptedRestoreHandoffArguments,
  fetchMirrorResult,
  findPreparedEncryptedRestoreRun,
  getWorkspaceFileFromMirror,
  hydrateChangedCompanyMirrorRecords,
  listCompanyContextMirror,
  materializeHistoricalWorkspaceTreeForRestore,
  prepareLocalProposalBundle,
  resolveMirrorPaths,
  searchCompanyContextMirror,
  searchWorkspaceFilesFromMirror,
  selectEncryptedProposalFilesFromManifest,
} from "../scripts/trelio-local-context.mjs";

const execFileAsync = promisify(execFile);

const mirror = {
  schemaVersion: 1,
  generation: "a".repeat(64),
  serverGeneration: "b".repeat(64),
  createdAt: "2026-09-01T00:00:00.000Z",
  company: { id: "11111111-1111-4111-8111-111111111111", slug: "acme", name: "Acme" },
  projects: [{
    id: "22222222-2222-4222-8222-222222222222",
    slug: "mobile",
    slugAliases: ["mobile-legacy"],
    name: "Мобильное приложение",
    isArchived: false,
  }],
  tasks: [{
    id: "33333333-3333-4333-8333-333333333333",
    projectId: "22222222-2222-4222-8222-222222222222",
    projectSlug: "mobile",
    number: 17,
    revisionToken: "33333333-3333-4333-8333-333333333333:1:2:3:4",
    payload: {
      task: {
        title: "Исправить офлайн синхронизацию",
        description: "Поиск релевантного контекста должен работать на устройстве",
        status: { code: "in_progress", name: "В работе" },
      },
    },
  }],
  dossiers: [{
    id: "44444444-4444-4444-8444-444444444444",
    title: "Архитектура локального индекса",
    description: "Неизменяемые поколения и один writer",
    project: { id: "22222222-2222-4222-8222-222222222222", slug: "mobile" },
  }],
  contextDocuments: [{
    id: "66666666-6666-4666-8666-666666666666",
    type: "registry",
    title: "Реестр поставщиков",
    revisionToken: "d".repeat(64),
    projectId: "22222222-2222-4222-8222-222222222222",
    projectSlug: "mobile",
    payload: {
      registry: { title: "Реестр поставщиков" },
      rows: [{ rowKey: "Север", values: { state: "Проверен" } }],
    },
  }],
  workspaces: [{
    id: "55555555-5555-4555-8555-555555555555",
    scopeType: "task",
    scopeKey: "task:33333333-3333-4333-8333-333333333333",
    taskId: "33333333-3333-4333-8333-333333333333",
    acceptedHead: "c".repeat(40),
    documents: [{
      path: "notes/decision.md",
      name: "decision.md",
      sizeBytes: 64,
      text: "Конфликты разрешаются optimistic CAS и fencing token.",
    }],
  }],
  instructions: { company: null, projects: [], userProfile: null },
};

test("local mirror search ranks structured and workspace context without remote query data", () => {
  const result = searchCompanyContextMirror(
    mirror,
    ["релевантный поиск контекста", "fencing token"],
    10,
  );

  assert.equal(result.provider, "local_company_context");
  assert.deepEqual(result.queries, ["релевантный поиск контекста", "fencing token"]);
  assert.equal(result.results.some(({ type }) => type === "task"), true);
  assert.equal(result.results.some(({ type }) => type === "workspace_file"), true);
  assert.equal(JSON.stringify(result).includes("remote"), false);
});

test("workspace-only local refinement and exact file read preserve the accepted-head fence", () => {
  const searched = searchWorkspaceFilesFromMirror(mirror, ["fencing token"], 10);

  assert.deepEqual(searched.results.map(({ type }) => type), ["workspace_file"]);
  const file = getWorkspaceFileFromMirror(mirror, {
    workspaceId: "55555555-5555-4555-8555-555555555555",
    workspaceHead: "c".repeat(40),
    filePath: "notes/decision.md",
  });
  assert.equal(file.file.text, "Конфликты разрешаются optimistic CAS и fencing token.");
  assert.throws(
    () => getWorkspaceFileFromMirror(mirror, {
      workspaceId: "55555555-5555-4555-8555-555555555555",
      workspaceHead: "d".repeat(40),
      filePath: "notes/decision.md",
    }),
    (error) => (
      error?.code === "LOCAL_CONTEXT_WORKSPACE_OUTDATED"
      && error?.details?.currentHead === "c".repeat(40)
    ),
  );
});

test("local mirror includes first-class company documents in search, list and fetch", () => {
  const searched = searchCompanyContextMirror(mirror, ["реестр поставщиков", "север"], 10);
  const registry = searched.results.find(({ type }) => type === "registry");

  assert.ok(registry);
  assert.equal(registry.id, "context:registry:66666666-6666-4666-8666-666666666666");
  const listed = listCompanyContextMirror(mirror, "registries", 0, 50, "mobile");
  assert.equal(listed.total, 1);
  const fetched = fetchMirrorResult(mirror, registry.id);
  assert.equal(fetched.document.payload.rows[0].rowKey, "Север");
  assert.equal(fetched.effectiveInstructions.agentInstructionsSnapshot, null);
});

test("local inventory is bounded and task result ids round-trip exactly", () => {
  const listed = listCompanyContextMirror(mirror, "tasks", 0, 50, "mobile");

  assert.equal(listed.total, 1);
  assert.equal(listed.items[0].id, "task:acme/mobile/17");
  const fetched = fetchMirrorResult(mirror, listed.items[0].id);
  assert.equal(fetched.task.title, "Исправить офлайн синхронизацию");
  assert.equal(fetched.generation, mirror.generation);
});

test("legacy project slugs resolve to canonical mirror records", () => {
  const listedTasks = listCompanyContextMirror(mirror, "tasks", 0, 50, "mobile-legacy");
  const listedDossiers = listCompanyContextMirror(mirror, "dossiers", 0, 50, "mobile-legacy");
  const listedRegistries = listCompanyContextMirror(mirror, "registries", 0, 50, "mobile-legacy");
  const fetched = fetchMirrorResult(mirror, "task:acme/mobile-legacy/17");

  assert.equal(listedTasks.total, 1);
  assert.equal(listedTasks.items[0].projectSlug, "mobile");
  assert.equal(listedDossiers.total, 1);
  assert.equal(listedRegistries.total, 1);
  assert.equal(fetched.task.title, "Исправить офлайн синхронизацию");
});

test("legacy task URLs use the canonical project route for every proposal write", () => {
  assert.deepEqual(
    canonicalizeProposalTargetFromMirror(mirror, {
      projectSlug: "mobile-legacy",
      taskNumber: 17,
    }),
    { projectSlug: "mobile", taskNumber: 17 },
  );
  assert.deepEqual(
    canonicalizeProposalTargetFromMirror(mirror, {
      runId: "77777777-7777-4777-8777-777777777777",
    }),
    { runId: "77777777-7777-4777-8777-777777777777" },
  );
  assert.throws(
    () => canonicalizeProposalTargetFromMirror(mirror, {
      projectSlug: "mobile-legacy",
      taskNumber: 999,
    }),
    (error) => error?.code === "LOCAL_CONTEXT_TASK_NOT_FOUND",
  );
});

test("ambiguous project routing aliases fail closed", () => {
  const ambiguousMirror = {
    ...mirror,
    projects: [
      ...mirror.projects,
      {
        id: "77777777-7777-4777-8777-777777777777",
        slug: "other",
        slugAliases: ["mobile-legacy"],
      },
    ],
  };

  assert.throws(
    () => listCompanyContextMirror(ambiguousMirror, "tasks", 0, 50, "mobile-legacy"),
    (error) => error?.code === "LOCAL_CONTEXT_MIRROR_INVALID",
  );
});

test("always-visible local schemas stay compact and provider-neutral", () => {
  const schemas = JSON.stringify([
    TRELIO_LOCAL_CONTEXT_TOOL,
    TRELIO_LOCAL_PROPOSAL_TOOL,
    TRELIO_LOCAL_WORKSPACE_TOOL,
  ]);

  assert.equal(Buffer.byteLength(schemas, "utf8") <= 3_000, true);
  assert.doesNotMatch(schemas, /encrypt|e2ee|cipher|private key/iu);
  assert.deepEqual(TRELIO_LOCAL_CONTEXT_TOOL.inputSchema.properties.operation.enum, [
    "search",
    "search_workspace_files",
    "list",
    "get_task",
    "fetch",
    "get_workspace_file",
  ]);
  assert.equal(TRELIO_LOCAL_CONTEXT_TOOL.annotations.readOnlyHint, true);
  assert.equal(TRELIO_LOCAL_PROPOSAL_TOOL.annotations.readOnlyHint, false);
  assert.deepEqual(TRELIO_LOCAL_PROPOSAL_TOOL.inputSchema.properties.kind.enum, [
    "comment",
    "status",
    "control_clear",
    "checklist",
    "bundle",
  ]);
  assert.deepEqual(TRELIO_LOCAL_WORKSPACE_TOOL.inputSchema.properties.operation.enum, [
    "list_revisions",
    "restore_revision",
    "cancel_run",
  ]);
  assert.equal(TRELIO_LOCAL_WORKSPACE_TOOL.annotations.readOnlyHint, false);
});

test("ambiguous restore prepare is recovered only by one exact audit marker", () => {
  const workspaceId = "55555555-5555-4555-8555-555555555555";
  const expectedHead = "a".repeat(40);
  const targetHead = "b".repeat(40);
  const reasonMarker = "~e1:77777777-7777-4777-8777-777777777777:restore_reason~";
  const exactRun = {
    id: "88888888-8888-4888-8888-888888888888",
    clientKind: "workspace_restore",
    baseHead: expectedHead,
    clientMetadataJson: {
      source: "local_encrypted_restore",
      restoredFromHead: targetHead,
      reason: reasonMarker,
    },
  };
  const input = {
    workspaceId,
    expectedHead,
    targetHead,
    reasonMarker,
  };

  assert.equal(findPreparedEncryptedRestoreRun({
    ...input,
    overview: { workspace: { id: workspaceId }, runs: [exactRun] },
  }), exactRun);
  assert.equal(findPreparedEncryptedRestoreRun({
    ...input,
    overview: {
      workspace: { id: workspaceId },
      runs: [{
        ...exactRun,
        clientMetadataJson: {
          ...exactRun.clientMetadataJson,
          reason: "~e1:99999999-9999-4999-8999-999999999999:restore_reason~",
        },
      }],
    },
  }), null);
  assert.equal(findPreparedEncryptedRestoreRun({
    ...input,
    overview: {
      workspace: { id: workspaceId },
      runs: [exactRun, { ...exactRun, id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }],
    },
  }), null);
});

test("encrypted restore handoff lets the bridge report the exact changed paths", () => {
  const dossierArguments = buildEncryptedRestoreHandoffArguments("dossier");
  assert.equal(dossierArguments.includes("--file"), false);
  assert.equal(dossierArguments.includes("--task-outcome"), false);
  assert.deepEqual(
    buildEncryptedRestoreHandoffArguments("task").slice(-2),
    ["--task-outcome", "no_status_change"],
  );
});
test("local restore keeps current control paths and normalizes legacy context", async () => {
  const repository = await fs.mkdtemp(path.join(os.tmpdir(), "trelio-local-restore-test-"));
  const git = (argumentsList) => execFileAsync("git", argumentsList, {
    cwd: repository,
    encoding: "utf8",
  });

  try {
    await git(["init", "--initial-branch=main"]);
    await git(["config", "user.name", "Trelio tests"]);
    await git(["config", "user.email", "tests@trelio.local"]);
    await fs.mkdir(path.join(repository, ".trelio"), { recursive: true });
    await fs.mkdir(path.join(repository, "work"), { recursive: true });
    await Promise.all([
      fs.writeFile(path.join(repository, "AGENTS.md"), "historical control\n"),
      fs.writeFile(path.join(repository, "CLAUDE.md"), "historical claude\n"),
      fs.writeFile(path.join(repository, ".trelio", "workspace.json"), "historical metadata\n"),
      fs.writeFile(path.join(repository, "PROJECT_CONTEXT.md"), "# PROJECT_CONTEXT\n\nold fact\n"),
      fs.writeFile(path.join(repository, "work", "result.md"), "historical result\n"),
    ]);
    await git(["add", "--all"]);
    await git(["commit", "-m", "historical"]);
    const targetHead = (await git(["rev-parse", "HEAD"])).stdout.trim();

    await Promise.all([
      fs.writeFile(path.join(repository, "AGENTS.md"), "current control\n"),
      fs.writeFile(path.join(repository, "CLAUDE.md"), "current claude\n"),
      fs.writeFile(path.join(repository, ".trelio", "workspace.json"), "current metadata\n"),
      fs.writeFile(path.join(repository, "WORKSPACE_CONTEXT.md"), "# WORKSPACE_CONTEXT\n\ncurrent fact\n"),
      fs.writeFile(path.join(repository, "work", "result.md"), "current result\n"),
      fs.rm(path.join(repository, "PROJECT_CONTEXT.md")),
    ]);
    await git(["add", "--all"]);
    await git(["commit", "-m", "current"]);
    const expectedHead = (await git(["rev-parse", "HEAD"])).stdout.trim();

    await materializeHistoricalWorkspaceTreeForRestore({
      workspaceDirectory: repository,
      expectedHead,
      targetHead,
      formatVersion: 5,
    });

    assert.equal(await fs.readFile(path.join(repository, "work", "result.md"), "utf8"), "historical result\n");
    assert.equal(
      await fs.readFile(path.join(repository, "WORKSPACE_CONTEXT.md"), "utf8"),
      "# WORKSPACE_CONTEXT\n\nold fact\n",
    );
    await assert.rejects(fs.stat(path.join(repository, "PROJECT_CONTEXT.md")), /ENOENT/u);
    assert.equal((await git(["show", ":AGENTS.md"])).stdout, "current control\n");
    assert.equal((await git(["show", ":CLAUDE.md"])).stdout, "current claude\n");
    assert.equal((await git(["show", ":.trelio/workspace.json"])).stdout, "current metadata\n");
    assert.equal(
      (await git([
        "diff",
        "--cached",
        "--name-only",
        expectedHead,
        "--",
        "AGENTS.md",
        "CLAUDE.md",
        ".trelio",
      ])).stdout,
      "",
    );
  } finally {
    await fs.rm(repository, { recursive: true, force: true });
  }
});

test("local proposal bundle preserves order, canonicalizes aliases and isolates card errors", async () => {
  const saves = [];
  const result = await prepareLocalProposalBundle({
    companySlug: "acme",
    rawBlocks: [
      { type: "text", markdown: "Проверьте оба решения." },
      {
        type: "commentProposal",
        companySlug: "acme",
        projectSlug: "mobile-legacy",
        taskNumber: 17,
        proposalText: "Подготовил исправление.",
        expectedStateRevision: 4,
        expectedPublicCommentsSnapshotHash: "a".repeat(64),
      },
      {
        type: "statusProposal",
        companySlug: "acme",
        projectSlug: "mobile-legacy",
        taskNumber: 17,
        expectedStateRevision: 2,
        expectedStatusId: "77777777-7777-4777-8777-777777777777",
        targetStatusCode: "done",
        reason: "Задача готова.",
      },
    ],
    canonicalizeTarget: async (target) => canonicalizeProposalTargetFromMirror(mirror, target),
    saveProposal: async (input) => {
      saves.push(input);
      if (input.kind === "status") {
        const error = new Error("The task status changed before this card was saved.");
        error.code = "TASK_STATUS_PROPOSAL_OUTDATED";
        throw error;
      }
      return { currentDraft: { proposalId: "88888888-8888-4888-8888-888888888888" } };
    },
  });

  assert.deepEqual(saves.map(({ kind, rawPayload }) => ({
    kind,
    target: rawPayload.target,
  })), [
    { kind: "comment", target: { projectSlug: "mobile", taskNumber: 17 } },
    { kind: "status", target: { projectSlug: "mobile", taskNumber: 17 } },
  ]);
  assert.equal(result.provider, "local_company_context");
  assert.equal(result.proposalBundle.blocks[0].type, "text");
  assert.equal(result.proposalBundle.blocks[1].status, "ready");
  assert.deepEqual(result.proposalBundle.blocks[2].error, {
    code: "TASK_STATUS_PROPOSAL_OUTDATED",
    message: "The task status changed before this card was saved.",
  });
});

test("local proposal bundle rejects a mixed company before saving any card", async () => {
  let saveCount = 0;

  await assert.rejects(
    prepareLocalProposalBundle({
      companySlug: "acme",
      rawBlocks: [{
        type: "commentProposal",
        companySlug: "other-company",
        projectSlug: "mobile",
        taskNumber: 17,
        proposalText: "Не должно сохраниться.",
        expectedStateRevision: 0,
        expectedPublicCommentsSnapshotHash: "a".repeat(64),
      }],
      canonicalizeTarget: async (target) => target,
      saveProposal: async () => {
        saveCount += 1;
        return {};
      },
    }),
    (error) => error?.code === "LOCAL_CONTEXT_INVALID_INPUT",
  );
  assert.equal(saveCount, 0);
});

test("decrypted mirror residency has the exact ten-minute hard TTL", () => {
  assert.equal(TRELIO_LOCAL_MIRROR_MEMORY_TTL_SECONDS, 600);
});

test("encrypted mirror pointers and locks are isolated by schema version", () => {
  const paths = resolveMirrorPaths({
    origin: "https://trelio.example",
    companyId: "11111111-1111-4111-8111-111111111111",
  });

  assert.equal(paths.root.endsWith("schema-2"), true);
  assert.equal(paths.pointer.startsWith(paths.root), true);
  assert.equal(paths.lock.startsWith(paths.root), true);
  assert.equal(paths.generations.startsWith(paths.root), true);
});

test("encrypted proposal paths resolve only through the exact local browser manifest", () => {
  const projectionId = "77777777-7777-4777-8777-777777777777";
  const workspaceId = "88888888-8888-4888-8888-888888888888";
  const acceptedHead = "c".repeat(40);
  const manifest = {
    schemaVersion: 1,
    kind: "agent-workspace-browser-manifest",
    projectionId,
    workspaceId,
    workspaceHead: acceptedHead,
    files: [{
      id: "99999999-9999-4999-8999-999999999999",
      path: "work/SMOKE_TEST.md",
      sizeBytes: 42,
      contentType: "text/plain; charset=utf-8",
    }],
  };
  const selected = selectEncryptedProposalFilesFromManifest({
    manifest,
    projectionId,
    projectionFileCount: 1,
    workspaceId,
    acceptedHead,
    filePaths: ["work/SMOKE_TEST.md"],
  });

  assert.deepEqual(selected, [{
    sourceFileId: "99999999-9999-4999-8999-999999999999",
    filePath: "work/SMOKE_TEST.md",
    fileName: "SMOKE_TEST.md",
    contentType: "text/plain; charset=utf-8",
  }]);
  assert.throws(
    () => selectEncryptedProposalFilesFromManifest({
      manifest,
      projectionId,
      projectionFileCount: 1,
      workspaceId,
      acceptedHead: "d".repeat(40),
      filePaths: ["work/SMOKE_TEST.md"],
    }),
    (error) => error?.code === "LOCAL_CONTEXT_BROWSER_PROJECTION_INVALID",
  );
});

test("changed mirror records are hydrated in bounded mirror-wide batches", async () => {
  const hydrationCalls = [];
  const records = [{ cached: { id: "cached" } }].concat(
    Array.from({ length: 501 }, (_, index) => ({ source: { id: `changed-${index}` } })),
  );

  const hydrated = await hydrateChangedCompanyMirrorRecords({
    records,
    load: async (value) => value,
    hydrate: async (values) => {
      hydrationCalls.push(values);
      return values.map((value) => ({ ...value, hydrated: true }));
    },
  });

  assert.deepEqual(hydrationCalls.map((batch) => batch.length), [250, 250, 1]);
  assert.deepEqual(hydrated[0], { id: "cached" });
  assert.deepEqual(hydrated[1], { id: "changed-0", hydrated: true });
  assert.deepEqual(hydrated.at(-1), { id: "changed-500", hydrated: true });
});
