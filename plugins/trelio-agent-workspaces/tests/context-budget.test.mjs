import assert from "node:assert/strict";
import test from "node:test";

import {
  LOCAL_COMPANY_CONTEXT_PATH,
  PLUGIN_CONTEXT_BUDGET_LIMITS,
  TASK_RUN_REQUIRED_SKILL_PATHS,
  buildPluginContextBudgetReport,
} from "../scripts/report-context-budget.mjs";

test("typical task Run plugin context stays inside explicit regression ceilings", async () => {
  const report = await buildPluginContextBudgetReport();
  const { layers, scenarios } = report;

  assert.equal(report.schemaVersion, 1);
  assert.equal(layers.requiredSkillFiles.length, TASK_RUN_REQUIRED_SKILL_PATHS.length);
  assert.deepEqual(
    layers.requiredSkillFiles.map((file) => file.source),
    TASK_RUN_REQUIRED_SKILL_PATHS,
  );
  assert.ok(
    !TASK_RUN_REQUIRED_SKILL_PATHS.includes(LOCAL_COMPANY_CONTEXT_PATH),
    "Ordinary company task Runs must not load the local-company provider manual",
  );

  assert.ok(
    layers.runtimeAgents.bytesUtf8 <= PLUGIN_CONTEXT_BUDGET_LIMITS.runtimeAgentsBytes,
    `Runtime AGENTS.md grew to ${layers.runtimeAgents.bytesUtf8} bytes`,
  );
  assert.ok(
    layers.workerSkill.bytesUtf8 <= PLUGIN_CONTEXT_BUDGET_LIMITS.workerSkillBytes,
    `Worker SKILL.md grew to ${layers.workerSkill.bytesUtf8} bytes`,
  );
  assert.ok(
    scenarios.requiredTaskRunSkills.bytesUtf8
      <= PLUGIN_CONTEXT_BUDGET_LIMITS.requiredTaskRunSkillsBytes,
    `Required task Run skills grew to ${scenarios.requiredTaskRunSkills.bytesUtf8} bytes`,
  );
  assert.ok(
    scenarios.taskRunWithProposalBundle.bytesUtf8
      <= PLUGIN_CONTEXT_BUDGET_LIMITS.taskRunWithProposalBundleBytes,
    `Task Run skills with proposal bundle grew to ${scenarios.taskRunWithProposalBundle.bytesUtf8} bytes`,
  );
  assert.ok(
    scenarios.requiredTaskRunPluginLayer.bytesUtf8
      <= PLUGIN_CONTEXT_BUDGET_LIMITS.requiredTaskRunPluginLayerBytes,
    `Required plugin layer grew to ${scenarios.requiredTaskRunPluginLayer.bytesUtf8} bytes`,
  );
  assert.ok(
    scenarios.taskRunWithProposalBundlePluginLayer.bytesUtf8
      <= PLUGIN_CONTEXT_BUDGET_LIMITS.taskRunWithProposalBundlePluginLayerBytes,
    `Plugin layer with proposal bundle grew to ${scenarios.taskRunWithProposalBundlePluginLayer.bytesUtf8} bytes`,
  );
  assert.ok(
    layers.localProviderToolSchemas.bytesUtf8
      <= PLUGIN_CONTEXT_BUDGET_LIMITS.localProviderToolSchemasBytes,
    `Provider-neutral local tool schemas grew to ${layers.localProviderToolSchemas.bytesUtf8} bytes`,
  );
  assert.ok(
    scenarios.plainCompanyTaskRunPluginLayer.bytesUtf8
      <= PLUGIN_CONTEXT_BUDGET_LIMITS.plainCompanyTaskRunPluginLayerBytes,
    `Plain-company task Run layer grew to ${scenarios.plainCompanyTaskRunPluginLayer.bytesUtf8} bytes`,
  );
  assert.ok(
    scenarios.encryptedCompanyTaskRunPluginLayer.bytesUtf8
      <= PLUGIN_CONTEXT_BUDGET_LIMITS.encryptedCompanyTaskRunPluginLayerBytes,
    `Encrypted-company task Run layer grew to ${scenarios.encryptedCompanyTaskRunPluginLayer.bytesUtf8} bytes`,
  );
  assert.equal(
    scenarios.encryptedCompanyTaskRunPluginLayer.bytesUtf8
      - scenarios.plainCompanyTaskRunPluginLayer.bytesUtf8,
    layers.localCompanyContextFile.bytesUtf8,
    "The protected-provider manual must be paid only by the encrypted-company scenario",
  );
});

test("token estimate remains an explicit UTF-8 byte heuristic", async () => {
  const report = await buildPluginContextBudgetReport();

  for (const measurement of [
    report.layers.runtimeAgents,
    report.layers.workerSkill,
    ...Object.values(report.scenarios),
  ]) {
    assert.equal(
      measurement.estimatedTokensUtf8Div4,
      Math.ceil(measurement.bytesUtf8 / 4),
    );
  }
});
