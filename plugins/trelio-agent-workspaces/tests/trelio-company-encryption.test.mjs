import assert from "node:assert/strict";
import { createHash, randomBytes, webcrypto } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  COMPANY_ENCRYPTION_SUITE,
  buildAgentDeviceRegistrationRecord,
  buildEncryptedAgentWorkspaceBrowserProjectionMigrationRecord,
  buildEncryptedAgentWorkspaceBrowserProjectionRecord,
  buildEncryptedAgentWorkspaceRevisionRecord,
  calculateKeyFingerprint,
  canonicalJson,
  createAgentEncryptionDevice,
  decryptFileFromCompanyContainer,
  decryptFileFromCompanyContainerBytes,
  encryptFileToCompanyContainer,
  hpkeOpen,
  hpkeSeal,
  readExact,
  unlockRememberedAgentEncryptionDevice,
  writeAll,
  wrapAndRememberAgentEncryptionDevice,
} from "../scripts/trelio-company-encryption.mjs";

test("encrypted file helpers complete short reads and writes", async () => {
  const source = Buffer.from("short IO must not truncate encrypted frames", "utf8");
  const destination = Buffer.alloc(source.byteLength);
  const writeHandle = {
    async write(buffer, offset, length, position) {
      const bytesWritten = Math.min(3, length);
      buffer.copy(destination, position, offset, offset + bytesWritten);
      return { bytesWritten };
    },
  };
  const finalPosition = await writeAll(writeHandle, source, 0);
  assert.equal(finalPosition, source.byteLength);
  assert.deepEqual(destination, source);

  const readHandle = {
    async read(buffer, offset, length, position) {
      const bytesRead = Math.min(2, length, source.byteLength - position);
      if (bytesRead > 0) source.copy(buffer, offset, position, position + bytesRead);
      return { bytesRead };
    },
  };
  assert.deepEqual(await readExact(readHandle, source.byteLength, 0), source);
});

test("encrypted file helpers reject zero-progress IO", async () => {
  await assert.rejects(
    writeAll({ write: async () => ({ bytesWritten: 0 }) }, Buffer.from("x"), 0),
    /made no progress/u,
  );
  await assert.rejects(
    readExact({ read: async () => ({ bytesRead: 0 }) }, 1, 0),
    /truncated/u,
  );
});

test("encrypted workspace records bind accepted revision to its browser projection", () => {
  const common = {
    companyId: "11111111-1111-4111-8111-111111111111",
    workspaceId: "22222222-2222-4222-8222-222222222222",
    runId: "33333333-3333-4333-8333-333333333333",
    baseHead: "a".repeat(40),
    workspaceHead: "b".repeat(40),
    projectionId: "44444444-4444-4444-8444-444444444444",
    scopeId: "55555555-5555-4555-8555-555555555555",
    scopeEpoch: 2,
    writerDeviceId: "66666666-6666-4666-8666-666666666666",
    ciphertextSha256: "c".repeat(64),
    ciphertextSizeBytes: 1234,
    indexSha256: "d".repeat(64),
    fileCount: 3,
    fencingToken: 7,
  };
  const projection = buildEncryptedAgentWorkspaceBrowserProjectionRecord(common);
  const revision = buildEncryptedAgentWorkspaceRevisionRecord({
    ...common,
    revisionKind: "accepted",
    browserProjectionId: common.projectionId,
  });
  const migration = buildEncryptedAgentWorkspaceBrowserProjectionMigrationRecord({
    ...common,
    encryptedRevisionId: "77777777-7777-4777-8777-777777777777",
  });

  assert.equal(projection.purpose, "agent-workspace-browser-projection");
  assert.equal(projection.indexSha256, common.indexSha256);
  assert.equal(revision.browserProjectionId, common.projectionId);
  assert.equal(migration.purpose, "agent-workspace-browser-projection-migration");
  assert.equal(migration.encryptedRevisionId, "77777777-7777-4777-8777-777777777777");
});

