import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { AGENT_WORKSPACE_RUNTIME_AGENTS_MARKDOWN } from "./trelio-workspace.mjs";
import {
  TRELIO_LOCAL_CONTEXT_TOOL,
  TRELIO_LOCAL_PROPOSAL_TOOL,
  TRELIO_LOCAL_WORKSPACE_TOOL,
} from "./trelio-local-context.mjs";

export const PLUGIN_CONTEXT_BUDGET_SCHEMA_VERSION = 1;

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.resolve(scriptDirectory, "..");

// Это не список всех reference-файлов plugin. Он описывает именно обычный
// task-scoped Run: discovery, lifecycle и три обязательных post-acceptance
// решения. Отдельный bundle-reference добавляется во второй сценарий, потому
// что он нужен только когда в одном ответе действительно появляются 2+ cards.
export const TASK_RUN_REQUIRED_SKILL_PATHS = [
  "skills/trelio-workspace-worker/SKILL.md",
  "skills/trelio-workspace-worker/references/scope-and-context.md",
  "skills/trelio-workspace-worker/references/agent-run.md",
  "skills/trelio-workspace-worker/references/task-run.md",
  "skills/trelio-workspace-worker/references/task-status-proposals.md",
  "skills/trelio-workspace-worker/references/task-comment-proposals.md",
  "skills/trelio-workspace-worker/references/task-checklist-proposals.md",
];

export const TASK_RUN_PROPOSAL_BUNDLE_PATH =
  "skills/trelio-workspace-worker/references/task-proposal-bundles.md";
export const LOCAL_COMPANY_CONTEXT_PATH =
  "skills/trelio-workspace-worker/references/local-company-context.md";

export const PLUGIN_CONTEXT_BUDGET_LIMITS = Object.freeze({
  runtimeAgentsBytes: 10_000,
  workerSkillBytes: 9_000,
  // Durable task–workspace sharing is a required discovery decision for ordinary
  // task Runs, so its bounded policy belongs in scope-and-context rather than a
  // conditionally unread reference. Keep only the exact 1 KiB ceiling increase.
  requiredTaskRunSkillsBytes: 52_000,
  taskRunWithProposalBundleBytes: 55_000,
  requiredTaskRunPluginLayerBytes: 61_000,
  taskRunWithProposalBundlePluginLayerBytes: 64_000,
  localProviderToolSchemasBytes: 3_000,
  plainCompanyTaskRunPluginLayerBytes: 64_000,
  encryptedCompanyTaskRunPluginLayerBytes: 73_000,
});

export const measureContextText = (text) => {
  const normalizedText = String(text ?? "");
  const bytesUtf8 = Buffer.byteLength(normalizedText, "utf8");

  return {
    bytesUtf8,
    // Array.from считает Unicode code points, а не UTF-16 code units. Это
    // делает отчёт стабильным для emoji и русского текста.
    characters: Array.from(normalizedText).length,
    words: normalizedText.match(/\S+/gu)?.length ?? 0,
    // Точного tokenizer-а в plugin нет намеренно. Эта прозрачная эвристика
    // нужна только для сравнения revisions; bytes остаются канонической метрикой.
    estimatedTokensUtf8Div4: Math.ceil(bytesUtf8 / 4),
  };
};

const sumMeasurements = (measurements) => {
  const total = measurements.reduce((sum, measurement) => ({
    bytesUtf8: sum.bytesUtf8 + measurement.bytesUtf8,
    characters: sum.characters + measurement.characters,
    words: sum.words + measurement.words,
  }), { bytesUtf8: 0, characters: 0, words: 0 });

  return {
    ...total,
    estimatedTokensUtf8Div4: Math.ceil(total.bytesUtf8 / 4),
  };
};

const readMeasuredFile = async (relativePath) => {
  const text = await readFile(path.join(pluginRoot, relativePath), "utf8");

  return {
    id: relativePath,
    source: relativePath,
    ...measureContextText(text),
  };
};

