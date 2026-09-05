import assert from "node:assert/strict";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  assertLocalAgentInstructionPublicationWithinLimit,
  assertHydratedLocalProposalPublicationMatches,
  canonicalizeProposalTargetFromMirror,
  TRELIO_LOCAL_MIRROR_MEMORY_TTL_SECONDS,
  TRELIO_LOCAL_CONTEXT_TOOL,
  TRELIO_LOCAL_ACTION_TOOL,
  TRELIO_LOCAL_PROPOSAL_CONTEXT_TOOL,
  TRELIO_LOCAL_PROPOSAL_RENDER_TOOL,
  TRELIO_LOCAL_PROPOSAL_RESOURCE_URI,
  TRELIO_LOCAL_WORKSPACE_TOOL,
  TRELIO_WORKSPACE_ACTION_TOOL,
  buildEncryptedRestoreHandoffArguments,
  buildLocalTaskAttachmentStreamRequest,
  buildLocalMarkdownDocument,
  buildTrelioWorkspaceActionInvocation,
  buildWorkspaceBridgeProcessArguments,
  fetchMirrorResult,
  findPreparedEncryptedRestoreRun,
  getWorkspaceFileFromMirror,
  handleNativeLocalContextRead,
  handleTrelioWorkspaceActionOperation,
  hydrateChangedCompanyMirrorRecords,
  isLocalTaskSectionRevisionConflict,
  listCompanyContextMirror,
  localActionMayMutateCompanyContext,
  materializeHistoricalWorkspaceTreeForRestore,
  inspectLocalWorkspaceRevisionDiff,
  prepareLocalTaskAttachmentUploadSession,
  prepareLocalProposalBundle,
  readLocalWorkspaceRevisionFile,
  protectLocalActionArguments,
  readLocalCompanyMirrorMutationToken,
  readTaskSectionsWithRevisionRefresh,
  rebuildHydratedLocalActionTaskDocuments,
  resolveMirrorPaths,
  searchCompanyContextMirror,
  searchWorkspaceFilesFromMirror,
  selectEncryptedProposalFilesFromManifest,
  signalLocalCompanyMirrorMutation,
  stageLocalTaskAttachmentUpload,
  uploadLocalTaskAttachmentStream,
  uploadLocalTaskAttachmentPayloads,
  uploadLocalActionPayloads,
} from "../scripts/trelio-local-context.mjs";
import {
  createAgentEncryptionDevice,
  decryptCompanyPayload,
  decryptFileFromCompanyContainerBytes,
} from "../scripts/trelio-company-encryption.mjs";
import {
  TrelioApiError,
  resolveCompanyContextMutationMarkerPath,
} from "../scripts/trelio-workspace.mjs";

const execFileAsync = promisify(execFile);

const actionWorkspaceId = "11111111-1111-4111-8111-111111111111";
const actionRunId = "22222222-2222-4222-8222-222222222222";
const actionReleaseId = "33333333-3333-4333-8333-333333333333";
const actionGrantId = "44444444-4444-4444-8444-444444444444";
const actionSecretId = "55555555-5555-4555-8555-555555555555";
const actionWorkingDirectory = path.resolve(os.tmpdir(), "trelio-action-workspace");

test("typed Workspace dispatcher covers every public bridge operation without shell input", () => {
  const actions = [
    ["doctor", { json: true }],
    ["login", { legacyOauth: false }],
    ["encryption_setup", { companySlug: "acme", json: true }],
    ["inspect", { workspaceId: actionWorkspaceId }],
    ["open", { workspaceId: actionWorkspaceId, runId: actionRunId }],
    ["status", {}, actionWorkingDirectory],
    ["heartbeat", {}, actionWorkingDirectory],
    ["context_sync", {}, actionWorkingDirectory],
    ["context_attach", { workspaceId: actionWorkspaceId }, actionWorkingDirectory],
    ["context_fetch", { path: "../context/related/source.md" }, actionWorkingDirectory],
    ["clean", { dryRun: true }],
    ["checkpoint", { type: "draft", summary: "Сохранить завершённую часть" }, actionWorkingDirectory],
    ["pause", {
      summary: "Сохранить результат перед решением",
      questions: ["Какой вариант выбрать?"],
      nextAction: "Продолжить после ответа",
    }, actionWorkingDirectory],
    ["finish", {
      summary: "Подготовлен и проверен итоговый материал",
      evidence: ["Проверка прошла"],
      filePaths: ["artifacts/result.md"],
      nextAction: "Проверить результат",
      taskOutcome: "work_completed",
    }, actionWorkingDirectory],
    ["submit", { message: "Сохранить результат" }, actionWorkingDirectory],
    ["skill_pack", {
      skillId: "example-skill",
      runtimeVersion: "1.2.3",
      sourceDirectory: path.resolve(os.tmpdir(), "skill-source"),
      entrypointPath: "main.mjs",
      interpreter: "node",
      outputPath: path.resolve(os.tmpdir(), "example.skillpkg"),
      capabilities: ["network"],
    }],
    ["skill_run", {
      companyId: actionWorkspaceId,
      skillId: "example-skill",
      releaseId: actionReleaseId,
      arguments: ["search", "--query", "exact phrase"],
    }],
    ["secret_exec", {
      grantId: actionGrantId,
      executable: "/usr/bin/example",
      arguments: ["--mode", "safe"],
    }, actionWorkingDirectory],
    ["secret_browser_fill", {
      grantId: actionGrantId,
      targetUrl: "https://example.com/login",
    }, actionWorkingDirectory],
    ["secret_set_file", {
      secretId: actionSecretId,
      filePath: path.resolve(os.tmpdir(), "secret-value.json"),
      format: "fields-json",
    }, actionWorkingDirectory],
  ];

  for (const [operation, parameters, workingDirectory] of actions) {
    const invocation = buildTrelioWorkspaceActionInvocation({
      schemaVersion: 1,
      operation,
      parameters,
      ...(workingDirectory ? { workingDirectory } : {}),
    });
    assert.equal(invocation.operation, operation);
    assert.equal(invocation.argumentsList.includes("trelio-workspace"), false);
    assert.equal(invocation.argumentsList.some((value) => value.includes("\0")), false);
    assert.equal(invocation.workingDirectory, workingDirectory ?? null);
  }
});

test("typed Workspace dispatcher rejects undeclared flags and implicit destructive cleanup", () => {
  assert.throws(
    () => buildTrelioWorkspaceActionInvocation({
      schemaVersion: 1,
      operation: "inspect",
      parameters: { workspaceId: actionWorkspaceId, shell: "sh" },
    }),
    (error) => error?.code === "TRELIO_WORKSPACE_ACTION_INVALID_INPUT",
  );
  assert.throws(
    () => buildTrelioWorkspaceActionInvocation({
      schemaVersion: 1,
      operation: "clean",
      parameters: {},
    }),
    (error) => error?.code === "TRELIO_WORKSPACE_ACTION_INVALID_INPUT",
  );
  assert.throws(
    () => buildTrelioWorkspaceActionInvocation({
      schemaVersion: 1,
      operation: "checkpoint",
      parameters: { type: "draft", summary: "Готово" },
      workingDirectory: "relative/workspace",
    }),
    (error) => error?.code === "TRELIO_WORKSPACE_ACTION_INVALID_INPUT",
  );
  assert.throws(
    () => buildTrelioWorkspaceActionInvocation({
      schemaVersion: 1,
      operation: "secret_exec",
      parameters: {
        grantId: actionGrantId,
        executable: "/usr/bin/example",
        arguments: [],
      },
    }),
    (error) => error?.code === "TRELIO_WORKSPACE_ACTION_INVALID_INPUT",
  );
});

test("bridge origin stays before child argv and the local handler uses the exact Node bridge route", async () => {
  const processArguments = buildWorkspaceBridgeProcessArguments(
    "https://trelio.example",
    ["secret", "exec", "--grant", actionGrantId, "--", "/usr/bin/example", "--flag"],
  );
  const separatorIndex = processArguments.indexOf("--");
  assert.deepEqual(
    processArguments.slice(separatorIndex - 2, separatorIndex + 3),
    ["--origin", "https://trelio.example", "--", "/usr/bin/example", "--flag"],
  );

  let captured = null;
  const result = await handleTrelioWorkspaceActionOperation(
    "https://trelio.example",
    {
      schemaVersion: 1,
      operation: "checkpoint",
      parameters: { type: "draft", summary: "Сохранить завершённую часть" },
      workingDirectory: actionWorkingDirectory,
    },
    {
      runBridge: async (origin, argumentsList, options) => {
        captured = { origin, argumentsList, options };
        return { stdout: "Checkpoint сохранён\n", stderr: "" };
      },
    },
  );
  assert.deepEqual(captured, {
    origin: "https://trelio.example",
    argumentsList: [
      "checkpoint",
      "--type",
      "draft",
      "--summary",
      "Сохранить завершённую часть",
    ],
    options: { cwd: actionWorkingDirectory, signal: undefined },
  });
  assert.deepEqual(result, {
    schemaVersion: 1,
    operation: "checkpoint",
    stdout: "Checkpoint сохранён\n",
  });
  assert.equal(TRELIO_WORKSPACE_ACTION_TOOL.name, "continue_trelio_workspace_action");
  assert.equal(TRELIO_WORKSPACE_ACTION_TOOL.inputSchema.additionalProperties, false);
});

