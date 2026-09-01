/**
 * Encrypted-company context provider for the static local MCP facade.
 *
 * The remote Trelio server supplies only ACL-filtered structural projections,
 * E2EE markers and already encrypted Workspace bundles.  This module resolves
 * those bytes on the trusted device, publishes an atomically switched local
 * mirror encrypted with the company scope key, and executes lexical searches
 * without sending the query or snippets back to Trelio.
 */
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import {
  ensureBridgeCompatibility,
  ensureCompanyEncryptionContext,
  ensurePrivateDirectory,
  hydrateAgentCompanyEncryptedJson,
  readEncryptedWorkspaceSearchDocuments,
  readPrivateJsonFile,
  request,
  requireToken,
  resolveCompanyContextMirrorDirectory,
  writePrivateJsonFile,
} from "./trelio-workspace.mjs";
import {
  COMPANY_ENCRYPTION_SUITE,
  buildCompanyEncryptedTextMarker,
  decryptCompanyPayload,
  encryptCompanyPayload,
  signCompanyEncryptionRecord,
} from "./trelio-company-encryption.mjs";

// Version 2 adds decrypted project routing aliases to the process-only mirror.
// A version-1 generation can otherwise look server-fresh forever even though
// pre-encryption task URLs cannot resolve inside it.
const MIRROR_SCHEMA_VERSION = 2;
const MIRROR_LOCK_STALE_MS = 10 * 60 * 1000;
// A first company snapshot can legitimately hydrate thousands of tasks. When
// no readable generation exists yet, simultaneous MCP hosts join that single
// writer instead of failing after a short arbitrary timeout. The extra margin
// also lets one waiter take over a genuinely stale lock and finish normally.
const MIRROR_FIRST_SYNC_WAIT_MS = MIRROR_LOCK_STALE_MS + 30 * 1000;
const MIRROR_LOCK_HEARTBEAT_MS = 20 * 1000;
const MIRROR_GENERATION_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const TRELIO_LOCAL_MIRROR_MEMORY_TTL_SECONDS = 600;
const LOCAL_MIRROR_MEMORY_TTL_MS = TRELIO_LOCAL_MIRROR_MEMORY_TTL_SECONDS * 1000;
// The production company "Вкус" already has more than 5,000 readable active-
// project tasks.  Ten thousand keeps that real scale inside the supported
// envelope while retaining an explicit fail-closed memory/sync bound.
const MAX_CONTEXT_TASKS = 10_000;
const MAX_CONTEXT_WORKSPACES = 2_000;
const MAX_CONTEXT_DOCUMENTS = 20_000;
const MIRROR_HYDRATION_RECORD_BATCH_SIZE = 250;
const MAX_SEARCH_QUERIES = 5;
const MAX_SEARCH_RESULTS = 50;
const MIRROR_GENERATION_PATTERN = /^[0-9a-f]{64}$/u;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const AGENT_TASK_PROPOSAL_ENCRYPTED_ENTITY_TYPE = "agent_task.proposal";
const PROPOSAL_KINDS = new Set(["comment", "status", "control_clear", "checklist"]);
const localCompanyProviderCache = new Map();
// Decrypted company content must never become a persistent cache.  Keeping one
// immutable generation in the MCP process avoids decrypting and parsing the
// complete snapshot for every tool call while preserving encrypted-at-rest
// storage.  A new MCP process has an empty map and performs its own bounded
// refresh/decrypt cycle.
const localCompanyMirrorSessionCache = new Map();
// Startup freshness and plaintext residency are deliberately separate.  A
// mirror that ages out of RAM can be decrypted again from the already fresh
// encrypted generation without another network sync in the same MCP process.
const localCompanyMirrorStartupSynced = new Set();
// Normalizing every document body is materially more expensive than AES-GCM
// decryption for repeated searches.  The weak cache is tied to the immutable
// in-memory mirror, cannot outlive it, and is never serialized to disk.
const mirrorSearchIndexCache = new WeakMap();

const cacheDecryptedMirror = (sessionKey, mirror) => {
  const entry = {
    mirror,
    expiresAt: Date.now() + LOCAL_MIRROR_MEMORY_TTL_MS,
  };
  localCompanyMirrorSessionCache.set(sessionKey, entry);
  const expiryTimer = setTimeout(() => {
    // A later access may have installed a different generation/TTL.  Never let
    // an older timer evict that newer entry.
    if (localCompanyMirrorSessionCache.get(sessionKey) === entry) {
      localCompanyMirrorSessionCache.delete(sessionKey);
    }
  }, LOCAL_MIRROR_MEMORY_TTL_MS);
  // The privacy/performance timer must not keep an otherwise idle MCP host
  // alive solely to perform cache cleanup.
  expiryTimer.unref?.();
  return mirror;
};

export class TrelioLocalContextError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");
const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

const normalizeCompanySlug = (value) => {
  const companySlug = String(value || "").trim();
  if (!/^[a-z0-9](?:[a-z0-9-]{0,118}[a-z0-9])?$/u.test(companySlug)) {
    throw new TrelioLocalContextError(
      "LOCAL_CONTEXT_INVALID_INPUT",
      "companySlug must contain one exact Trelio company slug.",
    );
  }
  return companySlug;
};

const normalizeBoundedString = (value, fieldName, maximumLength) => {
  const normalized = String(value ?? "").trim();
  if (!normalized || normalized.length > maximumLength) {
    throw new TrelioLocalContextError(
      "LOCAL_CONTEXT_INVALID_INPUT",
      `${fieldName} is required and must not exceed ${maximumLength} characters.`,
    );
  }
  return normalized;
};

const normalizeUuid = (value, fieldName) => {
  const normalized = normalizeBoundedString(value, fieldName, 36).toLowerCase();
  if (!UUID_PATTERN.test(normalized)) {
    throw new TrelioLocalContextError(
      "LOCAL_CONTEXT_INVALID_INPUT",
      `${fieldName} must contain one canonical UUID.`,
    );
  }
  return normalized;
};

const normalizeInteger = (value, fieldName, minimum = 0) => {
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < minimum) {
    throw new TrelioLocalContextError(
      "LOCAL_CONTEXT_INVALID_INPUT",
      `${fieldName} must be an integer greater than or equal to ${minimum}.`,
    );
  }
  return normalized;
};

const resolveMirrorPaths = ({ origin, companyId }) => {
  const originHash = sha256(origin).slice(0, 32);
  const root = path.join(resolveCompanyContextMirrorDirectory(), originHash, companyId);
  return {
    root,
    generations: path.join(root, "generations"),
    pointer: path.join(root, "current.json"),
    lock: path.join(root, "sync.lock"),
  };
};

const inspectLockOwner = async (lockDirectory) => {
  const owner = await readPrivateJsonFile(path.join(lockDirectory, "owner.json"));
  let metadata;
  try {
    metadata = await fs.stat(path.join(lockDirectory, `${owner.lockId}.heartbeat.json`));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    // A process can die between mkdir and heartbeat publication. The directory
    // timestamp then provides a bounded stale takeover instead of an immortal
    // malformed lock.
    metadata = await fs.stat(lockDirectory);
  }
  return { owner, metadata };
};

