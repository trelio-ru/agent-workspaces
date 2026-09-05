/**
 * Save credentials already supplied by the user through the local MCP host.
 *
 * This is deliberately separate from generic content protection: no chat value
 * enters argv, a subprocess, a file, the local mirror or remote MCP. E2EE card
 * metadata and values are sealed in this process and attached to one server
 * transaction. The original chat/tool input can still remain in the AI client.
 */
import crypto from "node:crypto";

import {
  BridgePairingRequiredError,
  BridgePluginUpgradeRequiredError,
  buildAgentEncryptedPayloadSignatureRecord,
  buildCompanyE2eeAgentSecretWrite,
  buildCompleteAgentSecretValues,
  ensureBridgeCompatibility,
  ensureCompanyEncryptionContext,
  request,
  requireToken,
} from "./trelio-workspace.mjs";
import {
  COMPANY_ENCRYPTION_SUITE,
  buildCompanyEncryptedTextMarker,
  encryptCompanyPayload,
  signCompanyEncryptionRecord,
} from "./trelio-company-encryption.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const FIELD_KEY = /^[a-z][a-z0-9_]{0,63}$/u;
const FIELD_TYPES = new Set(["username", "password", "token", "text", "key", "certificate", "totp"]);
const TEMPLATES = new Set(["legacy", "login", "api", "certificate", "custom"]);
const SAFE_NATIVE_FAILURES = new Map([
  ["TRELIO_RUNTIME_HOOK_REQUIRED", "Включите Hooks плагина Trelio Agent Workspaces и повторите запрос."],
  ["AGENT_RUNTIME_POLICY_NOT_SATISFIED", "Выберите разрешённую компанией модель и уровень reasoning, затем начните новую сессию с включёнными Hooks."],
  ["MCP_REAUTHORIZATION_REQUIRED", "Вызовите list_agent_secrets для исходной области через подключение Trelio: оно покажет штатное расширение OAuth-доступа. Сохраните ранее выданные scopes и повторите сохранение с тем же clientRequestId."],
]);
const INPUT_KEYS = new Set([
  "secretId", "runId", "expectedCurrentVersion", "clientRequestId",
  "value", "values", "newSecret", "userExplicitlyRequestedPersistentStorage",
]);

export class AgentSecretChatSaveError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}
const invalid = () => {
  // Never include the invalid input or a JSON/parser error in the exception.
  throw new AgentSecretChatSaveError("AGENT_SECRET_CHAT_INPUT_INVALID", "Проверьте цель сохранения, полную схему полей и явную просьбу сохранить доступы.");
};
const isRecord = (value) => Boolean(value && typeof value === "object" && !Array.isArray(value));
const boundedString = (value, maximum, allowEmpty = false) => (
  typeof value === "string" && (allowEmpty || value.length > 0) && value.length <= maximum
);
const canonicalJson = (value) => JSON.stringify(
  value,
  function (_key, item) {
    if (!isRecord(item)) return item;
    return Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]]));
  },
);

