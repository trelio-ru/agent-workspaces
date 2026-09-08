import assert from "node:assert/strict";
import test from "node:test";

import {
  CONTEXT_TOKENIZER,
  LOCAL_COMPANY_CONTEXT_PATH,
  PLUGIN_CONTEXT_BUDGET_LIMITS,
  PLUGIN_CONTEXT_TOKEN_LIMITS,
  TASK_RUN_REQUIRED_SKILL_PATHS,
  buildPluginContextBudgetReport,
  isModelVisibleLocalTool,
  measureContextText,
  sumMeasurements,
  formatPluginContextBudgetReport,
} from "../scripts/report-context-budget.mjs";

test("offline o200k counts Russian, Latin and literal special markers independently of byte heuristics", () => {
  // Проверенные в OpenAI tiktoken контрольные векторы: изменение зависимости,
  // кодировки или трактовки специальных маркеров не должно менять сравнение.
  for (const [text, tokens] of [
    ["", 0], ["Hello world", 2], ["Привет, мир!", 5], ["<|endoftext|>", 7],
  ]) assert.equal(measureContextText(text).tokensO200kBase, tokens, text);
  assert.notEqual(measureContextText("Привет, мир!").tokensO200kBase,
    measureContextText("Привет, мир!").estimatedTokensUtf8Div4);
  const parts = [measureContextText("a"), measureContextText("b")];
  assert.equal(sumMeasurements(parts).tokensO200kBase, 2);
  assert.equal(measureContextText("ab").tokensO200kBase, 1);
  assert.equal(sumMeasurements([]).tokensO200kBase, 0);
});

test("typical task Run plugin context stays inside explicit regression ceilings", async () => {
  const report = await buildPluginContextBudgetReport();
  const { layers, scenarios } = report;

  assert.equal(report.schemaVersion, 1);
  assert.deepEqual(report.tokenizer, CONTEXT_TOKENIZER);
  assert.equal(scenarios.requiredTaskRunSkills.tokensO200kBase,
    layers.requiredSkillFiles.reduce((sum, file) => sum + file.tokensO200kBase, 0));
  for (const [name, limit] of Object.entries(PLUGIN_CONTEXT_TOKEN_LIMITS)) {
    const measurement = layers[name] ?? scenarios[name] ?? {
      representativeLocalProposalResult: report.localResponses.proposalRender.compact,
      representativeLocalAttachmentResult: report.localResponses.attachmentDownload.localFile,
    }[name];
    assert.ok(measurement.tokensO200kBase <= limit,
      `${name} grew to ${measurement.tokensO200kBase} o200k_base tokens (ceiling: ${limit})`);
  }
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

test("text report uses counted tokens and JSON retains the separate legacy byte heuristic", async () => {
  const report = await buildPluginContextBudgetReport();
  const formatted = formatPluginContextBudgetReport(report);
  assert.match(formatted, /tokens \(o200k_base\)/u);
  assert.doesNotMatch(formatted, /est\. tokens/u);

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


test("local initialize, visible schemas and actual compact results have regression ceilings", async () => {
  const report = await buildPluginContextBudgetReport();
  for (const name of [
    "localMcpInstructions", "modelVisibleLocalToolSchemas",
    "clientPrefixedLocalToolSchemas", "clientPrefixedTaskRunLocalToolSchemas",
  ]) assert.ok(report.layers[name].bytesUtf8 <= PLUGIN_CONTEXT_BUDGET_LIMITS[`${name}Bytes`], name);
  assert.equal(report.dimensions.localTools, report.dimensions.modelVisibleLocalTools + report.dimensions.appOnlyLocalTools);
  assert.ok(report.dimensions.appOnlyLocalTools > 0);
  assert.equal(report.dimensions.taskRunLocalTools, 1);
  assert.ok(report.layers.clientPrefixedLocalToolSchemas.bytesUtf8 > report.layers.modelVisibleLocalToolSchemas.bytesUtf8);
  for (const name of ["proposalContext", "proposalRender"]) {
    const output = report.localResponses[name];
    assert.ok(output.compact.bytesUtf8 <= PLUGIN_CONTEXT_BUDGET_LIMITS.representativeLocalProposalResultBytes);
    assert.ok(output.compact.bytesUtf8 < output.duplicated.bytesUtf8 * 0.55, name);
    assert.ok(output.compact.tokensO200kBase <= PLUGIN_CONTEXT_TOKEN_LIMITS.representativeLocalProposalResult);
    assert.ok(output.compact.tokensO200kBase < output.duplicated.tokensO200kBase * 0.55, name);
  }
  const attachment = report.localResponses.attachmentDownload;
  assert.equal(report.localResponses.attachmentFileBytes, 1024 * 1024);
  assert.ok(attachment.duplicatedBase64.bytesUtf8 > 2_700_000);
  assert.ok(attachment.localFile.bytesUtf8 <= PLUGIN_CONTEXT_BUDGET_LIMITS.representativeLocalAttachmentResultBytes);
  assert.ok(attachment.localFile.tokensO200kBase <= PLUGIN_CONTEXT_TOKEN_LIMITS.representativeLocalAttachmentResult);
  assert.ok(attachment.duplicatedBase64.tokensO200kBase > 2_000_000,
    "The binary fixture must count its base64 text; it cannot silently become an empty attachment");
  for (const conditional of ["run-recovery.md", "workspace-relations.md"]) {
    assert.ok(!TASK_RUN_REQUIRED_SKILL_PATHS.some((file) => file.endsWith(conditional)));
  }
});

test("local schema accounting excludes App-only tools but includes mixed visibility", () => {
  assert.equal(isModelVisibleLocalTool({}), true);
  assert.equal(isModelVisibleLocalTool({ _meta: { ui: { visibility: ["model", "app"] } } }), true);
  assert.equal(isModelVisibleLocalTool({ _meta: { ui: { visibility: ["app"] } } }), false);
  assert.equal(isModelVisibleLocalTool({ _meta: { "openai/visibility": "private" } }), false);
  assert.equal(isModelVisibleLocalTool({ _meta: { "openai/visibility": "private", ui: { visibility: ["model"] } } }), false);
});
