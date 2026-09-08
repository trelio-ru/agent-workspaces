import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { compileContextSearchQuery, matchContextSearchField, normalizeContextSearchQueries } from "../scripts/trelio-context-search-matching.mjs";
import { searchCompanyContextMirror, getWorkspaceFileFromMirror } from "../scripts/trelio-local-context.mjs";

const fixture = JSON.parse(fs.readFileSync(new URL("./fixtures/context-search-matching-v2.json", import.meta.url), "utf8"));
test("local admission follows the shared native/local corpus", () => {
  for (const example of fixture.cases) {
    assert.equal(matchContextSearchField(example.text, compileContextSearchQuery(example.query)), example.matches, example.name);
  }
  assert.equal(normalizeContextSearchQueries(["Документы Мария", "документы Марии", "МАРИИ документы"]).length, 1);
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
  const exact = getWorkspaceFileFromMirror(mirror, { workspaceId: id, workspaceHead: head, filePath: found.path });
  assert.equal(exact.materialize.arguments.operation, "download_file");
  assert.deepEqual(exact.materialize.arguments.parameters, { workspaceId: id, workspaceHead: head, filePath: found.path });
  assert.throws(() => getWorkspaceFileFromMirror(mirror, { workspaceId: id, workspaceHead: "c".repeat(40), filePath: found.path }), { code: "LOCAL_CONTEXT_WORKSPACE_OUTDATED" });
});
