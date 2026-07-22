#!/usr/bin/env node

/**
 * Локальный bridge для Trelio Agent Workspaces.
 *
 * Bridge намеренно не является MCP-сервером и не передаёт OAuth token агенту.
 * Он материализует закреплённые Git-ревизии, хранит credential в системном
 * хранилище и отправляет на сервер только candidate bundle текущего Run.
 */
import { execFile, spawn } from "node:child_process";
import crypto from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const BRIDGE_VERSION = "1.3.1";
const DEFAULT_ORIGIN = "https://trelio.ru";
const OAUTH_SCOPES = "mcp:read mcp:workspaces:read mcp:workspaces:write mcp:secrets:read mcp:secrets:write mcp:secrets:checkout";
const KEYCHAIN_SERVICE = "ru.trelio.workspace-bridge";
const CONFIG_DIRECTORY = path.join(os.homedir(), ".config", "trelio", "workspace-bridge");
const CREDENTIAL_FILE = path.join(CONFIG_DIRECTORY, "credentials.json");
const DEFAULT_WORKSPACES_DIRECTORY = path.join(os.homedir(), "Trelio Workspaces");
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const GIT_OBJECT_PATTERN = /^[0-9a-f]{40,64}$/;

const fail = (message, exitCode = 1) => {
  process.stderr.write(`Ошибка: ${message}\n`);
  process.exitCode = exitCode;
};

const parseArguments = (rawArguments) => {
  const [command = "help", ...tokens] = rawArguments;
  const options = {};
  const positional = [];

  // Повторяемые параметры нужны для содержательного handoff без передачи
  // тяжёлого JSON через shell: агент может несколько раз указать --evidence,
  // --file и --question. Для старых одиночных параметров контракт сохраняется.
  const appendOption = (key, value) => {
    const currentValue = options[key];

    if (currentValue === undefined) {
      options[key] = value;
    } else if (Array.isArray(currentValue)) {
      currentValue.push(value);
    } else {
      options[key] = [currentValue, value];
    }
  };

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];

    // POSIX `--` завершает разбор bridge options. Всё после него является
    // argv локальной программы и передаётся spawn напрямую, без shell.
    if (token === "--") {
      positional.push(...tokens.slice(index + 1));
      break;
    }

    if (!token.startsWith("--")) {
      positional.push(token);
      continue;
    }

    const equalsIndex = token.indexOf("=");
    const key = token.slice(2, equalsIndex >= 0 ? equalsIndex : undefined);

    if (equalsIndex >= 0) {
      appendOption(key, token.slice(equalsIndex + 1));
      continue;
    }

    const nextToken = tokens[index + 1];

    if (nextToken && !nextToken.startsWith("--")) {
      appendOption(key, nextToken);
      index += 1;
    } else {
      appendOption(key, true);
    }
  }

  return { command, options, positional };
};

const normalizeOrigin = (value) => {
  const parsed = new URL(String(value || DEFAULT_ORIGIN));

  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error("origin должен быть обычным HTTP(S) адресом Trelio.");
  }

  parsed.pathname = "";
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString().replace(/\/$/, "");
};

const requireUuid = (value, name) => {
  if (!UUID_PATTERN.test(String(value || ""))) {
    throw new Error(`Параметр --${name} должен содержать UUID.`);
  }

  return String(value).toLowerCase();
};

const run = async (executable, args, options = {}) => {
  try {
    return await execFileAsync(executable, args, {
      ...options,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
        GIT_PAGER: "cat",
        ...options.env,
      },
    });
  } catch (error) {
    const detail = String(error.stderr || error.stdout || error.message).trim();
    throw new Error(`${executable} завершился с ошибкой: ${detail}`);
  }
};

const request = async (origin, token, pathname, options = {}) => {
  const headers = new Headers(options.headers || {});

  if (token) {
    headers.set("authorization", `Bearer ${token}`);
  }

  const response = await fetch(new URL(pathname, `${origin}/`), { ...options, headers });

  if (!response.ok) {
    const responseText = await response.text();
    let message = responseText;

    try {
      const parsed = JSON.parse(responseText);
      message = parsed.message || parsed.error_description || parsed.error || responseText;
    } catch {
      // Не-JSON proxy response всё равно полезнее скрытой HTTP ошибки.
    }

    throw new Error(`Trelio API ${response.status}: ${String(message).slice(0, 1000)}`);
  }

  return response;
};

const getKeychainToken = async (origin) => {
  if (process.platform !== "darwin") {
    return null;
  }

  try {
    const result = await execFileAsync("security", [
      "find-generic-password",
      "-s",
      KEYCHAIN_SERVICE,
      "-a",
      origin,
      "-w",
    ], { encoding: "utf8" });
    return result.stdout.trim() || null;
  } catch {
    return null;
  }
};

