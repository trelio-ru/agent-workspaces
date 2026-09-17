import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  CODEX_TRELIO_DIRECT_TOOL_NAMESPACES,
  CodexRoutingConfigError,
  applyCodexTrelioHookRouting,
  buildCodexRoutingConfigPatch,
  planCodexTrelioHookRouting,
  resolveCodexConfigPath,
} from "../../../host-runtime/scripts/trelio-codex-routing.mjs";

test("Codex config path follows CODEX_HOME and the Windows user profile", () => {
  assert.equal(resolveCodexConfigPath({
    platform: "win32",
    environment: { USERPROFILE: "C:\\Users\\Ada" },
    homeDirectory: "C:\\Fallback",
  }), "C:\\Users\\Ada\\.codex\\config.toml");
  assert.equal(resolveCodexConfigPath({
    platform: "win32",
    environment: { CODEX_HOME: "D:\\CodexData", USERPROFILE: "C:\\Users\\Ada" },
    homeDirectory: "C:\\Fallback",
  }), "D:\\CodexData\\config.toml");
});

test("routing patch creates one focused Code Mode table", () => {
  const patch = buildCodexRoutingConfigPatch("model = \"gpt-test\"\n");

  assert.equal(patch.status, "action_required");
  assert.deepEqual(patch.missingNamespaces, CODEX_TRELIO_DIRECT_TOOL_NAMESPACES);
  assert.equal(
    patch.nextSource,
    "model = \"gpt-test\"\n\n[features.code_mode]\n"
      + "direct_only_tool_namespaces = [\"mcp__trelio\",\"mcp__trelio_remote_skills\"]\n",
  );
});

test("routing patch merges existing namespaces and preserves CRLF plus trailing comments", () => {
  const source = [
    "[features.code_mode]",
    "direct_only_tool_namespaces = [\"mcp__other\", \"mcp__trelio\"] # keep",
    "",
    "[features]",
    "hooks = true",
    "",
  ].join("\r\n");
  const patch = buildCodexRoutingConfigPatch(source);

  assert.equal(patch.status, "action_required");
  assert.deepEqual(patch.missingNamespaces, ["mcp__trelio_remote_skills"]);
  assert.match(
    patch.nextSource,
    /direct_only_tool_namespaces = \["mcp__other", "mcp__trelio", "mcp__trelio_remote_skills"\] # keep\r\n/u,
  );
  assert.equal(patch.nextSource.replaceAll("\r\n", "").includes("\n"), false);

  const ready = buildCodexRoutingConfigPatch(patch.nextSource);
  assert.equal(ready.status, "ready");
  assert.equal(ready.nextSource, patch.nextSource);
});

