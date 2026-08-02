#!/usr/bin/env node

/**
 * Local MAX web runtime for the Trelio skill catalog.
 *
 * Browser cookies stay in a persistent profile outside every workspace. The
 * executable intentionally exposes only chat operations; incoming content
 * cannot invoke Trelio or another integration through this runtime.
 */

import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const SKILL_ID = "max-web";
const MAX_WEB_URL = "https://web.max.ru/";
const MAX_WEB_ORIGIN = new URL(MAX_WEB_URL).origin;
const POLICY_MODES = new Set(["confirm", "autonomous", "read-only"]);
const RUNTIME_VERSION = "1";
const ADAPTER_VERSION = "2";
const MAX_UI_READY_TIMEOUT_MS = 10_000;
const MAX_HISTORY_PAGES = 20;
const MAX_FILES_PER_MESSAGE = 10;
const MAX_GROUP_MEMBERS_PER_OPERATION = 100;
const MAX_WATCH_ITERATIONS = 60;
const MAX_WATCH_INTERVAL_MS = 300_000;
const PASSIVE_READ_PROTOCOL_MARKERS = ["READ_MESSAGE", "READ_REACTION"];
const STRUCTURAL_CONFIRMATION_COMMANDS = new Set([
  "chat-update",
  "create-direct",
  "create-group",
  "delete",
  "edit",
  "forward",
  "member-add",
  "member-remove",
]);
const MUTATING_COMMANDS = new Set([
  ...STRUCTURAL_CONFIRMATION_COMMANDS,
  "react",
  "reply",
  "send",
]);
const SUPPORTED_COMMANDS = new Set([
  "bootstrap",
  "chat-update",
  "contacts",
  "create-direct",
  "create-group",
  "delete",
  "dialogs",
  "doctor",
  "download",
  "edit",
  "forward",
  "help",
  "login",
  "member-add",
  "member-remove",
  "members",
  "policy",
  "probe",
  "react",
  "read",
  "reply",
  "send",
  "unread",
  "watch",
]);

const output = (payload) => process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);

const configHome = () => {
  if (process.env.TRELIO_CONFIG_HOME) return path.resolve(process.env.TRELIO_CONFIG_HOME);
  if (process.platform === "win32") {
    return path.join(process.env.LOCALAPPDATA || os.homedir(), "Trelio");
  }
  return path.join(os.homedir(), ".config", "trelio");
};

const cacheHome = () => {
  if (process.env.TRELIO_CACHE_HOME) return path.resolve(process.env.TRELIO_CACHE_HOME);
  if (process.platform === "win32") {
    return path.join(process.env.LOCALAPPDATA || os.homedir(), "Trelio", "cache");
  }
  return path.join(os.homedir(), ".cache", "trelio");
};

const normalizeIdentityPart = (value, label) => {
  const normalized = String(value || "").trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{0,127}$/u.test(normalized)) {
    throw new Error(`${label} must contain only lowercase letters, digits and hyphens.`);
  }
  return normalized;
};

const ensurePrivateDirectory = (directory) => {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") fs.chmodSync(directory, 0o700);
};

const ensurePrivateFile = (file) => {
  if (!fs.existsSync(file) || process.platform === "win32") return;
  const mode = fs.statSync(file).mode & 0o777;
  if ((mode & 0o077) !== 0) {
    throw new Error(`Unsafe permissions on ${file}: expected 600, got ${mode.toString(8)}.`);
  }
};