test("encrypted local rule publications enforce company/project UTF-8 limits before encryption", () => {
  assert.deepEqual(
    assertLocalAgentInstructionPublicationWithinLimit({
      nativeTool: "plan_agent_instructions_update",
      arguments: { companySlug: "acme", instructionsMarkdown: "a".repeat((16 * 1024) - 1) },
    }),
    { sizeBytes: 16 * 1024, maxBytes: 16 * 1024 },
  );
  assert.throws(
    () => assertLocalAgentInstructionPublicationWithinLimit({
      nativeTool: "publish_agent_instructions",
      arguments: { companySlug: "acme", instructionsMarkdown: "a".repeat(16 * 1024) },
    }),
    (error) => (
      error?.code === "LOCAL_ACTION_AGENT_INSTRUCTIONS_TOO_LARGE"
      && /Лимит – 16 КиБ/u.test(error.message)
    ),
  );
  assert.deepEqual(
    assertLocalAgentInstructionPublicationWithinLimit({
      nativeTool: "publish_agent_instructions",
      arguments: {
        companySlug: "acme",
        projectSlug: "mobile",
        instructionsMarkdown: "a".repeat((8 * 1024) - 1),
      },
    }),
    { sizeBytes: 8 * 1024, maxBytes: 8 * 1024 },
  );
  assert.throws(
    () => assertLocalAgentInstructionPublicationWithinLimit({
      nativeTool: "plan_agent_instructions_update",
      arguments: {
        companySlug: "acme",
        projectSlug: "mobile",
        instructionsMarkdown: "я".repeat(4 * 1024),
      },
    }),
    (error) => (
      error?.code === "LOCAL_ACTION_AGENT_INSTRUCTIONS_TOO_LARGE"
      && /Лимит – 8 КиБ/u.test(error.message)
    ),
  );
  assert.equal(
    assertLocalAgentInstructionPublicationWithinLimit({
      nativeTool: "create_task",
      arguments: { instructionsMarkdown: "a".repeat(20 * 1024) },
    }),
    null,
  );
});