const acquireMirrorWriter = async (paths, { allowReadableFallback = false } = {}) => {
  await ensurePrivateDirectory(paths.root);
  const lockId = crypto.randomUUID();
  const startedAt = Date.now();

  while (Date.now() - startedAt < MIRROR_FIRST_SYNC_WAIT_MS) {
    try {
      await fs.mkdir(paths.lock, { mode: 0o700 });
      await writePrivateJsonFile(path.join(paths.lock, "owner.json"), {
        schemaVersion: 1,
        lockId,
        pid: process.pid,
        createdAt: new Date().toISOString(),
      });
      const heartbeatPath = path.join(paths.lock, `${lockId}.heartbeat.json`);
      await writePrivateJsonFile(heartbeatPath, { schemaVersion: 1, lockId });
      // A full first sync may legitimately take longer than the stale-lock
      // threshold. Refresh only the lock that still carries our random owner
      // id, otherwise an old process could accidentally keep a replacement
      // writer alive after its directory was atomically taken over.
      const heartbeat = setInterval(() => {
        void (async () => {
          const owner = await readPrivateJsonFile(path.join(paths.lock, "owner.json"));
          if (owner.lockId === lockId) {
            const now = new Date();
            // The heartbeat filename contains this writer's random id. If the
            // directory was renamed and replaced between the owner read and
            // this call, a new lock cannot contain that path, so the old
            // writer cannot refresh the replacement by accident.
            await fs.utimes(heartbeatPath, now, now);
          }
        })().catch(() => undefined);
      }, MIRROR_LOCK_HEARTBEAT_MS);
      heartbeat.unref();
      return {
        lockId,
        release: async () => {
          clearInterval(heartbeat);
          const owner = await readPrivateJsonFile(path.join(paths.lock, "owner.json"));
          if (owner.lockId === lockId) {
            await fs.rm(paths.lock, { recursive: true, force: true });
          }
        },
      };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      let current;
      try {
        current = await inspectLockOwner(paths.lock);
      } catch (inspectionError) {
        if (inspectionError.code === "ENOENT") continue;
        throw inspectionError;
      }
      if (Date.now() - current.metadata.mtimeMs > MIRROR_LOCK_STALE_MS) {
        const stalePath = `${paths.lock}.stale-${crypto.randomUUID()}`;
        try {
          // Rename wins against only the exact observed lock entry. A live
          // writer that refreshed/replaced it causes ENOENT and the loop
          // simply rereads current state.
          await fs.rename(paths.lock, stalePath);
          await fs.rm(stalePath, { recursive: true, force: true });
        } catch (takeoverError) {
          if (takeoverError.code !== "ENOENT") throw takeoverError;
        }
        continue;
      }
      if (allowReadableFallback) {
        // A complete previous generation is preferable to queueing every
        // simultaneous chat behind a healthy refresh. Its immutable pointer
        // remains valid until the writer atomically publishes the replacement.
        return null;
      }
      await delay(200);
    }
  }

  throw new TrelioLocalContextError(
    "LOCAL_CONTEXT_SYNC_BUSY",
    "Another local process is still publishing this company context mirror.",
  );
};

const readMirrorGeneration = async ({ paths, companyEncryption }) => {
  const pointer = await readPrivateJsonFile(paths.pointer);
  if (Object.keys(pointer).length === 0) return null;
  if (pointer.schemaVersion === 1) {
    // Version 1 remains encrypted and harmless on disk, but it lacks the
    // process-only routing aliases introduced in version 2. Ignore it as a
    // stale cache and let the normal writer publish a complete replacement.
    return null;
  }
  if (
    pointer.schemaVersion !== MIRROR_SCHEMA_VERSION
    || pointer.companyId !== companyEncryption.runtime.company.id
    || !MIRROR_GENERATION_PATTERN.test(String(pointer.generation || ""))
  ) {
    throw new TrelioLocalContextError(
      "LOCAL_CONTEXT_MIRROR_INVALID",
      "The local company context pointer is invalid.",
    );
  }
  const record = await readPrivateJsonFile(
    path.join(paths.generations, `${pointer.generation}.json`),
  );
  if (
    record.schemaVersion !== MIRROR_SCHEMA_VERSION
    || record.companyId !== pointer.companyId
    || record.generation !== pointer.generation
    || record.encryptedPayload?.aad?.entityType !== "agent_context.mirror"
  ) {
    throw new TrelioLocalContextError(
      "LOCAL_CONTEXT_MIRROR_INVALID",
      "The local company context generation is invalid.",
    );
  }
  const payload = await decryptCompanyPayload({
    encryptedPayload: record.encryptedPayload,
    scopePrivateKey: companyEncryption.scopePrivateEncryptionKey.privateKey,
    scopePrivateJwk: companyEncryption.scopePrivateEncryptionKey.privateJwk,
  });
  if (
    payload?.schemaVersion !== MIRROR_SCHEMA_VERSION
    || payload.company?.id !== pointer.companyId
    || payload.generation !== pointer.generation
  ) {
    throw new TrelioLocalContextError(
      "LOCAL_CONTEXT_MIRROR_INVALID",
      "The decrypted company context generation does not match its pointer.",
    );
  }
  return payload;
};

const pruneOldMirrorGenerations = async (paths, currentGeneration) => {
  let entries;
  try {
    entries = await fs.readdir(paths.generations, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  const cutoff = Date.now() - MIRROR_GENERATION_RETENTION_MS;
  for (const entry of entries) {
    const generation = entry.name.replace(/\.json$/u, "");
    if (
      !entry.isFile()
      || generation === currentGeneration
      || !MIRROR_GENERATION_PATTERN.test(generation)
    ) {
      continue;
    }
    const generationPath = path.join(paths.generations, entry.name);
    const metadata = await fs.stat(generationPath);
    if (metadata.mtimeMs < cutoff) {
      await fs.rm(generationPath, { force: true });
    }
  }
};

const publishMirrorGeneration = async ({
  paths,
  companyEncryption,
  mirror,
}) => {
  const generation = sha256(JSON.stringify({
    serverGeneration: mirror.serverGeneration,
    taskRevisions: mirror.tasks.map((task) => [task.id, task.revisionToken]),
    workspaceHeads: mirror.workspaces.map((workspace) => [workspace.id, workspace.acceptedHead]),
    createdAt: mirror.createdAt,
  }));
  const entityId = crypto.randomUUID();
  const payload = {
    ...mirror,
    schemaVersion: MIRROR_SCHEMA_VERSION,
    generation,
  };
  const encryptedPayload = await encryptCompanyPayload({
    payload,
    scopePublicEncryptionJwk: companyEncryption.runtime.scope.publicEncryptionJwk,
    aad: {
      companyId: companyEncryption.runtime.company.id,
      scopeId: companyEncryption.runtime.scope.id,
      scopeEpoch: companyEncryption.runtime.scope.epoch,
      entityType: "agent_context.mirror",
      entityId,
      entityRevision: 1,
      purpose: "content",
    },
  });

  await ensurePrivateDirectory(paths.generations);
  await writePrivateJsonFile(path.join(paths.generations, `${generation}.json`), {
    schemaVersion: MIRROR_SCHEMA_VERSION,
    companyId: companyEncryption.runtime.company.id,
    generation,
    serverGeneration: mirror.serverGeneration,
    createdAt: mirror.createdAt,
    encryptedPayload,
  });
  // Pointer publication is the only visibility switch. Readers that started
  // before this rename keep their immutable old generation while new readers
  // get the complete new one; no search can observe a half-synced mirror.
  await writePrivateJsonFile(paths.pointer, {
    schemaVersion: MIRROR_SCHEMA_VERSION,
    companyId: companyEncryption.runtime.company.id,
    companySlug: companyEncryption.runtime.company.slug,
    generation,
    serverGeneration: mirror.serverGeneration,
    createdAt: mirror.createdAt,
  });
  await pruneOldMirrorGenerations(paths, generation);
  return payload;
};

const readJson = async (response) => response.json();

const buildEncryptedPayloadSignatureRecord = (payload) => ({
  suite: payload.suite,
  scopeId: payload.scopeId,
  scopeEpoch: payload.scopeEpoch,
  entityType: payload.entityType,
  entityId: payload.entityId,
  entityRevision: payload.entityRevision,
  schemaVersion: payload.schemaVersion,
  nonce: payload.nonce,
  ciphertext: payload.ciphertext,
  wrappedDataKey: payload.wrappedDataKey,
  aad: payload.aad,
  ciphertextSha256: payload.ciphertextSha256,
  writerDeviceId: payload.writerDeviceId,
});

const protectProposalValues = async ({ companyEncryption, values, source }) => {
  const entityId = crypto.randomUUID();
  const encrypted = await encryptCompanyPayload({
    payload: {
      suite: COMPANY_ENCRYPTION_SUITE,
      version: 1,
      source,
      values,
    },
    scopePublicEncryptionJwk: companyEncryption.runtime.scope.publicEncryptionJwk,
    aad: {
      companyId: companyEncryption.runtime.company.id,
      scopeId: companyEncryption.runtime.scope.id,
      scopeEpoch: companyEncryption.runtime.scope.epoch,
      entityType: AGENT_TASK_PROPOSAL_ENCRYPTED_ENTITY_TYPE,
      entityId,
      entityRevision: 1,
      purpose: "content",
    },
  });
  const payload = {
    ...encrypted,
    scopeId: companyEncryption.runtime.scope.id,
    scopeEpoch: companyEncryption.runtime.scope.epoch,
    entityType: AGENT_TASK_PROPOSAL_ENCRYPTED_ENTITY_TYPE,
    entityId,
    entityRevision: 1,
    writerDeviceId: companyEncryption.runtime.device.id,
  };
  payload.signature = await signCompanyEncryptionRecord(
    companyEncryption.device.privateKeys.signingPrivateKey,
    buildEncryptedPayloadSignatureRecord(payload),
  );
  return {
    payload,
    markers: Object.fromEntries(Object.keys(values).map((field) => [
      field,
      buildCompanyEncryptedTextMarker(entityId, field),
    ])),
  };
};

const uploadProposalPayload = async ({
  origin,
  token,
  companyEncryption,
  values,
  source,
  signal,
}) => {
  const protectedValues = await protectProposalValues({
    companyEncryption,
    values,
    source,
  });
  await request(origin, token, "/api/agent-workspaces/encryption/payloads", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      companySlug: companyEncryption.runtime.company.slug,
      writerDeviceId: companyEncryption.runtime.device.id,
      payloads: [protectedValues.payload],
    }),
    signal,
  });
  return protectedValues.markers;
};

