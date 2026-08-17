#!/usr/bin/env node

/**
 * Локальный runtime guard политики моделей Trelio.
 *
 * Скрипт используется двумя способами:
 * 1. bridge получает локально наблюдаемую model/effort attestation перед claim;
 * 2. Codex/Claude Code PreToolUse повторно проверяет pinned policy после
 *    materialization Run;
 * 3. вне Run тот же hook закрепляет current policy за обычной client session
 *    и применяет её ко всему Trelio-bound проекту либо exact scoped MCP call.
 *
 * Это осознанно называется local_observed, а не platform_attested: локальный
 * администратор машины технически может изменить plugin или отключить hooks.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  detectAgentRuntimeAttestation,
} from "./trelio-runtime-attestation.mjs";
import { evaluatePinnedRuntimePolicy } from "./trelio-runtime-policy-evaluator.mjs";

export { detectAgentRuntimeAttestation } from "./trelio-runtime-attestation.mjs";
export { evaluatePinnedRuntimePolicy } from "./trelio-runtime-policy-evaluator.mjs";

const INITIAL_CHAT_TITLE_REMINDER = [
  "Это первый ход нового основного чата.",
  "После сбора исходного контекста один раз проверь, нужно ли задать текущему чату короткое информативное название через прямой безопасный инструмент именно текущего чата.",
  "Если название уже понятное или задано пользователем либо прямого инструмента нет, молча продолжай.",
  "В следующих ходах автоматически к названию не возвращайся.",
].join(" ");
const TRELIO_MANAGED_BLOCK_PATTERN = /<!-- trelio-agent-workspaces:start -->([\s\S]*?)<!-- trelio-agent-workspaces:end -->/u;
const TRELIO_COMPANY_BINDING_PATTERN = /связан[^\n]*?\(`([a-z0-9]+(?:-[a-z0-9]+)*)`\)/iu;
const TRELIO_COMPANY_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const MAX_INSTRUCTION_FILE_BYTES = 512 * 1024;

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

export const parseTrelioProjectBinding = (markdown) => {
  const managedBlock = String(markdown || "").match(TRELIO_MANAGED_BLOCK_PATTERN)?.[1] ?? "";
  const companySlug = managedBlock.match(TRELIO_COMPANY_BINDING_PATTERN)?.[1] ?? null;
  return companySlug && TRELIO_COMPANY_SLUG_PATTERN.test(companySlug)
    ? { companySlug }
    : null;
};

const readInstructionBinding = async (filePath) => {
  try {
    const metadata = await fs.lstat(filePath);
    if (
      !metadata.isFile()
      || metadata.isSymbolicLink()
      || metadata.size > MAX_INSTRUCTION_FILE_BYTES
    ) {
      return { exists: true, binding: null };
    }
    return {
      exists: true,
      binding: parseTrelioProjectBinding(await fs.readFile(filePath, "utf8")),
    };
  } catch (error) {
    if (error.code === "ENOENT") return { exists: false, binding: null };
    return { exists: true, binding: null };
  }
};

export const findTrelioProjectBinding = async (cwd) => {
  let current = path.resolve(cwd || process.cwd());

  for (let depth = 0; depth < 16; depth += 1) {
    // AGENTS.override.md целиком заменяет AGENTS.md на том же уровне. Hook
    // повторяет этот выбор и не извлекает binding из неэффективного файла.
    const override = await readInstructionBinding(path.join(current, "AGENTS.override.md"));
    if (override.exists) {
      if (override.binding) return override.binding;
    } else {
      const agents = await readInstructionBinding(path.join(current, "AGENTS.md"));
      if (agents.binding) return agents.binding;
    }

    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  return null;
};

const resolveHookToolName = (hookInput) => String(
  hookInput?.tool_name
  || hookInput?.toolName
  || "",
);

const resolveHookToolInput = (hookInput) => {
  const raw = hookInput?.tool_input ?? hookInput?.toolInput ?? hookInput?.input ?? {};
  if (typeof raw !== "string" || raw.length > 256 * 1024) return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
};

const isTrelioToolName = (toolName) => (
  /(?:^|[_:./-])trelio(?:[_:./-]|$)/iu.test(toolName)
);

const findCompanyTarget = (value, depth = 0, seen = new Set()) => {
  if (!value || typeof value !== "object" || depth > 4 || seen.has(value)) return null;
  seen.add(value);

  for (const [key, candidate] of Object.entries(value).slice(0, 100)) {
    if (
      ["companySlug", "company_slug"].includes(key)
      && typeof candidate === "string"
      && candidate.length <= 255
      && TRELIO_COMPANY_SLUG_PATTERN.test(candidate)
    ) {
      return { companySlug: candidate };
    }
    if (
      ["companyId", "company_id"].includes(key)
      && typeof candidate === "string"
      && UUID_PATTERN.test(candidate)
    ) {
      return { companyId: candidate.toLowerCase() };
    }
  }

  for (const candidate of Object.values(value).slice(0, 100)) {
    const nested = findCompanyTarget(candidate, depth + 1, seen);
    if (nested) return nested;
  }
  return null;
};

export const resolveTrelioToolCompanyTarget = (hookInput) => {
  const toolName = resolveHookToolName(hookInput);
  return isTrelioToolName(toolName)
    ? findCompanyTarget(resolveHookToolInput(hookInput))
    : null;
};

const resolveRuntimeSessionId = (hookInput, environment = process.env) => {
  const value = environment.CODEX_THREAD_ID
    || hookInput?.session_id
    || environment.TRELIO_CLAUDE_SESSION_ID
    || null;
  return typeof value === "string" && value.length <= 512 ? value : null;
};

const isBridgeLoginRecoveryTool = (hookInput) => {
  const toolName = resolveHookToolName(hookInput);
  if (/approve_agent_workspace_bridge_pairing/iu.test(toolName)) return true;

  const toolInput = resolveHookToolInput(hookInput);
  const command = typeof toolInput?.cmd === "string"
    ? toolInput.cmd
    : typeof toolInput?.command === "string"
      ? toolInput.command
      : "";
  return /(?:trelio-workspace(?:\.mjs)?)[^\r\n]*(?:\s|^)(?:login|doctor)(?:\s|$)/iu.test(command)
    || /codex\s+mcp\s+login\s+trelio(?:\s|$)/iu.test(command);
};

const enforceOrdinaryRuntimePolicy = async ({ hookInput, attestation }) => {
  const [binding, workspaceModule] = await Promise.all([
    findTrelioProjectBinding(hookInput.cwd),
    import("./trelio-workspace.mjs"),
  ]);
  const admission = await workspaceModule.resolveOrdinaryRuntimePolicyAdmission({
    origin: process.env.TRELIO_WORKSPACE_ORIGIN || "https://trelio.ru",
    sessionId: resolveRuntimeSessionId(hookInput),
    clientFamily: attestation.clientFamily,
    observedBoundCompanySlug: binding?.companySlug ?? null,
    target: resolveTrelioToolCompanyTarget(hookInput),
    runtimeAttestation: attestation,
  });

  if (["not_applicable", "backend_unsupported"].includes(admission.status)) return;

  if (admission.status === "bridge_login_required") {
    if (isBridgeLoginRecoveryTool(hookInput)) return;
    process.stderr.write(
      "Trelio заблокировал действие до защищённой проверки политики компании. "
        + "Подключите локальный компонент штатной командой `trelio-workspace login` и повторите действие.\n",
    );
    process.exitCode = 2;
    return;
  }

  const evaluation = evaluatePinnedRuntimePolicy(
    admission.runtimePolicySnapshot,
    attestation,
  );
  if (evaluation.enforced && !evaluation.satisfied) {
    process.stderr.write(
      `Trelio заблокировал действие политикой компании (${evaluation.reasonCode}). `
        + "Выберите разрешённую модель и достаточный уровень рассуждений, затем повторите действие.\n",
    );
    process.exitCode = 2;
  }
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
    const attestation = await detectAgentRuntimeAttestation({ hookInput });
    await enforceOrdinaryRuntimePolicy({ hookInput, attestation });
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