const writePrivateJson = (file, value) => {
  ensurePrivateDirectory(path.dirname(file));
  const temporary = `${file}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  if (process.platform !== "win32") fs.chmodSync(temporary, 0o600);
  fs.renameSync(temporary, file);
};

const runtimeRoot = () => path.join(cacheHome(), "runtimes", SKILL_ID, RUNTIME_VERSION);

const defaultChromeExecutable = () => {
  const candidates = process.platform === "darwin"
    ? [
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/Applications/Chromium.app/Contents/MacOS/Chromium",
      ]
    : process.platform === "win32"
      ? [
          path.join(process.env.PROGRAMFILES || "C:\\Program Files", "Google", "Chrome", "Application", "chrome.exe"),
          path.join(process.env.LOCALAPPDATA || "", "Google", "Chrome", "Application", "chrome.exe"),
        ]
      : [
          "/usr/bin/google-chrome",
          "/usr/bin/google-chrome-stable",
          "/usr/bin/chromium",
          "/usr/bin/chromium-browser",
        ];
  return candidates.find((candidate) => candidate && fs.existsSync(candidate)) || candidates[0];
};

const parseArguments = (argv) => {
  const options = {
    command: "",
    policyCommand: "",
    companyId: "",
    memberId: "",
    connectionId: "",
    companyAllowsAutonomous: true,
    sendMode: "",
    chromeExecutable: defaultChromeExecutable(),
    headed: false,
    holdMs: 600_000,
    timeoutMs: 60_000,
    query: "",
    chat: "",
    contact: "",
    title: "",
    members: [],
    message: "",
    messageFile: "",
    files: [],
    avatar: "",
    output: "",
    messageId: "",
    targetText: "",
    targetAuthor: "",
    reaction: "",
    toChat: "",
    attachmentIndex: 1,
    limit: 20,
    pages: 1,
    iterations: 1,
    intervalMs: 15_000,
    confirm: false,
    dryRun: false,
    approvalHash: "",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = () => {
      const next = argv[index + 1];
      if (!next || next.startsWith("--")) throw new Error(`${argument} requires a value.`);
      index += 1;
      return next;
    };
    if (!options.command && !argument.startsWith("--")) options.command = argument;
    else if (options.command === "policy" && !options.policyCommand && !argument.startsWith("--")) {
      options.policyCommand = argument;
    } else if (argument === "--company-id") options.companyId = value();
    else if (argument === "--member-id") options.memberId = value();
    else if (argument === "--connection-id") options.connectionId = value();
    else if (argument === "--company-allows-autonomous") options.companyAllowsAutonomous = true;
    else if (argument === "--no-company-allows-autonomous") options.companyAllowsAutonomous = false;
    else if (argument === "--send-mode") options.sendMode = value();
    else if (argument === "--chrome") options.chromeExecutable = path.resolve(value());
    else if (argument === "--headed") options.headed = true;
    else if (argument === "--headless") options.headed = false;
    else if (argument === "--hold-ms") options.holdMs = Number(value());
    else if (argument === "--timeout-ms") options.timeoutMs = Number(value());
    else if (argument === "--query") options.query = value();
    else if (argument === "--chat") options.chat = value();
    else if (argument === "--contact") options.contact = value();
    else if (argument === "--title") options.title = value();
    else if (argument === "--member") options.members.push(value());
    else if (argument === "--message") options.message = value();
    else if (argument === "--message-file") options.messageFile = path.resolve(value());
    else if (argument === "--file") options.files.push(path.resolve(value()));
    else if (argument === "--avatar") options.avatar = path.resolve(value());
    else if (argument === "--output") options.output = path.resolve(value());
    else if (argument === "--message-id") options.messageId = value();
    else if (argument === "--target-text") options.targetText = value();
    else if (argument === "--target-author") options.targetAuthor = value();
    else if (argument === "--reaction") options.reaction = value();
    else if (argument === "--to-chat") options.toChat = value();
    else if (argument === "--attachment-index") options.attachmentIndex = Number(value());
    else if (argument === "--limit") options.limit = Number(value());
    else if (argument === "--pages") options.pages = Number(value());
    else if (argument === "--iterations") options.iterations = Number(value());
    else if (argument === "--interval-ms") options.intervalMs = Number(value());
    else if (argument === "--confirm") options.confirm = true;
    else if (argument === "--dry-run") options.dryRun = true;
    else if (argument === "--approval-hash") options.approvalHash = value();
    else if (argument === "--help" || argument === "-h") options.command = "help";
    else throw new Error(`Unknown argument: ${argument}`);
  }

  if (!options.companyId || !options.memberId || !options.connectionId) {
    throw new Error("--company-id, --member-id and --connection-id are required.");
  }
  options.companyId = normalizeIdentityPart(options.companyId, "company-id");
  options.memberId = normalizeIdentityPart(options.memberId, "member-id");
  options.connectionId = normalizeIdentityPart(options.connectionId, "connection-id");
  if (!SUPPORTED_COMMANDS.has(options.command)) {
    throw new Error(`Unsupported MAX browser command: ${options.command || "(missing)"}`);
  }
  if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 100) {
    throw new Error("--limit must be an integer from 1 to 100.");
  }
  if (!Number.isInteger(options.pages) || options.pages < 1 || options.pages > MAX_HISTORY_PAGES) {
    throw new Error(`--pages must be an integer from 1 to ${MAX_HISTORY_PAGES}.`);
  }
  if (!Number.isInteger(options.attachmentIndex) || options.attachmentIndex < 1 || options.attachmentIndex > 100) {
    throw new Error("--attachment-index must be an integer from 1 to 100.");
  }
  if (!Number.isInteger(options.iterations) || options.iterations < 1 || options.iterations > MAX_WATCH_ITERATIONS) {
    throw new Error(`--iterations must be an integer from 1 to ${MAX_WATCH_ITERATIONS}.`);
  }
  if (!Number.isFinite(options.intervalMs) || options.intervalMs < 1_000 || options.intervalMs > MAX_WATCH_INTERVAL_MS) {
    throw new Error(`--interval-ms must be from 1000 to ${MAX_WATCH_INTERVAL_MS}.`);
  }
  if (options.files.length > MAX_FILES_PER_MESSAGE) {
    throw new Error(`One MAX message can contain at most ${MAX_FILES_PER_MESSAGE} --file values.`);
  }
  if (options.members.length > MAX_GROUP_MEMBERS_PER_OPERATION) {
    throw new Error(`One MAX operation can contain at most ${MAX_GROUP_MEMBERS_PER_OPERATION} --member values.`);
  }
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 5_000) {
    throw new Error("--timeout-ms must be at least 5000.");
  }
  return options;
};

const usage = () => `
Usage:
  trelio-max.mjs --company-id UUID --member-id UUID --connection-id UUID bootstrap
  trelio-max.mjs --company-id UUID --member-id UUID --connection-id UUID doctor
  trelio-max.mjs --company-id UUID --member-id UUID --connection-id UUID probe
  trelio-max.mjs --company-id UUID --member-id UUID --connection-id UUID policy show
  trelio-max.mjs --company-id UUID --member-id UUID --connection-id UUID policy set --send-mode autonomous
  trelio-max.mjs --company-id UUID --member-id UUID --connection-id UUID login
  trelio-max.mjs --company-id UUID --member-id UUID --connection-id UUID dialogs --query "Название"
  trelio-max.mjs --company-id UUID --member-id UUID --connection-id UUID contacts --query "Имя или @username"
  trelio-max.mjs --company-id UUID --member-id UUID --connection-id UUID read --chat "Название" --limit 20 --pages 2
  trelio-max.mjs --company-id UUID --member-id UUID --connection-id UUID unread --limit 10 --pages 1
  trelio-max.mjs --company-id UUID --member-id UUID --connection-id UUID watch --limit 10 --iterations 4 --interval-ms 15000
  trelio-max.mjs --company-id UUID --member-id UUID --connection-id UUID download --chat "Название" --message-id ID --attachment-index 1 --output PATH
  trelio-max.mjs --company-id UUID --member-id UUID --connection-id UUID send --chat "Название" --message "Текст" --file PATH --confirm
  trelio-max.mjs --company-id UUID --member-id UUID --connection-id UUID reply --chat "Название" --message-id ID --message "Текст" --confirm
  trelio-max.mjs --company-id UUID --member-id UUID --connection-id UUID react --chat "Название" --message-id ID --reaction "👍" --confirm
  trelio-max.mjs --company-id UUID --member-id UUID --connection-id UUID edit --chat "Название" --message-id ID --message "Новый текст" --dry-run
  trelio-max.mjs --company-id UUID --member-id UUID --connection-id UUID delete --chat "Название" --message-id ID --dry-run
  trelio-max.mjs --company-id UUID --member-id UUID --connection-id UUID forward --chat "Источник" --message-id ID --to-chat "Получатель" --dry-run
  trelio-max.mjs --company-id UUID --member-id UUID --connection-id UUID create-direct --contact "https://max.ru/u/name" --message "Текст" --dry-run
  trelio-max.mjs --company-id UUID --member-id UUID --connection-id UUID create-group --title "Название" --member "@one" --member "@two" --dry-run
  trelio-max.mjs --company-id UUID --member-id UUID --connection-id UUID members --chat "Название"
  trelio-max.mjs --company-id UUID --member-id UUID --connection-id UUID member-add --chat "Название" --member "@name" --dry-run
  trelio-max.mjs --company-id UUID --member-id UUID --connection-id UUID member-remove --chat "Название" --member "@name" --dry-run
  trelio-max.mjs --company-id UUID --member-id UUID --connection-id UUID chat-update --chat "Название" --title "Новое название" --dry-run

Structural commands: show the unchanged --dry-run output, then repeat the exact
command with --confirm --approval-hash HASH instead of --dry-run.
`.trim();

const connectionRoot = (options) => path.join(
  configHome(),
  "integrations",
  SKILL_ID,
  options.companyId,
  options.memberId,
  options.connectionId,
);

const policyPath = (options) => path.join(connectionRoot(options), "config", "policy.json");
const profilePath = (options) => path.join(connectionRoot(options), "state", "chrome-profile");
const downloadsPath = (options) => path.join(
  cacheHome(),
  "integrations",
  SKILL_ID,
  options.companyId,
  options.memberId,
  options.connectionId,
  "downloads",
);

const loadPolicy = (options) => {
  const file = policyPath(options);
  if (!fs.existsSync(file)) return { sendMode: "confirm" };
  ensurePrivateFile(file);
  const value = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!POLICY_MODES.has(value.sendMode)) {
    throw new Error(`Local policy ${file} has an unsupported sendMode.`);
  }
  return { sendMode: value.sendMode };
};

const assertSendAllowed = (options) => {
  const { sendMode } = loadPolicy(options);
  if (sendMode === "read-only") throw new Error("Local MAX policy is read-only; sending is disabled.");
  if (sendMode === "autonomous" && !options.companyAllowsAutonomous) {
    throw new Error("The company connection forbids autonomous MAX sending.");
  }
  if (sendMode === "confirm" && !options.confirm) {
    throw new Error("MAX send requires --confirm in local confirm mode.");
  }
  return sendMode;
};

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

const sha256File = (file) => {
  const digest = createHash("sha256");
  const descriptor = fs.openSync(file, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    while (true) {
      const bytesRead = fs.readSync(descriptor, buffer, 0, buffer.byteLength, null);
      if (bytesRead === 0) break;
      digest.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    fs.closeSync(descriptor);
  }
  return digest.digest("hex");
};

const fileApprovalDescriptor = (file) => {
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    throw new Error(`MAX local file was not found: ${file}`);
  }
  const stat = fs.statSync(file);
  return {
    path: file,
    name: path.basename(file),
    sizeBytes: stat.size,
    sha256: sha256File(file),
  };
};

const ensureOutputParentDirectory = (directory) => {
  if (fs.existsSync(directory)) {
    if (!fs.statSync(directory).isDirectory()) throw new Error(`Download parent is not a directory: ${directory}`);
    return;
  }
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
};

const outgoingMessage = (options) => {
  if (options.messageFile) {
    ensurePrivateFile(options.messageFile);
    return fs.readFileSync(options.messageFile, "utf8");
  }
  return options.message;
};

const requireMessageTarget = (options) => {
  if (!options.messageId && !options.targetText) {
    throw new Error(`${options.command} requires --message-id or --target-text.`);
  }
};

const normalizeUniqueMembers = (members) => {
  const result = [];
  const seen = new Set();
  for (const member of members) {
    const normalized = String(member || "").normalize("NFKC").replace(/\s+/gu, " ").trim();
    if (!normalized) throw new Error("--member cannot be empty.");
    const identity = normalized.toLocaleLowerCase("ru-RU");
    if (seen.has(identity)) throw new Error(`Duplicate MAX member reference: ${normalized}`);
    seen.add(identity);
    result.push(normalized);
  }
  return result;
};

const validateCommandOptions = (options) => {
  const message = outgoingMessage(options);
  options.members = normalizeUniqueMembers(options.members);
  if (options.title) options.title = options.title.normalize("NFKC").replace(/\s+/gu, " ").trim();

  if (["dialogs", "contacts"].includes(options.command) && !options.query) {
    throw new Error(`${options.command} requires --query.`);
  }
  if ([
    "chat-update",
    "delete",
    "download",
    "edit",
    "forward",
    "member-add",
    "member-remove",
    "members",
    "react",
    "read",
    "reply",
    "send",
  ].includes(options.command) && !options.chat) {
    throw new Error(`${options.command} requires --chat.`);
  }
  if (["delete", "download", "edit", "forward", "react", "reply"].includes(options.command)) {
    requireMessageTarget(options);
  }
  if (["send", "reply", "create-direct"].includes(options.command) && !message && options.files.length === 0) {
    throw new Error(`${options.command} requires --message, --message-file or at least one --file.`);
  }
  if (options.command === "edit" && !message) throw new Error("edit requires --message or --message-file.");
  if (options.command === "react" && !options.reaction) throw new Error("react requires --reaction.");
  if (options.command === "forward" && !options.toChat) throw new Error("forward requires --to-chat.");
  if (options.command === "download" && !options.output) throw new Error("download requires --output.");
  if (options.command === "create-direct") {
    if (!options.contact) throw new Error("create-direct requires --contact.");
    const contactUrl = normalizeChatUrl(options.contact);
    if (!/\/u\/[A-Za-z0-9_-]+\/?$/u.test(new URL(contactUrl).pathname)) {
      throw new Error("create-direct requires an official MAX /u/ contact URL.");
    }
    options.contact = contactUrl;
  }
  if (options.command === "create-group") {
    const title = options.title.normalize("NFKC").replace(/\s+/gu, " ").trim();
    if (!title || title.length > 255) throw new Error("create-group requires --title from 1 to 255 characters.");
    if (options.members.length === 0) throw new Error("create-group requires at least one --member.");
    options.title = title;
  }
  if (["member-add", "member-remove"].includes(options.command) && options.members.length === 0) {
    throw new Error(`${options.command} requires at least one --member.`);
  }
  if (options.command === "chat-update" && !options.title && !options.avatar) {
    throw new Error("chat-update requires --title or --avatar.");
  }
  if (options.title && options.title.length > 255) throw new Error("--title cannot exceed 255 characters.");

  options.files.forEach(fileApprovalDescriptor);
  if (options.avatar) fileApprovalDescriptor(options.avatar);
  return { message };
};

const mutationApprovalPayload = (options) => {
  const { message } = validateCommandOptions(options);
  return {
    command: options.command,
    chat: options.chat || null,
    contact: options.contact || null,
    title: options.title || null,
    members: options.members,
    message: message || null,
    files: options.files.map(fileApprovalDescriptor),
    avatar: options.avatar ? fileApprovalDescriptor(options.avatar) : null,
    messageId: options.messageId || null,
    targetText: options.targetText || null,
    targetAuthor: options.targetAuthor || null,
    reaction: options.reaction || null,
    toChat: options.toChat || null,
  };
};

const buildMutationPreview = (options) => {
  if (!MUTATING_COMMANDS.has(options.command)) {
    throw new Error(`Command ${options.command} does not support --dry-run.`);
  }
  const payload = mutationApprovalPayload(options);
  return {
    dryRun: true,
    operation: payload,
    approvalHash: sha256(JSON.stringify(payload)),
    confirmationRequired: STRUCTURAL_CONFIRMATION_COMMANDS.has(options.command)
      || loadPolicy(options).sendMode === "confirm",
  };
};

const assertMutationAllowed = (options) => {
  const policyMode = assertSendAllowed(options);
  if (!STRUCTURAL_CONFIRMATION_COMMANDS.has(options.command)) return policyMode;
  if (!options.confirm) {
    throw new Error(`MAX ${options.command} always requires --confirm, including autonomous mode.`);
  }
  const expected = buildMutationPreview(options).approvalHash;
  if (!options.approvalHash || options.approvalHash !== expected) {
    throw new Error(
      `MAX ${options.command} requires the exact --approval-hash returned by an unchanged --dry-run.`,
    );
  }
  return policyMode;
};

const frameBytes = (frame) => Buffer.isBuffer(frame) ? frame : Buffer.from(String(frame), "utf8");

const passiveReadFrameMarker = (frame) => {
  const bytes = frameBytes(frame);
  return PASSIVE_READ_PROTOCOL_MARKERS.find((marker) => bytes.includes(Buffer.from(marker, "utf8"))) || null;
};

const shouldBlockPassiveReadFrame = (frame) => Boolean(passiveReadFrameMarker(frame));

const installPassiveReadGuard = async (context) => {
  if (typeof context.routeWebSocket !== "function") {
    throw new Error(
      "MAX passive reading requires Playwright WebSocket routing. Run bootstrap with the current runtime release.",
    );
  }
  const state = {
    allowReadReceipts: false,
    blockedFrames: 0,
    blockedByType: Object.fromEntries(PASSIVE_READ_PROTOCOL_MARKERS.map((marker) => [marker, 0])),
    forwardedReadFrames: 0,
  };

  // MAX optimistically updates unread counters in the DOM before its binary
  // WebSocket request reaches the server. Intercepting the protocol frame is
  // therefore the only reliable way to keep the server-side read mark and the
  // sender-visible receipt unchanged while the agent inspects a chat. Merely
  // clicking "mark unread" afterwards would not undo an already-sent receipt.
  await context.routeWebSocket(/.*/u, (client) => {
    const server = client.connectToServer();
    client.onMessage((message) => {
      const marker = passiveReadFrameMarker(message);
      if (marker && !state.allowReadReceipts) {
        state.blockedFrames += 1;
        state.blockedByType[marker] += 1;
        return;
      }
      if (marker) state.forwardedReadFrames += 1;
      server.send(message);
    });
  });
  return state;
};

const withProfileLock = async (options, callback) => {
  const lock = path.join(connectionRoot(options), "locks", "browser.lock");
  ensurePrivateDirectory(path.dirname(lock));
  try {
    fs.mkdirSync(lock, { mode: 0o700 });
    fs.writeFileSync(path.join(lock, "pid"), String(process.pid), { mode: 0o600 });
  } catch (error) {
    const pidFile = path.join(lock, "pid");
    const pid = Number(fs.existsSync(pidFile) ? fs.readFileSync(pidFile, "utf8") : 0);
    let alive = false;
    if (Number.isInteger(pid) && pid > 0) {
      try {
        process.kill(pid, 0);
        alive = true;
      } catch {
        alive = false;
      }
    }
    if (alive) throw new Error("This MAX profile is already used by another process.");
    fs.rmSync(lock, { recursive: true, force: true });
    fs.mkdirSync(lock, { mode: 0o700 });
    fs.writeFileSync(path.join(lock, "pid"), String(process.pid), { mode: 0o600 });
  }
  try {
    return await callback();
  } finally {
    fs.rmSync(lock, { recursive: true, force: true });
  }
};

const bootstrap = () => {
  const root = runtimeRoot();
  ensurePrivateDirectory(root);
  const packageFile = path.join(root, "package.json");
  if (!fs.existsSync(packageFile)) {
    writePrivateJson(packageFile, { private: true, dependencies: {} });
  }
  const result = spawnSync(
    process.platform === "win32" ? "npm.cmd" : "npm",
    ["install", "--prefix", root, "--no-audit", "--no-fund", "playwright-core@1.60.0"],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || "npm failed").trim().split("\n").at(-1);
    throw new Error(`Cannot install MAX browser runtime: ${detail}`);
  }
  return { runtimeReady: true, runtimeRoot: root };
};

const loadPlaywright = () => {
  try {
    const resolved = require.resolve("playwright-core", { paths: [runtimeRoot()] });
    return require(resolved);
  } catch (error) {
    throw new Error(`MAX browser runtime is unavailable. Run bootstrap first. ${error.message}`);
  }
};

const bodyText = (page) => page.evaluate(() => document.body?.innerText || "");

const assertLoggedIn = async (page) => {
  const text = (await bodyText(page)).toLowerCase();
  const loginLike = ["qr", "код", "телефон", "войти", "login"].some((needle) => text.includes(needle));
  const messengerLike = ["чат", "сообщ", "поиск"].some((needle) => text.includes(needle));
  if (loginLike && !messengerLike) {
    throw new Error("MAX login is required. Run login and let the user finish it in the visible window.");
  }
};

const waitForVisibleMaxUi = async (page, timeoutMs) => {
  const boundedTimeoutMs = Math.min(timeoutMs, MAX_UI_READY_TIMEOUT_MS);
  return page.waitForFunction(() => {
    const visible = (element) => {
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return rect.width >= 1
        && rect.height >= 1
        && style.display !== "none"
        && style.visibility !== "hidden";
    };
    // MAX is a client-rendered application. `domcontentloaded` may fire while
    // the persistent profile still shows an empty shell, so browser commands
    // must wait for a visible interactive surface before probing selectors.
    return Array.from(document.querySelectorAll(
      'input:not([type="hidden"]), textarea, [contenteditable="true"], button, [role="button"]',
    )).some(visible);
  }, null, { timeout: boundedTimeoutMs }).then(() => true).catch(() => false);
};

const openHome = async (page, options, allowLogin = false) => {
  await page.goto(MAX_WEB_URL, { waitUntil: "domcontentloaded", timeout: options.timeoutMs });
  let uiReady = await waitForVisibleMaxUi(page, options.timeoutMs);
  if (!uiReady) {
    // A copied or long-idle persistent profile can occasionally restore a
    // blank SPA shell on the first navigation. One controlled reload recovers
    // that state without weakening selector checks or repeating a user action.
    await page.reload({ waitUntil: "domcontentloaded", timeout: options.timeoutMs });
    uiReady = await waitForVisibleMaxUi(page, options.timeoutMs);
  }
  if (!uiReady && !allowLogin) {
    throw new Error(
      "MAX home rendered no visible interactive UI after one controlled reload. The runtime failed closed.",
    );
  }
  if (!allowLogin) await assertLoggedIn(page);
  return { uiReady };
};

const findSearchInput = async (page, timeoutMs) => {
  const candidates = [
    page.getByPlaceholder(/найти|поиск|find|search/iu).first(),
    page.getByRole("textbox", { name: /найти|поиск|find|search/iu }).first(),
    page.locator(
      'input[type="search"], input[placeholder*="найти" i], input[placeholder*="поиск" i], input[placeholder*="find" i], input[placeholder*="search" i]',
    ).first(),
  ];
  for (const candidate of candidates) {
    try {
      if (await candidate.count() && await candidate.isVisible({ timeout: 1_000 })) {
        await candidate.click({ timeout: timeoutMs });
        return candidate;
      }
    } catch {
      // MAX changes generated class names frequently; try an accessible fallback.
    }
  }

  // Last-resort semantic fallback: on the authenticated MAX home screen the
  // dialog search is normally the only visible input in the upper-left chat
  // pane. Geometry keeps this fallback away from the message composer.
  const visibleInputs = page.locator('input:not([type="hidden"])');
  const fallbackCandidates = [];
  for (let index = 0; index < await visibleInputs.count(); index += 1) {
    const candidate = visibleInputs.nth(index);
    if (!await candidate.isVisible().catch(() => false)) continue;
    const box = await candidate.boundingBox();
    if (!box || box.x > 600 || box.y > 400 || box.width < 80 || box.height < 20) continue;
    fallbackCandidates.push(candidate);
  }
  if (fallbackCandidates.length === 1) {
    await fallbackCandidates[0].click({ timeout: timeoutMs });
    return fallbackCandidates[0];
  }

  throw new Error(
    "Could not safely identify the MAX dialog search field. The runtime failed closed; inspect the current UI and publish a compatible plugin update before retrying.",
  );
};

const fillLocator = async (locator, value, page) => {
  try {
    await locator.fill(value);
  } catch {
    await locator.click();
    await page.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A");
    await page.keyboard.type(value);
  }
};

const normalizeDialogTitle = (value) => String(value || "")
  .normalize("NFKC")
  .replace(/\s+/gu, " ")
  .trim()
  .toLocaleLowerCase("ru-RU");

const selectExactDialogResult = (results, reference) => {
  const expected = normalizeDialogTitle(reference);
  const exactMatches = results.filter((result) => normalizeDialogTitle(result.title) === expected);
  if (exactMatches.length === 1) return exactMatches[0];
  if (exactMatches.length > 1) {
    throw new Error(
      `Ambiguous exact MAX dialog title: ${reference}. Use an official chat URL.`,
    );
  }

  const visibleCandidates = results
    .slice(0, 5)
    .map((result) => `"${result.title}"`)
    .join(", ");
  throw new Error(
    visibleCandidates
      ? `No exact visible MAX dialog matched: ${reference}. Visible partial matches: ${visibleCandidates}. Use the exact title or an official chat URL.`
      : `No exact visible MAX dialog matched: ${reference}. Use the exact title or an official chat URL.`,
  );
};

const collectDialogResults = (page, query = "", unreadOnly = false) => page.evaluate(({ needle, onlyUnread }) => {
  document.querySelectorAll("[data-trelio-max-dialog]").forEach((node) => {
    node.removeAttribute("data-trelio-max-dialog");
  });
  const normalized = String(needle || "").normalize("NFKC").toLowerCase().trim();
  const nodes = Array.from(document.querySelectorAll('a, button, [role="button"], [role="option"], [role="listitem"]'));
  const results = [];
  for (const node of nodes) {
    const visibleLines = String(node.innerText || "")
      .split(/\n+/u)
      .map((line) => line.replace(/\s+/gu, " ").trim())
      .filter(Boolean);
    const text = visibleLines.join(" ");
    // MAX search can return several messages from one dialog. De-duplicate by
    // its canonical link when available, while preserving different chats or
    // contacts that happen to use the same visible title.
    const titleNode = node.querySelector(
      '[class*="title" i] [class*="name" i], [class*="title" i]',
    );
    const title = (
      titleNode?.textContent
      || visibleLines.find((line) => line.length <= 160)
      || ""
    ).replace(/\s+/gu, " ").trim();
    const rect = node.getBoundingClientRect();
    const style = window.getComputedStyle(node);
    const link = node.matches("a[href]") ? node : node.closest("a[href]") || node.querySelector("a[href]");
    let url = null;
    try {
      const candidate = link?.getAttribute("href") || "";
      const parsed = candidate ? new URL(candidate, window.location.origin) : null;
      const canonicalPath = parsed
        && (/^\/\d+\/?$/u.test(parsed.pathname) || /^\/u\/[A-Za-z0-9_-]+\/?$/u.test(parsed.pathname));
      if (
        parsed
        && canonicalPath
        && !parsed.search
        && !parsed.hash
        && ["https://web.max.ru", "https://max.ru"].includes(parsed.origin)
      ) {
        parsed.protocol = "https:";
        parsed.host = "web.max.ru";
        url = parsed.toString();
      }
    } catch {
      url = null;
    }
    const unreadNode = node.querySelector(
      '[class*="unread" i], [class*="badge" i], [aria-label*="непрочитан" i], [aria-label*="unread" i]',
    );
    const unreadLabel = [
      unreadNode?.getAttribute("aria-label"),
      unreadNode?.textContent,
      node.getAttribute("aria-label"),
    ].filter(Boolean).join(" ");
    const unreadMatch = unreadLabel.match(/\b(\d{1,6})\b/u);
    const isUnread = /unread/iu.test(String(unreadNode?.className || ""))
      || /непрочитан|unread/iu.test(unreadLabel)
      || Boolean(unreadMatch)
      || /new messages|нов(?:ое|ых) сообщ/iu.test(text);
    const unreadCount = unreadMatch ? Number(unreadMatch[1]) : isUnread ? 1 : 0;
    if (!text || !title || text.length > 500 || (normalized && !title.toLowerCase().includes(normalized))) continue;
    if (onlyUnread && !isUnread) continue;
    if (rect.width < 20 || rect.height < 10 || style.display === "none" || style.visibility === "hidden") continue;
    const identity = (url || title).toLocaleLowerCase("ru-RU");
    if (results.some((item) => item.identity === identity)) continue;
    node.setAttribute("data-trelio-max-dialog", String(results.length));
    results.push({
      index: results.length,
      identity,
      title,
      text,
      url,
      stableId: url?.match(/\/(?:u\/)?([A-Za-z0-9_-]+)\/?$/u)?.[1] || null,
      isUnread,
      unreadCount,
    });
    if (results.length >= 100) break;
  }
  return results;
}, { needle: query, onlyUnread: unreadOnly });

const normalizeChatUrl = (reference) => {
  const url = new URL(reference, MAX_WEB_URL);
  const numeric = /^\/\d+\/?$/u.test(url.pathname);
  const contact = /^\/u\/[A-Za-z0-9_-]+\/?$/u.test(url.pathname);
  if (![MAX_WEB_ORIGIN, "https://max.ru"].includes(url.origin) || (!numeric && !contact) || url.search || url.hash) {
    throw new Error("MAX chat URL must be an official numeric or /u/ contact URL.");
  }
  url.protocol = "https:";
  url.host = "web.max.ru";
  return url.toString();
};

const openChat = async (page, options) => {
  if (/^https?:\/\//iu.test(options.chat) || /^\d+$/u.test(options.chat)) {
    await page.goto(normalizeChatUrl(options.chat), {
      waitUntil: "domcontentloaded",
      timeout: options.timeoutMs,
    });
    await page.waitForTimeout(2_500);
    await assertLoggedIn(page);
    return { method: "url", url: page.url() };
  }
  await openHome(page, options);
  const search = await findSearchInput(page, options.timeoutMs);
  await fillLocator(search, options.chat, page);
  await page.waitForTimeout(1_800);
  const results = await collectDialogResults(page, options.chat);
  // Search results are intentionally substring-based for discovery, but an
  // action must select one exact normalized title. A single partial result is
  // still unsafe: it may be a different person or organization with a longer
  // name, as in "ООО Вкус" versus "ООО Вкус моря".
  const selected = selectExactDialogResult(results, options.chat);
  await page.locator(`[data-trelio-max-dialog="${selected.index}"]`).click({ timeout: options.timeoutMs });
  await page.waitForTimeout(2_000);
  const openedUrl = page.url();
  const chatUrlOpened = openedUrl !== MAX_WEB_URL && openedUrl !== MAX_WEB_ORIGIN;
  const messageSurfaceVisible = (await visibleMessages(page, 1)).length > 0;
  const composerVisible = await findComposer(page).then(() => true).catch(() => false);
  if (!chatUrlOpened && !messageSurfaceVisible && !composerVisible) {
    throw new Error(
      "MAX dialog click had no verifiable effect. The runtime failed closed; do not send or retry automatically.",
    );
  }
  return { method: "search", matched: selected.title, url: openedUrl };
};

const loadHistoryPages = async (page, pages, timeoutMs) => {
  let loadedPages = 1;
  for (let pageIndex = 1; pageIndex < pages; pageIndex += 1) {
    const scrolled = await page.evaluate(() => {
      const message = Array.from(document.querySelectorAll(
        '[data-message-id], [data-testid*="message" i], [class*="message" i], [aria-label*="сообщ" i], [aria-label*="message" i]',
      )).find((node) => node instanceof HTMLElement && (node.innerText || node.textContent || "").trim());
      if (!(message instanceof HTMLElement)) return false;
      let container = message.parentElement;
      while (container && container !== document.body) {
        const style = window.getComputedStyle(container);
        if (container.scrollHeight > container.clientHeight + 40 && /auto|scroll/u.test(style.overflowY)) {
          const before = container.scrollHeight;
          container.scrollTop = 0;
          container.dispatchEvent(new Event("scroll", { bubbles: true }));
          container.setAttribute("data-trelio-max-history-height", String(before));
          return true;
        }
        container = container.parentElement;
      }
      return false;
    });
    if (!scrolled) break;
    await page.waitForTimeout(Math.min(2_000, Math.max(600, Math.round(timeoutMs / 30))));
    const grew = await page.evaluate(() => {
      const container = document.querySelector('[data-trelio-max-history-height]');
      if (!(container instanceof HTMLElement)) return false;
      const previous = Number(container.getAttribute("data-trelio-max-history-height") || 0);
      container.removeAttribute("data-trelio-max-history-height");
      return container.scrollHeight > previous;
    });
    loadedPages += 1;
    if (!grew) break;
  }
  return loadedPages;
};

const visibleMessages = async (page, limit) => {
  const rawMessages = await page.evaluate((maxCount) => {
  document.querySelectorAll("[data-trelio-max-message]").forEach((node) => {
    node.removeAttribute("data-trelio-max-message");
  });
  const nodes = Array.from(document.querySelectorAll(
    '[data-message-id], [data-testid*="message" i], [class*="message" i], [aria-label*="сообщ" i], [aria-label*="message" i]',
  ));
  const results = [];
  const seen = new Set();
  for (const node of nodes) {
    if (!(node instanceof HTMLElement)) continue;
    const rect = node.getBoundingClientRect();
    const style = window.getComputedStyle(node);
    const text = (node.innerText || node.textContent || "").replace(/\s+/gu, " ").trim();
    if (!text || text.length > 8_000 || rect.width < 40 || rect.height < 12) continue;
    if (style.display === "none" || style.visibility === "hidden") continue;
    if (window.innerWidth >= 900 && rect.right < window.innerWidth * 0.28) continue;
    const providerMessageId = [
      node.getAttribute("data-message-id"),
      node.getAttribute("data-id"),
      node.id?.match(/(?:message|msg)[-_:]?([A-Za-z0-9_-]+)/iu)?.[1],
      node.querySelector("[data-message-id]")?.getAttribute("data-message-id"),
    ].find(Boolean) || null;
    const authorNode = node.querySelector(
      '[data-testid*="author" i], [data-testid*="sender" i], [class*="author" i], [class*="sender" i], [class*="name" i]',
    );
    const timeNode = node.querySelector('time, [class*="time" i], [data-testid*="time" i]');
    const replyNode = node.querySelector(
      '[class*="reply" i], [data-testid*="reply" i], [aria-label*="ответ" i], [aria-label*="reply" i]',
    );
    const attachments = Array.from(node.querySelectorAll(
      'a[download], [aria-label*="скач" i], [aria-label*="download" i], [class*="attachment" i], [class*="file" i], img, video, audio',
    )).slice(0, 20).map((attachment, index) => ({
      index: index + 1,
      name: attachment.getAttribute("download")
        || attachment.getAttribute("aria-label")
        || attachment.getAttribute("alt")
        || attachment.getAttribute("title")
        || attachment.textContent?.replace(/\s+/gu, " ").trim()
        || null,
      href: attachment instanceof HTMLAnchorElement ? attachment.href : null,
      kind: attachment.tagName.toLowerCase(),
    }));
    const author = authorNode?.textContent?.replace(/\s+/gu, " ").trim() || null;
    const timestamp = timeNode?.getAttribute("datetime")
      || timeNode?.getAttribute("title")
      || timeNode?.textContent?.replace(/\s+/gu, " ").trim()
      || null;
    const isOutgoing = node.matches('[data-outgoing="true"], [data-is-out="true"]')
      || /(?:^|\s)(?:outgoing|message-out|is-out|viewer)(?:\s|$)/iu.test(node.className || "")
      || /вы:|you:/iu.test(author || "");
    const identity = providerMessageId || `${author || ""}\u0000${timestamp || ""}\u0000${text}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    node.setAttribute("data-trelio-max-message", String(results.length));
    results.push({
      index: results.length,
      providerMessageId,
      author,
      timestamp,
      text,
      isOutgoing,
      replyText: replyNode?.textContent?.replace(/\s+/gu, " ").trim() || null,
      attachments,
    });
  }
  return results.slice(-maxCount);
  }, limit);
  return rawMessages.map((message) => ({
    ...message,
    messageKey: sha256(JSON.stringify({
      providerMessageId: message.providerMessageId,
      author: message.author,
      timestamp: message.timestamp,
      text: message.text,
    })),
  }));
};

