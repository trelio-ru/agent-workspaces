import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  assertHydratedLocalProposalPublicationMatches,
  canonicalizeProposalTargetFromMirror,
  TRELIO_LOCAL_MIRROR_MEMORY_TTL_SECONDS,
  TRELIO_LOCAL_CONTEXT_TOOL,
  TRELIO_LOCAL_ACTION_TOOL,
  TRELIO_LOCAL_PROPOSAL_TOOL,
  TRELIO_LOCAL_WORKSPACE_TOOL,
  buildEncryptedRestoreHandoffArguments,
  buildLocalMarkdownDocument,
  fetchMirrorResult,
  findPreparedEncryptedRestoreRun,
  getWorkspaceFileFromMirror,
  handleNativeLocalContextRead,
  hydrateChangedCompanyMirrorRecords,
  listCompanyContextMirror,
  localActionMayMutateCompanyContext,
  materializeHistoricalWorkspaceTreeForRestore,
  prepareLocalProposalBundle,
  protectLocalActionArguments,
  readLocalCompanyMirrorMutationToken,
  resolveMirrorPaths,
  searchCompanyContextMirror,
  searchWorkspaceFilesFromMirror,
  selectEncryptedProposalFilesFromManifest,
  signalLocalCompanyMirrorMutation,
} from "../scripts/trelio-local-context.mjs";
import {
  createAgentEncryptionDevice,
  decryptCompanyPayload,
} from "../scripts/trelio-company-encryption.mjs";
import {
  resolveCompanyContextMutationMarkerPath,
} from "../scripts/trelio-workspace.mjs";

const execFileAsync = promisify(execFile);

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
  assert.deepEqual(result.queries, ["релевантный поиск контекста", "fencing token"]);
  assert.equal(result.results.some(({ type }) => type === "task"), true);
  assert.equal(result.results.some(({ type }) => type === "workspace_file"), true);
  assert.equal(JSON.stringify(result).includes("remote"), false);
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
  assert.equal(result.tasks[0].task.title, "Исправить офлайн синхронизацию");
  assert.equal(result.tasks[0].task.deferredSections.tool, "get_task_sections");
  assert.equal(result.tasks[0].task.deferredSections.available.length, 10);
  assert.equal(Object.hasOwn(result.tasks[0].task, "comments"), false);
});

test("native task search keeps ordinary lexical result ids and never needs a remote query", () => {
  const result = handleNativeLocalContextRead(mirror, "search_tasks", {
    queries: ["офлайн синхронизация", "релевантный контекст"],
    companySlugs: ["acme"],
    projectSlugs: ["mobile-legacy"],
    limit: 20,
  });

  assert.equal(result.searchMode, "lexical");
  assert.equal(result.tasks.length, 1);
  assert.equal(result.tasks[0].id, "task:acme/mobile/17");
  assert.equal(result.tasks[0].matchCount, 2);
  assert.deepEqual(result.scope.projectSlugs, ["mobile"]);
});

test("local action schema stays provider-neutral and does not advertise crypto mechanics", () => {
  assert.equal(TRELIO_LOCAL_ACTION_TOOL.name, "continue_trelio_local_action");
  assert.deepEqual(TRELIO_LOCAL_ACTION_TOOL.inputSchema.required, [
    "companySlug",
    "nativeTool",
    "arguments",
  ]);
  assert.equal(TRELIO_LOCAL_ACTION_TOOL.inputSchema.additionalProperties, false);
  assert.doesNotMatch(
    JSON.stringify(TRELIO_LOCAL_ACTION_TOOL),
    /cipher|private.?key|e2ee|encryption key/iu,
  );
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
    { id: "70000000-0000-4000-8000-000000000002", rowKey: "Скрытый", values: { state: "Архив" }, revision: 2, isTechnical: false, isArchived: true },
  ];
  registry.payload.history = [{ id: "h1" }, { id: "h2" }];
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
    ["скрытый", "архивный контакт"],
    10,
  );
  assert.equal(ordinarySearch.results.some((result) => (
    result.type === "contact" || result.preview?.includes("Скрытый")
  )), false);
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
    "native_read",
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

test("encrypted mirror generations are schema-isolated while mutation coherence spans versions", () => {
  const paths = resolveMirrorPaths({
    origin: "https://trelio.example",
    companyId: "11111111-1111-4111-8111-111111111111",
  });

  assert.equal(paths.root.endsWith("schema-3"), true);
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
    root: path.join(temporaryDirectory, "schema-3"),
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
