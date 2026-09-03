#!/usr/bin/env node

/**
 * Always-on runtime admission for Codex and Claude Code.
 *
 * The hook observes model/effort once, registers an Ed25519 public key through
 * the paired bridge, and injects a fresh signature after each protected tool
 * call has been authored by the model. The private key never enters chat,
 * tool output, MCP arguments, Workspace or backend storage.
 */
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { detectAgentRuntimeAttestation } from "./trelio-runtime-attestation.mjs";

const DISCOVERY_TOOLS = new Set([
  "list_knowledge_base_pages", "list_contacts", "list_registries",
  "search_meetings", "list_workspaces", "list_agent_secrets", "search",
  "search_tasks", "search_agent_workspace_files", "list_companies",
  "list_projects", "search_agent_skills", "list_agent_skills", "list_my_tasks",
  "list_project_tasks", "list_task_connections", "get_project_meta",
  "get_task_create_meta", "get_my_context", "resolve_user",
  "resolve_company_member", "resolve_status", "get_task_move_options",
  "list_notifications",
]);
const RECOVERY_TOOLS = new Set([
  "approve_agent_workspace_bridge_pairing",
  "list_agent_workspace_bridge_sessions",
  "revoke_agent_workspace_bridge_session",
]);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const HOOK_REQUIRED_CODE = "TRELIO_RUNTIME_HOOK_REQUIRED";
const HOOK_FAILED_CODE = "TRELIO_RUNTIME_HOOK_FAILED";
const PLUGIN_UPGRADE_CODES = new Set([
  "AGENT_WORKSPACE_PLUGIN_UPGRADE_REQUIRED",
  "AGENT_SKILL_RUNTIME_HOST_UPGRADE_REQUIRED",
]);
const SAFE_ERROR_CODE_PATTERN = /^[A-Z][A-Z0-9_]{2,127}$/u;
const TRELIO_TOOL_NAME_PATTERN = /^[a-z][a-z0-9_]{0,127}$/u;
// Claude Code qualifies MCP servers contributed by a plugin inside hook
// payloads. Match the exact plugin and server rather than a broad suffix: a
// different MCP server must never receive a proof signed for a Trelio tool.
const CLAUDE_PLUGIN_TRELIO_TOOL_PATTERN =
  /^mcp__plugin_trelio-agent-workspaces_trelio__([a-z0-9_]+)$/iu;
const LOCAL_ACTION_HOST_TOOL_PATTERNS = [
  /^(?:mcp__)?trelio_remote_skills__continue_trelio_local_action$/iu,
  /^mcp__plugin_trelio-agent-workspaces_trelio-remote-skills__continue_trelio_local_action$/iu,
  /^(?:mcp[:./-])?trelio-remote-skills[:./-]continue_trelio_local_action$/iu,
];
const RUNTIME_STATE_LOCK_WAIT_MILLISECONDS = 5_000;
const RUNTIME_STATE_LOCK_STALE_MILLISECONDS = 15_000;
const RUNTIME_REGISTRATION_TIMEOUT_MILLISECONDS = 11_000;
const RUNTIME_END_TIMEOUT_MILLISECONDS = 1_500;
let workspaceBridgeModulePromise;

// PreToolUse вызывается и для нетрелиевских инструментов. Большой bridge
// загружаем только после того, как установлено, что действительно нужен
// lifecycle state или защищённый Trelio proof.
const loadWorkspaceBridgeModule = () => {
  workspaceBridgeModulePromise ??= import("./trelio-workspace.mjs");
  return workspaceBridgeModulePromise;
};

const readStdinJson = async () => {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > 512 * 1024) throw new Error("Hook input is too large.");
    chunks.push(Buffer.from(chunk));
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
};

const resolveClientSessionId = (hookInput, environment = process.env) => {
  const value = environment.CODEX_THREAD_ID
    || hookInput.session_id
    || environment.TRELIO_CLAUDE_SESSION_ID
    || null;
  return typeof value === "string" && value.trim() && value.length <= 512
    ? value.trim()
    : null;
};