const mirror = {
  schemaVersion: 1,
  generation: "a".repeat(64),
  serverGeneration: "b".repeat(64),
  createdAt: "2026-09-01T00:00:00.000Z",
  company: { id: "11111111-1111-4111-8111-111111111111", slug: "acme", name: "Acme" },
  viewer: { memberId: "99999999-9999-4999-8999-999999999999", companyRole: "user" },
  viewerGroupIds: [],
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
      company: { id: "11111111-1111-4111-8111-111111111111", slug: "acme", name: "Acme" },
      project: {
        id: "22222222-2222-4222-8222-222222222222",
        slug: "mobile",
        name: "Мобильное приложение",
      },
      task: {
        title: "Исправить офлайн синхронизацию",
        descriptionPlainText: "Поиск релевантного контекста должен работать на устройстве",
        status: { code: "in_progress", name: "В работе" },
        urgency: 2,
        dueAt: "2026-09-10T00:00:00.000Z",
        createdBy: { memberId: "99999999-9999-4999-8999-999999999999" },
        assignee: null,
        participants: [],
        controls: [],
      },
      relatedWorkspaces: [{
        id: "44444444-4444-4444-8444-444444444444",
        title: "Архитектура локального индекса",
      }],
    },
  }],
  workspaceEntries: [{
    id: "44444444-4444-4444-8444-444444444444",
    title: "Архитектура локального индекса",
    description: "Неизменяемые поколения и один writer",
    state: "active",
    ownerScope: "project",
    project: { id: "22222222-2222-4222-8222-222222222222", slug: "mobile" },
    accessibleThroughProjectIds: ["22222222-2222-4222-8222-222222222222"],
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
  agentSkills: {
    company: [{
      id: "calendar",
      catalogSlug: "calendar",
      title: "Календарь отпусков",
      description: "Проверяет отсутствия и рабочий график",
      searchTerms: ["отпуск", "отсутствие", "график"],
      version: "1.2.3",
      catalogVisibility: "platform",
      sources: ["company"],
      integrationRouting: null,
      readiness: { company: "not_required", personal: "not_checked" },
      connection: null,
    }],
    projects: [],
  },
};

test("local mirror search ranks structured and workspace context without remote query data", () => {
  const result = searchCompanyContextMirror(
    mirror,
    ["релевантный поиск контекста", "fencing token"],
    10,
  );

  assert.equal(result.provider, "local_company_context");
  assert.equal(result.rankingPolicyVersion, "context-search-v1");
  assert.deepEqual(result.queries, ["релевантный поиск контекста", "fencing token"]);
  assert.equal(result.results.some(({ type }) => type === "task"), true);
  assert.equal(result.results.some(({ type }) => type === "workspace_file"), true);
  assert.equal(
    searchCompanyContextMirror(mirror, ["архитектура локального индекса"], 10)
      .results.some(({ type, id }) => (
        type === "workspace"
        && id === "workspace:44444444-4444-4444-8444-444444444444"
      )),
    true,
  );
  assert.equal(JSON.stringify(result).includes("remote"), false);
});

test("local task corpus keeps useful controls but excludes status and people", () => {
  const corpusMirror = structuredClone(mirror);
  const task = corpusMirror.tasks[0].payload.task;
  task.status = { code: "statusuniquenoise", name: "statusuniquenoise" };
  task.assignee = { displayName: "assigneeuniquenoise" };
  task.participants = [{ displayName: "participantuniquenoise" }];
  task.controls = [{ note: "controluniquesignal", visibility: "shared" }];

  assert.equal(
    searchCompanyContextMirror(corpusMirror, ["controluniquesignal"], 10)
      .results.some((result) => result.type === "task"),
    true,
  );
  for (const excludedQuery of [
    "statusuniquenoise",
    "assigneeuniquenoise",
    "participantuniquenoise",
  ]) {
    assert.equal(
      searchCompanyContextMirror(corpusMirror, [excludedQuery], 10)
        .results.some((result) => result.type === "task"),
      false,
    );
  }
});

test("local mixed search gives contacts no implicit type priority", () => {
  const rankingMirror = structuredClone(mirror);
  rankingMirror.tasks[0].projectSlug = "a-mobile";
  rankingMirror.tasks[0].payload.task.title = "Orion";
  rankingMirror.contextDocuments.push({
    id: "ffffffff-ffff-4fff-8fff-ffffffffffff",
    type: "contact",
    title: "Orion",
    revisionToken: "e".repeat(64),
    projectId: null,
    projectSlug: null,
    payload: {
      contact: {
        id: "ffffffff-ffff-4fff-8fff-ffffffffffff",
        displayName: "Orion",
        aliases: [],
        tags: [],
        channels: [],
        identifiers: [],
      },
    },
  });

  const mixed = searchCompanyContextMirror(rankingMirror, ["Orion"], 10)
    .results.filter((result) => result.type === "task" || result.type === "contact");

  assert.deepEqual(mixed.map((result) => result.type), ["task", "contact"]);
});

test("local search exposes archived workspaces as marked read-only history outside default inventory", () => {
  const archivedWorkspaceId = "77777777-7777-4777-8777-777777777777";
  const archivedWorkspace = {
    ...mirror,
    workspaceEntries: [...mirror.workspaceEntries, {
      id: archivedWorkspaceId,
      title: "История миграции каталога",
      description: "Архивное решение по индексу",
      state: "archived",
      ownerScope: "project",
      project: { id: "22222222-2222-4222-8222-222222222222", slug: "mobile" },
      accessibleThroughProjectIds: ["22222222-2222-4222-8222-222222222222"],
      permissions: { canRead: true, canWrite: false, canApprove: false },
    }],
    workspaces: [...mirror.workspaces, {
      id: archivedWorkspaceId,
      scopeType: "project",
      scopeKey: `workspace:${archivedWorkspaceId}`,
      taskId: null,
      acceptedHead: "e".repeat(40),
      documents: [{
        path: "notes/migration-history.md",
        name: "migration-history.md",
        sizeBytes: 48,
        text: "Историческое решение по переносу каталога.",
      }],
    }],
  };

  const workspaceResult = searchCompanyContextMirror(
    archivedWorkspace,
    ["история миграции каталога"],
    10,
  ).results.find((result) => result.id === `workspace:${archivedWorkspaceId}`);
  assert.equal(workspaceResult?.title, "[Архив] История миграции каталога");
  assert.equal(workspaceResult?.workspaceState, "archived");

  const fileResult = searchWorkspaceFilesFromMirror(
    archivedWorkspace,
    ["историческое решение"],
    10,
  ).results.find((result) => result.workspaceId === archivedWorkspaceId);
  assert.equal(fileResult?.title, "[Архив] migration-history.md");
  assert.equal(fileResult?.workspaceState, "archived");

  const activeInventory = handleNativeLocalContextRead(
    archivedWorkspace,
    "list_workspaces",
    { projectSlug: "mobile" },
  );
  assert.equal(
    activeInventory.workspaces.some((workspace) => workspace.id === archivedWorkspaceId),
    false,
  );
  const completeInventory = handleNativeLocalContextRead(
    archivedWorkspace,
    "list_workspaces",
    { projectSlug: "mobile", includeArchived: true },
  );
  const archivedInventoryEntry = completeInventory.workspaces.find((workspace) => (
    workspace.id === archivedWorkspaceId
  ));
  assert.equal(archivedInventoryEntry?.state, "archived");
  assert.equal(archivedInventoryEntry?.permissions?.canWrite, false);

  const exactWorkspace = fetchMirrorResult(
    archivedWorkspace,
    `workspace:${archivedWorkspaceId}`,
  );
  assert.equal(exactWorkspace.workspace.title, "История миграции каталога");
  assert.equal(exactWorkspace.workspace.permissions.canWrite, false);
});

test("agent-skill routing searches hydrated catalog terms only in the local mirror", () => {
  const result = handleNativeLocalContextRead(mirror, "search_agent_skills", {
    companySlug: "acme",
    query: "кто в отпуске",
    hints: ["отсутствие"],
    limit: 5,
  });

  assert.equal(result.skills.length, 1);
  assert.equal(result.skills[0].id, "calendar");
  assert.equal(result.skills[0].match.rank, 1);
  assert.deepEqual(result.query, { text: "кто в отпуске", hints: ["отсутствие"] });
});

test("native personal task reads keep the ordinary MCP list shape and local query", () => {
  const result = handleNativeLocalContextRead(mirror, "list_my_tasks", {
    companySlug: "acme",
    query: "офлайн контекст",
    relation: "created",
    archiveState: "active",
    limit: 50,
  });

  assert.equal(result.tasks.length, 1);
  assert.equal(result.tasks[0].project.slug, "mobile");
  assert.equal(result.tasks[0].descriptionPreview.includes("релевантного контекста"), true);
  assert.deepEqual(result.pagination, { limit: 50, offset: 0, total: 1, hasMore: false });
  assert.equal(result.filters.query, "офлайн контекст");
  assert.equal(Object.hasOwn(result, "provider"), false);
});

test("native exact-task reads preserve schema-v3 instruction and deferred-section shape", () => {
  const result = handleNativeLocalContextRead(mirror, "get_task", {
    companySlug: "acme",
    projectSlug: "mobile-legacy",
    taskNumber: 17,
  });

  assert.equal(result.effectiveInstructions.schemaVersion, 3);
  assert.equal(result.effectiveInstructions.status, "loaded");
  assert.equal(result.tasks[0].locator.projectSlug, "mobile");
  assert.deepEqual(result.tasks[0].proposalProvider, {
    automatic: true,
    provider: "local_company_context",
    server: "trelio-remote-skills",
    contextTool: "get_trelio_local_proposal_context",
    renderTool: "render_trelio_local_proposal",
    companySlug: "acme",
    target: { projectSlug: "mobile", taskNumber: 17 },
  });
  assert.equal(result.tasks[0].task.title, "Исправить офлайн синхронизацию");
  assert.equal(result.tasks[0].task.deferredSections.tool, "get_task_sections");
  assert.equal(result.tasks[0].task.deferredSections.available.length, 10);
  assert.equal(Object.hasOwn(result.tasks[0].task, "comments"), false);
  assert.equal(
    result.tasks[0].task.deferredSections.available.find(({ name }) => name === "comments")?.itemCount,
    null,
  );
});

test("local task cores never present the manual-search subset as the full comment count", () => {
  const taskWithSearchComments = structuredClone(mirror);
  taskWithSearchComments.tasks[0].payload.task.commentsIncluded = true;
  taskWithSearchComments.tasks[0].payload.task.comments = [{ id: "manual-comment" }];

  const unknownCount = handleNativeLocalContextRead(taskWithSearchComments, "get_task", {
    companySlug: "acme",
    projectSlug: "mobile",
    taskNumber: 17,
  });
  assert.equal(
    unknownCount.tasks[0].task.deferredSections.available
      .find(({ name }) => name === "comments")?.itemCount,
    null,
  );

  taskWithSearchComments.tasks[0].payload.task.commentsPagination = { total: 3 };
  const exactCount = handleNativeLocalContextRead(taskWithSearchComments, "get_task", {
    companySlug: "acme",
    projectSlug: "mobile",
    taskNumber: 17,
  });
  assert.equal(
    exactCount.tasks[0].task.deferredSections.available
      .find(({ name }) => name === "comments")?.itemCount,
    3,
  );
});

test("native task search keeps ordinary lexical result ids and never needs a remote query", () => {
  const result = handleNativeLocalContextRead(mirror, "search_tasks", {
    queries: ["офлайн синхронизация", "релевантный контекст"],
    companySlugs: ["acme"],
    projectSlugs: ["mobile-legacy"],
    limit: 20,
  });

  assert.equal(result.searchMode, "lexical");
  assert.equal(result.rankingPolicyVersion, "context-search-v1");
  assert.equal(result.tasks.length, 1);
  assert.equal(result.tasks[0].id, "task:acme/mobile/17");
  assert.equal(result.tasks[0].matchCount, 2);
  assert.deepEqual(result.scope.projectSlugs, ["mobile"]);
});

test("native task refinement uses controls but not status or people in the local provider", () => {
  const corpusMirror = structuredClone(mirror);
  const task = corpusMirror.tasks[0].payload.task;
  task.status = { code: "statusrefinementnoise", name: "statusrefinementnoise" };
  task.assignee = { displayName: "assigneerefinementnoise" };
  task.participants = [{ displayName: "participantrefinementnoise" }];
  task.controls = [{ note: "controlrefinementsignal", visibility: "shared" }];

  const search = (query) => handleNativeLocalContextRead(corpusMirror, "search_tasks", {
    queries: [query],
    companySlugs: ["acme"],
    projectSlugs: ["mobile"],
    limit: 20,
  });

  assert.equal(search("controlrefinementsignal").tasks[0]?.matches[0]?.source, "control");
  for (const excludedQuery of [
    "statusrefinementnoise",
    "assigneerefinementnoise",
    "participantrefinementnoise",
  ]) {
    assert.equal(search(excludedQuery).tasks.length, 0);
  }
});

test("local action schema stays provider-neutral and does not advertise crypto mechanics", () => {
  assert.equal(TRELIO_LOCAL_ACTION_TOOL.name, "continue_trelio_local_action");
  assert.deepEqual(TRELIO_LOCAL_ACTION_TOOL.inputSchema.required, [
    "companySlug",
    "nativeTool",
    "arguments",
  ]);
  assert.equal(TRELIO_LOCAL_ACTION_TOOL.inputSchema.additionalProperties, false);
  assert.equal(TRELIO_LOCAL_ACTION_TOOL.inputSchema.properties.localFilePath.type, "string");
  assert.doesNotMatch(
    JSON.stringify(TRELIO_LOCAL_ACTION_TOOL),
    /cipher|private.?key|e2ee|encryption key/iu,
  );
});

test("local task attachment staging keeps the path local and builds plain stream metadata", async () => {
  const sourceDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "trelio-local-upload-test-"));
  const sourcePath = path.join(sourceDirectory, "Планы этажей.pdf");
  const sourceBytes = Buffer.from("%PDF-1.7\nstreaming attachment test\n%%EOF", "utf8");
  await fs.writeFile(sourcePath, sourceBytes, { mode: 0o600 });
  let staging;

  try {
    staging = await stageLocalTaskAttachmentUpload(sourcePath);
    assert.notEqual(staging.stagedFilePath, sourcePath);
    assert.equal(staging.sizeBytes, sourceBytes.byteLength);
    assert.equal(staging.sha256, crypto.createHash("sha256").update(sourceBytes).digest("hex"));
    assert.deepEqual(await fs.readFile(staging.stagedFilePath), sourceBytes);

    const prepared = await buildLocalTaskAttachmentStreamRequest({
      rawArguments: {
        companySlug: "acme",
        projectSlug: "mobile",
        taskNumber: 17,
        clientRequestId: "stream-plain-pdf",
        dataBase64: "must-not-cross-the-boundary",
        localFilePath: "/must/not/cross/the-boundary.pdf",
      },
      staging,
    });
    assert.equal(prepared.value.fileName, "Планы этажей.pdf");
    assert.equal(prepared.value.contentType, "application/pdf");
    assert.equal(prepared.value.delivery, "local-stream");
    assert.equal(prepared.value.sizeBytes, sourceBytes.byteLength);
    assert.equal(prepared.value.sha256, staging.sha256);
    assert.equal(Object.hasOwn(prepared.value, "dataBase64"), false);
    assert.equal(Object.hasOwn(prepared.value, "localFilePath"), false);
    assert.equal(Object.hasOwn(prepared.value, "encryptedSourceFingerprint"), false);
    assert.equal(JSON.stringify(prepared.value).includes(sourcePath), false);
  } finally {
    if (staging) {
      await fs.rm(staging.temporaryDirectory, { recursive: true, force: true });
    }
    await fs.rm(sourceDirectory, { recursive: true, force: true });
  }
});

