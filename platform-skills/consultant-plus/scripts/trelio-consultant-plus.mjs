#!/usr/bin/env node

import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  rm,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const SKILL_ID = "consultant-plus";
const STATE_SCHEMA_VERSION = 1;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const ACCESS_STATES = new Set(["unknown", "connected", "no_access", "needs_reconnect"]);
const BROWSER_PREFERENCES = new Set([
  "codex-browser",
  "codex-chrome",
  "claude-chrome",
  "claude-edge",
]);

const fail = (message) => {
  throw new Error(message);
};

const parseArguments = (argv) => {
  const [command = "help", ...tokens] = argv;
  const options = new Map();

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token.startsWith("--")) fail(`Неизвестный аргумент: ${token}`);
    const name = token.slice(2);
    if (!name || options.has(name)) fail(`Некорректная или повторная опция: ${token}`);

    if (name === "confirm") {
      options.set(name, true);
      continue;
    }

    const value = tokens[index + 1];
    if (!value || value.startsWith("--")) fail(`Для ${token} требуется значение.`);
    options.set(name, value);
    index += 1;
  }

  return { command, options };
};

const requireExactOptions = (options, allowed) => {
  for (const name of options.keys()) {
    if (!allowed.has(name)) fail(`Команда не поддерживает --${name}.`);
  }
};

const requireRuntimeIdentity = () => {
  const companyId = String(process.env.TRELIO_SKILL_COMPANY_ID || "");
  const memberId = String(process.env.TRELIO_SKILL_MEMBER_ID || "");
  const skillId = String(process.env.TRELIO_SKILL_ID || "");

  if (!UUID_PATTERN.test(companyId)) fail("TRELIO_SKILL_COMPANY_ID отсутствует или некорректен.");
  if (!UUID_PATTERN.test(memberId)) fail("TRELIO_SKILL_MEMBER_ID отсутствует или некорректен.");
  if (skillId !== SKILL_ID) fail("Runtime запущен не для навыка consultant-plus.");

  return { companyId, memberId, skillId };
};

const resolveConfigHome = () => {
  const explicitRoot = process.env.TRELIO_CONFIG_HOME;
  if (explicitRoot) {
    if (!path.isAbsolute(explicitRoot)) fail("TRELIO_CONFIG_HOME должен быть абсолютным путём.");
    return path.normalize(explicitRoot);
  }

  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA;
    if (!localAppData || !path.isAbsolute(localAppData)) {
      fail("LOCALAPPDATA отсутствует или некорректен.");
    }
    return path.join(localAppData, "Trelio");
  }

  const xdgConfigHome = process.env.XDG_CONFIG_HOME;
  if (xdgConfigHome) {
    if (!path.isAbsolute(xdgConfigHome)) fail("XDG_CONFIG_HOME должен быть абсолютным путём.");
    return path.join(xdgConfigHome, "trelio");
  }

  return path.join(os.homedir(), ".config", "trelio");
};

const resolveStateLocation = (identity) => {
  const configHome = resolveConfigHome();
  const directory = path.join(
    configHome,
    "integrations",
    SKILL_ID,
    identity.companyId,
    identity.memberId,
    "browser",
    "state",
  );
  return { configHome, directory, file: path.join(directory, "access.json") };
};

const assertRealPrivateDirectory = async (directory) => {
  const metadata = await lstat(directory);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    fail(`Небезопасный путь локального состояния: ${directory}`);
  }
  if (process.platform !== "win32") await chmod(directory, 0o700);
};

const ensureStateDirectory = async ({ configHome, directory }) => {
  // Runtime owns everything below the configured Trelio root. Checking each
  // segment before descending prevents a pre-created symlink inside this
  // namespace from redirecting even mkdir side effects into another tree.
  await mkdir(configHome, { recursive: true, mode: 0o700 });
  const relativeSegments = path.relative(configHome, directory).split(path.sep).filter(Boolean);
  let current = configHome;
  await assertRealPrivateDirectory(current);
  for (const segment of relativeSegments) {
    current = path.join(current, segment);
    await mkdir(current, { mode: 0o700 }).catch((error) => {
      if (error?.code !== "EEXIST") throw error;
    });
    await assertRealPrivateDirectory(current);
  }
};

const defaultState = (identity) => ({
  schemaVersion: STATE_SCHEMA_VERSION,
  skillId: identity.skillId,
  companyId: identity.companyId,
  memberId: identity.memberId,
  accessState: "unknown",
  browserPreference: null,
  lastVerifiedAt: null,
  updatedAt: null,
});

