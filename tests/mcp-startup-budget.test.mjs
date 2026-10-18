import assert from "node:assert/strict";
import test from "node:test";
import {
  createMcpStartupBudget,
  MCP_LOCAL_STARTUP_TIMEOUT_MS,
  MCP_UPDATE_TIMEOUT_MS,
} from "../plugins/trelio-agent-workspaces/scripts/trelio-mcp-startup-budget.mjs";

test("MCP budget counts Node bootstrap/imports before the loader handler", () => {
  let time = new Date(2026, 0, 2, 12).getTime();
  const budget = createMcpStartupBudget({ environment: {}, now: () => time, uptimeMs: 12_000 });
  assert.equal(budget.updateDeadline - time, 8_000);
  assert.equal(budget.deadline - time, 13_000);
  time = budget.deadline;
  assert.throws(() => budget.check("runtime_spawn"), (error) => {
    assert.deepEqual(error.diagnostic, {
      code: "TRELIO_MCP_STARTUP_TIMEOUT", operation: "mcp_startup",
      stage: "runtime_spawn", timeoutKind: "total", timeoutMs: 25_000,
    });
    return true;
  });
});

test("launcher timestamp consumes the existing budget and never adds time", () => {
  const time = new Date(2026, 0, 2, 12).getTime();
  const create = (stamp) => createMcpStartupBudget({
    environment: { TRELIO_MCP_LAUNCH_TIME: stamp }, now: () => time, uptimeMs: 2_000,
  });
  const spent = create(`unix:${(time - 19_000) / 1000}`);
  assert.equal(spent.updateDeadline - time, 1_000);
  assert.equal(spent.deadline - time, 6_000);
  for (const stamp of ["invalid", "unix:0", `unix:${time / 1000 + 100}`, "win-time:25:00:00.00"]) {
    const budget = create(stamp);
    assert.equal(budget.updateDeadline, time - 2_000 + MCP_UPDATE_TIMEOUT_MS);
    assert.equal(budget.deadline, time - 2_000 + MCP_LOCAL_STARTUP_TIMEOUT_MS);
  }
});

test("Windows builtin TIME supports locale decimal separator and midnight", () => {
  const time = new Date(2026, 0, 3, 0, 0, 5, 120).getTime();
  for (const stamp of ["win-time:23:59:55.12", "win-time:23:59:55,12"]) {
    const budget = createMcpStartupBudget({
      environment: { TRELIO_MCP_LAUNCH_TIME: stamp }, now: () => time, uptimeMs: 1_000,
    });
    assert.equal(budget.updateDeadline - time, 10_000);
    assert.equal(budget.deadline - time, 15_000);
  }
  const morning = new Date(2026, 0, 3, 9, 0, 5, 120).getTime();
  const padded = createMcpStartupBudget({
    environment: { TRELIO_MCP_LAUNCH_TIME: "win-time: 9:00:00.12" },
    now: () => morning, uptimeMs: 1_000,
  });
  assert.equal(padded.updateDeadline - morning, 15_000);
});
