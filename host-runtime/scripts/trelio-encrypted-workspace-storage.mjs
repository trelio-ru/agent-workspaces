import crypto from "node:crypto";
import { constants, createReadStream, createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";

import {
  canonicalJson, COMPANY_ENCRYPTION_SUITE, decryptFileFromCompanyContainer,
  encryptFileToCompanyContainer, signCompanyEncryptionRecord,
} from "./trelio-company-encryption.mjs";

export const ENCRYPTED_WORKSPACE_PART_BYTES = 8 * 1024 * 1024;
export const ENCRYPTED_WORKSPACE_MAX_MANIFEST_BYTES = 8 * 1024 * 1024;
export const ENCRYPTED_WORKSPACE_MAX_CONTAINER_BYTES = 4 * 1024 ** 4;
export const ENCRYPTED_WORKSPACE_MAX_CHAIN_LENGTH = 128;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA = /^[0-9a-f]{64}$/u;
const HEAD = /^[0-9a-f]{40,64}$/u;
const ensure = (condition, message) => { if (!condition) throw new Error(message); };

// These clear records must stay byte-identical to the backend protocol. In
// particular, paths/MIME/plaintext digests must never be spread into them.
export const buildEncryptedWorkspaceUploadRecord = (input) => ({
  suite: COMPANY_ENCRYPTION_SUITE, purpose: "agent-workspace-encrypted-upload",
  companyId: input.companyId, workspaceId: input.workspaceId, runId: input.runId,
  uploadId: input.uploadId, kind: input.kind, scopeId: input.scopeId, scopeEpoch: input.scopeEpoch,
  writerDeviceId: input.writerDeviceId, fencingToken: input.fencingToken,
  plaintextSizeBytes: input.plaintextSizeBytes, ciphertextSizeBytes: input.ciphertextSizeBytes,
  ciphertextSha256: input.ciphertextSha256, partSizeBytes: ENCRYPTED_WORKSPACE_PART_BYTES,
});

export const buildEncryptedWorkspaceProjectionRecord = (input) => ({
  suite: COMPANY_ENCRYPTION_SUITE, purpose: "agent-workspace-browser-projection-v2",
  companyId: input.companyId, workspaceId: input.workspaceId, runId: input.runId,
  projectionId: input.projectionId, baseHead: input.baseHead, workspaceHead: input.workspaceHead,
  scopeId: input.scopeId, scopeEpoch: input.scopeEpoch, writerDeviceId: input.writerDeviceId,
  fencingToken: input.fencingToken, manifestFileId: input.manifestFileId,
  files: input.files.map((file) => ({ id: file.id, kind: file.kind, sizeBytes: file.sizeBytes,
    ciphertextSha256: file.ciphertextSha256 })),
});

export const validateEncryptedWorkspaceCapabilities = (value, metadata) => {
  const limits = value?.limits;
  ensure(value?.protocolVersion === 2 && value.workspaceId === metadata.workspaceId
    && value.baseHead === metadata.baseHead && UUID.test(value.baseRevision?.id || "")
    && value.baseRevision.head === metadata.baseHead && UUID.test(value.baseRevision.scopeId || "")
    && Number.isSafeInteger(value.baseRevision.scopeEpoch) && value.baseRevision.scopeEpoch > 0
    && Number.isSafeInteger(value.baseRevision.chainLength) && value.baseRevision.chainLength >= 1
    && value.baseRevision.chainLength <= ENCRYPTED_WORKSPACE_MAX_CHAIN_LENGTH
    && limits?.partSizeBytes === ENCRYPTED_WORKSPACE_PART_BYTES
    && limits.maxManifestBytes === ENCRYPTED_WORKSPACE_MAX_MANIFEST_BYTES
    && limits.maxContainerBytes === ENCRYPTED_WORKSPACE_MAX_CONTAINER_BYTES
    && limits.maxChainLength === ENCRYPTED_WORKSPACE_MAX_CHAIN_LENGTH
    && Number.isSafeInteger(limits.maxFileBytes) && limits.maxFileBytes > 0
    && Number.isSafeInteger(limits.maxFiles) && limits.maxFiles > 0 && limits.maxFiles <= 100_000,
  "Сервер вернул неподдерживаемый encrypted storage protocol или другую базовую ревизию.");
  return value;
};

export const encryptedWorkspaceCacheKey = (value) => crypto.createHash("sha256")
  .update(canonicalJson(value)).digest("hex");

/** A completed signed publication is read back before every possible replay. */
export const publishEncryptedWorkspaceRecord = async ({ metadata, kind, record, signature, api, retry, publish }) => retry(async () => {
  const query = new URLSearchParams({ kind, workspaceHead: record.workspaceHead });
  const saved = await (await api(`/api/agent-workspaces/runs/${metadata.runId}/encrypted-storage/publication?${query}`)).json();
  if (saved !== null) {
    ensure(saved && canonicalJson(saved.record) === canonicalJson(record) && saved.signature === signature && saved.result,
      "Сервер сохранил другой подписанный результат encrypted Workspace.");
    return saved.result;
  }
  return publish();
});

/** Keep ECDSA signatures as well as randomized ciphertext stable on replay. */
export const cacheEncryptedWorkspaceRecord = async ({ cacheDirectory, key, create,
  readPrivateJsonFile, writePrivateJsonFile }) => {
  const filename = path.join(cacheDirectory, `${encryptedWorkspaceCacheKey(key)}.record.json`);
  const saved = await readPrivateJsonFile(filename, { maximumBytes: 2 * ENCRYPTED_WORKSPACE_MAX_MANIFEST_BYTES });
  if (Object.keys(saved).length) {
    ensure(saved.key === canonicalJson(key) && saved.record && typeof saved.record === "object",
      "Повреждён checkpoint encrypted Workspace.");
    return saved.record;
  }
  const record = await create();
  await writePrivateJsonFile(filename, { key: canonicalJson(key), record });
  return record;
};

/**
 * Only protected manifest plaintext participates in local deduplication.
 * Clear capabilities prove that each reused random id belongs to the exact
 * accepted base; the backend repeats that authorization during publication.
 */
export const readEncryptedWorkspaceBaseManifest = async ({ capabilities, metadata, companyEncryption,
  api, retry, readBoundedResponseBuffer, ensurePrivateDirectory }) => {
  const projection = capabilities.projection;
  if (!projection || projection.formatVersion !== 2) return new Map();
  ensure(UUID.test(projection.id || "") && projection.workspaceHead === metadata.baseHead
    && UUID.test(projection.manifestFileId || "") && Array.isArray(projection.files)
    && projection.files.length <= capabilities.limits.maxFiles + 1,
  "Сервер вернул некорректную базовую browser projection.");
  const manifestReference = projection.files.find((file) => file.id === projection.manifestFileId && file.kind === "manifest");
  ensure(manifestReference && SHA.test(manifestReference.ciphertextSha256 || ""),
    "В базовой browser projection отсутствует encrypted manifest.");
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "trelio-base-manifest-"));
  try {
    await ensurePrivateDirectory(directory);
    const bytes = await retry(async () => readBoundedResponseBuffer(
      await api(`/api/agent-workspaces/files/${projection.manifestFileId}/encrypted-content`),
      ENCRYPTED_WORKSPACE_MAX_MANIFEST_BYTES + 1024 * 1024, "Encrypted Workspace manifest"));
    ensure(bytes.length === Number(manifestReference.sizeBytes), "Размер encrypted manifest не совпадает с accepted base.");
    const encryptedPath = path.join(directory, "manifest.trelioe1");
    const manifestPath = path.join(directory, "manifest.json");
    await fs.writeFile(encryptedPath, bytes, { flag: "wx", mode: 0o600 });
    const opened = await decryptFileFromCompanyContainer({ sourcePath: encryptedPath, destinationPath: manifestPath,
      scopePrivateKey: companyEncryption.scopePrivateEncryptionKey.privateKey,
      scopePrivateJwk: companyEncryption.scopePrivateEncryptionKey.privateJwk,
      expectedCiphertextSha256: manifestReference.ciphertextSha256 });
    const aad = opened.header.aad;
    ensure(aad.companyId === companyEncryption.runtime.company.id && aad.scopeId === companyEncryption.runtime.scope.id
      && aad.scopeEpoch === companyEncryption.runtime.scope.epoch && aad.entityType === "agent_workspace_browser_manifest"
      && aad.entityId === projection.manifestFileId && aad.entityRevision === 1 && aad.schemaVersion === 1
      && aad.purpose === "file" && opened.header.plaintextSizeBytes <= ENCRYPTED_WORKSPACE_MAX_MANIFEST_BYTES,
    "Базовый manifest имеет другую AAD-привязку.");
    const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
    ensure(manifest.schemaVersion === 1 && manifest.kind === "agent-workspace-browser-manifest"
      && manifest.projectionId === projection.id && manifest.workspaceId === metadata.workspaceId
      && manifest.workspaceHead === metadata.baseHead && Array.isArray(manifest.files)
      && manifest.files.length === projection.fileCount, "Базовый manifest относится к другой ревизии.");
    const references = new Map(projection.files.map((file) => [file.id, file]));
    const result = new Map();
    const ids = new Set();
    for (const file of manifest.files) {
      const reference = references.get(file.id);
      ensure(UUID.test(file.id || "") && !ids.has(file.id) && typeof file.path === "string" && !result.has(file.path)
        && Number.isSafeInteger(file.sizeBytes) && file.sizeBytes >= 0 && SHA.test(file.plaintextSha256 || "")
        && reference?.kind === "content" && SHA.test(reference.ciphertextSha256 || ""),
      "Базовый manifest содержит повреждённую ссылку на файл.");
      ids.add(file.id); result.set(file.path, { file, reference });
    }
    return result;
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
};