const findMessageTarget = async (page, options, { outgoingOnly = false } = {}) => {
  const messages = await visibleMessages(page, 100);
  const normalizedTargetText = options.targetText
    ? options.targetText.normalize("NFKC").replace(/\s+/gu, " ").trim()
    : null;
  const normalizedTargetAuthor = options.targetAuthor
    ? options.targetAuthor.normalize("NFKC").replace(/\s+/gu, " ").trim().toLocaleLowerCase("ru-RU")
    : null;
  const matches = messages.filter((message) => {
    if (options.messageId && message.providerMessageId !== options.messageId) return false;
    if (normalizedTargetText && message.text !== normalizedTargetText) return false;
    if (
      normalizedTargetAuthor
      && String(message.author || "").toLocaleLowerCase("ru-RU") !== normalizedTargetAuthor
    ) return false;
    if (outgoingOnly && !message.isOutgoing) return false;
    return true;
  });
  if (matches.length !== 1) {
    const reason = matches.length === 0 ? "No" : "Several";
    throw new Error(
      `${reason} exact MAX messages matched the requested target. Use a provider --message-id or add exact --target-text and --target-author.`,
    );
  }
  const target = page.locator(`[data-trelio-max-message="${matches[0].index}"]`);
  if (await target.count() !== 1) {
    throw new Error("The exact MAX message disappeared before the action. Read the chat again and retry once.");
  }
  return { locator: target, message: matches[0] };
};