export const resolveTrelioMcpToolName = (hookInput) => {
  const rawName = String(hookInput?.tool_name || hookInput?.toolName || "");
  if (LOCAL_ACTION_HOST_TOOL_PATTERNS.some((pattern) => pattern.test(rawName))) {
    const nativeTool = String(resolveToolInput(hookInput)?.nativeTool || "").trim().toLowerCase();
    return TRELIO_TOOL_NAME_PATTERN.test(nativeTool) ? nativeTool : null;
  }
  const doubleUnderscore = rawName.match(/^(?:mcp__)?trelio__([a-z0-9_]+)$/iu);
  if (doubleUnderscore) return doubleUnderscore[1].toLowerCase();
  const claudePluginQualified = rawName.match(CLAUDE_PLUGIN_TRELIO_TOOL_PATTERN);
  if (claudePluginQualified) return claudePluginQualified[1].toLowerCase();
  const separated = rawName.match(
    /^(?:mcp[:./-])?trelio[:./-]([a-z0-9_]+)$/iu,
  );
  return separated ? separated[1].toLowerCase() : null;
};

export const isProtectedTrelioToolName = (toolName) => Boolean(
  toolName && !DISCOVERY_TOOLS.has(toolName) && !RECOVERY_TOOLS.has(toolName)
);

const resolveToolInput = (hookInput) => {
  const value = hookInput?.tool_input ?? hookInput?.toolInput ?? hookInput?.input ?? {};
  if (typeof value !== "string") return value && typeof value === "object" ? value : {};
  if (value.length > 256 * 1024) throw new Error("Trelio tool input is too large.");
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
};

const statePathFor = async (clientSessionId, origin) => {
  const { resolveWorkspaceBridgeConfigDirectory } = await loadWorkspaceBridgeModule();
  return path.join(
    resolveWorkspaceBridgeConfigDirectory(),
    "runtime-sessions",
    `${crypto.createHash("sha256").update(`${origin}\n${clientSessionId}`).digest("hex")}.json`,
  );
};

const wait = (milliseconds) => new Promise((resolve) => {
  setTimeout(resolve, milliseconds);
});

/**
 * The first two protected calls may be authored almost simultaneously. An
 * atomic private lock ensures they register one server session and then share
 * its local key. Without it, the last writer would orphan the other session
 * and one of the already-created proofs could fail nondeterministically.
 */
const withRuntimeStateLock = async (filePath, operation) => {
  const lockPath = `${filePath}.lock`;
  const { ensurePrivateDirectory } = await loadWorkspaceBridgeModule();
  await ensurePrivateDirectory(path.dirname(filePath));
  const startedAt = Date.now();

  for (;;) {
    try {
      await fs.mkdir(lockPath, { mode: 0o700 });
      if (process.platform !== "win32") {
        await fs.chmod(lockPath, 0o700);
      }
      break;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const metadata = await fs.lstat(lockPath).catch(() => null);
      if (!metadata) continue;
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
        throw new Error("локальная блокировка runtime-сессии имеет небезопасный тип");
      }
      if (Date.now() - metadata.mtimeMs > RUNTIME_STATE_LOCK_STALE_MILLISECONDS) {
        await fs.rmdir(lockPath).catch(() => undefined);
        continue;
      }
      if (Date.now() - startedAt >= RUNTIME_STATE_LOCK_WAIT_MILLISECONDS) {
        throw new Error("другая runtime-регистрация не завершилась вовремя");
      }
      await wait(40);
    }
  }

  try {
    return await operation();
  } finally {
    await fs.rmdir(lockPath).catch(() => undefined);
  }
};

const readStoredState = async (filePath) => {
  try {
    const { readPrivateJsonFile } = await loadWorkspaceBridgeModule();
    return await readPrivateJsonFile(filePath);
  } catch {
    return {};
  }
};