const validateStoredState = (candidate, identity) => {
  if (
    !candidate
    || typeof candidate !== "object"
    || Array.isArray(candidate)
    || candidate.schemaVersion !== STATE_SCHEMA_VERSION
    || candidate.skillId !== identity.skillId
    || candidate.companyId !== identity.companyId
    || candidate.memberId !== identity.memberId
    || !ACCESS_STATES.has(candidate.accessState)
    || (
      candidate.browserPreference !== null
      && !BROWSER_PREFERENCES.has(candidate.browserPreference)
    )
    || (
      candidate.accessState === "connected"
      && !BROWSER_PREFERENCES.has(candidate.browserPreference)
    )
    || (candidate.lastVerifiedAt !== null && typeof candidate.lastVerifiedAt !== "string")
    || (candidate.updatedAt !== null && typeof candidate.updatedAt !== "string")
  ) {
    fail("Локальное состояние ConsultantPlus повреждено или относится к другой учётной записи.");
  }
  return candidate;
};

const readState = async (location, identity) => {
  try {
    const metadata = await lstat(location.file);
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      fail("Файл локального состояния ConsultantPlus имеет небезопасный тип.");
    }
    if (metadata.size > 16 * 1024) {
      fail("Файл локального состояния ConsultantPlus слишком велик.");
    }
    const bytes = await readFile(location.file, "utf8");
    return validateStoredState(JSON.parse(bytes), identity);
  } catch (error) {
    if (error?.code === "ENOENT") return defaultState(identity);
    if (error instanceof SyntaxError) fail("Локальное состояние ConsultantPlus содержит некорректный JSON.");
    throw error;
  }
};

const writeState = async (location, state) => {
  await ensureStateDirectory(location);
  const temporaryFile = path.join(
    location.directory,
    `.access.${process.pid}.${randomUUID()}.tmp`,
  );
  const body = `${JSON.stringify(state, null, 2)}\n`;
  let handle;

  try {
    // Exclusive creation plus same-directory rename makes a complete state
    // visible atomically and avoids following an attacker-controlled target
    // symlink. The temporary file never carries browser credentials.
    handle = await open(temporaryFile, "wx", 0o600);
    await handle.writeFile(body, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporaryFile, location.file);
    if (process.platform !== "win32") await chmod(location.file, 0o600);
  } finally {
    await handle?.close().catch(() => undefined);
    await rm(temporaryFile, { force: true }).catch(() => undefined);
  }
};

const renderState = (state) => ({
  ok: true,
  accessState: state.accessState,
  browserPreference: state.browserPreference,
  configured: state.accessState !== "unknown",
  canUseConsultantPlus: state.accessState === "connected",
  lastVerifiedAt: state.lastVerifiedAt,
  updatedAt: state.updatedAt,
  storesCredentials: false,
});

const main = async () => {
  const { command, options } = parseArguments(process.argv.slice(2));

  if (command === "help") {
    requireExactOptions(options, new Set());
    process.stdout.write([
      "ConsultantPlus local preference runtime",
      "",
      "Commands:",
      "  status",
      "  set-connected --browser codex-browser|codex-chrome|claude-chrome|claude-edge",
      "  set-no-access",
      "  set-needs-reconnect [--browser SURFACE]",
      "  reset --confirm",
      "",
    ].join("\n"));
    return;
  }

  const identity = requireRuntimeIdentity();
  const location = resolveStateLocation(identity);
  const current = await readState(location, identity);

  if (command === "status") {
    requireExactOptions(options, new Set());
    process.stdout.write(`${JSON.stringify(renderState(current))}\n`);
    return;
  }

  const now = new Date().toISOString();
  let next;

  if (command === "set-connected") {
    requireExactOptions(options, new Set(["browser"]));
    const browserPreference = options.get("browser");
    if (!BROWSER_PREFERENCES.has(browserPreference)) {
      fail("Для set-connected требуется поддерживаемый --browser.");
    }
    next = {
      ...current,
      accessState: "connected",
      browserPreference,
      lastVerifiedAt: now,
      updatedAt: now,
    };
  } else if (command === "set-no-access") {
    requireExactOptions(options, new Set());
    next = {
      ...current,
      accessState: "no_access",
      browserPreference: null,
      lastVerifiedAt: null,
      updatedAt: now,
    };
  } else if (command === "set-needs-reconnect") {
    requireExactOptions(options, new Set(["browser"]));
    const browserPreference = options.get("browser") ?? current.browserPreference;
    if (browserPreference !== null && !BROWSER_PREFERENCES.has(browserPreference)) {
      fail("Для set-needs-reconnect указан неподдерживаемый --browser.");
    }
    next = {
      ...current,
      accessState: "needs_reconnect",
      browserPreference,
      lastVerifiedAt: null,
      updatedAt: now,
    };
  } else if (command === "reset") {
    requireExactOptions(options, new Set(["confirm"]));
    if (options.get("confirm") !== true) fail("Для reset требуется --confirm.");
    next = { ...defaultState(identity), updatedAt: now };
  } else {
    fail(`Неизвестная команда: ${command}`);
  }

  validateStoredState(next, identity);
  await writeState(location, next);
  process.stdout.write(`${JSON.stringify(renderState(next))}\n`);
};

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