const clickVisibleAction = async (page, label, timeoutMs, { exact = false } = {}) => {
  const candidates = [
    page.getByRole("button", { name: label, exact }).last(),
    page.getByRole("menuitem", { name: label, exact }).last(),
    page.getByText(label, { exact }).last(),
  ];
  for (const candidate of candidates) {
    try {
      if (await candidate.count() && await candidate.isVisible({ timeout: 700 })) {
        await candidate.click({ timeout: timeoutMs });
        return;
      }
    } catch {
      // Try the next accessible representation of the same exact action.
    }
  }
  throw new Error(`Could not safely identify the MAX action: ${label}`);
};

const confirmVisibleDialogAction = async (page, label, timeoutMs) => {
  const dialogs = page.getByRole("dialog");
  for (let index = (await dialogs.count()) - 1; index >= 0; index -= 1) {
    const dialog = dialogs.nth(index);
    if (!await dialog.isVisible({ timeout: 500 }).catch(() => false)) continue;
    const button = dialog.getByRole("button", { name: label }).last();
    if (!await button.count() || !await button.isVisible({ timeout: 500 }).catch(() => false)) {
      throw new Error(`MAX confirmation dialog did not expose the expected action: ${label}`);
    }
    await button.click({ timeout: timeoutMs });
    return true;
  }
  return false;
};