test("routing patch keeps an existing table and unrelated settings", () => {
  const source = [
    "[features.code_mode]",
    "enabled = false",
    "",
    "[projects.\"C:/work\"]",
    "trust_level = \"trusted\"",
    "",
  ].join("\n");
  const patch = buildCodexRoutingConfigPatch(source);

  assert.match(
    patch.nextSource,
    /enabled = false\n\ndirect_only_tool_namespaces = \["mcp__trelio","mcp__trelio_remote_skills"\]\n\n\[projects\./u,
  );
  assert.match(patch.nextSource, /trust_level = "trusted"/u);
});

test("routing patch recognizes quoted Code Mode table keys", () => {
  const source = [
    "[features.\"code\\U0000005Fmode\"]",
    "'direct_only_tool_namespaces' = ['mcp__other']",
    "",
  ].join("\n");
  const patch = buildCodexRoutingConfigPatch(source);

  assert.equal(patch.status, "action_required");
  assert.match(
    patch.nextSource,
    /'direct_only_tool_namespaces' = \['mcp__other', "mcp__trelio", "mcp__trelio_remote_skills"\]/u,
  );
  assert.doesNotMatch(patch.nextSource, /\n\[features\.code_mode\]\n/u);
});

test("routing patch migrates the legacy Codex feature boolean without changing its value", () => {
  for (const enabled of ["true", "false"]) {
    const source = [
      "[features]",
      `code_mode = ${enabled} # keep state`,
      "hooks = true",
      "",
    ].join("\r\n");
    const patch = buildCodexRoutingConfigPatch(source);

    assert.equal(patch.status, "action_required");
    assert.equal(patch.migratesLegacyBoolean, true);
    assert.doesNotMatch(patch.nextSource, /^code_mode\s*=/mu);
    assert.match(patch.nextSource, /\[features\]\r\nhooks = true/u);
    assert.match(
      patch.nextSource,
      new RegExp(`\\[features\\.code_mode\\]\\r\\nenabled = ${enabled} # keep state`, "u"),
    );
    assert.equal(patch.nextSource.replaceAll("\r\n", "").includes("\n"), false);
  }
});

test("routing patch fails closed for ambiguous tables and commented target arrays", () => {
  assert.throws(
    () => buildCodexRoutingConfigPatch("features = { code_mode = { enabled = true } }\n"),
    (error) => error instanceof CodexRoutingConfigError
      && error.code === "TRELIO_CODEX_ROUTING_CONFIG_UNSUPPORTED",
  );
  assert.throws(
    () => buildCodexRoutingConfigPatch("[features]\ncode_mode = { enabled = false }\n"),
    (error) => error instanceof CodexRoutingConfigError
      && error.code === "TRELIO_CODEX_ROUTING_CONFIG_UNSUPPORTED",
  );
  assert.throws(
    () => buildCodexRoutingConfigPatch("features.code_mode.enabled = true\n"),
    (error) => error instanceof CodexRoutingConfigError
      && error.code === "TRELIO_CODEX_ROUTING_CONFIG_UNSUPPORTED",
  );
  assert.throws(
    () => buildCodexRoutingConfigPatch([
      "[features.code_mode]",
      "direct_only_tool_namespaces = [",
      "  \"mcp__other\", # user note",
      "]",
      "",
    ].join("\n")),
    (error) => error instanceof CodexRoutingConfigError
      && error.code === "TRELIO_CODEX_ROUTING_CONFIG_UNSUPPORTED",
  );
});

test("plan is value-free and apply requires exact confirmation", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "trelio-codex-routing-"));
  const configPath = path.join(directory, "config.toml");
  try {
    await writeFile(configPath, "api_key = \"must-not-leak\"\n", { mode: 0o600 });
    const plan = await planCodexTrelioHookRouting({ configPath });

    assert.equal(plan.status, "action_required");
    assert.match(plan.planHash, /^[0-9a-f]{64}$/u);
    assert.deepEqual(plan.change.add, CODEX_TRELIO_DIRECT_TOOL_NAMESPACES);
    assert.doesNotMatch(JSON.stringify(plan), /must-not-leak|trelio-codex-routing-/u);

    await assert.rejects(
      applyCodexTrelioHookRouting({ configPath, planHash: plan.planHash, confirmed: false }),
      (error) => error.code === "TRELIO_CODEX_ROUTING_CONFIRMATION_REQUIRED",
    );
    const applied = await applyCodexTrelioHookRouting({
      configPath,
      planHash: plan.planHash,
      confirmed: true,
    });
    assert.equal(applied.status, "applied");
    assert.equal(applied.restartRequired, true);
    assert.match(await readFile(configPath, "utf8"), /mcp__trelio_remote_skills/u);

    const ready = await planCodexTrelioHookRouting({ configPath });
    assert.equal(ready.status, "ready");
    assert.equal(ready.planHash, null);
    assert.match(ready.verification, /Пользовательский config Codex/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("apply rejects a stale plan without overwriting the newer config", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "trelio-codex-routing-stale-"));
  const configPath = path.join(directory, "config.toml");
  try {
    await writeFile(configPath, "model = \"first\"\n");
    const plan = await planCodexTrelioHookRouting({ configPath });
    await writeFile(configPath, "model = \"newer\"\n");

    await assert.rejects(
      applyCodexTrelioHookRouting({
        configPath,
        planHash: plan.planHash,
        confirmed: true,
      }),
      (error) => error.code === "TRELIO_CODEX_ROUTING_PLAN_STALE",
    );
    assert.equal(await readFile(configPath, "utf8"), "model = \"newer\"\n");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("plan refuses a non-file config target", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "trelio-codex-routing-unsafe-"));
  const configPath = path.join(directory, "config.toml");
  try {
    await mkdir(configPath);
    await assert.rejects(
      planCodexTrelioHookRouting({ configPath }),
      (error) => error.code === "TRELIO_CODEX_ROUTING_CONFIG_UNSAFE",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