test("encrypted local task attachment stays binary and decrypts to the staged source", async () => {
  const sourceDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "trelio-encrypted-upload-test-"));
  const sourcePath = path.join(sourceDirectory, "secret.pdf");
  const sourceBytes = Buffer.from("%PDF-1.7\nconfidential floor plan\n%%EOF", "utf8");
  await fs.writeFile(sourcePath, sourceBytes, { mode: 0o600 });
  const device = await createAgentEncryptionDevice();
  const companyEncryption = {
    runtime: {
      company: { id: "11111111-1111-4111-8111-111111111111", slug: "acme" },
      scope: {
        id: "22222222-2222-4222-8222-222222222222",
        epoch: 1,
        publicEncryptionJwk: device.publicEncryptionJwk,
      },
      device: { id: "33333333-3333-4333-8333-333333333333" },
    },
    device,
    scopePrivateEncryptionKey: {
      privateKey: device.privateKeys.encryptionPrivateKey,
      privateJwk: device.privateBundle.encryptionPrivateJwk,
    },
  };
  let staging;
  let opened;

  try {
    staging = await stageLocalTaskAttachmentUpload(sourcePath);
    const prepared = await buildLocalTaskAttachmentStreamRequest({
      rawArguments: {
        companySlug: "acme",
        projectSlug: "mobile",
        taskNumber: 17,
        fileName: "secret.pdf",
        contentType: "application/pdf",
        clientRequestId: "stream-encrypted-pdf",
      },
      staging,
      companyEncryption,
    });
    assert.equal(prepared.value.delivery, "local-stream");
    assert.equal(Object.hasOwn(prepared.value, "dataBase64"), false);
    assert.match(prepared.value.fileName, /^~e1:/u);
    assert.match(prepared.value.contentType, /^~e1:/u);
    assert.match(prepared.value.encryptedSourceFingerprint, /^[0-9a-f]{64}$/u);
    assert.notEqual(prepared.value.encryptedSourceFingerprint, staging.sha256);
    assert.equal((await fs.stat(prepared.uploadFilePath)).size, prepared.sizeBytes);
    await assert.rejects(fs.stat(staging.stagedFilePath), { code: "ENOENT" });

    const ciphertext = await fs.readFile(prepared.uploadFilePath);
    opened = await decryptFileFromCompanyContainerBytes({
      bytes: ciphertext,
      scopePrivateKey: device.privateKeys.encryptionPrivateKey,
      scopePrivateJwk: device.privateBundle.encryptionPrivateJwk,
      expectedCiphertextSha256: prepared.sha256,
      maximumPlaintextBytes: 1024,
    });
    assert.deepEqual(opened.bytes, sourceBytes);
    assert.equal(opened.originalName, "secret.pdf");
    assert.equal(opened.mimeType, "application/pdf");

    const metadata = await decryptCompanyPayload({
      encryptedPayload: prepared.payloads[0],
      scopePrivateKey: device.privateKeys.encryptionPrivateKey,
      scopePrivateJwk: device.privateBundle.encryptionPrivateJwk,
    });
    assert.deepEqual(metadata.values, {
      original_name: "secret.pdf",
      mime_type: "application/pdf",
    });
  } finally {
    opened?.bytes.fill(0);
    if (staging) {
      await fs.rm(staging.temporaryDirectory, { recursive: true, force: true });
    }
    await fs.rm(sourceDirectory, { recursive: true, force: true });
  }
});

test("encrypted task attachment metadata retries three transient network responses", async () => {
  let attempts = 0;
  const server = http.createServer(async (request, response) => {
    for await (const _chunk of request) {
      // Consume the exact small JSON request before deciding its response.
    }
    attempts += 1;
    if (attempts <= 3) {
      response.writeHead(503, { "content-type": "application/json" });
      response.end(JSON.stringify({ message: "temporary payload storage outage" }));
      return;
    }
    response.writeHead(201, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    const address = server.address();
    await uploadLocalTaskAttachmentPayloads({
      origin: `http://127.0.0.1:${address.port}`,
      token: "test-token",
      companyEncryption: {
        runtime: {
          company: { slug: "acme" },
          device: { id: "33333333-3333-4333-8333-333333333333" },
        },
      },
      payloads: [{ entityId: "payload-1" }],
      retryDelaysMs: [1, 1, 1],
    });
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }

  assert.equal(attempts, 4);
});

test("task attachment session recovery never replays the one-use proof-bearing action", async () => {
  const uploadId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const requests = [];
  let recoveryAttempts = 0;
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    requests.push({
      method: request.method,
      url: request.url,
      body: Buffer.concat(chunks).toString("utf8"),
    });

    if (request.method === "POST") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        isError: true,
        structuredContent: {
          code: "TASK_ATTACHMENT_UPLOAD_SESSION_IN_PROGRESS",
          retryable: true,
        },
        content: [{ type: "text", text: "retry" }],
      }));
      return;
    }

    recoveryAttempts += 1;
    if (recoveryAttempts <= 3) {
      response.writeHead(409, { "content-type": "application/json", "retry-after": "0" });
      response.end(JSON.stringify({
        code: "TASK_ATTACHMENT_UPLOAD_SESSION_NOT_READY",
        message: "not committed yet",
      }));
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      uploadSession: {
        id: uploadId,
        uploadPath: `/api/agent-workspaces/task-attachment-uploads/${uploadId}/content`,
        sizeBytes: 17,
        sha256: "a".repeat(64),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
    }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  const actionRequest = {
    nativeTool: "upload_attachment",
    runtimeSessionProof: { nonce: "one-use-proof" },
    arguments: {
      companySlug: "acme",
      projectSlug: "mobile",
      taskNumber: 17,
      delivery: "local-stream",
      clientRequestId: "prepare-retry",
    },
  };

  try {
    const address = server.address();
    const result = await prepareLocalTaskAttachmentUploadSession({
      origin: `http://127.0.0.1:${address.port}`,
      token: "test-token",
      companySlug: "acme",
      actionRequest,
      retryDelaysMs: [1, 1, 1],
    });
    assert.equal(result.structuredContent.uploadSession.id, uploadId);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }

  assert.equal(requests.filter((request) => request.method === "POST").length, 1);
  assert.equal(requests.filter((request) => request.method === "GET").length, 4);
  assert.equal(requests[0].body, JSON.stringify(actionRequest));
  assert.ok(requests.slice(1).every((request) => (
    request.url.includes("/task-attachment-uploads/resolve?clientRequestId=prepare-retry")
    && !request.url.includes("one-use-proof")
    && request.body === ""
  )));
});

test("binary task attachment upload reopens the same file for three safe retries", async () => {
  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "trelio-upload-retry-test-"));
  const uploadFilePath = path.join(temporaryDirectory, "attachment.bin");
  const bytes = Buffer.from("same immutable attachment bytes", "utf8");
  const digest = crypto.createHash("sha256").update(bytes).digest("hex");
  await fs.writeFile(uploadFilePath, bytes, { mode: 0o600 });
  const receivedBodies = [];
  const receivedHeaders = [];
  const uploadId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    receivedBodies.push(Buffer.concat(chunks));
    receivedHeaders.push(request.headers);
    if (receivedBodies.length <= 3) {
      response.writeHead(503, { "content-type": "application/json" });
      response.end(JSON.stringify({ message: "Temporary storage outage" }));
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    const address = server.address();
    const result = await uploadLocalTaskAttachmentStream({
      origin: `http://127.0.0.1:${address.port}`,
      token: "test-token",
      uploadSession: {
        id: uploadId,
        uploadPath: `/api/agent-workspaces/task-attachment-uploads/${uploadId}/content`,
        sizeBytes: bytes.byteLength,
        sha256: digest,
      },
      uploadFilePath,
      retryDelaysMs: [1, 1, 1],
    });
    assert.deepEqual(result.structuredContent, { ok: true });
    assert.deepEqual(result.content, [{ type: "text", text: JSON.stringify({ ok: true }) }]);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
  }

  assert.equal(receivedBodies.length, 4);
  for (let index = 0; index < receivedBodies.length; index += 1) {
    assert.deepEqual(receivedBodies[index], bytes);
    assert.equal(receivedHeaders[index]["content-length"], String(bytes.byteLength));
    assert.equal(receivedHeaders[index]["x-trelio-content-sha256"], digest);
  }
});

test("local action protects nested task content and converts Markdown before upload", async () => {
  const device = await createAgentEncryptionDevice();
  const companyEncryption = {
    runtime: {
      company: { id: "11111111-1111-4111-8111-111111111111", slug: "acme" },
      scope: {
        id: "22222222-2222-4222-8222-222222222222",
        epoch: 1,
        publicEncryptionJwk: device.publicEncryptionJwk,
      },
      device: { id: "33333333-3333-4333-8333-333333333333" },
    },
    device,
    scopePrivateEncryptionKey: {
      privateKey: device.privateKeys.encryptionPrivateKey,
      privateJwk: device.privateBundle.encryptionPrivateJwk,
    },
  };
  const protectedRequest = await protectLocalActionArguments({
    nativeTool: "create_task",
    arguments: {
      companySlug: "acme",
      projectSlug: "e-44444444-4444-4444-8444-444444444444",
      title: "Секретная задача",
      descriptionMarkdown: "## План\n\n- Первый шаг\n- Второй шаг",
      checklists: [{ title: "Проверка", items: [{ content: "Не утечь" }] }],
      statusCode: "todo",
      clientRequestId: "create-task-test",
    },
    companyEncryption,
  });

  assert.match(protectedRequest.value.title, /^~e1:/u);
  assert.equal(Object.hasOwn(protectedRequest.value, "descriptionMarkdown"), false);
  assert.equal(protectedRequest.value.descriptionJson.$trelioE2ee.v, 1);
  assert.match(protectedRequest.value.checklists[0].title, /^~e1:/u);
  assert.match(protectedRequest.value.checklists[0].items[0].content, /^~e1:/u);
  assert.equal(protectedRequest.value.companySlug, "acme");
  assert.equal(protectedRequest.value.statusCode, "todo");
  assert.doesNotMatch(JSON.stringify(protectedRequest.value), /Секретная|Первый шаг|Не утечь/u);

  const decryptedValues = [];
  for (const payload of protectedRequest.payloads) {
    decryptedValues.push(await decryptCompanyPayload({
      encryptedPayload: payload,
      scopePrivateKey: device.privateKeys.encryptionPrivateKey,
      scopePrivateJwk: device.privateBundle.encryptionPrivateJwk,
    }));
  }
  assert.match(JSON.stringify(decryptedValues), /Секретная задача/u);
  assert.match(JSON.stringify(decryptedValues), /bulletList/u);
  assert.match(JSON.stringify(decryptedValues), /Не утечь/u);

  const contactRequest = await protectLocalActionArguments({
    nativeTool: "create_contact",
    arguments: {
      companySlug: "acme",
      kind: "person",
      displayName: "Закрытый контакт",
      channels: [{ kind: "email", value: "private@example.test", source: "Лично" }],
      identifiers: [{ kind: "other", value: "Скрытый идентификатор" }],
    },
    companyEncryption,
  });
  assert.match(contactRequest.value.channels[0].value, /^~e1:/u);
  assert.match(contactRequest.value.identifiers[0].value, /^~e1:/u);
  assert.doesNotMatch(JSON.stringify(contactRequest.value), /private@example|Скрытый идентификатор/u);

  const mirrorWithCustomFields = structuredClone(mirror);
  mirrorWithCustomFields.tasks[0].payload.task.customFields = {
    fields: [
      { id: "text-field", fieldType: "text" },
      { id: "date-field", fieldType: "date" },
    ],
  };
  const customFieldRequest = await protectLocalActionArguments({
    nativeTool: "apply_task_patch",
    arguments: {
      companySlug: "acme",
      projectSlug: "mobile-legacy",
      taskNumber: 17,
      customFieldValues: [
        { fieldId: "text-field", value: "Закрытая заметка" },
        { fieldId: "date-field", value: "2026-09-02" },
      ],
      clientRequestId: "custom-fields-test",
    },
    companyEncryption,
    mirror: mirrorWithCustomFields,
  });
  assert.match(customFieldRequest.value.customFieldValues[0].value, /^~e1:/u);
  assert.equal(customFieldRequest.value.customFieldValues[1].value, "2026-09-02");
  assert.doesNotMatch(JSON.stringify(customFieldRequest.value), /Закрытая заметка/u);

  await assert.rejects(
    protectLocalActionArguments({
      nativeTool: "update_task_custom_field",
      arguments: {
        companySlug: "acme",
        projectSlug: "mobile",
        taskNumber: 17,
        fieldId: "missing-field",
        value: "Неизвестный тип",
        clientRequestId: "missing-custom-field-test",
      },
      companyEncryption,
      mirror: mirrorWithCustomFields,
    }),
    (error) => error?.code === "LOCAL_ACTION_CUSTOM_FIELD_TYPE_UNKNOWN",
  );
});

