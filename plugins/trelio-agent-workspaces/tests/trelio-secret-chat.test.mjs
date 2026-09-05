import assert from "node:assert/strict";
import { randomUUID, webcrypto } from "node:crypto";
import test from "node:test";

import {
  buildKnownAgentSecretChatWrite,
  handleKnownAgentSecretChatSave,
  normalizeKnownAgentSecretChatInput,
} from "../scripts/trelio-secret-chat.mjs";
import { createAgentEncryptionDevice, decryptCompanyPayload } from "../scripts/trelio-company-encryption.mjs";
import { BridgePairingRequiredError, BridgePluginUpgradeRequiredError } from "../scripts/trelio-workspace.mjs";
import { handleTrelioLocalActionOperation } from "../scripts/trelio-local-context.mjs";

const companyId = randomUUID();
const companySlug = "synthetic-company";
const secretId = randomUUID();
const companyMemberId = randomUUID();
const runId = randomUUID();
const canary = "SYNTHETIC-LOCAL-CHAT-" + randomUUID();
const fields = [
  { key: "username", label: "Логин " + canary, type: "username", required: true },
  { key: "password", label: "Пароль " + canary, type: "password", required: true },
  { key: "optional", label: "Заметка", type: "text", required: false },
];
const createInput = () => ({
  runId, expectedCurrentVersion: 0, clientRequestId: "synthetic-save",
  userExplicitlyRequestedPersistentStorage: true,
  values: { username: "user-" + canary, password: "password-" + canary },
  newSecret: { scopeType: "company", scopeId: companyId, name: "Доступ " + canary, fields },
});
const contextFor = (encrypted) => ({
  companyId, companySlug, companyMemberId, secretId, currentVersion: 0,
  storageMode: encrypted ? "company_e2ee" : "trelio",
  encryptionState: encrypted ? "encrypted" : "plain",
  allowAgentSaveChatSecrets: true, fields,
});
const encryptionFixture = async () => {
  const scope = await webcrypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const device = await createAgentEncryptionDevice();
  return {
    runtime: {
      state: "encrypted", accessState: "ready", company: { id: companyId, slug: companySlug },
      scope: {
        id: randomUUID(), epoch: 1,
        publicEncryptionJwk: await webcrypto.subtle.exportKey("jwk", scope.publicKey),
      },
      device: { id: randomUUID() },
    },
    device,
    scopePrivateEncryptionKey: {
      privateKey: scope.privateKey,
      privateJwk: await webcrypto.subtle.exportKey("jwk", scope.privateKey),
    },
  };
};

test("local chat input requires exact storage intent and a complete bounded target", () => {
  for (const input of [
    { ...createInput(), userExplicitlyRequestedPersistentStorage: false },
    { ...createInput(), secretId },
    { ...createInput(), value: canary },
    { ...createInput(), values: { bad: { token: canary } } },
    { ...createInput(), values: { password: "x".repeat(65537) } },
    { ...createInput(), newSecret: { ...createInput().newSecret, fields: [...fields, fields[0]] } },
  ]) {
    assert.throws(() => normalizeKnownAgentSecretChatInput(input), (error) => {
      assert.doesNotMatch(error.message, new RegExp(canary, "u"));
      return error.code === "AGENT_SECRET_CHAT_INPUT_INVALID";
    });
  }
});