test("agent device fingerprint uses the backend JWK canonical form", async () => {
  const device = await createAgentEncryptionDevice();

  assert.equal(Object.hasOwn(device.publicEncryptionJwk, "key_ops"), false);
  assert.equal(Object.hasOwn(device.publicSigningJwk, "key_ops"), false);
  assert.equal(calculateKeyFingerprint({
    publicEncryptionJwk: { ...device.publicEncryptionJwk, key_ops: [], alg: "ECDH-ES" },
    publicSigningJwk: { ...device.publicSigningJwk, key_ops: ["verify"], alg: "ES256" },
  }), device.fingerprint);

  const registrationRecord = buildAgentDeviceRegistrationRecord({
    companyId: "11111111-1111-4111-8111-111111111111",
    userId: "22222222-2222-4222-8222-222222222222",
    fingerprint: device.fingerprint,
    publicEncryptionJwk: { ...device.publicEncryptionJwk, key_ops: [] },
    publicSigningJwk: { ...device.publicSigningJwk, key_ops: ["verify"] },
  });
  assert.deepEqual(registrationRecord.publicEncryptionJwk, device.publicEncryptionJwk);
  assert.deepEqual(registrationRecord.publicSigningJwk, device.publicSigningJwk);
});

test("agent device survives trusted local wrapping without retaining the phrase", async () => {
  const device = await createAgentEncryptionDevice();
  const wrapped = await wrapAndRememberAgentEncryptionDevice({
    device,
    encryptionSecret: "correct horse battery staple",
    companyId: "11111111-1111-4111-8111-111111111111",
  });

  assert.equal(JSON.stringify(wrapped).includes("correct horse battery staple"), false);
  const unlocked = await unlockRememberedAgentEncryptionDevice({
    record: wrapped.record,
    trustedUnlockKey: wrapped.trustedUnlockKey,
  });
  assert.equal(unlocked.fingerprint, device.fingerprint);
});

test("agent device created by plugin 1.14.2 keeps its key pair and adopts the protocol fingerprint", async () => {
  const device = await createAgentEncryptionDevice();
  const legacyPublicEncryptionJwk = { ...device.publicEncryptionJwk, key_ops: [] };
  const legacyPublicSigningJwk = { ...device.publicSigningJwk, key_ops: ["verify"] };
  const legacyFingerprint = createHash("sha256")
    .update(canonicalJson({
      suite: COMPANY_ENCRYPTION_SUITE,
      publicEncryptionJwk: legacyPublicEncryptionJwk,
      publicSigningJwk: legacyPublicSigningJwk,
    }))
    .digest("base64url");
  assert.notEqual(legacyFingerprint, device.fingerprint);

  const wrapped = await wrapAndRememberAgentEncryptionDevice({
    device: {
      ...device,
      publicEncryptionJwk: legacyPublicEncryptionJwk,
      publicSigningJwk: legacyPublicSigningJwk,
      fingerprint: legacyFingerprint,
    },
    encryptionSecret: "correct horse battery staple",
    companyId: "11111111-1111-4111-8111-111111111111",
  });
  const unlocked = await unlockRememberedAgentEncryptionDevice({
    record: wrapped.record,
    trustedUnlockKey: wrapped.trustedUnlockKey,
  });

  assert.equal(wrapped.record.fingerprint, legacyFingerprint);
  assert.equal(unlocked.fingerprint, device.fingerprint);
  assert.deepEqual(unlocked.publicEncryptionJwk, device.publicEncryptionJwk);
  assert.deepEqual(unlocked.publicSigningJwk, device.publicSigningJwk);
});

test("dependency-free RFC 9180 implementation seals and opens P-256 envelopes", async () => {
  const recipient = await webcrypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits"],
  );
  const publicJwk = await webcrypto.subtle.exportKey("jwk", recipient.publicKey);
  const privateJwk = await webcrypto.subtle.exportKey("jwk", recipient.privateKey);
  const plaintext = randomBytes(97);
  const aad = { suite: COMPANY_ENCRYPTION_SUITE, purpose: "test-envelope", revision: 7 };
  const envelope = await hpkeSeal({
    recipientPublicEncryptionJwk: publicJwk,
    plaintext,
    aad,
  });
  const opened = await hpkeOpen({
    recipientPrivateKey: recipient.privateKey,
    recipientPrivateJwk: privateJwk,
    envelope,
    aad,
  });

  assert.deepEqual(opened, plaintext);
});