const resolveLocalCompanyProvider = async ({
  origin,
  companySlug,
  signal,
  allowCached = false,
}) => {
  const cacheKey = `${origin}\n${companySlug}`;
  if (allowCached && localCompanyProviderCache.has(cacheKey)) {
    return localCompanyProviderCache.get(cacheKey);
  }
  const token = await requireToken(origin, { onStatus: () => undefined, signal });
  await ensureBridgeCompatibility(origin, token, { signal });
  const companyEncryption = await ensureCompanyEncryptionContext({
    origin,
    token,
    company: { slug: companySlug },
  });
  if (companyEncryption) {
    // Cache only process-memory key material after a live provider check. It
    // enables every later query in this MCP process to read the encrypted
    // immutable mirror fully offline; nothing is serialized as plaintext.
    const provider = { token, companyEncryption };
    localCompanyProviderCache.set(cacheKey, provider);
    return provider;
  }
  return {
    nativeProvider: true,
    result: {
      schemaVersion: 1,
      provider: "native_trelio",
      company: { slug: companySlug },
      instruction: "Continue with the ordinary native Trelio tool for this operation.",
    },
  };
};

const fetchManifest = async ({ origin, token, companySlug, signal }) => (
  readJson(await request(
    origin,
    token,
    `/api/agent-workspaces/company-context/${encodeURIComponent(companySlug)}/manifest`,
    { signal },
  ))
);

const mapWithConcurrency = async (items, concurrency, mapper) => {
  const results = new Array(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
};

export const hydrateChangedCompanyMirrorRecords = async ({
  records,
  load,
  hydrate,
  concurrency = 6,
}) => {
  const results = new Array(records.length);
  const changedRecords = [];
  records.forEach((record, index) => {
    if (Object.hasOwn(record, "source")) {
      changedRecords.push({ index, source: record.source });
    } else {
      results[index] = record.cached;
    }
  });
  for (
    let offset = 0;
    offset < changedRecords.length;
    offset += MIRROR_HYDRATION_RECORD_BATCH_SIZE
  ) {
    const batch = changedRecords.slice(offset, offset + MIRROR_HYDRATION_RECORD_BATCH_SIZE);
    const rawValues = await mapWithConcurrency(
      batch,
      concurrency,
      (record) => load(record.source),
    );
    // A bounded record batch lets the shared E2EE resolver collect markers
    // across many changed tasks/documents, while avoiding a second full raw
    // company copy in RAM. The hydrator additionally splits at its 250-entity
    // server boundary, so request count no longer follows task count.
    const hydratedValues = await hydrate(rawValues);
    if (!Array.isArray(hydratedValues) || hydratedValues.length !== batch.length) {
      throw new TrelioLocalContextError(
        "LOCAL_CONTEXT_INVALID_HYDRATION",
        "Trelio returned an invalid hydrated company-context batch.",
      );
    }
    batch.forEach((record, batchIndex) => {
      results[record.index] = hydratedValues[batchIndex];
    });
  }
  return results;
};

const fetchTaskProjection = async ({
  origin,
  token,
  companySlug,
  task,
  signal,
}) => readJson(await request(
    origin,
    token,
    `/api/agent-workspaces/company-context/${encodeURIComponent(companySlug)}`
      + `/tasks/${encodeURIComponent(task.projectSlug)}/${task.number}`
      + `?${new URLSearchParams({ expectedRevision: task.revisionToken }).toString()}`,
    { signal },
  ));

const buildWorkspaceRecord = async ({
  origin,
  token,
  companyEncryption,
  workspace,
  signal,
}) => ({
  ...workspace,
  documents: await readEncryptedWorkspaceSearchDocuments({
    origin,
    token,
    companyEncryption,
    workspaceId: workspace.id,
    acceptedHead: workspace.acceptedHead,
    signal,
  }),
});

const buildMirror = async ({
  origin,
  token,
  companyEncryption,
  rawManifest,
  previous,
  signal,
}) => {
  if (
    rawManifest?.schemaVersion !== 1
    || rawManifest.provider !== "local_company_context"
    || rawManifest.company?.id !== companyEncryption.runtime.company.id
    || rawManifest.company?.slug !== companyEncryption.runtime.company.slug
    || !MIRROR_GENERATION_PATTERN.test(String(rawManifest.generation || ""))
  ) {
    throw new TrelioLocalContextError(
      "LOCAL_CONTEXT_INVALID_MANIFEST",
      "Trelio returned an invalid local company-context manifest.",
    );
  }
  if ((rawManifest.tasks?.length ?? 0) > MAX_CONTEXT_TASKS) {
    throw new TrelioLocalContextError(
      "LOCAL_CONTEXT_TOO_LARGE",
      `The company context contains more than ${MAX_CONTEXT_TASKS} accessible tasks.`,
    );
  }
  if ((rawManifest.acceptedWorkspaces?.length ?? 0) > MAX_CONTEXT_WORKSPACES) {
    throw new TrelioLocalContextError(
      "LOCAL_CONTEXT_TOO_LARGE",
      `The company context contains more than ${MAX_CONTEXT_WORKSPACES} accepted Workspaces.`,
    );
  }
  if ((rawManifest.contextDocuments?.length ?? 0) > MAX_CONTEXT_DOCUMENTS) {
    throw new TrelioLocalContextError(
      "LOCAL_CONTEXT_TOO_LARGE",
      `The company context contains more than ${MAX_CONTEXT_DOCUMENTS} first-class documents.`,
    );
  }

  // Keep independently revisioned domain documents outside the eager pass.
  // Their unchanged ciphertext markers can reuse the previous encrypted
  // generation without another decrypt/resolve cycle.
  const manifest = await hydrateAgentCompanyEncryptedJson({
    value: { ...rawManifest, contextDocuments: [] },
    origin,
    token,
    companyEncryption,
    signal,
  });
  const previousTasks = new Map((previous?.tasks ?? []).map((task) => [task.id, task]));
  const taskRecords = (manifest.tasks ?? []).map((task) => {
    const cached = previousTasks.get(task.id);
    return cached?.revisionToken === task.revisionToken
      ? { task, cached }
      : { task, source: task };
  });
  const hydratedTaskRecords = await hydrateChangedCompanyMirrorRecords({
    records: taskRecords,
    load: (task) => fetchTaskProjection({
      origin,
      token,
      companySlug: manifest.company.slug,
      task,
      signal,
    }),
    hydrate: (value) => hydrateAgentCompanyEncryptedJson({
      value,
      origin,
      token,
      companyEncryption,
      signal,
    }),
  });
  const tasks = taskRecords.map((record, index) => {
    if (record.cached) return record.cached;
    return {
      id: record.task.id,
      projectId: record.task.projectId,
      projectSlug: record.task.projectSlug,
      number: record.task.number,
      revisionToken: record.task.revisionToken,
      payload: hydratedTaskRecords[index].task,
    };
  });
  const previousWorkspaces = new Map(
    (previous?.workspaces ?? []).map((workspace) => [workspace.id, workspace]),
  );
  // Bundle opening is intentionally serial. It bounds disk/CPU pressure and
  // leaves Run/workspace locks untouched; only this short per-company mirror
  // writer is exclusive, while independent Agent Runs remain concurrent.
  const workspaces = [];
  for (const workspace of manifest.acceptedWorkspaces ?? []) {
    const cached = previousWorkspaces.get(workspace.id);
    workspaces.push(cached?.acceptedHead === workspace.acceptedHead
      ? cached
      : await buildWorkspaceRecord({ origin, token, companyEncryption, workspace, signal }));
  }
  const previousContextDocuments = new Map(
    (previous?.contextDocuments ?? []).map((document) => [document.id, document]),
  );
  const contextDocumentRecords = (rawManifest.contextDocuments ?? []).map((document) => {
    const cached = previousContextDocuments.get(document.id);
    return cached?.revisionToken === document.revisionToken
      ? { cached }
      : { source: document };
  });
  const contextDocuments = await hydrateChangedCompanyMirrorRecords({
    records: contextDocumentRecords,
    load: async (document) => document,
    hydrate: (value) => hydrateAgentCompanyEncryptedJson({
      value,
      origin,
      token,
      companyEncryption,
      signal,
    }),
  });

  return {
    schemaVersion: MIRROR_SCHEMA_VERSION,
    serverGeneration: manifest.generation,
    createdAt: new Date().toISOString(),
    company: manifest.company,
    viewer: manifest.viewer,
    projects: manifest.projects ?? [],
    dossiers: manifest.dossiers ?? [],
    contextDocuments,
    instructions: manifest.instructions,
    tasks,
    workspaces,
  };
};

export const syncCompanyContextMirror = async ({
  origin,
  token,
  companyEncryption,
  signal,
}) => {
  const companySlug = companyEncryption.runtime.company.slug;
  const paths = resolveMirrorPaths({
    origin,
    companyId: companyEncryption.runtime.company.id,
  });
  let previous = await readMirrorGeneration({ paths, companyEncryption });
  const writer = await acquireMirrorWriter(paths, {
    allowReadableFallback: Boolean(previous),
  });
  if (!writer) {
    return {
      mirror: previous,
      changed: false,
      syncInProgress: true,
      paths,
    };
  }

  try {
    // Another writer may have published between the optimistic read and our
    // lock acquisition. Always reread the atomic pointer under ownership.
    previous = await readMirrorGeneration({ paths, companyEncryption });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const startingManifest = await fetchManifest({
        origin,
        token,
        companySlug,
        signal,
      });
      if (previous?.serverGeneration === startingManifest.generation) {
        return { mirror: previous, changed: false, paths };
      }
      let candidate;
      try {
        candidate = await buildMirror({
          origin,
          token,
          companyEncryption,
          rawManifest: startingManifest,
          previous,
          signal,
        });
      } catch (error) {
        if (error?.code !== "LOCAL_CONTEXT_GENERATION_CHANGED") throw error;
        // A neighboring Run can advance one task/workspace revision between
        // manifest and projection reads. That is an optimistic read conflict,
        // not a broken mirror: restart from the next canonical manifest within
        // the same three-attempt bound instead of leaking the raw API 409.
        previous = await readMirrorGeneration({ paths, companyEncryption });
        continue;
      }
      const finishingManifest = await fetchManifest({
        origin,
        token,
        companySlug,
        signal,
      });
      if (finishingManifest.generation !== startingManifest.generation) {
        previous = await readMirrorGeneration({ paths, companyEncryption });
        continue;
      }
      return {
        mirror: await publishMirrorGeneration({ paths, companyEncryption, mirror: candidate }),
        changed: true,
        paths,
      };
    }
    throw new TrelioLocalContextError(
      "LOCAL_CONTEXT_GENERATION_CHANGED",
      "Company context kept changing during three bounded snapshot attempts.",
    );
  } finally {
    await writer.release();
  }
};