const readFallbackCredentials = async () => {
  try {
    return JSON.parse(await fs.readFile(CREDENTIAL_FILE, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") {
      return {};
    }
    throw error;
  }
};

const loadToken = async (origin) => {
  const keychainToken = await getKeychainToken(origin);

  if (keychainToken) {
    return keychainToken;
  }

  const credentials = await readFallbackCredentials();
  return credentials[origin]?.accessToken || null;
};

const saveToken = async (origin, accessToken) => {
  await fs.mkdir(CONFIG_DIRECTORY, { recursive: true, mode: 0o700 });

  if (process.platform === "darwin") {
    await run("security", [
      "add-generic-password",
      "-U",
      "-s",
      KEYCHAIN_SERVICE,
      "-a",
      origin,
      "-w",
      accessToken,
    ]);
    return "macOS Keychain";
  }

  // Linux/Windows fallback остаётся закрытым правами текущего пользователя.
  // Token никогда не помещается в workspace, Git config или stdout.
  const credentials = await readFallbackCredentials();
  credentials[origin] = { accessToken, savedAt: new Date().toISOString() };
  await fs.writeFile(CREDENTIAL_FILE, `${JSON.stringify(credentials, null, 2)}\n`, { mode: 0o600 });
  await fs.chmod(CREDENTIAL_FILE, 0o600);
  return CREDENTIAL_FILE;
};

const openBrowser = async (url) => {
  const candidates = process.platform === "darwin"
    ? [["open", [url]]]
    : process.platform === "win32"
      ? [["cmd", ["/c", "start", "", url]]]
      : [["xdg-open", [url]]];
  const [command, args] = candidates[0];
  const child = spawn(command, args, { detached: true, stdio: "ignore" });
  child.unref();
};

const createPkce = () => {
  const verifier = crypto.randomBytes(48).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
};

const login = async (origin) => {
  const state = crypto.randomBytes(24).toString("base64url");
  const { verifier, challenge } = createPkce();
  let resolveCallback;
  let rejectCallback;
  const callbackPromise = new Promise((resolve, reject) => {
    resolveCallback = resolve;
    rejectCallback = reject;
  });
  const server = http.createServer((incoming, outgoing) => {
    const callbackUrl = new URL(incoming.url || "/", "http://127.0.0.1");

    if (callbackUrl.pathname !== "/oauth/callback") {
      outgoing.writeHead(404).end("Not found");
      return;
    }

    const code = callbackUrl.searchParams.get("code");
    const returnedState = callbackUrl.searchParams.get("state");
    const oauthError = callbackUrl.searchParams.get("error");

    if (oauthError || !code || returnedState !== state) {
      outgoing.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
      outgoing.end("Trelio не удалось подключить. Можно закрыть эту вкладку.");
      rejectCallback(new Error(oauthError || "OAuth callback не прошёл проверку state."));
      return;
    }

    outgoing.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    outgoing.end("<!doctype html><meta charset=utf-8><title>Trelio подключён</title><p>Trelio Agent Workspaces подключён. Эту вкладку можно закрыть.</p>");
    resolveCallback(code);
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  try {
    const address = server.address();
    const redirectUri = `http://127.0.0.1:${address.port}/oauth/callback`;
    const registrationResponse = await request(origin, null, "/oauth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "Trelio Workspace Bridge",
        redirect_uris: [redirectUri],
        scope: OAUTH_SCOPES,
        grant_types: ["authorization_code"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      }),
    });
    const registration = await registrationResponse.json();
    const resource = `${origin}/mcp`;
    const authorizationUrl = new URL("/oauth/authorize", origin);
    authorizationUrl.search = new URLSearchParams({
      response_type: "code",
      client_id: registration.client_id,
      redirect_uri: redirectUri,
      scope: OAUTH_SCOPES,
      state,
      code_challenge: challenge,
      code_challenge_method: "S256",
      resource,
    }).toString();

    process.stdout.write("Открываю Trelio для подтверждения доступа…\n");
    await openBrowser(authorizationUrl.toString());
    let timeoutId;
    const timeout = new Promise((_, reject) => {
      timeoutId = setTimeout(
        () => reject(new Error("Время ожидания OAuth подтверждения истекло.")),
        5 * 60 * 1000,
      );
    });
    const code = await Promise.race([callbackPromise, timeout])
      .finally(() => clearTimeout(timeoutId));
    const tokenResponse = await request(origin, null, "/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
        client_id: registration.client_id,
        code_verifier: verifier,
        resource,
      }),
    });
    const tokenPayload = await tokenResponse.json();
    const storage = await saveToken(origin, tokenPayload.access_token);
    process.stdout.write(`Trelio подключён. Credential сохранён в ${storage}.\n`);
  } finally {
    server.close();
  }
};

const requireToken = async (origin) => {
  const token = await loadToken(origin);

  if (!token) {
    throw new Error(`Нет OAuth credential для ${origin}. Выполните trelio-workspace login.`);
  }

  return token;
};

const writeResponseToFile = async (response, destination) => {
  const bytes = Buffer.from(await response.arrayBuffer());
  await fs.writeFile(destination, bytes, { mode: 0o600 });
};

const materializeBundle = async ({ bundlePath, directory, head, branch }) => {
  if (!GIT_OBJECT_PATTERN.test(head)) {
    throw new Error("Сервер вернул некорректный Git head.");
  }

  await fs.mkdir(directory, { recursive: true });
  await run("git", ["-c", "init.templateDir=", "init", "--initial-branch=main"], { cwd: directory });
  // Ни checkout, ни последующие commit не должны исполнять hooks, которые
  // могли попасть из пользовательского Git template/config на этой машине.
  await run("git", ["config", "core.hooksPath", "/dev/null"], { cwd: directory });
  await run("git", ["config", "fetch.fsckObjects", "true"], { cwd: directory });
  await run("git", ["fetch", bundlePath, "+refs/trelio/exports/*:refs/remotes/trelio-export/*"], { cwd: directory });
  await run("git", ["cat-file", "-e", `${head}^{commit}`], { cwd: directory });
  await run("git", ["checkout", "-B", branch, head], { cwd: directory });
  await run("git", ["config", "user.name", "Trelio Agent Workspace"], { cwd: directory });
  await run("git", ["config", "user.email", "agent-workspaces@trelio.local"], { cwd: directory });
};

