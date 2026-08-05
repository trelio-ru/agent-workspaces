#!/usr/bin/env node

/**
 * Локальный runtime guard политики моделей Trelio.
 *
 * Скрипт используется двумя способами:
 * 1. bridge получает локально наблюдаемую model/effort attestation перед claim;
 * 2. Codex/Claude Code PreToolUse повторно проверяет pinned policy после
 *    materialization Run, поэтому смена модели посреди сессии тоже блокируется.
 *
 * Это осознанно называется local_observed, а не platform_attested: локальный
 * администратор машины технически может изменить plugin или отключить hooks.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max", "ultra"];
const MODEL_SUPPORTED_EFFORTS = new Map([
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
const INITIAL_CHAT_TITLE_REMINDER = [
  "Это первый ход нового основного чата.",
  "После сбора исходного контекста один раз проверь, нужно ли задать текущему чату короткое информативное название через прямой безопасный инструмент именно текущего чата.",
  "Если название уже понятное или задано пользователем либо прямого инструмента нет, молча продолжай.",
  "В следующих ходах автоматически к названию не возвращайся.",
].join(" ");

const readStdinJson = async () => {
  const chunks = [];

  for await (const chunk of process.stdin) {
    chunks.push(Buffer.from(chunk));
  }

  if (chunks.length === 0) {
    return {};
  }

  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
};

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

    // Если чтение началось посреди первой JSONL-строки, она просто
    // отбрасывается; следующие bounded строки остаются полноценными.
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      try {
        parsed.push(JSON.parse(lines[index]));
      } catch {
        // Transcript является runtime-форматом клиента. Одна повреждённая
        // строка не должна мешать найти более ранний валидный context event.
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

    if (!matchingEntry) {
      return null;
    }

    return path.join(matchingEntry.parentPath, matchingEntry.name);
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
  const effortLevel = EFFORT_LEVELS.includes(turnContext?.payload?.effort)
    ? turnContext.payload.effort
    : null;

  return {
    schemaVersion: 1,
    clientFamily: "codex",
    modelId,
    effortLevel,
    // Отсутствующий effort остаётся наблюдаемым фактом и отдельно даёт
    // EFFORT_REQUIRED. Не понижаем всю attestation до unavailable, потому что
    // модели без effort (например Claude Haiku) могут быть явно разрешены.
    evidenceLevel: modelId ? "local_observed" : "unavailable",
    source: hookInput.hook_event_name ? "codex_hook" : "codex_rollout",
    observedAt: new Date().toISOString(),
  };
};

const readClaudeTranscriptModel = async (transcriptPath) => {
  if (!transcriptPath) {
    return null;
  }

  const rows = await parseJsonLinesFromTail(transcriptPath);

  for (const row of rows) {
    const candidates = [
      row?.message?.model,
      row?.model,
      row?.payload?.model,
    ];
    const model = candidates.find((value) => typeof value === "string" && value.trim());

    if (model) {
      return model.trim();
    }
  }

  return null;
};

const readClaudeRuntime = async ({ hookInput = {}, environment = process.env } = {}) => {
  const transcriptModel = await readClaudeTranscriptModel(hookInput.transcript_path);
  const modelId = transcriptModel
    || (typeof hookInput.model === "string" ? hookInput.model.trim() : "")
    || (typeof environment.TRELIO_CLAUDE_MODEL === "string" ? environment.TRELIO_CLAUDE_MODEL.trim() : "")
    || null;
  const hookEffort = hookInput?.effort?.level;
  const environmentEffort = environment.CLAUDE_EFFORT;
  const effortLevel = EFFORT_LEVELS.includes(hookEffort)
    ? hookEffort
    : EFFORT_LEVELS.includes(environmentEffort)
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

/**
 * Возвращает лёгкое одноразовое напоминание только в начале новой Codex-сессии.
 * Оно намеренно не является Stop-проверкой: агент получает контекст в уже
 * запланированном первом model call, поэтому переименование не создаёт второй
 * проход, сетевой запрос или задержку в конце работы. Resume/clear/compact не
 * считаются новым чатом и не должны снова поднимать вопрос о названии.
 */
export const resolveInitialChatTitleReminder = ({
  hookInput = {},
  environment = process.env,
} = {}) => {
  const isCodexSession = Boolean(environment.CODEX_THREAD_ID);
  const isClaudeCodeSession = Boolean(
    environment.CLAUDE_CODE_ENTRYPOINT
    || environment.CLAUDE_EFFORT
    || hookInput?.effort,
  );

  if (
    hookInput.hook_event_name !== "SessionStart"
    || hookInput.source !== "startup"
    || !isCodexSession
    || isClaudeCodeSession
  ) {
    return null;
  }

  return INITIAL_CHAT_TITLE_REMINDER;
};

const findRunMetadataPath = async (cwd) => {
  let current = path.resolve(cwd || process.cwd());

  for (let depth = 0; depth < 12; depth += 1) {
    const candidates = [
      path.join(current, ".trelio-run.json"),
      path.join(current, "..", ".trelio-run.json"),
    ];

    for (const candidate of candidates) {
      try {
        const stat = await fs.lstat(candidate);

        if (stat.isFile() && !stat.isSymbolicLink()) {
          return path.resolve(candidate);
        }
      } catch (error) {
        if (error.code !== "ENOENT") {
          return null;
        }
      }
    }

    const parent = path.dirname(current);

    if (parent === current) {
      break;
    }
    current = parent;
  }

  return null;
};

