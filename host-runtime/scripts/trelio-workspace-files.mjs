import { isUtf8 } from "node:buffer";
import {
  request, requireToken, ensureBridgeCompatibility, ensureCompanyEncryptionContext,
  resolveBridgeDataPlaneRouting, hydrateAgentCompanyEncryptedJson,
} from "./trelio-workspace.mjs";
import { decryptFileFromCompanyContainerBytes } from "./trelio-company-encryption.mjs";
import { materializeLocalAttachment, LOCAL_ATTACHMENT_MAX_BYTES } from "./trelio-local-attachments.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const HEAD = /^[0-9a-f]{40,64}$/u;
const fail = (code) => { const error = new Error(code); error.code = code; throw error; };

export const validateWorkspaceFileLocator = ({ workspaceId, workspaceHead, filePath }) => {
  if (!UUID.test(String(workspaceId)) || !HEAD.test(String(workspaceHead))
    || typeof filePath !== "string" || !filePath || filePath.length > 2048
    || filePath.startsWith("/") || /[\\\x00-\x1f]/u.test(filePath)
    || filePath.split("/").some((part) => !part || part === "." || part === "..")) {
    fail("WORKSPACE_FILE_INVALID_LOCATOR");
  }
  return { workspaceId, workspaceHead, filePath };
};

/** Bound reads before allocating: a hostile/incorrect content-length is not a limit. */
const readBoundedBytes = async (response, maximum, signal) => {
  const chunks = [];
  let total = 0;
  try {
    for await (const chunk of response.body) {
      signal?.throwIfAborted();
      const bytes = Buffer.from(chunk);
      total += bytes.length;
      chunks.push(bytes);
      if (total > maximum) fail("WORKSPACE_FILE_TOO_LARGE");
    }
    return Buffer.concat(chunks);
  } finally {
    for (const chunk of chunks) chunk.fill(0);
  }
};

const openEncryptedFile = async ({ origin, token, companyEncryption, workspaceId, workspaceHead, fileId, kind, maximum, signal }) => {
  const response = await request(origin, token,
    `/api/agent-workspaces/files/${fileId}/encrypted-content`, { signal });
  if (response.headers.get("x-trelio-workspace-id") !== workspaceId
    || response.headers.get("x-trelio-workspace-head") !== workspaceHead) fail("WORKSPACE_OUTDATED");
  const ciphertext = await readBoundedBytes(response, maximum + 2 * 1024 * 1024, signal);
  let opened;
  try {
    opened = await decryptFileFromCompanyContainerBytes({
      bytes: ciphertext,
      scopePrivateKey: companyEncryption.scopePrivateEncryptionKey.privateKey,
      scopePrivateJwk: companyEncryption.scopePrivateEncryptionKey.privateJwk,
      expectedCiphertextSha256: response.headers.get("x-trelio-ciphertext-sha256"),
      maximumPlaintextBytes: maximum,
    });
    const aad = opened.header?.aad;
    if (aad?.companyId !== companyEncryption.runtime.company.id
      || aad?.scopeId !== companyEncryption.runtime.scope.id
      || aad?.scopeEpoch !== companyEncryption.runtime.scope.epoch
      || aad?.entityType !== `agent_workspace_browser_${kind}`
      || aad?.entityId !== fileId || aad?.entityRevision !== 1 || aad?.purpose !== "file") {
      fail("WORKSPACE_FILE_ENCRYPTION_BINDING_INVALID");
    }
    return opened.bytes;
  } catch (error) {
    opened?.bytes.fill(0);
    throw error;
  } finally { ciphertext.fill(0); }
};