export const normalizeKnownAgentSecretChatInput = (input) => {
  if (
    !isRecord(input) || Object.keys(input).some((key) => !INPUT_KEYS.has(key))
    || input.userExplicitlyRequestedPersistentStorage !== true
    || !UUID.test(input.runId || "")
    || !Number.isSafeInteger(input.expectedCurrentVersion) || input.expectedCurrentVersion < 0
    || !boundedString(input.clientRequestId, 255) || input.clientRequestId !== input.clientRequestId.trim()
    || (input.value === undefined) === (input.values === undefined)
    || Boolean(input.secretId) === Boolean(input.newSecret)
  ) invalid();
  if (input.secretId && !UUID.test(input.secretId)) invalid();
  let newSecret;
  if (input.newSecret) {
    const card = input.newSecret;
    if (
      !isRecord(card)
      || Object.keys(card).some((key) => !["scopeType", "scopeId", "name", "publicDescription", "templateType", "fields"].includes(key))
      || !["company", "project", "task"].includes(card.scopeType) || !UUID.test(card.scopeId || "")
      || !boundedString(card.name?.trim(), 255)
      || (card.publicDescription !== undefined && !boundedString(card.publicDescription, 5000, true))
      || (card.templateType !== undefined && !TEMPLATES.has(card.templateType))
      || !Array.isArray(card.fields) || card.fields.length < 1 || card.fields.length > 50
      || input.expectedCurrentVersion !== 0
    ) invalid();
    const keys = new Set();
    const fields = card.fields.map((field) => {
      if (
        !isRecord(field) || Object.keys(field).some((key) => !["key", "label", "type", "required"].includes(key))
        || !FIELD_KEY.test(field.key || "") || keys.has(field.key)
        || !boundedString(field.label?.trim(), 120) || !FIELD_TYPES.has(field.type)
        || (field.required !== undefined && typeof field.required !== "boolean")
      ) invalid();
      keys.add(field.key);
      return { key: field.key, label: field.label.trim(), type: field.type, required: field.required !== false };
    });
    newSecret = {
      scopeType: card.scopeType, scopeId: card.scopeId, name: card.name.trim(),
      publicDescription: card.publicDescription?.trim() ?? "",
      templateType: card.templateType ?? "custom", fields,
    };
  }
  if (input.value !== undefined && !boundedString(input.value, 65536)) invalid();
  if (input.values !== undefined && (
    !isRecord(input.values) || Object.keys(input.values).length < 1 || Object.keys(input.values).length > 50
    || Object.entries(input.values).some(([key, value]) => (
      !FIELD_KEY.test(key) || (value !== null && !boundedString(value, 65536, true))
    ))
  )) invalid();
  if (Buffer.byteLength(JSON.stringify({ value: input.value, values: input.values }), "utf8") > 65536) invalid();
  return { ...input, ...(newSecret ? { newSecret } : {}) };
};

const protectNewSecretMetadata = async (card, context, companyEncryption) => {
  const entityId = crypto.randomUUID();
  const metadata = { name: card.name };
  if (card.publicDescription !== undefined) metadata.public_description = card.publicDescription;
  const fields = card.fields.map((field, index) => {
    const key = "field_label_" + index;
    metadata[key] = field.label;
    return { ...field, label: buildCompanyEncryptedTextMarker(entityId, key) };
  });
  const scope = companyEncryption.runtime.scope;
  const entityType = "agent_secret.metadata";
  const encrypted = await encryptCompanyPayload({
    payload: {
      suite: COMPANY_ENCRYPTION_SUITE, version: 1,
      source: { kind: "agent_secret_metadata" }, values: metadata,
    },
    scopePublicEncryptionJwk: scope.publicEncryptionJwk,
    aad: {
      companyId: context.companyId, scopeId: scope.id, scopeEpoch: scope.epoch,
      entityType, entityId, entityRevision: 1, purpose: "content",
    },
  });
  const payload = {
    ...encrypted, scopeId: scope.id, scopeEpoch: scope.epoch,
    entityType, entityId, entityRevision: 1, writerDeviceId: companyEncryption.runtime.device.id,
  };
  payload.signature = await signCompanyEncryptionRecord(
    companyEncryption.device.privateKeys.signingPrivateKey,
    buildAgentEncryptedPayloadSignatureRecord(payload),
  );
  return {
    card: {
      ...card, fields, name: buildCompanyEncryptedTextMarker(entityId, "name"),
      ...(card.publicDescription !== undefined
        ? { publicDescription: buildCompanyEncryptedTextMarker(entityId, "public_description") } : {}),
    },
    payload,
  };
};

