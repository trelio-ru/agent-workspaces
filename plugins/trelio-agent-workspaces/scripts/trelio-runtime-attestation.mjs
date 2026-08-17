/**
 * Наблюдение фактической модели и reasoning effort в поддерживаемых клиентах.
 *
 * Модуль отделён от hook entrypoint, потому что те же данные нужны локальному
 * bridge перед запуском signed runtime. Он только читает bounded client
 * transcript и не выполняет сеть, не открывает credentials и не принимает
 * caller-provided model/effort из аргументов bridge-команды.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const AGENT_RUNTIME_EFFORT_LEVELS = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
];

export const AGENT_RUNTIME_MODEL_SUPPORTED_EFFORTS = new Map([
  ["gpt-5.6-sol", ["low", "medium", "high", "xhigh", "max", "ultra"]],
  ["gpt-5.6-terra", ["low", "medium", "high", "xhigh", "max", "ultra"]],
  ["gpt-5.6-luna", ["low", "medium", "high", "xhigh", "max"]],
  ["gpt-5.5", ["low", "medium", "high", "xhigh"]],
  ["gpt-5.4", ["low", "medium", "high", "xhigh"]],
  ["gpt-5.4-mini", ["low", "medium", "high", "xhigh"]],
  ["gpt-5.3-codex-spark", ["low", "medium", "high", "xhigh"]],
  ["claude-fable-5", ["low", "medium", "high", "xhigh", "max"]],
  ["claude-opus-5", ["low", "medium", "high", "xhigh", "max"]],
  ["claude-sonnet-5", ["low", "medium", "high", "xhigh", "max"]],
  ["claude-opus-4-8", ["low", "medium", "high", "xhigh", "max"]],
  ["claude-opus-4-7", ["low", "medium", "high", "xhigh", "max"]],
  ["claude-opus-4-6", ["low", "medium", "high", "max"]],
  ["claude-sonnet-4-6", ["low", "medium", "high", "max"]],
  ["claude-haiku-4-5", []],
]);

const THREAD_ID_PATTERN = /^[0-9a-f-]{16,64}$/i;
const MAX_TRANSCRIPT_TAIL_BYTES = 2 * 1024 * 1024;

const readFileTail = async (filePath, maximumBytes = MAX_TRANSCRIPT_TAIL_BYTES) => {
  const handle = await fs.open(filePath, "r");

  try {
    const stat = await handle.stat();
    const start = Math.max(0, stat.size - maximumBytes);
    const buffer = Buffer.alloc(stat.size - start);
    await handle.read(buffer, 0, buffer.length, start);
    return buffer.toString("utf8");
  } finally {
    await handle.close();
  }
};

const parseJsonLinesFromTail = async (filePath) => {
  try {
    const tail = await readFileTail(filePath);
    const lines = tail.split(/\r?\n/u).filter(Boolean);
    const parsed = [];

    // Если bounded tail начался внутри строки, отбрасываем только повреждённую
    // строку. Более ранний валидный turn_context всё равно будет найден.
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      try {
        parsed.push(JSON.parse(lines[index]));
      } catch {
        // Transcript принадлежит клиенту и может быть дописан параллельно.
      }
    }

    return parsed;
  } catch {
    return [];
  }
};

const findCodexRolloutPath = async (threadId, environment = process.env) => {
  if (!THREAD_ID_PATTERN.test(String(threadId || ""))) {
    return null;
  }

  const codexRoot = environment.CODEX_HOME
    ? path.resolve(environment.CODEX_HOME)
    : path.join(os.homedir(), ".codex");
  const sessionsRoot = path.join(codexRoot, "sessions");

  try {
    const entries = await fs.readdir(sessionsRoot, {
      recursive: true,
      withFileTypes: true,
    });
    const matchingEntry = entries.find((entry) => (
      entry.isFile()
      && entry.name.endsWith(".jsonl")
      && entry.name.includes(threadId)
    ));

    return matchingEntry
      ? path.join(matchingEntry.parentPath, matchingEntry.name)
      : null;
  } catch {
    return null;
  }
};

const readCodexRuntime = async ({ hookInput = {}, environment = process.env } = {}) => {
  const transcriptPath = typeof hookInput.transcript_path === "string"
    ? hookInput.transcript_path
    : await findCodexRolloutPath(environment.CODEX_THREAD_ID, environment);
  const rows = transcriptPath ? await parseJsonLinesFromTail(transcriptPath) : [];
  const turnContext = rows.find((row) => (
    row?.type === "turn_context"
    && row.payload
    && typeof row.payload === "object"
  ));
  const modelId = typeof hookInput.model === "string" && hookInput.model.trim()
    ? hookInput.model.trim()
    : typeof turnContext?.payload?.model === "string"
      ? turnContext.payload.model.trim()
      : null;
  const effortLevel = AGENT_RUNTIME_EFFORT_LEVELS.includes(turnContext?.payload?.effort)
    ? turnContext.payload.effort
    : null;

  return {
    schemaVersion: 1,
    clientFamily: "codex",
    modelId,
    effortLevel,
    evidenceLevel: modelId ? "local_observed" : "unavailable",
    source: hookInput.hook_event_name ? "codex_hook" : "codex_rollout",
    observedAt: new Date().toISOString(),
  };
};

const readClaudeTranscriptModel = async (transcriptPath) => {
  if (!transcriptPath) return null;

  const rows = await parseJsonLinesFromTail(transcriptPath);
  for (const row of rows) {
    const candidates = [row?.message?.model, row?.model, row?.payload?.model];
    const model = candidates.find((value) => typeof value === "string" && value.trim());
    if (model) return model.trim();
  }
  return null;
};

const readClaudeRuntime = async ({ hookInput = {}, environment = process.env } = {}) => {
  const transcriptModel = await readClaudeTranscriptModel(hookInput.transcript_path);
  const modelId = transcriptModel
    || (typeof hookInput.model === "string" ? hookInput.model.trim() : "")
    || (typeof environment.TRELIO_CLAUDE_MODEL === "string"
      ? environment.TRELIO_CLAUDE_MODEL.trim()
      : "")
    || null;
  const hookEffort = hookInput?.effort?.level;
  const environmentEffort = environment.CLAUDE_EFFORT;
  const effortLevel = AGENT_RUNTIME_EFFORT_LEVELS.includes(hookEffort)
    ? hookEffort
    : AGENT_RUNTIME_EFFORT_LEVELS.includes(environmentEffort)
      ? environmentEffort
      : null;

  return {
    schemaVersion: 1,
    clientFamily: "claude-code",
    modelId,
    effortLevel,
    evidenceLevel: modelId ? "local_observed" : "unavailable",
    source: "claude_hook",
    observedAt: new Date().toISOString(),
  };
};

export const detectAgentRuntimeAttestation = async ({
  hookInput = {},
  environment = process.env,
} = {}) => {
  const hasClaudeRuntime = Boolean(
    environment.CLAUDE_CODE_ENTRYPOINT
    || environment.CLAUDE_EFFORT
    || hookInput?.effort,
  );

  if (hasClaudeRuntime) {
    return readClaudeRuntime({ hookInput, environment });
  }

  if (environment.CODEX_THREAD_ID || typeof hookInput.model === "string") {
    return readCodexRuntime({ hookInput, environment });
  }

  return {
    schemaVersion: 1,
    clientFamily: "other",
    modelId: null,
    effortLevel: null,
    evidenceLevel: "unavailable",
    source: "unknown",
    observedAt: new Date().toISOString(),
  };
};
