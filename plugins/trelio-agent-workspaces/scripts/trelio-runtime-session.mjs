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
  "search_meetings", "list_dossiers", "list_agent_secrets", "search",
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
  const doubleUnderscore = rawName.match(/(?:^|__)trelio__([a-z0-9_]+)$/iu);
  if (doubleUnderscore) return doubleUnderscore[1].toLowerCase();
  const separated = rawName.match(/(?:^|[:./-])trelio[:./-]([a-z0-9_]+)$/iu);
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

  const registration = await retryIdempotentRequest(() => (
    registerAgentRuntimeHookSession({
      origin,
      clientSessionId,
      observation,
      publicKeySpki,
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
    const initialObservation = await readPendingObservation(filePath);
    await fs.rm(filePath, { force: true }).catch(() => undefined);
    try {
      state = await createRuntimeState({
        hookInput,
        clientSessionId,
        origin,
        filePath,
        initialObservation,
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
  if (hookInput.source && hookInput.source !== "startup") return;
  const clientSessionId = resolveClientSessionId(hookInput);
  if (!clientSessionId) return;
  const origin = process.env.TRELIO_WORKSPACE_ORIGIN || "https://trelio.ru";
  const filePath = await statePathFor(clientSessionId, origin);
  const existing = await readRuntimeState(filePath);
  if (existing) return;
  const observation = await detectAgentRuntimeAttestation({ hookInput });
  const { writePrivateJsonFile } = await loadWorkspaceBridgeModule();
  await writePrivateJsonFile(filePath, {
    schemaVersion: 1,
    pending: true,
    observation,
    createdAt: new Date().toISOString(),
  });
};

const runSessionEnd = async (hookInput) => {
  const clientSessionId = resolveClientSessionId(hookInput);
  if (!clientSessionId) return;
  const origin = process.env.TRELIO_WORKSPACE_ORIGIN || "https://trelio.ru";
  const filePath = await statePathFor(clientSessionId, origin);
  const state = await readRuntimeState(filePath);
  if (state) {
    const { endAgentRuntimeHookSession } = await loadWorkspaceBridgeModule();
    await retryIdempotentRequest(() => endAgentRuntimeHookSession({
      origin,
      runtimeSessionId: state.runtimeSessionId,
    })).catch(() => undefined);
  }
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runHook().catch((error) => {
    // Эта ветка выполняется только после фактического запуска hook клиентом.
    // Поэтому общий совет включить hooks, переустановить plugin или повторить
    // pairing здесь вводил бы пользователя в заблуждение. Конкретная причина
    // выше уже содержит точный recovery, если он действительно требуется.
    process.stderr.write(
      "TRELIO_RUNTIME_HOOK_REQUIRED: защищённая работа Trelio заблокирована. "
        + `${error instanceof Error ? error.message : String(error)}. `
        + "Устраните указанную причину и повторите запрос.\n",
    );
    process.exitCode = 2;
  });
}