test("both modes use complete replacement; E2EE metadata and values stay opaque", async () => {
  const encryption = await encryptionFixture();
  const input = normalizeKnownAgentSecretChatInput(createInput());
  const plain = await buildKnownAgentSecretChatWrite({
    input, context: contextFor(false), token: "synthetic-paired-token", companyEncryption: null,
  });
  assert.equal(plain.localWrite.contentProtection, "server_keyring_v1");
  assert.deepEqual(plain.localWrite.values, input.values);
  assert.equal(plain.localWrite.encryptedPayloads, undefined);
  const build = (source) => buildKnownAgentSecretChatWrite({
    input: source, context: contextFor(true), token: "synthetic-paired-token", companyEncryption: encryption,
  });
  const first = await build(input);
  const repeated = await build(input);
  assert.equal(first.localWrite.requestFingerprint, repeated.localWrite.requestFingerprint);
  assert.notEqual(first.localWrite.encryptedPayloads[1].ciphertext, repeated.localWrite.encryptedPayloads[1].ciphertext);
  assert.notEqual(first.localWrite.newSecret.name, repeated.localWrite.newSecret.name);
  assert.doesNotMatch(JSON.stringify(first), new RegExp(canary, "u"));
  assert.notEqual(first.localWrite.requestFingerprint, (await build({
    ...input, values: { ...input.values, password: "another-synthetic-password" },
  })).localWrite.requestFingerprint);
  for (const payload of first.localWrite.encryptedPayloads) {
    const opened = await decryptCompanyPayload({
      encryptedPayload: payload,
      scopePrivateKey: encryption.scopePrivateEncryptionKey.privateKey,
      scopePrivateJwk: encryption.scopePrivateEncryptionKey.privateJwk,
    });
    if (payload.entityType === "agent_secret.value") {
      assert.equal(payload.entityId, secretId);
      assert.equal(payload.entityRevision, 1);
      assert.deepEqual(opened.values.values_json, input.values);
    } else {
      assert.equal(opened.values.name, input.newSecret.name);
      assert.equal(opened.values.field_label_0, fields[0].label);
      assert.equal(opened.values.public_description, "");
    }
  }
  for (const encrypted of [false, true]) {
    await assert.rejects(buildKnownAgentSecretChatWrite({
      input: { ...input, values: { password: canary } },
      context: contextFor(encrypted),
      token: "synthetic-token", companyEncryption: encrypted ? encryption : null,
    }), /полную схему/u);
  }
});

test("local facade sends no E2EE plaintext and returns only whitelisted success fields", async () => {
  const encryption = await encryptionFixture();
  const calls = [];
  const proof = { synthetic: "one-use-hook-proof" };
  const result = await handleKnownAgentSecretChatSave("https://trelio.example", {
    companySlug, arguments: createInput(), runtimeSessionProof: proof,
  }, {
    getToken: async () => "synthetic-paired-token",
    checkCompatibility: async () => {},
    getEncryptionContext: async () => encryption,
    sendRequest: async (_origin, _token, pathname, options) => {
      calls.push({ pathname, ...options });
      assert.doesNotMatch(JSON.stringify(calls), new RegExp(canary, "u"));
      if (calls.length === 1) return { json: async () => contextFor(true) };
      assert.equal(JSON.parse(options.body).nativeTool, "save_known_agent_secret");
      assert.deepEqual(JSON.parse(options.body).runtimeSessionProof, proof);
      return { json: async () => ({
        structuredContent: {
          ok: true, secret: { id: secretId, currentVersion: 1, storageMode: "company_e2ee", hasValue: true, unexpectedValue: canary },
          unexpectedValue: canary,
        },
      }) };
    },
  });
  assert.equal(calls.length, 2);
  assert.equal(result.structuredContent.ok, true);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(canary, "u"));
});

test("policy denial, cancellation and unready device never submit secret bytes", async () => {
  for (const scenario of ["policy", "device", "cancel"]) {
    let calls = 0;
    const controller = new AbortController();
    if (scenario === "cancel") controller.abort();
    const result = await handleKnownAgentSecretChatSave("https://trelio.example", {
      companySlug, arguments: createInput(),
    }, {
      signal: controller.signal,
      getToken: async () => "synthetic-token",
      checkCompatibility: async () => {},
      getEncryptionContext: async () => { throw new Error(canary); },
      sendRequest: async () => {
        calls++;
        if (scenario === "policy") throw Object.assign(new Error(canary), { statusCode: 403, code: canary });
        return { json: async () => contextFor(true) };
      },
    });
    assert.equal(result.isError, true);
    assert.ok(calls <= 1);
    assert.doesNotMatch(JSON.stringify(result), new RegExp(canary, "u"));
  }
});