const readRuntimeState = async (filePath) => {
  try {
    const state = await readStoredState(filePath);
    if (
      state.schemaVersion !== 1
      || !UUID_PATTERN.test(String(state.runtimeSessionId || ""))
      || typeof state.privateKeyPkcs8 !== "string"
      || Number.isNaN(Date.parse(String(state.expiresAt || "")))
      || Date.parse(state.expiresAt) <= Date.now() + 30_000
    ) return null;
    crypto.createPrivateKey({
      key: Buffer.from(state.privateKeyPkcs8, "base64url"),
      format: "der",
      type: "pkcs8",
    });
    return state;
  } catch {
    return null;
  }
};

const readPendingObservation = async (filePath) => {
  const state = await readStoredState(filePath);
  return state.schemaVersion === 1
    && state.pending === true
    && state.observation
    && typeof state.observation === "object"
    ? state.observation
    : null;
};

const isTransientError = (error) => (
  [408, 429, 500, 502, 503, 504].includes(Number(error?.statusCode))
  || ["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EAI_AGAIN", "ENOTFOUND"]
    .includes(String(error?.code || error?.cause?.code || ""))
);

const retryIdempotentRequest = async (operation) => {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (!isTransientError(error) || attempt === 2) throw error;
      await new Promise((resolve) => setTimeout(resolve, 150 * (2 ** attempt)));
    }
  }
  throw lastError;
};

const createRuntimeState = async ({
  hookInput,
  clientSessionId,
  origin,
  filePath,
  initialObservation = null,
}) => {
  const currentObservation = await detectAgentRuntimeAttestation({ hookInput });
  // SessionStart reliably supplies the selected model but Codex does not yet
  // document effort in that event. Preserve the initial model/client and fill
  // only missing evidence from the first protected PreToolUse.
  const observation = initialObservation
    ? {
        ...currentObservation,
        clientFamily: initialObservation.clientFamily === "other"
          ? currentObservation.clientFamily
          : initialObservation.clientFamily,
        modelId: initialObservation.modelId || currentObservation.modelId,
        effortLevel: initialObservation.effortLevel || currentObservation.effortLevel,
        source: initialObservation.source === "unknown"
          ? currentObservation.source
          : initialObservation.source,
        evidenceLevel: (initialObservation.modelId || currentObservation.modelId)
          ? "local_observed"
          : "unavailable",
        observedAt: currentObservation.observedAt,
      }
    : currentObservation;
  if (
    (observation.clientFamily === "codex" || observation.clientFamily === "claude-code")
    && (!observation.modelId || observation.evidenceLevel !== "local_observed")
  ) {
    throw new Error(
      "активный клиентский hook не смог определить модель. Повторите запрос; если ошибка сохранится, начните новую задачу",
    );
  }
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const publicKeySpki = publicKey.export({ type: "spki", format: "der" }).toString("base64url");
  const privateKeyPkcs8 = privateKey.export({ type: "pkcs8", format: "der" }).toString("base64url");
  const {
    registerAgentRuntimeHookSession,
    writePrivateJsonFile,
  } = await loadWorkspaceBridgeModule();

  const registrationSignal = AbortSignal.timeout(
    RUNTIME_REGISTRATION_TIMEOUT_MILLISECONDS,
  );
  const registration = await retryIdempotentRequest(() => (
    registerAgentRuntimeHookSession({
      origin,
      clientSessionId,
      observation,
      publicKeySpki,
      signal: registrationSignal,
    })
  ));
  const state = {
    schemaVersion: 1,
    runtimeSessionId: registration.runtimeSessionId,
    expiresAt: registration.expiresAt,
    privateKeyPkcs8,
  };
  await writePrivateJsonFile(filePath, state);
  return state;
};