export const buildPluginContextBudgetReport = async () => {
  const requiredSkillFiles = await Promise.all(
    TASK_RUN_REQUIRED_SKILL_PATHS.map(readMeasuredFile),
  );
  const proposalBundleFile = await readMeasuredFile(TASK_RUN_PROPOSAL_BUNDLE_PATH);
  const localCompanyContextFile = await readMeasuredFile(LOCAL_COMPANY_CONTEXT_PATH);
  const localProviderToolSchemas = {
    id: "local-provider-tool-schemas",
    source: "scripts/trelio-local-context.mjs#local-provider-tools",
    ...measureContextText(JSON.stringify([
      TRELIO_LOCAL_CONTEXT_TOOL,
      TRELIO_LOCAL_PROPOSAL_TOOL,
      TRELIO_LOCAL_WORKSPACE_TOOL,
    ])),
  };
  const runtimeAgents = {
    id: "runtime-agents",
    source: "scripts/trelio-workspace.mjs#AGENT_WORKSPACE_RUNTIME_AGENTS_MARKDOWN",
    ...measureContextText(AGENT_WORKSPACE_RUNTIME_AGENTS_MARKDOWN),
  };
  const workerSkill = requiredSkillFiles[0];
  const requiredTaskRunSkills = sumMeasurements(requiredSkillFiles);
  const taskRunWithProposalBundle = sumMeasurements([
    ...requiredSkillFiles,
    proposalBundleFile,
  ]);

  return {
    schemaVersion: PLUGIN_CONTEXT_BUDGET_SCHEMA_VERSION,
    kind: "trelio-agent-workspaces-plugin-context-budget",
    estimator: {
      name: "utf8-bytes-div-4",
      note: "Approximation only. UTF-8 bytes are the canonical regression metric.",
    },
    dimensions: {
      requiredTaskRunSkillFiles: TASK_RUN_REQUIRED_SKILL_PATHS.length,
      proposalBundleSkillFiles: TASK_RUN_REQUIRED_SKILL_PATHS.length + 1,
    },
    layers: {
      runtimeAgents,
      workerSkill,
      requiredSkillFiles,
      proposalBundleFile,
      localCompanyContextFile,
      localProviderToolSchemas,
    },
    scenarios: {
      requiredTaskRunSkills,
      taskRunWithProposalBundle,
      requiredTaskRunPluginLayer: sumMeasurements([
        runtimeAgents,
        requiredTaskRunSkills,
      ]),
      taskRunWithProposalBundlePluginLayer: sumMeasurements([
        runtimeAgents,
        taskRunWithProposalBundle,
      ]),
      // Ordinary companies see only three compact provider-neutral schemas. The
      // complete protected-provider manual remains absent from their skill
      // path and therefore cannot consume their task context window.
      plainCompanyTaskRunPluginLayer: sumMeasurements([
        runtimeAgents,
        requiredTaskRunSkills,
        localProviderToolSchemas,
      ]),
      encryptedCompanyTaskRunPluginLayer: sumMeasurements([
        runtimeAgents,
        requiredTaskRunSkills,
        localProviderToolSchemas,
        localCompanyContextFile,
      ]),
    },
    limits: PLUGIN_CONTEXT_BUDGET_LIMITS,
  };
};

const formatNumber = (value) => new Intl.NumberFormat("ru-RU").format(value);

const formatMeasurement = (label, measurement) => (
  `${label.padEnd(42)} ${formatNumber(measurement.bytesUtf8).padStart(10)} B  `
  + `${formatNumber(measurement.estimatedTokensUtf8Div4).padStart(8)} est. tokens`
);

export const formatPluginContextBudgetReport = (report) => [
  "Trelio Agent Workspaces · context budget",
  "",
  formatMeasurement("Runtime AGENTS.md", report.layers.runtimeAgents),
  formatMeasurement("Worker SKILL.md", report.layers.workerSkill),
  formatMeasurement("Required task Run skills", report.scenarios.requiredTaskRunSkills),
  formatMeasurement(
    "Task Run skills + proposal bundle",
    report.scenarios.taskRunWithProposalBundle,
  ),
  formatMeasurement(
    "Required plugin layer",
    report.scenarios.requiredTaskRunPluginLayer,
  ),
  formatMeasurement(
    "Plugin layer + proposal bundle",
    report.scenarios.taskRunWithProposalBundlePluginLayer,
  ),
  formatMeasurement("Local provider tool schemas", report.layers.localProviderToolSchemas),
  formatMeasurement("Plain-company task Run layer", report.scenarios.plainCompanyTaskRunPluginLayer),
  formatMeasurement(
    "Encrypted-company task Run layer",
    report.scenarios.encryptedCompanyTaskRunPluginLayer,
  ),
  "",
  "Token values are estimates: ceil(UTF-8 bytes / 4). Compare exact bytes in CI.",
].join("\n");

const isEntrypoint = process.argv[1]
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isEntrypoint) {
  const report = await buildPluginContextBudgetReport();

  if (process.argv.slice(2).includes("--json")) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(`${formatPluginContextBudgetReport(report)}\n`);
  }
}