test("existing-card writes clear optional fields and seal only the value entity", async () => {
  const encryption = await encryptionFixture();
  const input = normalizeKnownAgentSecretChatInput({
    secretId, runId, expectedCurrentVersion: 7, clientRequestId: "rotate",
    userExplicitlyRequestedPersistentStorage: true,
    values: { ...createInput().values, optional: null },
  });
  for (const encrypted of [false, true]) {
    const write = await buildKnownAgentSecretChatWrite({
      input, context: contextFor(encrypted), token: "synthetic-token",
      companyEncryption: encrypted ? encryption : null,
    });
    assert.equal(write.localWrite.newSecret, undefined);
    assert.deepEqual(write.localWrite.fieldKeys, ["username", "password"]);
    if (encrypted) {
      assert.equal(write.localWrite.encryptedPayloads.length, 1);
      assert.equal(write.localWrite.encryptedPayloads[0].entityId, secretId);
      assert.equal(write.localWrite.encryptedPayloads[0].entityRevision, 8);
    } else {
      assert.deepEqual(write.localWrite.values, createInput().values);
    }
  }
});

test("plain facade uses the same local action and sanitizes native policy errors", async () => {
  for (const code of [null, "TRELIO_RUNTIME_HOOK_REQUIRED", "AGENT_RUNTIME_POLICY_NOT_SATISFIED", "MCP_REAUTHORIZATION_REQUIRED"]) {
    let calls = 0;
    const result = await handleKnownAgentSecretChatSave("https://trelio.example", {
      companySlug, arguments: createInput(),
    }, {
      getToken: async () => "synthetic-token", checkCompatibility: async () => {},
      getEncryptionContext: async () => { assert.fail("Plain save must not initialize company encryption."); },
      sendRequest: async (_origin, _token, pathname, options) => {
        if (++calls === 1) return { json: async () => contextFor(false) };
        assert.match(pathname, /\/actions\/execute$/u);
        assert.deepEqual(JSON.parse(options.body).arguments.localWrite.values, createInput().values);
        return { json: async () => code
          ? { isError: true, structuredContent: { code, unexpected: canary }, content: [{ text: canary }] }
          : { structuredContent: { ok: true, secret: { id: secretId, currentVersion: 1, storageMode: "trelio", hasValue: true } } },
        };
      },
    });
    assert.equal(calls, 2);
    if (code) assert.equal(result.structuredContent.code, code);
    else assert.equal(result.structuredContent.ok, true);
    assert.doesNotMatch(JSON.stringify(result), new RegExp(canary, "u"));
  }
});

test("the generic facade intercepts secrets before provider lookup and preserves host recovery", async () => {
  const rejected = await handleTrelioLocalActionOperation("https://trelio.example", {
    companySlug, nativeTool: "save_known_agent_secret",
    arguments: { ...createInput(), userExplicitlyRequestedPersistentStorage: false },
  });
  assert.equal(rejected.structuredContent.code, "AGENT_SECRET_CHAT_INPUT_INVALID");
  assert.doesNotMatch(JSON.stringify(rejected), new RegExp(canary, "u"));
  for (const error of [
    new BridgePairingRequiredError({ deviceName: "Synthetic device", pairingId: randomUUID(), expiresAt: "2099-01-01" }),
    new BridgePluginUpgradeRequiredError({ minimumVersion: "999.0.0" }),
  ]) {
    await assert.rejects(handleKnownAgentSecretChatSave("https://trelio.example", {
      companySlug, arguments: createInput(),
    }, {
      getToken: async () => { throw error; },
      sendRequest: async () => { assert.fail("No secret request precedes pairing."); },
    }), (actual) => actual === error);
    assert.doesNotMatch(error.message, new RegExp(canary, "u"));
  }
});