const collectText = (value, output = []) => {
  if (typeof value === "string") {
    if (value.trim()) output.push(value);
  } else if (Array.isArray(value)) {
    value.forEach((item) => collectText(item, output));
  } else if (value && typeof value === "object") {
    Object.values(value).forEach((item) => collectText(item, output));
  }
  return output;
};

const normalizeSearchText = (value) => String(value ?? "")
  .normalize("NFKC")
  .toLocaleLowerCase("ru")
  .replace(/[^\p{L}\p{N}]+/gu, " ")
  .trim()
  .replace(/\s+/gu, " ");

const buildPreview = (text, normalizedQuery) => {
  const compact = String(text || "").replace(/\s+/gu, " ").trim();
  if (!compact) return "";
  const normalizedText = normalizeSearchText(compact);
  const matchIndex = normalizedText.indexOf(normalizedQuery);
  if (matchIndex < 0) return compact.slice(0, 600);
  // Normalization can shift offsets slightly. A bounded neighbourhood remains
  // useful without trying to reconstruct a byte-exact source selection.
  const start = Math.max(0, matchIndex - 180);
  return compact.slice(start, start + 600);
};

const buildTaskSearchText = (taskPayload) => {
  const task = taskPayload?.task ?? taskPayload ?? {};
  const customFields = task.customFields?.fields ?? task.customFields ?? [];
  const comments = Array.isArray(task.comments)
    ? task.comments.filter((comment) => comment?.kind === "manual")
    : [];

  // Rich-text JSON and its plain-text projection carry the same prose.  The
  // mirror retains the canonical JSON for an exact fetch, while the ephemeral
  // search index takes only the plain projection so RAM does not double again.
  return collectText({
    title: task.title,
    description: task.descriptionPlainText ?? task.description,
    status: task.status?.name ?? task.status?.code,
    assignee: task.assignee,
    participants: task.participants,
    participantGroups: task.participantGroups,
    controls: task.controls,
    checklists: (task.checklists ?? []).map((checklist) => ({
      title: checklist.title,
      items: (checklist.items ?? []).map((item) => item.content),
    })),
    customFields,
    attachments: (task.attachments ?? []).map((attachment) => attachment.originalName),
    comments: comments.map((comment) => comment.bodyPlainText),
  }).join("\n");
};

const buildSearchDocuments = (mirror) => {
  const documents = [];
  for (const project of mirror.projects ?? []) {
    documents.push({
      id: `project:${mirror.company.slug}/${project.slug}`,
      type: "project",
      title: String(project.name || project.slug),
      text: collectText(project).join("\n"),
      metadata: { projectId: project.id, projectSlug: project.slug },
    });
  }
  for (const task of mirror.tasks ?? []) {
    const taskPayload = task.payload?.task ?? task.payload;
    documents.push({
      id: `task:${mirror.company.slug}/${task.projectSlug}/${task.number}`,
      type: "task",
      title: String(taskPayload?.title || `Task ${task.number}`),
      text: buildTaskSearchText(taskPayload),
      metadata: {
        taskId: task.id,
        projectId: task.projectId,
        projectSlug: task.projectSlug,
        taskNumber: task.number,
      },
    });
  }
  for (const dossier of mirror.dossiers ?? []) {
    documents.push({
      id: `dossier:${dossier.id}`,
      type: "dossier",
      title: String(dossier.title || "Dossier"),
      text: collectText(dossier).join("\n"),
      metadata: { dossierId: dossier.id, project: dossier.project ?? null },
    });
  }
  for (const contextDocument of mirror.contextDocuments ?? []) {
    const resultType = contextDocument.type === "knowledge_page"
      ? "knowledge-page"
      : contextDocument.type;
    documents.push({
      id: `context:${contextDocument.type}:${contextDocument.id}`,
      type: resultType,
      title: String(contextDocument.title || resultType),
      text: collectText(contextDocument.payload).join("\n"),
      metadata: {
        contextDocumentId: contextDocument.id,
        sourceType: contextDocument.type,
        projectId: contextDocument.projectId ?? null,
        projectSlug: contextDocument.projectSlug ?? null,
        revisionToken: contextDocument.revisionToken,
      },
    });
  }
  for (const workspace of mirror.workspaces ?? []) {
    for (const file of workspace.documents ?? []) {
      documents.push({
        id: `workspace:${workspace.id}:${file.path}`,
        type: "workspace_file",
        title: file.name,
        text: `${file.path}\n${file.text}`,
        metadata: {
          workspaceId: workspace.id,
          workspaceHead: workspace.acceptedHead,
          scopeType: workspace.scopeType,
          scopeKey: workspace.scopeKey,
          taskId: workspace.taskId ?? null,
          dossierId: workspace.dossierId ?? null,
          path: file.path,
          sizeBytes: file.sizeBytes,
        },
      });
    }
  }
  return documents;
};