const hashOpenFile = async (handle, sizeBytes) => {
  const digest = crypto.createHash("sha256");
  const buffer = Buffer.alloc(ENCRYPTED_WORKSPACE_PART_BYTES);
  let offset = 0;
  while (offset < sizeBytes) {
    const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, sizeBytes - offset), offset);
    ensure(bytesRead > 0, "Локальная encrypted копия обрезана.");
    digest.update(buffer.subarray(0, bytesRead)); offset += bytesRead;
  }
  return digest.digest("hex");
};

const readPart = async (handle, offset, sizeBytes) => {
  const bytes = Buffer.alloc(sizeBytes);
  let read = 0;
  while (read < sizeBytes) {
    const result = await handle.read(bytes, read, sizeBytes - read, offset + read);
    ensure(result.bytesRead > 0, "Локальная encrypted часть обрезана."); read += result.bytesRead;
  }
  return bytes;
};

/**
 * Persist randomized ciphertext outside the Git worktree before the first
 * request. A restarted bridge reuses the same upload UUID, signature and
 * bytes. Only an opaque local cache key is stored; plaintext source paths and
 * content hashes never appear in the server protocol.
 */
export const prepareCachedEncryptedWorkspaceFile = async ({
  cacheDirectory, cacheKey, sourcePath, kind, metadata, companyEncryption,
  originalName, mimeType, ensurePrivateDirectory, readPrivateJsonFile, writePrivateJsonFile,
}) => {
  ensure(SHA.test(cacheKey), "Некорректный ключ encrypted upload cache.");
  await ensurePrivateDirectory(cacheDirectory);
  const descriptorPath = path.join(cacheDirectory, `${cacheKey}.json`);
  const cached = await readPrivateJsonFile(descriptorPath, { maximumBytes: 16 * 1024 });
  if (Object.keys(cached).length) {
    ensure(cached.schemaVersion === 1 && cached.cacheKey === cacheKey && UUID.test(cached.uploadId || "")
      && cached.kind === kind && cached.companyId === companyEncryption.runtime.company.id
      && cached.workspaceId === metadata.workspaceId && cached.runId === metadata.runId
      && cached.scopeId === companyEncryption.runtime.scope.id && cached.scopeEpoch === companyEncryption.runtime.scope.epoch
      && cached.writerDeviceId === companyEncryption.runtime.device.id && cached.fencingToken === Number(metadata.fencingToken)
      && SHA.test(cached.ciphertextSha256 || "") && Number.isSafeInteger(cached.ciphertextSizeBytes)
      && cached.ciphertextSizeBytes > 0 && cached.ciphertextSizeBytes <= ENCRYPTED_WORKSPACE_MAX_CONTAINER_BYTES,
    "Локальная encrypted копия относится к другому Run или устройству.");
    // The uploader opens O_NOFOLLOW and verifies the bytes using that same fd.
    return { ...cached, encryptedPath: path.join(cacheDirectory, `${cached.uploadId}.trelioe1`) };
  }
  const uploadId = crypto.randomUUID();
  const encryptedPath = path.join(cacheDirectory, `${uploadId}.trelioe1`);
  const sourceStat = await fs.stat(sourcePath);
  const encrypted = await encryptFileToCompanyContainer({ sourcePath, destinationPath: encryptedPath,
    scopePublicEncryptionJwk: companyEncryption.runtime.scope.publicEncryptionJwk,
    aad: { companyId: companyEncryption.runtime.company.id, scopeId: companyEncryption.runtime.scope.id,
      scopeEpoch: companyEncryption.runtime.scope.epoch,
      entityType: kind === "revision" ? "agent_workspace_revision"
        : kind === "manifest" ? "agent_workspace_browser_manifest" : "agent_workspace_browser_file",
      entityId: kind === "revision" ? metadata.runId : uploadId,
      entityRevision: kind === "revision" ? Number(metadata.fencingToken) : 1 },
    originalName, mimeType, writerDeviceId: companyEncryption.runtime.device.id,
    signingPrivateKey: companyEncryption.device.privateKeys.signingPrivateKey,
  });
  const descriptor = { schemaVersion: 1, cacheKey, uploadId, kind,
    companyId: companyEncryption.runtime.company.id, workspaceId: metadata.workspaceId, runId: metadata.runId,
    scopeId: companyEncryption.runtime.scope.id, scopeEpoch: companyEncryption.runtime.scope.epoch,
    writerDeviceId: companyEncryption.runtime.device.id, fencingToken: Number(metadata.fencingToken),
    plaintextSizeBytes: sourceStat.size, ciphertextSha256: encrypted.ciphertextSha256,
    ciphertextSizeBytes: encrypted.ciphertextSizeBytes };
  descriptor.signature = await signCompanyEncryptionRecord(companyEncryption.device.privateKeys.signingPrivateKey,
    buildEncryptedWorkspaceUploadRecord(descriptor));
  await writePrivateJsonFile(descriptorPath, descriptor);
  return { ...descriptor, encryptedPath };
};

