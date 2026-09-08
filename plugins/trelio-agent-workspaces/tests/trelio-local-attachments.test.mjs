import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  LOCAL_ATTACHMENT_MAX_BYTES, LOCAL_ATTACHMENT_TTL_MS,
  materializeLocalAttachment, pruneLocalAttachmentDownloads,
} from "../scripts/trelio-local-attachments.mjs";
import { openLocalActionAttachmentResult } from "../scripts/trelio-local-context.mjs";
import { createAgentEncryptionDevice, encryptFileToCompanyContainer } from "../scripts/trelio-company-encryption.mjs";
import { ensurePrivateDirectory, readPrivateJsonFile } from "../scripts/trelio-workspace.mjs";

const withDirectory = async (operation) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "trelio-attachment-test-"));
  try { await operation(root); } finally { await fs.rm(root, { recursive: true, force: true }); }
};

test("local attachment files are private, unique, bounded and independent of original paths", async () => {
  await withDirectory(async (root) => {
    const bytes = Buffer.from("selected attachment\n");
    const now = Date.now();
    const first = await materializeLocalAttachment({ root, bytes, originalName: "../../CON:stream.txt", now });
    const second = await materializeLocalAttachment({ root, bytes, originalName: "../../CON:stream.txt", now });
    assert.notEqual(first.localFilePath, second.localFilePath);
    assert.equal(path.basename(first.localFilePath), "attachment.txt");
    assert.equal(path.dirname(path.dirname(first.localFilePath)), root);
    assert.deepEqual(await fs.readFile(first.localFilePath), bytes);
    assert.equal(first.sizeBytes, bytes.length);
    assert.equal(first.sha256, crypto.createHash("sha256").update(bytes).digest("hex"));
    assert.equal(first.expiresAt, new Date(now + LOCAL_ATTACHMENT_TTL_MS).toISOString());
    await ensurePrivateDirectory(path.dirname(first.localFilePath));
    // The same private-file reader verifies owner/mode on POSIX and real DACL
    // hardening on Windows; this suite also runs under a standard Windows user.
    assert.deepEqual(await readPrivateJsonFile(path.join(path.dirname(first.localFilePath), ".expires.json")), {
      schemaVersion: 1, expiresAtMs: now + LOCAL_ATTACHMENT_TTL_MS,
    });
    if (process.platform !== "win32") {
      assert.equal((await fs.stat(first.localFilePath)).mode & 0o777, 0o600);
      assert.equal((await fs.stat(path.dirname(first.localFilePath))).mode & 0o777, 0o700);
    }
    const unrelated = path.join(root, "keep.txt");
    await fs.writeFile(unrelated, "user material");
    await pruneLocalAttachmentDownloads(root, now + LOCAL_ATTACHMENT_TTL_MS - 1);
    assert.deepEqual(await fs.readFile(first.localFilePath), bytes);
    await pruneLocalAttachmentDownloads(root, now + LOCAL_ATTACHMENT_TTL_MS);
    await assert.rejects(fs.stat(first.localFilePath), { code: "ENOENT" });
    await assert.rejects(fs.stat(second.localFilePath), { code: "ENOENT" });
    assert.equal(await fs.readFile(unrelated, "utf8"), "user material");
  });
});

test("local delivery fails without plaintext fallback and removes incomplete directories", async () => {
  await withDirectory(async (root) => {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(materializeLocalAttachment({ root, bytes: Buffer.from("private"), signal: controller.signal }), { name: "AbortError" });
    await assert.rejects(materializeLocalAttachment({ root, bytes: Buffer.alloc(LOCAL_ATTACHMENT_MAX_BYTES + 1) }), /LOCAL_ATTACHMENT_TOO_LARGE/u);
    await assert.rejects(materializeLocalAttachment({
      root, bytes: Buffer.from("private"),
      originalName: { toString() { throw new Error("filename conversion failed"); } },
    }), /filename conversion failed/u);
    const midWriteAbort = new AbortController();
    await assert.rejects(materializeLocalAttachment({
      root, bytes: Buffer.from("private"), signal: midWriteAbort.signal,
      originalName: { toString() { midWriteAbort.abort(); return "file.txt"; } },
    }), { name: "AbortError" });
    assert.deepEqual(await fs.readdir(root), []);
  });
});