test("bridge opens an envelope produced by the browser @hpke/core implementation", async () => {
  // Static interoperability vector generated by @hpke/core 1.9.0. Keeping it
  // here catches a self-consistent but non-standard bridge implementation.
  const privateJwk = {
    key_ops: ["deriveBits"],
    ext: true,
    kty: "EC",
    x: "COYqQVPxkgh2O7v3m3l3AFDDQdLbyCPx4azyNjfVjto",
    y: "ksCZRYIFY6OuycKuR_279TnHpfLDedP49ma8SQyVQWM",
    crv: "P-256",
    d: "aWUIocuhJDsi-98Cffw7ABcWRMKwYK1YD0CqswXj7Vo",
  };
  const privateKey = await webcrypto.subtle.importKey(
    "jwk",
    privateJwk,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    ["deriveBits"],
  );
  const opened = await hpkeOpen({
    recipientPrivateKey: privateKey,
    recipientPrivateJwk: privateJwk,
    envelope: {
      enc: "BKvHZKuNAJH9NfH-vmpxzSIojPidlddToOALKEiWqW_aeEPC-TRxobZzC6vTetSDmy_Lmem7v0YaLT-vbx23Zi8",
      ciphertext: "D-5KKIqYhJWBVLfaa1I9rkJRfZwcqasiCGTefLGhJWxKRDvc96mMaK_t",
    },
    aad: { purpose: "interop", revision: 3, suite: COMPANY_ENCRYPTION_SUITE },
  });

  assert.equal(opened.toString("utf8"), "Trelio HPKE interop vector");
});

test("bridge streams a browser-compatible multi-chunk TRELIOE1 file", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "trelio-e2ee-test-"));
  const sourcePath = path.join(directory, "source.bundle");
  const encryptedPath = path.join(directory, "encrypted.bin");
  const decryptedPath = path.join(directory, "decrypted.bundle");
  const corruptedPath = path.join(directory, "corrupted.bin");
  const rejectedPlaintextPath = path.join(directory, "rejected.bundle");
  const scope = await webcrypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits"],
  );
  const publicJwk = await webcrypto.subtle.exportKey("jwk", scope.publicKey);
  const privateJwk = await webcrypto.subtle.exportKey("jwk", scope.privateKey);
  const bytes = randomBytes(4 * 1024 * 1024 + 37);

  try {
    await writeFile(sourcePath, bytes);
    const encrypted = await encryptFileToCompanyContainer({
      sourcePath,
      destinationPath: encryptedPath,
      scopePublicEncryptionJwk: publicJwk,
      aad: {
        companyId: "11111111-1111-4111-8111-111111111111",
        scopeId: "22222222-2222-4222-8222-222222222222",
        scopeEpoch: 1,
        entityType: "agent_workspace_revision",
        entityId: "33333333-3333-4333-8333-333333333333",
        entityRevision: 1,
        schemaVersion: 1,
      },
      originalName: "workspace.bundle",
      mimeType: "application/vnd.git.bundle",
    });
    const decrypted = await decryptFileFromCompanyContainer({
      sourcePath: encryptedPath,
      destinationPath: decryptedPath,
      scopePrivateKey: scope.privateKey,
      scopePrivateJwk: privateJwk,
      expectedCiphertextSha256: encrypted.ciphertextSha256,
    });
    const decryptedInMemory = await decryptFileFromCompanyContainerBytes({
      bytes: await readFile(encryptedPath),
      scopePrivateKey: scope.privateKey,
      scopePrivateJwk: privateJwk,
      expectedCiphertextSha256: encrypted.ciphertextSha256,
      maximumPlaintextBytes: bytes.byteLength,
    });

    assert.equal(decrypted.originalName, "workspace.bundle");
    assert.deepEqual(await readFile(decryptedPath), bytes);
    assert.equal(decryptedInMemory.originalName, "workspace.bundle");
    assert.deepEqual(decryptedInMemory.bytes, bytes);
    decryptedInMemory.bytes.fill(0);

    const corrupted = await readFile(encryptedPath);
    corrupted[corrupted.byteLength - 1] ^= 0xff;
    await writeFile(corruptedPath, corrupted);
    await assert.rejects(decryptFileFromCompanyContainer({
      sourcePath: corruptedPath,
      destinationPath: rejectedPlaintextPath,
      scopePrivateKey: scope.privateKey,
      scopePrivateJwk: privateJwk,
    }));
    await assert.rejects(
      stat(rejectedPlaintextPath),
      (error) => error?.code === "ENOENT",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