export const buildRuntimeSessionProof = ({ state, toolName, now = new Date() }) => {
  const issuedAt = now.toISOString();
  const nonce = crypto.randomUUID();
  const payload = Buffer.from([
    "trelio-runtime-proof-v1",
    state.runtimeSessionId,
    toolName,
    issuedAt,
    nonce,
  ].join("\n"), "utf8");
  const privateKey = crypto.createPrivateKey({
    key: Buffer.from(state.privateKeyPkcs8, "base64url"),
    format: "der",
    type: "pkcs8",
  });
  return {
    schemaVersion: 1,
    runtimeSessionId: state.runtimeSessionId,
    issuedAt,
    nonce,
    signature: crypto.sign(null, payload, privateKey).toString("base64url"),
  };
};

const writeUpdatedInput = (toolInput, proof) => {
  process.stdout.write(`${JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
      updatedInput: {
        ...toolInput,
        runtimeSessionProof: proof,
      },
    },
  })}\n`);
};

const runPreToolUse = async (hookInput) => {
  const toolName = resolveTrelioMcpToolName(hookInput);
  if (!isProtectedTrelioToolName(toolName)) return;
  const clientSessionId = resolveClientSessionId(hookInput);
  if (!clientSessionId) throw new Error("клиент не передал session_id");
  const origin = process.env.TRELIO_WORKSPACE_ORIGIN || "https://trelio.ru";
  const filePath = await statePathFor(clientSessionId, origin);
  let state = await readRuntimeState(filePath);
  if (!state) {
    try {
      state = await withRuntimeStateLock(filePath, async () => {
        // The winner may have completed while this process waited. Always
        // re-read after acquiring the lock before creating a second session.
        const registeredState = await readRuntimeState(filePath);
        if (registeredState) return registeredState;
        const initialObservation = await readPendingObservation(filePath);
        await fs.rm(filePath, { force: true }).catch(() => undefined);
        return createRuntimeState({
          hookInput,
          clientSessionId,
          origin,
          filePath,
          initialObservation,
        });
      });
    } catch (error) {
      // The plugin is released before the backend in the production sequence.
      // During that bounded window only, inject the hook-observed value into
      // the old server contract. A non-404 failure must remain fail-closed.
      if (Number(error?.statusCode) !== 404) throw error;
      const observation = await detectAgentRuntimeAttestation({ hookInput });
      const output = {
        ...resolveToolInput(hookInput),
        runtimeAttestation: {
          ...observation,
          evidenceLevel: observation.clientFamily === "other" ? "unavailable" : "self_reported",
          source: observation.clientFamily === "other" ? "unknown" : "agent_request",
        },
      };
      process.stdout.write(`${JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "allow",
          updatedInput: output,
        },
      })}\n`);
      return;
    }
  }
  writeUpdatedInput(resolveToolInput(hookInput), buildRuntimeSessionProof({ state, toolName }));
};

const runSessionStart = async (hookInput) => {
  const clientSessionId = resolveClientSessionId(hookInput);
  if (!clientSessionId) return;
  const origin = process.env.TRELIO_WORKSPACE_ORIGIN || "https://trelio.ru";
  const filePath = await statePathFor(clientSessionId, origin);
  const source = typeof hookInput.source === "string" ? hookInput.source : "startup";
  let stateToEnd = null;

  await withRuntimeStateLock(filePath, async () => {
    const existing = await readRuntimeState(filePath);
    if (source !== "clear" && existing) return;
    if (source !== "clear" && await readPendingObservation(filePath)) return;
    if (source === "clear") stateToEnd = existing;
    await fs.rm(filePath, { force: true }).catch(() => undefined);
    const observation = await detectAgentRuntimeAttestation({ hookInput });
    const { writePrivateJsonFile } = await loadWorkspaceBridgeModule();
    await writePrivateJsonFile(filePath, {
      schemaVersion: 1,
      pending: true,
      observation,
      createdAt: new Date().toISOString(),
    });
  });

  if (stateToEnd) {
    const { endAgentRuntimeHookSession } = await loadWorkspaceBridgeModule();
    await endAgentRuntimeHookSession({
      origin,
      runtimeSessionId: stateToEnd.runtimeSessionId,
      signal: AbortSignal.timeout(RUNTIME_END_TIMEOUT_MILLISECONDS),
    }).catch(() => undefined);
  }
};