const makeReadOnly = async (directory) => {
  if (process.platform === "win32") {
    return;
  }

  const entries = await fs.readdir(directory, { withFileTypes: true });

  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);

    if (entry.isDirectory()) {
      await makeReadOnly(entryPath);
      await fs.chmod(entryPath, 0o555);
    } else {
      await fs.chmod(entryPath, 0o444);
    }
  }
};

const makeWritable = async (directory) => {
  if (process.platform === "win32") {
    return;
  }

  const entries = await fs.readdir(directory, { withFileTypes: true });

  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);

    if (entry.isDirectory()) {
      await fs.chmod(entryPath, 0o755);
      await makeWritable(entryPath);
    } else {
      await fs.chmod(entryPath, 0o644);
    }
  }
  await fs.chmod(directory, 0o755);
};

export const buildRunContextSpecifications = (runId, rawContextHeads = {}) => {
  const normalizedRunId = requireUuid(runId, "run");
  const specifications = [];
  const seenWorkspaceIds = new Set();

  const append = ({ dependencyKind, dependency, relativeDirectory, endpoint }) => {
    if (!dependency) {
      return;
    }

    const workspaceId = requireUuid(dependency.workspaceId, "workspace");

    if (!GIT_OBJECT_PATTERN.test(String(dependency.head || ""))) {
      throw new Error(`Контекст ${workspaceId} содержит некорректный Git head.`);
    }

    // Backend не должен присылать один workspace дважды как parent и related.
    // Локальная проверка не даёт такому ответу перезаписать уже выбранный путь.
    if (seenWorkspaceIds.has(workspaceId)) {
      throw new Error(`Workspace ${workspaceId} повторяется в контексте Agent Run.`);
    }
    seenWorkspaceIds.add(workspaceId);
    specifications.push({
      dependencyKind,
      workspaceId,
      head: String(dependency.head),
      scopeType: dependency.scopeType || dependencyKind,
      scopeKey: dependency.scopeKey || "",
      relativeDirectory,
      endpoint,
    });
  };

  append({
    dependencyKind: "company",
    dependency: rawContextHeads.company,
    relativeDirectory: path.join("context", "company"),
    endpoint: `/api/agent-workspaces/runs/${normalizedRunId}/context/company/bundle`,
  });
  append({
    dependencyKind: "project",
    dependency: rawContextHeads.project,
    relativeDirectory: path.join("context", "project"),
    endpoint: `/api/agent-workspaces/runs/${normalizedRunId}/context/project/bundle`,
  });

  const relatedContexts = Array.isArray(rawContextHeads.related) ? rawContextHeads.related : [];

  for (const dependency of relatedContexts) {
    const workspaceId = requireUuid(dependency.workspaceId, "workspace");
    append({
      dependencyKind: "related",
      dependency,
      // UUID является одновременно безопасным segment и стабильным именем:
      // scopeKey может содержать `/` или измениться после переименования.
      relativeDirectory: path.join("context", "related", workspaceId),
      endpoint: `/api/agent-workspaces/runs/${normalizedRunId}/context/related/${workspaceId}/bundle`,
    });
  }

  return specifications;
};

const readMaterializedContextHead = async (directory) => {
  try {
    const directoryStat = await fs.lstat(directory);

    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
      return null;
    }

    const [headResult, statusResult] = await Promise.all([
      run("git", ["rev-parse", "HEAD"], { cwd: directory }),
      run("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: directory }),
    ]);

    // Даже при неизменном HEAD локально испорченный read-only snapshot нельзя
    // молча считать достоверным: bridge заново скачает pinned server revision.
    return statusResult.stdout.trim() ? null : headResult.stdout.trim();
  } catch {
    return null;
  }
};

const ensureContextDirectoryChain = async (rootDirectory, relativeDirectory) => {
  const relativeParent = path.dirname(relativeDirectory);
  let currentDirectory = rootDirectory;

  for (const segment of relativeParent.split(path.sep).filter((part) => part && part !== ".")) {
    currentDirectory = path.join(currentDirectory, segment);

    try {
      const currentStat = await fs.lstat(currentDirectory);

      if (!currentStat.isDirectory() || currentStat.isSymbolicLink()) {
        throw new Error(`Путь контекста ${currentDirectory} не является обычным каталогом.`);
      }
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
      await fs.mkdir(currentDirectory, { mode: 0o700 });
    }
  }
};