const getSearchIndex = (mirror) => {
  const cached = mirrorSearchIndexCache.get(mirror);
  if (cached) return cached;
  const index = buildSearchDocuments(mirror).map((document) => ({
    ...document,
    normalizedTitle: normalizeSearchText(document.title),
    normalizedBody: normalizeSearchText(document.text),
  }));
  mirrorSearchIndexCache.set(mirror, index);
  return index;
};

export const searchCompanyContextMirror = (mirror, rawQueries, rawLimit = 20) => {
  const queries = [...new Map((Array.isArray(rawQueries) ? rawQueries : [])
    .map((query) => normalizeBoundedString(query, "query", 500))
    .map((query) => [normalizeSearchText(query), query]))
    .entries()]
    .filter(([normalized]) => normalized)
    .slice(0, MAX_SEARCH_QUERIES);
  if (queries.length === 0) {
    throw new TrelioLocalContextError(
      "LOCAL_CONTEXT_INVALID_INPUT",
      "At least one local context search query is required.",
    );
  }
  const limit = Math.max(1, Math.min(MAX_SEARCH_RESULTS, Math.trunc(Number(rawLimit) || 20)));
  const results = [];

  for (const document of getSearchIndex(mirror)) {
    const { normalizedTitle, normalizedBody } = document;
    const matchedQueries = [];
    let previewQuery = queries[0][0];
    let score = 0;
    for (const [normalized, original] of queries) {
      const tokens = normalized.split(" ").filter((token) => token.length > 1);
      const titleTokenMatches = tokens.filter((token) => normalizedTitle.includes(token)).length;
      const bodyTokenMatches = tokens.filter((token) => normalizedBody.includes(token)).length;
      const tokenCoverage = tokens.length > 0
        ? Math.max(titleTokenMatches, bodyTokenMatches) / tokens.length
        : 0;
      if (normalizedTitle.includes(normalized)) {
        matchedQueries.push(original);
        score += 140;
      } else if (normalizedBody.includes(normalized)) {
        matchedQueries.push(original);
        score += 100;
      } else if (tokenCoverage >= (tokens.length <= 2 ? 1 : 0.6)) {
        matchedQueries.push(original);
        score += Math.round(40 + 60 * tokenCoverage + 10 * titleTokenMatches);
      } else {
        continue;
      }
      previewQuery = normalized;
    }
    if (matchedQueries.length === 0) continue;
    // Prefer first-class structured objects at equal lexical coverage. A file
    // remains first when it matches more independent formulations.
    const typeWeight = document.type === "registry"
      ? 40
      : document.type === "dossier"
        ? 35
        : document.type === "knowledge-page"
          ? 30
          : document.type === "contact"
            ? 25
            : document.type === "workspace_file"
              ? 20
              : document.type === "task"
                ? 15
                : document.type === "project"
                  ? 10
                  : 5;
    results.push({
      id: document.id,
      type: document.type,
      title: document.title,
      matchedQueries,
      score: score + matchedQueries.length * 1_000 + typeWeight,
      preview: buildPreview(document.text, previewQuery),
      ...document.metadata,
    });
  }

  results.sort((left, right) => right.score - left.score || left.id.localeCompare(right.id, "ru"));
  return {
    schemaVersion: 1,
    provider: "local_company_context",
    company: { id: mirror.company.id, slug: mirror.company.slug, name: mirror.company.name },
    generation: mirror.generation,
    queries: queries.map(([, original]) => original),
    results: results.slice(0, limit).map(({ score: _score, ...result }) => result),
    hasMore: results.length > limit,
    freshness: { mirroredAt: mirror.createdAt, serverGeneration: mirror.serverGeneration },
  };
};

const resolveMirrorProjectBySlug = (mirror, projectSlug) => {
  const matches = (mirror.projects ?? []).filter((project) => (
    project?.slug === projectSlug
    || (
      Array.isArray(project?.slugAliases)
      && project.slugAliases.includes(projectSlug)
    )
  ));

  // Current and historical project slugs are unique within one company. If
  // an authenticated mirror ever violates that server invariant, choosing an
  // arbitrary project could reveal the wrong task under a legacy URL. Treat
  // the generation as invalid instead of guessing.
  if (matches.length > 1) {
    throw new TrelioLocalContextError(
      "LOCAL_CONTEXT_MIRROR_INVALID",
      "The local company context contains an ambiguous project slug.",
    );
  }

  return matches[0] ?? null;
};

const buildMirrorProjectScopeMatcher = (mirror, projectSlug) => {
  if (!projectSlug) return () => true;
  const project = resolveMirrorProjectBySlug(mirror, projectSlug);

  // A pre-encryption or renamed project URL carries a historical slug while
  // mirror records intentionally retain the current opaque/canonical slug.
  // Once the project itself resolves that alias, compare immutable projectId
  // rather than rewriting result ids or duplicating every alias per record.
  if (project) {
    return ({ projectId }) => projectId === project.id;
  }

  // Preserve exact matching for older mirror generations that predate the
  // project-level slugAliases projection.
  return ({ projectSlug: recordProjectSlug }) => recordProjectSlug === projectSlug;
};

export const listCompanyContextMirror = (
  mirror,
  rawResource,
  rawOffset = 0,
  rawLimit = 50,
  rawProjectSlug = null,
) => {
  const resource = String(rawResource || "").trim();
  const offset = Math.max(0, Math.trunc(Number(rawOffset) || 0));
  const limit = Math.max(1, Math.min(100, Math.trunc(Number(rawLimit) || 50)));
  const projectSlug = rawProjectSlug
    ? normalizeBoundedString(rawProjectSlug, "projectSlug", 120)
    : null;
  const matchesProjectScope = buildMirrorProjectScopeMatcher(mirror, projectSlug);
  let items;

  if (resource === "projects") {
    items = (mirror.projects ?? []).map((project) => ({
      id: project.id,
      slug: project.slug,
      name: project.name,
      isArchived: project.isArchived,
    }));
  } else if (resource === "tasks") {
    items = (mirror.tasks ?? [])
      .filter(matchesProjectScope)
      .map((task) => {
        const payload = task.payload?.task ?? task.payload;
        return {
          id: `task:${mirror.company.slug}/${task.projectSlug}/${task.number}`,
          taskId: task.id,
          projectSlug: task.projectSlug,
          number: task.number,
          title: payload?.title ?? null,
          status: payload?.status ?? null,
          updatedAt: payload?.updatedAt ?? null,
        };
      });
  } else if (resource === "dossiers") {
    items = (mirror.dossiers ?? []).filter((dossier) => matchesProjectScope({
      projectId: dossier.project?.id ?? null,
      projectSlug: dossier.project?.slug ?? null,
    }));
  } else if (["knowledge_pages", "contacts", "registries", "meetings"].includes(resource)) {
    const expectedType = resource === "knowledge_pages"
      ? "knowledge_page"
      : resource === "contacts"
        ? "contact"
        : resource === "registries"
          ? "registry"
          : "meeting";
    items = (mirror.contextDocuments ?? [])
      .filter((document) => (
        document.type === expectedType
        && matchesProjectScope(document)
      ))
      .map((document) => ({
        id: `context:${document.type}:${document.id}`,
        sourceId: document.id,
        type: document.type,
        title: document.title,
        projectSlug: document.projectSlug ?? null,
        revisionToken: document.revisionToken,
      }));
  } else {
    throw new TrelioLocalContextError(
      "LOCAL_CONTEXT_INVALID_INPUT",
      "resource must be projects, tasks, dossiers, knowledge_pages, contacts, registries or meetings.",
    );
  }

  return {
    schemaVersion: 1,
    provider: "local_company_context",
    company: { id: mirror.company.id, slug: mirror.company.slug, name: mirror.company.name },
    generation: mirror.generation,
    resource,
    offset,
    limit,
    total: items.length,
    hasMore: offset + limit < items.length,
    items: items.slice(offset, offset + limit),
  };
};