const runSessionEnd = async (hookInput) => {
  const clientSessionId = resolveClientSessionId(hookInput);
  if (!clientSessionId) return;
  const origin = process.env.TRELIO_WORKSPACE_ORIGIN || "https://trelio.ru";
  const filePath = await statePathFor(clientSessionId, origin);
  const state = await readRuntimeState(filePath);
  // Local key removal is the privacy boundary and must complete before a slow
  // network cleanup can consume Codex's three-second SessionEnd budget. The
  // server session also expires independently if the best-effort request fails.
  await fs.rm(filePath, { force: true }).catch(() => undefined);
  if (state) {
    const { endAgentRuntimeHookSession } = await loadWorkspaceBridgeModule();
    await endAgentRuntimeHookSession({
      origin,
      runtimeSessionId: state.runtimeSessionId,
      signal: AbortSignal.timeout(RUNTIME_END_TIMEOUT_MILLISECONDS),
    }).catch(() => undefined);
  }
  // Close a narrow race with a first registration that began just before the
  // end event and completed while the bounded remote request was in flight.
  await fs.rm(filePath, { force: true }).catch(() => undefined);
};

const runHook = async () => {
  const hookInput = await readStdinJson();
  if (hookInput.hook_event_name === "SessionStart") {
    await runSessionStart(hookInput);
  } else if (hookInput.hook_event_name === "PreToolUse") {
    await runPreToolUse(hookInput);
  } else if (hookInput.hook_event_name === "SessionEnd") {
    await runSessionEnd(hookInput);
  }
};

/**
 * Ошибка из этой ветки доказывает, что lifecycle hook уже был запущен
 * клиентом. Поэтому нельзя маркировать любой его внутренний отказ как
 * `TRELIO_RUNTIME_HOOK_REQUIRED`: этот код зарезервирован для ответа Trelio,
 * когда proof не пришёл из-за действительно выключенного/неодобренного hook.
 *
 * Структурированные recovery-коды bridge/backend сохраняются, чтобы skill мог
 * выбрать точное действие. Неизвестные и противоречивые коды сворачиваются в
 * отдельный fail-closed `TRELIO_RUNTIME_HOOK_FAILED`.
 */
export const formatRuntimeHookFailure = (error) => {
  const rawCode = typeof error?.code === "string" ? error.code.trim() : "";
  const code = rawCode
    && rawCode !== HOOK_REQUIRED_CODE
    && SAFE_ERROR_CODE_PATTERN.test(rawCode)
    ? rawCode
    : HOOK_FAILED_CODE;
  const rawMessage = error instanceof Error ? error.message : String(error);
  const message = /[.!?]$/u.test(rawMessage.trim())
    ? rawMessage.trim()
    : `${rawMessage.trim()}.`;
  const recovery = PLUGIN_UPGRADE_CODES.has(code)
    ? (
        "Проверьте установленную версию плагина. Если требуемая версия уже установлена, "
        + "повторите запрос в новой задаче; иначе сначала обновите плагин. Полный "
        + "перезапуск нужен только если новая задача всё ещё видит старую версию."
      )
    : "Устраните указанную причину и повторите запрос в текущей задаче.";

  return `${code}: активный hook остановил защищённую работу Trelio. ${message} ${recovery}\n`;
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runHook().catch((error) => {
    // Эта ветка выполняется только после фактического запуска hook клиентом.
    // Поэтому общий совет включить hooks, переустановить plugin или повторить
    // pairing здесь вводил бы пользователя в заблуждение. Конкретная причина
    // выше уже содержит точный recovery, если он действительно требуется.
    process.stderr.write(formatRuntimeHookFailure(error));
    process.exitCode = 2;
  });
}