const replaceMaterializedContext = async ({
  origin,
  token,
  rootDirectory,
  specification,
  temporaryDirectory,
}) => {
  const destination = path.join(rootDirectory, specification.relativeDirectory);
  const currentHead = await readMaterializedContextHead(destination);

  if (currentHead === specification.head) {
    await makeReadOnly(destination);
    return { ...specification, directory: destination, changed: false };
  }

  const bundlePath = path.join(temporaryDirectory, `${specification.workspaceId}.bundle`);
  const stagingDirectory = `${destination}.staging-${crypto.randomUUID()}`;
  await ensureContextDirectoryChain(rootDirectory, specification.relativeDirectory);

  try {
    const contextResponse = await request(origin, token, specification.endpoint);
    await writeResponseToFile(contextResponse, bundlePath);
    await materializeBundle({
      bundlePath,
      directory: stagingDirectory,
      head: specification.head,
      branch: "trelio-context",
    });
    await makeReadOnly(stagingDirectory);

    try {
      const destinationStat = await fs.lstat(destination);

      if (destinationStat.isDirectory() && !destinationStat.isSymbolicLink()) {
        await makeWritable(destination);
        await fs.rm(destination, { recursive: true, force: true });
      } else {
        // Не следуем по локально подменённой symlink: удаляем только сам exact
        // destination entry внутри принадлежащего Run root.
        await fs.rm(destination, { force: true });
      }
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
    }

    // Rename в пределах одного root атомарно переключает локальный snapshot:
    // агент не увидит наполовину распакованный related context.
    await fs.rename(stagingDirectory, destination);
    return { ...specification, directory: destination, changed: true };
  } finally {
    await makeWritable(stagingDirectory).catch(() => undefined);
    await fs.rm(stagingDirectory, { recursive: true, force: true }).catch(() => undefined);
  }
};

const materializeRunContexts = async ({ origin, token, rootDirectory, runId, contextHeads }) => {
  const specifications = buildRunContextSpecifications(runId, contextHeads);
  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "trelio-context-"));
  const contexts = [];

  try {
    for (const specification of specifications) {
      contexts.push(await replaceMaterializedContext({
        origin,
        token,
        rootDirectory,
        specification,
        temporaryDirectory,
      }));
    }
  } finally {
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
  }

  return contexts;
};

const serializeMaterializedContexts = (contexts) => contexts.map((context) => ({
  dependencyKind: context.dependencyKind,
  workspaceId: context.workspaceId,
  head: context.head,
  scopeType: context.scopeType,
  scopeKey: context.scopeKey,
  directory: context.directory,
}));

const writeRunMetadata = async (metadataPath, metadata) => {
  await fs.writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, { mode: 0o600 });
  await fs.chmod(metadataPath, 0o600);
};

const writeContextIndex = async (rootDirectory, contexts) => {
  const contextDirectory = path.join(rootDirectory, "context");
  const indexPath = path.join(contextDirectory, "index.json");
  await ensureContextDirectoryChain(rootDirectory, path.join("context", "index.json"));
  await fs.chmod(indexPath, 0o600).catch(() => undefined);
  await fs.writeFile(indexPath, `${JSON.stringify({
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    contexts: serializeMaterializedContexts(contexts),
  }, null, 2)}\n`, { mode: 0o600 });

  if (process.platform !== "win32") {
    await fs.chmod(indexPath, 0o444);
  }
};

const readJsonResponse = async (response) => response.json();

const preflightExistingRunDirectory = async ({ workspaceId, runId, directoryOption }) => {
  const rootDirectory = path.resolve(String(
    directoryOption || path.join(DEFAULT_WORKSPACES_DIRECTORY, workspaceId, runId),
  ));

  try {
    const rootStat = await fs.stat(rootDirectory);

    if (!rootStat.isDirectory()) {
      throw new Error("Выбранный --dir существует и не является каталогом.");
    }

    const metadata = JSON.parse(await fs.readFile(path.join(rootDirectory, ".trelio-run.json"), "utf8"));

    if (metadata.runId !== runId || metadata.workspaceId !== workspaceId) {
      throw new Error("Выбранный каталог уже принадлежит другому Trelio Run.");
    }

    const gitDirectoryStat = await fs.stat(path.join(rootDirectory, "workspace", ".git"));

    if (!gitDirectoryStat.isDirectory()) {
      throw new Error("Каталог Run повреждён: локальный Git workspace отсутствует.");
    }
  } catch (error) {
    if (error.code === "ENOENT") {
      // Отсутствующий root безопасно создаст bridge. Но существующий каталог
      // без metadata не должен проходить: иначе claim отзовёт живую аренду до
      // того, как локальная ошибка станет видна оператору.
      try {
        await fs.stat(rootDirectory);
      } catch (rootError) {
        if (rootError.code === "ENOENT") {
          return;
        }
        throw rootError;
      }
      throw new Error("Выбранный --dir уже существует, но не принадлежит этому Trelio Run.");
    }
    throw error;
  }
};

