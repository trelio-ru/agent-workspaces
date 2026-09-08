import assert from "node:assert/strict";
import test from "node:test";
import { compactLocalMcpResult, compactLocalNativeMcpResult, compactRemoteDoctorPayload } from "../scripts/trelio-mcp-results.mjs";
import { projectMcpAgentPayload } from "../scripts/trelio-agent-response-projection.mjs";
import { handleLocalMcpMessage } from "../scripts/trelio-remote-mcp.mjs";

test("local MCP emits one copy of successful data without altering hidden App capabilities", async () => {
  const structuredContent = { proposalId: "proposal", revision: 2, bodyText: "private proposal".repeat(500) };
  const metadata = { ui: { resourceUri: "ui://trelio/test" }, capabilityToken: "hidden-human-only" };
  const original = { structuredContent, content: [{ type: "text", text: JSON.stringify(structuredContent) }], _meta: metadata };
  const response = await handleLocalMcpMessage({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "fixture" } }, {
    callTool: async () => original,
  });
  assert.equal(response.result.structuredContent, structuredContent);
  assert.equal(response.result._meta, metadata);
  assert.doesNotMatch(response.result.content[0].text, /private proposal|hidden-human-only/u);
  assert.match(response.result.content[0].text, /structuredContent/u);
  assert.ok(JSON.stringify(response.result).length < JSON.stringify(original).length * 0.55);
  assert.equal(compactLocalMcpResult(response.result), response.result);
});

test("local MCP preserves errors, independent text, partial projections and mixed media", () => {
  const structuredContent = { a: 1, b: 2 };
  const duplicate = { structuredContent, content: [{ type: "text", text: JSON.stringify(structuredContent) }] };
  for (const result of [
    null,
    { ...duplicate, isError: true },
    { ...duplicate, content: [{ type: "text", text: "Human explanation" }] },
    { ...duplicate, content: [{ type: "text", text: JSON.stringify({ a: 1 }) }] },
    { ...duplicate, content: [{ type: "text", text: JSON.stringify({ ...structuredContent, extra: "must survive" }) }] },
    { ...duplicate, content: [...duplicate.content, { type: "image", data: "image", mimeType: "image/png" }] },
    { content: duplicate.content },
  ]) assert.equal(compactLocalMcpResult(result), result);
});

test("local projection preserves hydrated notes, explicit states and arbitrary document keys", () => {
  const person = { memberId: "member", displayName: "Анна – закупки", userDisplayName: "Анна Иванова",
    displayNameOverride: "Анна – закупки", profileNote: "Отвечает за договоры", avatarUrl: "image", initials: "АИ", color: "slate" };
  const payload = { schemaVersion: 3, taskRevision: { id: "task", updatedAt: "exact" }, sections: {
    controls: { controls: [{ createdBy: person, permissions: { canClear: false }, note: null }] },
    custom_fields: { customFields: { color: "green", avatarUrl: "user-value" } },
  } };
  const expected = projectMcpAgentPayload("get_task_sections", payload);
  for (const original of [
    { content: [{ type: "text", text: JSON.stringify(payload) }] },
    { structuredContent: payload, content: [{ type: "text", text: JSON.stringify(payload) }], _meta: { secret: "hidden" } },
  ]) {
    const result = compactLocalNativeMcpResult("get_task_sections", original);
    const value = result.structuredContent ?? JSON.parse(result.content[0].text);
    assert.deepEqual(value, expected);
    assert.equal(value.sections.controls.controls[0].createdBy.profileNote, person.profileNote);
    assert.equal(value.sections.controls.controls[0].createdBy.userDisplayName, person.userDisplayName);
    assert.equal("avatarUrl" in value.sections.controls.controls[0].createdBy, false);
    assert.equal(value.sections.controls.controls[0].permissions.canClear, false);
    assert.equal(value.sections.controls.controls[0].note, null);
    assert.deepEqual(value.sections.custom_fields, payload.sections.custom_fields);
    assert.equal(result._meta, original._meta);
  }
});

test("local exact reads restore deferred options without changing errors or human App results", () => {
  const payload = { company: { slug: "demo" }, contact: { id: "contact", description: "Details" }, options: { contacts: ["Другой контакт\n".repeat(100)] } };
  const envelope = { content: [{ type: "text", text: JSON.stringify(payload) }] };
  const compact = JSON.parse(compactLocalNativeMcpResult("get_contact", envelope).content[0].text);
  assert.equal(compact.deferredData.tool, "get_contact");
  const full = compactLocalNativeMcpResult(compact.deferredData.tool, envelope, compact.deferredData.arguments);
  assert.deepEqual(JSON.parse(full.content[0].text), payload);
  const error = { ...envelope, isError: true };
  assert.equal(compactLocalNativeMcpResult("get_contact", error), error);
  for (const tool of ["get_task_proposal_app_state", "render_task_proposals", "external_provider_tool"]) {
    assert.deepEqual(compactLocalNativeMcpResult(tool, envelope), envelope);
  }
});

test("local file read carries exactly one full copy with revision and coverage", () => {
  const payload = { text: "Большой файл\n".repeat(500), revisionHead: "exact-head", truncated: true, nextOffset: 500 };
  const original = { structuredContent: payload, content: [{ type: "text", text: payload.text }] };
  const compact = compactLocalNativeMcpResult("get_agent_workspace_file", original);
  assert.equal(compact.structuredContent, payload);
  assert.doesNotMatch(compact.content[0].text, /Большой файл/);
  assert.equal(compactLocalNativeMcpResult("external_provider_tool", original).content, original.content);
});

test("provider doctor omits only unselected schemas, and exact read restores required arguments", () => {
  const payload = { ok: true, toolPolicy: "all_read_only", configFingerprint: "fingerprint", ignoredTools: [{ name: "write", reason: "write_like_name" }], tools: [
    { name: "read_one", description: "Find records", annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: { type: "object", required: ["sourceId"], properties: { sourceId: { type: "string" } }, additionalProperties: false } },
    { name: "read_two", description: "Read a second domain", inputSchema: { type: "object", required: ["revision"] } },
  ] };
  const args = { companySlug: "demo", projectSlug: "project", skillId: "generic-skill" };
  const catalog = compactRemoteDoctorPayload(payload, args);
  assert.equal(catalog.tools.length, 2);
  assert.equal(catalog.tools[0].inputSchema, undefined);
  assert.deepEqual(catalog.ignoredTools, payload.ignoredTools);
  assert.equal(catalog.configFingerprint, payload.configFingerprint);
  assert.deepEqual(catalog.schemaSelection.arguments, args);
  const exact = compactRemoteDoctorPayload(payload, { ...catalog.schemaSelection.arguments, schemaToolName: "read_one" });
  assert.deepEqual(exact.tools[0], payload.tools[0]);
  assert.equal(exact.tools[1].inputSchema, undefined);
  assert.equal(exact.schemaSelection.found, true);
  assert.equal(compactRemoteDoctorPayload(payload, { ...args, schemaToolName: "unknown" }).schemaSelection.found, false);
  assert.equal(payload.tools[0].inputSchema.required[0], "sourceId", "Original doctor/credential validation result stays intact");
});