/** Names and paths leave this function only on the trusted device. HTTP uses opaque UUIDs. */
export const readEncryptedWorkspaceFileManifest = async (input) => {
  const overview = await (await request(input.origin, input.token,
    `/api/agent-workspaces/workspaces/${input.workspaceId}`, { signal: input.signal })).json();
  const projection = overview?.encryption?.browserProjection;
  if (overview?.company?.id !== input.companyEncryption.runtime.company.id) fail("WORKSPACE_FILE_ENCRYPTION_BINDING_INVALID");
  if (overview?.workspace?.acceptedHead && overview.workspace.acceptedHead !== input.workspaceHead) fail("WORKSPACE_OUTDATED");
  if (!projection) fail("WORKSPACE_BROWSER_PROJECTION_UNAVAILABLE");
  if (projection.workspaceHead !== input.workspaceHead) fail("WORKSPACE_OUTDATED");
  if (!UUID.test(String(projection.id)) || !UUID.test(String(projection.manifestFileId))) fail("WORKSPACE_FILE_MANIFEST_INVALID");
  const bytes = await openEncryptedFile({ ...input, fileId: projection.manifestFileId, kind: "manifest", maximum: 16 * 1024 * 1024 });
  try {
    const manifest = JSON.parse(bytes.toString("utf8"));
    if (manifest?.schemaVersion !== 1 || manifest.kind !== "agent-workspace-browser-manifest"
      || manifest.projectionId !== projection.id || manifest.workspaceId !== input.workspaceId
      || manifest.workspaceHead !== input.workspaceHead || !Array.isArray(manifest.files)
      || manifest.files.length !== Number(projection.fileCount)) fail("WORKSPACE_FILE_MANIFEST_INVALID");
    const paths = new Set();
    const ids = new Set();
    for (const file of manifest.files) {
      validateWorkspaceFileLocator({ ...input, filePath: file.path });
      if (!UUID.test(String(file.id)) || ids.has(file.id) || paths.has(file.path)
        || !Number.isSafeInteger(file.sizeBytes) || file.sizeBytes < 0
        || typeof file.contentType !== "string" || file.contentType.length > 2048) fail("WORKSPACE_FILE_MANIFEST_INVALID");
      ids.add(file.id); paths.add(file.path);
    }
    return manifest.files;
  } finally { bytes.fill(0); }
};

export const readEncryptedWorkspaceSelectedFile = async (input, file) => {
  if (file.sizeBytes > LOCAL_ATTACHMENT_MAX_BYTES) fail("WORKSPACE_FILE_TOO_LARGE");
  const bytes = await openEncryptedFile({ ...input, fileId: file.id, kind: "file", maximum: Math.min(file.sizeBytes, LOCAL_ATTACHMENT_MAX_BYTES) });
  if (bytes.length !== file.sizeBytes) { bytes.fill(0); fail("WORKSPACE_FILE_SIZE_MISMATCH"); }
  return bytes;
};

/** One exact file; fresh ACL/head and authority are read even for repeated downloads. */
export const downloadAcceptedWorkspaceFile = async (origin, rawLocator, { signal } = {}) => {
  const locator = validateWorkspaceFileLocator(rawLocator);
  const token = await requireToken(origin);
  const compatibility = await ensureBridgeCompatibility(origin, token);
  const routing = compatibility?.encryptedDataPlane?.enabled === true
    ? await resolveBridgeDataPlaneRouting({ origin, token, workspaceId: locator.workspaceId })
    : { requestOrigin: origin };
  const requestOrigin = routing.requestOrigin;
  const rawSnapshot = await (await request(requestOrigin, token,
    `/api/agent-workspaces/workspaces/${locator.workspaceId}/read-snapshot`, { signal })).json();
  if (rawSnapshot?.workspace?.id !== locator.workspaceId
    || rawSnapshot.workspace.acceptedHead !== locator.workspaceHead) fail("WORKSPACE_OUTDATED");
  const companyEncryption = await ensureCompanyEncryptionContext({ origin, requestOrigin, token, company: rawSnapshot.company });
  const snapshot = await hydrateAgentCompanyEncryptedJson({ value: rawSnapshot, origin: requestOrigin, token, companyEncryption });
  const input = { ...locator, origin: requestOrigin, token, companyEncryption, signal };
  let bytes;
  let contentType;
  try {
    if (companyEncryption) {
      const files = await readEncryptedWorkspaceFileManifest(input);
      const file = files.find((candidate) => candidate.path === locator.filePath);
      if (!file) fail("WORKSPACE_FILE_NOT_FOUND");
      contentType = file.contentType;
      bytes = await readEncryptedWorkspaceSelectedFile(input, file);
    } else {
      const query = new URLSearchParams({ path: locator.filePath, head: locator.workspaceHead, download: "1" });
      const response = await request(requestOrigin, token,
        `/api/agent-workspaces/workspaces/${locator.workspaceId}/file?${query}`, { signal });
      if (response.headers.get("x-trelio-accepted-head") !== locator.workspaceHead) fail("WORKSPACE_OUTDATED");
      contentType = response.headers.get("x-trelio-file-content-type")
        || response.headers.get("content-type") || "application/octet-stream";
      bytes = await readBoundedBytes(response, LOCAL_ATTACHMENT_MAX_BYTES, signal);
    }
    const originalName = locator.filePath.split("/").at(-1);
    const file = await materializeLocalAttachment({ bytes, originalName, signal });
    return {
      schemaVersion: 1, delivery: "local-file", ...locator, originalName, contentType, ...file,
      agentInstructionsSnapshot: snapshot.agentInstructionsSnapshot,
      userProfileSnapshot: snapshot.userProfileSnapshot,
    };
  } finally { bytes?.fill(0); }
};

export const workspaceFileSearchText = (bytes) => (
  !bytes.includes(0) && isUtf8(bytes) ? bytes.toString("utf8") : ""
);