test("encrypted registry actions preserve row identity and typed structure across chats", async () => {
  const device = await createAgentEncryptionDevice();
  const companyEncryption = {
    runtime: {
      company: { id: "11111111-1111-4111-8111-111111111111", slug: "acme" },
      scope: {
        id: "22222222-2222-4222-8222-222222222222",
        epoch: 1,
        publicEncryptionJwk: device.publicEncryptionJwk,
      },
      device: { id: "33333333-3333-4333-8333-333333333333" },
    },
    device,
    scopePrivateEncryptionKey: {
      privateKey: device.privateKeys.encryptionPrivateKey,
      privateJwk: device.privateBundle.encryptionPrivateJwk,
    },
  };
  const registryMirror = structuredClone(mirror);
  const registry = registryMirror.contextDocuments[0];
  registry.payload.registry = {
    id: registry.id,
    slug: "e-66666666-6666-4666-8666-666666666666",
    columns: [
      { key: "supplier", label: "Поставщик", type: "text", required: true },
      { key: "state", label: "Статус", type: "select", required: true, options: ["Новый", "Проверен"] },
      { key: "rating", label: "Оценка", type: "number", required: false },
      { key: "site", label: "Сайт", type: "url", required: false },
    ],
  };
  registry.payload.rows = [{
    id: "77777777-7777-4777-8777-777777777777",
    rowKey: "supplier-1",
    revision: 2,
    values: { supplier: "Север", state: "Проверен", rating: 5, site: "https://example.test" },
  }];
  registryMirror.registryRowLocators = {
    [registry.id]: {
      "77777777-7777-4777-8777-777777777777": "~e1:88888888-8888-4888-8888-888888888888:row_key~",
    },
  };
  const argumentsValue = {
    companySlug: "acme",
    projectSlug: "mobile-legacy",
    registrySlug: "e-66666666-6666-4666-8666-666666666666",
    rows: [
      {
        rowKey: "supplier-1",
        expectedRevision: 2,
        values: { supplier: "Север-2", state: "Проверен", rating: 4, site: "https://north.test" },
        sourceRefs: [{ label: "Карточка", url: "https://source.test" }],
      },
      {
        rowKey: "supplier-2",
        expectedRevision: 0,
        values: { supplier: "Юг", state: "Новый", rating: 3 },
      },
    ],
    changeSummary: "Обновить поставщиков",
    clientRequestId: "registry-upsert-1",
  };
  const first = await protectLocalActionArguments({
    nativeTool: "upsert_registry_rows",
    arguments: argumentsValue,
    companyEncryption,
    mirror: registryMirror,
  });
  const second = await protectLocalActionArguments({
    nativeTool: "upsert_registry_rows",
    arguments: argumentsValue,
    companyEncryption,
    mirror: registryMirror,
  });

  assert.equal(first.value.rows[0].rowKey, registryMirror.registryRowLocators[registry.id]["77777777-7777-4777-8777-777777777777"]);
  assert.match(first.value.rows[1].rowKey, /^~e1:.*:row_key~$/u);
  assert.equal(first.value.rows[1].rowKey, second.value.rows[1].rowKey);
  assert.equal(first.value.rows[0].values.rating, 4);
  assert.match(first.value.rows[0].values.supplier, /^~e1:/u);
  assert.match(first.value.rows[0].values.state, /^~e1:/u);
  assert.match(first.value.rows[0].values.site, /^~e1:/u);
  assert.match(first.value.rows[0].sourceRefs[0].label, /^~e1:/u);
  assert.match(first.value.rows[0].sourceRefs[0].url, /^~e1:/u);
  assert.deepEqual(
    first.payloads.map((payload) => payload.entityId),
    second.payloads.map((payload) => payload.entityId),
  );
  assert.doesNotMatch(JSON.stringify(first.value), /Север-2|Юг|Обновить поставщиков|source\.test/u);

  const archive = await protectLocalActionArguments({
    nativeTool: "archive_registry_rows",
    arguments: {
      companySlug: "acme",
      projectSlug: "mobile",
      registrySlug: "e-66666666-6666-4666-8666-666666666666",
      rows: [{ rowKey: "supplier-1", expectedRevision: 2 }],
      changeSummary: "Архивировать строку",
      clientRequestId: "registry-archive-1",
    },
    companyEncryption,
    mirror: registryMirror,
  });
  assert.equal(archive.value.rows[0].rowKey, first.value.rows[0].rowKey);
  assert.match(archive.value.changeSummary, /^~e1:/u);
});

test("encrypted local action retry uploads the missing part of a mixed payload batch", async () => {
  const device = await createAgentEncryptionDevice();
  const companyEncryption = {
    runtime: {
      company: { id: "11111111-1111-4111-8111-111111111111", slug: "acme" },
      scope: {
        id: "22222222-2222-4222-8222-222222222222",
        epoch: 1,
        publicEncryptionJwk: device.publicEncryptionJwk,
      },
      device: { id: "33333333-3333-4333-8333-333333333333" },
    },
    device,
    scopePrivateEncryptionKey: {
      privateKey: device.privateKeys.encryptionPrivateKey,
      privateJwk: device.privateBundle.encryptionPrivateJwk,
    },
  };
  const registryMirror = structuredClone(mirror);
  const registry = registryMirror.contextDocuments[0];
  registry.payload.registry = {
    id: registry.id,
    slug: "e-66666666-6666-4666-8666-666666666666",
    columns: [{ key: "supplier", label: "Поставщик", type: "text", required: true }],
  };
  registry.payload.rows = [];
  registryMirror.registryRowLocators = { [registry.id]: {} };
  const baseArguments = {
    companySlug: "acme",
    projectSlug: "mobile",
    registrySlug: registry.payload.registry.slug,
    rows: [{
      rowKey: "supplier-1",
      expectedRevision: 0,
      values: { supplier: "Север" },
      verificationStatus: "preliminary",
    }],
    changeSummary: "Создать поставщика",
    clientRequestId: "registry-partial-retry",
  };
  const first = await protectLocalActionArguments({
    nativeTool: "upsert_registry_rows",
    arguments: baseArguments,
    companyEncryption,
    mirror: registryMirror,
  });
  const corrected = await protectLocalActionArguments({
    nativeTool: "upsert_registry_rows",
    arguments: {
      ...baseArguments,
      rows: [{
        ...baseArguments.rows[0],
        sourceRefs: [{ label: "Карточка", url: "https://source.test" }],
      }],
    },
    companyEncryption,
    mirror: registryMirror,
  });
  const conflicting = await protectLocalActionArguments({
    nativeTool: "upsert_registry_rows",
    arguments: {
      ...baseArguments,
      rows: [{
        ...baseArguments.rows[0],
        values: { supplier: "Юг" },
        sourceRefs: [{ label: "Карточка", url: "https://source.test" }],
      }],
    },
    companyEncryption,
    mirror: registryMirror,
  });
  const storedByEntity = new Map(first.payloads.map((payload) => [payload.entityId, payload]));
  const postedBatchSizes = [];
  let resolveCount = 0;
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));

    if (request.url === "/api/agent-workspaces/encryption/payloads/resolve") {
      resolveCount += 1;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        payloads: body.entityIds
          .map((entityId) => storedByEntity.get(entityId))
          .filter(Boolean),
      }));
      return;
    }

    if (request.url === "/api/agent-workspaces/encryption/payloads") {
      postedBatchSizes.push(body.payloads.length);
      const hasConflictingExisting = body.payloads.some((payload) => {
        const existing = storedByEntity.get(payload.entityId);
        return existing && existing.ciphertextSha256 !== payload.ciphertextSha256;
      });
      if (hasConflictingExisting) {
        response.writeHead(409, { "content-type": "application/json" });
        response.end(JSON.stringify({
          code: "COMPANY_ENCRYPTION_CONFLICT",
          message: "Encrypted payload revision is stale; expected 2.",
        }));
        return;
      }
      for (const payload of body.payloads) storedByEntity.set(payload.entityId, payload);
      response.writeHead(201, { "content-type": "application/json" });
      response.end(JSON.stringify({ stored: body.payloads.length }));
      return;
    }

    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ message: "Not found" }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    const address = server.address();
    await uploadLocalActionPayloads({
      origin: `http://127.0.0.1:${address.port}`,
      token: "test-token",
      companyEncryption,
      payloads: corrected.payloads,
      expectedPayloadValues: corrected.expectedPayloadValues,
    });
    await assert.rejects(
      uploadLocalActionPayloads({
        origin: `http://127.0.0.1:${address.port}`,
        token: "test-token",
        companyEncryption,
        payloads: conflicting.payloads,
        expectedPayloadValues: conflicting.expectedPayloadValues,
      }),
      (error) => error instanceof TrelioApiError && error.statusCode === 409,
    );
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }

  assert.equal(resolveCount, 2);
  assert.equal(storedByEntity.size, corrected.payloads.length);
  assert.deepEqual(postedBatchSizes, [corrected.payloads.length, 1, conflicting.payloads.length]);
});