const selectTaskInstructions = (mirror, task) => ({
  agentInstructionsSnapshot:
    mirror.instructions?.projects?.find((entry) => entry.projectId === task.projectId)?.snapshot
    ?? mirror.instructions?.company
    ?? null,
  userProfileSnapshot: mirror.instructions?.userProfile ?? null,
});

const getTaskFromMirror = (mirror, { projectSlug, taskNumber }) => {
  const matchesProjectScope = buildMirrorProjectScopeMatcher(mirror, projectSlug);
  const task = (mirror.tasks ?? []).find((candidate) => (
    matchesProjectScope(candidate) && candidate.number === taskNumber
  ));
  if (!task) {
    throw new TrelioLocalContextError(
      "LOCAL_CONTEXT_TASK_NOT_FOUND",
      "Task was not found in the current ACL-filtered local company snapshot.",
    );
  }
  return {
    schemaVersion: 1,
    provider: "local_company_context",
    generation: mirror.generation,
    ...task.payload,
    effectiveInstructions: selectTaskInstructions(mirror, task),
  };
};

export const fetchMirrorResult = (mirror, rawResultId) => {
  const resultId = normalizeBoundedString(rawResultId, "resultId", 4_096);
  if (resultId.startsWith("context:")) {
    const contextDocument = (mirror.contextDocuments ?? []).find((document) => (
      `context:${document.type}:${document.id}` === resultId
    ));
    if (!contextDocument) {
      throw new TrelioLocalContextError(
        "LOCAL_CONTEXT_RESULT_NOT_FOUND",
        "The selected company-context document is stale.",
      );
    }
    return {
      schemaVersion: 1,
      provider: "local_company_context",
      generation: mirror.generation,
      document: contextDocument,
      effectiveInstructions: {
        agentInstructionsSnapshot: contextDocument.projectId
          ? mirror.instructions?.projects?.find(
              (entry) => entry.projectId === contextDocument.projectId,
            )?.snapshot ?? null
          : mirror.instructions?.company ?? null,
        userProfileSnapshot: mirror.instructions?.userProfile ?? null,
      },
    };
  }
  if (resultId.startsWith("task:")) {
    const parts = resultId.slice("task:".length).split("/");
    const [companySlug, projectSlug, taskNumberText] = parts;
    if (parts.length !== 3 || companySlug !== mirror.company.slug) {
      throw new TrelioLocalContextError("LOCAL_CONTEXT_INVALID_INPUT", "Task result company changed.");
    }
    return getTaskFromMirror(mirror, {
      projectSlug,
      taskNumber: Number(taskNumberText),
    });
  }
  if (resultId.startsWith("dossier:")) {
    const dossierId = resultId.slice("dossier:".length);
    const dossier = (mirror.dossiers ?? []).find((candidate) => candidate.id === dossierId);
    if (!dossier) {
      throw new TrelioLocalContextError("LOCAL_CONTEXT_RESULT_NOT_FOUND", "Dossier result is stale.");
    }
    return {
      schemaVersion: 1,
      provider: "local_company_context",
      generation: mirror.generation,
      dossier,
      effectiveInstructions: {
        agentInstructionsSnapshot: dossier.project?.id
          ? mirror.instructions?.projects?.find((entry) => entry.projectId === dossier.project.id)?.snapshot
          : mirror.instructions?.company,
        userProfileSnapshot: mirror.instructions?.userProfile ?? null,
      },
    };
  }
  if (resultId.startsWith("workspace:")) {
    const separator = resultId.indexOf(":", "workspace:".length);
    const workspaceId = resultId.slice("workspace:".length, separator);
    const filePath = resultId.slice(separator + 1);
    const workspace = (mirror.workspaces ?? []).find((candidate) => candidate.id === workspaceId);
    const file = workspace?.documents?.find((candidate) => candidate.path === filePath);
    if (!workspace || !file) {
      throw new TrelioLocalContextError("LOCAL_CONTEXT_RESULT_NOT_FOUND", "Workspace result is stale.");
    }
    return {
      schemaVersion: 1,
      provider: "local_company_context",
      generation: mirror.generation,
      workspace: {
        id: workspace.id,
        scopeType: workspace.scopeType,
        scopeKey: workspace.scopeKey,
        acceptedHead: workspace.acceptedHead,
      },
      file,
      materialize: {
        nativeTool: "prepare_agent_workspace_read",
        scopeType: workspace.scopeType,
        scopeId: workspace.taskId ?? workspace.dossierId,
      },
    };
  }
  if (resultId.startsWith("project:")) {
    const projectSlug = resultId.split("/").at(-1);
    const project = (mirror.projects ?? []).find((candidate) => candidate.slug === projectSlug);
    if (!project) {
      throw new TrelioLocalContextError("LOCAL_CONTEXT_RESULT_NOT_FOUND", "Project result is stale.");
    }
    return { schemaVersion: 1, provider: "local_company_context", project };
  }
  throw new TrelioLocalContextError("LOCAL_CONTEXT_INVALID_INPUT", "Unknown local context result id.");
};

const normalizeProposalKind = (value) => {
  const kind = String(value || "").trim();
  if (!PROPOSAL_KINDS.has(kind)) {
    throw new TrelioLocalContextError(
      "LOCAL_CONTEXT_INVALID_INPUT",
      "kind must be comment, status, control_clear or checklist.",
    );
  }
  return kind;
};

const normalizeProposalTarget = (rawTarget) => {
  const runId = rawTarget?.runId ? normalizeUuid(rawTarget.runId, "target.runId") : null;
  const hasDirectPart = rawTarget?.projectSlug !== undefined
    || rawTarget?.taskNumber !== undefined;
  if (runId && hasDirectPart) {
    throw new TrelioLocalContextError(
      "LOCAL_CONTEXT_INVALID_INPUT",
      "Use target.runId or target.projectSlug/taskNumber, not both.",
    );
  }
  if (runId) return { runId };

  return {
    projectSlug: normalizeBoundedString(rawTarget?.projectSlug, "target.projectSlug", 120),
    taskNumber: normalizeInteger(rawTarget?.taskNumber, "target.taskNumber", 1),
  };
};

const normalizeBoundedStringArray = (value, fieldName, maximumItems, maximumLength) => {
  if (!Array.isArray(value) || value.length > maximumItems) {
    throw new TrelioLocalContextError(
      "LOCAL_CONTEXT_INVALID_INPUT",
      `${fieldName} must be an array with at most ${maximumItems} items.`,
    );
  }
  return value.map((item, index) => (
    normalizeBoundedString(item, `${fieldName}[${index}]`, maximumLength)
  ));
};

const postProposalRequest = async ({
  origin,
  token,
  companySlug,
  endpoint,
  body,
  signal,
}) => readJson(await request(
  origin,
  token,
  `/api/agent-workspaces/company-context/${encodeURIComponent(companySlug)}/proposals/${endpoint}`,
  {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal,
  },
));

const buildProposalLocalResult = (origin, hydrated) => {
  const taskUrl = typeof hydrated?.task?.url === "string"
    ? hydrated.task.url
    : typeof hydrated?.task?.publicPath === "string"
      ? new URL(hydrated.task.publicPath, `${origin}/`).href
      : null;
  return {
    schemaVersion: 1,
    provider: "local_company_context",
    proposal: hydrated,
    ...(taskUrl ? { reviewUrl: taskUrl } : {}),
  };
};