const openWorkspace = async (origin, options) => {
  const token = await requireToken(origin);
  const workspaceId = requireUuid(options.workspace, "workspace");
  let runPayload;

  if (options.run) {
    const runId = requireUuid(options.run, "run");
    await preflightExistingRunDirectory({
      workspaceId,
      runId,
      directoryOption: options.dir,
    });
    const overview = await readJsonResponse(await request(
      origin,
      token,
      `/api/agent-workspaces/workspaces/${workspaceId}`,
    ));
    const existingRun = overview.runs.find((item) => item.id === runId);

    if (!existingRun) {
      throw new Error("Run не найден в указанном workspace или недоступен пользователю.");
    }
    const claimedRun = await readJsonResponse(await request(
      origin,
      token,
      `/api/agent-workspaces/runs/${runId}/claim`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          expectedFencingToken: existingRun.fencingToken,
          clientKind: "workspace-bridge",
          clientVersion: BRIDGE_VERSION,
        }),
      },
    ));
    runPayload = { run: claimedRun, workspace: overview.workspace };
  } else {
    runPayload = await readJsonResponse(await request(
      origin,
      token,
      `/api/agent-workspaces/workspaces/${workspaceId}/runs`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ clientKind: "workspace-bridge", clientVersion: BRIDGE_VERSION }),
      },
    ));
  }

  const agentRun = runPayload.run;
  const runId = requireUuid(agentRun.id, "run");
  const rootDirectory = path.resolve(String(options.dir || path.join(DEFAULT_WORKSPACES_DIRECTORY, workspaceId, runId)));
  const workspaceDirectory = path.join(rootDirectory, "workspace");
  const metadataPath = path.join(rootDirectory, ".trelio-run.json");
  let rootDirectoryExists = false;

  try {
    const rootStat = await fs.stat(rootDirectory);

    if (!rootStat.isDirectory()) {
      throw new Error("Выбранный --dir существует и не является каталогом.");
    }
    rootDirectoryExists = true;
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }

  try {
    const existingMetadata = JSON.parse(await fs.readFile(metadataPath, "utf8"));

    if (existingMetadata.runId === runId && existingMetadata.workspaceId === workspaceId) {
      const gitDirectoryStat = await fs.stat(path.join(workspaceDirectory, ".git"));

      if (!gitDirectoryStat.isDirectory()) {
        throw new Error("Каталог Run повреждён: локальный Git workspace отсутствует.");
      }
      // Claim всегда ротирует lease/fencing pair. Даже если Git-каталог уже
      // материализован, локальный metadata обязан получить новые значения до
      // возврата управления агенту, иначе первый heartbeat будет закономерно
      // отклонён как запрос от прежнего владельца аренды.
      const refreshedMetadata = {
        ...existingMetadata,
        schemaVersion: 2,
        origin,
        leaseId: agentRun.leaseId,
        fencingToken: agentRun.fencingToken,
        baseHead: agentRun.baseHead,
        workspaceDirectory,
        contextHeads: agentRun.contextHeadsJson || {},
        claimedAt: new Date().toISOString(),
      };
      // Новая lease-пара сохраняется до сетевой синхронизации контекста. Если
      // download related bundle временно упадёт, следующий вызов `context sync`
      // продолжит работу с уже актуальным fencing, а не со старой арендой.
      await writeRunMetadata(metadataPath, refreshedMetadata);
      const contexts = await materializeRunContexts({
        origin,
        token,
        rootDirectory,
        runId,
        contextHeads: refreshedMetadata.contextHeads,
      });
      await writeContextIndex(rootDirectory, contexts);
      await writeRunMetadata(metadataPath, {
        ...refreshedMetadata,
        contexts: serializeMaterializedContexts(contexts),
      });
      process.stdout.write(`${workspaceDirectory}\n`);
      return;
    }
    throw new Error("Выбранный каталог уже принадлежит другому Trelio Run.");
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }

  if (rootDirectoryExists) {
    throw new Error("Выбранный --dir уже существует, но не принадлежит этому Trelio Run.");
  }

  await fs.mkdir(rootDirectory, { recursive: true, mode: 0o700 });
  let ownsRootDirectory = true;
  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "trelio-workspace-"));

  try {
    const baseBundlePath = path.join(temporaryDirectory, "base.bundle");
    const baseResponse = await request(origin, token, `/api/agent-workspaces/runs/${runId}/bundle`);
    await writeResponseToFile(baseResponse, baseBundlePath);
    await materializeBundle({
      bundlePath: baseBundlePath,
      directory: workspaceDirectory,
      head: agentRun.baseHead,
      branch: "trelio-candidate",
    });

    const contextHeads = agentRun.contextHeadsJson || {};
    const contexts = await materializeRunContexts({
      origin,
      token,
      rootDirectory,
      runId,
      contextHeads,
    });
    await writeContextIndex(rootDirectory, contexts);

    const metadata = {
      schemaVersion: 2,
      origin,
      workspaceId,
      runId,
      leaseId: agentRun.leaseId,
      fencingToken: agentRun.fencingToken,
      baseHead: agentRun.baseHead,
      workspaceDirectory,
      contextHeads,
      contexts: serializeMaterializedContexts(contexts),
      createdAt: new Date().toISOString(),
    };
    await writeRunMetadata(metadataPath, metadata);
    process.stdout.write(`${workspaceDirectory}\n`);
  } catch (error) {
    // Не оставляем полуматериализованный Run: следующий open должен либо найти
    // полностью готовый metadata, либо начать в чистом каталоге. Удалять можно
    // только exact root, отсутствие которого bridge проверил перед созданием.
    if (ownsRootDirectory) {
      await fs.rm(rootDirectory, { recursive: true, force: true });
      ownsRootDirectory = false;
    }
    throw error;
  } finally {
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
  }
};

const findRunMetadata = async (startDirectory = process.cwd()) => {
  let current = path.resolve(startDirectory);

  while (true) {
    for (const candidate of [
      path.join(current, ".trelio-run.json"),
      path.join(current, "..", ".trelio-run.json"),
    ]) {
      try {
        const metadata = JSON.parse(await fs.readFile(candidate, "utf8"));
        return { metadata, metadataPath: path.resolve(candidate) };
      } catch (error) {
        if (error.code !== "ENOENT") {
          throw error;
        }
      }
    }

    const parent = path.dirname(current);

    if (parent === current) {
      throw new Error("Текущий каталог не находится внутри материализованного Trelio Run.");
    }
    current = parent;
  }
};