const openMessageActionMenu = async (page, target, timeoutMs) => {
  await target.hover({ timeout: timeoutMs });
  const menuButtons = [
    target.getByRole("button", { name: /ещ[её]|more|действ|меню/iu }).last(),
    target.locator('[aria-label*="ещ" i], [aria-label*="more" i], [title*="ещ" i], [title*="more" i]').last(),
  ];
  for (const button of menuButtons) {
    try {
      if (await button.count() && await button.isVisible({ timeout: 700 })) {
        await button.click({ timeout: timeoutMs });
        return "button";
      }
    } catch {
      // A right-click remains an intentional semantic fallback for messages.
    }
  }
  await target.click({ button: "right", timeout: timeoutMs });
  return "context-menu";
};

const findPickerSearchInput = async (page, timeoutMs) => {
  const candidates = [
    page.getByPlaceholder(/найти|поиск|find|search/iu).last(),
    page.getByRole("textbox", { name: /найти|поиск|find|search/iu }).last(),
    page.locator('input[type="search"], input[placeholder*="найти" i], input[placeholder*="поиск" i]').last(),
  ];
  for (const candidate of candidates) {
    try {
      if (await candidate.count() && await candidate.isVisible({ timeout: 700 })) return candidate;
    } catch {
      // Continue to the next accessible picker input.
    }
  }
  throw new Error("Could not safely identify the MAX participant/chat picker search field.");
};

const normalizeContactReference = (value) => String(value || "")
  .normalize("NFKC")
  .replace(/^https:\/\/(?:web\.)?max\.ru\/u\//iu, "")
  .replace(/^@/u, "")
  .replace(/\/$/u, "")
  .replace(/\s+/gu, " ")
  .trim()
  .toLocaleLowerCase("ru-RU");

const selectExactContactResult = (results, reference) => {
  const expected = normalizeContactReference(reference);
  const matches = results.filter((result) => {
    const stableId = normalizeContactReference(result.stableId);
    const title = normalizeContactReference(result.title);
    const textTokens = String(result.text || "")
      .split(/\s+/u)
      .map(normalizeContactReference);
    return stableId === expected || title === expected || textTokens.includes(expected);
  });
  if (matches.length !== 1) {
    const reason = matches.length === 0 ? "No" : "Several";
    throw new Error(
      `${reason} exact MAX contacts matched ${reference}. Use the official /u/ profile URL or exact @username.`,
    );
  }
  return matches[0];
};

const chooseExactPickerEntry = async (page, reference, timeoutMs) => {
  const input = await findPickerSearchInput(page, timeoutMs);
  await fillLocator(input, normalizeContactReference(reference), page);
  await page.waitForTimeout(1_200);
  const results = await collectDialogResults(page, normalizeContactReference(reference));
  const selected = selectExactContactResult(results, reference);
  await page.locator(`[data-trelio-max-dialog="${selected.index}"]`).click({ timeout: timeoutMs });
  return selected;
};

const findComposer = async (page) => {
  const locators = [
    page.locator('textarea').last(),
    page.locator('[contenteditable="true"]').last(),
    page.getByRole("textbox").last(),
  ];
  for (const locator of locators) {
    try {
      if (await locator.count() && await locator.isVisible({ timeout: 1_000 })) return locator;
    } catch {
      // Try the next accessible composer.
    }
  }

  // Generated classes and accessibility metadata may change independently.
  // A composer is still expected to be a sizeable editable element in the
  // lower-right chat pane, unlike the dialog search in the upper-left pane.
  const viewport = page.viewportSize() || { width: 1280, height: 900 };
  const editable = page.locator(
    'textarea, [contenteditable="true"], [role="textbox"], input:not([type="hidden"])',
  );
  const geometricCandidates = [];
  for (let index = 0; index < await editable.count(); index += 1) {
    const candidate = editable.nth(index);
    if (!await candidate.isVisible().catch(() => false)) continue;
    const box = await candidate.boundingBox();
    if (!box) continue;
    if (
      box.x < Math.min(300, viewport.width * 0.28)
      || box.y < viewport.height * 0.5
      || box.width < 120
      || box.height < 20
    ) {
      continue;
    }
    geometricCandidates.push({ candidate, box });
  }
  geometricCandidates.sort((left, right) => (
    (right.box.y + right.box.height) - (left.box.y + left.box.height)
    || right.box.x - left.box.x
  ));
  if (geometricCandidates.length > 0) return geometricCandidates[0].candidate;

  throw new Error(
    "Could not safely identify a visible MAX message composer. The runtime failed closed; inspect the current UI and publish a compatible plugin update before retrying.",
  );
};

const uploadFiles = async (page, files, timeoutMs) => {
  if (files.length === 0) return;
  const inputs = page.locator('input[type="file"]');
  if (await inputs.count()) {
    await inputs.last().setInputFiles(files, { timeout: timeoutMs });
    return;
  }
  const button = page.getByRole("button", { name: /загрузить|прикрепить|attach|файл/iu }).last();
  const chooserPromise = page.waitForEvent("filechooser", { timeout: timeoutMs });
  await button.click({ timeout: timeoutMs });
  const chooser = await chooserPromise;
  await chooser.setFiles(files);
};

const sendCurrentComposer = async (page, timeoutMs, hasText) => {
  const button = page.getByRole("button", { name: /отправить|send/iu }).last();
  try {
    if (await button.count() && await button.isVisible({ timeout: 1_000 })) {
      await button.click({ timeout: timeoutMs });
      return "button";
    }
  } catch {
    // Text-only chats usually support Enter as the stable fallback.
  }
  if (!hasText) throw new Error("Could not find the MAX send button for the attachment.");
  await page.keyboard.press("Enter");
  return "enter";
};

const composerText = async (composer) => composer.evaluate((element) => {
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
    return element.value;
  }
  return element.textContent || "";
});

const verifyTextSend = async (page, composer, message, timeoutMs) => {
  const exactMessage = page.getByText(message, { exact: true }).last();
  await exactMessage.waitFor({
    state: "visible",
    timeout: Math.min(timeoutMs, 15_000),
  }).catch(() => {
    throw new Error(
      "MAX send result is ambiguous: the exact outgoing text did not appear in the open chat. Do not retry automatically.",
    );
  });
  const remainingDraft = (await composerText(composer)).trim();
  if (remainingDraft) {
    throw new Error(
      "MAX send result is ambiguous: the composer still contains text. Do not retry automatically.",
    );
  }
  return "exact-text-visible-and-composer-cleared";
};

const verifyAttachmentSend = async (page, files, timeoutMs) => {
  if (files.length === 0) return [];
  const verified = [];
  for (const file of files) {
    const filename = path.basename(file);
    await page.getByText(filename, { exact: true }).last().waitFor({
      state: "visible",
      timeout: Math.min(timeoutMs, 15_000),
    }).catch(() => {
      throw new Error(
        `MAX send result is ambiguous: attachment ${filename} did not appear in the open chat. Do not retry automatically.`,
      );
    });
    verified.push(filename);
  }
  return verified;
};

const withBrowser = async (options, callback) => withProfileLock(options, async () => {
  const { chromium } = loadPlaywright();
  ensurePrivateDirectory(profilePath(options));
  ensurePrivateDirectory(downloadsPath(options));
  if (!fs.existsSync(options.chromeExecutable)) {
    throw new Error(`Chrome or Chromium executable was not found: ${options.chromeExecutable}`);
  }
  const context = await chromium.launchPersistentContext(profilePath(options), {
    executablePath: options.chromeExecutable,
    headless: !options.headed,
    viewport: { width: 1280, height: 900 },
    acceptDownloads: true,
    downloadsPath: downloadsPath(options),
    args: [
      "--no-first-run",
      "--disable-session-crashed-bubble",
      "--disable-blink-features=AutomationControlled",
    ],
  });
  try {
    // Install the guard before the first intentional navigation. All commands,
    // including probes and dialog discovery, default to passive mode. Only a
    // successfully verified send/reply temporarily allows read receipts.
    const readGuard = await installPassiveReadGuard(context);
    const page = context.pages()[0] || await context.newPage();
    return await callback(page, readGuard);
  } finally {
    await context.close();
  }
});

