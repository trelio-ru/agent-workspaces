import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { buildRunContextSpecifications } from "../scripts/trelio-workspace.mjs";

const execFileAsync = promisify(execFile);
const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const bridgePath = path.resolve(testDirectory, "../scripts/trelio-workspace.mjs");
const runId = "11111111-1111-4111-8111-111111111111";
const companyWorkspaceId = "22222222-2222-4222-8222-222222222222";
const relatedWorkspaceId = "33333333-3333-4333-8333-333333333333";
const companyHead = "a".repeat(40);
const relatedHead = "b".repeat(40);

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

test("bridge help advertises the related context sync command", async () => {
  const result = await execFileAsync(process.execPath, [bridgePath, "help"], { encoding: "utf8" });
  assert.match(result.stdout, /Bridge 1\.3\.0/);
  assert.match(result.stdout, /trelio-workspace context sync/);
  assert.match(result.stdout, /trelio-workspace context attach --workspace UUID/);
});
