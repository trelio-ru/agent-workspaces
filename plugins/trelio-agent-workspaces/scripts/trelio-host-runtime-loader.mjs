#!/usr/bin/env node

/**
 * Stable Trelio plugin shell.
 *
 * Loader never mutates Codex plugin cache. It selects an already verified
 * content-addressed runtime outside that cache and checks for a newer signed
 * package in a detached helper. A fresh installation and every long-lived MCP
 * startup perform a foreground convergence because a stale MCP process cannot
 * replace its own executable after the server raises the runtime minimum.
 * Therefore runtime updates neither rewrite plugin files nor invalidate
 * absolute paths held by open Codex tasks.
 */
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  PLUGIN_VERSION,
  parseAndValidateHostRuntimePackage,
  readBoundedResponseBuffer,
  resolveWorkspaceBridgeConfigDirectory,
} from "./trelio-host-runtime-shell.mjs";

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HOST_RUNTIME_SKILL_ID = "trelio-host-runtime";
const DEFAULT_ORIGIN = "https://trelio.ru";
const UPDATE_INTERVAL_MS = 15 * 60 * 1000;
const UPDATE_FAILURE_RETRY_MS = 5 * 60 * 1000;
const LOCK_STALE_MS = 5 * 60 * 1000;
const UPDATE_LOCK_WAIT_MS = 90 * 1000;
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_PACKAGE_BYTES = 64 * 1024 * 1024;
const RETRY_DELAYS_MS = Object.freeze([250, 1_000, 3_000]);
const MCP_STARTUP_REQUEST_TIMEOUT_MS = 4_000;
const MCP_STARTUP_RETRY_DELAYS_MS = Object.freeze([200, 600, 1_200]);

const CONFIG_DIRECTORY = resolveWorkspaceBridgeConfigDirectory();
const RUNTIME_ROOT = path.join(CONFIG_DIRECTORY, "host-runtimes");
const CURRENT_POINTER_PATH = path.join(RUNTIME_ROOT, "current.json");
const UPDATE_STATE_PATH = path.join(RUNTIME_ROOT, "update-state.json");
const UPDATE_LOCK_PATH = path.join(RUNTIME_ROOT, "update.lock");

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const stableVersionPattern = /^\d{1,9}\.\d{1,9}\.\d{1,9}$/u;
const sha256Pattern = /^[0-9a-f]{64}$/u;

const compareStableVersions = (left, right) => {
  const leftParts = String(left).split(".").map(Number);
  const rightParts = String(right).split(".").map(Number);

  for (let index = 0; index < 3; index += 1) {
    if (leftParts[index] !== rightParts[index]) {
      return leftParts[index] > rightParts[index] ? 1 : -1;
    }
  }
  return 0;
};

const ensurePrivateDirectory = async (directoryPath) => {
  await fs.mkdir(directoryPath, { recursive: true, mode: 0o700 });
  const metadata = await fs.lstat(directoryPath);

  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error("Trelio host runtime cache имеет небезопасный тип.");
  }
  if (process.platform !== "win32") {
    await fs.chmod(directoryPath, 0o700);
  }
};

const readPrivateJson = async (filePath) => {
  try {
    const metadata = await fs.lstat(filePath);
    if (!metadata.isFile() || metadata.isSymbolicLink()) return null;
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT" || error instanceof SyntaxError) return null;
    throw error;
  }
};