export const buildKnownAgentSecretChatWrite = async ({ input, context, companyEncryption, token }) => {
  const encrypted = context.storageMode === "company_e2ee";
  if (
    !["trelio", "company_e2ee"].includes(context.storageMode)
    || context.encryptionState !== (encrypted ? "encrypted" : "plain")
    || context.allowAgentSaveChatSecrets !== true
    || !UUID.test(context.secretId || "") || !UUID.test(context.companyId || "")
    || !UUID.test(context.companyMemberId || "")
    || (input.secretId && input.secretId !== context.secretId)
    || encrypted !== Boolean(companyEncryption)
  ) invalid();
  const fields = input.newSecret?.fields ?? context.fields;
  if (
    !Array.isArray(fields) || fields.length < 1 || fields.length > 50
    || fields.some((field) => !FIELD_KEY.test(field.key || "") || !FIELD_TYPES.has(field.type) || typeof field.required !== "boolean")
    || new Set(fields.map((field) => field.key)).size !== fields.length
  ) invalid();
  const writeContext = { ...context, fields, currentVersion: input.expectedCurrentVersion };
  let values;
  try {
    values = buildCompleteAgentSecretValues({ valuePayload: input, context: writeContext });
  } catch {
    invalid();
  }
  if (Buffer.byteLength(JSON.stringify({ version: 1, values }), "utf8") > 65536) invalid();
  // Fingerprint the logical plaintext before randomized encryption. The key is
  // never sent to Trelio, so a persisted replay row is not a password oracle.
  // Scope-key derivation also keeps an E2EE retry stable across paired devices.
  const key = encrypted
    ? Buffer.from(companyEncryption.scopePrivateEncryptionKey?.privateJwk?.d || "", "base64url")
    : Buffer.from(token || "", "utf8");
  if (!key.length) invalid();
  let fingerprint;
  try {
    fingerprint = crypto.createHmac("sha256", key)
      .update("trelio:local-secret-chat:v1\0")
      .update(canonicalJson({
        companyId: context.companyId, memberId: context.companyMemberId,
        requestId: input.clientRequestId, secretId: context.secretId,
        runId: input.runId, expectedCurrentVersion: input.expectedCurrentVersion,
        newSecret: input.newSecret ?? null, values,
      })).digest("hex");
  } finally {
    key.fill(0);
  }
  const protectedValue = encrypted
    ? await buildCompanyE2eeAgentSecretWrite({ context: writeContext, valuePayload: { values }, companyEncryption })
    : { contentProtection: "server_keyring_v1", fieldKeys: Object.keys(values), values: { ...values } };
  const metadata = input.newSecret && encrypted
    ? await protectNewSecretMetadata(input.newSecret, context, companyEncryption)
    : null;
  const { expectedCurrentVersion: _expected, ...valueWrite } = protectedValue;
  return {
    secretId: context.secretId, runId: input.runId,
    expectedCurrentVersion: input.expectedCurrentVersion, clientRequestId: input.clientRequestId,
    userExplicitlyRequestedPersistentStorage: true,
    localWrite: {
      ...valueWrite, companySlug: context.companySlug, requestFingerprint: fingerprint,
      ...(input.newSecret ? { newSecret: metadata?.card ?? input.newSecret } : {}),
      ...(metadata ? { encryptedPayloads: [metadata.payload, ...protectedValue.encryptedPayloads] } : {}),
    },
  };
};