const safeUiFingerprint = async (page) => page.evaluate(() => {
  const visible = (element) => {
    const rect = element.getBoundingClientRect();
    const style = window.getComputedStyle(element);
    return rect.width >= 1
      && rect.height >= 1
      && style.display !== "none"
      && style.visibility !== "hidden";
  };
  const count = (selector) => Array.from(document.querySelectorAll(selector)).filter(visible).length;
  const pathname = window.location.pathname;
  return {
    pageKind: pathname === "/" ? "home" : /^\/(?:\d+|u\/[A-Za-z0-9_-]+)\/?$/u.test(pathname) ? "chat" : "other",
    visibleInputs: count('input:not([type="hidden"])'),
    visibleTextareas: count("textarea"),
    visibleEditables: count('[contenteditable="true"]'),
    visibleButtons: count('button, [role="button"]'),
    viewport: { width: window.innerWidth, height: window.innerHeight },
  };
});

const passiveReadSummary = (readGuard) => ({
  mode: "preserve-unread",
  blockedFrames: readGuard.blockedFrames,
  blockedByType: { ...readGuard.blockedByType },
  forwardedReadFrames: readGuard.forwardedReadFrames,
  note: "MAX server-side message/reaction read receipts stayed blocked unless a verified send or reply explicitly enabled them.",
});

const sendOpenChat = async (page, options) => {
  const message = outgoingMessage(options);
  await uploadFiles(page, options.files, options.timeoutMs);
  const composer = message ? await findComposer(page) : null;
  if (message) await fillLocator(composer, message, page);
  const method = await sendCurrentComposer(page, options.timeoutMs, Boolean(message));
  await page.waitForTimeout(1_200);
  const textVerification = message
    ? await verifyTextSend(page, composer, message, options.timeoutMs)
    : null;
  const verifiedAttachments = await verifyAttachmentSend(page, options.files, options.timeoutMs);
  return { method, textVerification, verifiedAttachments };
};