const validateUploadStatus = (status, file) => {
  ensure(status?.uploadId === file.uploadId && status.kind === file.kind
    && status.ciphertextSha256 === file.ciphertextSha256 && status.ciphertextSizeBytes === file.ciphertextSizeBytes
    && status.partSizeBytes === ENCRYPTED_WORKSPACE_PART_BYTES && ["ready", "uploading"].includes(status.state)
    && Array.isArray(status.parts) && status.parts.length <= Math.ceil(file.ciphertextSizeBytes / ENCRYPTED_WORKSPACE_PART_BYTES),
  "Сервер вернул другую encrypted upload session.");
  const seen = new Set();
  for (const part of status.parts) {
    ensure(Number.isSafeInteger(part.partIndex) && part.partIndex >= 0
      && part.partIndex < Math.ceil(file.ciphertextSizeBytes / ENCRYPTED_WORKSPACE_PART_BYTES)
      && !seen.has(part.partIndex) && SHA.test(part.sha256 || "")
      && part.sizeBytes === Math.min(ENCRYPTED_WORKSPACE_PART_BYTES,
        file.ciphertextSizeBytes - part.partIndex * ENCRYPTED_WORKSPACE_PART_BYTES),
    "Сервер вернул некорректную часть encrypted upload.");
    seen.add(part.partIndex);
  }
  return status;
};

