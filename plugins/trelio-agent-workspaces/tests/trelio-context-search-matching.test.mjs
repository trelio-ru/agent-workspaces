import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import {
  buildContextSearchPreview,
  compileContextSearchQuery,
  matchContextSearchField,
  normalizeContextSearchQueries,
} from "../scripts/trelio-context-search-matching.mjs";
import { searchCompanyContextMirror, getWorkspaceFileFromMirror } from "../scripts/trelio-local-context.mjs";

const fixture = JSON.parse(fs.readFileSync(new URL("./fixtures/context-search-matching-v2.json", import.meta.url), "utf8"));
test("local admission follows the shared native/local corpus", () => {
  for (const example of fixture.cases) {
    assert.equal(matchContextSearchField(example.text, compileContextSearchQuery(example.query)), example.matches, example.name);
  }
  assert.equal(normalizeContextSearchQueries(["Документы Мария", "документы Марии", "МАРИИ документы"]).length, 1);
});

test("local preview keeps distant subject and distinguishing evidence within 300 characters", () => {
  const source = [
    "ASUS Принт VPN прокси: базовое описание.",
    "обычный контекст ".repeat(80),
    "Маршрут переведён в fail-open после проверки.",
  ].join(" ");
  const preview = buildContextSearchPreview(source, ["ASUS fail-open маршрут"]);

  assert.ok(preview.length <= 300);
  assert.match(preview, /ASUS/u);
  assert.match(preview, /fail-open/u);
  assert.match(preview, /маршрут/iu);
  assert.match(preview, / … /u);
});

test("local unified search returns five results by default and reports remaining coverage", () => {
  const mirror = {
    company: { id: "11111111-1111-4111-8111-111111111111", slug: "example", name: "Example" },
    generation: "test", serverGeneration: "server-test", createdAt: "2026-09-17T10:00:00.000Z",
    projects: Array.from({ length: 6 }, (_, index) => ({
      id: `22222222-2222-4222-8222-22222222222${index}`,
      slug: `asus-${index}`,
      name: `ASUS ${index}`,
    })),
    tasks: [], workspaceEntries: [], workspaces: [], contextDocuments: [],
  };
  const result = searchCompanyContextMirror(mirror, ["ASUS"]);

  assert.equal(result.results.length, 5);
  assert.equal(result.hasMore, true);
  assert.deepEqual(result.pagination, { limit: 5, total: 6, returned: 5, hasMore: true });
});

test("discovery resolves a binary original above an old registry mention without an inspection", () => {
  const id = "22222222-2222-4222-8222-222222222222";
  const head = "b".repeat(40);
  const mirror = { company: { id: "11111111-1111-4111-8111-111111111111", slug: "example", name: "Example" }, generation: "test",
    workspaceEntries: [{ id, title: "Документы Марии", description: "Личные документы", state: "active" }],
    workspaces: [
      { id, acceptedHead: head, documents: [{ path: "sources/0088--scan_88.jpg", name: "0088--scan_88.jpg", text: "", sizeBytes: 123, contentType: "image/jpeg" }] },
      { id: "33333333-3333-4333-8333-333333333333", acceptedHead: "a".repeat(40), documents: [{ path: "index.md", name: "index.md", text: "Рождение. Дочь. Файл 0088--scan_88.jpg перенесён.", sizeBytes: 100 }] },
    ],
  };
  const title = searchCompanyContextMirror(mirror, ["Документы Мария", "рождение", "дочь"], 1);
  assert.equal(title.results[0].workspaceId, id);
  assert.equal(title.results[0].type, "workspace");
  const found = searchCompanyContextMirror(mirror, ["0088--scan_88.jpg"], 1).results[0];
  assert.equal(found.workspaceId, id);
  assert.equal(found.path, "sources/0088--scan_88.jpg");
  assert.equal("sizeBytes" in found, false);
  assert.equal("contentType" in found, false);
  assert.equal("scopeType" in found, false);
  const exact = getWorkspaceFileFromMirror(mirror, { workspaceId: id, workspaceHead: head, filePath: found.path });
  assert.equal(exact.materialize.arguments.operation, "download_file");
  assert.deepEqual(exact.materialize.arguments.parameters, { workspaceId: id, workspaceHead: head, filePath: found.path });
  assert.throws(() => getWorkspaceFileFromMirror(mirror, { workspaceId: id, workspaceHead: "c".repeat(40), filePath: found.path }), { code: "LOCAL_CONTEXT_WORKSPACE_OUTDATED" });
});
