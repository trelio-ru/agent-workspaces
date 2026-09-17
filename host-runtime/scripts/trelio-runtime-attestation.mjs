/**
 * Читает runtime, который наблюдает сам Codex/Claude Code hook. Эти данные не
 * принимаются из tool arguments и не формируются моделью. Transcript читается
 * bounded-tail только потому, что Codex пока не передаёт reasoning effort в
 * документированном общем hook payload.
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

const THREAD_ID_PATTERN = /^[0-9a-f-]{16,64}$/iu;
const MAX_TRANSCRIPT_TAIL_BYTES = 2 * 1024 * 1024;

const readFileTail = async (filePath) => {
  const handle = await fs.open(filePath, "r");
  try {
    const stat = await handle.stat();
    const start = Math.max(0, stat.size - MAX_TRANSCRIPT_TAIL_BYTES);
    const buffer = Buffer.alloc(stat.size - start);
    await handle.read(buffer, 0, buffer.length, start);
    return buffer.toString("utf8");
  } finally {
    await handle.close();
  }
};

const parseJsonLinesFromTail = async (filePath) => {
  try {
    const lines = (await readFileTail(filePath)).split(/\r?\n/u).filter(Boolean);
    const rows = [];
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      try {
        rows.push(JSON.parse(lines[index]));
      } catch {
        // Клиент может дописывать последнюю JSONL-строку параллельно hook.
      }
    }
    return rows;
  } catch {
    return [];
  }
};

const findCodexRolloutPath = async (threadId, environment) => {
  if (!THREAD_ID_PATTERN.test(String(threadId || ""))) return null;
  const codexRoot = environment.CODEX_HOME
    ? path.resolve(environment.CODEX_HOME)
    : path.join(os.homedir(), ".codex");
  try {
    const entries = await fs.readdir(path.join(codexRoot, "sessions"), {
      recursive: true,
      withFileTypes: true,
    });
    const match = entries.find((entry) => (
      entry.isFile()
      && entry.name.endsWith(".jsonl")
      && entry.name.includes(threadId)
    ));
    return match ? path.join(match.parentPath, match.name) : null;
  } catch {
    return null;
  }
};

const readCodexRuntime = async ({ hookInput, environment }) => {
  const transcriptPath = typeof hookInput.transcript_path === "string"
    ? hookInput.transcript_path
    : await findCodexRolloutPath(
        environment.CODEX_THREAD_ID || hookInput.session_id,
        environment,
      );
  const rows = transcriptPath ? await parseJsonLinesFromTail(transcriptPath) : [];
  const turnContext = rows.find((row) => row?.type === "turn_context" && row.payload);
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
    source: "codex_hook",
    observedAt: new Date().toISOString(),
  };
};

const readClaudeRuntime = async ({ hookInput, environment }) => {
  const rows = typeof hookInput.transcript_path === "string"
    ? await parseJsonLinesFromTail(hookInput.transcript_path)
    : [];
  const transcriptModel = rows
    .flatMap((row) => [row?.message?.model, row?.model, row?.payload?.model])
    .find((value) => typeof value === "string" && value.trim());
  const modelId = transcriptModel
    || (typeof hookInput.model === "string" ? hookInput.model.trim() : "")
    || (typeof environment.TRELIO_CLAUDE_MODEL === "string"
      ? environment.TRELIO_CLAUDE_MODEL.trim()
      : "")
    || null;
  const hookEffort = hookInput?.effort?.level;
  const effortLevel = AGENT_RUNTIME_EFFORT_LEVELS.includes(hookEffort)
    ? hookEffort
    : AGENT_RUNTIME_EFFORT_LEVELS.includes(environment.CLAUDE_EFFORT)
      ? environment.CLAUDE_EFFORT
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
  const claudeCode = Boolean(
    environment.CLAUDE_CODE_ENTRYPOINT
    || environment.CLAUDE_EFFORT
    || hookInput?.effort,
  );
  if (claudeCode) return readClaudeRuntime({ hookInput, environment });
  if (
    environment.CODEX_THREAD_ID
    || hookInput.session_id
    || typeof hookInput.model === "string"
  ) {
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