export const handleKnownAgentSecretChatSave = async (
  origin, rawInput,
  {
    signal,
    getToken = requireToken,
    checkCompatibility = ensureBridgeCompatibility,
    getEncryptionContext = ensureCompanyEncryptionContext,
    sendRequest = request,
  } = {},
) => {
  try {
    signal?.throwIfAborted();
    const input = normalizeKnownAgentSecretChatInput(rawInput?.arguments);
    const companySlug = rawInput?.companySlug;
    if (!boundedString(companySlug, 120) || companySlug !== companySlug.trim() || rawInput.localFilePath !== undefined) invalid();
    const token = await getToken(origin, { onStatus: () => undefined, signal });
    await checkCompatibility(origin, token, { signal });
    const query = new URLSearchParams({
      companySlug, runId: input.runId, clientRequestId: input.clientRequestId,
      ...(input.newSecret
        ? { scopeType: input.newSecret.scopeType, scopeId: input.newSecret.scopeId }
        : { secretId: input.secretId }),
    });
    const context = await (await sendRequest(origin, token, "/api/agent-secrets/chat-save-context?" + query, { signal })).json();
    if (context.companySlug !== companySlug) invalid();
    let companyEncryption = null;
    if (context.storageMode === "company_e2ee") {
      try {
        companyEncryption = await getEncryptionContext({ origin, token, company: { id: context.companyId, slug: companySlug } });
      } catch {
        throw new AgentSecretChatSaveError("AGENT_SECRET_DEVICE_NOT_READY", "Локальное устройство не готово к шифрованию. Проверьте его доступ в настройках шифрования компании, затем повторите сохранение с тем же clientRequestId.");
      }
    }
    const transport = await buildKnownAgentSecretChatWrite({ input, context, companyEncryption, token });
    signal?.throwIfAborted();
    const result = await (await sendRequest(
      origin, token,
      "/api/agent-workspaces/company-context/" + encodeURIComponent(companySlug) + "/actions/execute",
      {
        method: "POST", headers: { "content-type": "application/json" }, signal,
        body: JSON.stringify({
          nativeTool: "save_known_agent_secret", arguments: transport,
          ...(rawInput.runtimeSessionProof ? { runtimeSessionProof: rawInput.runtimeSessionProof } : {}),
        }),
      },
    )).json();
    const outcome = result.structuredContent;
    if (result.isError && SAFE_NATIVE_FAILURES.has(outcome?.code)) {
      // The local facade is not the user's remote OAuth connection. Recover
      // scopes through its exact value-free read; never echo arbitrary native
      // response text or attach another connection's challenge to this host.
      throw new AgentSecretChatSaveError(outcome.code, SAFE_NATIVE_FAILURES.get(outcome.code));
    }
    if (
      result.isError || outcome?.ok !== true || outcome.secret?.id !== context.secretId
      || outcome.secret?.storageMode !== context.storageMode || outcome.secret?.hasValue !== true
      || outcome.secret?.currentVersion !== input.expectedCurrentVersion + 1
    ) {
      throw new AgentSecretChatSaveError("AGENT_SECRET_CHAT_SAVE_REJECTED", "Сохранение не подтверждено. Проверьте разрешения, активный запуск и текущую версию карточки; повтор использует тот же clientRequestId.");
    }
    // Never pass through an arbitrary server response. Only bounded structural
    // success fields can cross back into the model/client transcript.
    const safe = {
      ok: true,
      secret: {
        id: context.secretId, storageMode: context.storageMode,
        currentVersion: outcome.secret.currentVersion, hasValue: true,
      },
      replayed: outcome.replayed === true,
      setupUrl: new URL("/" + encodeURIComponent(companySlug) + "/agent-secrets/" + context.secretId + "/setup/", origin).href,
    };
    return { structuredContent: safe, content: [{ type: "text", text: "Доступы сохранены." }] };
  } catch (error) {
    // Preserve approved local host routing for one-time pairing and upgrades.
    // These typed errors contain no value-bearing request or server response.
    if (error instanceof BridgePairingRequiredError || error instanceof BridgePluginUpgradeRequiredError) {
      throw error;
    }
    // Upstream validation/proxy errors may echo request fragments. Never expose
    // their text or body from a secret-bearing call, even on malformed input.
    const safe = error instanceof AgentSecretChatSaveError
      ? { code: error.code, message: error.message }
      : {
          code: "AGENT_SECRET_CHAT_SAVE_UNCONFIRMED",
          message: error?.statusCode === 403
            ? "Нет разрешения на сохранение. Проверьте флаг сохранения секретов из чата, права на карточку и применимый активный запуск."
            : "Сохранение доступов не подтверждено. Проверьте подключение, локальное устройство и текущую карточку перед повтором с тем же clientRequestId.",
        };
    return { isError: true, structuredContent: safe, content: [{ type: "text", text: safe.message }] };
  }
};