const resolvePolicyRule = (providerPolicy, rawModelId) => {
  const normalizedModelId = String(rawModelId || "").trim().toLowerCase();
  const models = Array.isArray(providerPolicy?.models) ? providerPolicy.models : [];

  return models.find((rule) => {
    const canonical = String(rule?.modelId || "").trim().toLowerCase();

    if (!canonical) {
      return false;
    }

    return normalizedModelId === canonical
      || (
        canonical.startsWith("claude-")
        && (
          normalizedModelId.startsWith(`${canonical}-`)
          || normalizedModelId.includes(`.${canonical}`)
          || normalizedModelId.includes(`/${canonical}`)
        )
      );
  }) ?? null;
};

export const evaluatePinnedRuntimePolicy = (snapshot, attestation) => {
  const policy = snapshot?.policy;

  if (!policy || policy.mode === "disabled") {
    return { satisfied: true, enforced: false, reasonCode: "POLICY_DISABLED" };
  }

  const enforced = policy.mode === "enforce";

  if (attestation?.clientFamily === "other") {
    const satisfied = policy.otherClientsAction === "allow";
    return {
      satisfied,
      enforced,
      reasonCode: satisfied ? "OTHER_CLIENT_ALLOWED" : "OTHER_CLIENT_DENIED",
    };
  }

  if (
    !attestation
    || attestation.evidenceLevel !== "local_observed"
    || !attestation.modelId
  ) {
    return { satisfied: false, enforced, reasonCode: "EVIDENCE_REQUIRED" };
  }

  const providerPolicy = attestation.clientFamily === "codex"
    ? policy?.providers?.codex
    : policy?.providers?.claudeCode;
  const rule = resolvePolicyRule(providerPolicy, attestation.modelId);

  if (!rule) {
    const satisfied = providerPolicy?.unlistedModelsAction === "allow";
    return {
      satisfied,
      enforced,
      reasonCode: satisfied ? "UNLISTED_MODEL_ALLOWED" : "UNLISTED_MODEL_DENIED",
    };
  }

  if (rule.decision === "deny") {
    return { satisfied: false, enforced, reasonCode: "MODEL_DENIED" };
  }

  if (rule.minimumEffort === null) {
    return { satisfied: true, enforced, reasonCode: "MODEL_ALLOWED" };
  }

  if (!EFFORT_LEVELS.includes(attestation.effortLevel)) {
    return { satisfied: false, enforced, reasonCode: "EFFORT_REQUIRED" };
  }

  // Набор уровней различается между моделями. Например, `ultra` есть у
  // Codex 5.6 Sol/Terra, но не у Claude, а Opus 4.6 не поддерживает `xhigh`.
  // Сравнение по одной глобальной шкале ошибочно разрешило бы такой уровень.
  const supportedEfforts = MODEL_SUPPORTED_EFFORTS.get(rule.modelId) ?? EFFORT_LEVELS;
  const actualIndex = supportedEfforts.indexOf(attestation.effortLevel);
  const minimumIndex = supportedEfforts.indexOf(rule.minimumEffort);
  const satisfied = actualIndex >= minimumIndex && minimumIndex >= 0;
  return {
    satisfied,
    enforced,
    reasonCode: satisfied ? "MODEL_ALLOWED" : "EFFORT_TOO_LOW",
  };
};

const persistClaudeSessionEnvironment = async (hookInput) => {
  const environmentFile = process.env.CLAUDE_ENV_FILE;
  const modelId = typeof hookInput.model === "string" ? hookInput.model.trim() : "";

  if (!environmentFile || !modelId) {
    return;
  }

  // Single-quote escaping keeps model/session identifiers data-only inside the
  // shell fragment Claude Code sources for subsequent Bash commands.
  const quote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;
  await fs.appendFile(
    environmentFile,
    `export TRELIO_CLAUDE_MODEL=${quote(modelId)}\n`
      + `export TRELIO_CLAUDE_SESSION_ID=${quote(hookInput.session_id || "")}\n`,
    { mode: 0o600 },
  );
};

const runHook = async () => {
  const hookInput = await readStdinJson();

  if (hookInput.hook_event_name === "SessionStart") {
    await persistClaudeSessionEnvironment(hookInput);
    const chatTitleReminder = resolveInitialChatTitleReminder({ hookInput });

    if (chatTitleReminder) {
      // SessionStart передаёт plain stdout модели как дополнительный контекст.
      // Одной строки достаточно; структурированный hook result здесь не нужен.
      process.stdout.write(`${chatTitleReminder}\n`);
    }
    return;
  }

  if (hookInput.hook_event_name !== "PreToolUse") {
    return;
  }

  const metadataPath = await findRunMetadataPath(hookInput.cwd);

  if (!metadataPath) {
    return;
  }

  let metadata;

  try {
    metadata = JSON.parse(await fs.readFile(metadataPath, "utf8"));
  } catch {
    process.stderr.write("Trelio: runtime metadata повреждён, действие заблокировано.\n");
    process.exitCode = 2;
    return;
  }

  const attestation = await detectAgentRuntimeAttestation({ hookInput });
  const evaluation = evaluatePinnedRuntimePolicy(
    metadata.runtimePolicySnapshot,
    attestation,
  );

  if (evaluation.enforced && !evaluation.satisfied) {
    process.stderr.write(
      `Trelio: модель или уровень рассуждений не разрешены политикой компании (${evaluation.reasonCode}). `
        + "Выберите разрешённую модель и достаточный effort.\n",
    );
    process.exitCode = 2;
  }
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runHook().catch((error) => {
    process.stderr.write(`Trelio runtime policy hook failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  });
}