const writePrivateJson = async (filePath, value) => {
  await ensurePrivateDirectory(path.dirname(filePath));
  const temporaryPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(temporaryPath, `${JSON.stringify(value)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
  await fs.rename(temporaryPath, filePath);
};

const scheduleNextUpdate = async (delayMilliseconds) => {
  // update-state is a private throttle, not a diagnostic journal. Keeping only
  // the timestamp consumed by startDetachedUpdate avoids stale duplicate state.
  await writePrivateJson(UPDATE_STATE_PATH, {
    nextAttemptAt: new Date(Date.now() + delayMilliseconds).toISOString(),
  });
};

const normalizeOrigin = (rawOrigin) => {
  const url = new URL(rawOrigin || DEFAULT_ORIGIN);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "localhost", "::1"].includes(url.hostname))) {
    throw new Error("Trelio host runtime origin должен использовать HTTPS.");
  }
  url.pathname = "/";
  url.search = "";
  url.hash = "";
  return url.origin;
};

const fetchWithRetries = async (
  url,
  options = {},
  {
    requestTimeoutMs = REQUEST_TIMEOUT_MS,
    retryDelaysMs = RETRY_DELAYS_MS,
  } = {},
) => {
  let lastError;

  for (let attempt = 0; attempt <= retryDelaysMs.length; attempt += 1) {
    try {
      const response = await fetch(url, {
        ...options,
        signal: AbortSignal.timeout(requestTimeoutMs),
      });
      if (response.status >= 500 && attempt < retryDelaysMs.length) {
        await sleep(retryDelaysMs[attempt]);
        continue;
      }
      return response;
    } catch (error) {
      lastError = error;
      if (attempt >= retryDelaysMs.length) break;
      await sleep(retryDelaysMs[attempt]);
    }
  }

  throw lastError;
};

export const normalizeHostRuntimeDescriptor = (payload, origin) => {
  const runtime = payload?.runtime;
  const packageUrl = new URL(String(runtime?.packageUrl || ""), origin);

  if (
    payload?.schemaVersion !== 1
    || !runtime
    || !stableVersionPattern.test(String(runtime.runtimeVersion || ""))
    || !stableVersionPattern.test(String(runtime.minimumRuntimeVersion || ""))
    || !stableVersionPattern.test(String(runtime.minimumPluginVersion || ""))
    || compareStableVersions(runtime.runtimeVersion, runtime.minimumRuntimeVersion) < 0
    || !sha256Pattern.test(String(runtime.packageSha256 || ""))
    || !Number.isSafeInteger(runtime.packageSizeBytes)
    || runtime.packageSizeBytes <= 0
    || runtime.packageSizeBytes > MAX_PACKAGE_BYTES
    || typeof runtime.packageSignature !== "string"
    || typeof runtime.signingPublicKeySpki !== "string"
    || packageUrl.origin !== origin
    || packageUrl.protocol !== new URL(origin).protocol
  ) {
    throw new Error("Trelio вернул некорректное описание host runtime.");
  }

  return {
    ...runtime,
    packageUrl: packageUrl.href,
  };
};

export const verifyHostRuntimeSignature = (packageBytes, descriptor) => {
  const publicKey = crypto.createPublicKey({
    key: Buffer.from(descriptor.signingPublicKeySpki, "base64"),
    format: "der",
    type: "spki",
  });
  const signature = Buffer.from(descriptor.packageSignature, "base64");

  if (
    publicKey.asymmetricKeyType !== "ed25519"
    || signature.byteLength !== 64
    || !crypto.verify(null, packageBytes, publicKey, signature)
  ) {
    throw new Error("Trelio host runtime не прошёл Ed25519 signature verification.");
  }
};

const runtimeDirectoryFor = (descriptor) => path.join(
  RUNTIME_ROOT,
  descriptor.runtimeVersion,
  descriptor.packageSha256,
);

const readVerifiedRuntime = async (pointer = null) => {
  const selected = pointer ?? await readPrivateJson(CURRENT_POINTER_PATH);

  if (
    !selected
    || !stableVersionPattern.test(String(selected.runtimeVersion || ""))
    || !sha256Pattern.test(String(selected.packageSha256 || ""))
  ) {
    return null;
  }

  const runtimeDirectory = runtimeDirectoryFor(selected);
  const marker = await readPrivateJson(path.join(runtimeDirectory, ".trelio-verified.json"));
  const entrypointRelativePath = "scripts/trelio-host-runtime-entry.mjs";
  const entrypointPath = path.join(runtimeDirectory, ...entrypointRelativePath.split("/"));

  if (
    marker?.runtimeVersion !== selected.runtimeVersion
    || marker?.packageSha256 !== selected.packageSha256
    || !Array.isArray(marker?.files)
  ) {
    return null;
  }

  const verifiedPaths = new Set();
  for (const file of marker.files) {
    if (
      typeof file?.path !== "string"
      || file.path.includes("\\")
      || file.path.split("/").some((segment) => !segment || segment === "." || segment === "..")
      || verifiedPaths.has(file.path)
      || !sha256Pattern.test(String(file?.sha256 || ""))
      || !Number.isSafeInteger(file?.sizeBytes)
    ) {
      return null;
    }
    const absolutePath = path.join(runtimeDirectory, ...file.path.split("/"));
    try {
      const metadata = await fs.lstat(absolutePath);
      if (
        !metadata.isFile()
        || metadata.isSymbolicLink()
        || metadata.size !== file.sizeBytes
      ) {
        return null;
      }
      const bytes = await fs.readFile(absolutePath);
      if (crypto.createHash("sha256").update(bytes).digest("hex") !== file.sha256) {
        return null;
      }
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      throw error;
    }
    verifiedPaths.add(file.path);
  }
  if (!verifiedPaths.has(entrypointRelativePath)) return null;

  return {
    runtimeVersion: selected.runtimeVersion,
    packageSha256: selected.packageSha256,
    runtimeDirectory,
    entrypointPath,
  };
};

const removeInvalidRuntimeTarget = async (targetDirectory) => {
  const metadata = await fs.lstat(targetDirectory).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (!metadata) return;
  if (metadata.isSymbolicLink()) {
    throw new Error("Повреждённый Trelio host runtime cache имеет небезопасный тип.");
  }

  // materializeRuntime is called only while the updater lock is held. The
  // descriptor also fixes this exact version/hash path, so recovery removes no
  // sibling runtime and cannot widen into a cache sweep.
  if (metadata.isDirectory()) {
    await fs.rm(targetDirectory, { recursive: true, force: false });
  } else {
    await fs.unlink(targetDirectory);
  }
};

const materializeRuntime = async (descriptor, packageBytes) => {
  const parsed = parseAndValidateHostRuntimePackage(packageBytes, HOST_RUNTIME_SKILL_ID);

  if (
    parsed.runtimeVersion !== descriptor.runtimeVersion
    || parsed.packageSha256 !== descriptor.packageSha256
    || parsed.packageSizeBytes !== descriptor.packageSizeBytes
    || parsed.entrypoint.path !== "scripts/trelio-host-runtime-entry.mjs"
    || parsed.entrypoint.interpreter !== "node"
  ) {
    throw new Error("Подписанный host runtime не совпадает с опубликованным manifest.");
  }

  const targetDirectory = runtimeDirectoryFor(descriptor);
  const existing = await readVerifiedRuntime(descriptor);
  if (existing) return existing;

  await ensurePrivateDirectory(path.dirname(targetDirectory));
  await removeInvalidRuntimeTarget(targetDirectory);
  const temporaryDirectory = await fs.mkdtemp(path.join(
    path.dirname(targetDirectory),
    ".materializing-",
  ));
  if (process.platform !== "win32") await fs.chmod(temporaryDirectory, 0o700);

  try {
    for (const file of parsed.files) {
      const absolutePath = path.join(temporaryDirectory, ...file.path.split("/"));
      await ensurePrivateDirectory(path.dirname(absolutePath));
      await fs.writeFile(absolutePath, file.bytes, {
        flag: "wx",
        mode: file.mode,
      });
    }
    await writePrivateJson(path.join(temporaryDirectory, ".trelio-verified.json"), {
      runtimeVersion: descriptor.runtimeVersion,
      packageSha256: descriptor.packageSha256,
      verifiedAt: new Date().toISOString(),
      files: parsed.files.map((file) => ({
        path: file.path,
        sha256: file.sha256,
        sizeBytes: file.bytes.byteLength,
      })),
    });

    await fs.rename(temporaryDirectory, targetDirectory);
  } finally {
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
    for (const file of parsed.files) file.bytes.fill(0);
  }

  await writePrivateJson(CURRENT_POINTER_PATH, {
    runtimeVersion: descriptor.runtimeVersion,
    packageSha256: descriptor.packageSha256,
  });
  const verified = await readVerifiedRuntime(descriptor);
  if (!verified) throw new Error("Trelio host runtime не прошёл проверку после materialization.");
  return verified;
};

const acquireUpdateLock = async ({ waitForExisting = false } = {}) => {
  await ensurePrivateDirectory(RUNTIME_ROOT);
  const deadline = Date.now() + UPDATE_LOCK_WAIT_MS;

  while (true) {
    try {
      await fs.mkdir(UPDATE_LOCK_PATH, { mode: 0o700 });
      return true;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }

    const metadata = await fs.lstat(UPDATE_LOCK_PATH).catch(() => null);
    if (metadata && Date.now() - metadata.mtimeMs > LOCK_STALE_MS) {
      await fs.rm(UPDATE_LOCK_PATH, { recursive: true, force: true });
      continue;
    }
    if (!waitForExisting) return false;
    if (Date.now() >= deadline) {
      throw new Error("Trelio host runtime update lock не освободился вовремя.");
    }
    // A hard compatibility gate can race with the detached updater started at
    // process launch. Waiting here avoids re-executing the same stale runtime.
    await sleep(250);
  }
};

const updateRuntime = async ({
  environment = process.env,
  waitForExisting = false,
  requestPolicy,
} = {}) => {
  if (!await acquireUpdateLock({ waitForExisting })) return false;

  try {
    const origin = normalizeOrigin(environment.TRELIO_ORIGIN || DEFAULT_ORIGIN);
    const metadataUrl = new URL("/api/agent-workspaces/host-runtime/current", origin);
    metadataUrl.searchParams.set("pluginVersion", PLUGIN_VERSION);
    const metadataResponse = await fetchWithRetries(metadataUrl, {}, requestPolicy);

    // A source-only/backend rollout may precede the first runtime artifact.
    // Existing verified runtimes keep working, but a fresh shell must fail
    // closed because it intentionally contains no executable fallback.
    if (metadataResponse.status === 404) {
      await scheduleNextUpdate(UPDATE_INTERVAL_MS);
      return false;
    }
    if (!metadataResponse.ok) {
      throw new Error(`Host runtime metadata HTTP ${metadataResponse.status}.`);
    }

    const descriptor = normalizeHostRuntimeDescriptor(await metadataResponse.json(), origin);
    if (compareStableVersions(PLUGIN_VERSION, descriptor.minimumPluginVersion) < 0) {
      throw new Error(`Host runtime требует plugin v${descriptor.minimumPluginVersion} или новее.`);
    }

    const current = await readVerifiedRuntime();
    if (
      current
      && current.runtimeVersion === descriptor.runtimeVersion
      && current.packageSha256 === descriptor.packageSha256
    ) {
      await scheduleNextUpdate(UPDATE_INTERVAL_MS);
      return false;
    }

    const packageResponse = await fetchWithRetries(descriptor.packageUrl, {}, requestPolicy);
    if (!packageResponse.ok) throw new Error(`Host runtime package HTTP ${packageResponse.status}.`);
    // Content-Length is optional and cannot be trusted as the only allocation
    // boundary. Stream-count against the signed descriptor before buffering.
    const packageBytes = await readBoundedResponseBuffer(
      packageResponse,
      descriptor.packageSizeBytes,
      "Trelio host runtime package",
    );

    try {
      verifyHostRuntimeSignature(packageBytes, descriptor);
      // Package parsing computes the whole-package SHA-256 once and compares
      // both size and digest with this descriptor before any file is written.
      await materializeRuntime(descriptor, packageBytes);
    } finally {
      packageBytes.fill(0);
    }

    await scheduleNextUpdate(UPDATE_INTERVAL_MS);
    return true;
  } catch (error) {
    await scheduleNextUpdate(UPDATE_FAILURE_RETRY_MS).catch(() => undefined);
    throw error;
  } finally {
    await fs.rm(UPDATE_LOCK_PATH, { recursive: true, force: true });
  }
};

const startDetachedUpdate = async ({
  environment = process.env,
  spawnProcess = spawn,
} = {}) => {
  if (environment.TRELIO_HOST_RUNTIME_DISABLE_AUTO_UPDATE === "1") return false;
  const state = await readPrivateJson(UPDATE_STATE_PATH);
  const nextAttemptAt = Date.parse(String(state?.nextAttemptAt || ""));
  if (Number.isFinite(nextAttemptAt) && nextAttemptAt > Date.now()) return false;

  const child = spawnProcess(process.execPath, [fileURLToPath(import.meta.url), "__update"], {
    detached: true,
    env: environment,
    shell: false,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
  return true;
};

export const selectHostRuntime = async () => readVerifiedRuntime();

export const runHostRuntimeLoader = async ({
  rawArguments = process.argv.slice(2),
  environment = process.env,
  spawnProcess = spawn,
} = {}) => {
  const [mode, ...forwardedArguments] = rawArguments;

  if (mode === "__update") {
    await updateRuntime({
      environment,
      waitForExisting: environment.TRELIO_HOST_RUNTIME_UPDATE_WAIT_FOR_LOCK === "1",
    });
    return 0;
  }
  if (!new Set(["bridge", "hook", "mcp"]).has(mode)) {
    throw new Error("Trelio host runtime loader ожидает mode bridge, hook или mcp.");
  }

  let selected = await selectHostRuntime();
  if (
    mode === "mcp"
    && selected
    && environment.TRELIO_HOST_RUNTIME_DISABLE_AUTO_UPDATE !== "1"
  ) {
    try {
      // The local MCP is long-lived. If it starts on a cached runtime and the
      // server has already raised the minimum, a detached update can switch
      // current.json but cannot replace the executable that owns this stdio
      // transport. Converge before opening the transport and then re-read the
      // verified pointer. A bounded network failure preserves the existing
      // immutable runtime; its next server call remains fail-closed.
      await updateRuntime({
        environment,
        waitForExisting: true,
        requestPolicy: {
          requestTimeoutMs: MCP_STARTUP_REQUEST_TIMEOUT_MS,
          retryDelaysMs: MCP_STARTUP_RETRY_DELAYS_MS,
        },
      });
      selected = await selectHostRuntime();
    } catch {
      // The detached retry schedule was written by updateRuntime. Starting the
      // last verified runtime keeps offline-compatible work available without
      // pretending that a server-side compatibility gate was satisfied.
    }
  }
  if (!selected) {
    // The foreground bootstrap happens only once per installation. It waits
    // for a racing updater, verifies the signed package and then executes from
    // the immutable cache. Network failure never falls back to plugin code.
    await updateRuntime({ environment, waitForExisting: true });
    selected = await selectHostRuntime();
  }
  if (!selected) {
    throw new Error(
      "HOST_RUNTIME_UNAVAILABLE: подписанный Trelio host runtime ещё не опубликован или недоступен.",
    );
  }
  // Update is deliberately outside the foreground path. This process never
  // deletes the selected content-addressed directory, so an already running
  // hook, bridge or MCP host keeps a stable executable tree.
  await startDetachedUpdate({ environment, spawnProcess }).catch(() => undefined);

  return await new Promise((resolve, reject) => {
    const child = spawnProcess(
      process.execPath,
      [selected.entrypointPath, mode, ...forwardedArguments],
      {
        cwd: selected.runtimeDirectory,
        env: {
          ...environment,
          TRELIO_HOST_RUNTIME_VERSION: selected.runtimeVersion,
          TRELIO_PLUGIN_VERSION: PLUGIN_VERSION,
          TRELIO_PLUGIN_ROOT: PLUGIN_ROOT,
        },
        shell: false,
        stdio: "inherit",
        windowsHide: true,
      },
    );
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) {
        process.kill(process.pid, signal);
        return;
      }
      resolve(code ?? 1);
    });
  });
};

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const isHookInvocation = process.argv[2] === "hook";
  runHostRuntimeLoader()
    .then((exitCode) => {
      // Codex blocks a PreToolUse call only for exit 2. If package selection or
      // the child hook fails with another code, forwarding it would let the MCP
      // request proceed without the runtime proof and hide the local failure.
      process.exitCode = isHookInvocation && exitCode !== 0 ? 2 : exitCode;
    })
    .catch((error) => {
      process.stderr.write(`Trelio host runtime loader failed: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = isHookInvocation ? 2 : 1;
    });
}
