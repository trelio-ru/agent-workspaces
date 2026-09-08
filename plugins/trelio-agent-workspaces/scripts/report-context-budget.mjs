import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { AGENT_SKILL_ROUTING_INSTRUCTIONS, buildLocalProposalRenderResult, handleLocalMcpMessage, handleToolCall } from "./trelio-remote-mcp.mjs";
import { buildLocalAttachmentFileResult } from "./trelio-local-attachments.mjs";

import { AGENT_WORKSPACE_RUNTIME_AGENTS_MARKDOWN } from "./trelio-workspace.mjs";
import {
  TRELIO_LOCAL_CONTEXT_TOOL,
  TRELIO_LOCAL_PROPOSAL_CONTEXT_TOOL,
  TRELIO_LOCAL_PROPOSAL_RENDER_TOOL,
  TRELIO_LOCAL_WORKSPACE_TOOL,
  TRELIO_WORKSPACE_ACTION_TOOL,
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
  workerSkillBytes: 14_500,
  // Канонические правила русские: кириллица занимает два UTF-8 байта.
  // Пределы учитывают этот язык с небольшим запасом, без дублирования EN/RU.
  // Набор обязательных файлов не расширяется: recovery и local-provider
  // инструкции по-прежнему загружаются только для подходящего сценария.
  requiredTaskRunSkillsBytes: 74_000,
  taskRunWithProposalBundleBytes: 79_000,
  requiredTaskRunPluginLayerBytes: 83_000,
  taskRunWithProposalBundlePluginLayerBytes: 88_000,
  // The added schema is a compact typed dispatcher; it replaces launcher
  // resolution prose in every operational Run and signed-runtime prompt.
  localProviderToolSchemasBytes: 3_800,
  plainCompanyTaskRunPluginLayerBytes: 87_000,
  encryptedCompanyTaskRunPluginLayerBytes: 103_000,
  localMcpInstructionsBytes: 4_000,
  modelVisibleLocalToolSchemasBytes: 13_500,
  clientPrefixedLocalToolSchemasBytes: 69_000,
  clientPrefixedTaskRunLocalToolSchemasBytes: 4_600,
  representativeLocalProposalResultBytes: 14_500,
  representativeLocalAttachmentResultBytes: 1_400,
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

// MCP App-only tools are callable by the App but are not model tool schemas.
// Mixed ["model", "app"] visibility remains visible; private takes precedence.
export const isModelVisibleLocalTool = (tool) => (
  tool._meta?.["openai/visibility"] !== "private"
  && (!Array.isArray(tool._meta?.ui?.visibility) || tool._meta.ui.visibility.includes("model"))
);

const measureModelResult = (result) => measureContextText(JSON.stringify({
  structuredContent: result.structuredContent, content: result.content,
}));
const measureDuplicatedResult = (result) => measureModelResult({
  structuredContent: result.structuredContent,
  content: [{ type: "text", text: JSON.stringify(result.structuredContent) }],
});

const buildLocalResponseMeasurements = async () => {
  // Fixed synthetic content makes versions comparable without reading company
  // data, materializing files or minting hidden App capabilities.
  const proposal = { schemaVersion: 3, currentDraft: {
    proposalId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", revision: 1,
    bodyText: "Проверен итоговый материал задачи. ".repeat(200),
    contextRequest: { runId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" },
  } };
  const result = { provider: "local_company_context", proposal };
  const context = await handleToolCall("https://context-budget.invalid", "get_trelio_local_proposal_context", {
    companySlug: "demo", kind: "comment", payload: { target: { runId: proposal.currentDraft.contextRequest.runId } },
  }, { proposalOperation: async () => result });
  const render = buildLocalProposalRenderResult({ result, companySlug: "demo", kind: "comment", operation: "save" });
  const attachmentPayload = {
    attachmentId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", originalName: "sample.pdf",
    mimeType: "application/pdf", sizeBytes: 1024 * 1024,
    delivery: "inline-base64", dataBase64: Buffer.alloc(1024 * 1024, 97).toString("base64"),
  };
  const attachment = buildLocalAttachmentFileResult({
    result: { structuredContent: attachmentPayload }, opened: attachmentPayload,
    file: {
      localFilePath: "/private/trelio/attachment-downloads/download-ABC123/attachment.pdf",
      expiresAt: "2026-01-01T01:00:00.000Z", sizeBytes: attachmentPayload.sizeBytes, sha256: "a".repeat(64),
    },
  });
  return {
    note: "Synthetic fixtures through production result builders; hidden App _meta and local file bytes are excluded. Baselines repeat the identical structured payload in text.",
    attachmentFileBytes: attachmentPayload.sizeBytes,
    proposalContext: { duplicated: measureDuplicatedResult(context), compact: measureModelResult(context) },
    proposalRender: { duplicated: measureDuplicatedResult(render), compact: measureModelResult(render) },
    attachmentDownload: {
      duplicatedBase64: measureDuplicatedResult({ structuredContent: attachmentPayload }),
      localFile: measureModelResult(attachment),
    },
  };
};

export const buildPluginContextBudgetReport = async () => {
  const listed = await handleLocalMcpMessage({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  const localTools = listed.result.tools.filter(isModelVisibleLocalTool);
  const taskRunLocalTools = localTools.filter((tool) => tool.name === TRELIO_WORKSPACE_ACTION_TOOL.name);
  if (taskRunLocalTools.length !== 1) throw new Error("Task Run local action descriptor is missing or hidden.");
  const measureTools = (tools, prefixed = false) => measureContextText(JSON.stringify(
    tools.map((tool) => prefixed ? { ...tool, description: `${AGENT_SKILL_ROUTING_INSTRUCTIONS}${tool.description ?? ""}` } : tool),
  ));
  const localResponses = await buildLocalResponseMeasurements();
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
      TRELIO_LOCAL_PROPOSAL_CONTEXT_TOOL,
      TRELIO_LOCAL_PROPOSAL_RENDER_TOOL,
      TRELIO_LOCAL_WORKSPACE_TOOL,
      TRELIO_WORKSPACE_ACTION_TOOL,
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
      localTools: listed.result.tools.length,
      modelVisibleLocalTools: localTools.length,
      appOnlyLocalTools: listed.result.tools.length - localTools.length,
      taskRunLocalTools: taskRunLocalTools.length,
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
      localMcpInstructions: measureContextText(AGENT_SKILL_ROUTING_INSTRUCTIONS),
      modelVisibleLocalToolSchemas: measureTools(localTools),
      clientPrefixedLocalToolSchemas: measureTools(localTools, true),
      taskRunLocalToolSchemas: measureTools(taskRunLocalTools),
      clientPrefixedTaskRunLocalToolSchemas: measureTools(taskRunLocalTools, true),
    },
    localResponses,
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
      // Historical five-schema subset retained for revision comparisons. It
      // is not the complete local tools/list: the explicit local layers above
      // cover all model-visible tools and client instruction prefixes. The
      // encrypted manual remains conditional, never an ordinary Run input.
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
  formatMeasurement("Local initialize instructions", report.layers.localMcpInstructions),
  formatMeasurement("All model-visible local schemas", report.layers.modelVisibleLocalToolSchemas),
  formatMeasurement("Client · prefixed local schemas", report.layers.clientPrefixedLocalToolSchemas),
  formatMeasurement("Task Run · prefixed local action", report.layers.clientPrefixedTaskRunLocalToolSchemas),
  formatMeasurement("Proposal context · duplicated", report.localResponses.proposalContext.duplicated),
  formatMeasurement("Proposal context · compact", report.localResponses.proposalContext.compact),
  formatMeasurement("Proposal card · duplicated", report.localResponses.proposalRender.duplicated),
  formatMeasurement("Proposal card · compact", report.localResponses.proposalRender.compact),
  formatMeasurement("1 MiB attachment · duplicated base64", report.localResponses.attachmentDownload.duplicatedBase64),
  formatMeasurement("1 MiB attachment · local file", report.localResponses.attachmentDownload.localFile),
  "",
  "Local catalog excludes App-only tools. Prefixes describe a client serialization scenario, not every host.",
  "Local file bytes and these optional result fixtures are not added to a normal task Run total.",
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
