import assert from "node:assert/strict";
import { randomUUID, webcrypto } from "node:crypto";
import test from "node:test";

import {
  buildGeneratedAgentSecretWrite,
  generateDeterministicPassword,
  handleGeneratedAgentSecretSave,
  normalizeGeneratedAgentSecretInput,
} from "../scripts/trelio-secret-generate.mjs";
import { createAgentEncryptionDevice, decryptCompanyPayload } from "../scripts/trelio-company-encryption.mjs";
import { handleTrelioLocalActionOperation } from "../scripts/trelio-local-context.mjs";

const companyId = randomUUID();
const companySlug = "synthetic-company";
const secretId = randomUUID();
const companyMemberId = randomUUID();
const runId = randomUUID();
const fields = [
  { key: "password", label: "Пароль", type: "password", required: true },
  { key: "recovery_password", label: "Резервный пароль", type: "password", required: false },
];
const createInput = () => ({
  runId,
  expectedCurrentVersion: 0,
  clientRequestId: "synthetic-generate",
  userExplicitlyRequestedGeneratedPersistentStorage: true,
  generatedFields: [{ key: "password", generator: "password", length: 32 }],
  newSecret: {
    scopeType: "company",
    scopeId: companyId,
    name: "OpenWrt",
    templateType: "custom",
    fields,
  },
});
const contextFor = (encrypted) => ({
  companyId,
  companySlug,
  companyMemberId,
  secretId,
  currentVersion: 0,
  storageMode: encrypted ? "company_e2ee" : "trelio",
  encryptionState: encrypted ? "encrypted" : "plain",
  generatedSecretStorageSupported: true,
  fields,
});
const encryptionFixture = async () => {
  const scope = await webcrypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits"],
  );
  const device = await createAgentEncryptionDevice();
  return {
    runtime: {
      state: "encrypted",
      accessState: "ready",
      company: { id: companyId, slug: companySlug },
      scope: {
        id: randomUUID(),
        epoch: 1,
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

test("generated-secret input is value-free, explicit and password-only", () => {
  const valid = normalizeGeneratedAgentSecretInput(createInput());
  assert.equal(valid.generatedFields[0].length, 32);
  for (const input of [
    { ...createInput(), userExplicitlyRequestedGeneratedPersistentStorage: false },
    { ...createInput(), secretId },
    { ...createInput(), value: "must-not-be-accepted" },
    { ...createInput(), generatedFields: [{ key: "password", generator: "token", length: 32 }] },
    { ...createInput(), generatedFields: [{ key: "password", generator: "password", length: 8 }] },
    { ...createInput(), newSecret: { ...createInput().newSecret, fields: [
      { key: "username", label: "Логин", type: "username", required: true },
    ] } },
  ]) {
    assert.throws(
      () => normalizeGeneratedAgentSecretInput(input),
      (error) => error.code === "AGENT_SECRET_GENERATE_INPUT_INVALID",
    );
  }
});

test("password derivation is deterministic, strong by construction and domain-sensitive", () => {
  const key = Buffer.from("synthetic-paired-device-key", "utf8");
  const first = generateDeterministicPassword({ key, seed: "request-one", length: 48 });
  const replay = generateDeterministicPassword({ key, seed: "request-one", length: 48 });
  const another = generateDeterministicPassword({ key, seed: "request-two", length: 48 });
  assert.equal(first, replay);
  assert.notEqual(first, another);
  assert.equal(first.length, 48);
  assert.match(first, /[a-z]/u);
  assert.match(first, /[A-Z]/u);
  assert.match(first, /[0-9]/u);
  assert.match(first, /[^A-Za-z0-9]/u);
});

test("generated writes are retry-stable while E2EE keeps password bytes opaque", async () => {
  const input = normalizeGeneratedAgentSecretInput(createInput());
  const encryption = await encryptionFixture();
  const build = () => buildGeneratedAgentSecretWrite({
    input,
    context: contextFor(true),
    token: "synthetic-paired-token",
    companyEncryption: encryption,
  });
  const first = await build();
  const replay = await build();
  assert.equal(first.localWrite.requestFingerprint, replay.localWrite.requestFingerprint);
  assert.notEqual(first.localWrite.encryptedPayloads[1].ciphertext, replay.localWrite.encryptedPayloads[1].ciphertext);
  assert.equal(first.userExplicitlyRequestedGeneratedPersistentStorage, true);
  assert.equal(first.userExplicitlyRequestedPersistentStorage, undefined);
  assert.equal(first.localWrite.values.$trelioE2ee.id, secretId);
  assert.equal(first.localWrite.values.$trelioE2ee.field, "values_json");

  const valuePayload = first.localWrite.encryptedPayloads.find(
    (payload) => payload.entityType === "agent_secret.value",
  );
  const opened = await decryptCompanyPayload({
    encryptedPayload: valuePayload,
    scopePrivateKey: encryption.scopePrivateEncryptionKey.privateKey,
    scopePrivateJwk: encryption.scopePrivateEncryptionKey.privateJwk,
  });
  const password = opened.values.values_json.password;
  assert.equal(password.length, 32);
  assert.match(password, /[a-z]/u);
  assert.match(password, /[A-Z]/u);
  assert.match(password, /[0-9]/u);
  assert.match(password, /[^A-Za-z0-9]/u);

  const changed = await buildGeneratedAgentSecretWrite({
    input: { ...input, clientRequestId: "another-request" },
    context: contextFor(true),
    token: "synthetic-paired-token",
    companyEncryption: encryption,
  });
  assert.notEqual(first.localWrite.requestFingerprint, changed.localWrite.requestFingerprint);
});

test("plain generation stays inside the local transport and never enters public input", async () => {
  const input = normalizeGeneratedAgentSecretInput(createInput());
  const write = await buildGeneratedAgentSecretWrite({
    input,
    context: contextFor(false),
    token: "synthetic-paired-token",
    companyEncryption: null,
  });
  assert.equal(write.localWrite.contentProtection, "server_keyring_v1");
  assert.equal(write.localWrite.values.password.length, 32);
  assert.equal(JSON.stringify(input).includes(write.localWrite.values.password), false);
});

test("local facade performs value-free preflight and returns only a safe receipt", async () => {
  const encryption = await encryptionFixture();
  const calls = [];
  const result = await handleGeneratedAgentSecretSave("https://trelio.example", {
    companySlug,
    arguments: createInput(),
    runtimeSessionProof: { synthetic: "one-use-hook-proof" },
  }, {
    getToken: async () => "synthetic-paired-token",
    checkCompatibility: async () => {},
    getEncryptionContext: async () => encryption,
    sendRequest: async (_origin, _token, pathname, options) => {
      calls.push({ pathname, ...options });
      if (calls.length === 1) {
        assert.match(pathname, /generated-save-context/u);
        assert.equal(options.body, undefined);
        return { json: async () => contextFor(true) };
      }
      const body = JSON.parse(options.body);
      assert.equal(body.nativeTool, "generate_agent_secret");
      assert.equal(body.arguments.localWrite.values.$trelioE2ee.id, secretId);
      assert.equal(body.arguments.localWrite.values.$trelioE2ee.field, "values_json");
      return { json: async () => ({
        structuredContent: {
          ok: true,
          secret: {
            id: secretId,
            currentVersion: 1,
            storageMode: "company_e2ee",
            hasValue: true,
          },
          unexpected: "server-data-must-not-pass-through",
        },
      }) };
    },
  });
  assert.equal(calls.length, 2);
  assert.deepEqual(Object.keys(result.structuredContent).sort(), ["ok", "replayed", "secret", "setupUrl"]);
  assert.equal(JSON.stringify(result).includes("server-data-must-not-pass-through"), false);
});

test("generic local action intercepts generation before provider lookup", async () => {
  const rejected = await handleTrelioLocalActionOperation("https://trelio.example", {
    companySlug,
    nativeTool: "generate_agent_secret",
    arguments: {
      ...createInput(),
      userExplicitlyRequestedGeneratedPersistentStorage: false,
    },
  });
  assert.equal(rejected.structuredContent.code, "AGENT_SECRET_GENERATE_INPUT_INVALID");
});