test("encrypted task mutation rebuilds every derived document field from hydrated task data", () => {
  const hydratedTask = {
    number: 17,
    title: "Расшифрованный заголовок",
    publicPath: "/acme/mobile/tasks/17/",
    isArchived: false,
    archivedAt: null,
    status: { name: "В работе" },
    urgency: 2,
    dueAt: "2026-09-10T00:00:00.000Z",
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-03T00:00:00.000Z",
    createdBy: { displayName: "Автор" },
    assignee: { displayName: "Исполнитель" },
    participants: [{ displayName: "Участник" }],
    controls: [{
      id: "control-1",
      controlDate: "2026-09-04",
      visibility: "shared",
      note: "Расшифрованный контроль",
    }],
    parentTask: null,
    subtasks: [],
    descriptionPlainText: "Расшифрованное описание",
    checklists: [{
      title: "Расшифрованный чек-лист",
      items: [{ content: "Расшифрованный пункт", isCompleted: true, linkedTask: null }],
    }],
    availableMembers: [],
    availableMemberGroups: [],
    customFields: {
      fields: [{
        name: "Расшифрованное поле",
        fieldType: "text",
        settings: { fieldType: "text" },
        value: "Расшифрованное значение",
      }],
    },
    attachments: [{
      id: "attachment-1",
      originalName: "расшифрованный-файл.txt",
      mimeType: "text/plain",
      sizeBytes: 42,
    }],
    comments: [{
      type: "manual",
      author: "Комментатор",
      datetime: "2026-09-03T01:02:03.000Z",
      content: {
        type: "doc",
        content: [{
          type: "paragraph",
          content: [{ type: "text", text: "Расшифрованный комментарий" }],
        }],
      },
    }],
  };
  const staleDocument = {
    id: "task:acme:mobile:17",
    title: "~e1:11111111-1111-4111-8111-111111111111:title~ · Мобильное приложение",
    text: "Задача: ~e1:11111111-1111-4111-8111-111111111111:title~\n"
      + "Описание: ~e1:11111111-1111-4111-8111-111111111111:description_plain_text~\n"
      + "Комментарии:\n- Комментатор: (пустой комментарий)",
    url: "https://trelio.ru/acme/mobile/tasks/17/",
    metadata: {
      type: "task",
      company: "acme",
      project: "mobile",
      taskNumber: 17,
    },
  };
  const input = {
    structuredContent: {
      ok: true,
      task: hydratedTask,
      document: staleDocument,
    },
  };

  const rebuilt = rebuildHydratedLocalActionTaskDocuments({
    value: input,
    mirror,
    origin: "https://trelio.ru",
  });
  const document = rebuilt.structuredContent.document;

  assert.equal(document.title, "Расшифрованный заголовок · Мобильное приложение");
  assert.match(document.text, /Задача: Расшифрованный заголовок/u);
  assert.match(document.text, /Описание:\nРасшифрованное описание/u);
  assert.match(document.text, /Расшифрованный контроль/u);
  assert.match(document.text, /\[x\] Расшифрованный пункт/u);
  assert.match(document.text, /Расшифрованное поле: Расшифрованное значение/u);
  assert.match(document.text, /расшифрованный-файл\.txt/u);
  assert.match(document.text, /Расшифрованный комментарий/u);
  assert.doesNotMatch(document.text, /~e1:|\(пустой комментарий\)/u);
  assert.equal(input.structuredContent.document, staleDocument);
});

