import assert from "node:assert/strict";
import test from "node:test";

import {
  TRELIO_LOCAL_MIRROR_MEMORY_TTL_SECONDS,
  TRELIO_LOCAL_CONTEXT_TOOL,
  TRELIO_LOCAL_PROPOSAL_TOOL,
  fetchMirrorResult,
  hydrateChangedCompanyMirrorRecords,
  listCompanyContextMirror,
  searchCompanyContextMirror,
} from "../scripts/trelio-local-context.mjs";

const mirror = {
  schemaVersion: 1,
  generation: "a".repeat(64),
  serverGeneration: "b".repeat(64),
  createdAt: "2026-09-01T00:00:00.000Z",
  company: { id: "11111111-1111-4111-8111-111111111111", slug: "acme", name: "Acme" },
  projects: [{
    id: "22222222-2222-4222-8222-222222222222",
    slug: "mobile",
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

test("always-visible local schemas stay compact and provider-neutral", () => {
  const schemas = JSON.stringify([TRELIO_LOCAL_CONTEXT_TOOL, TRELIO_LOCAL_PROPOSAL_TOOL]);

  assert.equal(Buffer.byteLength(schemas, "utf8") <= 3_000, true);
  assert.doesNotMatch(schemas, /encrypt|e2ee|cipher|private key/iu);
  assert.deepEqual(TRELIO_LOCAL_CONTEXT_TOOL.inputSchema.properties.operation.enum, [
    "search",
    "list",
    "get_task",
    "fetch",
  ]);
  assert.equal(TRELIO_LOCAL_CONTEXT_TOOL.annotations.readOnlyHint, true);
  assert.equal(TRELIO_LOCAL_PROPOSAL_TOOL.annotations.readOnlyHint, false);
});

test("decrypted mirror residency has the exact ten-minute hard TTL", () => {
  assert.equal(TRELIO_LOCAL_MIRROR_MEMORY_TTL_SECONDS, 600);
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