/**
 * `retry` owns the existing transport cooldown. Every uncertain mutation is
 * reconciled by GET before another write, including after a process restart.
 * A hash conflict is terminal; no retry can replace an already stored part.
 */
export const uploadEncryptedWorkspaceFile = async ({ file, metadata, api, retry, onProgress = async () => {} }) => {
  const endpoint = `/api/agent-workspaces/runs/${metadata.runId}/encrypted-storage/uploads`;
  const ownEndpoint = `${endpoint}/${file.uploadId}`;
  const lease = { leaseId: metadata.leaseId, fencingToken: Number(metadata.fencingToken) };
  const jsonRequest = (pathname, body) => api(pathname, { method: "POST",
    headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((response) => response.json());
  const readStatus = async () => {
    try { return validateUploadStatus(await (await api(ownEndpoint)).json(), file); }
    catch (error) { if (error.statusCode === 404) return null; throw error; }
  };
  const handle = await fs.open(file.encryptedPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    ensure(stat.isFile() && (process.platform === "win32" || ((stat.mode & 0o777) === 0o600
      && (typeof process.getuid !== "function" || stat.uid === process.getuid())))
      && stat.size === file.ciphertextSizeBytes
      && await hashOpenFile(handle, stat.size) === file.ciphertextSha256,
    "Локальная encrypted копия изменилась; загрузка остановлена.");
    let status = await retry(async () => {
      const existing = await readStatus();
      if (existing) return existing;
      return validateUploadStatus(await jsonRequest(endpoint, { ...lease, uploadId: file.uploadId, kind: file.kind,
        scopeId: file.scopeId, scopeEpoch: file.scopeEpoch, writerDeviceId: file.writerDeviceId,
        plaintextSizeBytes: file.plaintextSizeBytes, ciphertextSizeBytes: file.ciphertextSizeBytes,
        ciphertextSha256: file.ciphertextSha256, signature: file.signature }), file);
    });
    if (status.state === "ready") return status;
    const knownParts = new Map(status.parts.map((part) => [part.partIndex, part]));
    for (let partIndex = 0, offset = 0; offset < file.ciphertextSizeBytes; partIndex += 1) {
      const bytes = await readPart(handle, offset, Math.min(ENCRYPTED_WORKSPACE_PART_BYTES, file.ciphertextSizeBytes - offset));
      const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
      const existing = knownParts.get(partIndex);
      if (existing) ensure(existing.sha256 === sha256 && existing.sizeBytes === bytes.length,
        "Уже загруженная encrypted часть не совпадает с локальной копией.");
      if (!existing) {
        let attempt = 0;
        await retry(async () => {
          if (attempt++ > 0) {
            const current = await readStatus();
            ensure(current, "Encrypted upload session исчезла после обрыва связи.");
            if (current.state === "ready") return;
            const saved = current.parts.find((part) => part.partIndex === partIndex);
            if (saved) {
              ensure(saved.sha256 === sha256 && saved.sizeBytes === bytes.length,
                "Сервер сохранил другую encrypted часть.");
              return;
            }
          }
          let response;
          try { response = await api(`${ownEndpoint}/parts/${partIndex}`, { method: "PUT",
            headers: { "content-type": "application/octet-stream", "content-length": String(bytes.length),
              "x-trelio-lease-id": lease.leaseId, "x-trelio-fencing-token": String(lease.fencingToken),
              "x-trelio-ciphertext-sha256": sha256 }, body: bytes }); }
          catch (error) {
            if (error.code !== "ENCRYPTED_UPLOAD_ALREADY_COMPLETE") throw error;
            const current = await readStatus();
            ensure(current?.state === "ready", "Encrypted upload completion was not confirmed.");
            return;
          }
          const saved = await response.json();
          ensure(saved.uploadId === file.uploadId && saved.partIndex === partIndex
            && saved.sha256 === sha256 && saved.sizeBytes === bytes.length, "Сервер не подтвердил exact encrypted часть.");
        });
      }
      offset += bytes.length;
      await onProgress({ uploadedBytes: offset, totalBytes: file.ciphertextSizeBytes });
    }
    status = await retry(async () => {
      const current = await readStatus();
      if (current?.state === "ready") return current;
      return validateUploadStatus(await jsonRequest(`${ownEndpoint}/complete`, lease), file);
    });
    ensure(status.state === "ready", "Encrypted файл ещё не собран на сервере.");
    return status;
  } finally { await handle.close(); }
};

/**
 * Turn an opaque base/delta stream into the same full local Git bundle expected
 * by existing inspect/open/history callers. Only this trusted process opens
 * company ciphertext. Each temporary frame is removed immediately after import.
 */
export const materializeEncryptedWorkspaceChain = async ({
  sourcePath, destination, companyEncryption, expectedWorkspaceId, expectedWorkspaceHead,
  expectedCiphertextSha256, runGit, ensurePrivateDirectory,
}) => {
  const source = await fs.open(sourcePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "trelio-encrypted-history-"));
  const repository = path.join(directory, "repository.git");
  try {
    await ensurePrivateDirectory(directory);
    const stat = await source.stat();
    const prefix = await readPart(source, 0, 12);
    const headerLength = prefix.readUInt32BE(8);
    ensure(prefix.subarray(0, 8).toString("ascii") === "TRELIOH1" && headerLength >= 2
      && headerLength <= ENCRYPTED_WORKSPACE_MAX_MANIFEST_BYTES && 12 + headerLength < stat.size,
    "Повреждён encrypted Workspace history container.");
    const headerBytes = await readPart(source, 12, headerLength);
    const header = JSON.parse(headerBytes.toString("utf8"));
    ensure(headerBytes.equals(Buffer.from(canonicalJson(header))) && header.schemaVersion === 1
      && header.companyId === companyEncryption.runtime.company.id && header.workspaceId === expectedWorkspaceId
      && Array.isArray(header.revisions) && header.revisions.length >= 2
      && header.revisions.length <= ENCRYPTED_WORKSPACE_MAX_CHAIN_LENGTH,
    "Encrypted история относится к другому Workspace или формату.");
    await runGit(["init", "--bare", repository]);
    let offset = 12 + headerLength;
    let previous = null;
    let opened;
    const seen = new Set();
    for (const [index, revision] of header.revisions.entries()) {
      ensure(UUID.test(revision.id || "") && !seen.has(revision.id) && HEAD.test(revision.workspaceHead || "")
        && SHA.test(revision.ciphertextSha256 || "") && Number.isSafeInteger(revision.ciphertextSizeBytes)
        && revision.ciphertextSizeBytes > 0 && revision.ciphertextSizeBytes <= ENCRYPTED_WORKSPACE_MAX_CONTAINER_BYTES
        && revision.scopeId === companyEncryption.runtime.scope.id && revision.scopeEpoch === companyEncryption.runtime.scope.epoch
        && offset + revision.ciphertextSizeBytes <= stat.size
        && (previous ? revision.bundleFormat === "delta" && revision.parentRevisionId === previous.id
          && revision.baseHead === previous.workspaceHead : revision.bundleFormat === "full" && revision.parentRevisionId === null),
      "Encrypted история содержит повреждённую или чужую базовую ревизию.");
      seen.add(revision.id);
      const encryptedPath = path.join(directory, `${index}.trelioe1`);
      const bundlePath = path.join(directory, `${index}.bundle`);
      await pipeline(source.createReadStream({ start: offset, end: offset + revision.ciphertextSizeBytes - 1, autoClose: false }),
        createWriteStream(encryptedPath, { flags: "wx", mode: 0o600 }));
      opened = await decryptFileFromCompanyContainer({ sourcePath: encryptedPath, destinationPath: bundlePath,
        scopePrivateKey: companyEncryption.scopePrivateEncryptionKey.privateKey,
        scopePrivateJwk: companyEncryption.scopePrivateEncryptionKey.privateJwk,
        expectedCiphertextSha256: revision.ciphertextSha256 });
      const aad = opened.header.aad;
      ensure(aad.companyId === header.companyId && aad.scopeId === revision.scopeId && aad.scopeEpoch === revision.scopeEpoch
        && aad.entityType === "agent_workspace_revision" && aad.schemaVersion === 1 && aad.purpose === "file"
        && UUID.test(aad.entityId || "") && Number.isSafeInteger(aad.entityRevision) && aad.entityRevision >= 1
        && opened.originalName === "workspace.bundle" && opened.mimeType === "application/vnd.git.bundle",
      "Encrypted Git bundle имеет другую AAD-привязку.");
      await runGit(["--git-dir", repository, "bundle", "verify", bundlePath]);
      await runGit(["--git-dir", repository, "bundle", "unbundle", bundlePath]);
      await runGit(["--git-dir", repository, "cat-file", "-e", `${revision.workspaceHead}^{commit}`]);
      if (previous) await runGit(["--git-dir", repository, "merge-base", "--is-ancestor", previous.workspaceHead, revision.workspaceHead]);
      await runGit(["--git-dir", repository, "update-ref", "refs/heads/trelio-candidate", revision.workspaceHead]);
      offset += revision.ciphertextSizeBytes; previous = revision;
      await fs.rm(encryptedPath); await fs.rm(bundlePath);
    }
    ensure(offset === stat.size && previous?.workspaceHead === expectedWorkspaceHead
      && previous.ciphertextSha256 === expectedCiphertextSha256,
      "Encrypted история обрезана либо не заканчивается ожидаемым head.");
    await runGit(["--git-dir", repository, "bundle", "create", destination, "refs/heads/trelio-candidate"]);
    return opened;
  } finally {
    await source.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
};