test("local Markdown conversion preserves malformed fences as visible text", () => {
  const document = buildLocalMarkdownDocument("```js\nconst answer = 42;");
  assert.match(JSON.stringify(document), /```js/u);
  assert.match(JSON.stringify(document), /const answer = 42/u);
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

test("archived contacts and registry rows require the same explicit native flags locally", () => {
  const archiveMirror = structuredClone(mirror);
  const registry = archiveMirror.contextDocuments[0];
  const archivedValueOnly = "archived-value-only-71f4e6";
  registry.payload.registry = {
    id: registry.id,
    slug: "supplier-registry",
    title: "Реестр поставщиков",
    columns: [
      { key: "state", label: "Статус", type: "select", options: ["Проверен", "Архив"] },
      { key: "document", label: "Документ", type: "document" },
    ],
  };
  registry.payload.rows = [
    { id: "70000000-0000-4000-8000-000000000001", rowKey: "Север", values: { state: "Проверен" }, revision: 1, isTechnical: false, isArchived: false },
    { id: "70000000-0000-4000-8000-000000000002", rowKey: "Скрытый", values: { state: archivedValueOnly }, revision: 2, isTechnical: false, isArchived: true },
  ];
  // Registry history intentionally retains the before/after snapshots used by
  // explicit audit reads. The ordinary index must not rediscover an archived
  // row through that historical copy after filtering payload.rows.
  registry.payload.history = [
    { id: "h1", before: { values: { state: archivedValueOnly } } },
    { id: "h2", after: { values: { state: archivedValueOnly } } },
  ];
  archiveMirror.contextDocuments.push({
    id: "80000000-0000-4000-8000-000000000001",
    type: "contact",
    title: "Архивный контакт",
    revisionToken: "e".repeat(64),
    projectId: null,
    projectSlug: null,
    payload: {
      contact: {
        id: "80000000-0000-4000-8000-000000000001",
        displayName: "Архивный контакт",
        isArchived: true,
      },
    },
  });

  const activeRegistry = handleNativeLocalContextRead(archiveMirror, "get_registry", {
    companySlug: "acme",
    projectSlug: "mobile",
    registrySlug: "supplier-registry",
  });
  assert.deepEqual(activeRegistry.document.payload.rows.map((row) => row.rowKey), ["Север"]);
  assert.equal(activeRegistry.document.payload.page.total, 1);

  const completeRegistry = handleNativeLocalContextRead(archiveMirror, "get_registry", {
    companySlug: "acme",
    projectSlug: "mobile",
    registrySlug: "supplier-registry",
    includeArchivedRows: true,
    sortDirection: "desc",
    historyLimit: 1,
  });
  assert.deepEqual(completeRegistry.document.payload.rows.map((row) => row.rowKey), ["Скрытый", "Север"]);
  assert.equal(completeRegistry.document.payload.page.total, 2);
  assert.equal(completeRegistry.document.payload.history.length, 1);
  assert.throws(
    () => handleNativeLocalContextRead(archiveMirror, "get_registry", {
      companySlug: "acme",
      projectSlug: "mobile",
      registrySlug: "supplier-registry",
      filters: { document: "opaque-file" },
    }),
    /does not support exact filtering/u,
  );

  const ordinaryContacts = handleNativeLocalContextRead(archiveMirror, "list_contacts", {
    companySlug: "acme",
  });
  const allContacts = handleNativeLocalContextRead(archiveMirror, "list_contacts", {
    companySlug: "acme",
    includeArchived: true,
  });
  assert.equal(ordinaryContacts.total, 0);
  assert.equal(allContacts.total, 1);
  assert.equal(
    handleNativeLocalContextRead(archiveMirror, "get_contact", {
      companySlug: "acme",
      contactId: "80000000-0000-4000-8000-000000000001",
    }).document.payload.contact.isArchived,
    true,
  );

  const ordinarySearch = searchCompanyContextMirror(
    archiveMirror,
    ["проверен", "скрытый", archivedValueOnly, "архивный контакт"],
    10,
  );
  assert.equal(ordinarySearch.results.some((result) => (
    result.type === "registry" && result.matchedQueries.includes("проверен")
  )), true);
  assert.equal(ordinarySearch.results.some((result) => (
    result.type === "contact"
    || result.preview?.includes("Скрытый")
    || result.preview?.includes(archivedValueOnly)
  )), false);
  assert.equal(
    ordinarySearch.results.some((result) => (
      result.type === "registry" && result.matchedQueries.includes(archivedValueOnly)
    )),
    false,
  );
});

test("local inventory is bounded and task result ids round-trip exactly", () => {
  const listed = listCompanyContextMirror(mirror, "tasks", 0, 50, "mobile");

  assert.equal(listed.total, 1);
  assert.equal(listed.items[0].id, "task:acme/mobile/17");
  const fetched = fetchMirrorResult(mirror, listed.items[0].id);
  assert.equal(fetched.task.title, "Исправить офлайн синхронизацию");
  assert.equal(fetched.generation, mirror.generation);
});

test("historical project slugs resolve to canonical mirror records", () => {
  const listedTasks = listCompanyContextMirror(mirror, "tasks", 0, 50, "mobile-legacy");
  const listedWorkspaces = listCompanyContextMirror(mirror, "workspaces", 0, 50, "mobile-legacy");
  const listedRegistries = listCompanyContextMirror(mirror, "registries", 0, 50, "mobile-legacy");
  const fetched = fetchMirrorResult(mirror, "task:acme/mobile-legacy/17");

  assert.equal(listedTasks.total, 1);
  assert.equal(listedTasks.items[0].projectSlug, "mobile");
  assert.equal(listedWorkspaces.total, 1);
  assert.equal(listedRegistries.total, 1);
  assert.equal(fetched.task.title, "Исправить офлайн синхронизацию");
});

test("native workspace reads preserve project links and unambiguous result ids", () => {
  const listed = handleNativeLocalContextRead(mirror, "list_workspaces", {
    companySlug: "acme",
    projectSlug: "mobile-legacy",
  });
  const fetched = handleNativeLocalContextRead(mirror, "get_workspace", {
    workspaceId: "44444444-4444-4444-8444-444444444444",
  });
  const fileSearch = searchWorkspaceFilesFromMirror(mirror, ["fencing token"], 10);

  assert.equal(listed.workspaces.length, 1);
  assert.equal(fetched.workspace.title, "Архитектура локального индекса");
  assert.equal(fetched.effectiveInstructions.agentInstructionsSnapshot, null);
  assert.match(fileSearch.results[0].id, /^workspace-file:/u);
  assert.equal(
    fetchMirrorResult(mirror, fileSearch.results[0].id).file.path,
    "notes/decision.md",
  );
});

test("native fetch ids and pre-encryption URLs resolve through the canonical local mirror", () => {
  const urlMirror = structuredClone(mirror);
  // A persisted generation may have been written by a compatible older host
  // with an origin shape that is no longer suitable as a WHATWG URL base.
  // Fetch locators are structural and must not depend on that stored field.
  urlMirror.origin = "legacy-origin-without-scheme";
  urlMirror.contextDocuments[0].payload.registry.slug = "suppliers";
  urlMirror.contextDocuments[0].payload.registry.slugAliases = ["suppliers-legacy"];
  urlMirror.contextDocuments.push(
    {
      id: "88888888-8888-4888-8888-888888888888",
      type: "knowledge_page",
      title: "Инструкция",
      revisionToken: "e".repeat(64),
      projectId: null,
      projectSlug: null,
      payload: { page: { slug: "handbook", title: "Инструкция" } },
    },
    {
      id: "99999999-9999-4999-8999-999999999999",
      type: "contact",
      title: "Контакт",
      revisionToken: "f".repeat(64),
      projectId: null,
      projectSlug: null,
      payload: {
        contact: {
          id: "99999999-9999-4999-8999-999999999999",
          displayName: "Контакт",
        },
      },
    },
  );

  // A pasted URL is the common entry path for `fetch`. The historical slug
  // must select the immutable project id and return the current canonical
  // route, just like exact get_task and proposal targets already do.
  const legacyUrl = "https://trelio.ru/acme/mobile-legacy/tasks/17/";
  const fetchedTask = handleNativeLocalContextRead(urlMirror, "fetch", { id: legacyUrl });
  assert.equal(fetchedTask.task.title, "Исправить офлайн синхронизацию");
  assert.equal(fetchedTask.project.slug, "mobile");

  // Stable ids can survive in an older chat across the moment when a company
  // enables encryption, so accept both native colon ids and local slash ids.
  assert.equal(
    fetchMirrorResult(urlMirror, "task:acme:mobile-legacy:17").task.title,
    "Исправить офлайн синхронизацию",
  );
  assert.equal(fetchMirrorResult(urlMirror, "project:acme:mobile-legacy").project.slug, "mobile");
  assert.equal(
    fetchMirrorResult(urlMirror, "registry:acme:project:mobile-legacy:suppliers-legacy")
      .document.payload.registry.slug,
    "suppliers",
  );
  assert.equal(
    fetchMirrorResult(urlMirror, "knowledge-page:acme:handbook").document.payload.page.slug,
    "handbook",
  );
  assert.equal(
    fetchMirrorResult(
      urlMirror,
      "contact:acme:99999999-9999-4999-8999-999999999999",
    ).document.payload.contact.displayName,
    "Контакт",
  );
  assert.equal(
    fetchMirrorResult(
      urlMirror,
      `workspace-file:55555555-5555-4555-8555-555555555555:${"c".repeat(40)}:notes%2Fdecision.md`,
    ).file.path,
    "notes/decision.md",
  );

  assert.equal(
    fetchMirrorResult(urlMirror, "https://trelio.ru/acme/mobile-legacy/registries/suppliers-legacy/")
      .document.payload.registry.slug,
    "suppliers",
  );
  assert.equal(
    fetchMirrorResult(urlMirror, "/acme/mobile-legacy/tasks/17/").task.title,
    "Исправить офлайн синхронизацию",
  );
  assert.equal(
    fetchMirrorResult(urlMirror, "https://trelio.ru/acme/pages/handbook/").document.payload.page.slug,
    "handbook",
  );
  assert.equal(
    fetchMirrorResult(
      urlMirror,
      "https://trelio.ru/acme/contacts/99999999-9999-4999-8999-999999999999/",
    ).document.payload.contact.displayName,
    "Контакт",
  );
  assert.equal(
    fetchMirrorResult(urlMirror, "https://trelio.ru/acme/mobile-legacy/").project.slug,
    "mobile",
  );
  assert.throws(
    () => fetchMirrorResult(urlMirror, "https://trelio.ru/other/mobile/tasks/17/"),
    (error) => error?.code === "LOCAL_CONTEXT_INVALID_INPUT",
  );
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
    TRELIO_LOCAL_PROPOSAL_CONTEXT_TOOL,
    TRELIO_LOCAL_PROPOSAL_RENDER_TOOL,
    TRELIO_LOCAL_WORKSPACE_TOOL,
  ]);

  assert.equal(Buffer.byteLength(schemas, "utf8") <= 3_500, true);
  assert.doesNotMatch(schemas, /encrypt|e2ee|cipher|private key/iu);
  assert.deepEqual(TRELIO_LOCAL_CONTEXT_TOOL.inputSchema.properties.operation.enum, [
    "native_read",
    "search",
    "search_workspace_files",
    "list",
    "get_task",
    "fetch",
    "get_workspace_file",
  ]);
  assert.equal(TRELIO_LOCAL_CONTEXT_TOOL.annotations.readOnlyHint, true);
  assert.equal(TRELIO_LOCAL_PROPOSAL_CONTEXT_TOOL.annotations.readOnlyHint, true);
  assert.equal(TRELIO_LOCAL_PROPOSAL_CONTEXT_TOOL._meta, undefined);
  assert.equal(TRELIO_LOCAL_PROPOSAL_RENDER_TOOL.annotations.readOnlyHint, false);
  assert.deepEqual(TRELIO_LOCAL_PROPOSAL_RENDER_TOOL.inputSchema.properties.kind.enum, [
    "comment",
    "status",
    "control_clear",
    "checklist",
    "bundle",
  ]);
  assert.deepEqual(
    TRELIO_LOCAL_PROPOSAL_RENDER_TOOL.inputSchema.properties.operation.enum,
    ["save", "action"],
  );
  assert.equal(
    TRELIO_LOCAL_PROPOSAL_RENDER_TOOL._meta.ui.resourceUri,
    TRELIO_LOCAL_PROPOSAL_RESOURCE_URI,
  );
  assert.doesNotMatch(schemas, /continue_trelio_local_proposal/u);
  assert.deepEqual(TRELIO_LOCAL_WORKSPACE_TOOL.inputSchema.properties.operation.enum, [
    "list_revisions",
    "get_revision_diff",
    "read_revision_file",
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
  const workspaceArguments = buildEncryptedRestoreHandoffArguments("project");
  assert.equal(workspaceArguments.includes("--file"), false);
  assert.equal(workspaceArguments.includes("--task-outcome"), false);
  assert.deepEqual(
    buildEncryptedRestoreHandoffArguments("task").slice(-2),
    ["--task-outcome", "no_status_change"],
  );
});

test("local encrypted history reproduces bounded native diff and file reads", async () => {
  const repository = await fs.mkdtemp(path.join(os.tmpdir(), "trelio-local-history-test-"));
  const git = (argumentsList) => execFileAsync("git", argumentsList, {
    cwd: repository,
    encoding: "utf8",
  });
  const objectPointer = [
    "version https://trelio.ru/spec/workspace-object/v1",
    `oid sha256:${"a".repeat(64)}`,
    "size 12345",
    "content-type application/pdf",
    "",
  ].join("\n");

  try {
    await git(["init", "--initial-branch=main"]);
    await git(["config", "user.name", "Trelio tests"]);
    await git(["config", "user.email", "tests@trelio.local"]);
    await Promise.all([
      fs.mkdir(path.join(repository, ".trelio"), { recursive: true }),
      fs.mkdir(path.join(repository, "artifacts"), { recursive: true }),
      fs.mkdir(path.join(repository, "sources"), { recursive: true }),
    ]);
    await Promise.all([
      fs.writeFile(path.join(repository, "AGENTS.md"), "base control\n"),
      fs.writeFile(path.join(repository, ".trelio", "workspace.json"), "base metadata\n"),
      fs.writeFile(path.join(repository, "artifacts", "report.md"), "base line\nsecond line\n"),
      fs.writeFile(path.join(repository, "artifacts", "old-name.md"), "rename me\n"),
      fs.writeFile(path.join(repository, "sources", "manual.pdf"), objectPointer),
    ]);
    await git(["add", "--all"]);
    await git(["commit", "-m", "base"]);
    const baseHead = (await git(["rev-parse", "HEAD"])).stdout.trim();

    await Promise.all([
      fs.writeFile(path.join(repository, "AGENTS.md"), "after control\n"),
      fs.writeFile(path.join(repository, ".trelio", "workspace.json"), "after metadata\n"),
      fs.writeFile(path.join(repository, "artifacts", "report.md"), "after line\nsecond line\nthird line\n"),
    ]);
    await git(["mv", "artifacts/old-name.md", "artifacts/new-name.md"]);
    await git(["add", "--all"]);
    await git(["commit", "-m", "after"]);
    const acceptedHead = (await git(["rev-parse", "HEAD"])).stdout.trim();

    const manifest = await inspectLocalWorkspaceRevisionDiff({
      repositoryDirectory: repository,
      baseHead,
      acceptedHead,
    });
    assert.equal(manifest.files.some((file) => file.newPath === "artifacts/report.md"), true);
    assert.equal(manifest.files.some((file) => file.status === "renamed"), true);
    assert.equal(manifest.files.some((file) => file.newPath === "AGENTS.md"), false);
    assert.equal(manifest.files.some((file) => file.newPath?.startsWith(".trelio/")), false);

    const boundedPatch = await inspectLocalWorkspaceRevisionDiff({
      repositoryDirectory: repository,
      baseHead,
      acceptedHead,
      filePath: "artifacts/report.md",
      patchLimit: 12,
    });
    assert.equal(boundedPatch.patch.length, 12);
    assert.equal(boundedPatch.patchTruncated, true);
    assert.equal(boundedPatch.nextPatchOffset, 12);

    const before = await readLocalWorkspaceRevisionFile({
      repositoryDirectory: repository,
      revisionHead: baseHead,
      filePath: "artifacts/report.md",
      offset: 5,
      limit: 4,
    });
    assert.equal(before.text, "line");
    assert.equal(before.nextOffset, 9);
    const pointer = await readLocalWorkspaceRevisionFile({
      repositoryDirectory: repository,
      revisionHead: acceptedHead,
      filePath: "sources/manual.pdf",
    });
    assert.equal(pointer.text, null);
    assert.deepEqual(pointer.externalObject, {
      sha256: "a".repeat(64),
      sizeBytes: 12345,
      contentType: "application/pdf",
    });
    await assert.rejects(
      inspectLocalWorkspaceRevisionDiff({
        repositoryDirectory: repository,
        baseHead,
        acceptedHead,
        filePath: "AGENTS.md",
      }),
      (error) => error?.code === "LOCAL_WORKSPACE_PROTECTED_PATH",
    );
    await assert.rejects(
      readLocalWorkspaceRevisionFile({
        repositoryDirectory: repository,
        revisionHead: acceptedHead,
        filePath: "artifacts/report.md",
        limit: 0,
      }),
      (error) => error?.code === "LOCAL_CONTEXT_INVALID_INPUT",
    );
  } finally {
    await fs.rm(repository, { recursive: true, force: true });
  }
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

test("encrypted proposal publication verifies the hydrated persisted plaintext", () => {
  const publication = {
    comment: {
      content: {
        type: "doc",
        content: [{
          type: "paragraph",
          content: [
            { type: "mention", attrs: { username: "reviewer" } },
            { type: "text", text: ", проверено" },
            { type: "hardBreak" },
            { type: "text", text: "Можно публиковать." },
          ],
        }, {
          type: "paragraph",
          content: [{
            type: "text",
            text: "result.txt",
            marks: [{
              type: "link",
              attrs: {
                href: "https://trelio.example/attachment",
                taskAttachmentKind: "file",
                taskAttachmentId: "11111111-1111-4111-8111-111111111111",
              },
            }],
          }],
        }],
      },
    },
  };

  assert.equal(
    assertHydratedLocalProposalPublicationMatches({
      publication,
      expectedBodyText: "@reviewer, проверено\nМожно публиковать.",
    }),
    publication,
  );
  assert.throws(
    () => assertHydratedLocalProposalPublicationMatches({
      publication,
      expectedBodyText: "Другой текст",
    }),
    (error) => error?.code === "LOCAL_CONTEXT_PROPOSAL_PUBLICATION_MISMATCH",
  );
  assert.throws(
    () => assertHydratedLocalProposalPublicationMatches({
      publication: { comment: {} },
      expectedBodyText: "Можно публиковать.",
    }),
    (error) => error?.code === "LOCAL_CONTEXT_PROPOSAL_PUBLICATION_MISMATCH",
  );
});

test("decrypted mirror residency has the exact ten-minute hard TTL", () => {
  assert.equal(TRELIO_LOCAL_MIRROR_MEMORY_TTL_SECONDS, 600);
});

test("stale supplemental task sections refresh the mirror and repeat only the read", async () => {
  const staleReady = { mirror: "stale" };
  const freshReady = { mirror: "fresh" };
  const reads = [];
  let refreshCount = 0;

  const result = await readTaskSectionsWithRevisionRefresh({
    initialReady: staleReady,
    readSections: async (ready) => {
      reads.push(ready.mirror);
      if (ready === staleReady) {
        throw new TrelioApiError(
          409,
          "Task context changed while deferred local sections were being read.",
          null,
          "LOCAL_CONTEXT_GENERATION_CHANGED",
        );
      }
      return { sections: { comments: { comments: [] } } };
    },
    refreshReady: async () => {
      refreshCount += 1;
      return freshReady;
    },
  });

  assert.deepEqual(reads, ["stale", "fresh"]);
  assert.equal(refreshCount, 1);
  assert.deepEqual(result, { sections: { comments: { comments: [] } } });
});

test("task-section refresh remains fail-closed for unrelated and repeated conflicts", async () => {
  const unrelated = new TrelioApiError(
    409,
    "Another conflict",
    null,
    "ANOTHER_CONFLICT",
  );
  assert.equal(isLocalTaskSectionRevisionConflict(unrelated), false);
  await assert.rejects(
    readTaskSectionsWithRevisionRefresh({
      initialReady: { mirror: "stale" },
      readSections: async () => { throw unrelated; },
      refreshReady: async () => assert.fail("Unrelated conflicts must not refresh."),
    }),
    (error) => error === unrelated,
  );

  const revisionConflict = new TrelioApiError(
    409,
    "Task context changed while deferred local sections were being read.",
    null,
    "LOCAL_CONTEXT_GENERATION_CHANGED",
  );
  let readCount = 0;
  let refreshCount = 0;
  await assert.rejects(
    readTaskSectionsWithRevisionRefresh({
      initialReady: { mirror: "stale" },
      readSections: async () => {
        readCount += 1;
        throw revisionConflict;
      },
      refreshReady: async () => {
        refreshCount += 1;
        return { mirror: "still-changing" };
      },
    }),
    (error) => error === revisionConflict,
  );
  assert.equal(readCount, 2);
  assert.equal(refreshCount, 1);
});

test("encrypted mirror generations are schema-isolated while mutation coherence spans versions", () => {
  const paths = resolveMirrorPaths({
    origin: "https://trelio.example",
    companyId: "11111111-1111-4111-8111-111111111111",
  });

  assert.equal(paths.root.endsWith("schema-4"), true);
  assert.equal(paths.pointer.startsWith(paths.root), true);
  assert.equal(paths.lock.startsWith(paths.root), true);
  assert.equal(paths.generations.startsWith(paths.root), true);
  assert.equal(paths.mutation.startsWith(paths.root), false);
  assert.equal(paths.mutation, resolveCompanyContextMutationMarkerPath({
    origin: "https://trelio.example",
    companyId: "11111111-1111-4111-8111-111111111111",
  }));
});

test("local action mutation classification is read-only by contract and fail-closed for new verbs", () => {
  for (const nativeTool of [
    "fetch",
    "read_workspace_revision_file",
    "get_task_create_meta",
    "list_projects",
    "search_trelio_tools",
    "resolve_status",
    "plan_task_update",
    "download_attachment",
    "render_task_comment_proposal",
  ]) {
    assert.equal(localActionMayMutateCompanyContext(nativeTool), false, nativeTool);
  }
  for (const nativeTool of ["create_task", "update_task_title", "future_company_write"]) {
    assert.equal(localActionMayMutateCompanyContext(nativeTool), true, nativeTool);
  }
});

test("cross-process mutation marker is owner-private and contains no company content", async () => {
  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "trelio-mirror-marker-"));
  const paths = {
    root: path.join(temporaryDirectory, "schema-4"),
    mutation: path.join(temporaryDirectory, "mutation.json"),
  };
  try {
    assert.equal(await readLocalCompanyMirrorMutationToken(paths), null);
    const firstToken = await signalLocalCompanyMirrorMutation(paths);
    assert.equal(await readLocalCompanyMirrorMutationToken(paths), firstToken);
    const secondToken = await signalLocalCompanyMirrorMutation(paths);
    assert.notEqual(secondToken, firstToken);
    assert.equal(await readLocalCompanyMirrorMutationToken(paths), secondToken);

    const record = JSON.parse(await fs.readFile(paths.mutation, "utf8"));
    assert.deepEqual(Object.keys(record).sort(), ["createdAt", "schemaVersion", "token"]);
    assert.equal(JSON.stringify(record).includes("task"), false);
    assert.equal(JSON.stringify(record).includes("query"), false);
    assert.equal(JSON.stringify(record).includes("content"), false);
    if (process.platform !== "win32") {
      assert.equal((await fs.stat(paths.mutation)).mode & 0o777, 0o600);
    }
  } finally {
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
  }
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