const saveLocalProposal = async ({
  origin,
  token,
  companyEncryption,
  companySlug,
  kind,
  rawPayload,
  signal,
}) => {
  const target = normalizeProposalTarget(rawPayload?.target);
  const expectedStateRevision = normalizeInteger(
    rawPayload?.expectedStateRevision,
    "payload.expectedStateRevision",
    0,
  );
  let body;

  if (kind === "comment") {
    const proposalText = normalizeBoundedString(
      rawPayload?.proposalText,
      "payload.proposalText",
      20_000,
    );
    const expectedPublicCommentsSnapshotHash = normalizeBoundedString(
      rawPayload?.expectedPublicCommentsSnapshotHash,
      "payload.expectedPublicCommentsSnapshotHash",
      64,
    );
    if (!SHA256_PATTERN.test(expectedPublicCommentsSnapshotHash)) {
      throw new TrelioLocalContextError(
        "LOCAL_CONTEXT_INVALID_INPUT",
        "payload.expectedPublicCommentsSnapshotHash must be an exact SHA-256.",
      );
    }
    const markers = await uploadProposalPayload({
      origin,
      token,
      companyEncryption,
      values: { proposal_text: proposalText },
      source: { kind: "agent_task_proposal", proposalKind: kind, action: "save" },
      signal,
    });
    const draftWriteMode = rawPayload?.draftWriteMode === undefined
      ? null
      : String(rawPayload.draftWriteMode);
    if (draftWriteMode && !["replace", "create_only"].includes(draftWriteMode)) {
      throw new TrelioLocalContextError(
        "LOCAL_CONTEXT_INVALID_INPUT",
        "payload.draftWriteMode must be replace or create_only.",
      );
    }
    body = {
      kind,
      target,
      proposalText: markers.proposal_text,
      expectedStateRevision,
      expectedPublicCommentsSnapshotHash,
      ...(rawPayload?.filePaths === undefined
        ? {}
        : {
            filePaths: normalizeBoundedStringArray(
              rawPayload.filePaths,
              "payload.filePaths",
              10,
              2_048,
            ),
          }),
      ...(draftWriteMode ? { draftWriteMode } : {}),
    };
  } else if (kind === "status") {
    const reason = normalizeBoundedString(rawPayload?.reason, "payload.reason", 4_000);
    const markers = await uploadProposalPayload({
      origin,
      token,
      companyEncryption,
      values: { reason },
      source: { kind: "agent_task_proposal", proposalKind: kind, action: "save" },
      signal,
    });
    const intent = rawPayload?.intent === undefined ? null : String(rawPayload.intent);
    if (intent && !["work_started", "whole_task_ready"].includes(intent)) {
      throw new TrelioLocalContextError(
        "LOCAL_CONTEXT_INVALID_INPUT",
        "payload.intent must be work_started or whole_task_ready.",
      );
    }
    body = {
      kind,
      target,
      expectedStateRevision,
      expectedStatusId: normalizeUuid(rawPayload?.expectedStatusId, "payload.expectedStatusId"),
      targetStatusCode: normalizeBoundedString(
        rawPayload?.targetStatusCode,
        "payload.targetStatusCode",
        120,
      ),
      reason: markers.reason,
      ...(intent ? { intent } : {}),
    };
  } else if (kind === "control_clear") {
    if (!Array.isArray(rawPayload?.controls) || rawPayload.controls.length < 1 || rawPayload.controls.length > 20) {
      throw new TrelioLocalContextError(
        "LOCAL_CONTEXT_INVALID_INPUT",
        "payload.controls must contain between 1 and 20 items.",
      );
    }
    const controls = rawPayload.controls.map((item, index) => ({
      controlId: normalizeUuid(item?.controlId, `payload.controls[${index}].controlId`),
      reason: normalizeBoundedString(item?.reason, `payload.controls[${index}].reason`, 4_000),
    }));
    const values = Object.fromEntries(controls.map((item, index) => [
      `reason_${index}`,
      item.reason,
    ]));
    const markers = await uploadProposalPayload({
      origin,
      token,
      companyEncryption,
      values,
      source: { kind: "agent_task_proposal", proposalKind: kind, action: "save" },
      signal,
    });
    body = {
      kind,
      target,
      expectedStateRevision,
      controls: controls.map((item, index) => ({
        controlId: item.controlId,
        reason: markers[`reason_${index}`],
      })),
    };
  } else {
    if (!Array.isArray(rawPayload?.changes) || rawPayload.changes.length < 1 || rawPayload.changes.length > 50) {
      throw new TrelioLocalContextError(
        "LOCAL_CONTEXT_INVALID_INPUT",
        "payload.changes must contain between 1 and 50 items.",
      );
    }
    const changes = rawPayload.changes.map((item, index) => ({
      itemId: normalizeUuid(item?.itemId, `payload.changes[${index}].itemId`),
      targetIsCompleted: item?.targetIsCompleted,
      reason: normalizeBoundedString(item?.reason, `payload.changes[${index}].reason`, 4_000),
    }));
    if (changes.some((item) => typeof item.targetIsCompleted !== "boolean")) {
      throw new TrelioLocalContextError(
        "LOCAL_CONTEXT_INVALID_INPUT",
        "Every payload.changes[].targetIsCompleted must be boolean.",
      );
    }
    const values = Object.fromEntries(changes.map((item, index) => [
      `reason_${index}`,
      item.reason,
    ]));
    const markers = await uploadProposalPayload({
      origin,
      token,
      companyEncryption,
      values,
      source: { kind: "agent_task_proposal", proposalKind: kind, action: "save" },
      signal,
    });
    body = {
      kind,
      target,
      expectedStateRevision,
      changes: changes.map((item, index) => ({
        itemId: item.itemId,
        targetIsCompleted: item.targetIsCompleted,
        reason: markers[`reason_${index}`],
      })),
    };
  }

  return postProposalRequest({
    origin,
    token,
    companySlug,
    endpoint: "save",
    body,
    signal,
  });
};

const applyLocalProposalAction = async ({
  origin,
  token,
  companyEncryption,
  companySlug,
  kind,
  rawPayload,
  signal,
}) => {
  if (rawPayload?.confirmed !== true) {
    throw new TrelioLocalContextError(
      "LOCAL_CONTEXT_CONFIRMATION_REQUIRED",
      "Proposal publication, application or dismissal requires a separate explicit user decision and confirmed=true.",
    );
  }
  const action = normalizeBoundedString(rawPayload?.action, "payload.action", 16);
  const proposalId = normalizeUuid(rawPayload?.proposalId, "payload.proposalId");
  const expectedRevision = normalizeInteger(
    rawPayload?.expectedRevision,
    "payload.expectedRevision",
    1,
  );
  const common = { kind, action, confirmed: true, proposalId, expectedRevision };
  let body;

  if (kind === "comment") {
    if (!["publish", "dismiss"].includes(action)) {
      throw new TrelioLocalContextError(
        "LOCAL_CONTEXT_INVALID_INPUT",
        "A comment proposal action must be publish or dismiss.",
      );
    }
    if (action === "publish") {
      const bodyText = normalizeBoundedString(rawPayload?.bodyText, "payload.bodyText", 20_000);
      const markers = await uploadProposalPayload({
        origin,
        token,
        companyEncryption,
        values: { body_text: bodyText },
        source: { kind: "agent_task_proposal", proposalKind: kind, action },
        signal,
      });
      body = {
        ...common,
        bodyText: markers.body_text,
        ...(rawPayload?.attachmentIds === undefined
          ? {}
          : {
              attachmentIds: normalizeBoundedStringArray(
                rawPayload.attachmentIds,
                "payload.attachmentIds",
                10,
                36,
              ).map((value, index) => normalizeUuid(
                value,
                `payload.attachmentIds[${index}]`,
              )),
            }),
      };
    } else {
      body = common;
    }
  } else if (kind === "status") {
    if (!["apply", "dismiss"].includes(action)) {
      throw new TrelioLocalContextError(
        "LOCAL_CONTEXT_INVALID_INPUT",
        "A status proposal action must be apply or dismiss.",
      );
    }
    body = {
      ...common,
      ...(action === "apply"
        ? {
            targetStatusCode: normalizeBoundedString(
              rawPayload?.targetStatusCode,
              "payload.targetStatusCode",
              120,
            ),
          }
        : {}),
    };
  } else if (kind === "control_clear") {
    if (!["apply", "dismiss"].includes(action)) {
      throw new TrelioLocalContextError(
        "LOCAL_CONTEXT_INVALID_INPUT",
        "A control proposal action must be apply or dismiss.",
      );
    }
    body = {
      ...common,
      ...(action === "apply"
        ? {
            controlIds: normalizeBoundedStringArray(
              rawPayload?.controlIds,
              "payload.controlIds",
              20,
              36,
            ).map((value, index) => normalizeUuid(value, `payload.controlIds[${index}]`)),
          }
        : {}),
    };
  } else {
    if (!["apply", "dismiss"].includes(action)) {
      throw new TrelioLocalContextError(
        "LOCAL_CONTEXT_INVALID_INPUT",
        "A checklist proposal action must be apply or dismiss.",
      );
    }
    body = {
      ...common,
      ...(action === "apply"
        ? {
            itemIds: normalizeBoundedStringArray(
              rawPayload?.itemIds,
              "payload.itemIds",
              50,
              36,
            ).map((value, index) => normalizeUuid(value, `payload.itemIds[${index}]`)),
          }
        : {}),
    };
  }

  return postProposalRequest({
    origin,
    token,
    companySlug,
    endpoint: "action",
    body,
    signal,
  });
};