test("expired cleanup ignores unknown directories and symlinks", async (t) => {
  if (process.platform === "win32") return t.skip("Symlink creation requires a separate Windows privilege; real private writes run above.");
  await withDirectory(async (root) => {
    const outside = path.join(root, "user-material");
    await fs.mkdir(outside, { mode: 0o700 });
    await fs.writeFile(path.join(outside, "keep"), "must survive");
    await fs.symlink(outside, path.join(root, "download-ABC123"));
    await fs.mkdir(path.join(root, "download-DEF456"), { mode: 0o700 });
    await pruneLocalAttachmentDownloads(root, Date.now() + LOCAL_ATTACHMENT_TTL_MS);
    assert.equal(await fs.readFile(path.join(outside, "keep"), "utf8"), "must survive");
    await fs.stat(path.join(root, "download-DEF456"));
    await assert.rejects(materializeLocalAttachment({
      root: path.join(root, "download-ABC123"), bytes: Buffer.from("private"),
    }), /symbolic link|symlink|directory|Небезопасный локальный каталог/iu);
  });
});

test("encrypted download keeps bytes out of MCP, verifies the container and zeroes decrypted buffers", async () => {
  await withDirectory(async (root) => {
    const bytes = Buffer.from("confidential attachment canary\n".repeat(200));
    const sourcePath = path.join(root, "source.txt");
    const destinationPath = path.join(root, "encrypted.bin");
    await fs.writeFile(sourcePath, bytes, { mode: 0o600 });
    const device = await createAgentEncryptionDevice();
    await encryptFileToCompanyContainer({
      sourcePath, destinationPath, scopePublicEncryptionJwk: device.publicEncryptionJwk,
      originalName: "secret.txt", mimeType: "text/plain",
      aad: {
        companyId: "11111111-1111-4111-8111-111111111111",
        scopeId: "22222222-2222-4222-8222-222222222222", scopeEpoch: 1,
        entityType: "file.task_attachments", entityId: "33333333-3333-4333-8333-333333333333", entityRevision: 1,
      },
    });
    const ciphertext = await fs.readFile(destinationPath);
    const companyEncryption = { scopePrivateEncryptionKey: {
      privateKey: device.privateKeys.encryptionPrivateKey, privateJwk: device.privateBundle.encryptionPrivateJwk,
    } };
    const makeResult = (binary) => {
      const structuredContent = {
        attachmentId: "33333333-3333-4333-8333-333333333333",
        delivery: "inline-base64", dataBase64: binary.toString("base64"),
        originalName: "~e1:protected", mimeType: "~e1:protected", sizeBytes: binary.length,
        downloadUrl: "https://download.invalid/private", expiresInSeconds: 60,
      };
      return { structuredContent, content: [{ type: "text", text: JSON.stringify(structuredContent) }] };
    };
    let decrypted;
    const result = await openLocalActionAttachmentResult({
      result: makeResult(ciphertext), companyEncryption,
      materialize: async (input) => {
        decrypted = input.bytes;
        return materializeLocalAttachment({ ...input, root: path.join(root, "downloads") });
      },
    });
    assert.equal(result.structuredContent.delivery, "local-file");
    assert.equal(result.structuredContent.originalName, "secret.txt");
    assert.deepEqual(await fs.readFile(result.structuredContent.localFilePath), bytes);
    assert.equal(result.structuredContent.sizeBytes, bytes.length);
    for (const field of ["dataBase64", "downloadUrl", "expiresInSeconds"]) assert.equal(Object.hasOwn(result.structuredContent, field), false);
    assert.doesNotMatch(JSON.stringify(result), /confidential attachment canary|download\.invalid/u);
    assert.ok(Buffer.byteLength(JSON.stringify(result)) < 1_600);
    assert.ok(decrypted.every((value) => value === 0), "Decrypted RAM must be zeroed after delivery");

    let called = false;
    const corrupted = Buffer.from(ciphertext);
    corrupted[corrupted.length - 1] ^= 1;
    await assert.rejects(openLocalActionAttachmentResult({
      result: makeResult(corrupted), companyEncryption,
      materialize: async () => { called = true; },
    }));
    assert.equal(called, false, "An unauthenticated container must never reach file delivery");
    await assert.rejects(openLocalActionAttachmentResult({
      result: makeResult(ciphertext), companyEncryption,
      materialize: async (input) => { decrypted = input.bytes; throw new Error("private write failed"); },
    }), /private write failed/u);
    assert.ok(decrypted.every((value) => value === 0), "Write failures must also zero decrypted RAM");
    const failure = { isError: true, content: [{ type: "text", text: "denied" }] };
    assert.equal(await openLocalActionAttachmentResult({ result: failure }), failure);
  });
});
