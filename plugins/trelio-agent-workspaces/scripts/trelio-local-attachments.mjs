import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import {
  ensurePrivateDirectory,
  hardenWindowsPrivatePath,
  readPrivateJsonFile,
  resolveWorkspaceBridgeConfigDirectory,
  writePrivateJsonFile,
} from "./trelio-workspace.mjs";

export const LOCAL_ATTACHMENT_MAX_BYTES = 24 * 1024 * 1024;
export const LOCAL_ATTACHMENT_TTL_MS = 60 * 60 * 1000;
const DOWNLOAD_DIRECTORY_PATTERN = /^download-[A-Za-z0-9]{6}$/u;

/** Delete only expired snapshots owned by this primitive, never user files. */
export const pruneLocalAttachmentDownloads = async (root, now = Date.now()) => {
  await ensurePrivateDirectory(root);
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !DOWNLOAD_DIRECTORY_PATTERN.test(entry.name)) continue;
    const directory = path.join(root, entry.name);
    try {
      await ensurePrivateDirectory(directory);
      const lease = await readPrivateJsonFile(path.join(directory, ".expires.json"), { maximumBytes: 512 });
      if (lease.schemaVersion === 1 && Number.isSafeInteger(lease.expiresAtMs)
        && lease.expiresAtMs <= now) {
        await fs.rm(directory, { recursive: true, force: true });
      }
    } catch {
      // An unknown, replaced or inaccessible entry is not a cleanup target.
      // Do not report its path or contents through the MCP response.
    }
  }
};

/**
 * Materialize one already-authorized attachment outside workspace Git, mirrors
 * and plugin caches. Its plaintext has the same local trust boundary as an
 * inspected Workspace. No caller-supplied destination or filename becomes a
 * filesystem path; each request owns a new private directory and exclusive file.
 */
export const materializeLocalAttachment = async ({
  bytes, originalName, signal, root, now = Date.now(),
}) => {
  if (!Buffer.isBuffer(bytes) || bytes.length > LOCAL_ATTACHMENT_MAX_BYTES) {
    throw new Error("LOCAL_ATTACHMENT_TOO_LARGE: Attachment exceeds the local file delivery limit.");
  }
  signal?.throwIfAborted();
  if (!root) {
    const config = resolveWorkspaceBridgeConfigDirectory();
    await ensurePrivateDirectory(config);
    root = path.join(config, "attachment-downloads");
  }
  await ensurePrivateDirectory(root);
  await pruneLocalAttachmentDownloads(root, now);
  const directory = await fs.mkdtemp(path.join(root, "download-"));
  let handle;
  try {
    await ensurePrivateDirectory(directory);
    // Keep only a bounded extension for local viewers. Original names remain
    // metadata, so traversal, Windows device names and ADS never affect paths.
    const extension = /\.[A-Za-z0-9]{1,12}$/u.exec(String(originalName ?? ""))?.[0] || ".bin";
    const localFilePath = path.join(directory, `attachment${extension}`);
    handle = await fs.open(localFilePath, "wx", 0o600);
    if (process.platform === "win32") await hardenWindowsPrivatePath(localFilePath, "file");
    signal?.throwIfAborted();
    await handle.writeFile(bytes, { signal });
    await handle.sync();
    await handle.close();
    handle = null;
    signal?.throwIfAborted();
    const expiresAtMs = now + LOCAL_ATTACHMENT_TTL_MS;
    await writePrivateJsonFile(path.join(directory, ".expires.json"), {
      schemaVersion: 1, expiresAtMs,
    });
    signal?.throwIfAborted();
    // The timer does not keep an MCP host alive. After process exit, the next
    // download prunes expired leases; no persistent cleanup daemon is added.
    const timer = setTimeout(() => {
      fs.rm(directory, { recursive: true, force: true }).catch(() => undefined);
    }, Math.max(0, expiresAtMs - Date.now()));
    timer.unref();
    return {
      localFilePath, expiresAt: new Date(expiresAtMs).toISOString(),
      sizeBytes: bytes.length, sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
    };
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await fs.rm(directory, { recursive: true, force: true });
    throw error;
  }
};

/** Preserve attachment identity while stripping every binary/network delivery field. */
export const buildLocalAttachmentFileResult = ({ result, opened, file }) => {
  const { dataBase64, downloadUrl, expiresInSeconds, ...metadata } = result.structuredContent;
  return {
    ...result,
    structuredContent: {
      ...metadata,
      delivery: "local-file",
      originalName: opened.originalName,
      mimeType: opened.mimeType,
      ...file,
      instruction: "Read only the needed content from localFilePath. Cleanup is scheduled after one hour while this host runs, otherwise on the next local download. Save required durable material in the authorized Workspace. Do not return file bytes or base64 through MCP.",
    },
    content: [{ type: "text", text: "Attachment saved to an owner-private local file. Read its path, metadata and expiry from structuredContent." }],
  };
};
