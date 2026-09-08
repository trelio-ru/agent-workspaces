import assert from "node:assert/strict";
import test from "node:test";
import { compactLocalMcpResult } from "../scripts/trelio-mcp-results.mjs";
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