const withRun = async (handler) => {
  const { metadata, metadataPath } = await findRunMetadata();
  const origin = normalizeOrigin(metadata.origin);
  const token = await requireToken(origin);
  return handler({ metadata, metadataPath, origin, token });
};

const heartbeat = async () => withRun(async ({ metadata, origin, token }) => {
  const response = await request(origin, token, `/api/agent-workspaces/runs/${metadata.runId}/heartbeat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ leaseId: metadata.leaseId, fencingToken: metadata.fencingToken }),
  });
  const runPayload = await response.json();
  process.stdout.write(`Lease продлён до ${runPayload.leaseExpiresAt}.\n`);
});

const synchronizeRunContext = async ({ metadata, metadataPath, origin, token }) => {
  const overview = await readJsonResponse(await request(
    origin,
    token,
    `/api/agent-workspaces/workspaces/${requireUuid(metadata.workspaceId, "workspace")}`,
  ));
  const agentRun = overview.runs.find((item) => item.id === metadata.runId);

  if (!agentRun) {
    throw new Error("Agent Run не найден или больше недоступен пользователю.");
  }

  const rootDirectory = path.dirname(metadataPath);
  const contextHeads = agentRun.contextHeadsJson || {};
  const contexts = await materializeRunContexts({
    origin,
    token,
    rootDirectory,
    runId: metadata.runId,
    contextHeads,
  });
  await writeContextIndex(rootDirectory, contexts);
  await writeRunMetadata(metadataPath, {
    ...metadata,
    schemaVersion: 2,
    contextHeads,
    contexts: serializeMaterializedContexts(contexts),
    contextSyncedAt: new Date().toISOString(),
  });
  const changedCount = contexts.filter((context) => context.changed).length;
  process.stdout.write(`Контекст синхронизирован: ${contexts.length}, обновлено: ${changedCount}.\n`);
  process.stdout.write(`${path.join(rootDirectory, "context", "index.json")}\n`);
};

const contextCommand = async (options, positional) => withRun(async (runContext) => {
  if (positional[0] === "sync") {
    await synchronizeRunContext(runContext);
    return;
  }

  if (positional[0] === "attach") {
    const relatedWorkspaceId = requireUuid(options.workspace, "workspace");
    await readJsonResponse(await request(
      runContext.origin,
      runContext.token,
      `/api/agent-workspaces/runs/${runContext.metadata.runId}/context/related`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          relatedWorkspaceId,
          leaseId: runContext.metadata.leaseId,
          fencingToken: runContext.metadata.fencingToken,
        }),
      },
    ));
    await synchronizeRunContext(runContext);
    return;
  }

  throw new Error("Поддерживаются `trelio-workspace context sync` и `trelio-workspace context attach --workspace UUID`.");
});

const getOptionValues = (options, key) => {
  const rawValue = options[key];
  const values = Array.isArray(rawValue) ? rawValue : rawValue === undefined ? [] : [rawValue];
  return values
    .map((value) => String(value).trim())
    .filter(Boolean);
};

const getChangedPaths = async (workspaceDirectory) => {
  const gitStatus = await getGitStatus(workspaceDirectory);

  if (!gitStatus) {
    return [];
  }

  // `git status --short` начинает строку двухсимвольным статусом и пробелом.
  // Для rename человеку полезен итоговый путь справа от ` -> `.
  return gitStatus
    .split("\n")
    .map((line) => line.slice(3).trim())
    .map((changedPath) => changedPath.split(" -> ").at(-1)?.trim() || changedPath)
    .filter(Boolean);
};

const checkpoint = async (options) => withRun(async ({ metadata, origin, token }) => {
  const checkpointType = String(options.type || "draft");
  const summary = String(options.summary || "").trim();

  if (!summary) {
    throw new Error("Для checkpoint требуется --summary.");
  }

  const allowedTypes = new Set(["research", "analysis", "draft", "decision", "artifact", "blocker", "handoff"]);

  if (!allowedTypes.has(checkpointType)) {
    throw new Error("Неизвестный --type checkpoint.");
  }

  const evidence = getOptionValues(options, "evidence");
  const explicitlyNamedFiles = getOptionValues(options, "file");
  const filesChanged = explicitlyNamedFiles.length > 0
    ? explicitlyNamedFiles
    : checkpointType === "handoff"
      ? await getChangedPaths(metadata.workspaceDirectory)
      : [];
  const openQuestions = getOptionValues(options, "question");
  const nextActionInstruction = getOptionValues(options, "next-action")[0] || "";
  const rawTaskCommentId = getOptionValues(options, "task-comment")[0] || "";
  const taskCommentId = rawTaskCommentId ? requireUuid(rawTaskCommentId, "task-comment") : "";

  if (checkpointType === "handoff") {
    if (summary.length < 20) {
      throw new Error("Для handoff опишите итог для человека минимум в 20 символах через --summary.");
    }

    if (evidence.length === 0) {
      throw new Error("Для handoff добавьте хотя бы один результат или проверку через --evidence.");
    }

    if (filesChanged.length === 0) {
      throw new Error("Для handoff укажите материал через --file или оставьте изменения в workspace.");
    }

    if (!nextActionInstruction) {
      throw new Error("Для handoff явно укажите действие оператора через --next-action.");
    }
  }

  const response = await request(origin, token, `/api/agent-workspaces/runs/${metadata.runId}/checkpoints`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      leaseId: metadata.leaseId,
      fencingToken: metadata.fencingToken,
      checkpointType,
      summary,
      ...(evidence.length > 0 ? { evidence } : {}),
      ...(filesChanged.length > 0 ? { filesChanged } : {}),
      ...(openQuestions.length > 0 ? { openQuestions } : {}),
      ...(nextActionInstruction ? { nextAction: { instruction: nextActionInstruction } } : {}),
      ...(taskCommentId ? { taskCommentId } : {}),
    }),
  });
  const checkpointPayload = await response.json();
  process.stdout.write(`Checkpoint сохранён: ${checkpointPayload.id}.\n`);
});

const getGitStatus = async (workspaceDirectory) => {
  const result = await run("git", ["status", "--short"], { cwd: workspaceDirectory });
  return result.stdout.trim();
};

const status = async () => withRun(async ({ metadata }) => {
  const gitStatus = await getGitStatus(metadata.workspaceDirectory);
  process.stdout.write(`${JSON.stringify({
    workspaceId: metadata.workspaceId,
    runId: metadata.runId,
    baseHead: metadata.baseHead,
    workspaceDirectory: metadata.workspaceDirectory,
    contexts: Array.isArray(metadata.contexts) ? metadata.contexts : [],
    dirty: Boolean(gitStatus),
    changes: gitStatus ? gitStatus.split("\n") : [],
  }, null, 2)}\n`);
});

const submit = async (options) => withRun(async ({ metadata, origin, token }) => {
  const workspaceDirectory = metadata.workspaceDirectory;
  const gitStatus = await getGitStatus(workspaceDirectory);

  if (gitStatus) {
    await run("git", ["add", "--all"], { cwd: workspaceDirectory });
    await run("git", ["commit", "-m", String(options.message || "Подготовить результат Agent Run")], {
      cwd: workspaceDirectory,
    });
  }

  const headResult = await run("git", ["rev-parse", "HEAD"], { cwd: workspaceDirectory });
  const head = headResult.stdout.trim();

  if (head === metadata.baseHead) {
    throw new Error("В workspace нет изменений для отправки.");
  }

  await heartbeat();
  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "trelio-candidate-"));
  const bundlePath = path.join(temporaryDirectory, "candidate.bundle");

  try {
    await run("git", ["bundle", "create", bundlePath, "refs/heads/trelio-candidate"], {
      cwd: workspaceDirectory,
    });
    const bundleStat = await fs.stat(bundlePath);
    const response = await request(origin, token, `/api/agent-workspaces/runs/${metadata.runId}/candidate`, {
      method: "POST",
      duplex: "half",
      headers: {
        "content-type": "application/vnd.git.bundle",
        "content-length": String(bundleStat.size),
        "x-trelio-lease-id": metadata.leaseId,
        "x-trelio-fencing-token": String(metadata.fencingToken),
      },
      body: createReadStream(bundlePath),
    });
    const result = await response.json();
    if (result.run.status !== "accepted") {
      throw new Error(`Trelio вернул неожиданный статус Agent Run: ${result.run.status}.`);
    }
    process.stdout.write("Результат записан в рабочее пространство Trelio.\n");
    process.stdout.write("Статус: принят автоматически.\n");
    process.stdout.write("Проверки структуры, безопасности и актуальности базовой версии пройдены.\n");
    if (result.projection?.status === "pending_reconciliation") {
      process.stdout.write("Git-проекция будет восстановлена фоновым reconciliation; повторять submit не нужно.\n");
    }
  } finally {
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
  }
});

const spawnSecretCommand = async ({ commandArguments, deliveryMode, environmentVariable, secretValue }) => {
  const [executable, ...args] = commandArguments;
  const childEnvironment = { ...process.env };
  let temporaryDirectory = null;
  let childStdin = "inherit";

  if (deliveryMode === "env") {
    if (!environmentVariable) {
      throw new Error("Сервер не указал переменную окружения для env checkout.");
    }
    childEnvironment[environmentVariable] = secretValue;
  } else if (deliveryMode === "stdin") {
    childStdin = "pipe";
  } else if (deliveryMode === "file") {
    temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "trelio-secret-"));
    await fs.chmod(temporaryDirectory, 0o700);
    const secretFilePath = path.join(temporaryDirectory, "value");
    await fs.writeFile(secretFilePath, secretValue, { mode: 0o600 });
    await fs.chmod(secretFilePath, 0o600);
    // Фиксированное имя не содержит название секрета и позволяет инструменту
    // прочитать файл без подстановки plaintext в argv или shell history.
    childEnvironment.TRELIO_SECRET_FILE = secretFilePath;
  } else {
    throw new Error(`Неизвестный delivery mode: ${deliveryMode}`);
  }

  try {
    const exitCode = await new Promise((resolve, reject) => {
      const child = spawn(executable, args, {
        cwd: process.cwd(),
        env: childEnvironment,
        shell: false,
        stdio: [childStdin, "inherit", "inherit"],
      });

      child.once("error", reject);
      child.once("exit", (code, signal) => {
        if (signal) {
          reject(new Error(`Локальная команда остановлена сигналом ${signal}.`));
          return;
        }
        resolve(code ?? 1);
      });

      if (deliveryMode === "stdin") {
        child.stdin.end(secretValue);
      }
    });

    if (exitCode !== 0) {
      throw new Error(`Локальная команда завершилась с кодом ${exitCode}.`);
    }
  } finally {
    // Значение не логируем и не сохраняем в workspace. В file mode удаляем
    // весь отдельный private temp directory независимо от результата команды.
    if (temporaryDirectory) {
      await fs.rm(temporaryDirectory, { recursive: true, force: true });
    }
  }
};

const readSecretInput = async (fileOption) => {
  if (fileOption) {
    const filePath = path.resolve(String(fileOption));
    const stat = await fs.stat(filePath);
    if (!stat.isFile() || stat.size < 1 || stat.size > 64 * 1024) {
      throw new Error("Файл секрета должен содержать от 1 до 65536 байт.");
    }
    return fs.readFile(filePath, "utf8");
  }

  if (process.stdin.isTTY) {
    throw new Error("Передайте значение через stdin или --file. Не указывайте секрет в аргументах команды.");
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > 64 * 1024) throw new Error("Значение секрета превышает 65536 байт.");
    chunks.push(bytes);
  }
  const value = Buffer.concat(chunks).toString("utf8");
  if (!value) throw new Error("Значение секрета не может быть пустым.");
  return value;
};

const setSecretValue = async (options, positional) => withRun(async ({ metadata, origin, token }) => {
  if (positional[0] !== "set") {
    throw new Error("Поддерживаются `secret set` и `secret exec`.");
  }
  const secretId = requireUuid(options.secret, "secret");
  const value = await readSecretInput(options.file);
  const response = await request(origin, token, `/api/agent-secrets/secrets/${secretId}/value-from-bridge`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ runId: metadata.runId, value }),
  });
  await response.json();
  process.stdout.write("Значение секрета зашифровано и сохранено новой версией.\n");
});

const executeSecretCheckout = async (options, positional) => withRun(async ({ metadata, origin, token }) => {
  if (positional[0] !== "exec") {
    throw new Error("Поддерживается команда `trelio-workspace secret exec --grant UUID -- COMMAND [ARGS...]`.");
  }

  const grantId = requireUuid(options.grant, "grant");
  const commandArguments = positional.slice(1);

  if (commandArguments.length === 0) {
    throw new Error("После `--` укажите локальную программу и её аргументы.");
  }

  if (!metadata.runId) {
    throw new Error("Текущая папка не содержит активный Trelio Agent Run.");
  }

  // Endpoint атомарно consume-ит одноразовый grant. Ответ держим только в
  // памяти bridge и никогда не печатаем, не пишем в metadata и не передаём MCP.
  const response = await request(origin, token, `/api/agent-secrets/checkout-grants/${grantId}/consume`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    // runId берётся только из materialized `.trelio-run.json`. Backend сверяет
    // его с grant и повторно проверяет активную lease в atomic consume.
    body: JSON.stringify({ runId: metadata.runId }),
  });
  const payload = await response.json();

  if (payload.executable !== commandArguments[0]) {
    throw new Error("Локальная программа не совпадает с executable, закреплённым в checkout grant.");
  }

  if (payload.runId !== metadata.runId) {
    throw new Error("Checkout grant принадлежит другому Trelio Agent Run.");
  }

  await spawnSecretCommand({
    commandArguments,
    deliveryMode: payload.deliveryMode,
    environmentVariable: payload.environmentVariable,
    secretValue: payload.value,
  });
});

const printHelp = () => {
  process.stdout.write(`Trelio Agent Workspace Bridge ${BRIDGE_VERSION}\n\n`);
  process.stdout.write("Команды:\n");
  process.stdout.write("  trelio-workspace login [--origin https://trelio.ru]\n");
  process.stdout.write("  trelio-workspace open --workspace UUID [--run UUID] [--dir PATH]\n");
  process.stdout.write("  trelio-workspace status\n");
  process.stdout.write("  trelio-workspace heartbeat\n");
  process.stdout.write("  trelio-workspace context sync\n");
  process.stdout.write("  trelio-workspace context attach --workspace UUID\n");
  process.stdout.write("  trelio-workspace checkpoint --type draft --summary TEXT\n");
  process.stdout.write("  trelio-workspace checkpoint --type handoff --summary TEXT --evidence TEXT [--file PATH] [--question TEXT] [--task-comment UUID] --next-action TEXT\n");
  process.stdout.write("  trelio-workspace submit [--message TEXT]\n");
  process.stdout.write("  trelio-workspace secret exec --grant UUID -- COMMAND [ARGS...]\n");
  process.stdout.write("  COMMAND | trelio-workspace secret set --secret UUID\n");
  process.stdout.write("  trelio-workspace secret set --secret UUID --file PATH\n");
};

const main = async () => {
  const { command, options, positional } = parseArguments(process.argv.slice(2));
  const origin = normalizeOrigin(options.origin || DEFAULT_ORIGIN);

  if (command === "login") {
    await login(origin);
  } else if (command === "open") {
    await openWorkspace(origin, options);
  } else if (command === "status") {
    await status();
  } else if (command === "heartbeat") {
    await heartbeat();
  } else if (command === "context") {
    await contextCommand(options, positional);
  } else if (command === "checkpoint") {
    await checkpoint(options);
  } else if (command === "submit") {
    await submit(options);
  } else if (command === "secret") {
    if (positional[0] === "set") {
      await setSecretValue(options, positional);
    } else {
      await executeSecretCheckout(options, positional);
    }
  } else if (command === "help" || command === "--help" || command === "-h") {
    printHelp();
  } else {
    throw new Error(`Неизвестная команда: ${command}`);
  }
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => fail(error instanceof Error ? error.message : String(error)));
}