const getReadyMirror = async ({ origin, companySlug, signal }) => {
  const provider = await resolveLocalCompanyProvider({
    origin,
    companySlug,
    signal,
    allowCached: true,
  });
  if (provider.nativeProvider) return provider;
  const { token, companyEncryption } = provider;
  const sessionKey = `${origin}\n${companySlug}`;

  const cachedEntry = localCompanyMirrorSessionCache.get(sessionKey);
  if (cachedEntry && cachedEntry.expiresAt > Date.now()) {
    return { mirror: cachedEntry.mirror, token, companyEncryption };
  }
  if (cachedEntry) localCompanyMirrorSessionCache.delete(sessionKey);

  const paths = resolveMirrorPaths({
    origin,
    companyId: companyEncryption.runtime.company.id,
  });
  if (localCompanyMirrorStartupSynced.has(sessionKey)) {
    const current = await readMirrorGeneration({ paths, companyEncryption });
    if (current) {
      return {
        mirror: cacheDecryptedMirror(sessionKey, current),
        token,
        companyEncryption,
      };
    }
  }
  const synced = await syncCompanyContextMirror({
    origin,
    token,
    companyEncryption,
    signal,
  });
  // This process has now completed (or joined) its one startup refresh. Later
  // reads reuse the same decrypted immutable object and its lazy in-memory
  // search index: no network call, disk read, decryption or JSON parse repeats.
  // The plaintext object/index is evicted after ten minutes; only the small
  // startup-freshness marker survives so the next read can reopen encrypted
  // local bytes without an unnecessary remote sync. A new MCP host starts with
  // both caches empty and refreshes again.
  localCompanyMirrorStartupSynced.add(sessionKey);
  cacheDecryptedMirror(sessionKey, synced.mirror);
  return { ...synced, token, companyEncryption };
};

export const handleTrelioLocalContextOperation = async (
  origin,
  rawInput,
  { signal } = {},
) => {
  const operation = String(rawInput?.operation || "").trim();
  const companySlug = normalizeCompanySlug(rawInput?.companySlug);
  const ready = await getReadyMirror({
    origin,
    companySlug,
    signal,
  });
  if (ready.nativeProvider) return ready.result;

  if (operation === "search") {
    return searchCompanyContextMirror(ready.mirror, rawInput?.queries, rawInput?.limit);
  }
  if (operation === "list") {
    return listCompanyContextMirror(
      ready.mirror,
      rawInput?.resource,
      rawInput?.offset,
      rawInput?.limit,
      rawInput?.projectSlug,
    );
  }
  if (operation === "get_task") {
    const projectSlug = normalizeBoundedString(rawInput?.projectSlug, "projectSlug", 120);
    const taskNumber = Number(rawInput?.taskNumber);
    if (!Number.isSafeInteger(taskNumber) || taskNumber <= 0) {
      throw new TrelioLocalContextError("LOCAL_CONTEXT_INVALID_INPUT", "taskNumber must be positive.");
    }
    return getTaskFromMirror(ready.mirror, { projectSlug, taskNumber });
  }
  if (operation === "fetch") {
    return fetchMirrorResult(ready.mirror, rawInput?.resultId);
  }
  throw new TrelioLocalContextError(
    "LOCAL_CONTEXT_INVALID_INPUT",
    "operation must be search, list, get_task or fetch.",
  );
};

export const handleTrelioLocalProposalOperation = async (
  origin,
  rawInput,
  { signal } = {},
) => {
  const companySlug = normalizeCompanySlug(rawInput?.companySlug);
  const operation = String(rawInput?.operation || "").trim();
  const kind = normalizeProposalKind(rawInput?.kind);
  const rawPayload = rawInput?.payload;
  if (!rawPayload || typeof rawPayload !== "object" || Array.isArray(rawPayload)) {
    throw new TrelioLocalContextError(
      "LOCAL_CONTEXT_INVALID_INPUT",
      "payload must be an object.",
    );
  }
  const provider = await resolveLocalCompanyProvider({ origin, companySlug, signal });
  if (provider.nativeProvider) return provider.result;

  let rawResult;
  if (operation === "context") {
    rawResult = await postProposalRequest({
      origin,
      token: provider.token,
      companySlug,
      endpoint: "context",
      body: {
        kind,
        target: normalizeProposalTarget(rawPayload.target),
      },
      signal,
    });
  } else if (operation === "save") {
    rawResult = await saveLocalProposal({
      origin,
      token: provider.token,
      companyEncryption: provider.companyEncryption,
      companySlug,
      kind,
      rawPayload,
      signal,
    });
  } else if (operation === "action") {
    rawResult = await applyLocalProposalAction({
      origin,
      token: provider.token,
      companyEncryption: provider.companyEncryption,
      companySlug,
      kind,
      rawPayload,
      signal,
    });
  } else {
    throw new TrelioLocalContextError(
      "LOCAL_CONTEXT_INVALID_INPUT",
      "operation must be context, save or action.",
    );
  }

  const hydrated = await hydrateAgentCompanyEncryptedJson({
    value: rawResult,
    origin,
    token: provider.token,
    companyEncryption: provider.companyEncryption,
    signal,
  });
  return buildProposalLocalResult(origin, hydrated);
};

export const TRELIO_LOCAL_CONTEXT_TOOL = {
  name: "continue_trelio_local_context",
  title: "Continue a Trelio local context route",
  description: "Continue only the exact local-context route selected by Trelio. The trusted host chooses the data provider automatically; do not use this tool when a native Trelio content tool succeeded.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["operation", "companySlug"],
    properties: {
      operation: { type: "string", enum: ["search", "list", "get_task", "fetch"] },
      companySlug: { type: "string", minLength: 1, maxLength: 120 },
      projectSlug: { type: "string", minLength: 1, maxLength: 120 },
      taskNumber: { type: "integer", minimum: 1 },
      queries: {
        type: "array",
        minItems: 1,
        maxItems: MAX_SEARCH_QUERIES,
        items: { type: "string", minLength: 1, maxLength: 500 },
      },
      limit: { type: "integer", minimum: 1, maximum: MAX_SEARCH_RESULTS },
      resultId: { type: "string", minLength: 1, maxLength: 4096 },
      resource: {
        type: "string",
        enum: [
          "projects",
          "tasks",
          "dossiers",
          "knowledge_pages",
          "contacts",
          "registries",
          "meetings",
        ],
      },
      offset: { type: "integer", minimum: 0 },
    },
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: false,
  },
};

export const TRELIO_LOCAL_PROPOSAL_TOOL = {
  name: "continue_trelio_local_proposal",
  title: "Continue a Trelio local proposal route",
  description: "Continue only an exact proposal route selected by Trelio. The trusted host protects content and rechecks the provider; final actions require a separate explicit user decision.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["operation", "companySlug", "kind", "payload"],
    properties: {
      operation: { type: "string", enum: ["context", "save", "action"] },
      companySlug: { type: "string", minLength: 1, maxLength: 120 },
      kind: {
        type: "string",
        enum: ["comment", "status", "control_clear", "checklist"],
      },
      payload: {
        type: "object",
        description: "Exact fields from the selected proposal route and its immediately preceding context response.",
      },
    },
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    openWorldHint: false,
  },
};