const markReadAfterVerifiedReply = async (page, options, readGuard) => {
  const forwardedBefore = readGuard.forwardedReadFrames;
  readGuard.allowReadReceipts = true;
  try {
    // The UI has already updated its local read marker optimistically while
    // the guard was blocking the network frame. Reloading rehydrates the
    // authoritative unread state and makes MAX emit its normal READ_MESSAGE
    // only after the outgoing answer has been verified in the chat.
    await page.reload({ waitUntil: "domcontentloaded", timeout: options.timeoutMs });
    await waitForVisibleMaxUi(page, options.timeoutMs);
    await assertLoggedIn(page);
    const lastMessage = page.locator(
      '[data-message-id], [data-testid*="message" i], [class*="message" i], [aria-label*="сообщ" i], [aria-label*="message" i]',
    ).last();
    if (await lastMessage.count()) {
      await lastMessage.scrollIntoViewIfNeeded({ timeout: options.timeoutMs }).catch(() => undefined);
    }
    await page.waitForTimeout(1_500);
    const forwardedReadFrames = readGuard.forwardedReadFrames - forwardedBefore;
    return {
      attempted: true,
      forwardedReadFrames,
      status: forwardedReadFrames > 0
        ? "read-receipt-forwarded-after-verified-answer"
        : "answer-sent-no-read-receipt-was-needed-or-observed",
    };
  } catch (error) {
    // Sending has already succeeded, so throwing here would invite an unsafe
    // retry and could duplicate the message. Report the narrower read-mark
    // failure while preserving the successful send result.
    return {
      attempted: true,
      forwardedReadFrames: readGuard.forwardedReadFrames - forwardedBefore,
      status: "answer-sent-read-mark-not-confirmed",
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    readGuard.allowReadReceipts = false;
  }
};

const readChatMessages = async (page, options) => {
  const opened = await openChat(page, options);
  const loadedPages = await loadHistoryPages(page, options.pages, options.timeoutMs);
  return {
    opened,
    loadedPages,
    messages: await visibleMessages(page, options.limit),
  };
};

const readUnreadDialogs = async (page, options) => {
  await openHome(page, options);
  const unreadDialogs = (await collectDialogResults(page, "", true)).slice(0, options.limit);
  const chats = [];
  for (const dialog of unreadDialogs) {
    const nestedOptions = { ...options, chat: dialog.url || dialog.title };
    try {
      chats.push({
        dialog,
        ...(await readChatMessages(page, nestedOptions)),
      });
    } catch (error) {
      chats.push({
        dialog,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { unreadDialogs: chats };
};

const waitFor = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

const downloadSelectedAttachment = async (page, options) => {
  await openChat(page, options);
  await loadHistoryPages(page, options.pages, options.timeoutMs);
  const target = await findMessageTarget(page, options);
  const attachments = target.locator.locator(
    'a[download], button[aria-label*="скач" i], button[aria-label*="download" i], [role="button"][aria-label*="скач" i], [role="button"][aria-label*="download" i]',
  );
  const count = await attachments.count();
  if (options.attachmentIndex > count) {
    throw new Error(
      `MAX message exposes ${count} downloadable attachment(s); requested index ${options.attachmentIndex}.`,
    );
  }
  const downloadPromise = page.waitForEvent("download", { timeout: options.timeoutMs });
  await attachments.nth(options.attachmentIndex - 1).click({ timeout: options.timeoutMs });
  const download = await downloadPromise;
  const suggestedName = download.suggestedFilename();
  const destination = fs.existsSync(options.output) && fs.statSync(options.output).isDirectory()
    ? path.join(options.output, suggestedName)
    : options.output;
  if (fs.existsSync(destination)) {
    throw new Error(`Refusing to overwrite existing download: ${destination}`);
  }
  ensureOutputParentDirectory(path.dirname(destination));
  await download.saveAs(destination);
  if (process.platform !== "win32") fs.chmodSync(destination, 0o600);
  const stat = fs.statSync(destination);
  return {
    downloaded: true,
    path: destination,
    name: path.basename(destination),
    sizeBytes: stat.size,
    sha256: sha256File(destination),
    sourceMessage: target.message,
  };
};

const replyToMessage = async (page, options, readGuard) => {
  const policyMode = assertMutationAllowed(options);
  const opened = await openChat(page, options);
  await loadHistoryPages(page, options.pages, options.timeoutMs);
  const target = await findMessageTarget(page, options);
  await openMessageActionMenu(page, target.locator, options.timeoutMs);
  await clickVisibleAction(page, /ответить|reply/iu, options.timeoutMs);
  const dispatched = await sendOpenChat(page, options);
  const readMark = await markReadAfterVerifiedReply(page, options, readGuard);
  return {
    replied: true,
    opened,
    target: target.message,
    policyMode,
    ...dispatched,
    readMark,
    retryPolicy: "Do not retry automatically after an ambiguous failure.",
  };
};

const editMessage = async (page, options) => {
  const policyMode = assertMutationAllowed(options);
  const opened = await openChat(page, options);
  await loadHistoryPages(page, options.pages, options.timeoutMs);
  const target = await findMessageTarget(page, options, { outgoingOnly: true });
  await openMessageActionMenu(page, target.locator, options.timeoutMs);
  await clickVisibleAction(page, /редактировать|edit/iu, options.timeoutMs);
  const composer = await findComposer(page);
  const message = outgoingMessage(options);
  await fillLocator(composer, message, page);
  const method = await sendCurrentComposer(page, options.timeoutMs, true);
  const verification = await verifyTextSend(page, composer, message, options.timeoutMs);
  return {
    edited: true,
    opened,
    target: target.message,
    policyMode,
    method,
    verification,
    retryPolicy: "Do not retry automatically after an ambiguous failure.",
  };
};

const deleteMessage = async (page, options) => {
  const policyMode = assertMutationAllowed(options);
  const opened = await openChat(page, options);
  await loadHistoryPages(page, options.pages, options.timeoutMs);
  const target = await findMessageTarget(page, options, { outgoingOnly: true });
  await openMessageActionMenu(page, target.locator, options.timeoutMs);
  await clickVisibleAction(page, /удалить(?: сообщение)?|delete(?: message)?/iu, options.timeoutMs);
  const confirmed = await confirmVisibleDialogAction(page, /удалить|delete/iu, options.timeoutMs);
  if (!confirmed && await target.locator.count()) {
    throw new Error("MAX did not show a scoped delete confirmation and the target is still present.");
  }
  await target.locator.waitFor({ state: "detached", timeout: Math.min(options.timeoutMs, 15_000) }).catch(() => {
    throw new Error("MAX delete result is ambiguous: the exact message is still present. Do not retry automatically.");
  });
  return {
    deleted: true,
    opened,
    target: target.message,
    policyMode,
    retryPolicy: "Do not retry automatically after an ambiguous failure.",
  };
};

const reactToMessage = async (page, options) => {
  const policyMode = assertMutationAllowed(options);
  const opened = await openChat(page, options);
  await loadHistoryPages(page, options.pages, options.timeoutMs);
  const target = await findMessageTarget(page, options);
  await target.locator.hover({ timeout: options.timeoutMs });
  const reactionButton = target.locator.getByRole("button", { name: /реакц|react/iu }).last();
  if (await reactionButton.count() && await reactionButton.isVisible({ timeout: 700 }).catch(() => false)) {
    await reactionButton.click({ timeout: options.timeoutMs });
  } else {
    await openMessageActionMenu(page, target.locator, options.timeoutMs);
    await clickVisibleAction(page, /реакц|react/iu, options.timeoutMs);
  }
  await clickVisibleAction(page, options.reaction, options.timeoutMs, { exact: true });
  await target.locator.getByText(options.reaction, { exact: true }).last().waitFor({
    state: "visible",
    timeout: Math.min(options.timeoutMs, 10_000),
  }).catch(() => {
    throw new Error("MAX reaction result is ambiguous. Do not retry automatically.");
  });
  return {
    reacted: true,
    reaction: options.reaction,
    opened,
    target: target.message,
    policyMode,
    retryPolicy: "Do not retry automatically after an ambiguous failure.",
  };
};

const forwardMessage = async (page, options) => {
  const policyMode = assertMutationAllowed(options);
  const opened = await openChat(page, options);
  await loadHistoryPages(page, options.pages, options.timeoutMs);
  const target = await findMessageTarget(page, options);
  await openMessageActionMenu(page, target.locator, options.timeoutMs);
  await clickVisibleAction(page, /переслать|forward/iu, options.timeoutMs);
  const destination = await chooseExactPickerEntry(page, options.toChat, options.timeoutMs);
  await clickVisibleAction(page, /отправить|send/iu, options.timeoutMs);
  await page.waitForTimeout(1_200);
  return {
    forwarded: true,
    opened,
    target: target.message,
    destination,
    policyMode,
    verification: "MAX accepted the exact destination and closed the send action.",
    retryPolicy: "Do not retry automatically after an ambiguous failure.",
  };
};

const openChatDetails = async (page, options) => {
  const title = /^https?:\/\//iu.test(options.chat) || /^\d+$/u.test(options.chat)
    ? null
    : options.chat;
  const candidates = [
    title ? page.getByRole("button", { name: new RegExp(title.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "iu") }).last() : null,
    page.locator('[data-testid*="chat-header" i] button, [class*="chat-header" i] button, header button').last(),
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      if (await candidate.count() && await candidate.isVisible({ timeout: 700 })) {
        await candidate.click({ timeout: options.timeoutMs });
        await page.waitForTimeout(800);
        return;
      }
    } catch {
      // Try the geometry fallback below.
    }
  }
  const selected = await page.evaluate(() => {
    const candidates = Array.from(document.querySelectorAll('button, [role="button"]'))
      .filter((node) => {
        if (!(node instanceof HTMLElement)) return false;
        const rect = node.getBoundingClientRect();
        const style = window.getComputedStyle(node);
        return rect.width >= 80
          && rect.height >= 24
          && rect.x > window.innerWidth * 0.28
          && rect.y < 180
          && style.display !== "none"
          && style.visibility !== "hidden";
      });
    if (candidates.length !== 1) return false;
    candidates[0].setAttribute("data-trelio-max-chat-header", "true");
    return true;
  });
  if (!selected) throw new Error("Could not safely identify the MAX chat header/details action.");
  await page.locator('[data-trelio-max-chat-header="true"]').click({ timeout: options.timeoutMs });
  await page.waitForTimeout(800);
};

const collectVisibleMembers = (page) => page.evaluate(() => {
  document.querySelectorAll("[data-trelio-max-member]").forEach((node) => {
    node.removeAttribute("data-trelio-max-member");
  });
  const rows = Array.from(document.querySelectorAll(
    'a[href*="/u/"], [data-testid*="member" i], [class*="member" i], [role="listitem"]',
  ));
  const result = [];
  const seen = new Set();
  for (const row of rows) {
    if (!(row instanceof HTMLElement)) continue;
    const rect = row.getBoundingClientRect();
    const style = window.getComputedStyle(row);
    if (rect.width < 40 || rect.height < 16 || style.display === "none" || style.visibility === "hidden") continue;
    const text = (row.innerText || row.textContent || "").replace(/\s+/gu, " ").trim();
    if (!text || text.length > 500) continue;
    const link = row.matches("a[href]") ? row : row.querySelector('a[href*="/u/"]');
    const href = link instanceof HTMLAnchorElement ? link.href : null;
    const stableId = href?.match(/\/u\/([A-Za-z0-9_-]+)\/?$/u)?.[1]
      || text.match(/@([A-Za-z0-9_.-]+)/u)?.[1]
      || null;
    const key = stableId?.toLowerCase() || text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    row.setAttribute("data-trelio-max-member", String(result.length));
    result.push({ index: result.length, title: text, text, url: href, stableId });
  }
  return result;
});

const listChatMembers = async (page, options) => {
  const opened = await openChat(page, options);
  await openChatDetails(page, options);
  return { opened, members: await collectVisibleMembers(page) };
};

const createDirectChat = async (page, options, readGuard) => {
  const policyMode = assertMutationAllowed(options);
  const contactUrl = normalizeChatUrl(options.contact);
  if (!/\/u\/[A-Za-z0-9_-]+\/?$/u.test(new URL(contactUrl).pathname)) {
    throw new Error("create-direct requires an official MAX /u/ contact URL.");
  }
  await page.goto(contactUrl, { waitUntil: "domcontentloaded", timeout: options.timeoutMs });
  await waitForVisibleMaxUi(page, options.timeoutMs);
  await assertLoggedIn(page);
  const dispatched = await sendOpenChat(page, options);
  const readMark = await markReadAfterVerifiedReply(page, options, readGuard);
  return {
    created: true,
    kind: "direct",
    contactUrl,
    policyMode,
    ...dispatched,
    readMark,
    retryPolicy: "Do not retry automatically after an ambiguous failure.",
  };
};

const openCreateGroupFlow = async (page, options) => {
  await openHome(page, options);
  const explicit = page.getByRole("button", { name: /новый чат|создать чат|new chat|create chat/iu }).last();
  if (await explicit.count() && await explicit.isVisible({ timeout: 700 }).catch(() => false)) {
    await explicit.click({ timeout: options.timeoutMs });
  } else {
    const plus = page.locator(
      'button[aria-label*="созд" i], button[aria-label*="добав" i], button[aria-label="+"], [role="button"][aria-label="+"]',
    ).first();
    if (!await plus.count() || !await plus.isVisible({ timeout: 700 }).catch(() => false)) {
      throw new Error("Could not safely identify the MAX new-chat action.");
    }
    await plus.click({ timeout: options.timeoutMs });
  }
  await clickVisibleAction(page, /создать групповой чат|create group chat/iu, options.timeoutMs);
};

const fillGroupTitleAndAvatar = async (page, options) => {
  const titleCandidates = [
    page.getByLabel(/название|title/iu).last(),
    page.getByPlaceholder(/название|title/iu).last(),
    page.getByRole("textbox").last(),
  ];
  let titleInput = null;
  for (const candidate of titleCandidates) {
    if (await candidate.count() && await candidate.isVisible({ timeout: 700 }).catch(() => false)) {
      titleInput = candidate;
      break;
    }
  }
  if (!titleInput) throw new Error("Could not safely identify the MAX group title field.");
  await fillLocator(titleInput, options.title, page);
  if (options.avatar) {
    const upload = page.locator('input[type="file"][accept*="image" i], input[type="file"]').last();
    if (!await upload.count()) throw new Error("MAX group avatar upload is unavailable in the current UI.");
    await upload.setInputFiles(options.avatar, { timeout: options.timeoutMs });
  }
};

const findExistingGroupCandidate = async (page, options) => {
  await openHome(page, options);
  const search = await findSearchInput(page, options.timeoutMs);
  await fillLocator(search, options.title, page);
  await page.waitForTimeout(1_200);
  const results = await collectDialogResults(page, options.title);
  const exact = results.filter((result) => normalizeDialogTitle(result.title) === normalizeDialogTitle(options.title));
  if (exact.length === 0) return null;
  if (exact.length > 1) {
    throw new Error(
      "Several MAX chats already use this exact title. Use a unique title before creating another group.",
    );
  }
  return exact[0];
};

const verifyExistingGroupMembers = async (page, options, candidate) => {
  const nestedOptions = { ...options, chat: candidate.url || candidate.title };
  const current = await listChatMembers(page, nestedOptions);
  const missing = options.members.filter((reference) => {
    try {
      selectExactContactResult(current.members, reference);
      return false;
    } catch {
      return true;
    }
  });
  return { current, missing };
};

const createGroupChat = async (page, options) => {
  const policyMode = assertMutationAllowed(options);
  const existing = await findExistingGroupCandidate(page, options);
  if (existing) {
    const verification = await verifyExistingGroupMembers(page, options, existing);
    if (verification.missing.length === 0) {
      return {
        created: false,
        alreadyExists: true,
        recoveredIdempotently: true,
        kind: "group",
        title: options.title,
        url: existing.url,
        members: verification.current.members,
        policyMode,
      };
    }
    throw new Error(
      `A MAX chat named ${options.title} already exists but is missing requested members: ${verification.missing.join(", ")}. Use a unique title.`,
    );
  }
  await openCreateGroupFlow(page, options);
  const selectedMembers = [];
  for (const member of options.members) {
    selectedMembers.push(await chooseExactPickerEntry(page, member, options.timeoutMs));
  }
  await clickVisibleAction(page, /продолжить|continue|далее|next/iu, options.timeoutMs);
  await fillGroupTitleAndAvatar(page, options);
  await clickVisibleAction(page, /создать чат|create chat/iu, options.timeoutMs);
  await page.waitForTimeout(1_500);
  const titleVisible = await page.getByText(options.title, { exact: true }).last().isVisible({ timeout: 2_000 })
    .catch(() => false);
  if (!titleVisible) {
    const recovered = await findExistingGroupCandidate(page, options).catch(() => null);
    if (recovered) {
      const verification = await verifyExistingGroupMembers(page, options, recovered).catch(() => null);
      if (verification && verification.missing.length === 0) {
        return {
          created: true,
          recoveredAfterAmbiguousResponse: true,
          kind: "group",
          title: options.title,
          members: verification.current.members,
          url: recovered.url,
          policyMode,
          retryPolicy: "Creation was verified by exact title and participant set; do not repeat it.",
        };
      }
    }
    throw new Error("MAX group creation result is ambiguous and exact live verification failed. Do not retry automatically.");
  }
  return {
    created: true,
    kind: "group",
    title: options.title,
    members: selectedMembers,
    avatar: options.avatar ? fileApprovalDescriptor(options.avatar) : null,
    url: page.url(),
    policyMode,
    retryPolicy: "Search and verify the exact title and participant set before retrying an ambiguous creation.",
  };
};

const mutateMembers = async (page, options, remove) => {
  const policyMode = assertMutationAllowed(options);
  const opened = await openChat(page, options);
  await openChatDetails(page, options);
  const changed = [];
  if (!remove) {
    await clickVisibleAction(page, /добавить участников|add (?:participants|members)/iu, options.timeoutMs);
    for (const member of options.members) {
      changed.push(await chooseExactPickerEntry(page, member, options.timeoutMs));
    }
    await clickVisibleAction(page, /добавить|add/iu, options.timeoutMs);
  } else {
    for (const member of options.members) {
      const current = await collectVisibleMembers(page);
      const selected = selectExactContactResult(current, member);
      const row = page.locator(`[data-trelio-max-member="${selected.index}"]`);
      await row.click({ timeout: options.timeoutMs });
      await clickVisibleAction(page, /удалить участника|remove (?:participant|member)/iu, options.timeoutMs);
      const confirmed = await confirmVisibleDialogAction(page, /удалить|remove/iu, options.timeoutMs);
      if (!confirmed) throw new Error("MAX did not show the expected scoped member-removal confirmation.");
      changed.push(selected);
    }
  }
  await page.waitForTimeout(1_000);
  return {
    changed: true,
    operation: remove ? "remove" : "add",
    opened,
    members: changed,
    policyMode,
    retryPolicy: "Do not repeat an ambiguous member mutation before rereading the live member list.",
  };
};

const updateChat = async (page, options) => {
  const policyMode = assertMutationAllowed(options);
  const opened = await openChat(page, options);
  await openChatDetails(page, options);
  await clickVisibleAction(page, /редактировать чат|edit chat/iu, options.timeoutMs);
  if (options.title) {
    const title = page.getByLabel(/название|title/iu).last();
    const fallback = page.getByRole("textbox").last();
    const input = await title.count() && await title.isVisible({ timeout: 700 }).catch(() => false) ? title : fallback;
    if (!await input.count()) throw new Error("Could not safely identify the MAX chat title field.");
    await fillLocator(input, options.title, page);
  }
  if (options.avatar) {
    const upload = page.locator('input[type="file"][accept*="image" i], input[type="file"]').last();
    if (!await upload.count()) throw new Error("MAX chat avatar upload is unavailable in the current UI.");
    await upload.setInputFiles(options.avatar, { timeout: options.timeoutMs });
  }
  await clickVisibleAction(page, /сохранить|save/iu, options.timeoutMs);
  await page.waitForTimeout(1_000);
  if (options.title) {
    const visible = await page.getByText(options.title, { exact: true }).last().isVisible({ timeout: 2_000 })
      .catch(() => false);
    if (!visible) throw new Error("MAX chat update result is ambiguous. Reread chat details before retrying.");
  }
  return {
    updated: true,
    opened,
    title: options.title || null,
    avatar: options.avatar ? fileApprovalDescriptor(options.avatar) : null,
    policyMode,
    retryPolicy: "Reread live chat details before retrying an ambiguous update.",
  };
};

const runBrowserCommand = async (options) => withBrowser(options, async (page, readGuard) => {
  validateCommandOptions(options);
  if (options.command === "login") {
    await openHome(page, options, true);
    if (!options.headed) throw new Error("MAX login requires --headed.");
    await page.waitForTimeout(options.holdMs);
    return { opened: true, profile: profilePath(options), heldMs: options.holdMs };
  }
  if (options.command === "probe") {
    await openHome(page, options);
    const searchReady = await findSearchInput(page, options.timeoutMs)
      .then(() => true)
      .catch(() => false);
    return {
      adapterVersion: ADAPTER_VERSION,
      authenticated: true,
      searchReady,
      fingerprint: await safeUiFingerprint(page),
      passiveReadProtection: passiveReadSummary(readGuard),
      diagnosticPolicy: "No chat text, message text, cookies or credentials are included.",
    };
  }
  if (options.command === "dialogs") {
    await openHome(page, options);
    const search = await findSearchInput(page, options.timeoutMs);
    await fillLocator(search, options.query, page);
    await page.waitForTimeout(1_800);
    return {
      query: options.query,
      dialogs: await collectDialogResults(page, options.query),
      passiveReadProtection: passiveReadSummary(readGuard),
    };
  }
  if (options.command === "contacts") {
    await openHome(page, options);
    const search = await findSearchInput(page, options.timeoutMs);
    await fillLocator(search, options.query, page);
    await page.waitForTimeout(1_800);
    const results = await collectDialogResults(page, options.query);
    return {
      query: options.query,
      contacts: results.filter((result) => result.url?.includes("/u/") || /@[A-Za-z0-9_.-]+/u.test(result.text)),
      passiveReadProtection: passiveReadSummary(readGuard),
    };
  }
  if (options.command === "read") {
    return {
      ...(await readChatMessages(page, options)),
      passiveReadProtection: passiveReadSummary(readGuard),
      note: "Loaded MAX messages are returned with bounded structured metadata; read receipts stay blocked.",
      securityBoundary: "chat-only",
    };
  }
  if (options.command === "unread") {
    return {
      ...(await readUnreadDialogs(page, options)),
      passiveReadProtection: passiveReadSummary(readGuard),
      securityBoundary: "chat-only",
    };
  }
  if (options.command === "watch") {
    const snapshots = [];
    for (let iteration = 0; iteration < options.iterations; iteration += 1) {
      snapshots.push({
        observedAt: new Date().toISOString(),
        ...(await readUnreadDialogs(page, options)),
      });
      if (iteration + 1 < options.iterations) {
        await waitFor(options.intervalMs);
        await page.reload({ waitUntil: "domcontentloaded", timeout: options.timeoutMs }).catch(() => undefined);
      }
    }
    return {
      snapshots,
      passiveReadProtection: passiveReadSummary(readGuard),
      schedulingNote: "Use the host scheduler for durable background monitoring; this command is intentionally bounded.",
      securityBoundary: "chat-only",
    };
  }
  if (options.command === "download") {
    return {
      ...(await downloadSelectedAttachment(page, options)),
      passiveReadProtection: passiveReadSummary(readGuard),
      securityBoundary: "chat-only",
    };
  }
  if (options.command === "send") {
    const policyMode = assertMutationAllowed(options);
    const opened = await openChat(page, options);
    const dispatched = await sendOpenChat(page, options);
    const readMark = await markReadAfterVerifiedReply(page, options, readGuard);
    return {
      sent: true,
      opened,
      policyMode,
      ...dispatched,
      readMark,
      passiveReadProtection: passiveReadSummary(readGuard),
      retryPolicy: "Do not retry automatically after an ambiguous failure.",
    };
  }
  if (options.command === "reply") {
    return {
      ...(await replyToMessage(page, options, readGuard)),
      passiveReadProtection: passiveReadSummary(readGuard),
    };
  }
  if (options.command === "edit") {
    return { ...(await editMessage(page, options)), passiveReadProtection: passiveReadSummary(readGuard) };
  }
  if (options.command === "delete") {
    return { ...(await deleteMessage(page, options)), passiveReadProtection: passiveReadSummary(readGuard) };
  }
  if (options.command === "react") {
    return { ...(await reactToMessage(page, options)), passiveReadProtection: passiveReadSummary(readGuard) };
  }
  if (options.command === "forward") {
    return { ...(await forwardMessage(page, options)), passiveReadProtection: passiveReadSummary(readGuard) };
  }
  if (options.command === "create-direct") {
    return {
      ...(await createDirectChat(page, options, readGuard)),
      passiveReadProtection: passiveReadSummary(readGuard),
    };
  }
  if (options.command === "create-group") {
    return { ...(await createGroupChat(page, options)), passiveReadProtection: passiveReadSummary(readGuard) };
  }
  if (options.command === "members") {
    return { ...(await listChatMembers(page, options)), passiveReadProtection: passiveReadSummary(readGuard) };
  }
  if (options.command === "member-add") {
    return { ...(await mutateMembers(page, options, false)), passiveReadProtection: passiveReadSummary(readGuard) };
  }
  if (options.command === "member-remove") {
    return { ...(await mutateMembers(page, options, true)), passiveReadProtection: passiveReadSummary(readGuard) };
  }
  if (options.command === "chat-update") {
    return { ...(await updateChat(page, options)), passiveReadProtection: passiveReadSummary(readGuard) };
  }
  throw new Error(`Unsupported MAX browser command: ${options.command}`);
});

const main = async () => {
  const options = parseArguments(process.argv.slice(2));
  if (options.command === "help") {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  if (options.command === "bootstrap") {
    output({ ok: true, ...bootstrap() });
    return;
  }
  if (options.command === "doctor") {
    let playwrightPath = null;
    try {
      playwrightPath = require.resolve("playwright-core", { paths: [runtimeRoot()] });
    } catch {
      playwrightPath = null;
    }
    output({
      ok: true,
      runtimeReady: Boolean(playwrightPath),
      playwrightPath,
      chromeExecutable: options.chromeExecutable,
      chromeExists: fs.existsSync(options.chromeExecutable),
      profilePresent: fs.existsSync(profilePath(options)),
      policy: loadPolicy(options),
      localRoot: connectionRoot(options),
      securityBoundary: "chat-only",
      adapterVersion: ADAPTER_VERSION,
    });
    return;
  }
  if (options.command === "policy") {
    if (options.policyCommand === "set") {
      if (!POLICY_MODES.has(options.sendMode)) throw new Error("--send-mode is invalid.");
      writePrivateJson(policyPath(options), { sendMode: options.sendMode });
    } else if (options.policyCommand !== "show") {
      throw new Error("policy requires show or set.");
    }
    output({ ok: true, policy: loadPolicy(options), path: policyPath(options) });
    return;
  }
  if (options.dryRun) {
    output({ ok: true, ...buildMutationPreview(options) });
    return;
  }
  output({ ok: true, ...(await runBrowserCommand(options)) });
};

export {
  ADAPTER_VERSION,
  assertMutationAllowed,
  assertSendAllowed,
  buildMutationPreview,
  connectionRoot,
  installPassiveReadGuard,
  loadPolicy,
  normalizeDialogTitle,
  normalizeContactReference,
  openHome,
  parseArguments,
  passiveReadFrameMarker,
  policyPath,
  selectExactDialogResult,
  selectExactContactResult,
  shouldBlockPassiveReadFrame,
  writePrivateJson,
};

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    output({ ok: false, error: error instanceof Error ? error.message : String(error) });
    process.exitCode = 2;
  });
}
