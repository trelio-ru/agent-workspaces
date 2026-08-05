#!/usr/bin/env node

/**
 * Trelio Telegram Web signed runtime.
 *
 * The runtime deliberately uses a dedicated persistent Chrome profile. It
 * never imports cookies from the user's normal browser and never serializes
 * Telegram storage into Trelio, a workspace, stdout, or an approval payload.
 * Codex and Claude Code therefore execute exactly the same local CLI contract.
 */

import { execFile, spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  chmod,
  lstat as rawLstat,
  link,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import {
  constants as fsConstants,
  createReadStream,
  existsSync,
  realpathSync,
} from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const require = createRequire(import.meta.url);
const execFileAsync = promisify(execFile);

// APFS inode values can exceed JavaScript's exact integer range. Distinct
// same-type files such as /bin/[ and /bin/ls can therefore collapse to the
// same Number-valued Stats. Every security identity/recheck uses BigInt stats
// normalized to decimal strings; ordinary numeric Stats are never an ABA
// token in this runtime.
const normalizeExactStats = (metadata) => ({
  dev: metadata.dev.toString(),
  ino: metadata.ino.toString(),
  mode: Number(metadata.mode),
  uid: Number(metadata.uid),
  gid: Number(metadata.gid),
  size: Number(metadata.size),
  mtimeMs: Number(metadata.mtimeMs),
  mtimeNs: metadata.mtimeNs?.toString?.() || null,
  isBlockDevice: () => metadata.isBlockDevice(),
  isCharacterDevice: () => metadata.isCharacterDevice(),
  isDirectory: () => metadata.isDirectory(),
  isFIFO: () => metadata.isFIFO(),
  isFile: () => metadata.isFile(),
  isSocket: () => metadata.isSocket(),
  isSymbolicLink: () => metadata.isSymbolicLink(),
});

const lstat = async (targetPath) => normalizeExactStats(await rawLstat(targetPath, { bigint: true }));
const handleStatExact = async (handle) => normalizeExactStats(await handle.stat({ bigint: true }));
const exactPathIdentity = async (targetPath) => {
  const metadata = await lstat(targetPath);
  return { dev: metadata.dev, ino: metadata.ino };
};

export const SKILL_ID = "telegram-web";
export const ADAPTER_VERSION = "1";
export const TELEGRAM_WEB_URL = "https://web.telegram.org/k/";
export const TELEGRAM_WEB_ORIGIN = new URL(TELEGRAM_WEB_URL).origin;
export const CONSENT_TERMS_VERSION = "telegram-ai-processing/2026-08-04";
export const CONSENT_VALID_DAYS = 365;
export const PLAYWRIGHT_VERSION = "1.60.0";
// Aggregate over the exact npm tarball tree for playwright-core@1.60.0:
// globally UTF-8-sorted relative file paths, decimal byte lengths, bytes, and
// a trailing NUL per file under domain `trelio-playwright-core-tree/v1\0`.
// Directories are traversed and trust-checked but are not hash records.
// The source tarball is independently pinned by the lockfile SSRI below.
const PLAYWRIGHT_CORE_TREE_SHA256 = "801165b18e76d3b89ae2e7d1cece9f3c4d6a29d7cd737fa602534d6ec5eff6d2";
const PLAYWRIGHT_CORE_SSRI = "sha512-9bW6zvX/m0lEbgTKJ6YppOKx8H3VOPBMOCFh2irXFOT4BbHgrx5hPjwJYLT40Lu+4qtD36qKc/Hn56StUW57IA==";
const MAX_PINNED_PACKAGE_FILES = 1_000;
const MAX_PINNED_PACKAGE_BYTES = 64 * 1024 * 1024;

const POLICY_MODES = new Set(["confirm", "autonomous", "read-only"]);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const VERSION_PATTERN = /^\d+\.\d+\.\d+$/u;
const PEER_ID_PATTERN = /^-?\d{1,24}$/u;
const MAX_CAPTION_CHARS = 1_024;
const MAX_MESSAGE_FILE_BYTES = 128 * 1024;
const MAX_UPLOAD_FILE_BYTES = 64 * 1024 * 1024;
const MAX_UPLOAD_TOTAL_BYTES = MAX_UPLOAD_FILE_BYTES;
const MAX_DOWNLOAD_BYTES = 256 * 1024 * 1024;
// The verified file lane deliberately sends one immutable local file as one
// Telegram document. Multiple files would enter Web K's grouped/album path and
// require proving several independently-final provider messages after one
// click; that is a different mutation contract, not a parser convenience.
const MAX_FILES = 1;
const MAX_MEMBERS = 100;
const MAX_EXACT_CHATS = 20;
const MAX_HISTORY_PAGES = 10;
const MAX_HISTORY_MESSAGES = 100;
const MAX_SEARCH_RESULTS_TOTAL = 100;
const MAX_LINK_ENTITIES_PER_MESSAGE = 32;
const MAX_REPLY_CONTEXT_CHARS = 2_000;
// One Telegram message model has at most one top-level media payload in the
// verified Web K surface. Albums are separate message models. Keeping this
// public cap explicit prevents a future provider wrapper from turning nested
// previews or paid-media internals into an unbounded metadata traversal.
const MAX_ATTACHMENT_METADATA_PER_MESSAGE = 1;
const MAX_RESULT_BYTES = 512 * 1024;
const MAX_WATCH_ITERATIONS = 60;
const MAX_WATCH_INTERVAL_MS = 300_000;
const MIN_WATCH_INTERVAL_MS = 1_000;
const DEFAULT_TIMEOUT_MS = 60_000;
const UI_READY_TIMEOUT_MS = 15_000;
// A completed owner login must remain canonical for a short bounded interval.
// This prevents a one-frame chat-shell/manager mount immediately before Web K
// renders two-step verification from being mistaken for final authentication.
const LOGIN_AUTH_STABILITY_MS = 1_000;
const TELEGRAM_CHAT_LIST_SELECTOR = '.chatlist-chat[data-peer-id]';
const TELEGRAM_COMPOSER_SELECTOR = '.input-message-input[contenteditable="true"]';
const TELEGRAM_BUBBLES_SELECTOR = '.bubbles-inner';
const TELEGRAM_LOGIN_SURFACE_SELECTOR = 'canvas, [class*="auth" i], [class*="qr" i], input[type="tel"], input[autocomplete="tel"]';
const TELEGRAM_PASSWORD_SELECTOR = 'input[type="password"], input[autocomplete="current-password"]';
const CONSENT_BODY_LIMIT = 8 * 1024;
const CONSENT_TIMEOUT_MS = 10 * 60_000;
// The revoke path waits at most ten seconds for the consent-state lock.  A
// decisive browser lease therefore contains a bounded surface snapshot, one
// bounded read-only source/composer reproof, and one Locator.click(). Their
// fixed deadlines remain below the revoke lock's ten-second wait independently
// of the user's general command timeout.
const CONSENT_LEASE_SURFACE_TIMEOUT_MS = 2_000;
const CONSENT_LEASE_REPROOF_TIMEOUT_MS = 2_000;
const CONSENT_LEASE_CLICK_TIMEOUT_MS = 3_000;
const APPROVAL_TTL_MS = 10 * 60_000;
const SEARCH_COMPLETION_STATE_KEY = "__trelioTelegramWebSearchCompletionsV1";

const PUBLIC_MESSAGE_ARTIFACT_CONTRACT = Object.freeze({
  authorAndTimestamp: "when_available",
  linkEntitiesPerMessage: MAX_LINK_ENTITIES_PER_MESSAGE,
  linkEntityProtocols: Object.freeze(["http", "https", "mailto", "tg"]),
  replyDepth: 1,
  replyTextChars: MAX_REPLY_CONTEXT_CHARS,
  attachmentMetadataPerMessage: MAX_ATTACHMENT_METADATA_PER_MESSAGE,
  attachmentMetadataFields: Object.freeze(["index", "kind", "name", "sizeBytes", "mimeType"]),
  peerId: "opaque_safe_integer_without_access_hash",
  providerCapabilityMaterial: "excluded",
});

const CONTENT_COMMANDS = new Set([
  "archive",
  "chat-update",
  "create-direct",
  "create-group",
  "delete",
  "dialogs",
  "download",
  "edit",
  "mark-unread",
  "member-add",
  "member-remove",
  "members",
  "mute",
  "pin",
  "react",
  "read",
  "reply",
  "search",
  "send",
  "unarchive",
  "unmute",
  "unpin",
  "unread",
  "watch",
]);

const MUTATING_COMMANDS = new Set([
  "archive",
  "chat-update",
  "create-direct",
  "create-group",
  "delete",
  "edit",
  "mark-unread",
  "member-add",
  "member-remove",
  "mute",
  "pin",
  "react",
  "reply",
  "send",
  "unarchive",
  "unmute",
  "unpin",
]);

const STRUCTURAL_COMMANDS = new Set([
  "archive",
  "chat-update",
  "create-direct",
  "create-group",
  "delete",
  "edit",
  "forget",
  "logout",
  "mark-unread",
  "member-add",
  "member-remove",
  "mute",
  "pin",
  "unarchive",
  "unmute",
  "unpin",
]);

// Includes recognized-but-deliberately-unsupported commands so the CLI can
// return deterministic TELEGRAM_WEB_UNSUPPORTED_OPERATION before any browser
// launch instead of a generic parser error.
const RECOGNIZED_COMMANDS = new Set([
  "access-status",
  "archive",
  "bootstrap",
  "chat-update",
  "consent",
  "create-direct",
  "create-group",
  "delete",
  "dialogs",
  "doctor",
  "download",
  "edit",
  "forget",
  "forward",
  "help",
  "inspect",
  "login",
  "logout",
  "mark-unread",
  "member-add",
  "member-remove",
  "members",
  "mute",
  "pin",
  "policy",
  "probe",
  "react",
  "read",
  "reply",
  "search",
  "send",
  "status",
  "unarchive",
  "unmute",
  "unpin",
  "unread",
  "watch",
]);

const ACTION_LABELS = Object.freeze({
  archive: /^(?:Archive|Архивировать)$/iu,
  unarchive: /^(?:Unarchive|Разархивировать|Вернуть из архива)$/iu,
  mute: /^(?:Mute|Отключить уведомления)$/iu,
  unmute: /^(?:Unmute|Включить уведомления)$/iu,
  pin: /^(?:Pin|Закрепить)$/iu,
  unpin: /^(?:Unpin|Открепить)$/iu,
  "mark-unread": /^(?:Mark as unread|Пометить непрочитанным)$/iu,
});

export class TelegramWebRuntimeError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = "TelegramWebRuntimeError";
    this.code = code;
    this.details = details;
  }
}

const fail = (code, message, details) => {
  throw new TelegramWebRuntimeError(code, message, details);
};

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

const canonicalJson = (value) => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
};

const boundedString = (value, maxLength, label) => {
  const normalized = String(value ?? "").normalize("NFKC").trim();
  if (!normalized || normalized.length > maxLength) {
    fail("TELEGRAM_WEB_INVALID_ARGUMENT", `${label} must contain from 1 to ${maxLength} characters.`);
  }
  return normalized;
};

const MAX_DISPLAY_LABEL_CHARS = 512;
// Default_Ignorable_Code_Point closes the whole Unicode class used by soft
// hyphens, grapheme joiners, ZWJ/ZWNJ and variation selectors instead of
// chasing individual visually hidden code points. Message body text remains
// untouched; this boundary applies only to routing/display metadata, public
// link targets and local document paths that participate in approval.
const DISPLAY_LABEL_UNSAFE_PATTERN_SOURCE = "[\\u0000-\\u001f\\u007f-\\u009f\\u061c\\u200e\\u200f\\u202a-\\u202e\\u2060-\\u206f\\p{Default_Ignorable_Code_Point}]";
const DISPLAY_LABEL_UNSAFE_PATTERN = new RegExp(DISPLAY_LABEL_UNSAFE_PATTERN_SOURCE, "gu");
const DISPLAY_LABEL_UNSAFE_TEST_PATTERN = new RegExp(DISPLAY_LABEL_UNSAFE_PATTERN_SOURCE, "u");

const wellFormedUtf16 = (value) => {
  let output = "";
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xD800 && unit <= 0xDBFF) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xDC00 && next <= 0xDFFF) {
        output += value[index] + value[index + 1];
        index += 1;
      }
      continue;
    }
    if (unit >= 0xDC00 && unit <= 0xDFFF) continue;
    output += value[index];
  }
  return output;
};

// Provider routing identifiers are opaque. Unlike human-facing labels, they
// must never be trimmed or Unicode-normalized before classification.
const boundedOpaqueString = (value, maximum, label) => {
  const exact = String(value ?? "");
  if (!exact || exact.length > maximum || wellFormedUtf16(exact) !== exact) {
    fail("TELEGRAM_WEB_INVALID_ARGUMENT", `${label} must contain from 1 to ${maximum} well-formed UTF-16 code units.`);
  }
  return exact;
};

const boundedWellFormedUtf16 = (value, maximum) => {
  let bounded = wellFormedUtf16(value).slice(0, maximum);
  if (/[\uD800-\uDBFF]$/u.test(bounded)) bounded = bounded.slice(0, -1);
  return bounded;
};

/**
 * Telegram titles and display names are untrusted UI content. Normalize them
 * once under a shared closed rule so bidi isolates/overrides and control
 * characters cannot visually reorder a separately displayed opaque PeerId.
 */
const sanitizeDisplayLabel = (value, maximum = MAX_DISPLAY_LABEL_CHARS) => boundedWellFormedUtf16(
  String(value ?? "")
    .normalize("NFKC")
    .replace(DISPLAY_LABEL_UNSAFE_PATTERN, " ")
    .replace(/\s+/gu, " ")
    .trim(),
  maximum,
);

const sanitizePublicUsername = (value) => {
  const normalized = sanitizeDisplayLabel(value, 33);
  return /^@[A-Za-z0-9_]{5,32}$/u.test(normalized) ? normalized : null;
};

const parseInteger = (value, minimum, maximum, label) => {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    fail("TELEGRAM_WEB_INVALID_ARGUMENT", `${label} must be an integer from ${minimum} to ${maximum}.`);
  }
  return parsed;
};

/**
 * Web K managers accept JavaScript numbers for PeerId values.  A syntactically
 * numeric 24-digit string is therefore not enough: converting it after a
 * navigation or click could silently round to another Telegram peer.  Keep one
 * validator at every trust boundary and call it before URL construction,
 * provider-manager access, or an element action.
 */
const requireExactSafePeerId = (
  value,
  {
    code = "TELEGRAM_WEB_UI_UNSUPPORTED",
    message = "Telegram Web exposed a malformed or inexact provider peer identifier.",
  } = {},
) => {
  const exact = String(value ?? "");
  const numeric = Number(exact);
  if (!PEER_ID_PATTERN.test(exact) || !Number.isSafeInteger(numeric) || numeric === 0 || String(numeric) !== exact) {
    fail(code, message);
  }
  return exact;
};

const validateDedicatedBase = (value, label, { allowMaterializedRuntimeAncestor = false } = {}) => {
  if (!path.isAbsolute(value)) fail("TELEGRAM_WEB_UNSAFE_PATH", `${label} must be absolute.`);
  const normalized = path.normalize(value);
  const comparable = (candidate) => process.platform === "win32"
    ? path.normalize(candidate).toLocaleLowerCase("en-US")
    : path.normalize(candidate);
  const broadRoots = new Set([
    path.parse(normalized).root,
    path.normalize(os.homedir()),
    path.normalize(os.tmpdir()),
    path.normalize(process.cwd()),
  ].map(comparable));
  if (broadRoots.has(comparable(normalized))) {
    fail("TELEGRAM_WEB_UNSAFE_PATH", `${label} must name a dedicated child directory, not a filesystem, home, temp, or workspace root.`);
  }
  const workspaceRelative = path.relative(normalized, process.cwd());
  const materializedRuntimeRelative = path.relative(
    path.join(normalized, "workspace-bridge", "skill-runtimes"),
    process.cwd(),
  );
  const exactMaterializedRuntimeException = allowMaterializedRuntimeAncestor
    && materializedRuntimeRelative !== ""
    && !materializedRuntimeRelative.startsWith("..")
    && !path.isAbsolute(materializedRuntimeRelative);
  if (!workspaceRelative.startsWith("..")
    && !path.isAbsolute(workspaceRelative)
    && !exactMaterializedRuntimeException) {
    fail("TELEGRAM_WEB_UNSAFE_PATH", `${label} cannot be the workspace or one of its ancestor directories.`);
  }
  const baseInsideWorkspace = path.relative(process.cwd(), normalized);
  if (!baseInsideWorkspace.startsWith("..") && !path.isAbsolute(baseInsideWorkspace)) {
    fail("TELEGRAM_WEB_UNSAFE_PATH", `${label} cannot be inside the current workspace.`);
  }
  return normalized;
};

export const parseArguments = (argv) => {
  const options = {
    command: "",
    subcommand: "",
    chats: [],
    query: "",
    contact: "",
    title: "",
    members: [],
    message: "",
    messageFile: "",
    files: [],
    avatar: "",
    output: "",
    messageId: "",
    deleteScope: "",
    reaction: "",
    toChat: "",
    attachmentIndex: 1,
    limit: 20,
    pages: 1,
    iterations: 1,
    intervalMs: 15_000,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    holdMs: 10 * 60_000,
    sendMode: "",
    headed: false,
    confirm: false,
    dryRun: false,
    approvalHash: "",
    account: 0,
    providedFlags: new Set(),
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token.startsWith("--")) options.providedFlags.add(token);
    const takeValue = () => {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) {
        fail("TELEGRAM_WEB_INVALID_ARGUMENT", `${token} requires a value.`);
      }
      index += 1;
      return value;
    };

    if (!options.command && !token.startsWith("--")) options.command = token;
    else if (["consent", "policy"].includes(options.command) && !options.subcommand && !token.startsWith("--")) {
      options.subcommand = token;
    } else if (token === "--chat") options.chats.push(takeValue());
    else if (token === "--query") options.query = takeValue();
    else if (token === "--contact") options.contact = takeValue();
    else if (token === "--title") options.title = takeValue();
    else if (token === "--member") options.members.push(takeValue());
    else if (token === "--message") options.message = takeValue();
    // Preserve exact local path spelling. Security-sensitive input paths are
    // validated as canonical absolute paths before they are opened; silently
    // resolving a relative or dot-segment path would bind approval to a path
    // the user did not actually type.
    else if (token === "--message-file") options.messageFile = takeValue();
    else if (token === "--file") options.files.push(takeValue());
    else if (token === "--avatar") options.avatar = takeValue();
    // Download publication is a security boundary, not a convenience input.
    // Preserve the exact user argument so a relative or dot-segment path is
    // rejected rather than silently rebound to the runtime's current cwd.
    else if (token === "--output") options.output = takeValue();
    else if (token === "--message-id") options.messageId = takeValue();
    else if (token === "--delete-scope") options.deleteScope = takeValue();
    else if (token === "--reaction") options.reaction = takeValue();
    else if (token === "--to-chat") options.toChat = takeValue();
    else if (token === "--attachment-index") options.attachmentIndex = parseInteger(takeValue(), 1, 100, "--attachment-index");
    else if (token === "--account") options.account = parseInteger(takeValue(), 1, 4, "--account");
    else if (token === "--limit") options.limit = parseInteger(takeValue(), 1, MAX_HISTORY_MESSAGES, "--limit");
    else if (token === "--pages") options.pages = parseInteger(takeValue(), 1, MAX_HISTORY_PAGES, "--pages");
    else if (token === "--iterations") options.iterations = parseInteger(takeValue(), 1, MAX_WATCH_ITERATIONS, "--iterations");
    else if (token === "--interval-ms") options.intervalMs = parseInteger(takeValue(), MIN_WATCH_INTERVAL_MS, MAX_WATCH_INTERVAL_MS, "--interval-ms");
    else if (token === "--timeout-ms") options.timeoutMs = parseInteger(takeValue(), 5_000, 300_000, "--timeout-ms");
    else if (token === "--hold-ms") options.holdMs = parseInteger(takeValue(), 10_000, 3_600_000, "--hold-ms");
    else if (token === "--send-mode") options.sendMode = takeValue();
    else if (token === "--headed") options.headed = true;
    else if (token === "--headless") options.headed = false;
    else if (token === "--confirm") options.confirm = true;
    else if (token === "--dry-run") options.dryRun = true;
    else if (token === "--approval-hash") options.approvalHash = takeValue();
    else if (token === "--help" || token === "-h") options.command = "help";
    else fail("TELEGRAM_WEB_INVALID_ARGUMENT", `Unknown argument: ${token}`);
  }

  if (!RECOGNIZED_COMMANDS.has(options.command)) {
    fail("TELEGRAM_WEB_UNSUPPORTED_COMMAND", `Unsupported Telegram Web command: ${options.command || "(missing)"}.`);
  }
  if (options.command === "status") options.command = "access-status";
  if (options.files.length > MAX_FILES) fail("TELEGRAM_WEB_INVALID_ARGUMENT", `At most ${MAX_FILES} --file values are allowed.`);
  if (options.members.length > MAX_MEMBERS) fail("TELEGRAM_WEB_INVALID_ARGUMENT", `At most ${MAX_MEMBERS} --member values are allowed.`);
  if (options.chats.length > MAX_EXACT_CHATS) fail("TELEGRAM_WEB_INVALID_ARGUMENT", `At most ${MAX_EXACT_CHATS} exact --chat values are allowed.`);
  if (options.messageId) {
    requireExactPositiveSafeDecimal(
      options.messageId,
      "TELEGRAM_WEB_INVALID_ARGUMENT",
      "--message-id must be one canonical positive JavaScript-safe Telegram message ID.",
    );
  }
  if (options.deleteScope && !["me", "everyone"].includes(options.deleteScope)) {
    fail("TELEGRAM_WEB_INVALID_ARGUMENT", "--delete-scope must be me or everyone.");
  }
  if (options.approvalHash && !/^[0-9a-f]{64}$/u.test(options.approvalHash)) {
    fail("TELEGRAM_WEB_INVALID_ARGUMENT", "--approval-hash must be a lowercase SHA-256 digest.");
  }
  if (options.command === "search" && options.chats.length * options.limit > MAX_SEARCH_RESULTS_TOTAL) {
    fail(
      "TELEGRAM_WEB_INVALID_ARGUMENT",
      `search may request at most ${MAX_SEARCH_RESULTS_TOTAL} results in aggregate; reduce --limit or the number of exact --chat targets.`,
    );
  }
  validateCommandContract(options);
  return options;
};

const usage = () => `
Trelio Telegram Web runtime (Web K, chat-only)

Commands:
  bootstrap | doctor | probe | access-status
  login [--hold-ms MS] | inspect --account SLOT [--hold-ms MS] (headed read-only)
  logout --dry-run (headed owner handoff) | forget --dry-run
  consent status | consent accept | consent revoke --confirm
  policy show | policy set --send-mode confirm|autonomous|read-only --confirm
  dialogs --query EXACT_OR_PREFIX --limit N
  read --chat EXACT --limit N --pages N
  search --chat EXACT [--chat EXACT...] --query TEXT --limit N
  unread --chat EXACT [--chat EXACT...] | watch --chat EXACT [--chat EXACT...]
  download --chat EXACT --message-id ID --attachment-index N --output PATH --pages N
  send --chat EXACT (--message TEXT | --file ABSOLUTE_PATH [--message CAPTION]) --dry-run
  reply --chat EXACT --message-id ID --message TEXT --pages N --dry-run
  edit --chat EXACT --message-id ID --message TEXT --pages N --dry-run
  delete --chat EXACT --message-id ID --delete-scope me|everyone --pages N --dry-run
  archive|unarchive|mute|unmute|pin|unpin|mark-unread --chat EXACT --dry-run
  create-direct --contact @username --message TEXT --dry-run

In confirm policy, send/reply and every structural mutation use two steps:
  1. Run the exact command with --dry-run.
  2. Repeat it once with --confirm --approval-hash HASH.
The hash is connection/account/slot-bound, expires after 10 minutes, and is
consumed before the decisive click even if the mutation later becomes ambiguous.
Every account-specific public result and dry-run operation displays canonical
accountSlot 1..4 without exposing a raw Telegram account id or private digest.
One-document send always requires that exact two-step approval, even when the
local text-send policy is autonomous, because local bytes cross into Telegram.

Verified file sending is one non-empty regular local file, at most 64 MiB,
sent as one ungrouped Telegram document. The exact canonical absolute path,
name, size, SHA-256, caption, chat, and document-only options are approval-bound.

read/search return bounded author/date/text, at most 32 safe link entities, and
at most one 2000-character reply context. Opaque PeerId is routing metadata,
never an inputPeer/access_hash capability; Saved Messages redacts it.

Unsupported in the 1.0.2 pilot (returns TELEGRAM_WEB_UNSUPPORTED_OPERATION):
  react, forward, reply/create-direct files, media conversion/albums,
  audio/OGG/GIF/TGS document remapping, create-group, members,
  member-add, member-remove, chat-update, bot commands, dice-media,
  Markdown/rich transformations, automatic message splitting, migrated-peer
  sends, Stars/paid messages/payments, topics/monoforums, scheduled and other
  non-normal chat surfaces, calls, Mini Apps, admin actions, and bulk mutation.

watch is exactly one bounded sidebar snapshot. Repeat it only through an
external scheduler that starts a fresh invocation; in-process watch loops are
unsupported. logout opens the dedicated headed profile and waits for the
account owner to perform and verify logout personally; runtime-driven logout
clicks are unsupported. inspect opens the exact canonical account-slot URL in
the dedicated headed profile, performs no runtime click or cleanup, requires no
content consent, and never claims that a composer was repaired.
`.trim();

const validateCommandContract = (options) => {
  const browser = ["--account", "--timeout-ms", "--headed", "--headless"];
  const approval = ["--dry-run", "--confirm", "--approval-hash"];
  const message = ["--message", "--message-file"];
  const files = ["--file"];
  const allowedByCommand = {
    help: ["--help"],
    bootstrap: [],
    doctor: [],
    probe: browser,
    "access-status": browser,
    inspect: ["--account", "--timeout-ms", "--hold-ms", "--headed"],
    login: ["--account", "--timeout-ms", "--hold-ms", "--headed"],
    logout: ["--account", "--timeout-ms", "--hold-ms", "--headed", ...approval],
    forget: approval,
    consent: options.subcommand === "revoke" ? ["--confirm"] : browser,
    policy: options.subcommand === "set" ? ["--send-mode", "--confirm"] : [],
    dialogs: [...browser, "--query", "--limit"],
    read: [...browser, "--chat", "--limit", "--pages"],
    search: [...browser, "--chat", "--query", "--limit"],
    unread: [...browser, "--chat"],
    watch: [...browser, "--chat", "--iterations", "--interval-ms"],
    download: [...browser, "--chat", "--message-id", "--attachment-index", "--output", "--pages"],
    send: [...browser, "--chat", ...message, ...files, ...approval],
    reply: [...browser, "--chat", "--message-id", "--pages", ...message, ...files, ...approval],
    react: [...browser, "--chat", "--message-id", "--reaction", "--confirm"],
    edit: [...browser, "--chat", "--message-id", "--pages", ...message, ...approval],
    delete: [...browser, "--chat", "--message-id", "--pages", "--delete-scope", ...approval],
    forward: [...browser, "--chat", "--message-id", "--to-chat", ...approval],
    archive: [...browser, "--chat", ...approval],
    unarchive: [...browser, "--chat", ...approval],
    mute: [...browser, "--chat", ...approval],
    unmute: [...browser, "--chat", ...approval],
    pin: [...browser, "--chat", ...approval],
    unpin: [...browser, "--chat", ...approval],
    "mark-unread": [...browser, "--chat", ...approval],
    "create-direct": [...browser, "--contact", ...message, ...files, ...approval],
    "create-group": [...browser, "--title", "--member", "--avatar", ...approval],
    members: [...browser, "--chat", "--limit"],
    "member-add": [...browser, "--chat", "--member", ...approval],
    "member-remove": [...browser, "--chat", "--member", ...approval],
    "chat-update": [...browser, "--chat", "--title", "--avatar", ...approval],
  };
  const allowed = new Set(allowedByCommand[options.command] || []);
  if (options.command === "inspect") {
    if (!options.providedFlags.has("--account")) {
      fail("TELEGRAM_WEB_INVALID_ARGUMENT", "inspect requires one explicit canonical --account slot from 1 through 4.");
    }
    if (options.providedFlags.has("--headless")) {
      fail("TELEGRAM_WEB_INVALID_ARGUMENT", "inspect is an explicitly headed manual handoff and rejects --headless.");
    }
  }
  for (const flag of options.providedFlags) {
    if (!allowed.has(flag)) fail("TELEGRAM_WEB_INVALID_ARGUMENT", `${flag} is not valid for ${options.command}.`);
  }
  if (options.providedFlags.has("--headed") && options.providedFlags.has("--headless")) {
    fail("TELEGRAM_WEB_INVALID_ARGUMENT", "--headed and --headless are mutually exclusive.");
  }
  if (options.message && options.messageFile) fail("TELEGRAM_WEB_INVALID_ARGUMENT", "Use either --message or --message-file, not both.");
  if (options.dryRun && (options.confirm || options.approvalHash)) {
    fail("TELEGRAM_WEB_INVALID_ARGUMENT", "--dry-run cannot be combined with --confirm or --approval-hash.");
  }
  if (options.approvalHash && !options.confirm) fail("TELEGRAM_WEB_INVALID_ARGUMENT", "--approval-hash requires --confirm.");
  if (new Set(options.files).size !== options.files.length) fail("TELEGRAM_WEB_INVALID_ARGUMENT", "Repeated --file paths are not allowed.");
  if (new Set(options.chats).size !== options.chats.length) fail("TELEGRAM_WEB_INVALID_ARGUMENT", "Repeated exact --chat values are not allowed.");
};

export const requireRuntimeIdentity = (environment = process.env) => {
  const identity = {
    skillId: String(environment.TRELIO_SKILL_ID || ""),
    runtimeVersion: String(environment.TRELIO_SKILL_RUNTIME_VERSION || ""),
    companyId: String(environment.TRELIO_SKILL_COMPANY_ID || "").toLowerCase(),
    memberId: String(environment.TRELIO_SKILL_MEMBER_ID || "").toLowerCase(),
    connectionId: String(environment.TRELIO_SKILL_CONNECTION_ID || "").toLowerCase(),
  };
  if (identity.skillId !== SKILL_ID) fail("TELEGRAM_WEB_INVALID_IDENTITY", `Runtime must be resolved for ${SKILL_ID}.`);
  if (!VERSION_PATTERN.test(identity.runtimeVersion)) fail("TELEGRAM_WEB_INVALID_IDENTITY", "TRELIO_SKILL_RUNTIME_VERSION is missing or invalid.");
  for (const key of ["companyId", "memberId", "connectionId"]) {
    if (!UUID_PATTERN.test(identity[key])) fail("TELEGRAM_WEB_INVALID_IDENTITY", `Trusted ${key} is missing or invalid.`);
  }

  let config;
  try {
    config = JSON.parse(String(environment.TRELIO_SKILL_CONNECTION_CONFIG_JSON || ""));
  } catch {
    fail("TELEGRAM_WEB_INVALID_CONFIG", "Trusted Telegram Web company config is missing or invalid.");
  }
  if (
    !config
    || typeof config !== "object"
    || Array.isArray(config)
    || Object.keys(config).some((key) => key !== "allowAutonomous")
    || typeof config.allowAutonomous !== "boolean"
  ) {
    fail("TELEGRAM_WEB_INVALID_CONFIG", "Telegram Web config must contain only boolean allowAutonomous.");
  }
  return { ...identity, allowAutonomous: config.allowAutonomous };
};

const resolveConfigHome = (environment = process.env) => {
  if (environment.TRELIO_CONFIG_HOME) {
    return validateDedicatedBase(environment.TRELIO_CONFIG_HOME, "TRELIO_CONFIG_HOME");
  }
  if (process.platform === "win32") {
    if (!environment.LOCALAPPDATA || !path.isAbsolute(environment.LOCALAPPDATA)) {
      fail("TELEGRAM_WEB_UNSAFE_PATH", "LOCALAPPDATA is missing or invalid.");
    }
    return validateDedicatedBase(path.join(environment.LOCALAPPDATA, "Trelio"), "resolved LOCALAPPDATA config root");
  }
  if (environment.XDG_CONFIG_HOME) {
    if (!path.isAbsolute(environment.XDG_CONFIG_HOME)) fail("TELEGRAM_WEB_UNSAFE_PATH", "XDG_CONFIG_HOME must be absolute.");
    return validateDedicatedBase(path.join(environment.XDG_CONFIG_HOME, "trelio"), "resolved XDG_CONFIG_HOME");
  }
  return validateDedicatedBase(path.join(os.homedir(), ".config", "trelio"), "default Trelio config root");
};

const resolveCacheHome = (environment = process.env) => {
  if (environment.TRELIO_CACHE_HOME) {
    return validateDedicatedBase(environment.TRELIO_CACHE_HOME, "TRELIO_CACHE_HOME");
  }
  if (process.platform === "win32") {
    if (!environment.LOCALAPPDATA || !path.isAbsolute(environment.LOCALAPPDATA)) fail("TELEGRAM_WEB_UNSAFE_PATH", "LOCALAPPDATA is missing or invalid.");
    return validateDedicatedBase(path.join(environment.LOCALAPPDATA, "Trelio", "cache"), "resolved LOCALAPPDATA cache root");
  }
  if (environment.XDG_CACHE_HOME) {
    if (!path.isAbsolute(environment.XDG_CACHE_HOME)) fail("TELEGRAM_WEB_UNSAFE_PATH", "XDG_CACHE_HOME must be absolute.");
    return validateDedicatedBase(path.join(environment.XDG_CACHE_HOME, "trelio"), "resolved XDG_CACHE_HOME");
  }
  return validateDedicatedBase(
    path.join(os.homedir(), ".cache", "trelio"),
    "default Trelio cache root",
    { allowMaterializedRuntimeAncestor: true },
  );
};

export const connectionRoot = (identity, environment = process.env) => path.join(
  resolveConfigHome(environment),
  "integrations",
  SKILL_ID,
  identity.companyId,
  identity.memberId,
  identity.connectionId,
);

const runtimeRoot = (identity, environment = process.env) => path.join(
  resolveCacheHome(environment),
  "runtimes",
  SKILL_ID,
  identity.runtimeVersion,
);

export const runtimeLocations = (identity, environment = process.env) => {
  const root = connectionRoot(identity, environment);
  return {
    root,
    policyFile: path.join(root, "config", "policy.json"),
    consentFile: path.join(root, "config", "consent.json"),
    accountFile: path.join(root, "config", "account.json"),
    pendingApprovalFile: path.join(root, "state", "pending-approval.json"),
    consentGenerationFile: path.join(root, "state", "consent-generation.json"),
    consentLockFile: path.join(root, "state", "consent-state.lock"),
    browserDirectory: path.join(root, "browser"),
    profileDirectory: path.join(root, "browser", "chrome-profile"),
    downloadStagingDirectory: path.join(root, "browser", "download-staging"),
    lockFile: path.join(root, "state", "profile.lock"),
  };
};

// Windows has no chmod-equivalent privacy guarantee. This script installs a
// protected DACL that grants only the current user FullControl, then reads the
// owner and DACL back. A failure is fatal: the runtime never stores Telegram
// cookies, consent, policy, or browser cache under an inherited broad ACL.
export const WINDOWS_PRIVATE_ACL_SCRIPT = String.raw`
$ErrorActionPreference = "Stop"
$encodedTargetPath = [Environment]::GetEnvironmentVariable("TRELIO_WINDOWS_PRIVATE_ACL_PATH_BASE64", [EnvironmentVariableTarget]::Process)
$TargetKind = [Environment]::GetEnvironmentVariable("TRELIO_WINDOWS_PRIVATE_ACL_KIND", [EnvironmentVariableTarget]::Process)
$AclMode = [Environment]::GetEnvironmentVariable("TRELIO_WINDOWS_PRIVATE_ACL_MODE", [EnvironmentVariableTarget]::Process)
if ([string]::IsNullOrWhiteSpace($encodedTargetPath)) { throw "Private path transport is missing." }
$TargetPath = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($encodedTargetPath))
if ([string]::IsNullOrWhiteSpace($TargetPath)) { throw "Private path transport decoded an empty path." }
if ($TargetKind -ne "directory" -and $TargetKind -ne "file") { throw "Private path kind is invalid." }
if ($AclMode -ne "install" -and $AclMode -ne "strict" -and $AclMode -ne "base") { throw "Private ACL mode is invalid." }
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
if ($TargetKind -eq "directory") {
  $targetInfo = New-Object System.IO.DirectoryInfo($TargetPath)
  $ownerAcl = New-Object System.Security.AccessControl.DirectorySecurity
  $acl = New-Object System.Security.AccessControl.DirectorySecurity
  $rule = New-Object System.Security.AccessControl.FileSystemAccessRule(
    $sid,
    [System.Security.AccessControl.FileSystemRights]::FullControl,
    [System.Security.AccessControl.InheritanceFlags]"ContainerInherit, ObjectInherit",
    [System.Security.AccessControl.PropagationFlags]::None,
    [System.Security.AccessControl.AccessControlType]::Allow
  )
} else {
  $targetInfo = New-Object System.IO.FileInfo($TargetPath)
  $ownerAcl = New-Object System.Security.AccessControl.FileSecurity
  $acl = New-Object System.Security.AccessControl.FileSecurity
  $rule = New-Object System.Security.AccessControl.FileSystemAccessRule(
    $sid,
    [System.Security.AccessControl.FileSystemRights]::FullControl,
    [System.Security.AccessControl.AccessControlType]::Allow
  )
}
$ownerSecurity = $targetInfo.GetAccessControl([System.Security.AccessControl.AccessControlSections]::Owner)
$ownerSid = $ownerSecurity.GetOwner([System.Security.Principal.SecurityIdentifier]).Value
if ($AclMode -eq "install") {
  if ($ownerSid -ne $sid.Value) {
    $ownerAcl.SetOwner($sid)
    $targetInfo.SetAccessControl($ownerAcl)
  }
  $acl.SetAccessRuleProtection($true, $false)
  $acl.SetAccessRule($rule)
  $targetInfo.SetAccessControl($acl)
}
$sections = ([System.Security.AccessControl.AccessControlSections]::Access -bor [System.Security.AccessControl.AccessControlSections]::Owner)
$verified = $targetInfo.GetAccessControl($sections)
if ($verified.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $sid.Value) { throw "Private path owner verification failed." }
if ($AclMode -eq "base") {
  $broadSids = @("S-1-1-0", "S-1-5-11", "S-1-5-32-545")
  $unsafeRights = ([System.Security.AccessControl.FileSystemRights]::Write -bor [System.Security.AccessControl.FileSystemRights]::Modify -bor [System.Security.AccessControl.FileSystemRights]::FullControl)
  $unsafeBase = @($verified.Access | Where-Object {
    $_.AccessControlType -eq [System.Security.AccessControl.AccessControlType]::Allow -and
    $broadSids -contains $_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value -and
    ($_.FileSystemRights -band $unsafeRights) -ne 0
  })
  if ($unsafeBase.Count -ne 0) { throw "Trusted base grants broad write access." }
  exit 0
}
$unexpected = @($verified.Access | Where-Object {
  $_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value -ne $sid.Value -or
  $_.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow -or
  $_.IsInherited
})
if ($unexpected.Count -ne 0) { throw "Private path ACL verification failed." }
$expected = @($verified.Access | Where-Object {
  $_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value -eq $sid.Value -and
  $_.AccessControlType -eq [System.Security.AccessControl.AccessControlType]::Allow -and
  -not $_.IsInherited -and
  ($_.FileSystemRights -band [System.Security.AccessControl.FileSystemRights]::FullControl) -eq [System.Security.AccessControl.FileSystemRights]::FullControl
})
if ($expected.Count -eq 0) { throw "Private path current-user ACL verification failed." }
`;

// Download output lives outside Trelio's private namespace, so it cannot be
// hardened by replacing the user's existing ACL.  Instead, Windows performs a
// read-only trust-chain check: the exact output parent must belong to the
// current user, no component may be a reparse point, and no untrusted principal
// may have rights that let it replace the parent or one of its descendants.
// SYSTEM, Administrators, and service-owned machine roots remain trusted OS
// principals; ordinary Users/Authenticated Users may retain read-only access.
export const WINDOWS_OUTPUT_PARENT_ACL_SCRIPT = String.raw`
$ErrorActionPreference = "Stop"
$encodedTargetPath = [Environment]::GetEnvironmentVariable("TRELIO_WINDOWS_OUTPUT_PARENT_PATH_BASE64", [EnvironmentVariableTarget]::Process)
if ([string]::IsNullOrWhiteSpace($encodedTargetPath)) { throw "Output parent transport is missing." }
$TargetPath = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($encodedTargetPath))
if ([string]::IsNullOrWhiteSpace($TargetPath)) { throw "Output parent transport decoded an empty path." }
$fullPath = [System.IO.Path]::GetFullPath($TargetPath)
$currentSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$trustedExactSids = @($currentSid, "S-1-5-18", "S-1-5-32-544")
$unsafeExactRights = (
  [System.Security.AccessControl.FileSystemRights]::Write -bor
  [System.Security.AccessControl.FileSystemRights]::Modify -bor
  [System.Security.AccessControl.FileSystemRights]::FullControl -bor
  [System.Security.AccessControl.FileSystemRights]::Delete -bor
  [System.Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor
  [System.Security.AccessControl.FileSystemRights]::ChangePermissions -bor
  [System.Security.AccessControl.FileSystemRights]::TakeOwnership
)
$unsafeAncestorRights = (
  [System.Security.AccessControl.FileSystemRights]::Modify -bor
  [System.Security.AccessControl.FileSystemRights]::FullControl -bor
  [System.Security.AccessControl.FileSystemRights]::Delete -bor
  [System.Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor
  [System.Security.AccessControl.FileSystemRights]::ChangePermissions -bor
  [System.Security.AccessControl.FileSystemRights]::TakeOwnership
)
$cursor = New-Object System.IO.DirectoryInfo($fullPath)
$isExactParent = $true
while ($null -ne $cursor) {
  if (-not $cursor.Exists) { throw "Output parent ancestor is missing." }
  if (($cursor.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw "Output parent ancestor is a reparse point."
  }
  $sections = ([System.Security.AccessControl.AccessControlSections]::Access -bor [System.Security.AccessControl.AccessControlSections]::Owner)
  $acl = $cursor.GetAccessControl($sections)
  $ownerSid = $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value
  if ($isExactParent -and $ownerSid -ne $currentSid) { throw "Output parent is not owned by the current user." }
  if (-not $isExactParent -and
      $trustedExactSids -notcontains $ownerSid -and
      -not $ownerSid.StartsWith("S-1-5-80-", [System.StringComparison]::Ordinal)) {
    throw "Output parent ancestor has an untrusted owner."
  }
  $unsafeRights = if ($isExactParent) { $unsafeExactRights } else { $unsafeAncestorRights }
  $unsafe = @($acl.Access | Where-Object {
    $aceSid = $_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value
    $_.AccessControlType -eq [System.Security.AccessControl.AccessControlType]::Allow -and
    $trustedExactSids -notcontains $aceSid -and
    -not $aceSid.StartsWith("S-1-5-80-", [System.StringComparison]::Ordinal) -and
    ($_.FileSystemRights -band $unsafeRights) -ne 0
  })
  if ($unsafe.Count -ne 0) { throw "Output parent chain grants unsafe write or replacement access." }
  $cursor = $cursor.Parent
  $isExactParent = $false
}
`;

// Program Files is a location hint, not by itself an ACL proof. Verify every
// selected browser component from the executable back to its exact declared
// Program Files boundary. Only the current user (same-user machine trust),
// SYSTEM, Administrators, CREATOR OWNER, and Windows service principals may
// carry write/replacement rights; ordinary Users/Authenticated Users may read.
export const WINDOWS_MACHINE_EXECUTABLE_ACL_SCRIPT = String.raw`
$ErrorActionPreference = "Stop"
$encodedTarget = [Environment]::GetEnvironmentVariable("TRELIO_WINDOWS_MACHINE_EXECUTABLE_PATH_BASE64", [EnvironmentVariableTarget]::Process)
$encodedBoundary = [Environment]::GetEnvironmentVariable("TRELIO_WINDOWS_MACHINE_EXECUTABLE_BOUNDARY_BASE64", [EnvironmentVariableTarget]::Process)
if ([string]::IsNullOrWhiteSpace($encodedTarget) -or [string]::IsNullOrWhiteSpace($encodedBoundary)) {
  throw "Machine executable ACL transport is missing."
}
$TargetPath = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($encodedTarget))
$BoundaryPath = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($encodedBoundary))
$targetFull = [System.IO.Path]::GetFullPath($TargetPath)
$boundaryFull = [System.IO.Path]::GetFullPath($BoundaryPath).TrimEnd([System.IO.Path]::DirectorySeparatorChar)
if (-not $targetFull.StartsWith($boundaryFull + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "Machine executable escaped Program Files boundary."
}
$currentSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$trustedSids = @($currentSid, "S-1-5-18", "S-1-5-32-544", "S-1-3-0")
$unsafeRights = (
  [System.Security.AccessControl.FileSystemRights]::Write -bor
  [System.Security.AccessControl.FileSystemRights]::Modify -bor
  [System.Security.AccessControl.FileSystemRights]::FullControl -bor
  [System.Security.AccessControl.FileSystemRights]::Delete -bor
  [System.Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor
  [System.Security.AccessControl.FileSystemRights]::ChangePermissions -bor
  [System.Security.AccessControl.FileSystemRights]::TakeOwnership
)
$cursor = New-Object System.IO.FileInfo($targetFull)
$reachedBoundary = $false
while ($null -ne $cursor) {
  if (-not $cursor.Exists) { throw "Machine executable component is missing." }
  if (($cursor.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw "Machine executable component is a reparse point."
  }
  $sections = ([System.Security.AccessControl.AccessControlSections]::Access -bor [System.Security.AccessControl.AccessControlSections]::Owner)
  $acl = $cursor.GetAccessControl($sections)
  $ownerSid = $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value
  if ($trustedSids -notcontains $ownerSid -and -not $ownerSid.StartsWith("S-1-5-80-", [System.StringComparison]::Ordinal)) {
    throw "Machine executable component has an untrusted owner."
  }
  $unsafe = @($acl.Access | Where-Object {
    $aceSid = $_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value
    $_.AccessControlType -eq [System.Security.AccessControl.AccessControlType]::Allow -and
    $trustedSids -notcontains $aceSid -and
    -not $aceSid.StartsWith("S-1-5-80-", [System.StringComparison]::Ordinal) -and
    ($_.FileSystemRights -band $unsafeRights) -ne 0
  })
  if ($unsafe.Count -ne 0) { throw "Machine executable component grants unsafe write or replacement access." }
  if ($cursor.FullName.TrimEnd([System.IO.Path]::DirectorySeparatorChar).Equals($boundaryFull, [System.StringComparison]::OrdinalIgnoreCase)) {
    $reachedBoundary = $true
    break
  }
  $cursor = $cursor.Parent
}
if (-not $reachedBoundary) { throw "Machine executable ACL walk did not reach Program Files boundary." }
`;

export const buildWindowsPrivateAclPowerShellInvocation = (targetPath, targetKind, mode = "strict") => {
  if (!targetPath || !["directory", "file"].includes(targetKind) || !["install", "strict", "base"].includes(mode)) {
    fail("TELEGRAM_WEB_UNSAFE_PATH", "Windows private path ACL invocation is invalid.");
  }
  return {
    args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", WINDOWS_PRIVATE_ACL_SCRIPT],
    environment: {
      TRELIO_WINDOWS_PRIVATE_ACL_PATH_BASE64: Buffer.from(targetPath, "utf8").toString("base64"),
      TRELIO_WINDOWS_PRIVATE_ACL_KIND: targetKind,
      TRELIO_WINDOWS_PRIVATE_ACL_MODE: mode,
    },
  };
};

export const resolveTrustedWindowsSystemExecutable = async (environment, relativeExecutable) => {
  // Trust boundary: the signed desktop host must pass the real inherited OS
  // environment. Pure Node cannot provide WinVerifyTrust/GetSystemDirectoryW;
  // these checks are fail-closed consistency checks, not a cryptographic proof
  // of the Windows installation.
  const declaredSystemRoot = String(environment.SystemRoot || environment.SYSTEMROOT || "");
  const declaredWinDir = String(environment.windir || environment.WINDIR || "");
  const systemRoot = path.normalize(declaredSystemRoot);
  const winDir = path.normalize(declaredWinDir);
  if (
    !path.isAbsolute(systemRoot)
    || !/^[A-Za-z]:[\\/]/u.test(systemRoot)
    || systemRoot.startsWith("\\\\")
    || systemRoot === path.parse(systemRoot).root
    || path.basename(systemRoot).toLocaleLowerCase("en-US") !== "windows"
    || systemRoot.toLocaleLowerCase("en-US") !== winDir.toLocaleLowerCase("en-US")
  ) {
    fail("TELEGRAM_WEB_UNSAFE_PATH", "Windows SystemRoot is missing or invalid.");
  }
  const rootMetadata = await lstat(systemRoot).catch(() => null);
  if (!rootMetadata || rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory()) {
    fail("TELEGRAM_WEB_UNSAFE_PATH", "Windows SystemRoot has an unsafe type.");
  }
  const protectedComparands = [process.cwd(), os.homedir(), os.tmpdir()].map((value) => path.normalize(value));
  for (const candidate of protectedComparands) {
    const rootToCandidate = path.relative(systemRoot, candidate);
    const candidateToRoot = path.relative(candidate, systemRoot);
    const overlaps = (!rootToCandidate.startsWith("..") && !path.isAbsolute(rootToCandidate))
      || (!candidateToRoot.startsWith("..") && !path.isAbsolute(candidateToRoot));
    if (overlaps) fail("TELEGRAM_WEB_UNSAFE_PATH", "Windows SystemRoot overlaps an untrusted workspace, home, or temporary directory.");
  }
  const expectedCommandProcessor = path.join(systemRoot, "System32", "cmd.exe");
  if (path.normalize(String(environment.ComSpec || "")).toLocaleLowerCase("en-US") !== expectedCommandProcessor.toLocaleLowerCase("en-US")) {
    fail("TELEGRAM_WEB_UNSAFE_PATH", "Windows ComSpec does not match the declared SystemRoot.");
  }
  if (!relativeExecutable || path.isAbsolute(relativeExecutable) || relativeExecutable.split(/[\\/]/u).includes("..")) {
    fail("TELEGRAM_WEB_UNSAFE_PATH", "Windows system executable name is invalid.");
  }
  const executable = path.join(path.normalize(systemRoot), "System32", ...relativeExecutable.split(/[\\/]/u));
  const metadata = await lstat(executable).catch(() => null);
  if (!metadata || metadata.isSymbolicLink() || !metadata.isFile()) {
    fail("TELEGRAM_WEB_UNSAFE_PATH", "A required absolute Windows system executable is missing or has an unsafe type.");
  }
  if ((await realpath(executable)).toLocaleLowerCase("en-US") !== path.resolve(executable).toLocaleLowerCase("en-US")) {
    fail("TELEGRAM_WEB_UNSAFE_PATH", "A required Windows system executable resolves through a reparse point.");
  }
  return executable;
};

const verifyWindowsPrivatePath = async (targetPath, targetKind, mode, environment = process.env) => {
  const invocation = buildWindowsPrivateAclPowerShellInvocation(targetPath, targetKind, mode);
  const powershell = await resolveTrustedWindowsSystemExecutable(
    environment,
    path.join("WindowsPowerShell", "v1.0", "powershell.exe"),
  );
  try {
    await execFileAsync(powershell, invocation.args, {
      encoding: "utf8",
      env: { ...environment, ...invocation.environment },
      cwd: path.dirname(powershell),
      windowsHide: true,
      timeout: 30_000,
      killSignal: "SIGTERM",
      maxBuffer: 256 * 1024,
    });
  } catch {
    fail("TELEGRAM_WEB_WINDOWS_ACL_FAILED", "Could not verify the required Windows ACL for Telegram Web local state without broadening access.");
  }
};

const verifyWindowsOutputParent = async (targetPath, environment = process.env) => {
  const powershell = await resolveTrustedWindowsSystemExecutable(
    environment,
    path.join("WindowsPowerShell", "v1.0", "powershell.exe"),
  );
  try {
    await execFileAsync(powershell, [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      WINDOWS_OUTPUT_PARENT_ACL_SCRIPT,
    ], {
      encoding: "utf8",
      env: {
        ...environment,
        TRELIO_WINDOWS_OUTPUT_PARENT_PATH_BASE64: Buffer.from(targetPath, "utf8").toString("base64"),
      },
      cwd: path.dirname(powershell),
      windowsHide: true,
      timeout: 30_000,
      killSignal: "SIGTERM",
      maxBuffer: 256 * 1024,
    });
  } catch {
    fail(
      "TELEGRAM_WEB_UNSAFE_PATH",
      "The download output parent or one of its Windows ancestors has an unsafe owner, ACL, or reparse point.",
    );
  }
};

const verifyWindowsMachineExecutableChain = async (targetPath, boundaryPath, environment = process.env) => {
  const powershell = await resolveTrustedWindowsSystemExecutable(
    environment,
    path.join("WindowsPowerShell", "v1.0", "powershell.exe"),
  );
  try {
    await execFileAsync(powershell, [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      WINDOWS_MACHINE_EXECUTABLE_ACL_SCRIPT,
    ], {
      encoding: "utf8",
      env: {
        ...environment,
        TRELIO_WINDOWS_MACHINE_EXECUTABLE_PATH_BASE64: Buffer.from(targetPath, "utf8").toString("base64"),
        TRELIO_WINDOWS_MACHINE_EXECUTABLE_BOUNDARY_BASE64: Buffer.from(boundaryPath, "utf8").toString("base64"),
      },
      cwd: path.dirname(powershell),
      windowsHide: true,
      timeout: 30_000,
      killSignal: "SIGTERM",
      maxBuffer: 256 * 1024,
    });
  } catch {
    fail(
      "TELEGRAM_WEB_UNSAFE_PATH",
      "The selected Windows browser executable chain has an unsafe owner, DACL, or reparse point.",
    );
  }
};

/**
 * Node's stat fields do not expose macOS extended ACLs: a path can be owned by
 * the current user and mode 0700 while an ALLOW ACE still grants another
 * principal add/delete rights. Use the fixed system ls without a shell, under
 * a bounded C-locale invocation, and fail closed on malformed output.
 *
 * `private-leaf` requires no ACL entries at all for Trelio-created secrets.
 * `private-ancestor` permits benign DENY entries (the standard macOS home ACL)
 * but rejects every non-owner ALLOW. `replace-protected` permits read-only
 * ALLOW entries while rejecting rights that can modify or replace descendants.
 */
const assertSafeMacExtendedAcl = async (targetPath, mode, ownerUid) => {
  if (process.platform !== "darwin") return;
  if (!["private-leaf", "private-ancestor", "replace-protected"].includes(mode)
    || !path.isAbsolute(targetPath)
    || /[\u0000-\u001f\u007f]/u.test(targetPath)) {
    fail("TELEGRAM_WEB_UNSAFE_PATH", "The macOS ACL verification request is invalid.");
  }
  const inspector = "/bin/ls";
  const inspectorChain = ["/", "/bin", inspector];
  const snapshots = [];
  for (let index = 0; index < inspectorChain.length; index += 1) {
    const item = inspectorChain[index];
    const metadata = await lstat(item).catch(() => null);
    if (!metadata
      || metadata.isSymbolicLink()
      || (index === inspectorChain.length - 1 ? !metadata.isFile() : !metadata.isDirectory())
      || metadata.uid !== 0
      || (metadata.mode & 0o022) !== 0
      || await realpath(item) !== item) {
      fail("TELEGRAM_WEB_UNSAFE_PATH", "The fixed macOS ACL inspector chain is unsafe.");
    }
    snapshots.push({ item, dev: metadata.dev, ino: metadata.ino, mode: metadata.mode, uid: metadata.uid, gid: metadata.gid });
  }
  let stdout;
  try {
    ({ stdout } = await execFileAsync(inspector, ["-lde", "--", targetPath], {
      encoding: "utf8",
      env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "C", LC_ALL: "C", TZ: "UTC" },
      cwd: "/",
      windowsHide: true,
      timeout: 5_000,
      killSignal: "SIGTERM",
      maxBuffer: 64 * 1024,
    }));
  } catch {
    fail("TELEGRAM_WEB_UNSAFE_PATH", "The fixed macOS ACL inspector could not verify a protected path.");
  }
  for (const snapshot of snapshots) {
    const after = await lstat(snapshot.item).catch(() => null);
    if (!after
      || after.dev !== snapshot.dev
      || after.ino !== snapshot.ino
      || after.mode !== snapshot.mode
      || after.uid !== snapshot.uid
      || after.gid !== snapshot.gid) {
      fail("TELEGRAM_WEB_UNSAFE_PATH", "The fixed macOS ACL inspector changed identity during verification.");
    }
  }
  const lines = String(stdout).replace(/\r/gu, "").split("\n").filter((line) => line.length > 0);
  if (lines.length < 1 || !/^[bcdlps-][rwxStT-]{9}[+@]?\s/u.test(lines[0])) {
    fail("TELEGRAM_WEB_UNSAFE_PATH", "The fixed macOS ACL inspector returned malformed metadata.");
  }
  const entries = lines.slice(1);
  const modeToken = lines[0].split(/\s+/u, 1)[0];
  const headerHasAcl = modeToken.endsWith("+");
  const headerHasExtendedMetadata = modeToken.endsWith("@");
  // BSD ls uses `@` instead of `+` when xattrs and ACLs coexist, while still
  // printing the numbered ACL entries. Therefore `@` legitimately permits
  // either zero or more entries; every emitted entry is parsed below.
  if ((headerHasAcl && entries.length === 0)
    || (!headerHasAcl && !headerHasExtendedMetadata && entries.length !== 0)) {
    fail("TELEGRAM_WEB_UNSAFE_PATH", "The fixed macOS ACL inspector returned inconsistent ACL metadata.");
  }
  if (mode === "private-leaf" && entries.length !== 0) {
    fail("TELEGRAM_WEB_UNSAFE_PATH", "A Trelio-owned private path must not carry an extended macOS ACL.");
  }
  const ownerName = ownerUid === 0 ? "root" : os.userInfo().username;
  const unsafeReplacementRight = /(?:^|,)(?:write|append|add_file|add_subdirectory|delete|delete_child|writeattr|writeextattr|writeowner|writesecurity|chown|file_inherit|directory_inherit|limit_inherit|only_inherit)(?:,|$)/iu;
  for (const line of entries) {
    const match = line.match(/^\s*\d+:\s+(.+?)\s+(allow|deny)\s+(.+)$/iu);
    if (!match) fail("TELEGRAM_WEB_UNSAFE_PATH", "The fixed macOS ACL inspector returned an unrecognized ACL entry.");
    const [, principal, action, rawRights] = match;
    if (action.toLocaleLowerCase("en-US") === "deny") continue;
    const ownerGrant = principal === `user:${ownerName}`;
    const rights = rawRights.replace(/\s+/gu, "").toLocaleLowerCase("en-US");
    if (!ownerGrant && (mode === "private-ancestor" || unsafeReplacementRight.test(rights))) {
      fail("TELEGRAM_WEB_UNSAFE_PATH", "A protected macOS path grants unsafe extended-ACL access to another principal.");
    }
  }
};

/**
 * Prove that another OS principal cannot rename the staging/public leaf while
 * the runtime downloads.  Sticky world-writable ancestors are intentionally
 * rejected too: this contract is for ordinary user-owned folders such as
 * Downloads, not /tmp or another shared exchange directory.  Same-OS-user
 * malware remains outside the runtime threat boundary documented by Trelio.
 */
export const assertTrustedDownloadOutputParent = async (parent, environment = process.env) => {
  const resolvedParent = path.resolve(parent);
  if (!path.isAbsolute(parent) || resolvedParent !== path.normalize(parent)) {
    fail("TELEGRAM_WEB_UNSAFE_PATH", "The download output parent must use one canonical absolute path.");
  }
  if (process.platform === "win32") {
    await verifyWindowsOutputParent(resolvedParent, environment);
    return;
  }
  const currentUserId = typeof process.getuid === "function" ? process.getuid() : null;
  if (!Number.isInteger(currentUserId) || currentUserId < 0) {
    fail("TELEGRAM_WEB_UNSAFE_PATH", "The current POSIX user identity is unavailable for download output verification.");
  }
  const root = path.parse(resolvedParent).root;
  const relativeSegments = path.relative(root, resolvedParent).split(path.sep).filter(Boolean);
  const chain = [root];
  let current = root;
  for (const segment of relativeSegments) {
    current = path.join(current, segment);
    chain.push(current);
  }
  for (let index = 0; index < chain.length; index += 1) {
    const candidate = chain[index];
    const before = await lstat(candidate).catch(() => null);
    if (!before || before.isSymbolicLink() || !before.isDirectory()) {
      fail("TELEGRAM_WEB_UNSAFE_PATH", "The download output parent chain must contain only existing real directories.");
    }
    const exactParent = index === chain.length - 1;
    if ((exactParent && before.uid !== currentUserId)
      || (!exactParent && before.uid !== currentUserId && before.uid !== 0)) {
      fail(
        "TELEGRAM_WEB_UNSAFE_PATH",
        exactParent
          ? "The download output parent must belong to the current user."
          : "A download output ancestor belongs to an untrusted OS principal.",
      );
    }
    // Deliberately reject sticky 01777 roots as well as non-sticky shared
    // roots.  The private temporary and exclusive hard-link publication are
    // safe only under a chain that no other principal can write or replace.
    if ((before.mode & 0o022) !== 0) {
      fail("TELEGRAM_WEB_UNSAFE_PATH", "The download output parent chain must not be group- or world-writable.");
    }
    await assertSafeMacExtendedAcl(candidate, "replace-protected", before.uid);
    const canonical = await realpath(candidate);
    const after = await lstat(candidate);
    if (canonical !== path.resolve(candidate)
      || after.isSymbolicLink()
      || !after.isDirectory()
      || after.dev !== before.dev
      || after.ino !== before.ino) {
      fail("TELEGRAM_WEB_UNSAFE_PATH", "The download output parent chain changed identity or resolved through a symlink.");
    }
  }
};

const assertPrivatePath = async (targetPath, targetKind, environment = process.env, hardenNewPath = false) => {
  const metadata = await lstat(targetPath);
  const correctKind = targetKind === "directory" ? metadata.isDirectory() : metadata.isFile();
  if (metadata.isSymbolicLink() || !correctKind) fail("TELEGRAM_WEB_UNSAFE_PATH", "A Telegram Web private path has an unsafe type.");
  if (process.platform === "win32") {
    await verifyWindowsPrivatePath(targetPath, targetKind, hardenNewPath ? "install" : "strict", environment);
    return;
  }
  const currentUserId = typeof process.getuid === "function" ? process.getuid() : null;
  if (currentUserId !== null && metadata.uid !== currentUserId) fail("TELEGRAM_WEB_UNSAFE_PATH", "A Telegram Web private path belongs to another user.");
  const expected = targetKind === "directory" ? 0o700 : 0o600;
  if ((metadata.mode & 0o777) !== expected) fail("TELEGRAM_WEB_UNSAFE_PATH", `A Telegram Web private ${targetKind} must use mode ${expected.toString(8)}.`);
  await assertSafeMacExtendedAcl(targetPath, "private-leaf", metadata.uid);
  const verified = await lstat(targetPath);
  if (verified.isSymbolicLink()
    || verified.dev !== metadata.dev
    || verified.ino !== metadata.ino
    || verified.mode !== metadata.mode
    || verified.uid !== metadata.uid
    || verified.gid !== metadata.gid) {
    fail("TELEGRAM_WEB_UNSAFE_PATH", "A Telegram Web private path changed identity during ACL verification.");
  }
};

const assertRealPrivateDirectory = async (directory, hardenNewDirectory = false, environment = process.env) => {
  const before = await lstat(directory);
  if (before.isSymbolicLink() || !before.isDirectory()) fail("TELEGRAM_WEB_UNSAFE_PATH", "A Telegram Web private directory has an unsafe type.");
  const currentUserId = typeof process.getuid === "function" ? process.getuid() : null;
  if (currentUserId !== null && before.uid !== currentUserId) fail("TELEGRAM_WEB_UNSAFE_PATH", "A Telegram Web private directory belongs to another user.");
  if (hardenNewDirectory && process.platform !== "win32") await chmod(directory, 0o700);
  const after = await lstat(directory);
  if (after.isSymbolicLink() || !after.isDirectory() || after.dev !== before.dev || after.ino !== before.ino) {
    fail("TELEGRAM_WEB_UNSAFE_PATH", "A Telegram Web private directory changed identity while it was hardened.");
  }
  await assertPrivatePath(directory, "directory", environment, hardenNewDirectory);
};

const assertTrustedBaseDirectory = async (base, created, environment = process.env) => {
  const metadata = await lstat(base);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) fail("TELEGRAM_WEB_UNSAFE_PATH", "A Telegram Web trusted base has an unsafe type.");
  const currentUserId = typeof process.getuid === "function" ? process.getuid() : null;
  if (currentUserId !== null && metadata.uid !== currentUserId) fail("TELEGRAM_WEB_UNSAFE_PATH", "A Telegram Web trusted base belongs to another user.");
  if (process.platform === "win32") {
    await verifyWindowsPrivatePath(base, "directory", created ? "install" : "base", environment);
    return;
  }
  if (created) await chmod(base, 0o700);
  const verified = await lstat(base);
  if (verified.isSymbolicLink() || !verified.isDirectory() || verified.dev !== metadata.dev || verified.ino !== metadata.ino) {
    fail("TELEGRAM_WEB_UNSAFE_PATH", "A Telegram Web trusted base changed identity during verification.");
  }
  // Existing XDG/Trelio bases commonly use 0755. They are acceptable only
  // when owned by this user and not writable by group or others; every
  // sensitive child created below remains exact 0700.
  if ((verified.mode & 0o022) !== 0) fail("TELEGRAM_WEB_UNSAFE_PATH", "A Telegram Web trusted base must not be group- or world-writable.");
  if (await realpath(base) !== path.resolve(base)) fail("TELEGRAM_WEB_UNSAFE_PATH", "A Telegram Web trusted base must not resolve through a symlink.");
  await assertSafeMacExtendedAcl(base, "private-ancestor", verified.uid);
  const final = await lstat(base);
  if (final.dev !== verified.dev
    || final.ino !== verified.ino
    || final.mode !== verified.mode
    || final.uid !== verified.uid
    || final.gid !== verified.gid) {
    fail("TELEGRAM_WEB_UNSAFE_PATH", "A Telegram Web trusted base changed identity during ACL verification.");
  }
};

/**
 * Materialize a dedicated config/cache base only after proving the complete
 * existing ancestor chain. Recursive mkdir is intentionally forbidden here:
 * it could traverse or create below a replaceable/ACL-writable ancestor before
 * the runtime has established any trust boundary.
 */
const ensureDedicatedBaseDirectory = async (base, environment = process.env, dependencies = {}) => {
  const resolved = path.resolve(base);
  if (resolved !== base || /[\u0000-\u001f\u007f]/u.test(base)) {
    fail("TELEGRAM_WEB_UNSAFE_PATH", "A Telegram Web dedicated base must be one canonical absolute path.");
  }
  let existing = resolved;
  const missing = [];
  while (true) {
    const metadata = await lstat(existing).catch((error) => {
      if (error?.code === "ENOENT") return null;
      throw error;
    });
    if (metadata) break;
    const parent = path.dirname(existing);
    if (parent === existing) fail("TELEGRAM_WEB_UNSAFE_PATH", "No trustworthy existing ancestor was found for a Telegram Web base.");
    missing.unshift(path.basename(existing));
    existing = parent;
  }
  // This read-only verifier handles root-to-existing ownership, modes,
  // symlinks/reparse points, Windows DACLs, macOS ACLs, and exact identities.
  await assertTrustedDownloadOutputParent(existing, environment);
  let current = existing;
  for (const segment of missing) {
    current = path.join(current, segment);
    let created = false;
    try {
      const makeDirectory = dependencies.mkdir || mkdir;
      await makeDirectory(current, { mode: 0o700 });
      created = true;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
    await dependencies.afterComponentMkdir?.(current, { created });
    await assertTrustedBaseDirectory(current, created, environment);
  }
  await assertTrustedDownloadOutputParent(resolved, environment);
  await assertTrustedBaseDirectory(resolved, missing.length > 0, environment);
};

const ensurePrivateTree = async (base, target, environment = process.env) => {
  await ensureDedicatedBaseDirectory(base, environment);
  const relative = path.relative(base, target);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) fail("TELEGRAM_WEB_UNSAFE_PATH", "Local state escaped its trusted root.");
  let current = base;
  let sensitive = false;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    if (segment === SKILL_ID) sensitive = true;
    const existed = await lstat(current).catch((error) => {
      if (error?.code === "ENOENT") return null;
      throw error;
    });
    if (!existed) await mkdir(current, { mode: 0o700 });
    if (sensitive) await assertRealPrivateDirectory(current, !existed, environment);
    else await assertTrustedBaseDirectory(current, !existed, environment);
  }
  if (!sensitive) fail("TELEGRAM_WEB_UNSAFE_PATH", "Telegram Web private state must be rooted below its exact skill namespace.");
};

/**
 * Read-only counterpart to ensurePrivateTree.  Cache readiness and code load
 * must validate an existing trust chain before reading manifests or executing
 * any cached JavaScript; an unsafe path is an error, while a genuinely missing
 * path simply means bootstrap is still required.
 */
const verifyExistingPrivateTree = async (base, target, environment = process.env) => {
  const baseMetadata = await lstat(base).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (!baseMetadata) return false;
  await assertTrustedDownloadOutputParent(base, environment);
  await assertTrustedBaseDirectory(base, false, environment);
  const relative = path.relative(base, target);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    fail("TELEGRAM_WEB_UNSAFE_PATH", "Telegram Web runtime cache escaped its trusted root.");
  }
  let current = base;
  let sensitive = false;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    if (segment === SKILL_ID) sensitive = true;
    const metadata = await lstat(current).catch((error) => {
      if (error?.code === "ENOENT") return null;
      throw error;
    });
    if (!metadata) return false;
    if (sensitive) await assertRealPrivateDirectory(current, false, environment);
    else await assertTrustedBaseDirectory(current, false, environment);
  }
  if (!sensitive) fail("TELEGRAM_WEB_UNSAFE_PATH", "Telegram Web runtime cache is outside its exact skill namespace.");
  return true;
};

const verifyTrustedContainedPath = async (targetPath, expectedKind, environment = process.env) => {
  const metadata = await lstat(targetPath).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (!metadata) return false;
  const correctKind = expectedKind === "directory" ? metadata.isDirectory() : metadata.isFile();
  if (metadata.isSymbolicLink() || !correctKind) fail("TELEGRAM_WEB_UNSAFE_PATH", "Telegram Web cached runtime contains a symlink or unsafe path type.");
  const currentUserId = typeof process.getuid === "function" ? process.getuid() : null;
  if (currentUserId !== null && metadata.uid !== currentUserId) fail("TELEGRAM_WEB_UNSAFE_PATH", "Telegram Web cached runtime contains a path owned by another user.");
  if (process.platform === "win32") {
    await verifyWindowsPrivatePath(targetPath, expectedKind, "base", environment);
  } else if ((metadata.mode & 0o022) !== 0) {
    fail("TELEGRAM_WEB_UNSAFE_PATH", "Telegram Web cached runtime contains a group- or world-writable path.");
  }
  await assertSafeMacExtendedAcl(targetPath, "private-leaf", metadata.uid);
  const canonical = await realpath(targetPath);
  const resolved = path.resolve(targetPath);
  if ((process.platform === "win32" ? canonical.toLocaleLowerCase("en-US") : canonical)
    !== (process.platform === "win32" ? resolved.toLocaleLowerCase("en-US") : resolved)) {
    fail("TELEGRAM_WEB_UNSAFE_PATH", "Telegram Web cached runtime resolves through a symlink or reparse point.");
  }
  return true;
};

const verifyTrustedContainedDirectoryChain = async (root, target, environment = process.env) => {
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    fail("TELEGRAM_WEB_UNSAFE_PATH", "Telegram Web cached package escaped its exact runtime root.");
  }
  let current = root;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    if (!await verifyTrustedContainedPath(current, "directory", environment)) return false;
  }
  return true;
};

const readBoundedJson = async (file, maximumBytes, missingValue) => {
  let handle;
  try {
    await assertPrivatePath(file, "file");
    const pathMetadata = await lstat(file);
    if (pathMetadata.isSymbolicLink() || !pathMetadata.isFile() || pathMetadata.size > maximumBytes) {
      fail("TELEGRAM_WEB_UNSAFE_STATE", "A local Telegram Web state file has an unsafe type or size.");
    }
    const flags = fsConstants.O_RDONLY | (process.platform === "win32" ? 0 : (fsConstants.O_NOFOLLOW || 0));
    handle = await open(file, flags);
    try {
      const before = await handleStatExact(handle);
      if (
        !before.isFile()
        || before.dev !== pathMetadata.dev
        || before.ino !== pathMetadata.ino
        || before.size > maximumBytes
      ) fail("TELEGRAM_WEB_UNSAFE_STATE", "A local Telegram Web state file changed identity before bounded reading.");
      const chunks = [];
      let totalBytes = 0;
      while (true) {
        const nextSize = Math.min(16 * 1024, maximumBytes + 1 - totalBytes);
        const chunk = Buffer.allocUnsafe(nextSize);
        const { bytesRead } = await handle.read(chunk, 0, chunk.byteLength, null);
        if (bytesRead === 0) break;
        totalBytes += bytesRead;
        if (totalBytes > maximumBytes) fail("TELEGRAM_WEB_UNSAFE_STATE", "A local Telegram Web state file grew beyond its bounded read limit.");
        chunks.push(chunk.subarray(0, bytesRead));
      }
      const [after, currentPath] = await Promise.all([handleStatExact(handle), lstat(file)]);
      if (
        currentPath.isSymbolicLink()
        || !currentPath.isFile()
        || after.dev !== before.dev
        || after.ino !== before.ino
        || currentPath.dev !== before.dev
        || currentPath.ino !== before.ino
        || after.size !== before.size
        || after.mtimeNs !== before.mtimeNs
        || currentPath.size !== before.size
        || currentPath.mtimeNs !== before.mtimeNs
        || totalBytes !== before.size
      ) fail("TELEGRAM_WEB_UNSAFE_STATE", "A local Telegram Web state file changed during bounded reading.");
      return JSON.parse(Buffer.concat(chunks, totalBytes).toString("utf8"));
    } finally {
      await handle.close();
      handle = undefined;
    }
  } catch (error) {
    if (error?.code === "ENOENT") return missingValue;
    if (error instanceof SyntaxError) fail("TELEGRAM_WEB_UNSAFE_STATE", "A local Telegram Web state file contains invalid JSON.");
    throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
};

const writePrivateJson = async (file, value, configHome = resolveConfigHome(), environment = process.env) => {
  await ensurePrivateTree(configHome, path.dirname(file), environment);
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`);
  let handle;
  let published = false;
  let stagedIdentity = null;
  try {
    handle = await open(temporary, "wx+", 0o600);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    if (process.platform !== "win32") await chmod(temporary, 0o600);
    await assertPrivatePath(temporary, "file", environment, true);
    const staged = await lstat(temporary);
    stagedIdentity = { dev: staged.dev, ino: staged.ino };
    await rename(temporary, file);
    published = true;
    await assertPrivatePath(file, "file", environment);
  } catch (error) {
    if (published && stagedIdentity) {
      const current = await lstat(file).catch(() => null);
      if (current && !current.isSymbolicLink() && current.dev === stagedIdentity.dev && current.ino === stagedIdentity.ino) {
        await rm(file, { force: true }).catch(() => undefined);
      }
    }
    throw error;
  } finally {
    await handle?.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
  }
};

const writePrivateText = async (file, value, trustedBase, environment = process.env) => {
  await ensurePrivateTree(trustedBase, path.dirname(file), environment);
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(temporary, "wx+", 0o600);
    await handle.writeFile(String(value), "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    if (process.platform !== "win32") await chmod(temporary, 0o600);
    await assertPrivatePath(temporary, "file", environment, true);
    await rename(temporary, file);
    await assertPrivatePath(file, "file", environment);
  } finally {
    await handle?.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
  }
};

export const loadPolicy = async (identity, environment = process.env) => {
  const { policyFile } = runtimeLocations(identity, environment);
  const value = await readBoundedJson(policyFile, 8 * 1024, { sendMode: "confirm" });
  if (
    !value
    || typeof value !== "object"
    || Array.isArray(value)
    || Object.keys(value).join(",") !== "sendMode"
    || !POLICY_MODES.has(value.sendMode)
  ) {
    fail("TELEGRAM_WEB_UNSAFE_STATE", "Local Telegram Web policy is invalid.");
  }
  return { sendMode: value.sendMode };
};

export const assertMutationAllowed = async (identity, options, environment = process.env) => {
  const { sendMode } = await loadPolicy(identity, environment);
  if (sendMode === "read-only") fail("TELEGRAM_WEB_READ_ONLY", "Local Telegram Web policy is read-only; mutations are disabled.");
  if (sendMode === "autonomous" && !identity.allowAutonomous) {
    fail("TELEGRAM_WEB_AUTONOMOUS_FORBIDDEN", "The company connection forbids autonomous Telegram Web mutations.");
  }
  if (sendMode === "confirm" && !options.confirm) {
    fail("TELEGRAM_WEB_CONFIRMATION_REQUIRED", "Telegram Web mutation requires --confirm in local confirm mode.");
  }
  return sendMode;
};

export const CONSENT_STATEMENTS = Object.freeze([
  "Я разрешаю обоим локальным ИИ-клиентам – Codex/OpenAI и Claude Code/Anthropic, включая их агентов и модельных провайдеров, – читать и обрабатывать данные моих Telegram-чатов по моим запросам.",
  "Я подтверждаю, что сам уже получил необходимые явные, информированные, актуальные и продолжающиеся согласия всех остальных участников для каждого конкретного чата, материала и контекста, который передам агенту. При отзыве такого согласия я прекращу обработку и отзову это разрешение.",
]);

export const CONSENT_STATEMENT_DIGEST = sha256(canonicalJson({ statements: CONSENT_STATEMENTS }));

const ACCOUNT_DIGEST_DOMAIN = "trelio-telegram-web-account/v1\0";

const isExactPositiveSafeDecimal = (value) => {
  const normalized = String(value ?? "");
  const numeric = Number(normalized);
  return /^\d{1,24}$/u.test(normalized)
    && Number.isSafeInteger(numeric)
    && numeric > 0
    && String(numeric) === normalized;
};

const requireExactPositiveSafeDecimal = (value, code, message) => {
  const normalized = String(value ?? "");
  if (!isExactPositiveSafeDecimal(normalized)) fail(code, message);
  return normalized;
};

export const accountDigestFromTelegramUserId = (userId) => {
  const normalized = requireExactPositiveSafeDecimal(
    userId,
    "TELEGRAM_WEB_ACCOUNT_ID_INVALID",
    "Telegram Web current account identity must be one canonical positive JavaScript-safe integer.",
  );
  return sha256(`${ACCOUNT_DIGEST_DOMAIN}${normalized}`);
};

export const telegramWebUrlForAccount = (account, peerId = null) => {
  if (!Number.isInteger(account) || account < 1 || account > 4) fail("TELEGRAM_WEB_INVALID_ACCOUNT", "Telegram account slot must be an integer from 1 to 4.");
  if (peerId !== null) requireExactSafePeerId(peerId, {
    code: "TELEGRAM_WEB_INVALID_CHAT",
    message: "Telegram peer identity must be one exact non-zero safe integer.",
  });
  const target = new URL(TELEGRAM_WEB_URL);
  if (account > 1) target.searchParams.set("account", String(account));
  if (peerId !== null) target.hash = String(peerId);
  return target.href;
};

const readPreferredAccount = async (identity, environment = process.env) => {
  const record = await readBoundedJson(runtimeLocations(identity, environment).accountFile, 4 * 1024, { slot: 1 });
  if (!record || typeof record !== "object" || Object.keys(record).join(",") !== "slot" || !Number.isInteger(record.slot) || record.slot < 1 || record.slot > 4) {
    fail("TELEGRAM_WEB_UNSAFE_STATE", "Telegram Web preferred account slot state is invalid.");
  }
  return record.slot;
};

const resolvePreferredAccount = async (identity, options, environment = process.env) => (
  options.account || await readPreferredAccount(identity, environment)
);

const savePreferredAccount = async (identity, account, environment = process.env) => {
  await writePrivateJson(
    runtimeLocations(identity, environment).accountFile,
    { slot: account },
    resolveConfigHome(environment),
    environment,
  );
};

export const readCurrentTelegramAccountDigest = async (page, expectedAccount = null) => {
  const digest = await page.evaluate(async ({ domain, expectedSlot }) => {
    // Official Web K mounts rootScope and its storage controller on window.
    // rootScope.myId follows the active account even with passcode-encrypted
    // storage. AccountController is the current multi-account corroboration.
    // Legacy user_auth belongs to account #1 only and must never reject a
    // valid active account #2-#4 merely because it still names account #1.
    const exactPositiveSafeId = (value) => {
      if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) return null;
      const rendered = String(value);
      return /^\d{1,24}$/u.test(rendered) ? rendered : null;
    };
    const rootId = exactPositiveSafeId(globalThis.rootScope?.myId);
    if (!rootId) return null;
    let currentAccount;
    try {
      const rawHref = String(globalThis.location.href || "");
      const canonical = /^https:\/\/web\.telegram\.org\/k\/(?:\?account=([2-4]))?(?:#(-?\d{1,24}))?$/u.exec(rawHref);
      if (!canonical) return null;
      if (canonical[2] !== undefined) {
        const peer = Number(canonical[2]);
        if (!Number.isSafeInteger(peer) || peer === 0 || String(peer) !== canonical[2]) return null;
      }
      currentAccount = canonical[1] === undefined ? 1 : Number(canonical[1]);
      if (currentAccount === null) return null;
      if (expectedSlot !== null && currentAccount !== expectedSlot) return null;
    } catch {
      return null;
    }
    try {
      if (typeof globalThis.AccountController?.get !== "function") return null;
      const currentRecord = await globalThis.AccountController.get(currentAccount);
      if (!currentRecord || typeof currentRecord !== "object" || Array.isArray(currentRecord)) return null;
      const currentPrototype = Object.getPrototypeOf(currentRecord);
      if (currentPrototype !== Object.prototype && currentPrototype !== null) return null;
      const controllerId = exactPositiveSafeId(currentRecord?.userId);
      if (!controllerId || controllerId !== rootId) return null;
      if (currentAccount === 1 && typeof globalThis.appStorage?.get === "function") {
        const legacy = await globalThis.appStorage.get("user_auth");
        if (legacy !== undefined && legacy !== null) {
          if (typeof legacy !== "object" || Array.isArray(legacy)) return null;
          const legacyPrototype = Object.getPrototypeOf(legacy);
          if (legacyPrototype !== Object.prototype && legacyPrototype !== null) return null;
          const legacyId = exactPositiveSafeId(legacy?.id);
          if (!legacyId || legacyId !== rootId) return null;
        }
      }
    } catch {
      return null;
    }
    const bytes = new TextEncoder().encode(`${domain}${rootId}`);
    const hashed = await crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(hashed), (byte) => byte.toString(16).padStart(2, "0")).join("");
  }, {
    domain: ACCOUNT_DIGEST_DOMAIN,
    expectedSlot: expectedAccount,
  });
  if (!/^[0-9a-f]{64}$/u.test(String(digest || ""))) {
    fail("TELEGRAM_WEB_ACCOUNT_ID_INVALID", "Telegram Web did not expose one valid authenticated current account identity.");
  }
  return digest;
};

const renderConsentStatusUnlocked = async (identity, currentAccountDigest, now = new Date(), environment = process.env) => {
  const { consentFile } = runtimeLocations(identity, environment);
  const consentGeneration = await readConsentGenerationUnlocked(identity, environment);
  const revoked = consentGeneration !== "initial";
  const record = await readBoundedJson(consentFile, 8 * 1024, null);
  const acceptedAtMs = Date.parse(record?.acceptedAt);
  const expiresAtMs = Date.parse(record?.expiresAt);
  const nowMs = now.getTime();
  const canonicalDates = typeof record?.acceptedAt === "string"
    && typeof record?.expiresAt === "string"
    && Number.isFinite(acceptedAtMs)
    && Number.isFinite(expiresAtMs)
    && new Date(acceptedAtMs).toISOString() === record.acceptedAt
    && new Date(expiresAtMs).toISOString() === record.expiresAt;
  const validDates = canonicalDates
    && Number.isFinite(expiresAtMs)
    && acceptedAtMs <= nowMs + 5 * 60_000
    && expiresAtMs === acceptedAtMs + CONSENT_VALID_DAYS * 24 * 60 * 60 * 1000
    && expiresAtMs <= nowMs + CONSENT_VALID_DAYS * 24 * 60 * 60 * 1000 + 5 * 60_000;
  const structurallyValid = Boolean(
    record
    && typeof record === "object"
    && Object.keys(record).sort().join(",") === "acceptedAt,accountDigest,expiresAt,statementDigest,termsVersion"
    && record.termsVersion === CONSENT_TERMS_VERSION
    && record.statementDigest === CONSENT_STATEMENT_DIGEST
    && /^[0-9a-f]{64}$/u.test(String(record.accountDigest || ""))
    && validDates,
  );
  const accountMatches = structurallyValid
    && /^[0-9a-f]{64}$/u.test(String(currentAccountDigest || ""))
    && record.accountDigest === currentAccountDigest;
  const valid = !revoked && structurallyValid && accountMatches && expiresAtMs > nowMs;
  return {
    valid,
    termsVersion: CONSENT_TERMS_VERSION,
    acceptedAt: structurallyValid ? record.acceptedAt : null,
    expiresAt: structurallyValid ? record.expiresAt : null,
    accountBound: accountMatches,
    reason: valid
      ? null
      : revoked
        ? "revoked"
        : !record
        ? "not_accepted"
        : !structurallyValid
          ? "terms_changed_or_invalid"
          : expiresAtMs <= nowMs
            ? "expired"
            : "account_changed",
  };
};

export const renderConsentStatus = async (identity, currentAccountDigest, now = new Date(), environment = process.env) => (
  acquireConsentStateLock(
    identity,
    () => renderConsentStatusUnlocked(identity, currentAccountDigest, now, environment),
    environment,
  )
);

const assertConsentStatusValid = (status) => {
  if (!status.valid) {
    fail(
      "TELEGRAM_WEB_CONSENT_REQUIRED",
      "Protected Telegram processing consent is missing, expired, or belongs to an older terms version. Run `consent accept` and let the account owner confirm it in the local browser.",
      status,
    );
  }
  return status;
};

export const requireValidConsent = async (identity, currentAccountDigest, environment = process.env) => {
  const status = await renderConsentStatus(identity, currentAccountDigest, new Date(), environment);
  return assertConsentStatusValid(status);
};

/**
 * Content commands must fail from private local state before Chrome starts.
 * The live account digest is intentionally re-bound after launch; this first
 * gate proves only that one current, unrevoked five-field grant exists, so a
 * missing/expired/old-terms grant cannot trigger Telegram network activity.
 */
export const requireLocalConsentPreflight = async (identity, environment = process.env) => acquireConsentStateLock(
  identity,
  async () => {
    const record = await readBoundedJson(runtimeLocations(identity, environment).consentFile, 8 * 1024, null);
    const accountDigest = record?.accountDigest;
    if (!/^[0-9a-f]{64}$/u.test(String(accountDigest || ""))) {
      return assertConsentStatusValid(await renderConsentStatusUnlocked(
        identity,
        null,
        new Date(),
        environment,
      ));
    }
    return assertConsentStatusValid(await renderConsentStatusUnlocked(
      identity,
      accountDigest,
      new Date(),
      environment,
    ));
  },
  environment,
);

const readConsentGenerationUnlocked = async (identity, environment = process.env) => {
  const record = await readBoundedJson(
    runtimeLocations(identity, environment).consentGenerationFile,
    4 * 1024,
    null,
  );
  if (record === null) return "initial";
  if (!record
    || typeof record !== "object"
    || Array.isArray(record)
    || Object.keys(record).join(",") !== "generation"
    || !/^[0-9a-f]{64}$/u.test(String(record.generation || ""))) {
    fail("TELEGRAM_WEB_UNSAFE_STATE", "Telegram Web consent generation state is invalid.");
  }
  return record.generation;
};

const rotateConsentGenerationUnlocked = async (identity, environment = process.env) => {
  const generation = randomBytes(32).toString("hex");
  await writePrivateJson(
    runtimeLocations(identity, environment).consentGenerationFile,
    { generation },
    resolveConfigHome(environment),
    environment,
  );
  return generation;
};

const CONSENT_STYLE = "body{font:16px/1.5 system-ui,sans-serif;max-width:760px;margin:40px auto;padding:0 20px;color:#17212b}fieldset{border:1px solid #ccd6dd;border-radius:12px;padding:20px}label{display:block;margin:18px 0}button{font:inherit;padding:10px 18px;border:0;border-radius:8px;background:#2481cc;color:white}small{color:#52616b}";
const CONSENT_STYLE_CSP_HASH = createHash("sha256").update(CONSENT_STYLE).digest("base64");
const securityHeaders = Object.freeze({
  "cache-control": "no-store, max-age=0",
  "content-security-policy": `default-src 'none'; style-src 'sha256-${CONSENT_STYLE_CSP_HASH}'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`,
  "cross-origin-opener-policy": "same-origin",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
});

const htmlEscape = (value) => String(value).replace(/[&<>"']/gu, (character) => ({
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  "\"": "&quot;",
  "'": "&#39;",
}[character]));

const requireTrustedAbsoluteExecutable = async (candidates) => {
  for (const candidate of candidates) {
    if (!path.isAbsolute(candidate)) continue;
    try {
      return await assertTrustedPosixExecutableChain(candidate);
    } catch (error) {
      if (error instanceof TelegramWebRuntimeError && error.code === "TELEGRAM_WEB_UNSAFE_PATH") continue;
      throw error;
    }
  }
  fail("TELEGRAM_WEB_BROWSER_OPEN_FAILED", "No trusted absolute system browser opener was found.");
};

const launchExternalBrowser = async (url, environment = process.env) => {
  let command;
  if (process.platform === "darwin") {
    command = { executable: await requireTrustedAbsoluteExecutable(["/usr/bin/open"]), args: [url], cwd: "/" };
  } else if (process.platform === "win32") {
    const executable = await resolveTrustedWindowsSystemExecutable(environment, "rundll32.exe");
    const urlLibrary = await resolveTrustedWindowsSystemExecutable(environment, "url.dll");
    command = {
      executable,
      args: [`${urlLibrary},FileProtocolHandler`, url],
      cwd: path.dirname(executable),
    };
  } else {
    command = {
      executable: await requireTrustedAbsoluteExecutable(["/usr/bin/xdg-open", "/bin/xdg-open"]),
      args: [url],
      cwd: "/",
    };
  }
  // The opener argv carries the one-use landing capability. Revalidate the
  // complete POSIX owner/mode/link/identity chain immediately before spawn.
  if (process.platform !== "win32") await assertTrustedPosixExecutableChain(command.executable);
  await new Promise((resolve, reject) => {
    const child = spawn(command.executable, command.args, {
      detached: process.platform !== "win32",
      shell: false,
      stdio: "ignore",
      windowsHide: true,
      cwd: command.cwd,
      env: sanitizeBrowserEnvironment(environment),
    });
    let complete = false;
    const finish = (callback, value) => {
      if (complete) return;
      complete = true;
      clearTimeout(timer);
      callback(value);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(reject, new Error("browser opener timed out"));
    }, 8_000);
    // Keep the deadline referenced while the opener promise is pending.  An
    // unreferenced watchdog can let Node terminate before the promised
    // fail-closed timeout and cleanup have actually happened.
    child.once("error", (error) => finish(reject, error));
    child.once("exit", (code) => code === 0
      ? finish(resolve)
      : finish(reject, new Error("browser opener failed")));
  }).catch(() => fail("TELEGRAM_WEB_BROWSER_OPEN_FAILED", "Could not open the protected local consent page in the system browser."));
};

export const acceptConsentInProtectedBrowser = async (
  identity,
  accountDigest,
  environment = process.env,
  dependencies = {},
) => {
  if (!/^[0-9a-f]{64}$/u.test(String(accountDigest || ""))) {
    fail("TELEGRAM_WEB_ACCOUNT_ID_INVALID", "Protected consent requires one verified authenticated Telegram account.");
  }
  // Enter an explicitly invalid/pending generation before opening the local
  // page. The five-field record may be written slowly later, but it cannot be
  // consumed until this exact tombstone is removed at the final commit point.
  const expectedConsentGeneration = await acquireConsentStateLock(
    identity,
    async () => {
      const generation = await rotateConsentGenerationUnlocked(identity, environment);
      await revokeConsentUnlocked(identity, environment);
      return generation;
    },
    environment,
  );
  const nonce = randomBytes(32).toString("base64url");
  // The loopback port alone is discoverable by another local principal.  Keep
  // both routes unguessable as an additional bearer boundary, and admit only
  // the first request to the landing route.  The landing route is necessarily
  // present in the system-browser opener argv, so this protects against blind
  // loopback probing rather than a process already able to inspect that argv.
  const landingPath = `/consent/${randomBytes(32).toString("base64url")}`;
  const confirmPath = `/confirm/${randomBytes(32).toString("base64url")}`;
  const sockets = new Set();
  let settled = false;
  let committed = false;
  let landingClaimed = false;
  let submissionStarted = false;
  let consentTimer;
  let terminalError = null;
  let server = null;
  let unsubscribeLifecycleAbort = () => undefined;
  let resolveAccepted;
  let rejectAccepted;
  const accepted = new Promise((resolve, reject) => {
    resolveAccepted = resolve;
    rejectAccepted = reject;
  });
  const shutdownLoopback = () => {
    server?.close();
    for (const socket of sockets) socket.destroy();
  };
  const finishError = (error) => {
    if (settled) return;
    settled = true;
    terminalError = error;
    shutdownLoopback();
    rejectAccepted(error);
  };

  server = http.createServer((request, response) => {
    const reject = (status, message) => {
      response.writeHead(status, { ...securityHeaders, "content-type": "text/plain; charset=utf-8" });
      response.end(message);
    };
    const local = request.socket.remoteAddress === "127.0.0.1" || request.socket.remoteAddress === "::ffff:127.0.0.1";
    const exactHost = `127.0.0.1:${server.address()?.port}`;
    if (!local || request.headers.host !== exactHost || ![landingPath, confirmPath].includes(request.url)) {
      reject(404, "Not found");
      return;
    }
    if (settled || submissionStarted) {
      reject(410, "This one-time consent page is already closed");
      return;
    }

    if (request.method === "GET" && request.url === landingPath) {
      // A second GET is not a harmless refresh: it could be a competing local
      // principal trying to obtain a fresh nonce cookie after the owner opened
      // the protected route.  Claim the route before writing any response.
      if (landingClaimed) {
        reject(410, "This one-time consent landing page is already claimed");
        return;
      }
      landingClaimed = true;
      const body = `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Telegram Web – согласие</title><style>${CONSENT_STYLE}</style></head><body><h1>Обработка чатов Telegram</h1><p>Оба локальных ИИ-клиента – Codex от OpenAI и Claude Code от Anthropic – вместе со своими агентами и модельными провайдерами смогут по вашим запросам читать и обрабатывать сообщения, имена, даты и время, а также выбранные вложения, только для выполнения ваших задач с Telegram. Для каждого клиента действуют правила конфиденциальности и хранения данных его провайдера.</p><p>Raw Telegram content не отправляется на сервер Trelio самим runtime. Он попадёт в Trelio только если вы отдельно попросите сохранить результат, файл или выдержку в Trelio.</p><p>Подтверждение действует 365 дней только на этом устройстве, для текущего подключения Trelio и текущего Telegram-аккаунта. Его можно отозвать командой <code>consent revoke --confirm</code>.</p><form method="post" action="${htmlEscape(confirmPath)}"><fieldset><legend>Два неделимых пункта подтверждения</legend><p>1. ${htmlEscape(CONSENT_STATEMENTS[0])}</p><p>2. ${htmlEscape(CONSENT_STATEMENTS[1])}</p><button type="submit" name="affirm" value="yes">Да, подтверждаю оба пункта</button></fieldset></form><p><small>Версия условий: ${htmlEscape(CONSENT_TERMS_VERSION)}. Официальные условия: <a rel="noreferrer noopener" target="_blank" href="https://telegram.org/tos/content-licensing">Content Licensing Terms</a> и <a rel="noreferrer noopener" target="_blank" href="https://core.telegram.org/api/terms">API Terms</a>. Это подтверждение не является согласием за других людей, доказательством наличия или сохранения их согласия, подтверждением соблюдения закона либо разрешением Telegram. Runtime не может проверить эти внешние факты.</small></p></body></html>`;
      response.writeHead(200, {
        ...securityHeaders,
        "content-type": "text/html; charset=utf-8",
        "set-cookie": `trelio_tg_consent=${nonce}; HttpOnly; SameSite=Strict; Path=${confirmPath}; Max-Age=600`,
      });
      response.end(body);
      return;
    }

    if (request.method !== "POST" || request.url !== confirmPath) {
      reject(405, "Method not allowed");
      return;
    }
    const origin = `http://${exactHost}`;
    const fetchSite = String(request.headers["sec-fetch-site"] || "");
    const fetchMode = String(request.headers["sec-fetch-mode"] || "");
    const fetchDest = String(request.headers["sec-fetch-dest"] || "");
    if (
      request.headers.origin !== origin
      || fetchSite !== "same-origin"
      || fetchMode !== "navigate"
      || fetchDest !== "document"
      || !String(request.headers["content-type"] || "").startsWith("application/x-www-form-urlencoded")
    ) {
      reject(403, "Invalid browser submission");
      return;
    }

    let size = 0;
    const chunks = [];
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size <= CONSENT_BODY_LIMIT) {
        chunks.push(chunk);
        return;
      }
      if (!submissionStarted && !settled) {
        submissionStarted = true;
        reject(413, "Consent request body is too large");
        finishError(new TelegramWebRuntimeError(
          "TELEGRAM_WEB_CONSENT_INVALID_SUBMISSION",
          "Protected Telegram consent received an oversized form submission and was closed.",
        ));
      }
    });
    request.on("end", async () => {
      if (size > CONSENT_BODY_LIMIT) return;
      const form = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
      const cookie = String(request.headers.cookie || "");
      if (!cookie.split(/;\s*/u).includes(`trelio_tg_consent=${nonce}`) || form.get("affirm") !== "yes") {
        reject(400, "The single affirmation of both statements is required");
        return;
      }
      // Claim the one-use nonce synchronously before the first await. Two
      // concurrent valid POST requests cannot both reach local state writes.
      if (submissionStarted || settled) {
        reject(410, "This one-time consent page is already closed");
        return;
      }
      submissionStarted = true;
      const acceptedAt = new Date();
      const expiresAt = new Date(acceptedAt.getTime() + CONSENT_VALID_DAYS * 24 * 60 * 60 * 1000);
      const record = {
        termsVersion: CONSENT_TERMS_VERSION,
        statementDigest: CONSENT_STATEMENT_DIGEST,
        accountDigest,
        acceptedAt: acceptedAt.toISOString(),
        expiresAt: expiresAt.toISOString(),
      };
      try {
        await acquireConsentStateLock(identity, async () => {
          dependencies.commandLifecycle?.assertActive("protected consent persistence");
          if (settled) throw terminalError || new TelegramWebRuntimeError(
            "TELEGRAM_WEB_CONSENT_TIMEOUT",
            "Protected Telegram consent closed before its pending record could be published.",
          );
          const currentGeneration = await readConsentGenerationUnlocked(identity, environment);
          if (currentGeneration !== expectedConsentGeneration) {
            fail(
              "TELEGRAM_WEB_CONSENT_REVOKED_DURING_APPROVAL",
              "Telegram Web consent was revoked while the protected approval page was open. The delayed submission was not saved.",
            );
          }
          const writeConsent = dependencies.writeConsent || ((nextRecord) => writePrivateJson(
            runtimeLocations(identity, environment).consentFile,
            nextRecord,
            resolveConfigHome(environment),
            environment,
          ));
          await writeConsent(record);
          // A command/HTTP deadline may expire while the injected or local
          // write is pending. Recheck under the same state lock before the
          // only mutation that can make the record valid.
          dependencies.commandLifecycle?.assertActive("protected consent publication");
          if (settled) throw terminalError || new TelegramWebRuntimeError(
            "TELEGRAM_WEB_CONSENT_TIMEOUT",
            "Protected Telegram consent closed before publication.",
          );
          let publicationStarted = false;
          try {
            publicationStarted = true;
            await removePrivateStateFile(
              runtimeLocations(identity, environment).consentGenerationFile,
              environment,
            );
            // Timers can run while the asynchronous unlink is in flight. No
            // other reader can observe the transient state because this exact
            // consent lock is still held; restore a fresh tombstone before
            // releasing it if the lifecycle ended during that syscall.
            dependencies.commandLifecycle?.assertActive("protected consent publication completion");
            if (settled) throw terminalError || new TelegramWebRuntimeError(
              "TELEGRAM_WEB_CONSENT_TIMEOUT",
              "Protected Telegram consent expired while publication was completing.",
            );
            // This synchronous flag change is the local commit point. The
            // sole timer is deliberately left armed until the outer finally.
            committed = true;
            settled = true;
          } catch (error) {
            if (publicationStarted) await rotateConsentGenerationUnlocked(identity, environment);
            throw error;
          }
        }, environment);
        response.writeHead(200, {
          ...securityHeaders,
          "content-type": "text/html; charset=utf-8",
          "set-cookie": `trelio_tg_consent=; HttpOnly; SameSite=Strict; Path=${confirmPath}; Max-Age=0`,
        });
        response.end("<!doctype html><html lang=ru><meta charset=utf-8><title>Готово</title><body><p>Согласие сохранено. Эту вкладку можно закрыть.</p></body></html>");
        resolveAccepted(record);
      } catch (error) {
        if (committed) {
          // The durable commit already completed before the response channel
          // failed. Report that committed result rather than hanging or
          // falsely claiming the consent remained pending.
          resolveAccepted(record);
          return;
        }
        if (!response.headersSent && !response.destroyed) reject(500, "Could not save consent");
        finishError(error);
      }
    });
    const terminateAbortedSubmission = () => {
      // After a valid end() handler synchronously claims submissionStarted,
      // only the awaited private write may settle the consent promise. A
      // client disconnect cannot release the profile lock while that write is
      // still pending and later resurrect consent after revoke/logout/forget.
      if (submissionStarted || settled) return;
      submissionStarted = true;
      finishError(new TelegramWebRuntimeError(
        "TELEGRAM_WEB_CONSENT_INVALID_SUBMISSION",
        "Protected Telegram consent submission ended before it could be verified.",
      ));
    };
    request.once("aborted", terminateAbortedSubmission);
    request.once("error", terminateAbortedSubmission);
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  if (dependencies.commandLifecycle?.onAbort) {
    unsubscribeLifecycleAbort = dependencies.commandLifecycle.onAbort((error) => finishError(error));
  }
  // The opener URL contains a high-entropy one-use landing capability.  It is
  // not printed, and the authorization cookie/confirm capability are delivered
  // only in the response.  A process with permission to inspect the opener's
  // argv can still observe the landing capability; that same-local-principal
  // boundary is documented rather than represented as OS-level isolation.
  const localUrl = `http://127.0.0.1:${server.address().port}${landingPath}`;
  try {
    dependencies.commandLifecycle?.assertActive("opening protected consent page");
    consentTimer = setTimeout(() => finishError(new TelegramWebRuntimeError(
      "TELEGRAM_WEB_CONSENT_TIMEOUT",
      "Protected Telegram consent was not completed before the local page expired.",
    )), CONSENT_TIMEOUT_MS);
    // This is part of the protected consent guarantee, not background
    // housekeeping: keep the process alive until acceptance or exact expiry.
    const openBrowser = dependencies.openBrowser || ((nextUrl) => launchExternalBrowser(nextUrl, environment));
    const opener = Promise.resolve().then(() => openBrowser(localUrl));
    // The protected deadline starts before the handoff. Even a host/test
    // opener dependency that never settles cannot retain the profile lock and
    // loopback server indefinitely.
    await Promise.race([opener, accepted]);
    return await accepted;
  } finally {
    clearTimeout(consentTimer);
    unsubscribeLifecycleAbort();
    shutdownLoopback();
  }
};

const knownChromeCandidates = (environment = process.env) => {
  if (process.platform === "darwin") {
    return [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    ];
  }
  if (process.platform === "win32") {
    return [];
  }
  return [
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ];
};

// macOS machine-wide applications are commonly installed as root:admin 0775.
// Group 80 is the fixed local `admin` group on supported macOS; treating that
// one OS-administrator group as a machine trust root is deliberate and mirrors
// Windows Program Files/Administrators. Every other group-write bit, every
// world-write bit, arbitrary owner, link, and identity change fails closed.
const DARWIN_TRUSTED_ADMIN_GID = 80;

const assertTrustedPosixPathChain = async (candidate, { requireExecutable = false } = {}) => {
  if (process.platform === "win32") {
    fail("TELEGRAM_WEB_UNSAFE_PATH", "POSIX executable-chain verification is unavailable on Windows.");
  }
  const resolved = path.resolve(candidate);
  if (!path.isAbsolute(candidate) || resolved !== candidate) {
    fail("TELEGRAM_WEB_UNSAFE_PATH", "A trusted local code path must use one canonical absolute path.");
  }
  const currentUserId = typeof process.getuid === "function" ? process.getuid() : null;
  if (!Number.isInteger(currentUserId) || currentUserId < 0) {
    fail("TELEGRAM_WEB_UNSAFE_PATH", "The current POSIX user identity is unavailable for code-path verification.");
  }
  const root = path.parse(resolved).root;
  const segments = path.relative(root, resolved).split(path.sep).filter(Boolean);
  const chain = [root];
  let current = root;
  for (const segment of segments) {
    current = path.join(current, segment);
    chain.push(current);
  }
  for (let index = 0; index < chain.length; index += 1) {
    const item = chain[index];
    const final = index === chain.length - 1;
    const before = await lstat(item).catch(() => null);
    if (!before
      || before.isSymbolicLink()
      || (final ? !before.isFile() : !before.isDirectory())) {
      fail("TELEGRAM_WEB_UNSAFE_PATH", "A trusted local code path contains a missing link, symlink, or unsafe path type.");
    }
    if (before.uid !== 0 && before.uid !== currentUserId) {
      fail("TELEGRAM_WEB_UNSAFE_PATH", "A trusted local code path belongs to an untrusted OS principal.");
    }
    if ((before.mode & 0o002) !== 0) {
      fail("TELEGRAM_WEB_UNSAFE_PATH", "A trusted local code path must not be world-writable.");
    }
    if ((before.mode & 0o020) !== 0
      && !(process.platform === "darwin" && before.gid === DARWIN_TRUSTED_ADMIN_GID)) {
      fail("TELEGRAM_WEB_UNSAFE_PATH", "A trusted local code path is group-writable outside the trusted macOS admin boundary.");
    }
    if (final && requireExecutable && (before.mode & 0o111) === 0) {
      fail("TELEGRAM_WEB_UNSAFE_PATH", "The trusted local executable is not executable.");
    }
    await assertSafeMacExtendedAcl(item, "replace-protected", before.uid);
    const canonical = await realpath(item);
    const after = await lstat(item);
    if (canonical !== item
      || after.isSymbolicLink()
      || after.dev !== before.dev
      || after.ino !== before.ino
      || after.mode !== before.mode
      || after.uid !== before.uid
      || after.gid !== before.gid) {
      fail("TELEGRAM_WEB_UNSAFE_PATH", "A trusted local code path changed identity or resolved through a link.");
    }
  }
  return resolved;
};

export const assertTrustedPosixExecutableChain = (candidate) => assertTrustedPosixPathChain(
  candidate,
  { requireExecutable: true },
);

const validateWindowsProgramFilesRoot = async (declaredRoot, expectedBasename, validatedDriveRoot) => {
  const root = path.normalize(String(declaredRoot || ""));
  if (!path.isAbsolute(root)
    || !/^[A-Za-z]:[\\/]/u.test(root)
    || root.startsWith("\\\\")
    || path.basename(root).toLocaleLowerCase("en-US") !== expectedBasename.toLocaleLowerCase("en-US")
    || path.dirname(root).toLocaleLowerCase("en-US") !== path.normalize(validatedDriveRoot).toLocaleLowerCase("en-US")
    || path.parse(root).root.toLocaleLowerCase("en-US") !== path.normalize(validatedDriveRoot).toLocaleLowerCase("en-US")) {
    fail("TELEGRAM_WEB_UNSAFE_PATH", "A declared Windows Program Files root is missing or invalid.");
  }
  const metadata = await lstat(root).catch(() => null);
  if (!metadata || metadata.isSymbolicLink() || !metadata.isDirectory()) {
    fail("TELEGRAM_WEB_UNSAFE_PATH", "A declared Windows Program Files root has an unsafe type.");
  }
  if ((await realpath(root)).toLocaleLowerCase("en-US") !== path.resolve(root).toLocaleLowerCase("en-US")) {
    fail("TELEGRAM_WEB_UNSAFE_PATH", "A declared Windows Program Files root resolves through a reparse point.");
  }
  for (const untrusted of [process.cwd(), os.homedir(), os.tmpdir()]) {
    const left = path.relative(root, untrusted);
    const right = path.relative(untrusted, root);
    if ((!left.startsWith("..") && !path.isAbsolute(left)) || (!right.startsWith("..") && !path.isAbsolute(right))) {
      fail("TELEGRAM_WEB_UNSAFE_PATH", "A declared Windows Program Files root overlaps the workspace, home, or temporary directory.");
    }
  }
  return root;
};

export const findChromeExecutable = async (environment = process.env) => {
  if (process.platform !== "win32") {
    for (const candidate of knownChromeCandidates(environment)) {
      if (!candidate || !path.isAbsolute(candidate)) continue;
      const metadata = await lstat(candidate).catch((error) => {
        if (error?.code === "ENOENT") return null;
        throw error;
      });
      if (!metadata) continue;
      return assertTrustedPosixExecutableChain(candidate);
    }
    return null;
  }
  // Establish the same inherited-OS environment boundary used by ACL tools.
  // This is a canonical path/type check, not a cryptographic Authenticode
  // signature claim. Per-user LocalAppData browser installs are intentionally
  // excluded from 1.0.2 because that root overlaps user-controlled state.
  const commandProcessor = await resolveTrustedWindowsSystemExecutable(environment, "cmd.exe");
  const validatedSystemRoot = path.dirname(path.dirname(commandProcessor));
  const validatedDriveRoot = path.parse(validatedSystemRoot).root;
  const roots = [];
  if (environment.PROGRAMFILES) {
    roots.push(await validateWindowsProgramFilesRoot(environment.PROGRAMFILES, "Program Files", validatedDriveRoot));
  }
  if (environment["PROGRAMFILES(X86)"]) {
    roots.push(await validateWindowsProgramFilesRoot(environment["PROGRAMFILES(X86)"], "Program Files (x86)", validatedDriveRoot));
  }
  if (!roots.length) fail("TELEGRAM_WEB_UNSAFE_PATH", "No trusted machine-wide Windows Program Files root was declared.");
  const candidates = roots.flatMap((root) => [
    { root, candidate: path.join(root, "Google", "Chrome", "Application", "chrome.exe") },
    { root, candidate: path.join(root, "Microsoft", "Edge", "Application", "msedge.exe") },
  ]);
  for (const { root, candidate } of candidates) {
    const metadata = await lstat(candidate).catch(() => null);
    if (!metadata) continue;
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      fail("TELEGRAM_WEB_UNSAFE_PATH", "A Windows browser executable candidate has an unsafe type.");
    }
    if ((await realpath(candidate)).toLocaleLowerCase("en-US") !== path.resolve(candidate).toLocaleLowerCase("en-US")) {
      fail("TELEGRAM_WEB_UNSAFE_PATH", "A Windows browser executable candidate resolves through a reparse point.");
    }
    await verifyWindowsMachineExecutableChain(candidate, root, environment);
    return candidate;
  }
  return null;
};

export const sanitizeBrowserEnvironment = (environment = process.env) => {
  // Browser/external-opener children never receive arbitrary agent/workspace
  // variables. In particular this excludes dynamic-loader injection,
  // SSLKEYLOGFILE, language-runtime hooks, Playwright debugging, proxy and
  // Chromium wrapper variables from the process that owns the persistent
  // Telegram profile.
  const allowed = new Set([
    "HOME", "USER", "LOGNAME", "TMPDIR", "TMP", "TEMP",
    "LANG", "LANGUAGE", "LC_ALL", "LC_CTYPE", "TZ",
    "DISPLAY", "WAYLAND_DISPLAY", "XAUTHORITY", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS",
    "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT", "USERNAME", "USERPROFILE",
    "LOCALAPPDATA", "APPDATA", "PROGRAMDATA", "PROGRAMFILES", "PROGRAMFILES(X86)",
    "COMMONPROGRAMFILES", "COMMONPROGRAMFILES(X86)",
  ]);
  const sanitized = {};
  for (const [key, value] of Object.entries(environment)) {
    if (allowed.has(key.toLocaleUpperCase("en-US")) && typeof value === "string") sanitized[key] = value;
  }
  const systemRoot = Object.entries(sanitized).find(([key]) => key.toLocaleUpperCase("en-US") === "SYSTEMROOT")?.[1];
  sanitized.PATH = process.platform === "win32"
    ? [systemRoot, systemRoot && path.join(systemRoot, "System32"), systemRoot && path.join(systemRoot, "System32", "Wbem")].filter(Boolean).join(";")
    : process.platform === "darwin"
      ? "/usr/bin:/bin:/usr/sbin:/sbin"
      : "/usr/bin:/bin";
  return sanitized;
};

const sanitizeBootstrapEnvironment = (environment, { cache, userConfig, globalConfig }) => {
  const sanitized = sanitizeBrowserEnvironment(environment);
  for (const key of [
    "NODE_OPTIONS", "NODE_PATH", "NPM_CONFIG_NODE_OPTIONS", "npm_config_node_options",
    "NPM_CONFIG_USERCONFIG", "npm_config_userconfig", "NPM_CONFIG_GLOBALCONFIG",
    "npm_config_globalconfig", "NPM_CONFIG_PREFIX", "npm_config_prefix",
    "NPM_CONFIG_SCRIPT_SHELL", "npm_config_script_shell", "INIT_CWD",
  ]) delete sanitized[key];
  return {
    ...sanitized,
    NPM_CONFIG_NODE_OPTIONS: "",
    npm_config_node_options: "",
    NPM_CONFIG_REGISTRY: "https://registry.npmjs.org/",
    npm_config_registry: "https://registry.npmjs.org/",
    NPM_CONFIG_CACHE: cache,
    npm_config_cache: cache,
    NPM_CONFIG_USERCONFIG: userConfig,
    npm_config_userconfig: userConfig,
    NPM_CONFIG_GLOBALCONFIG: globalConfig,
    npm_config_globalconfig: globalConfig,
    NPM_CONFIG_IGNORE_SCRIPTS: "true",
    npm_config_ignore_scripts: "true",
    NPM_CONFIG_BIN_LINKS: "false",
    npm_config_bin_links: "false",
    NPM_CONFIG_AUDIT: "false",
    npm_config_audit: "false",
    NPM_CONFIG_FUND: "false",
    npm_config_fund: "false",
  };
};

export const buildChromiumLaunchOptions = ({ executablePath, headless, downloadsPath, acceptDownloads = false, timeoutMs = DEFAULT_TIMEOUT_MS, environment = process.env }) => ({
  executablePath,
  headless,
  // Telegram messages and attachments are untrusted web content. Chromium's
  // OS sandbox is therefore a hard runtime invariant. Do not retry with
  // --no-sandbox if the machine cannot satisfy it; doctor must report failure.
  chromiumSandbox: true,
  bypassCSP: false,
  ignoreHTTPSErrors: false,
  locale: "en-US",
  viewport: { width: 1440, height: 1000 },
  acceptDownloads,
  downloadsPath,
  serviceWorkers: "allow",
  timeout: Math.min(timeoutMs, 30_000),
  args: ["--lang=en-US"],
  env: sanitizeBrowserEnvironment(environment),
});

const readFreshPackageJson = async (file, maximumBytes = 128 * 1024) => {
  try {
    const metadata = await lstat(file);
    if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.size > maximumBytes) return null;
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return null;
  }
};

/**
 * Hash the exact installed package bytes rather than trusting package.json or
 * a copied lockfile.  A same-user process can replace ordinary files in a
 * persistent cache after bootstrap; every subsequent load therefore walks the
 * complete pinned tree, rejects links/special/extra entries through the final
 * aggregate, and verifies each file identity before returning its digest.
 */
const digestTrustedPackageTree = async (packageRoot, environment = process.env) => {
  void environment;
  const digest = createHash("sha256");
  digest.update("trelio-playwright-core-tree/v1\0");
  const fileEntries = [];
  let totalBytes = 0;

  const assertTreePath = async (absolute, expectedKind) => {
    const metadata = await lstat(absolute);
    const correctKind = expectedKind === "directory" ? metadata.isDirectory() : metadata.isFile();
    if (metadata.isSymbolicLink() || !correctKind) {
      fail("TELEGRAM_WEB_RUNTIME_INTEGRITY_FAILED", "The pinned browser runtime tree contains a symlink or special entry.");
    }
    const currentUserId = typeof process.getuid === "function" ? process.getuid() : null;
    if (currentUserId !== null && metadata.uid !== currentUserId) {
      fail("TELEGRAM_WEB_RUNTIME_INTEGRITY_FAILED", "The pinned browser runtime tree contains an entry owned by another user.");
    }
    if (process.platform === "win32") {
      // The runtime root receives a protected inherited DACL during bootstrap;
      // canonical no-reparse checks remain mandatory for every child.
      if ((await realpath(absolute)).toLocaleLowerCase("en-US") !== path.resolve(absolute).toLocaleLowerCase("en-US")) {
        fail("TELEGRAM_WEB_RUNTIME_INTEGRITY_FAILED", "The pinned browser runtime tree resolves through a reparse point.");
      }
    } else if ((metadata.mode & 0o022) !== 0 || await realpath(absolute) !== path.resolve(absolute)) {
      fail("TELEGRAM_WEB_RUNTIME_INTEGRITY_FAILED", "The pinned browser runtime tree is writable by another principal or resolves through a link.");
    }
    await assertSafeMacExtendedAcl(absolute, "private-leaf", metadata.uid);
    const after = await lstat(absolute);
    if (after.dev !== metadata.dev
      || after.ino !== metadata.ino
      || after.mode !== metadata.mode
      || after.uid !== metadata.uid
      || after.gid !== metadata.gid) {
      fail("TELEGRAM_WEB_RUNTIME_INTEGRITY_FAILED", "The pinned browser runtime tree changed identity during ACL verification.");
    }
    return metadata;
  };

  const walk = async (directory, relativeDirectory = "", depth = 0) => {
    if (depth > 32) fail("TELEGRAM_WEB_RUNTIME_INTEGRITY_FAILED", "The pinned browser runtime tree exceeded its maximum directory depth.");
    const entries = await readdir(directory, { withFileTypes: true });
    // npm's exact playwright-core tree has no empty directories. Because the
    // aggregate below hashes file paths/bytes, rejecting every empty child is
    // what makes an injected empty directory observable without changing the
    // independently reproduced file-tree digest constant.
    if (depth > 0 && entries.length === 0) {
      fail("TELEGRAM_WEB_RUNTIME_INTEGRITY_FAILED", "The pinned browser runtime tree contains an unexpected empty directory.");
    }
    const portableNames = new Set();
    for (const entry of entries) {
      if (!entry.name || entry.name === "." || entry.name === ".." || entry.name.includes("/") || entry.name.includes("\\")) {
        fail("TELEGRAM_WEB_RUNTIME_INTEGRITY_FAILED", "The pinned browser runtime tree contains an unsafe path segment.");
      }
      const portableName = entry.name.normalize("NFC").toLocaleLowerCase("en-US");
      if (portableNames.has(portableName)) {
        fail("TELEGRAM_WEB_RUNTIME_INTEGRITY_FAILED", "The pinned browser runtime tree contains a cross-platform case or Unicode path collision.");
      }
      portableNames.add(portableName);
      const relative = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      const absolute = path.join(directory, entry.name);
      const metadata = await lstat(absolute);
      if (metadata.isSymbolicLink() || (!metadata.isDirectory() && !metadata.isFile())) {
        fail("TELEGRAM_WEB_RUNTIME_INTEGRITY_FAILED", "The pinned browser runtime tree contains a symlink or special entry.");
      }
      if (metadata.isDirectory()) {
        await assertTreePath(absolute, "directory");
        await walk(absolute, relative, depth + 1);
      } else {
        await assertTreePath(absolute, "file");
        fileEntries.push({ absolute, relative });
      }
    }
  };

  await assertTreePath(packageRoot, "directory");
  await walk(packageRoot);
  fileEntries.sort((left, right) => Buffer.compare(
    Buffer.from(left.relative, "utf8"),
    Buffer.from(right.relative, "utf8"),
  ));
  if (fileEntries.length > MAX_PINNED_PACKAGE_FILES) {
    fail("TELEGRAM_WEB_RUNTIME_INTEGRITY_FAILED", "The pinned browser runtime tree exceeded its exact bounded package shape.");
  }

  for (const { absolute, relative } of fileEntries) {
    const pathMetadata = await assertTreePath(absolute, "file");
    totalBytes += pathMetadata.size;
    if (totalBytes > MAX_PINNED_PACKAGE_BYTES) {
      fail("TELEGRAM_WEB_RUNTIME_INTEGRITY_FAILED", "The pinned browser runtime tree exceeded its exact bounded byte size.");
    }
    const flags = fsConstants.O_RDONLY | (process.platform === "win32" ? 0 : (fsConstants.O_NOFOLLOW || 0));
    let handle;
    try {
      handle = await open(absolute, flags);
      const before = await handleStatExact(handle);
      if (!before.isFile()
        || before.dev !== pathMetadata.dev
        || before.ino !== pathMetadata.ino
        || before.size !== pathMetadata.size
        || before.mtimeNs !== pathMetadata.mtimeNs) {
        fail("TELEGRAM_WEB_RUNTIME_INTEGRITY_FAILED", "A pinned browser runtime file changed before hashing.");
      }
      digest.update(`F\0${relative}\0${before.size}\0`);
      let offset = 0;
      while (offset < before.size) {
        const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, before.size - offset));
        const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, offset);
        if (bytesRead <= 0) fail("TELEGRAM_WEB_RUNTIME_INTEGRITY_FAILED", "A pinned browser runtime file ended during hashing.");
        digest.update(buffer.subarray(0, bytesRead));
        offset += bytesRead;
      }
      digest.update("\0");
      const [after, currentPath] = await Promise.all([handleStatExact(handle), lstat(absolute)]);
      if (after.dev !== before.dev
        || after.ino !== before.ino
        || after.size !== before.size
        || after.mtimeNs !== before.mtimeNs
        || currentPath.isSymbolicLink()
        || !currentPath.isFile()
        || currentPath.dev !== before.dev
        || currentPath.ino !== before.ino
        || currentPath.size !== before.size
        || currentPath.mtimeNs !== before.mtimeNs) {
        fail("TELEGRAM_WEB_RUNTIME_INTEGRITY_FAILED", "A pinned browser runtime file changed while it was hashed.");
      }
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }
  return { sha256: digest.digest("hex"), files: fileEntries.length, totalBytes };
};

const exactDirectoryEntryNames = async (directory, expected, errorMessage, { allowMissing = false } = {}) => {
  const entries = await readdir(directory, { withFileTypes: true });
  const names = entries.map((entry) => entry.name).sort((left, right) => Buffer.compare(
    Buffer.from(left, "utf8"),
    Buffer.from(right, "utf8"),
  ));
  const expectedNames = [...expected].sort((left, right) => Buffer.compare(
    Buffer.from(left, "utf8"),
    Buffer.from(right, "utf8"),
  ));
  if (names.some((name) => !expectedNames.includes(name))) {
    fail("TELEGRAM_WEB_RUNTIME_INTEGRITY_FAILED", errorMessage);
  }
  if (canonicalJson(names) !== canonicalJson(expectedNames)) {
    if (allowMissing) return null;
    fail("TELEGRAM_WEB_RUNTIME_INTEGRITY_FAILED", errorMessage);
  }
  return new Map(entries.map((entry) => [entry.name, entry]));
};

/**
 * Prevent at-rest additions outside the digested package from influencing
 * Node's bare-specifier resolution. npm's hidden lock is allowed as inert
 * metadata; no sibling package or .bin link is part of the runtime shape.
 */
const verifyExactRuntimeRootShape = async (root, environment = process.env) => {
  const rootEntries = await exactDirectoryEntryNames(
    root,
    ["node_modules", "package-lock.json", "package.json"],
    "The pinned browser runtime root contains an unexpected file or npm-consumed project state.",
    { allowMissing: true },
  );
  if (!rootEntries) return false;
  if (!rootEntries.get("node_modules")?.isDirectory()
    || !rootEntries.get("package-lock.json")?.isFile()
    || !rootEntries.get("package.json")?.isFile()) {
    fail("TELEGRAM_WEB_RUNTIME_INTEGRITY_FAILED", "The pinned browser runtime root has an unexpected path type.");
  }
  const nodeModules = path.join(root, "node_modules");
  await verifyTrustedContainedPath(nodeModules, "directory", environment);
  const moduleEntries = await exactDirectoryEntryNames(
    nodeModules,
    [".package-lock.json", "playwright-core"],
    "The pinned browser runtime node_modules contains an unexpected sibling package or executable link.",
    { allowMissing: true },
  );
  if (!moduleEntries) return false;
  if (!moduleEntries.get(".package-lock.json")?.isFile() || !moduleEntries.get("playwright-core")?.isDirectory()) {
    fail("TELEGRAM_WEB_RUNTIME_INTEGRITY_FAILED", "The pinned browser runtime node_modules has an unexpected path type.");
  }
  const hiddenLockPath = path.join(nodeModules, ".package-lock.json");
  if (!await verifyTrustedContainedPath(hiddenLockPath, "file", environment)) {
    fail("TELEGRAM_WEB_RUNTIME_INTEGRITY_FAILED", "The pinned browser runtime hidden npm lock is missing.");
  }
  const hiddenLock = await readFreshPackageJson(hiddenLockPath);
  if (hiddenLock?.lockfileVersion !== 3
    || Object.keys(hiddenLock?.packages || {}).join(",") !== "node_modules/playwright-core"
    || hiddenLock.packages["node_modules/playwright-core"]?.version !== PLAYWRIGHT_VERSION
    || hiddenLock.packages["node_modules/playwright-core"]?.integrity !== PLAYWRIGHT_CORE_SSRI) {
    fail("TELEGRAM_WEB_RUNTIME_INTEGRITY_FAILED", "The pinned browser runtime hidden npm lock does not match the exact package graph.");
  }
  return true;
};

const inspectPinnedPlaywrightRoot = async (root, environment = process.env) => {
  root = path.resolve(root);
  if (!await verifyExistingPrivateTree(resolveCacheHome(environment), root, environment)) {
    return { ready: false, entryReal: null };
  }
  if (!await verifyExactRuntimeRootShape(root, environment)) return { ready: false, entryReal: null };
  const packageRoot = path.join(root, "node_modules", "playwright-core");
  if (!await verifyTrustedContainedDirectoryChain(root, packageRoot, environment)) return { ready: false, entryReal: null };
  const rootPackagePath = path.join(root, "package.json");
  const lockPath = path.join(root, "package-lock.json");
  const packageJsonPath = path.join(packageRoot, "package.json");
  for (const file of [rootPackagePath, lockPath, packageJsonPath]) {
    if (!await verifyTrustedContainedPath(file, "file", environment)) return { ready: false, entryReal: null };
  }
  try {
    const rootPackage = await readFreshPackageJson(rootPackagePath);
    const packageJson = await readFreshPackageJson(packageJsonPath);
    const lock = await readFreshPackageJson(lockPath);
    if (rootPackage?.name !== "trelio-telegram-web-runtime"
      || rootPackage?.private !== true
      || rootPackage?.dependencies?.["playwright-core"] !== PLAYWRIGHT_VERSION
      || Object.keys(rootPackage.dependencies || {}).length !== 1
      || packageJson?.version !== PLAYWRIGHT_VERSION
      || (packageJson?.main ?? "index.js") !== "index.js"
      || lock?.lockfileVersion !== 3
      || lock?.packages?.["node_modules/playwright-core"]?.version !== PLAYWRIGHT_VERSION
      || lock?.packages?.["node_modules/playwright-core"]?.integrity !== PLAYWRIGHT_CORE_SSRI) {
      return { ready: false, entryReal: null };
    }
    const tree = await digestTrustedPackageTree(packageRoot, environment);
    if (tree.sha256 !== PLAYWRIGHT_CORE_TREE_SHA256) {
      fail(
        "TELEGRAM_WEB_RUNTIME_INTEGRITY_FAILED",
        "The installed playwright-core tree does not match the exact embedded digest of the pinned npm package. Re-bootstrap the private runtime before any browser use.",
      );
    }
    const entry = path.resolve(packageRoot, packageJson.main ?? "index.js");
    const relative = path.relative(packageRoot, entry);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
      fail("TELEGRAM_WEB_RUNTIME_VERSION_MISMATCH", "Telegram Web playwright-core entrypoint escaped its exact pinned package root.");
    }
    if (!await verifyTrustedContainedPath(entry, "file", environment)) return { ready: false, entryReal: null };
    const entryReal = await realpath(entry);
    const packageRootReal = await realpath(packageRoot);
    if (!pathIsSameOrDescendant(entryReal, packageRootReal) || entryReal === packageRootReal) {
      fail("TELEGRAM_WEB_RUNTIME_VERSION_MISMATCH", "Telegram Web playwright-core entrypoint escaped its exact pinned package root.");
    }
    return { ready: true, entryReal };
  } catch (error) {
    if (error instanceof TelegramWebRuntimeError) throw error;
    return { ready: false, entryReal: null };
  }
};

const inspectPinnedPlaywright = async (identity, environment = process.env) => (
  inspectPinnedPlaywrightRoot(runtimeRoot(identity, environment), environment)
);

const hasPinnedPlaywright = async (identity, environment = process.env) => (
  (await inspectPinnedPlaywright(identity, environment)).ready
);

/**
 * Explicit bootstrap is the only path allowed to recover an ordinary-file
 * byte-integrity failure. Doctor, probe and every content command continue to
 * surface the integrity error without changing the persistent runtime.
 */
const hasPinnedPlaywrightForBootstrap = async (identity, environment = process.env) => {
  try {
    return await hasPinnedPlaywright(identity, environment);
  } catch (error) {
    if (error instanceof TelegramWebRuntimeError && [
      "TELEGRAM_WEB_RUNTIME_INTEGRITY_FAILED",
      "TELEGRAM_WEB_RUNTIME_VERSION_MISMATCH",
    ].includes(error.code)) return false;
    if (error instanceof TelegramWebRuntimeError && error.code === "TELEGRAM_WEB_UNSAFE_PATH") {
      // Repair only unsafe entries *below* an independently reverified exact
      // runtime root. An unsafe cache ancestor, namespace or root itself stays
      // fail-closed and is never renamed/deleted automatically.
      const exactRootBoundarySafe = await verifyExistingPrivateTree(
        resolveCacheHome(environment),
        runtimeRoot(identity, environment),
        environment,
      );
      if (exactRootBoundarySafe) return false;
    }
    throw error;
  }
};

const guardedPlaywrightPackageRoots = new Set();
let originalCommonJsModuleLoad = null;

const externalModuleBlockedError = (request) => {
  const error = new Error(`Cannot find module '${String(request)}'`);
  error.code = "MODULE_NOT_FOUND";
  return error;
};

/**
 * playwright-core declares zero dependencies but contains optional bare
 * requires (for example bufferutil/fsevents). Without a lifetime guard Node
 * could satisfy one from an attacker-added ancestor node_modules after the
 * package digest passed. Parents inside a verified playwright-core root may
 * load builtins or canonical files in that same digested root only.
 */
const installPlaywrightCommonJsLoadGuard = (packageRoot) => {
  const canonicalRoot = realpathSync(packageRoot);
  guardedPlaywrightPackageRoots.add(canonicalRoot);
  if (originalCommonJsModuleLoad) return;
  const Module = require("node:module");
  const builtins = new Set(Module.builtinModules.flatMap((name) => [name, `node:${name}`]));
  originalCommonJsModuleLoad = Module._load;
  Module._load = function guardedPlaywrightLoad(request, parent, isMain) {
    const parentFilename = typeof parent?.filename === "string" ? path.resolve(parent.filename) : null;
    const guardedRoot = parentFilename && [...guardedPlaywrightPackageRoots].find((root) => {
      const relative = path.relative(root, parentFilename);
      return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
    });
    if (!guardedRoot) return originalCommonJsModuleLoad.call(this, request, parent, isMain);

    let canonicalParent;
    try {
      canonicalParent = realpathSync(parentFilename);
    } catch {
      throw externalModuleBlockedError(request);
    }
    const parentRelative = path.relative(guardedRoot, canonicalParent);
    if (parentRelative.startsWith("..") || path.isAbsolute(parentRelative)) throw externalModuleBlockedError(request);
    if (builtins.has(request) || String(request).startsWith("node:")) {
      return originalCommonJsModuleLoad.call(this, request, parent, isMain);
    }
    const pathLike = path.isAbsolute(String(request))
      || String(request).startsWith("./")
      || String(request).startsWith("../");
    if (!pathLike) throw externalModuleBlockedError(request);
    let resolved;
    let canonicalTarget;
    try {
      resolved = Module._resolveFilename(request, parent, isMain);
      if (!path.isAbsolute(resolved)) throw new Error("non-file resolution");
      canonicalTarget = realpathSync(resolved);
    } catch {
      throw externalModuleBlockedError(request);
    }
    const targetRelative = path.relative(guardedRoot, canonicalTarget);
    if (targetRelative.startsWith("..") || path.isAbsolute(targetRelative)) throw externalModuleBlockedError(request);
    return originalCommonJsModuleLoad.call(this, canonicalTarget, parent, isMain);
  };
};

const loadPlaywright = async (identity, environment = process.env) => {
  const inspection = await inspectPinnedPlaywright(identity, environment);
  if (!inspection.ready || !inspection.entryReal) {
    fail("TELEGRAM_WEB_RUNTIME_MISSING", "Telegram Web browser runtime is unavailable or incomplete. Run bootstrap first.");
  }
  try {
    installPlaywrightCommonJsLoadGuard(path.join(runtimeRoot(identity, environment), "node_modules", "playwright-core"));
    const loaded = require(inspection.entryReal);
    if (!loaded?.chromium || typeof loaded.chromium.launchPersistentContext !== "function") {
      fail("TELEGRAM_WEB_RUNTIME_VERSION_MISMATCH", "Pinned playwright-core did not expose the required Chromium persistent-context API.");
    }
    return loaded;
  } catch (error) {
    if (error instanceof TelegramWebRuntimeError) throw error;
    fail("TELEGRAM_WEB_RUNTIME_MISSING", "Telegram Web browser runtime failed its trusted load smoke test. Run bootstrap again after repairing only this runtime cache.");
  }
};

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

const verifyCanonicalContainedFile = async (trustedRoot, candidate, { allowTestRoot = false } = {}) => {
  const root = path.resolve(trustedRoot);
  const file = path.resolve(candidate);
  const relative = path.relative(root, file);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return false;
  if (!allowTestRoot) {
    if (root === path.parse(root).root) return false;
    // Versioned Node installs under ~/.nvm are valid for local Codex/Claude.
    // Workspace and temporary roots remain untrusted code-loading locations.
    const untrusted = [os.tmpdir(), process.cwd()].map((value) => path.resolve(value));
    if (untrusted.some((value) => {
      const left = path.relative(root, value);
      const right = path.relative(value, root);
      return (!left.startsWith("..") && !path.isAbsolute(left)) || (!right.startsWith("..") && !path.isAbsolute(right));
    })) return false;
  }
  const rootMetadata = await lstat(root).catch(() => null);
  if (!rootMetadata || rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory()) return false;
  const rootReal = await realpath(root).catch(() => null);
  const normalize = (value) => process.platform === "win32" ? value.toLocaleLowerCase("en-US") : value;
  if (!rootReal || normalize(rootReal) !== normalize(root)) return false;
  let current = root;
  const segments = relative.split(path.sep).filter(Boolean);
  for (let index = 0; index < segments.length; index += 1) {
    current = path.join(current, segments[index]);
    const metadata = await lstat(current).catch(() => null);
    const final = index === segments.length - 1;
    if (!metadata
      || metadata.isSymbolicLink()
      || (final ? !metadata.isFile() : !metadata.isDirectory())) return false;
  }
  const fileReal = await realpath(file).catch(() => null);
  return Boolean(fileReal && normalize(fileReal) === normalize(file));
};

export const resolveTrustedNpmInvocation = async (dependencies = {}) => {
  const nodeExecutable = path.resolve(dependencies.nodeExecutable || process.execPath);
  const nodeMetadata = await lstat(nodeExecutable).catch(() => null);
  const canonicalNodeExecutable = await realpath(nodeExecutable).catch(() => null);
  const sameCanonicalNode = canonicalNodeExecutable && (process.platform === "win32"
    ? canonicalNodeExecutable.toLocaleLowerCase("en-US") === nodeExecutable.toLocaleLowerCase("en-US")
    : canonicalNodeExecutable === nodeExecutable);
  if (!nodeMetadata
    || nodeMetadata.isSymbolicLink()
    || !nodeMetadata.isFile()
    || (process.platform !== "win32" && (nodeMetadata.mode & 0o111) === 0)
    || !sameCanonicalNode) {
    fail("TELEGRAM_WEB_BOOTSTRAP_FAILED", "The trusted absolute Node.js executable has an unsafe type.");
  }
  const executableDirectory = path.dirname(nodeExecutable);
  const testOnlyOverride = dependencies.testOnlyNpmLayout === true;
  if ((dependencies.nodeExecutable || dependencies.npmCliPath) && !testOnlyOverride) {
    fail("TELEGRAM_WEB_BOOTSTRAP_FAILED", "Injected Node/npm paths are accepted only by explicit deterministic runtime tests.");
  }
  const layouts = dependencies.npmCliPath ? [{
    candidate: path.resolve(dependencies.npmCliPath),
    trustedRoot: path.resolve(executableDirectory, ".."),
  }] : [
    {
      candidate: path.join(executableDirectory, "node_modules", "npm", "bin", "npm-cli.js"),
      trustedRoot: executableDirectory,
    },
    {
      candidate: path.resolve(executableDirectory, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
      trustedRoot: path.resolve(executableDirectory, ".."),
    },
    {
      candidate: path.resolve(executableDirectory, "..", "..", "..", "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
      trustedRoot: path.resolve(executableDirectory, "..", "..", "..", ".."),
    },
  ];
  for (const { candidate, trustedRoot } of layouts) {
    const metadata = await lstat(candidate).catch(() => null);
    if (!metadata || metadata.isSymbolicLink() || !metadata.isFile()) continue;
    if (process.platform !== "win32" && (metadata.mode & 0o022) !== 0) continue;
    if (!await verifyCanonicalContainedFile(trustedRoot, candidate, { allowTestRoot: testOnlyOverride })) continue;
    if (!await verifyCanonicalContainedFile(trustedRoot, nodeExecutable, { allowTestRoot: testOnlyOverride })) continue;
    try {
      if (process.platform === "win32") {
        await verifyWindowsMachineExecutableChain(nodeExecutable, trustedRoot);
        await verifyWindowsMachineExecutableChain(candidate, trustedRoot);
      } else {
        await assertTrustedPosixExecutableChain(nodeExecutable);
        await assertTrustedPosixPathChain(candidate, { requireExecutable: false });
      }
    } catch (error) {
      if (error instanceof TelegramWebRuntimeError && error.code === "TELEGRAM_WEB_UNSAFE_PATH") continue;
      throw error;
    }
    return { executable: nodeExecutable, argsPrefix: [candidate], trustedRoot };
  }
  fail("TELEGRAM_WEB_BOOTSTRAP_FAILED", "Could not locate npm-cli.js under the trusted Node.js installation; the runtime will not execute npm through PATH or the workspace.");
};

export const bootstrapBrowserRuntime = async (
  identity,
  environment = process.env,
  dependencies = {},
) => {
  if (await hasPinnedPlaywrightForBootstrap(identity, environment)) {
    return { ok: true, runtimeReady: true, playwrightVersion: PLAYWRIGHT_VERSION, cached: true };
  }
  const cacheHome = resolveCacheHome(environment);
  const lockFile = `${runtimeRoot(identity, environment)}.bootstrap.lock`;
  await ensurePrivateTree(cacheHome, path.dirname(lockFile), environment);
  const deadline = Date.now() + 10 * 60_000;
  while (true) {
    try {
      return await withOwnedFileLock({
        lockFile,
        trustedBase: cacheHome,
        environment,
        busyCode: "TELEGRAM_WEB_BOOTSTRAP_BUSY",
        busyMessage: "Another process is installing the shared Telegram Web runtime.",
      }, async () => {
        if (await hasPinnedPlaywrightForBootstrap(identity, environment)) {
          return { ok: true, runtimeReady: true, playwrightVersion: PLAYWRIGHT_VERSION, cached: true };
        }
        return installBrowserRuntimeUnlocked(identity, environment, dependencies);
      });
    } catch (error) {
      if (!(error instanceof TelegramWebRuntimeError) || error.code !== "TELEGRAM_WEB_BOOTSTRAP_BUSY") throw error;
      if (await hasPinnedPlaywrightForBootstrap(identity, environment)) {
        return { ok: true, runtimeReady: true, playwrightVersion: PLAYWRIGHT_VERSION, cached: true };
      }
      if (Date.now() >= deadline) {
        fail("TELEGRAM_WEB_BOOTSTRAP_BUSY", "The shared Telegram Web runtime bootstrap did not complete within the bounded wait.");
      }
      await wait(250);
    }
  }
};

const sameFileIdentity = (left, right) => Boolean(
  left && right && !left.isSymbolicLink() && !right.isSymbolicLink()
  && left.dev === right.dev && left.ino === right.ino
);

const unusedPrivateSiblingPath = async (parent, label) => {
  for (let attempt = 0; attempt < 32; attempt += 1) {
    const candidate = path.join(parent, `.${label}.${process.pid}.${randomUUID()}`);
    if (!await lstat(candidate).catch((error) => {
      if (error?.code === "ENOENT") return null;
      throw error;
    })) return candidate;
  }
  fail("TELEGRAM_WEB_BOOTSTRAP_FAILED", "Could not reserve a fresh private sibling path for browser runtime bootstrap.");
};

/**
 * Create a random, exclusive private sibling below the already protected
 * telegram-web cache namespace. npm is allowed to see only roots created by
 * this call; it never receives the persistent (possibly tampered) root as cwd
 * or --prefix.
 */
const createFreshBootstrapDirectory = async (parent, label, environment) => {
  const cacheHome = resolveCacheHome(environment);
  await ensurePrivateTree(cacheHome, parent, environment);
  for (let attempt = 0; attempt < 32; attempt += 1) {
    const candidate = await unusedPrivateSiblingPath(parent, label);
    try {
      await mkdir(candidate, { mode: 0o700 });
    } catch (error) {
      if (error?.code === "EEXIST") continue;
      throw error;
    }
    await assertRealPrivateDirectory(candidate, true, environment);
    const metadata = await lstat(candidate);
    return { path: candidate, identity: metadata };
  }
  fail("TELEGRAM_WEB_BOOTSTRAP_FAILED", "Could not create a fresh private browser runtime bootstrap directory.");
};

/**
 * Remove only the cooperative/local-lifecycle directory identity captured by
 * this process. Rename-to-graveyard prevents an accidental or cooperating
 * contender from placing a replacement at the public path before recursive
 * cleanup. This is not a defence boundary against malware running as the same
 * OS user, which could also instrument arbitrary Node filesystem operations.
 */
const removeOwnedDirectoryByRename = async (owned, environment, {
  changedCode = "TELEGRAM_WEB_UNSAFE_STATE",
  changedMessage = "A private Telegram Web directory changed identity before safe removal and was preserved.",
  dependencies = {},
} = {}) => {
  if (!owned?.path || !owned.identity) return;
  const current = await lstat(owned.path).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (!current) return;
  if (!current.isDirectory() || !sameFileIdentity(current, owned.identity)) {
    fail(changedCode, changedMessage);
  }
  await assertRealPrivateDirectory(owned.path, false, environment);
  const graveyard = await unusedPrivateSiblingPath(path.dirname(owned.path), `${path.basename(owned.path)}.cleanup`);
  await rename(owned.path, graveyard);
  await dependencies.afterPublicRename?.({ publicPath: owned.path, movedPath: graveyard });
  const moved = await lstat(graveyard);
  if (!moved.isDirectory() || !sameFileIdentity(moved, owned.identity)) {
    fail(changedCode, changedMessage);
  }
  await rm(graveyard, { recursive: true, force: true, maxRetries: 2, retryDelay: 50 });
};

const removeOwnedBootstrapDirectory = (owned, environment) => removeOwnedDirectoryByRename(owned, environment, {
  changedCode: "TELEGRAM_WEB_BOOTSTRAP_REPAIR_REQUIRED",
  changedMessage: "A private browser-runtime staging directory changed identity during cleanup; it was preserved for manual inspection.",
});

/**
 * Publish a completely verified sibling tree. The old root is quarantined by
 * rename and is never used as an npm project. A synchronous failure restores
 * it; a process crash leaves either the old or the new root (or no root), and
 * the next explicit bootstrap can build another fresh sibling without
 * consulting either leftover as npm configuration.
 */
const promoteVerifiedRuntime = async (identity, staged, environment) => {
  const root = runtimeRoot(identity, environment);
  const parent = path.dirname(root);
  const stagedInspection = await inspectPinnedPlaywrightRoot(staged.path, environment);
  if (!stagedInspection.ready) {
    fail("TELEGRAM_WEB_BOOTSTRAP_FAILED", "The fresh staged playwright-core runtime did not pass exact byte verification.");
  }
  const stagedCurrent = await lstat(staged.path);
  if (!stagedCurrent.isDirectory() || !sameFileIdentity(stagedCurrent, staged.identity)) {
    fail("TELEGRAM_WEB_BOOTSTRAP_REPAIR_REQUIRED", "The verified browser-runtime staging root changed identity before promotion.");
  }

  let previous = null;
  let promoted = false;
  try {
    const existing = await lstat(root).catch((error) => {
      if (error?.code === "ENOENT") return null;
      throw error;
    });
    if (existing) {
      await assertRealPrivateDirectory(root, false, environment);
      const quarantinePath = await unusedPrivateSiblingPath(parent, `${path.basename(root)}.previous`);
      await rename(root, quarantinePath);
      const quarantined = await lstat(quarantinePath);
      if (!quarantined.isDirectory() || !sameFileIdentity(quarantined, existing)) {
        fail("TELEGRAM_WEB_BOOTSTRAP_REPAIR_REQUIRED", "The previous browser runtime changed identity while it was quarantined.");
      }
      previous = { path: quarantinePath, identity: quarantined };
    }

    await rename(staged.path, root);
    const published = await lstat(root);
    if (!published.isDirectory() || !sameFileIdentity(published, staged.identity)) {
      fail("TELEGRAM_WEB_BOOTSTRAP_REPAIR_REQUIRED", "The staged browser runtime changed identity during atomic promotion.");
    }
    promoted = true;
    const finalInspection = await inspectPinnedPlaywrightRoot(root, environment);
    if (!finalInspection.ready) {
      fail("TELEGRAM_WEB_BOOTSTRAP_FAILED", "The promoted browser runtime failed its exact post-publication verification.");
    }
  } catch (error) {
    let rollbackFailed = false;
    let failedPublished = null;
    if (promoted) {
      try {
        const published = await lstat(root);
        if (!published.isDirectory() || !sameFileIdentity(published, staged.identity)) throw new Error("published identity changed");
        const failedPath = await unusedPrivateSiblingPath(parent, `${path.basename(root)}.failed`);
        await rename(root, failedPath);
        const moved = await lstat(failedPath);
        if (!moved.isDirectory() || !sameFileIdentity(moved, staged.identity)) throw new Error("failed tree identity changed");
        failedPublished = { path: failedPath, identity: moved };
      } catch {
        rollbackFailed = true;
      }
    }
    if (previous) {
      try {
        if (await lstat(root).catch(() => null)) throw new Error("runtime root unexpectedly occupied");
        await rename(previous.path, root);
        const restored = await lstat(root);
        if (!restored.isDirectory() || !sameFileIdentity(restored, previous.identity)) throw new Error("restored identity changed");
        previous = null;
      } catch {
        rollbackFailed = true;
      }
    }
    if (failedPublished) await removeOwnedBootstrapDirectory(failedPublished, environment).catch(() => { rollbackFailed = true; });
    if (rollbackFailed) {
      fail("TELEGRAM_WEB_BOOTSTRAP_REPAIR_REQUIRED", "Browser runtime promotion failed and could not be rolled back safely; run bootstrap again after inspecting the private runtime cache.");
    }
    throw error;
  }

  if (previous) await removeOwnedBootstrapDirectory(previous, environment);
};

const installBrowserRuntimeUnlocked = async (identity, environment = process.env, dependencies = {}) => {
  const root = runtimeRoot(identity, environment);
  const parent = path.dirname(root);
  const cacheHome = resolveCacheHome(environment);
  await ensurePrivateTree(cacheHome, parent, environment);
  const packageDocument = {
    name: "trelio-telegram-web-runtime",
    version: "1.0.2",
    private: true,
    dependencies: { "playwright-core": PLAYWRIGHT_VERSION },
  };
  const lockDocument = {
    name: "trelio-telegram-web-runtime",
    version: "1.0.2",
    lockfileVersion: 3,
    requires: true,
    packages: {
      "": {
        name: "trelio-telegram-web-runtime",
        version: "1.0.2",
        dependencies: { "playwright-core": PLAYWRIGHT_VERSION },
      },
      "node_modules/playwright-core": {
        version: PLAYWRIGHT_VERSION,
        resolved: `https://registry.npmjs.org/playwright-core/-/playwright-core-${PLAYWRIGHT_VERSION}.tgz`,
        integrity: PLAYWRIGHT_CORE_SSRI,
        license: "Apache-2.0",
        bin: { "playwright-core": "cli.js" },
        engines: { node: ">=18" },
      },
    },
  };
  const npm = await resolveTrustedNpmInvocation(dependencies);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    if (await hasPinnedPlaywrightForBootstrap(identity, environment)) {
      return { ok: true, runtimeReady: true, playwrightVersion: PLAYWRIGHT_VERSION };
    }
    let staged = null;
    let bootstrapFiles = null;
    let transient = false;
    try {
      staged = await createFreshBootstrapDirectory(parent, `${path.basename(root)}.install`, environment);
      bootstrapFiles = await createFreshBootstrapDirectory(parent, `${path.basename(root)}.npm`, environment);
      const packageFile = path.join(staged.path, "package.json");
      const packageLockFile = path.join(staged.path, "package-lock.json");
      // The deterministic project and lockfile are written only into the new
      // sibling. Existing runtime .npmrc files or npm-consumed state are never
      // opened by repair.
      await writePrivateJson(packageFile, packageDocument, cacheHome, environment);
      await writePrivateJson(packageLockFile, lockDocument, cacheHome, environment);
      const npmCache = path.join(bootstrapFiles.path, "cache");
      const npmUserConfig = path.join(bootstrapFiles.path, "user.conf");
      const npmGlobalConfig = path.join(bootstrapFiles.path, "global.conf");
      await ensurePrivateTree(cacheHome, npmCache, environment);
      await writePrivateText(npmUserConfig, "", cacheHome, environment);
      await writePrivateText(npmGlobalConfig, "", cacheHome, environment);
      const npmEnvironment = sanitizeBootstrapEnvironment(environment, {
        cache: npmCache,
        userConfig: npmUserConfig,
        globalConfig: npmGlobalConfig,
      });
      // Reprove both code paths immediately before the process boundary; the
      // earlier layout discovery is not an execution-time identity proof.
      if (process.platform === "win32") {
        await verifyWindowsMachineExecutableChain(npm.executable, npm.trustedRoot, environment);
        await verifyWindowsMachineExecutableChain(npm.argsPrefix[0], npm.trustedRoot, environment);
      } else {
        await assertTrustedPosixExecutableChain(npm.executable);
        await assertTrustedPosixPathChain(npm.argsPrefix[0], { requireExecutable: false });
      }
      const result = (dependencies.spawnSync || spawnSync)(npm.executable, [
        ...npm.argsPrefix,
        "ci",
        "--prefix",
        staged.path,
        "--ignore-scripts",
        "--no-bin-links",
        "--no-audit",
        "--no-fund",
        "--registry=https://registry.npmjs.org/",
        `--cache=${npmCache}`,
        `--userconfig=${npmUserConfig}`,
        `--globalconfig=${npmGlobalConfig}`,
      ], {
        encoding: "utf8",
        env: npmEnvironment,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        cwd: staged.path,
        timeout: 120_000,
        killSignal: "SIGTERM",
        maxBuffer: 512 * 1024,
      });
      // npm helper state is outside the candidate and is destroyed before any
      // candidate verification or publication.
      await removeOwnedBootstrapDirectory(bootstrapFiles, environment);
      bootstrapFiles = null;

      const diagnostic = `${result?.error?.code || ""}\n${result?.stderr || ""}\n${result?.stdout || ""}`;
      transient = /ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENETUNREACH|socket hang up|5\d\d/iu.test(diagnostic);
      if (result?.status === 0) transient = false;
      let inspection = { ready: false, entryReal: null };
      try {
        inspection = await inspectPinnedPlaywrightRoot(staged.path, environment);
      } catch (error) {
        if (!(error instanceof TelegramWebRuntimeError) || ![
          "TELEGRAM_WEB_RUNTIME_INTEGRITY_FAILED",
          "TELEGRAM_WEB_RUNTIME_VERSION_MISMATCH",
          "TELEGRAM_WEB_UNSAFE_PATH",
        ].includes(error.code)) throw error;
        // A reset can leave malformed bytes or an incomplete path type. This
        // fresh stage is never reused: classify retry from npm's transport
        // diagnostic, discard it in finally, and create another fresh stage.
      }
      if (inspection.ready) {
        // A transport reset can be reported after all verified bytes landed.
        // Promote only the exact digest, independent of npm's exit status.
        await promoteVerifiedRuntime(identity, staged, environment);
        staged = null;
        return { ok: true, runtimeReady: true, playwrightVersion: PLAYWRIGHT_VERSION };
      }
    } finally {
      if (bootstrapFiles) await removeOwnedBootstrapDirectory(bootstrapFiles, environment);
      if (staged) await removeOwnedBootstrapDirectory(staged, environment);
    }
    if (!transient || attempt === 3) break;
    await wait(500 * (2 ** attempt));
  }
  fail("TELEGRAM_WEB_BOOTSTRAP_FAILED", "Could not install and verify the pinned Telegram Web browser runtime after bounded safe retries.");
};

const isProcessAlive = (pid) => {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
};

const validateLockRecord = (record) => Boolean(
  record
  && typeof record === "object"
  && Object.keys(record).sort().join(",") === "pid,startedAt,token"
  && Number.isInteger(Number(record.pid))
  && Number(record.pid) > 0
  && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(String(record.token || ""))
  && typeof record.startedAt === "string"
  && Number.isFinite(Date.parse(record.startedAt))
  && new Date(Date.parse(record.startedAt)).toISOString() === record.startedAt
);

const readLockSnapshot = async (lockFile, environment) => {
  const metadata = await lstat(lockFile).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (!metadata) return null;
  if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.size > 4 * 1024) {
    fail("TELEGRAM_WEB_UNSAFE_STATE", "A Telegram Web coordination lock has an unsafe type or size.");
  }
  await assertPrivatePath(lockFile, "file", environment);
  const record = await readBoundedJson(lockFile, 4 * 1024, null);
  if (!validateLockRecord(record)) fail("TELEGRAM_WEB_UNSAFE_STATE", "A Telegram Web coordination lock is malformed.");
  const verifiedMetadata = await lstat(lockFile);
  if (verifiedMetadata.dev !== metadata.dev || verifiedMetadata.ino !== metadata.ino) {
    fail("TELEGRAM_WEB_LOCK_CHANGED", "A Telegram Web coordination lock changed while it was inspected.");
  }
  return { record, dev: metadata.dev, ino: metadata.ino };
};

const removeLockIfUnchanged = async (lockFile, expected, environment, dependencies = {}) => {
  // Claim this exact stale/owned inode with a deterministic hard link before
  // unlinking its public name. Only the process that creates the claim may
  // proceed. A delayed cooperating lock contender therefore cannot have its
  // replacement public lock unlinked (the classic check/remove ABA race).
  const claimFile = `${lockFile}.reap-${expected.record.token}`;
  try {
    await link(lockFile, claimFile);
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "EEXIST") return false;
    throw error;
  }
  try {
    const claim = await readLockSnapshot(claimFile, environment);
    if (
      !claim
      || claim.dev !== expected.dev
      || claim.ino !== expected.ino
      || claim.record.token !== expected.record.token
    ) return false;
    const releaseFile = `${lockFile}.release-${expected.record.token}-${randomUUID()}`;
    try {
      // Rename is the public-name linearization point. A replacement created
      // immediately afterwards remains at lockFile and is never unlinked.
      await rename(lockFile, releaseFile);
    } catch (error) {
      if (error?.code === "ENOENT" || error?.code === "EEXIST") return false;
      throw error;
    }
    await dependencies.afterPublicRename?.({ publicPath: lockFile, movedPath: releaseFile });
    let moved;
    try {
      moved = await readLockSnapshot(releaseFile, environment);
    } catch (error) {
      // Restore the known old inode from its hard-link claim if the moved name
      // was replaced. Preserve the unexpected moved leaf for inspection.
      await link(claimFile, lockFile).catch((linkError) => {
        if (linkError?.code !== "EEXIST") throw linkError;
      });
      throw error;
    }
    if (!moved
      || moved.dev !== claim.dev
      || moved.ino !== claim.ino
      || moved.record.token !== claim.record.token) {
      await link(claimFile, lockFile).catch((error) => {
        if (error?.code !== "EEXIST") throw error;
      });
      return false;
    }
    await rm(releaseFile, { force: false });
    return true;
  } finally {
    await rm(claimFile, { force: true }).catch(() => undefined);
  }
};

const createOwnedLock = async (lockFile, environment) => {
  const token = randomUUID();
  const record = { pid: process.pid, token, startedAt: new Date().toISOString() };
  const lockBody = `${JSON.stringify(record)}\n`;
  let handle;
  try {
    handle = await open(lockFile, "wx", 0o600);
    await handle.writeFile(lockBody, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    if (process.platform !== "win32") await chmod(lockFile, 0o600);
    await assertPrivatePath(lockFile, "file", environment, true);
    const snapshot = await readLockSnapshot(lockFile, environment);
    if (!snapshot || snapshot.record.token !== token) fail("TELEGRAM_WEB_LOCK_CHANGED", "Telegram Web could not prove ownership of its coordination lock.");
    return snapshot;
  } finally {
    await handle?.close().catch(() => undefined);
  }
};

export const withOwnedFileLock = async ({
  lockFile,
  trustedBase,
  environment = process.env,
  busyCode,
  busyMessage,
}, callback) => {
  await ensurePrivateTree(trustedBase, path.dirname(lockFile), environment);
  let owned = null;
  try {
    owned = await createOwnedLock(lockFile, environment);
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    // Another process can observe the exclusive lock inode in the tiny window
    // between open("wx") and the owner's durable JSON write. Treat that exact
    // EEXIST+partial snapshot as busy; never delete it and never mistake a
    // concurrent valid owner for corrupt state.
    const current = await readLockSnapshot(lockFile, environment).catch((snapshotError) => {
      if (snapshotError?.code === "ENOENT"
        || (snapshotError instanceof TelegramWebRuntimeError && snapshotError.code === "TELEGRAM_WEB_UNSAFE_STATE")) {
        fail(busyCode, busyMessage);
      }
      throw snapshotError;
    });
    if (!current || isProcessAlive(Number(current.record.pid))) fail(busyCode, busyMessage);
    // Never reap a dead-PID lock automatically. Filesystem APIs do not offer
    // a portable compare-and-unlink primitive, so automatic stale cleanup can
    // delete a replacement lock under forced ABA interleaving. Fail closed and
    // require an explicit local repair after the operator confirms no process
    // owns the dedicated profile/runtime directory.
    fail(
      "TELEGRAM_WEB_STALE_LOCK_REPAIR_REQUIRED",
      "Telegram Web found a dead-owner coordination lock and did not remove it automatically. Verify no Telegram Web runtime is running, then remove that one exact local lock file before retrying.",
    );
  }

  const verified = await readLockSnapshot(lockFile, environment);
  if (!verified || verified.record.token !== owned.record.token || verified.dev !== owned.dev || verified.ino !== owned.ino) {
    fail("TELEGRAM_WEB_LOCK_CHANGED", "Telegram Web lost ownership of its lock before protected work began.");
  }

  let preserveOwnedLock = false;
  try {
    return await callback();
  } catch (error) {
    preserveOwnedLock = error?.preserveTelegramWebProfileLock === true;
    throw error;
  } finally {
    if (!preserveOwnedLock) {
      const released = await removeLockIfUnchanged(lockFile, owned, environment);
      if (!released) fail("TELEGRAM_WEB_LOCK_CHANGED", "Telegram Web could not prove safe release of its owned lock.");
    }
  }
};

export const acquireProfileLock = async (identity, callback, environment = process.env) => {
  const locations = runtimeLocations(identity, environment);
  return withOwnedFileLock({
    lockFile: locations.lockFile,
    trustedBase: resolveConfigHome(environment),
    environment,
    busyCode: "TELEGRAM_WEB_PROFILE_BUSY",
    busyMessage: "The dedicated Telegram Web profile is already in use by another runtime process.",
  }, callback);
};

const acquireConsentStateLock = async (identity, callback, environment = process.env) => {
  const locations = runtimeLocations(identity, environment);
  const deadline = Date.now() + 10_000;
  while (true) {
    try {
      return await withOwnedFileLock({
        lockFile: locations.consentLockFile,
        trustedBase: resolveConfigHome(environment),
        environment,
        busyCode: "TELEGRAM_WEB_CONSENT_STATE_BUSY",
        busyMessage: "Telegram Web consent state is being updated by another local invocation.",
      }, callback);
    } catch (error) {
      if (!(error instanceof TelegramWebRuntimeError)
        || error.code !== "TELEGRAM_WEB_CONSENT_STATE_BUSY"
        || Date.now() >= deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
};

const waitForTelegramSurface = async (page, timeoutMs) => {
  try {
    await page.waitForFunction(() => {
      const visible = (element) => {
        const rectangle = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        return rectangle.width > 1 && rectangle.height > 1 && style.display !== "none" && style.visibility !== "hidden";
      };
      return Array.from(document.querySelectorAll(
        '.chatlist-chat[data-peer-id], .input-message-input[contenteditable="true"], button, input, canvas, [role="button"]',
      )).some(visible);
    }, null, { timeout: Math.min(timeoutMs, UI_READY_TIMEOUT_MS) });
    return true;
  } catch (error) {
    // A normal bounded selector timeout means only "not ready" and permits
    // the one documented fallback navigation. Page closure, renderer errors,
    // command-lifecycle aborts, and every other failure must retain their
    // caller's sanitized stage instead of being mistaken for blank UI.
    if (error?.name === "TimeoutError") return false;
    throw error;
  }
};

export const classifyTelegramSurface = async (page) => page.evaluate(({
  chatListSelector,
  composerSelector,
  bubblesSelector,
  loginSelector,
  passwordSelector,
}) => {
  // Authentication/probe/consent/inspect all call this classifier before a
  // content grant may exist. Use structural selectors only: a broad body text
  // read could collect the currently visible chat even when an authenticated
  // Web K build drifted away from one of the expected logged-in selectors.
  // Web K can retain hidden/stale chat nodes while moving from the QR surface
  // to two-step verification. Mere DOM presence must therefore never prove a
  // completed login. Geometry/style are the only properties inspected here;
  // in particular, the runtime never reads password value/text/HTML.
  const visible = (element) => {
    if (!element || typeof element.getBoundingClientRect !== "function") return false;
    const rectangle = element.getBoundingClientRect();
    const style = globalThis.getComputedStyle(element);
    return rectangle.width > 1
      && rectangle.height > 1
      && style.display !== "none"
      && style.visibility !== "hidden";
  };
  const hasVisible = (selector) => Array.from(document.querySelectorAll(selector)).some(visible);
  const hasChatList = hasVisible(chatListSelector);
  const hasComposer = hasVisible(composerSelector);
  const passwordInput = hasVisible(passwordSelector);
  const protectedCredentialSurface = passwordInput;
  // A visible password/passcode handoff wins over every stale chat node. This
  // covers both Telegram two-step verification and a local Web K passcode
  // without trying to distinguish them by reading sensitive page content.
  const loggedIn = !protectedCredentialSurface
    && (hasChatList || hasComposer || hasVisible(bubblesSelector));
  const locked = !loggedIn && protectedCredentialSurface;
  const login = !loggedIn
    && !locked
    && hasVisible(loginSelector);
  return {
    loggedIn,
    login,
    locked,
    supported: loggedIn || login || locked,
    hasChatList,
    hasComposer,
  };
}, {
  chatListSelector: TELEGRAM_CHAT_LIST_SELECTOR,
  composerSelector: TELEGRAM_COMPOSER_SELECTOR,
  bubblesSelector: TELEGRAM_BUBBLES_SELECTOR,
  loginSelector: TELEGRAM_LOGIN_SURFACE_SELECTOR,
  passwordSelector: TELEGRAM_PASSWORD_SELECTOR,
});

/**
 * Wait through the complete account-owner login handoff without one long
 * provider evaluation. A long `page.waitForFunction()` would be truncated by
 * the generic 30-second provider-stall fence, which previously closed Chrome
 * just as QR login reached Telegram two-step verification. Short structural
 * polls remain inside the referenced absolute command lifecycle, while this
 * owner-handoff deadline alone controls how long the visible window stays up.
 *
 * Success requires both a visible authenticated surface and the canonical
 * account identity proof. A visible password/passcode field never qualifies,
 * even if Web K has already mounted hidden chat nodes or populated managers.
 * No credential value, text, HTML, keystroke, or form API is accessed.
 */
export const waitForAuthenticatedTelegramAccount = async (
  page,
  expectedAccount,
  holdMs,
  dependencies = {},
) => {
  const classify = dependencies.classifyTelegramSurface || classifyTelegramSurface;
  const readAccountDigest = dependencies.readCurrentTelegramAccountDigest || readCurrentTelegramAccountDigest;
  const now = dependencies.now || Date.now;
  const waitForPoll = dependencies.waitForPoll
    || ((delayMs) => page.waitForTimeout(delayMs));
  const deadlineAt = now() + holdMs;
  let candidateDigest = null;
  let candidateSince = null;

  while (true) {
    const surface = await classify(page);
    if (surface?.loggedIn === true && surface?.locked !== true) {
      try {
        const digest = await readAccountDigest(page, expectedAccount);
        const observedAt = now();
        if (digest !== candidateDigest) {
          candidateDigest = digest;
          candidateSince = observedAt;
        } else if (candidateSince !== null
          && observedAt - candidateSince >= LOGIN_AUTH_STABILITY_MS) return digest;
      } catch (error) {
        // Web K may mount its visible chat shell a moment before rootScope and
        // AccountController agree. Treat only that exact not-ready identity
        // state as transitional; every other runtime/security error escapes.
        if (!(error instanceof TelegramWebRuntimeError)
          || error.code !== "TELEGRAM_WEB_ACCOUNT_ID_INVALID") throw error;
        candidateDigest = null;
        candidateSince = null;
      }
    } else {
      candidateDigest = null;
      candidateSince = null;
    }

    const remainingMs = deadlineAt - now();
    if (remainingMs <= 0) {
      fail(
        "TELEGRAM_WEB_LOGIN_TIMEOUT",
        "Telegram Web login was not completed in the visible dedicated browser before the bounded hold expired.",
      );
    }
    const candidateRemainingMs = candidateSince === null
      ? 250
      : Math.max(1, LOGIN_AUTH_STABILITY_MS - (now() - candidateSince));
    await waitForPoll(Math.min(250, remainingMs, candidateRemainingMs));
  }
};

const waitForVerifiedLoggedOutSurface = async (page, timeoutMs, dependencies = {}) => {
  const classify = dependencies.classifyTelegramSurface || classifyTelegramSurface;
  const readProviderState = dependencies.readConfiguredAccountCount || readConfiguredAccountCount;
  const now = dependencies.now || Date.now;
  const waitForPoll = dependencies.waitForPoll
    || ((delayMs) => page.waitForTimeout(delayMs));
  const deadlineAt = now() + timeoutMs;

  // Logout is the second long account-owner handoff. Keep it off a single
  // waitForFunction for the same reason as login: the generic renderer-stall
  // fence intentionally remains 30 seconds, while the person may need the full
  // configured hold to find and complete Telegram's visible logout action.
  while (true) {
    const surface = await classify(page);
    if (surface?.loggedIn === false
      && surface?.locked === false
      && surface?.login === true) {
      // Web K can render the QR/login shell one frame before it finishes
      // clearing AccountController and rootScope. Treat that overlap as a
      // normal transition, not as a completed logout or an immediate
      // ambiguity. A provider evaluation timeout/error still escapes this
      // helper through the bounded page proxy and therefore remains fail-closed.
      const providerState = await readProviderState(page);
      if (providerState?.known === true
        && providerState.count === 0
        && providerState.activeIdentityPresent === false) return true;
    }
    const remainingMs = deadlineAt - now();
    if (remainingMs <= 0) throw new Error("TELEGRAM_WEB_LOGOUT_SURFACE_NOT_VERIFIED");
    await waitForPoll(Math.min(250, remainingMs));
  }
};

export const isAllowedTelegramTopLevelUrl = (value, expectedAccount = null) => {
  if (typeof value !== "string"
    || value.length < 1
    || value.length > 2_048
    || DISPLAY_LABEL_UNSAFE_TEST_PATTERN.test(value)) return false;
  const canonical = /^https:\/\/web\.telegram\.org\/k\/(?:\?account=([2-4]))?(?:#(-?\d{1,24}))?$/u.exec(value);
  if (!canonical) return false;
  const slot = canonical[1] === undefined ? 1 : Number(canonical[1]);
  if (expectedAccount !== null && slot !== expectedAccount) return false;
  if (canonical[2] === undefined) return true;
  const numericPeer = Number(canonical[2]);
  return Number.isSafeInteger(numericPeer)
    && numericPeer !== 0
    && String(numericPeer) === canonical[2];
};

const assertTrustedPage = (page, account) => {
  if (!isAllowedTelegramTopLevelUrl(page.url(), account)) {
    fail("TELEGRAM_WEB_EXTERNAL_NAVIGATION_BLOCKED", "Telegram Web attempted to leave the fixed official Web K origin. The runtime stopped before continuing.");
  }
};

const openTelegramHome = async (page, options, { allowLoggedOut = false } = {}) => {
  if (options.blockAccountWideMessageSearch === true) {
    await prepareAccountWideSearchGuardForNavigation(page, options);
  }
  const canonicalHomeUrl = telegramWebUrlForAccount(options.account);
  const restoredCanonicalHome = page.url() === canonicalHomeUrl;
  // A persistent Chrome context may return its restored Web K page while that
  // page is still completing the navigation started by session restoration.
  // Starting a second page.goto() immediately can interrupt either navigation
  // and surface only a native Playwright error. First give an already exact
  // account-home page the same bounded structural readiness proof used after
  // navigation. A ready restored page needs no network/navigation retry.
  let ready = restoredCanonicalHome
    ? await waitForTelegramSurface(page, options.timeoutMs)
    : false;
  if (!ready) {
    // This is the one fallback navigation for a canonical restored page that
    // did not become structurally ready. about:blank/new pages take this same
    // path as their ordinary first navigation.
    await page.goto(canonicalHomeUrl, { waitUntil: "domcontentloaded", timeout: options.timeoutMs });
    ready = await waitForTelegramSurface(page, options.timeoutMs);
  }
  if (!ready && !restoredCanonicalHome) {
    // One blank-shell reload is bounded and happens before any user mutation.
    // Do not add this second navigation to the restored-page recovery path:
    // that path already received a readiness wait plus one fallback goto.
    await page.reload({ waitUntil: "domcontentloaded", timeout: options.timeoutMs });
    ready = await waitForTelegramSurface(page, options.timeoutMs);
  }
  assertTrustedPage(page, options.account);
  if (!ready) fail("TELEGRAM_WEB_UI_UNSUPPORTED", "Telegram Web K rendered no supported interactive surface after bounded restored-page and navigation checks.");
  const surface = await classifyTelegramSurface(page);
  if (!surface.supported) fail("TELEGRAM_WEB_UI_UNSUPPORTED", "Telegram Web K UI fingerprint is not supported by this runtime release.");
  if (!allowLoggedOut && !surface.loggedIn) {
    fail(
      surface.locked ? "TELEGRAM_WEB_UNLOCK_REQUIRED" : "TELEGRAM_WEB_LOGIN_REQUIRED",
      surface.locked
        ? "Telegram Web dedicated profile is passcode-locked. Run headed login and unlock it personally; the runtime never reads or types the passcode."
        : "Telegram Web login is required. Run login and complete authentication in the visible dedicated window.",
    );
  }
  if (options.blockAccountWideMessageSearch === true && surface.loggedIn) {
    await refreshAccountWideMessageSearchGuard(page, options, { contextReset: true });
  }
  return surface;
};

const resetDownloadStaging = async (locations, environment = process.env, dependencies = {}) => {
  const relative = path.relative(locations.root, locations.downloadStagingDirectory);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) fail("TELEGRAM_WEB_UNSAFE_PATH", "Telegram Web download staging escaped its exact connection root.");
  await ensurePrivateTree(resolveConfigHome(environment), path.dirname(locations.downloadStagingDirectory), environment);
  const metadata = await lstat(locations.downloadStagingDirectory).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (metadata) {
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) fail("TELEGRAM_WEB_UNSAFE_STATE", "Telegram Web download staging has an unsafe type.");
    await assertRealPrivateDirectory(locations.downloadStagingDirectory, false, environment);
    await removeOwnedDirectoryByRename({ path: locations.downloadStagingDirectory, identity: metadata }, environment, {
      changedCode: "TELEGRAM_WEB_DOWNLOAD_STAGING_REPAIR_REQUIRED",
      changedMessage: "Telegram Web download staging changed identity during safe reset; no replacement directory was recursively removed.",
      dependencies,
    });
  }
  await ensurePrivateTree(resolveConfigHome(environment), locations.downloadStagingDirectory, environment);
};

const profileTeardownUnverified = () => {
  const error = new TelegramWebRuntimeError(
    "TELEGRAM_WEB_PROFILE_TEARDOWN_UNVERIFIED",
    "Telegram Web could not prove that the persistent browser process closed. The exact profile lock was preserved; verify no browser process owns the profile, then repair that one stale lock before retrying.",
  );
  error.preserveTelegramWebProfileLock = true;
  return error;
};

/**
 * Playwright's public persistent-context client does not expose the Chrome
 * ChildProcess.  The exact pinned 1.60.0 server launches Chrome in this same
 * Node process through node:child_process.spawn, however.  Intercept only the
 * synchronous launch window, require the verified executable plus exact
 * --user-data-dir argument, and restore the built-in before returning.  This
 * gives teardown an OS process-group capability without scraping the process
 * table or trusting undocumented client fields that are absent in 1.60.0.
 */
export const launchPersistentContextWithProcess = async ({
  chromium,
  userDataDirectory,
  launchOptions,
}) => {
  const childProcessModule = require("node:child_process");
  const originalSpawn = childProcessModule.spawn;
  const expectedExecutable = launchOptions.executablePath;
  const expectedProfileArgument = `--user-data-dir=${userDataDirectory}`;
  let capturedProcess = null;
  let matchingLaunches = 0;
  let context = null;
  let launchError = null;
  let spawnHookChanged = false;

  function captureExactBrowserSpawn(command, args, spawnOptions) {
    const child = Reflect.apply(originalSpawn, this, [command, args, spawnOptions]);
    if (command === expectedExecutable
      && Array.isArray(args)
      && args.includes(expectedProfileArgument)) {
      matchingLaunches += 1;
      if (matchingLaunches === 1) {
        capturedProcess = {
          child,
          command,
          detached: spawnOptions?.detached === true,
          pid: child.pid,
          get exitCode() { return child.exitCode; },
          get signalCode() { return child.signalCode; },
        };
      }
    }
    return child;
  }

  childProcessModule.spawn = captureExactBrowserSpawn;
  try {
    context = await chromium.launchPersistentContext(userDataDirectory, launchOptions);
  } catch (error) {
    launchError = error;
  } finally {
    if (childProcessModule.spawn === captureExactBrowserSpawn) {
      childProcessModule.spawn = originalSpawn;
    } else {
      // A second in-process writer changed the same global launch primitive.
      // Do not overwrite it silently and do not claim an exclusive PID proof.
      spawnHookChanged = true;
    }
  }

  const pid = Number(capturedProcess?.pid);
  const captureValid = !spawnHookChanged
    && matchingLaunches === 1
    && capturedProcess?.command === expectedExecutable
    && Number.isSafeInteger(pid)
    && pid > 0
    && (process.platform === "win32" || capturedProcess.detached === true);
  if (launchError) {
    if (matchingLaunches === 0 && !spawnHookChanged) throw launchError;
    if (!captureValid) throw profileTeardownUnverified();
    try {
      if (capturedBrowserProcessAlive(capturedProcess)
        || capturedBrowserProcessGroupAlive(capturedProcess)) {
        await terminateCapturedBrowserProcess(capturedProcess, true);
      }
      const deadline = Date.now() + 2_000;
      while ((capturedBrowserProcessAlive(capturedProcess)
        || capturedBrowserProcessGroupAlive(capturedProcess)) && Date.now() < deadline) await wait(25);
    } catch {
      throw profileTeardownUnverified();
    }
    if (capturedBrowserProcessAlive(capturedProcess)
      || capturedBrowserProcessGroupAlive(capturedProcess)) throw profileTeardownUnverified();
    throw launchError;
  }
  if (!captureValid) {
    // The context may be live, but without one exact process(-group) handle it
    // is unsafe to release the persistent-profile lock after any later hang.
    // Try graceful close as hygiene; the preserved lock is the safety proof.
    if (context) {
      let timer;
      await Promise.race([
        Promise.resolve().then(() => context.close()).catch(() => undefined),
        new Promise((resolve) => {
          timer = setTimeout(resolve, 5_000);
        }),
      ]).finally(() => clearTimeout(timer));
    }
    throw profileTeardownUnverified();
  }
  return { context, browserProcess: capturedProcess };
};

const capturedBrowserProcessAlive = (browserProcess) => {
  const pid = Number(browserProcess?.pid);
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  if (browserProcess.exitCode !== null || browserProcess.signalCode !== null) return false;
  return isProcessAlive(pid);
};

const capturedBrowserProcessGroupAlive = (browserProcess) => {
  const pid = Number(browserProcess?.pid);
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  if (process.platform === "win32" || browserProcess?.detached !== true) {
    return capturedBrowserProcessAlive(browserProcess);
  }
  // A detached Chrome parent can exit before one of its descendants. Probe
  // the exact process group even after ChildProcess exitCode is populated;
  // parent exit alone is not proof that the persistent profile was released.
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    return true;
  }
};

const terminateCapturedBrowserProcess = async (browserProcess, force, environment = process.env) => {
  const pid = Number(browserProcess?.pid);
  if (!Number.isSafeInteger(pid) || pid <= 0) throw profileTeardownUnverified();
  if (process.platform === "win32") {
    const taskkill = await resolveTrustedWindowsSystemExecutable(environment, "taskkill.exe");
    await execFileAsync(taskkill, ["/pid", String(pid), "/T", "/F"], {
      cwd: path.dirname(taskkill),
      env: sanitizeBrowserEnvironment(environment),
      timeout: 5_000,
      windowsHide: true,
      maxBuffer: 64 * 1024,
    });
    return;
  }
  if (browserProcess.detached !== true) throw profileTeardownUnverified();
  try {
    process.kill(-pid, force ? "SIGKILL" : "SIGTERM");
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
};

export const closePersistentContextVerified = async (context, dependencies = {}) => {
  const browser = typeof context?.browser === "function" ? context.browser() : null;
  // The process handle comes only from the exact synchronous spawn capture
  // above. Playwright 1.60.0's public client has no browserProcess field.
  const browserProcess = dependencies.browserProcess || null;
  const environment = dependencies.environment || process.env;
  if (!browserProcess) throw profileTeardownUnverified();
  const closeTimeoutMs = dependencies.closeTimeoutMs || 5_000;
  const settleWithin = async (promise, milliseconds) => {
    let timer;
    try {
      return await Promise.race([
        Promise.resolve(promise).then(
          (value) => ({ status: "fulfilled", value }),
          (error) => ({ status: "rejected", error }),
        ),
        new Promise((resolve) => {
          timer = setTimeout(() => resolve({ status: "timeout" }), milliseconds);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  // BrowserContext.close has no Playwright timeout option. Bound it here, then
  // actively terminate the exact launched ChildProcess if graceful teardown
  // wedged. The lock is released only after disconnect/process-exit proof.
  const closeOutcome = await settleWithin(
    Promise.resolve().then(() => context.close()),
    closeTimeoutMs,
  );
  const browserConnected = () => browser
    && (typeof browser.isConnected !== "function" || browser.isConnected());
  const processAlive = () => capturedBrowserProcessAlive(browserProcess);
  const processGroupAlive = () => capturedBrowserProcessGroupAlive(browserProcess);
  if (closeOutcome.status !== "fulfilled" || browserConnected() || processAlive() || processGroupAlive()) {
    if (!browserProcess) {
      throw profileTeardownUnverified();
    }
    try {
      if (dependencies.terminateBrowserProcess) {
        await dependencies.terminateBrowserProcess(browserProcess, false);
      } else {
        await terminateCapturedBrowserProcess(browserProcess, false, environment);
      }
    } catch {
      // Continue to the mandatory exit proof/stronger termination attempt.
    }
    let deadline = Date.now() + 1_000;
    while ((processAlive() || processGroupAlive()) && Date.now() < deadline) await wait(25);
    if (processAlive() || processGroupAlive()) {
      try {
        if (dependencies.terminateBrowserProcess) {
          await dependencies.terminateBrowserProcess(browserProcess, true);
        } else {
          await terminateCapturedBrowserProcess(browserProcess, true, environment);
        }
      } catch {
        throw profileTeardownUnverified();
      }
      deadline = Date.now() + 2_000;
      while ((processAlive() || processGroupAlive()) && Date.now() < deadline) await wait(25);
    }
    // Give Playwright's transport one bounded turn to observe the exact OS
    // process exit; both facts are required before the profile lock is freed.
    deadline = Date.now() + 1_000;
    while (browserConnected() && Date.now() < deadline) await wait(25);
    if (browserConnected() && typeof browser?.close === "function") {
      await settleWithin(Promise.resolve().then(() => browser.close()), 500);
    }
  }
  if (browserConnected() || processAlive() || processGroupAlive()) throw profileTeardownUnverified();
};

/**
 * A persistent Chromium profile can restore several tabs after a crash.  The
 * Telegram account and composer are shared between those tabs, so allowing a
 * second page to survive would make every later peer/composer assertion racy.
 * Close and verify all restored extras before installing command handlers.
 */
const prepareSinglePersistentPage = async (context, dependencies = {}) => {
  const bound = dependencies.bound || (async (promise) => promise);
  const unexpectedPages = new Set();
  const pagesCreatedForPrimary = new Set();
  let primary = null;
  let creatingPrimary = false;
  const onPage = (candidate) => {
    // context.newPage() emits `page` before its promise resolves. Buffer that
    // one creation window so the returned page can be designated primary;
    // every other candidate remains an unexpected second tab.
    if (!primary && creatingPrimary) {
      pagesCreatedForPrimary.add(candidate);
      return;
    }
    if (candidate === primary) return;
    unexpectedPages.add(candidate);
    dependencies.onUnexpectedPage?.(candidate);
  };
  context.on?.("page", onPage);
  const restored = context.pages();
  if (restored[0]) {
    primary = restored[0];
  } else {
    creatingPrimary = true;
    try {
      primary = await bound(Promise.resolve().then(() => context.newPage()), "creating the primary page");
    } finally {
      creatingPrimary = false;
    }
    for (const candidate of pagesCreatedForPrimary) {
      if (candidate === primary) continue;
      unexpectedPages.add(candidate);
      dependencies.onUnexpectedPage?.(candidate);
    }
  }
  unexpectedPages.delete(primary);
  // Re-enumeration closes the setup gap between pages() and handler install;
  // the live page listener captures every page created after that point.
  const extras = [...new Set([...restored.slice(1), ...context.pages().filter((page) => page !== primary), ...unexpectedPages])];
  for (const extra of extras) {
    try {
      await bound(
        Promise.resolve().then(() => extra.close({ runBeforeUnload: false })),
        "closing a restored extra page",
      );
    } catch {
      fail("TELEGRAM_WEB_UNSAFE_BROWSER_STATE", "Telegram Web could not close a restored extra profile tab before the command started.");
    }
    if (typeof extra.isClosed !== "function" || !extra.isClosed()) {
      fail("TELEGRAM_WEB_UNSAFE_BROWSER_STATE", "Telegram Web could not verify closure of a restored extra profile tab.");
    }
  }
  const survivors = context.pages().filter((page) => page !== primary && !page.isClosed?.());
  if (survivors.length !== 0) {
    fail("TELEGRAM_WEB_UNSAFE_BROWSER_STATE", "Telegram Web created another profile tab during bounded single-page setup.");
  }
  // Keep this first-installed guard for the context lifetime. Removing it
  // before the command-level page guard is attached would recreate the exact
  // setup race this helper is meant to close.
  return primary;
};

const commandLifecycleTimeoutError = (decisiveAttempted, label) => decisiveAttempted
  ? new TelegramWebRuntimeError(
    "TELEGRAM_WEB_MUTATION_OUTCOME_AMBIGUOUS",
    `Telegram Web exceeded its absolute lifecycle deadline after a decisive action may have started (${label}). Do not retry automatically or through telegram-mtproto; re-read exact live state first.`,
    { safeToRetry: false },
  )
  : new TelegramWebRuntimeError(
    "TELEGRAM_WEB_COMMAND_TIMEOUT",
    `Telegram Web exceeded its absolute lifecycle deadline before a decisive action (${label}). Browser termination and profile-lock proof are mandatory before retry.`,
    { safeToRetry: false },
  );

const createCommandLifecycle = (options) => {
  const ownerHandoffCommand = ["login", "logout", "inspect"].includes(options.command);
  // Browser setup is its own bounded phase. The owner-visible handoff is
  // armed only after the single guarded page has loaded and the runtime is
  // actually ready for the person. Otherwise slow setup consumes part of
  // holdMs and can reproduce the QR -> 2FA window-closing bug.
  const initialDurationMs = options.command === "consent" && options.subcommand === "accept"
    ? Math.max(options.timeoutMs || DEFAULT_TIMEOUT_MS, CONSENT_TIMEOUT_MS + 30_000)
    : options.timeoutMs || DEFAULT_TIMEOUT_MS;
  let deadlineAt = 0;
  let globalTimer = null;
  let ownerHandoffStarted = false;
  let aborted = false;
  let abortError = null;
  let decisiveAttempted = false;
  const abortHandlers = new Set();
  let rejectAbort;
  const abortSignal = new Promise((_, reject) => { rejectAbort = reject; });
  abortSignal.catch(() => undefined);
  const abort = (error) => {
    if (aborted) return abortError;
    aborted = true;
    abortError = error;
    rejectAbort(error);
    for (const handler of abortHandlers) {
      void Promise.resolve().then(() => handler(error)).catch(() => undefined);
    }
    return error;
  };
  const armDeadline = (durationMs, label) => {
    clearTimeout(globalTimer);
    deadlineAt = Date.now() + durationMs;
    globalTimer = setTimeout(() => abort(commandLifecycleTimeoutError(
      decisiveAttempted,
      label,
    )), durationMs);
  };
  armDeadline(initialDurationMs, "command deadline");
  // A command that is awaiting a stalled provider promise may have no other
  // referenced event-loop handle.  The absolute lifecycle timer therefore
  // stays referenced until stop(), so the process cannot disappear without
  // producing the required timeout/ambiguity result and teardown.
  const assertActive = (label = "operation") => {
    if (!aborted && Date.now() >= deadlineAt) abort(commandLifecycleTimeoutError(decisiveAttempted, label));
    if (aborted) throw abortError;
  };
  const race = async (promise, label, maximumMs = null) => {
    assertActive(label);
    // The single referenced global timer owns the mutable phase deadline.
    // An unbounded outer command race must not capture the old setup deadline:
    // beginOwnerHandoff() deliberately rearms it after the visible page is
    // ready. Provider operations pass maximumMs and keep their independent
    // fixed 30-second (or narrower) stall fence.
    if (maximumMs === null) {
      return Promise.race([Promise.resolve(promise), abortSignal]);
    }
    const remaining = Math.max(1, deadlineAt - Date.now());
    const boundedMs = Math.max(1, Math.min(remaining, maximumMs));
    let timer;
    const localTimeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        const error = commandLifecycleTimeoutError(decisiveAttempted, label);
        abort(error);
        reject(error);
      }, boundedMs);
    });
    try {
      return await Promise.race([Promise.resolve(promise), abortSignal, localTimeout]);
    } finally {
      clearTimeout(timer);
    }
  };
  return {
    abort,
    assertActive,
    beginOwnerHandoff: (holdMs, label = "owner handoff deadline") => {
      assertActive(label);
      if (!ownerHandoffCommand || ownerHandoffStarted) {
        fail("TELEGRAM_WEB_UNSAFE_STATE", "Telegram Web owner handoff lifecycle was armed in an invalid command phase.");
      }
      const normalizedHoldMs = Number(holdMs);
      if (!Number.isSafeInteger(normalizedHoldMs)
        || normalizedHoldMs < 1
        || normalizedHoldMs > Number.MAX_SAFE_INTEGER - 30_000) {
        fail("TELEGRAM_WEB_INVALID_ARGUMENT", "Telegram Web owner handoff requires one positive safe hold duration.");
      }
      ownerHandoffStarted = true;
      // The extra budget belongs only to post-handoff verification and exact
      // browser teardown. The helper itself still expires at exact holdMs.
      armDeadline(normalizedHoldMs + 30_000, label);
    },
    markDecisive: (label = "decisive action") => {
      assertActive(label);
      decisiveAttempted = true;
    },
    race,
    setAbortHandler: (handler) => { abortHandlers.add(handler); },
    onAbort: (handler) => {
      if (aborted) {
        void Promise.resolve().then(() => handler(abortError)).catch(() => undefined);
        return () => undefined;
      }
      abortHandlers.add(handler);
      return () => abortHandlers.delete(handler);
    },
    stop: () => clearTimeout(globalTimer),
    get aborted() { return aborted; },
    get decisiveAttempted() { return decisiveAttempted; },
  };
};

const boundedHandleProxy = (handle, lifecycle, timeoutMs) => new Proxy(handle, {
  get(target, property) {
    const value = Reflect.get(target, property, target);
    if (property === "jsonValue" && typeof value === "function") {
      return (...args) => lifecycle.race(
        Promise.resolve().then(() => value.apply(target, args)),
        "reading a provider evaluation handle",
        timeoutMs,
      );
    }
    return typeof value === "function" ? value.bind(target) : value;
  },
});

const boundedPageProxy = (page, lifecycle, options) => {
  const providerTimeoutMs = Math.min(options.timeoutMs || DEFAULT_TIMEOUT_MS, 30_000);
  return new Proxy(page, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (["evaluate", "evaluateHandle"].includes(property) && typeof value === "function") {
        return (...args) => lifecycle.race(
          Promise.resolve().then(() => value.apply(target, args)),
          `bounded page.${String(property)} provider evaluation`,
          providerTimeoutMs,
        ).then((result) => property === "evaluateHandle"
          ? boundedHandleProxy(result, lifecycle, providerTimeoutMs)
          : result);
      }
      if (property === "waitForFunction" && typeof value === "function") {
        return (...args) => lifecycle.race(
          Promise.resolve().then(() => value.apply(target, args)),
          "bounded page.waitForFunction provider evaluation",
          providerTimeoutMs,
        ).then((handle) => boundedHandleProxy(handle, lifecycle, providerTimeoutMs));
      }
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
};

const blockedNavigationError = (decisiveAttempted) => decisiveAttempted
  ? new TelegramWebRuntimeError(
    "TELEGRAM_WEB_MUTATION_OUTCOME_AMBIGUOUS",
    "Telegram Web opened an unexpected tab or navigation after a decisive action may have started. The browser context was closed; do not retry automatically or through telegram-mtproto, and re-read exact live state first.",
    { safeToRetry: false },
  )
  : new TelegramWebRuntimeError(
    "TELEGRAM_WEB_EXTERNAL_NAVIGATION_BLOCKED",
    "Telegram Web attempted a blocked top-level navigation or opened an unexpected tab. The browser context was closed immediately.",
  );

const withTelegramBrowser = async (identity, options, callback, environment = process.env) => acquireProfileLock(
  identity,
  async () => {
    const executablePath = await findChromeExecutable(environment);
    if (!executablePath) fail("TELEGRAM_WEB_CHROME_MISSING", "A supported local Google Chrome or Chromium installation was not found.");
    const locations = runtimeLocations(identity, environment);
    await ensurePrivateTree(resolveConfigHome(environment), locations.profileDirectory, environment);
    await resetDownloadStaging(locations, environment);
    const { chromium } = await loadPlaywright(identity, environment);
    // Recheck the exact browser bytes/ancestor identities immediately before
    // they receive the private persistent profile. The earlier discovery is
    // not treated as a durable capability across bootstrap or setup work.
    const launchExecutablePath = process.platform === "win32"
      ? await findChromeExecutable(environment)
      : await assertTrustedPosixExecutableChain(executablePath);
    if (!launchExecutablePath || launchExecutablePath !== executablePath) {
      fail("TELEGRAM_WEB_UNSAFE_PATH", "The selected fixed browser executable changed before launch.");
    }
    let context;
    let browserProcess;
    try {
      ({ context, browserProcess } = await launchPersistentContextWithProcess({
        chromium,
        userDataDirectory: locations.profileDirectory,
        launchOptions: buildChromiumLaunchOptions({
          executablePath: launchExecutablePath,
          headless: !options.headed,
          downloadsPath: locations.downloadStagingDirectory,
          acceptDownloads: options.command === "download",
          timeoutMs: options.timeoutMs,
          environment,
        }),
      }));
    } catch (error) {
      if (error instanceof TelegramWebRuntimeError) throw error;
      fail("TELEGRAM_WEB_SANDBOX_LAUNCH_FAILED", "Chrome could not start with the required Chromium sandbox. The runtime did not retry with weaker security.");
    }
    const lifecycle = createCommandLifecycle(options);
    options.commandLifecycle = lifecycle;
    let terminationPromise = null;
    const terminate = () => {
      terminationPromise ||= closePersistentContextVerified(context, { browserProcess, environment });
      return terminationPromise;
    };
    lifecycle.setAbortHandler(terminate);
    try {
      // The verified teardown covers every failure after launch, including
      // newPage(), restored-page cleanup, routing, and event-listener setup.
      // Otherwise a setup exception could release the profile lock while a
      // live Chrome process still owned the same persistent directory.
      let blockedNavigation = null;
      let rejectNavigationViolation;
      const navigationViolation = new Promise((_, reject) => {
        rejectNavigationViolation = reject;
      });
      navigationViolation.catch(() => undefined);
      const blockNavigation = (reason) => {
        if (blockedNavigation) return;
        blockedNavigation = reason;
        const error = blockedNavigationError(Boolean(options.commandLifecycle?.decisiveAttempted));
        rejectNavigationViolation(error);
        lifecycle.abort(error);
      };
      const primary = await prepareSinglePersistentPage(context, {
        bound: (promise, label) => lifecycle.race(promise, label, Math.min(options.timeoutMs, 10_000)),
        onUnexpectedPage: () => blockNavigation("unexpected_page"),
      });
      if (primary.url() !== "about:blank") assertTrustedPage(primary, options.account);
      await lifecycle.race(context.route("**/*", async (route) => {
        const request = route.request();
        if (request.isNavigationRequest() && request.frame() === primary.mainFrame()) {
          if (!isAllowedTelegramTopLevelUrl(request.url(), options.account)) {
            blockNavigation("invalid_url");
            await route.abort("blockedbyclient");
            return;
          }
        }
        await route.continue();
      }), "installing the fixed-origin route guard", Math.min(options.timeoutMs, 10_000));
      const setupPages = context.pages().filter((candidate) => !candidate.isClosed?.());
      if (setupPages.length !== 1 || setupPages[0] !== primary || blockedNavigation) {
        fail("TELEGRAM_WEB_UNSAFE_BROWSER_STATE", "Telegram Web could not prove a single fixed-origin profile tab after route setup.");
      }
      context.on("page", (candidate) => {
        if (candidate !== primary) blockNavigation("unexpected_page");
      });
      primary.on("popup", () => blockNavigation("unexpected_popup"));
      primary.on("framenavigated", (frame) => {
        if (frame !== primary.mainFrame() || frame.url() === "about:blank") return;
        if (!isAllowedTelegramTopLevelUrl(frame.url(), options.account)) blockNavigation("external_top_level");
      });
      const boundedPage = boundedPageProxy(primary, lifecycle, options);
      const result = await lifecycle.race(
        Promise.race([callback({ context, page: boundedPage }), navigationViolation]),
        "running the bounded Telegram Web command",
      );
      if (blockedNavigation) {
        fail("TELEGRAM_WEB_EXTERNAL_NAVIGATION_BLOCKED", "Telegram Web attempted a blocked top-level navigation. The runtime stopped and did not continue the action.");
      }
      assertTrustedPage(primary, options.account);
      return result;
    } finally {
      try {
        await terminate();
        await resetDownloadStaging(locations, environment);
      } finally {
        lifecycle.stop();
        delete options.commandLifecycle;
      }
    }
  },
  environment,
);

const normalizeTitle = (value) => sanitizeDisplayLabel(value)
  .toLocaleLowerCase("ru-RU");

/**
 * Every public result states whether it belongs to one canonical Web K account
 * slot. The slot is safe human-facing routing metadata (1..4), unlike the raw
 * Telegram user id or its private account digest, which must never be emitted.
 * Commands covering the whole connection profile use null deliberately.
 */
const withPublicAccountSlot = (result, accountSlot) => {
  if (accountSlot !== null
    && (!Number.isInteger(accountSlot) || accountSlot < 1 || accountSlot > 4)) {
    fail("TELEGRAM_WEB_INVALID_ACCOUNT", "A public Telegram Web result requires one canonical account slot from 1 through 4.");
  }
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    fail("TELEGRAM_WEB_UNSAFE_STATE", "Telegram Web produced an invalid public result envelope.");
  }
  if (Object.prototype.hasOwnProperty.call(result, "accountSlot")
    && result.accountSlot !== accountSlot) {
    fail("TELEGRAM_WEB_ACCOUNT_CHANGED", "Telegram Web produced a result for a different account slot than the selected canonical slot.");
  }
  const publicResult = { ...result, accountSlot };
  // This is the last public envelope step. Keep a global invariant even for a
  // future command that forgets to budget the slot before its own pruning.
  // Read/search include the slot before bounding, so ordinary boundary cases
  // are pruned rather than failing after this final check.
  if (Buffer.byteLength(JSON.stringify(publicResult), "utf8") > MAX_RESULT_BYTES) {
    fail("TELEGRAM_WEB_RESULT_TOO_LARGE", "The final Telegram Web public result exceeded the safe JSON byte limit after account routing metadata was applied.");
  }
  return publicResult;
};

export const publicChat = (chat) => chat?.isSelf
  ? { semanticId: "saved-messages", peerId: null, title: sanitizeDisplayLabel(chat.title), isSelf: true }
  : {
    semanticId: null,
    peerId: chat?.peerId ?? null,
    title: sanitizeDisplayLabel(chat?.title),
    isSelf: false,
  };

const publicMessage = (message, chat) => {
  if (!chat?.isSelf) return message;
  return {
    ...message,
    peerId: null,
    chatSemanticId: "saved-messages",
    // Saved Messages is addressed semantically so the current account's raw
    // internal user id cannot leak through either the message or its one-level
    // reply author. The account slot remains available at the result envelope.
    authorPeerId: null,
    authorSemanticId: "self",
    reply: message.reply
      ? {
        ...message.reply,
        authorPeerId: null,
        // An unavailable reply has no known author at all. Saved Messages
        // redaction must not manufacture a self author and violate the closed
        // contextAvailable:false null contract.
        authorSemanticId: message.reply.contextAvailable === true ? "self" : null,
      }
      : null,
  };
};

export const normalizeChatReference = (reference, expectedAccount = 1) => {
  const normalized = boundedOpaqueString(reference, 512, "--chat");
  if (normalized === "saved-messages" || normalized === "self") return { kind: "self", value: "saved-messages" };
  if (/^-?\d+$/u.test(normalized)) {
    return { kind: "peer", value: requireExactSafePeerId(normalized, {
      code: "TELEGRAM_WEB_INVALID_CHAT",
      message: "A numeric --chat must be one exact non-zero JavaScript-safe Telegram PeerId.",
    }) };
  }
  if (normalized.startsWith("https://")) {
    if (
      !isAllowedTelegramTopLevelUrl(normalized, expectedAccount)
      || !/#-?\d{1,24}$/u.test(normalized)
    ) {
      fail("TELEGRAM_WEB_INVALID_CHAT", "Only an exact official https://web.telegram.org/k/#PEER_ID URL is accepted.");
    }
    return { kind: "peer", value: requireExactSafePeerId(normalized.slice(normalized.lastIndexOf("#") + 1), {
      code: "TELEGRAM_WEB_INVALID_CHAT",
      message: "The Telegram Web chat URL contains an inexact or unsafe PeerId.",
    }) };
  }
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//u.test(normalized)) {
    fail("TELEGRAM_WEB_INVALID_CHAT", "Only an exact canonical https://web.telegram.org/k/ chat URL is accepted.");
  }
  return { kind: "title", value: normalized };
};

const collectDialogRows = async (page, limit = 100) => {
  const capturedRows = await page.evaluate(({ maximum, unsafeDisplayPatternSource, maximumDisplayLabelChars }) => {
  const rows = [];
  const seen = new Set();
  let ordinaryIndex = 0;
  let scannedRows = 0;
  const unsafeDisplayPattern = new RegExp(unsafeDisplayPatternSource, "gu");
  const boundedWellFormedLabel = (value, maximumLength) => {
    let output = "";
    for (let index = 0; index < value.length; index += 1) {
      const unit = value.charCodeAt(index);
      if (unit >= 0xD800 && unit <= 0xDBFF) {
        const next = value.charCodeAt(index + 1);
        if (next < 0xDC00 || next > 0xDFFF) continue;
        if (output.length + 2 > maximumLength) break;
        output += value[index] + value[index + 1];
        index += 1;
        continue;
      }
      if (unit >= 0xDC00 && unit <= 0xDFFF) continue;
      if (output.length + 1 > maximumLength) break;
      output += value[index];
    }
    return output;
  };
  const safeDisplayLabel = (value) => boundedWellFormedLabel(
    String(value ?? "")
      .normalize("NFKC")
      .replace(unsafeDisplayPattern, " ")
      .replace(/\s+/gu, " ")
      .trim(),
    maximumDisplayLabelChars,
  );
  for (const node of document.querySelectorAll('.chatlist-chat[data-peer-id]')) {
    const peerId = node.getAttribute("data-peer-id");
    if (!peerId || !/^-?\d{1,24}$/u.test(peerId)) continue;
    const rectangle = node.getBoundingClientRect();
    const style = window.getComputedStyle(node);
    if (rectangle.width < 20 || rectangle.height < 10 || style.display === "none" || style.visibility === "hidden") continue;
    scannedRows += 1;
    if (scannedRows > maximum) break;
    const title = safeDisplayLabel(node.querySelector('.peer-title')?.textContent);
    if (!title) continue;
    const threadValues = [
      node.getAttribute("data-thread-id"),
      node.getAttribute("data-topic-id"),
      node.getAttribute("data-monoforum-thread-id"),
      node.getAttribute("data-monoforum-topic-id"),
      node.getAttribute("data-monoforum-peer-id"),
      node.getAttribute("data-monoforum-parent-peer-id"),
    ];
    const isThread = threadValues.some((value) => value !== null && value !== "" && value !== "0");
    const dedupeKey = isThread ? `${peerId}:thread:${threadValues.join(":")}` : `${peerId}:main`;
    if (seen.has(dedupeKey)) continue;
    const unread = node.querySelector('.dialog-subtitle-badge-unread');
    const unreadText = String(unread?.textContent || "").trim();
    const numericUnread = unreadText.match(/\d{1,6}/u);
    const liveCurrentUserId = globalThis.rootScope?.myId;
    const currentUserId = typeof liveCurrentUserId === "number"
      && Number.isSafeInteger(liveCurrentUserId)
      && liveCurrentUserId > 0
      ? String(liveCurrentUserId)
      : "";
    // Web K avatarNew.tsx marks Saved Messages with these exact avatar
    // classes. rootScope.myId remains authoritative; the icon is only an
    // independent fail-closed mismatch signal against a spoofed/misbound row.
    const hasSelfIcon = Boolean(node.querySelector('.avatar-icon-mynotes, .avatar-icon-saved'));
    const isSelf = Boolean(/^\d{1,24}$/u.test(currentUserId) && peerId === currentUserId);
    rows.push({
      peerId,
      title,
      username: null,
      activeUsernames: [],
      isThread,
      isSelf,
      selfIconMismatch: Boolean(hasSelfIcon && !isSelf),
      unread: Boolean(unread),
      unreadCount: numericUnread ? Number(numericUnread[0]) : unread ? 1 : 0,
      muted: node.classList.contains("is-muted"),
      pinned: Boolean(node.querySelector('.dialog-subtitle-badge-pinned')),
      isMessageResult: Boolean(node.getAttribute("data-mid")),
      domIndex: ordinaryIndex,
    });
    seen.add(dedupeKey);
    if (!isThread) {
      node.setAttribute("data-trelio-telegram-dialog-index", String(ordinaryIndex));
      ordinaryIndex += 1;
    }
    if (rows.length >= maximum) break;
  }
  return { rows, scanLimitHit: scannedRows >= maximum };
  }, {
    maximum: limit,
    unsafeDisplayPatternSource: DISPLAY_LABEL_UNSAFE_PATTERN_SOURCE,
    maximumDisplayLabelChars: MAX_DISPLAY_LABEL_CHARS,
  });
  if (!capturedRows || !Array.isArray(capturedRows.rows)) {
    fail("TELEGRAM_WEB_UI_UNSUPPORTED", "Telegram Web exposed an invalid bounded dialog-row result.");
  }
  // Repeat the shared Node-side boundary before any title participates in
  // matching or leaves the runtime. This also catches a displaced/modified
  // page serializer rather than trusting browser-side presentation cleanup.
  let rows = capturedRows.rows
    .map((row) => ({
      ...row,
      title: sanitizeDisplayLabel(row?.title),
      username: sanitizePublicUsername(row?.username),
      activeUsernames: Array.isArray(row?.activeUsernames)
        ? row.activeUsernames.map(sanitizePublicUsername).filter(Boolean)
        : [],
    }))
    .filter((row) => row.title.length > 0);
  if (rows.some((row) => {
    try {
      requireExactSafePeerId(row.peerId);
      return row.selfIconMismatch;
    } catch {
      return true;
    }
  })) {
    fail("TELEGRAM_WEB_UI_UNSUPPORTED", "Telegram Web exposed a malformed provider peer identifier.");
  }
  const threadRows = rows.filter((row) => row.isThread);
  const scanLimitHit = capturedRows.scanLimitHit === true;
  let ordinaryRows = rows.filter((row) => !row.isThread);
  const bindings = await page.evaluate(async (peerIds) => {
    const result = { known: true, peers: {} };
    const peers = globalThis.rootScope?.managers?.appPeersManager;
    const messages = globalThis.rootScope?.managers?.appMessagesManager;
    const notifications = globalThis.rootScope?.managers?.appNotificationsManager;
    if (typeof peers?.getPeerActiveUsernames !== "function"
      || typeof messages?.getDialogOnly !== "function"
      || typeof messages?.isDialogUnread !== "function"
      || typeof notifications?.isPeerLocalMuted !== "function") return { known: false, peers: {} };
    for (const peerId of peerIds) {
      const numeric = Number(peerId);
      if (!Number.isSafeInteger(numeric)) continue;
      const binding = {
        activeUsernames: [],
        dialog: false,
        unread: false,
        unreadCount: 0,
        muted: false,
        pinned: false,
      };
      try {
        const values = await Promise.resolve(peers.getPeerActiveUsernames(numeric));
        if (Array.isArray(values)) binding.activeUsernames = values
          .map((value) => String(value || ""))
          .filter((value) => /^[A-Za-z0-9_]{5,32}$/u.test(value));
      } catch {
        binding.activeUsernames = [];
      }
      try {
        const dialog = await Promise.resolve(messages.getDialogOnly(numeric));
        if (dialog
          && typeof dialog.peerId === "number"
          && Number.isSafeInteger(dialog.peerId)
          && dialog.peerId !== 0
          && String(dialog.peerId) === peerId) {
          const unread = await Promise.resolve(messages.isDialogUnread(dialog));
          const muted = await Promise.resolve(notifications.isPeerLocalMuted({ peerId: numeric, threadId: undefined }));
          if (typeof unread !== "boolean" || typeof muted !== "boolean") return { known: false, peers: {} };
          const presentUnreadCount = dialog.unread_count;
          if (presentUnreadCount !== undefined
            && presentUnreadCount !== null
            && (!Number.isSafeInteger(presentUnreadCount) || presentUnreadCount < 0)) {
            return { known: false, peers: {} };
          }
          const rawUnreadCount = presentUnreadCount ?? 0;
          binding.dialog = true;
          binding.unread = unread;
          binding.unreadCount = Math.max(rawUnreadCount, unread ? 1 : 0);
          binding.muted = muted;
          binding.pinned = dialog.pFlags?.pinned === true;
        }
      } catch {
        return { known: false, peers: {} };
      }
      result.peers[peerId] = binding;
    }
    return result;
  }, ordinaryRows.map((row) => row.peerId));
  if (!bindings?.known) {
    fail("TELEGRAM_WEB_UI_UNSUPPORTED", "Telegram Web dialog rows could not be rebound to authoritative dialog, unread and notification models.");
  }
  ordinaryRows = ordinaryRows.filter((row) => {
    const binding = bindings.peers?.[row.peerId];
    if (!binding || row.isMessageResult) return false;
    return binding.dialog === true;
  });
  for (const row of ordinaryRows) {
    const binding = bindings.peers[row.peerId];
    const exactActive = Array.isArray(binding.activeUsernames) ? binding.activeUsernames : [];
    row.activeUsernames = exactActive.map((value) => `@${value}`);
    row.username = exactActive[0] ? `@${exactActive[0]}` : null;
    row.unread = binding.unread;
    row.unreadCount = binding.unreadCount;
    row.muted = binding.muted;
    row.pinned = binding.pinned;
    delete row.selfIconMismatch;
    delete row.isThread;
    delete row.isMessageResult;
  }
  Object.defineProperty(ordinaryRows, "threadRows", { value: threadRows, enumerable: false });
  Object.defineProperty(ordinaryRows, "scanLimitHit", { value: scanLimitHit, enumerable: false });
  return ordinaryRows;
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

const cleanupSearchCompletion = async (page, token) => {
  await page.evaluate(({ key, completionToken }) => {
    const registry = globalThis[key];
    const state = registry?.get?.(completionToken);
    try {
      state?.restore?.();
      state?.observer?.disconnect?.();
      if (state?.input && state?.onInput) state.input.removeEventListener("input", state.onInput);
    } finally {
      registry?.delete?.(completionToken);
      if (registry?.size === 0) delete globalThis[key];
    }
  }, { key: SEARCH_COMPLETION_STATE_KEY, completionToken: token }).catch(() => undefined);
};

export const selectExactDialog = (rows, reference) => {
  if (reference.kind === "peer") {
    requireExactSafePeerId(reference.value, {
      code: "TELEGRAM_WEB_INVALID_CHAT",
      message: "The requested Telegram PeerId is outside the exact safe integer range.",
    });
    const matches = rows.filter((row) => row.peerId === reference.value);
    if (matches.length === 1) return matches[0];
    if (rows.threadRows?.some((row) => row.peerId === reference.value)) {
      fail("TELEGRAM_WEB_UNSUPPORTED_OPERATION", "Telegram Web forum/topic rows are not supported by this chat-only runtime release.", { operation: "topic", fallbackEligible: true });
    }
  } else if (reference.kind === "self") {
    const matches = rows.filter((row) => row.isSelf);
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) fail("TELEGRAM_WEB_AMBIGUOUS_CHAT", "Several Telegram rows claimed the Saved Messages semantic identity.");
    if (rows.threadRows?.some((row) => row.isSelf)) {
      fail("TELEGRAM_WEB_UNSUPPORTED_OPERATION", "Saved Messages topics are not supported by this chat-only runtime release.", { operation: "topic", fallbackEligible: true });
    }
  } else if (reference.kind === "title") {
    fail(
      "TELEGRAM_WEB_AMBIGUOUS_CHAT",
      "Bounded Telegram Web search cannot prove title uniqueness. Discover and use one exact PeerId or Web K URL.",
    );
  }
  fail("TELEGRAM_WEB_CHAT_NOT_FOUND", "No exact Telegram dialog matched. Use saved-messages, a safe PeerId, or an official Web K peer URL.");
};

const readUniqueTopbarPeerId = async (page) => {
  const peerIds = await page.locator('.chat-info .peer-title[data-peer-id], .chat.topbar .peer-title[data-peer-id]').evaluateAll((nodes) => [
    ...new Set(nodes.filter((node) => {
      const rectangle = node.getBoundingClientRect();
      const style = window.getComputedStyle(node);
      return rectangle.width > 1 && rectangle.height > 1 && style.display !== "none" && style.visibility !== "hidden";
    }).map((node) => node.getAttribute("data-peer-id"))),
  ]);
  if (peerIds.length !== 1) {
    fail("TELEGRAM_WEB_CHAT_MISMATCH", "Telegram Web did not expose one valid current topbar peer identity.");
  }
  return requireExactSafePeerId(peerIds[0], {
    code: "TELEGRAM_WEB_CHAT_MISMATCH",
    message: "Telegram Web topbar exposed an inexact or unsafe peer identity.",
  });
};

const assertOpenPeer = async (page, expectedPeerId) => {
  expectedPeerId = requireExactSafePeerId(expectedPeerId);
  const actual = await readUniqueTopbarPeerId(page);
  if (actual !== expectedPeerId) fail("TELEGRAM_WEB_CHAT_MISMATCH", "Telegram opened a different peer than the exact resolved dialog.");
  const liveChat = await page.evaluate(() => {
    const chat = globalThis.appImManager?.chat;
    const nonemptyThread = (value) => value !== undefined && value !== null && value !== "" && value !== 0 && value !== "0";
    const livePeerId = chat?.peerId;
    return {
      peerId: typeof livePeerId === "number" && Number.isSafeInteger(livePeerId) && livePeerId !== 0
        ? String(livePeerId)
        : null,
      type: String(chat?.type ?? ""),
      threaded: nonemptyThread(chat?.threadId) || nonemptyThread(chat?.monoforumThreadId),
      monoforum: chat?.isMonoforum === true,
    };
  });
  if (liveChat.peerId !== expectedPeerId) fail("TELEGRAM_WEB_CHAT_MISMATCH", "Telegram Web live chat model did not match the exact resolved peer.");
  if (liveChat.type !== "chat") {
    fail(
      "TELEGRAM_WEB_UNSUPPORTED_OPERATION",
      "Telegram Web is not on the exact normal chat surface. Scheduled, discussion, search, static, logs, stories, pinned, and saved sub-surfaces are unsupported.",
      { operation: "non-chat-surface", fallbackEligible: true },
    );
  }
  if (liveChat.threaded || liveChat.monoforum) {
    fail(
      "TELEGRAM_WEB_UNSUPPORTED_OPERATION",
      "Telegram Web forum/topic and monoforum surfaces are not supported by this chat-only runtime release.",
      { operation: "topic", fallbackEligible: true },
    );
  }
};

/**
 * Plain text sent to a bot can trigger bot-side actions even when it is not a
 * slash command. Bind every message mutation to Web K's authoritative peer
 * classifier, and require create-direct to remain an existing non-bot contact.
 */
const assertSafeMutationPeer = async (page, expectedPeerId, { requireContact = false } = {}) => {
  expectedPeerId = requireExactSafePeerId(expectedPeerId);
  await assertOpenPeer(page, expectedPeerId);
  const state = await page.evaluate(async ({ peerId, contactRequired }) => {
    const peers = globalThis.rootScope?.managers?.appPeersManager;
    const numericPeerId = Number(peerId);
    if (typeof peers?.getPeer !== "function"
      || typeof peers?.isBot !== "function"
      || (contactRequired && typeof peers?.isContact !== "function")
      || !Number.isSafeInteger(numericPeerId)
      || numericPeerId === 0) return { known: false };
    try {
      const peer = peers.getPeer(numericPeerId);
      const bot = await Promise.resolve(peers.isBot(numericPeerId));
      const contact = contactRequired
        ? await Promise.resolve(peers.isContact(numericPeerId))
        : null;
      if (!peer
        || typeof bot !== "boolean"
        || (contactRequired && typeof contact !== "boolean")) {
        return { known: false };
      }
      return {
        known: true,
        bot,
        contact,
        deleted: peer._ === "user" && peer.pFlags?.deleted === true,
        support: peer._ === "user" && peer.pFlags?.support === true,
      };
    } catch {
      return { known: false };
    }
  }, { peerId: expectedPeerId, contactRequired: requireContact });
  if (!state?.known) {
    fail("TELEGRAM_WEB_UI_UNSUPPORTED", "Telegram Web did not expose one authoritative bot/contact classification for the exact mutation destination.");
  }
  if (state.bot) {
    fail(
      "TELEGRAM_WEB_UNSUPPORTED_OPERATION",
      "Telegram Web text mutations to bots are outside the verified pilot because plain text can trigger bot-side actions.",
      { operation: "bot-peer", fallbackEligible: true },
    );
  }
  if (state.deleted || state.support) {
    fail(
      "TELEGRAM_WEB_UNSUPPORTED_OPERATION",
      "Telegram Web mutations to deleted or provider-support accounts are outside the verified direct-message surface.",
      { operation: "unsupported-user-peer", fallbackEligible: true },
    );
  }
  if (requireContact && state.contact !== true) {
    fail(
      "TELEGRAM_WEB_UNSUPPORTED_OPERATION",
      "create-direct is limited to one exact existing non-bot Telegram contact.",
      { operation: "non-contact-direct", fallbackEligible: true },
    );
  }
  return true;
};

const waitForExactOpenPeer = async (page, expectedPeerId, timeoutMs) => {
  expectedPeerId = requireExactSafePeerId(expectedPeerId);
  try {
    await page.waitForFunction(({ peerId }) => {
      const visible = (node) => {
        const rectangle = node?.getBoundingClientRect?.();
        const style = node ? globalThis.getComputedStyle?.(node) : null;
        return Boolean(rectangle && rectangle.width > 1 && rectangle.height > 1
          && style?.display !== "none" && style?.visibility !== "hidden");
      };
      const peerIds = [...new Set(Array.from(document.querySelectorAll(
        '.chat-info .peer-title[data-peer-id], .chat.topbar .peer-title[data-peer-id]',
      )).filter(visible).map((node) => node.getAttribute("data-peer-id")))];
      const chat = globalThis.appImManager?.chat;
      const nonempty = (value) => value !== undefined && value !== null && value !== "" && value !== 0 && value !== "0";
      const liveChatPeerId = chat?.peerId;
      return peerIds.length === 1
        && peerIds[0] === peerId
        && typeof liveChatPeerId === "number"
        && Number.isSafeInteger(liveChatPeerId)
        && liveChatPeerId !== 0
        && String(liveChatPeerId) === peerId
        && chat?.type === "chat"
        && chat?.isMonoforum !== true
        && !nonempty(chat?.threadId)
        && !nonempty(chat?.monoforumThreadId);
    }, { peerId: expectedPeerId }, { timeout: timeoutMs });
  } catch {
    fail("TELEGRAM_WEB_CHAT_MISMATCH", "Telegram Web did not reach the exact normal chat model and topbar before the bounded deadline.");
  }
  await assertOpenPeer(page, expectedPeerId);
};

const bindExactDialogRowLocator = async (page, row) => {
  if (!row || !Number.isInteger(row.domIndex)) fail("TELEGRAM_WEB_UI_UNSUPPORTED", "Telegram Web dialog row has no exact captured DOM identity.");
  const locator = page.locator(`[data-trelio-telegram-dialog-index="${row.domIndex}"]`);
  if (await locator.count() !== 1 || !await locator.isVisible().catch(() => false)) {
    fail("TELEGRAM_WEB_UI_UNSUPPORTED", "The exact Telegram dialog row disappeared before use.");
  }
  const state = await locator.evaluate((node) => ({
    peerId: node.getAttribute("data-peer-id"),
    domIndex: node.getAttribute("data-trelio-telegram-dialog-index"),
    messageResult: Boolean(node.getAttribute("data-mid")),
    threaded: [
      "data-thread-id", "data-topic-id", "data-monoforum-thread-id",
      "data-monoforum-topic-id", "data-monoforum-peer-id", "data-monoforum-parent-peer-id",
    ].some((name) => {
      const value = node.getAttribute(name);
      return value !== null && value !== "" && value !== "0";
    }),
  }));
  if (state.peerId !== row.peerId
    || state.domIndex !== String(row.domIndex)
    || state.messageResult
    || state.threaded) {
    fail("TELEGRAM_WEB_SOURCE_CHANGED", "The exact Telegram dialog row identity changed before use.");
  }
  return locator;
};

const resolveDialog = async (page, chat, options, { openChat = false } = {}) => {
  let reference = normalizeChatReference(chat, options.account);
  let requestedSelf = false;
  if (reference.kind === "title") {
    fail(
      "TELEGRAM_WEB_AMBIGUOUS_CHAT",
      "Telegram Web cannot prove global title uniqueness from its bounded sidebar search. Run dialogs to discover the provider PeerId, then use that exact PeerId or Web K URL; use saved-messages for the current account.",
    );
  }
  if (reference.kind === "self") {
    const selfPeerId = await page.evaluate(() => {
      const myId = globalThis.rootScope?.myId;
      return typeof myId === "number" && Number.isSafeInteger(myId) && myId > 0
        ? String(myId)
        : null;
    });
    if (!selfPeerId) fail("TELEGRAM_WEB_UI_UNSUPPORTED", "Telegram Web did not expose the current account's exact Saved Messages peer identity.");
    reference = { kind: "peer", value: requireExactSafePeerId(selfPeerId) };
    requestedSelf = true;
  }
  let rows;
  if (reference.kind === "peer") {
    rows = await collectDialogRows(page, 100);
    if (!rows.some((row) => row.peerId === reference.value)) {
      if (!openChat) {
        if (requestedSelf) {
          const dialogState = await readAuthoritativeDialogState(page, reference.value);
          return {
            peerId: reference.value,
            title: "Saved Messages",
            isSelf: true,
            unread: dialogState.unread,
            unreadCount: dialogState.unreadCount,
            muted: dialogState.muted,
            pinned: dialogState.pinned,
            domIndex: null,
            alreadyOpen: false,
          };
        }
        fail(
          "TELEGRAM_WEB_CHAT_NOT_FOUND",
          "The exact peer is not present in the bounded sidebar state. Telegram Web will not open it during unread polling because that could mark messages read.",
        );
      }
      if (options.blockAccountWideMessageSearch === true) {
        await prepareAccountWideSearchGuardForNavigation(page, options);
      }
      await page.goto(telegramWebUrlForAccount(options.account, reference.value), { waitUntil: "domcontentloaded", timeout: options.timeoutMs });
      assertTrustedPage(page, options.account);
      await waitForExactOpenPeer(page, reference.value, options.timeoutMs);
      if (options.blockAccountWideMessageSearch === true) {
        await refreshAccountWideMessageSearchGuard(page, options, { contextReset: true });
      }
      const topbar = page.locator('.chat-info .peer-title[data-peer-id], .chat.topbar .peer-title[data-peer-id]').filter({ visible: true });
      if (await topbar.count() !== 1) fail("TELEGRAM_WEB_CHAT_NOT_FOUND", "The exact Telegram peer URL did not open a supported chat.");
      const title = sanitizeDisplayLabel(await topbar.first().textContent());
      const isSelf = await page.evaluate((peerId) => {
        const myId = globalThis.rootScope?.myId;
        return typeof myId === "number" && Number.isSafeInteger(myId) && myId > 0 && String(myId) === peerId;
      }, reference.value);
      const dialogState = await readAuthoritativeDialogState(page, reference.value);
      return {
        peerId: reference.value,
        title,
        isSelf,
        unread: dialogState.unread,
        unreadCount: dialogState.unreadCount,
        muted: dialogState.muted,
        pinned: dialogState.pinned,
        domIndex: null,
        alreadyOpen: true,
      };
    }
  }
  const selected = selectExactDialog(rows, reference);
  if (requestedSelf && !selected.isSelf) {
    fail("TELEGRAM_WEB_CHAT_MISMATCH", "Telegram Web local dialog state did not bind Saved Messages to the current account.");
  }
  if (openChat) {
    const row = await bindExactDialogRowLocator(page, selected);
    await row.click({ timeout: options.timeoutMs });
    assertTrustedPage(page, options.account);
    await waitForExactOpenPeer(page, selected.peerId, options.timeoutMs);
  }
  return { ...selected, alreadyOpen: openChat };
};

const loadHistoryPages = async (page, pages, timeoutMs = DEFAULT_TIMEOUT_MS) => {
  let loadedPages = 1;
  let completionUnproven = false;
  for (let index = 1; index < pages; index += 1) {
    const before = await page.locator('.bubbles-inner .bubble[data-mid]').count();
    const scrolled = await page.evaluate(() => {
      const container = document.querySelector('.bubbles-scrollable');
      if (!(container instanceof HTMLElement)) return false;
      container.scrollTop = 0;
      container.dispatchEvent(new Event("scroll", { bubbles: true }));
      return true;
    });
    if (!scrolled) break;
    try {
      await page.waitForFunction((previousCount) => document.querySelectorAll(
        '.bubbles-inner .bubble[data-mid][data-peer-id]',
      ).length > previousCount, before, { timeout: Math.min(timeoutMs, 5_000) });
    } catch {
      // No count transition is proof of neither completion nor another page.
      // Stop conservatively and leave the read result marked incomplete by
      // the caller's requested page bound instead of inventing a loaded page.
      completionUnproven = true;
      break;
    }
    const after = await page.locator('.bubbles-inner .bubble[data-mid]').count();
    if (after <= before) break;
    loadedPages += 1;
  }
  return { loadedPages, completionUnproven };
};

/**
 * Convert exact Web K message models into a bounded, useful public artifact.
 * Only opaque safe-integer PeerIds are returned; TL inputPeer objects,
 * access_hash, file references and any other provider capability material are
 * never copied. Reply expansion is deliberately one level, link entities are
 * a closed normalized projection of visible URL/email semantics, and one
 * top-level media model is reduced to bounded non-capability metadata.
 */
const readExactMessageArtifacts = async (page, references, dialogPeerId) => {
  dialogPeerId = requireExactSafePeerId(dialogPeerId);
  if (!Array.isArray(references)
    || references.length > MAX_HISTORY_MESSAGES
    || references.some((reference) => !isExactPositiveSafeDecimal(reference?.messageId))) {
    fail("TELEGRAM_WEB_UI_UNSUPPORTED", "Telegram Web message artifact references are malformed or exceed the bounded result limit.");
  }
  const artifacts = await page.evaluate(async ({
    exactDialogPeerId,
    exactReferences,
    maximumLinks,
    maximumReplyChars,
    maximumAttachments,
    unsafeDisplayPatternSource,
    maximumDisplayLabelChars,
  }) => {
    const numericDialogPeerId = Number(exactDialogPeerId);
    const managers = globalThis.rootScope?.managers;
    const messages = managers?.appMessagesManager;
    const peers = managers?.appPeersManager;
    const chat = globalThis.appImManager?.chat;
    const myId = globalThis.rootScope?.myId;
    if (!Number.isSafeInteger(numericDialogPeerId)
      || numericDialogPeerId === 0
      || typeof messages?.getMessageByPeer !== "function") return null;

    const exactPeerId = (value) => typeof value === "number"
      && Number.isSafeInteger(value)
      && value !== 0
      ? String(value)
      : null;
    const exactMessageId = (value) => typeof value === "number"
      && Number.isSafeInteger(value)
      && value > 0
      ? String(value)
      : null;
    const boundedWellFormedLabel = (value, maximumLength) => {
      let output = "";
      for (let index = 0; index < value.length; index += 1) {
        const unit = value.charCodeAt(index);
        if (unit >= 0xD800 && unit <= 0xDBFF) {
          const next = value.charCodeAt(index + 1);
          if (next < 0xDC00 || next > 0xDFFF) continue;
          if (output.length + 2 > maximumLength) break;
          output += value[index] + value[index + 1];
          index += 1;
          continue;
        }
        if (unit >= 0xDC00 && unit <= 0xDFFF) continue;
        if (output.length + 1 > maximumLength) break;
        output += value[index];
      }
      return output;
    };
    const unsafeDisplayPattern = new RegExp(unsafeDisplayPatternSource, "gu");
    const unsafeDisplayTestPattern = new RegExp(unsafeDisplayPatternSource, "u");
    const normalizeLabel = (value, maximum = 256) => {
      if (typeof value !== "string") return null;
      const boundedMaximum = Number.isSafeInteger(maximum)
        && maximum > 0
        && Number.isSafeInteger(maximumDisplayLabelChars)
        && maximumDisplayLabelChars > 0
        ? Math.min(maximum, maximumDisplayLabelChars)
        : 256;
      const normalized = boundedWellFormedLabel(
        value
          .normalize("NFKC")
          .replace(unsafeDisplayPattern, " ")
          .replace(/\s+/gu, " ")
          .trim(),
        boundedMaximum,
      );
      return normalized || null;
    };
    const timestamp = (seconds) => {
      if (typeof seconds !== "number" || !Number.isSafeInteger(seconds) || seconds <= 0) return null;
      const milliseconds = seconds * 1_000;
      if (!Number.isSafeInteger(milliseconds) || Math.abs(milliseconds) > 8_640_000_000_000_000) return null;
      try {
        return new Date(milliseconds).toISOString();
      } catch {
        return null;
      }
    };
    const safeLinkTarget = (value) => {
      if (typeof value !== "string"
        || value.length < 1
        || value.length > 2_048
        || unsafeDisplayTestPattern.test(value)) return null;
      try {
        const parsed = new URL(value);
        const numericScalarEqualsSelf = (candidate) => {
          if (typeof candidate !== "string" || candidate.trim() === "") return false;
          const numeric = Number(candidate);
          return typeof myId === "number"
            && Number.isSafeInteger(myId)
            && myId > 0
            && Number.isSafeInteger(numeric)
            && numeric > 0
            && numeric === myId;
        };
        const standaloneSelfScalar = (candidate) => {
          if (typeof myId !== "number" || !Number.isSafeInteger(myId) || myId <= 0) return false;
          const needle = String(myId);
          let offset = String(candidate || "").indexOf(needle);
          while (offset >= 0) {
            const before = offset === 0 ? "" : candidate[offset - 1];
            const afterIndex = offset + needle.length;
            const after = afterIndex >= candidate.length ? "" : candidate[afterIndex];
            if ((!before || !/[0-9]/u.test(before))
              && (!after || !/[0-9]/u.test(after))) return true;
            offset = candidate.indexOf(needle, offset + 1);
          }
          return false;
        };
        const decodedVariants = (candidate) => {
          const variants = [];
          const seen = new Set();
          let current = String(candidate || "");
          for (let depth = 0; depth <= 4; depth += 1) {
            if (current.length > 2_048 || seen.has(current)) return { variants, unsafe: false };
            // The raw target is checked before URL parsing, but percent
            // encoding must not turn format/bidi controls into a visually
            // hidden route on a later decoding layer.
            if (unsafeDisplayTestPattern.test(current)) return { variants, unsafe: true };
            seen.add(current);
            variants.push(current);
            if (!current.includes("%")) return { variants, unsafe: false };
            let decoded;
            try {
              decoded = decodeURIComponent(current);
            } catch {
              return { variants, unsafe: true };
            }
            if (decoded === current) return { variants, unsafe: false };
            current = decoded;
          }
          // More than four active encoding layers is not useful public link
          // metadata and remains an identity-obfuscation ambiguity.
          return { variants, unsafe: true };
        };
        const targetLeaksSelf = (candidate, depth = 0, visited = new Set()) => {
          if (depth > 3 || typeof candidate !== "string" || candidate.length > 2_048) return true;
          const decoded = decodedVariants(candidate);
          if (decoded.unsafe) return true;
          for (const variant of decoded.variants) {
            if (visited.has(variant)) continue;
            visited.add(variant);
            let nested;
            try {
              nested = new URL(variant);
            } catch {
              continue;
            }
            const entries = [...nested.searchParams.entries()];
            if (entries.some(([key, queryValue]) => (
              numericScalarEqualsSelf(key) || numericScalarEqualsSelf(queryValue)
            ))) return true;
            if (nested.protocol === "tg:" && standaloneSelfScalar(variant)) return true;
            if (["http:", "https:"].includes(nested.protocol)
              && nested.hostname.toLocaleLowerCase("en-US").replace(/\.+$/u, "") === "web.telegram.org") {
              const decodedHash = decodedVariants(nested.hash.replace(/^#/, ""));
              const webHashTargetsSelf = (hash) => {
                if (standaloneSelfScalar(hash)) return true;
                const question = hash.indexOf("?");
                const route = (question < 0 ? hash : hash.slice(0, question)).toLocaleLowerCase("en-US");
                // Web K accepts `#self` as an alias for the currently selected
                // account. Treat it exactly like a numeric current-user route:
                // it is private identity/routing metadata and must not escape
                // through a public link entity. decodedVariants() above makes
                // this cover percent-encoded and repeatedly encoded forms too.
                if (route.replace(/^\/+|\/+$/gu, "") === "self") return true;
                if (/^\/?im\/?$/u.test(route)) {
                  if (question < 0) return false;
                  const parameters = new URLSearchParams(hash.slice(question + 1));
                  return parameters.getAll("p").some((candidate) => numericScalarEqualsSelf(candidate));
                }
                // Current Web K applies unary Number before toPeerId. Mirror
                // that semantic only for identity screening: padded decimal,
                // exponent, hexadecimal, octal, binary and fractional forms
                // that resolve to the selected safe integer are all private.
                const directToken = hash.split(/[?\/#&]/u, 1)[0];
                return numericScalarEqualsSelf(directToken);
              };
              if (decodedHash.unsafe
                || decodedHash.variants.some(webHashTargetsSelf)) return true;
            }
            // Do not expose a target whose nested query chain exceeds the
            // bounded inspection depth. Silently accepting the unchecked tail
            // would let a current-account route hide one wrapper deeper than
            // the recursion limit.
            if (depth >= 3 && entries.length > 0) return true;
            for (const [, queryValue] of entries) {
              if (targetLeaksSelf(queryValue, depth + 1, visited)) return true;
            }
          }
          return false;
        };
        if (targetLeaksSelf(value)) return null;

        const queryEntries = [...parsed.searchParams.entries()];
        let decodedTelegramRouteParts = [];
        if (parsed.protocol === "tg:") {
          try {
            decodedTelegramRouteParts = [parsed.hostname, parsed.pathname.replace(/^\/+/, "")]
              .map((part) => decodeURIComponent(part).toLocaleLowerCase("en-US"));
          } catch {
            // An invalid percent-encoded Telegram route has no safe public
            // target semantics even if its query happens to look ordinary.
            return null;
          }
        }
        const tgUserRoute = parsed.protocol === "tg:"
          && decodedTelegramRouteParts.includes("user");
        if (tgUserRoute) {
          // `tg://user` is accepted only in its one unambiguous canonical
          // shape. Duplicate, missing, empty, padded, suffixed, unsafe, or
          // extra provider parameters are not useful enough to expose.
          const exactRoute = (
            decodedTelegramRouteParts[0] === "user"
            && decodedTelegramRouteParts[1] === ""
          ) || (
            decodedTelegramRouteParts[0] === ""
            && decodedTelegramRouteParts[1] === "user"
          );
          if (!exactRoute
            || parsed.username
            || parsed.password
            || parsed.port
            || parsed.hash
            || queryEntries.length !== 1
            || queryEntries[0][0] !== "id") return null;
          const linkedUserIdRaw = queryEntries[0][1];
          const linkedUserId = Number(linkedUserIdRaw);
          if (!/^\d{1,24}$/u.test(linkedUserIdRaw)
            || !Number.isSafeInteger(linkedUserId)
            || linkedUserId <= 0
            || String(linkedUserId) !== linkedUserIdRaw) return null;
        }
        return ["http:", "https:", "mailto:", "tg:"].includes(parsed.protocol)
          ? value
          : null;
      } catch {
        return null;
      }
    };
    const linksFromModel = (model, fullText, exposedText) => {
      const primary = model?.entities ?? [];
      const total = model?.totalEntities ?? [];
      if (!Array.isArray(primary)
        || !Array.isArray(total)
        || primary.length > 128
        || total.length > 128) return null;
      const seen = new Set();
      const source = [...primary, ...total].filter((entity) => {
        const key = JSON.stringify([
          entity?._,
          entity?.offset,
          entity?.length,
          typeof entity?.url === "string" ? entity.url : null,
        ]);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      const links = [];
      let relevantCount = 0;
      for (const entity of source) {
        const type = entity?._;
        if (!["messageEntityUrl", "messageEntityTextUrl", "messageEntityEmail"].includes(type)) continue;
        relevantCount += 1;
        if (!Number.isInteger(entity.offset)
          || !Number.isInteger(entity.length)
          || entity.offset < 0
          || entity.length < 1
          || entity.offset + entity.length > fullText.length) return null;
        if (entity.offset + entity.length > exposedText.length) continue;
        if (links.length >= maximumLinks) continue;
        const visibleText = fullText.slice(entity.offset, entity.offset + entity.length).slice(0, 2_048);
        const candidate = type === "messageEntityTextUrl"
          ? entity.url
          : type === "messageEntityEmail"
            ? `mailto:${visibleText}`
            : visibleText;
        links.push({
          type: type === "messageEntityTextUrl"
            ? "text_url"
            : type === "messageEntityEmail"
              ? "email"
              : "url",
          offsetUtf16: entity.offset,
          lengthUtf16: entity.length,
          text: visibleText,
          target: safeLinkTarget(candidate),
        });
      }
      return { links, truncated: relevantCount > links.length };
    };
    const safeMimeType = (value) => typeof value === "string"
      && value.length >= 3
      && value.length <= 255
      && /^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/iu.test(value)
      ? value.toLocaleLowerCase("en-US")
      : null;
    const attachmentMetadataFromModel = (model) => {
      const media = model?.media;
      if (!media || typeof media !== "object" || Array.isArray(media)) return [];
      if (media._ === "messageMediaPhoto") {
        return media.photo?._ === "photo"
          ? [{ index: 1, kind: "image", name: null, sizeBytes: null, mimeType: null }]
          : [];
      }
      if (media._ !== "messageMediaDocument" || media.document?._ !== "document") return [];
      const documentModel = media.document;
      const attributes = Array.isArray(documentModel.attributes)
        && documentModel.attributes.length <= 128
        ? documentModel.attributes
        : [];
      const firstAttribute = (kind) => attributes.find((attribute) => attribute?._ === kind) || null;
      const filenameAttribute = firstAttribute("documentAttributeFilename");
      const name = normalizeLabel(documentModel.file_name, 512)
        || normalizeLabel(filenameAttribute?.file_name, 512);
      const sizeBytes = typeof documentModel.size === "number"
        && Number.isSafeInteger(documentModel.size)
        && documentModel.size >= 0
        ? documentModel.size
        : null;
      const mimeType = safeMimeType(documentModel.mime_type);
      const sticker = firstAttribute("documentAttributeSticker");
      const audio = firstAttribute("documentAttributeAudio");
      const video = firstAttribute("documentAttributeVideo");
      const animated = firstAttribute("documentAttributeAnimated");
      let kind = "document";
      if (sticker) kind = "sticker";
      else if (animated || documentModel.type === "gif") kind = "animation";
      else if (audio) kind = audio.pFlags?.voice === true ? "voice" : "audio";
      else if (video) kind = video.pFlags?.round_message === true ? "video_note" : "video";
      else if (mimeType?.startsWith("image/")) kind = "image";
      return [{ index: 1, kind, name, sizeBytes, mimeType }];
    };
    const authorPeerIdFromModel = (model, outgoing) => {
      const direct = exactPeerId(model?.fromId);
      if (direct) return direct;
      return outgoing === true ? exactPeerId(myId) : null;
    };
    const peerTitle = async (peerId) => {
      if (!peerId || typeof peers?.getPeerTitle !== "function") return null;
      try {
        return normalizeLabel(await Promise.resolve(peers.getPeerTitle(Number(peerId))));
      } catch {
        return null;
      }
    };
    const directionFromModel = (model) => {
      if (typeof chat?.peerId !== "number"
        || !Number.isSafeInteger(chat.peerId)
        || String(chat.peerId) !== exactDialogPeerId
        || chat.type !== "chat"
        || chat.isMonoforum === true
        || typeof chat.isOutMessage !== "function") return null;
      try {
        const outgoing = chat.isOutMessage(model);
        return typeof outgoing === "boolean" ? outgoing : null;
      } catch {
        return null;
      }
    };
    const exactModel = (model, messageId) => model
      && exactPeerId(model.peerId) === exactDialogPeerId
      && exactMessageId(model.mid) === messageId
      && (typeof model.message === "string" || model._ === "messageService" || model._ === "messageEmpty");
    const replyMessageId = (model) => {
      const header = model?.reply_to;
      const convenience = model?.reply_to_mid;
      const present = (value) => value !== undefined && value !== null && value !== false && value !== "" && value !== 0 && value !== "0";
      if (!present(header) && !present(convenience)) return null;
      if (header?._ !== "messageReplyHeader") return null;
      const headerId = exactMessageId(header.reply_to_msg_id);
      const convenienceId = exactMessageId(convenience);
      if (!headerId || headerId !== convenienceId) return null;
      if (present(header.reply_to_peer_id)) {
        if (typeof peers?.getPeerId !== "function") return null;
        try {
          if (exactPeerId(peers.getPeerId(header.reply_to_peer_id)) !== exactDialogPeerId) return null;
        } catch {
          return null;
        }
      }
      return headerId;
    };
    const baseArtifact = async (model, messageId, authorHint, textLimit) => {
      if (!exactModel(model, messageId)) return null;
      const fullText = typeof model.message === "string" ? model.message : "";
      const text = fullText.slice(0, textLimit);
      const links = linksFromModel(model, fullText, text);
      if (!links) return null;
      const outgoing = directionFromModel(model);
      const modelAuthorPeerId = authorPeerIdFromModel(model, outgoing);
      const authorIsSelf = Boolean(modelAuthorPeerId && exactPeerId(myId) === modelAuthorPeerId);
      const author = normalizeLabel(authorHint)
        || normalizeLabel(model.post_author)
        || await peerTitle(modelAuthorPeerId);
      return {
        messageId,
        author,
        // The selected account's raw Telegram user id is private connection
        // identity even in an ordinary chat. Preserve only the semantic self
        // marker; other authors may retain their opaque routing PeerId.
        authorPeerId: authorIsSelf ? null : modelAuthorPeerId,
        authorSemanticId: authorIsSelf ? "self" : null,
        timestamp: timestamp(model.date),
        direction: outgoing === null ? null : outgoing ? "outgoing" : "incoming",
        text,
        linkEntities: links.links,
        linkEntitiesTruncated: links.truncated,
        attachments: attachmentMetadataFromModel(model).slice(0, maximumAttachments),
      };
    };

    const output = [];
    for (const reference of exactReferences) {
      const numericMessageId = Number(reference.messageId);
      const model = await Promise.resolve(
        messages.getMessageByPeer(numericDialogPeerId, numericMessageId),
      ).catch(() => null);
      const artifact = await baseArtifact(model, reference.messageId, reference.authorHint, 8_000);
      if (!artifact) return null;
      const exactReplyId = replyMessageId(model);
      let reply = null;
      if (exactReplyId) {
        const replyModel = await Promise.resolve(
          messages.getMessageByPeer(numericDialogPeerId, Number(exactReplyId)),
        ).catch(() => null);
        const replyArtifact = await baseArtifact(replyModel, exactReplyId, null, maximumReplyChars);
        reply = replyArtifact
          ? {
            messageId: replyArtifact.messageId,
            contextAvailable: true,
            simple: null,
            author: replyArtifact.author,
            authorPeerId: replyArtifact.authorPeerId,
            authorSemanticId: replyArtifact.authorSemanticId,
            timestamp: replyArtifact.timestamp,
            text: replyArtifact.text,
            linkEntities: replyArtifact.linkEntities,
            linkEntitiesTruncated: replyArtifact.linkEntitiesTruncated,
          }
          : {
            messageId: exactReplyId,
            contextAvailable: false,
            simple: null,
            author: null,
            authorPeerId: null,
            authorSemanticId: null,
            timestamp: null,
            text: null,
            linkEntities: [],
            linkEntitiesTruncated: false,
          };
      }
      output.push({
        messageId: artifact.messageId,
        peerId: exactDialogPeerId,
        author: artifact.author,
        authorPeerId: artifact.authorPeerId,
        authorSemanticId: artifact.authorSemanticId,
        timestamp: artifact.timestamp,
        direction: artifact.direction,
        text: artifact.text,
        linkEntities: artifact.linkEntities,
        linkEntitiesTruncated: artifact.linkEntitiesTruncated,
        attachments: artifact.attachments,
        reply,
      });
    }
    return output;
  }, {
    exactDialogPeerId: dialogPeerId,
    exactReferences: references.map((reference) => ({
      messageId: reference.messageId,
      authorHint: typeof reference.authorHint === "string" ? reference.authorHint.slice(0, 256) : null,
    })),
    maximumLinks: MAX_LINK_ENTITIES_PER_MESSAGE,
    maximumReplyChars: MAX_REPLY_CONTEXT_CHARS,
    maximumAttachments: MAX_ATTACHMENT_METADATA_PER_MESSAGE,
    unsafeDisplayPatternSource: DISPLAY_LABEL_UNSAFE_PATTERN_SOURCE,
    maximumDisplayLabelChars: MAX_DISPLAY_LABEL_CHARS,
  });

  const linkSafe = (entity, text) => {
    if (!entity || typeof entity !== "object" || Array.isArray(entity)) return false;
    if (Object.keys(entity).join(",") !== "type,offsetUtf16,lengthUtf16,text,target") return false;
    if (!["url", "text_url", "email"].includes(entity.type)
      || !Number.isInteger(entity.offsetUtf16)
      || !Number.isInteger(entity.lengthUtf16)
      || entity.offsetUtf16 < 0
      || entity.lengthUtf16 < 1
      || entity.offsetUtf16 + entity.lengthUtf16 > text.length
      || typeof entity.text !== "string"
      || entity.text.length > 2_048
      || entity.text !== text.slice(
        entity.offsetUtf16,
        entity.offsetUtf16 + entity.lengthUtf16,
      ).slice(0, 2_048)
      || ![null, "string"].includes(entity.target === null ? null : typeof entity.target)
      || (typeof entity.target === "string" && entity.target.length > 2_048)) return false;
    if (entity.target !== null) {
      if (DISPLAY_LABEL_UNSAFE_TEST_PATTERN.test(entity.target)) return false;
      try {
        if (!["http:", "https:", "mailto:", "tg:"].includes(new URL(entity.target).protocol)) return false;
      } catch {
        return false;
      }
    }
    return true;
  };
  const authorSafe = (value) => value === null
    || (typeof value === "string"
      && value.length <= 256
      && sanitizeDisplayLabel(value, 256) === value);
  const authorPeerSafe = (value) => {
    if (value === null) return true;
    try {
      requireExactSafePeerId(value);
      return true;
    } catch {
      return false;
    }
  };
  const timestampSafe = (value) => {
    if (value === null) return true;
    if (typeof value !== "string" || value.length > 128) return false;
    try {
      return new Date(value).toISOString() === value;
    } catch {
      return false;
    }
  };
  const linksSafe = (links, text, truncated) => Array.isArray(links)
    && links.length <= MAX_LINK_ENTITIES_PER_MESSAGE
    && typeof truncated === "boolean"
    && links.every((entity) => linkSafe(entity, text));
  const attachmentSafe = (attachment, index) => {
    if (!attachment || typeof attachment !== "object" || Array.isArray(attachment)) return false;
    if (Object.keys(attachment).join(",") !== "index,kind,name,sizeBytes,mimeType") return false;
    return attachment.index === index + 1
      && ["document", "image", "audio", "voice", "video", "video_note", "animation", "sticker"].includes(attachment.kind)
      && (attachment.name === null || (
        typeof attachment.name === "string"
        && attachment.name.length >= 1
        && attachment.name.length <= 512
        && sanitizeDisplayLabel(attachment.name, 512) === attachment.name
      ))
      && (attachment.sizeBytes === null || (
        typeof attachment.sizeBytes === "number"
        && Number.isSafeInteger(attachment.sizeBytes)
        && attachment.sizeBytes >= 0
      ))
      && (attachment.mimeType === null || (
        typeof attachment.mimeType === "string"
        && attachment.mimeType.length >= 3
        && attachment.mimeType.length <= 255
        && /^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/u.test(attachment.mimeType)
      ));
  };
  const attachmentsSafe = (attachments) => Array.isArray(attachments)
    && attachments.length <= MAX_ATTACHMENT_METADATA_PER_MESSAGE
    && attachments.every(attachmentSafe);
  const replySafe = (reply) => {
    if (reply === null) return true;
    if (!reply || typeof reply !== "object" || Array.isArray(reply)) return false;
    if (Object.keys(reply).join(",") !== "messageId,contextAvailable,simple,author,authorPeerId,authorSemanticId,timestamp,text,linkEntities,linkEntitiesTruncated") return false;
    return isExactPositiveSafeDecimal(reply.messageId)
      && typeof reply.contextAvailable === "boolean"
      && [null, true, false].includes(reply.simple)
      && authorSafe(reply.author)
      && authorPeerSafe(reply.authorPeerId)
      && [null, "self"].includes(reply.authorSemanticId)
      && (reply.authorSemanticId !== "self" || reply.authorPeerId === null)
      && timestampSafe(reply.timestamp)
      && (reply.text === null || (typeof reply.text === "string" && reply.text.length <= MAX_REPLY_CONTEXT_CHARS))
      && linksSafe(reply.linkEntities, reply.text || "", reply.linkEntitiesTruncated)
      && (reply.contextAvailable || (
        reply.author === null
        && reply.authorPeerId === null
        && reply.authorSemanticId === null
        && reply.timestamp === null
        && reply.text === null
        && reply.linkEntities.length === 0
        && reply.linkEntitiesTruncated === false
      ));
  };
  const expectedKeys = "messageId,peerId,author,authorPeerId,authorSemanticId,timestamp,direction,text,linkEntities,linkEntitiesTruncated,attachments,reply";
  if (!Array.isArray(artifacts)
    || artifacts.length !== references.length
    || artifacts.some((artifact, index) => !artifact
      || typeof artifact !== "object"
      || Array.isArray(artifact)
      || Object.keys(artifact).join(",") !== expectedKeys
      || artifact.messageId !== references[index].messageId
      || artifact.peerId !== dialogPeerId
      || !authorSafe(artifact.author)
      || !authorPeerSafe(artifact.authorPeerId)
      || ![null, "self"].includes(artifact.authorSemanticId)
      || (artifact.authorSemanticId === "self" && artifact.authorPeerId !== null)
      || !timestampSafe(artifact.timestamp)
      || ![null, "incoming", "outgoing"].includes(artifact.direction)
      || typeof artifact.text !== "string"
      || artifact.text.length > 8_000
      || !linksSafe(artifact.linkEntities, artifact.text, artifact.linkEntitiesTruncated)
      || !attachmentsSafe(artifact.attachments)
      || !replySafe(artifact.reply))) {
    fail("TELEGRAM_WEB_UI_UNSUPPORTED", "Telegram Web message artifacts did not satisfy the bounded author/date/link/reply/attachment contract.");
  }
  return artifacts;
};

const collectMessages = async (page, limit) => {
  const messages = await page.evaluate(async (maximum) => {
  const messages = [];
  const seen = new Set();
  const exactPositiveSafeId = (value) => {
    const rendered = String(value ?? "");
    const numeric = Number(rendered);
    return /^\d{1,24}$/u.test(rendered)
      && Number.isSafeInteger(numeric)
      && numeric > 0
      && String(numeric) === rendered;
  };
  const exactPositiveSafeModelId = (value) => typeof value === "number"
    && Number.isSafeInteger(value)
    && value > 0;
  const nodes = document.querySelectorAll('.bubbles-inner .bubble[data-mid][data-peer-id]');
  for (const bubble of nodes) {
    const messageId = bubble.getAttribute("data-mid");
    const peerId = bubble.getAttribute("data-peer-id");
    if (!messageId || !exactPositiveSafeId(messageId) || !peerId || !/^-?\d{1,24}$/u.test(peerId)) {
      // Preserve only an internal sentinel. The outer fail-closed check emits
      // no provider identifier but must not silently omit a malformed row.
      messages.push({ providerIdentityInvalid: true });
      break;
    }
    if (seen.has(`${peerId}:${messageId}`)) continue;
    const manager = globalThis.rootScope?.managers?.appMessagesManager;
    const numericPeerId = Number(peerId);
    const numericMessageId = Number(messageId);
    let modelText = null;
    let modelReplyMessageId = null;
    let modelReplySafe = false;
    let modelReplySimple = true;
    let modelDirectionVerified = false;
    let modelOutgoing = null;
    if (Number.isSafeInteger(numericPeerId) && numericPeerId !== 0 && exactPositiveSafeId(messageId) && typeof manager?.getMessageByPeer === "function") {
      try {
        const modelMessage = await Promise.resolve(manager.getMessageByPeer(numericPeerId, numericMessageId));
        const modelIdentityExact = typeof modelMessage?.peerId === "number"
          && Number.isSafeInteger(modelMessage.peerId)
          && modelMessage.peerId !== 0
          && String(modelMessage.peerId) === peerId
          && typeof modelMessage?.mid === "number"
          && Number.isSafeInteger(modelMessage.mid)
          && modelMessage.mid > 0
          && String(modelMessage.mid) === messageId;
        if (modelIdentityExact && typeof modelMessage?.message === "string") modelText = modelMessage.message;
        else if (modelIdentityExact && (modelMessage?._ === "messageService" || modelMessage?._ === "messageEmpty")) modelText = "";
        const activeChat = globalThis.appImManager?.chat;
        if (modelIdentityExact
          && typeof activeChat?.peerId === "number"
          && Number.isSafeInteger(activeChat.peerId)
          && activeChat.peerId !== 0
          && String(activeChat.peerId) === peerId
          && activeChat.type === "chat"
          && activeChat.isMonoforum !== true
          && typeof activeChat.isOutMessage === "function") {
          const officialOutgoing = activeChat.isOutMessage(modelMessage);
          const domOutgoing = bubble.classList.contains("is-out");
          if (typeof officialOutgoing === "boolean" && officialOutgoing === domOutgoing) {
            modelOutgoing = officialOutgoing;
            modelDirectionVerified = true;
          }
        }
        const replyHeader = modelMessage?.reply_to;
        const convenienceReplyId = modelMessage?.reply_to_mid;
        const nonempty = (value) => value !== undefined && value !== null && value !== false && value !== "" && value !== 0 && value !== "0";
        const identifierPresent = (value) => value !== undefined && value !== null && value !== false && value !== "";
        if (!identifierPresent(replyHeader) && !identifierPresent(convenienceReplyId)) {
          modelReplySafe = true;
        } else if (replyHeader?._ === "messageReplyHeader") {
          const headerReplyId = String(replyHeader.reply_to_msg_id ?? "");
          const convenienceId = String(convenienceReplyId ?? "");
          let headerPeerId = null;
          if (nonempty(replyHeader.reply_to_peer_id)) {
            const peers = globalThis.rootScope?.managers?.appPeersManager;
            if (typeof peers?.getPeerId === "function") {
              try {
                const liveReplyPeerId = peers.getPeerId(replyHeader.reply_to_peer_id);
                headerPeerId = typeof liveReplyPeerId === "number"
                  && Number.isSafeInteger(liveReplyPeerId)
                  && liveReplyPeerId !== 0
                  ? String(liveReplyPeerId)
                  : "invalid";
              } catch {
                headerPeerId = "invalid";
              }
            } else {
              headerPeerId = "invalid";
            }
          }
          const flags = replyHeader.pFlags;
          const unsafeFlags = flags && typeof flags === "object" && Object.values(flags).some(Boolean);
          const unsafeFields = [
            replyHeader.reply_to_story_id,
            replyHeader.reply_to_top_id,
            replyHeader.reply_from,
            replyHeader.reply_media,
            replyHeader.quote_text,
            replyHeader.quote_entities,
            replyHeader.quote_offset,
            replyHeader.todo_item_id,
          ].some(nonempty);
          if (exactPositiveSafeModelId(replyHeader.reply_to_msg_id)
            && exactPositiveSafeModelId(convenienceReplyId)
            && headerReplyId === convenienceId
            && (headerPeerId === null || headerPeerId === peerId)) {
            modelReplyMessageId = headerReplyId;
            modelReplySafe = true;
            modelReplySimple = !unsafeFlags && !unsafeFields;
          }
        }
      } catch {
        modelText = null;
        modelReplySafe = false;
      }
    }
    const author = String(
      bubble.querySelector('.colored-name .peer-title, .name .peer-title, [data-peer-id] > .peer-title')?.textContent || "",
    ).replace(/\s+/gu, " ").trim().slice(0, 256) || null;
    const seconds = Number(bubble.getAttribute("data-timestamp"));
    const timeNode = bubble.querySelector('.time, .time-inner, time');
    const displayedTimestamp = String(
      timeNode?.getAttribute("datetime")
      || timeNode?.getAttribute("title")
      || timeNode?.textContent
      || "",
    ).replace(/\s+/gu, " ").trim().slice(0, 128) || null;
    const reply = String(bubble.querySelector('.reply, .reply-summary')?.innerText || "").slice(0, 2_000) || null;
    const rawReplyToMessageId = bubble.getAttribute("data-reply-to-mid");
    const replyToMessageId = rawReplyToMessageId === null ? "" : String(rawReplyToMessageId);
    const domReplyPresent = rawReplyToMessageId !== null && replyToMessageId !== "";
    const domReplyExact = domReplyPresent && exactPositiveSafeId(replyToMessageId);
    const nestedAttachmentNodes = Array.from(bubble.querySelectorAll(
      '.document-container, .document, .media-container img, .media-container video, audio-element, .grouped-item[data-mid]',
    ));
    const attachmentNodes = nestedAttachmentNodes.filter((node) => !nestedAttachmentNodes.some((other) => other !== node && other.contains(node)));
    const attachments = attachmentNodes.slice(0, 20).map((node, attachmentIndex) => ({
      index: attachmentIndex + 1,
      kind: node.matches('.document, .document-container')
        ? "document"
        : node.matches('audio-element')
          ? "audio"
          : node.querySelector?.('video') || node.matches('video')
            ? "video"
            : "image",
      name: String(
        node.querySelector?.('.document-name')?.textContent
        || node.getAttribute?.("alt")
        || node.getAttribute?.("title")
        || "",
      ).replace(/\s+/gu, " ").trim().slice(0, 512) || null,
      size: String(node.querySelector?.('.document-size')?.textContent || "").replace(/\s+/gu, " ").trim().slice(0, 128) || null,
    }));
    messages.push({
      messageId,
      peerId,
      author,
      timestamp: Number.isFinite(seconds) && seconds > 0 ? new Date(seconds * 1000).toISOString() : displayedTimestamp,
      direction: modelOutgoing === true ? "outgoing" : "incoming",
      text: modelText === null ? "" : modelText.slice(0, 8_000),
      modelTextVerified: modelText !== null,
      modelReplyVerified: modelReplySafe && (
        (!modelReplyMessageId && !domReplyPresent)
        || (Boolean(modelReplyMessageId) && domReplyExact && modelReplyMessageId === replyToMessageId)
      ),
      modelDirectionVerified,
      reply: reply || modelReplyMessageId
        ? { messageId: modelReplyMessageId, text: reply, simple: modelReplySimple }
        : null,
      attachments,
    });
    seen.add(`${peerId}:${messageId}`);
  }
  return messages.slice(-maximum);
  }, limit);
  if (messages.some((message) => {
    if (message.providerIdentityInvalid) return true;
    let peerUnsafe = false;
    try {
      requireExactSafePeerId(message.peerId);
    } catch {
      peerUnsafe = true;
    }
    return !isExactPositiveSafeDecimal(message.messageId)
      || peerUnsafe
      || !message.modelTextVerified
      || !message.modelReplyVerified
      || !message.modelDirectionVerified;
  })) {
    fail("TELEGRAM_WEB_UI_UNSUPPORTED", "Telegram Web exposed malformed provider message identifiers.");
  }
  for (const message of messages) {
    delete message.modelTextVerified;
    delete message.modelReplyVerified;
    delete message.modelDirectionVerified;
  }
  if (messages.length === 0) return messages;
  const dialogPeerId = messages[0].peerId;
  if (messages.some((message) => message.peerId !== dialogPeerId)) {
    fail("TELEGRAM_WEB_UI_UNSUPPORTED", "Telegram Web mixed multiple dialog peers into one bounded history artifact.");
  }
  const artifacts = await readExactMessageArtifacts(
    page,
    messages.map((message) => ({ messageId: message.messageId, authorHint: message.author })),
    dialogPeerId,
  );
  return messages.map((message, index) => {
    const artifact = artifacts[index];
    if (artifact.text !== message.text
      || (artifact.direction !== null && artifact.direction !== message.direction)
      || Boolean(artifact.reply) !== Boolean(message.reply)
      || (artifact.reply && artifact.reply.messageId !== message.reply.messageId)) {
      fail("TELEGRAM_WEB_UI_UNSUPPORTED", "Telegram Web model and DOM history artifacts disagreed on exact text, direction, or reply identity.");
    }
    return {
      ...message,
      // Never fall back to the raw DOM label. The model artifact has already
      // normalized both its bounded DOM hint and authoritative peer title
      // through the full shared display sanitizer; a null result means there
      // is no safe author label to expose.
      author: artifact.author,
      authorPeerId: artifact.authorPeerId,
      authorSemanticId: artifact.authorSemanticId,
      // The authoritative model timestamp is either exact ISO or null. Never
      // substitute an arbitrary localized DOM label such as "10:45": search
      // has no such fallback and the shared public schema promises ISO|null.
      timestamp: artifact.timestamp,
      direction: artifact.direction || message.direction,
      text: artifact.text,
      linkEntities: artifact.linkEntities,
      linkEntitiesTruncated: artifact.linkEntitiesTruncated,
      attachments: artifact.attachments,
      reply: artifact.reply
        ? { ...artifact.reply, simple: message.reply.simple }
        : null,
    };
  });
};

const sourceMessageDescriptor = (message) => ({
  messageId: message.messageId,
  peerId: message.peerId,
  direction: message.direction,
  text: message.text,
  textSha256: sha256(message.text),
  attachments: message.attachments.map(({ kind, name, sizeBytes, mimeType }) => ({
    kind,
    name,
    sizeBytes,
    mimeType,
  })),
});

const exactLoadedMessageDescriptor = async (page, messageId, { outgoingOnly = false, expectedPeerId } = {}) => {
  expectedPeerId = requireExactSafePeerId(expectedPeerId);
  await assertOpenPeer(page, expectedPeerId);
  const messages = await collectMessages(page, MAX_HISTORY_MESSAGES);
  const matches = messages.filter((message) => message.messageId === messageId
    && message.peerId === expectedPeerId
    && (!outgoingOnly || message.direction === "outgoing"));
  if (matches.length !== 1) fail("TELEGRAM_WEB_MESSAGE_NOT_FOUND", "One exact loaded Telegram message could not be bound to the operation approval.");
  return sourceMessageDescriptor(matches[0]);
};

/**
 * Prove from Web K's authoritative message model that an edit source belongs
 * to the deliberately narrow plain-text surface. DOM attachment discovery is
 * only presentation corroboration: a caption, grouped/forwarded/bot message,
 * scheduled result, effect, or paid message must be rejected before approval
 * and again immediately before the decisive edit submit click.
 */
const COMPLEX_PLAIN_TEXT_MESSAGE_FIELDS = Object.freeze([
  "media",
  "grouped_id",
  "fwd_from",
  "via_bot_id",
  "via_business_bot_id",
  "guestchat_via_from",
  "effect",
  "effect_id",
  "paid_message_stars",
  "paid_suggested_post_stars",
  "paid_suggested_post_ton",
  "schedule_date",
  "schedule_repeat_period",
  "reply_markup",
  "factcheck",
  "suggested_post",
  "rich_message",
  "quick_reply_shortcut_id",
  "sponsoredMessage",
  "saved_peer_id",
  "post_author",
  "replies",
  "restriction_reason",
  "ttl_period",
  "destroyAt",
  "report_delivery_until_date",
  "promise",
  "uploadingFileName",
  "repayRequest",
  "clear_history",
  "business_connection_id",
  "from_boosts_applied",
  "from_rank",
  "summary_from_language",
  "silent",
  "post",
  "noforwards",
  "invert_media",
  "offline",
  "video_processing_pending",
  "is_scheduled",
  "sponsored",
  "totalEntities",
  "savedFrom",
  "viaBotId",
  "fwdFromId",
]);

const COMPLEX_PLAIN_TEXT_MESSAGE_FLAGS = Object.freeze([
  "is_outgoing",
  "from_scheduled",
  "silent",
  "post",
  "legacy",
  "edit_hide",
  "pinned",
  "noforwards",
  "invert_media",
  "offline",
  "video_processing_pending",
  "paid_suggested_post_stars",
  "paid_suggested_post_ton",
  "is_scheduled",
  "sponsored",
  "local",
  "currentlyTyping",
  "fakeForSavedMusic",
]);

// Exact enumerable shape admitted by the narrow source model. Unknown future
// fields/flags fail closed even if the denylist above has not learned their
// name yet. The allowed set consists only of base MTProto identity/text/time
// fields and Web K's corroborating local identity keys. Reply metadata must be
// empty. entities/totalEntities may contain only automatic semantics which the
// live Web K parser derives from exact visible substrings under the
// source-validated Web K contract. Some of those semantics (URL, mention,
// timestamp) are interactive, but none may carry a
// hidden target. Formatting and explicit-target entities remain outside this
// surface.
const PLAIN_TEXT_MESSAGE_ALLOWED_KEYS = Object.freeze([
  "_",
  "flags",
  "flags2",
  "pFlags",
  "id",
  "from_id",
  "peer_id",
  "saved_peer_id",
  "reply_to",
  "date",
  "message",
  "edit_date",
  "reactions",
  "mid",
  "peerId",
  "fromId",
  "reply_to_mid",
  "storageKey",
  "entities",
  "totalEntities",
]);

const PLAIN_TEXT_MESSAGE_ALLOWED_PFLAGS = Object.freeze(["out"]);

const assertPlainEditableSourceModel = async (page, expectedPeerId, messageId) => {
  expectedPeerId = requireExactSafePeerId(expectedPeerId);
  if (!isExactPositiveSafeDecimal(messageId)) {
    fail("TELEGRAM_WEB_INVALID_ARGUMENT", "Plain-text edit eligibility requires one exact positive safe message ID.");
  }
  await assertOpenPeer(page, expectedPeerId);
  const state = await page.evaluate(async ({
    peerId,
    mid,
    forbiddenFields,
    forbiddenFlags,
    allowedKeys,
    allowedFlags,
  }) => {
    const manager = globalThis.rootScope?.managers?.appMessagesManager;
    const chat = globalThis.appImManager?.chat;
    const numericPeerId = Number(peerId);
    const numericMessageId = Number(mid);
    if (typeof manager?.getMessageByPeer !== "function"
      || typeof chat?.isOutMessage !== "function"
      || typeof chat?.peerId !== "number"
      || !Number.isSafeInteger(chat.peerId)
      || chat.peerId === 0
      || String(chat.peerId) !== peerId
      || chat.type !== "chat"
      || chat.isMonoforum === true
      || !Number.isSafeInteger(numericPeerId)
      || numericPeerId === 0
      || !Number.isSafeInteger(numericMessageId)
      || numericMessageId <= 0) return { known: false };
    let model;
    let outgoing;
    try {
      model = await Promise.resolve(manager.getMessageByPeer(numericPeerId, numericMessageId));
      outgoing = chat.isOutMessage(model);
    } catch {
      return { known: false };
    }
    const identityExact = model?._ === "message"
      && typeof model.peerId === "number"
      && Number.isSafeInteger(model.peerId)
      && model.peerId !== 0
      && String(model.peerId) === peerId
      && typeof model.mid === "number"
      && Number.isSafeInteger(model.mid)
      && model.mid > 0
      && String(model.mid) === mid
      && typeof model.message === "string"
      && outgoing === true;
    if (!identityExact) return { known: false };
    const modelPrototype = Object.getPrototypeOf(model);
    if (modelPrototype !== Object.prototype && modelPrototype !== null) return { known: false };
    const nonempty = (value) => value !== undefined
      && value !== null
      && value !== false
      && value !== ""
      && value !== 0
      && value !== "0"
      && (!Array.isArray(value) || value.length > 0);
    const flags = model.pFlags === undefined || model.pFlags === null ? {} : model.pFlags;
    const flagPrototype = typeof flags === "object" && !Array.isArray(flags)
      ? Object.getPrototypeOf(flags)
      : null;
    const flagsKnown = typeof flags === "object"
      && !Array.isArray(flags)
      && (flagPrototype === Object.prototype || flagPrototype === null);
    const finalEntities = model.entities === undefined || model.entities === null ? [] : model.entities;
    const totalEntities = model.totalEntities === undefined || model.totalEntities === null ? [] : model.totalEntities;
    const rootId = globalThis.rootScope?.myId;
    const savedPeer = model.saved_peer_id;
    const savedPeerPrototype = savedPeer && typeof savedPeer === "object" && !Array.isArray(savedPeer)
      ? Object.getPrototypeOf(savedPeer)
      : null;
    const savedPeerKnown = !nonempty(savedPeer) || (
      typeof rootId === "number"
      && Number.isSafeInteger(rootId)
      && rootId > 0
      && String(rootId) === peerId
      && (savedPeerPrototype === Object.prototype || savedPeerPrototype === null)
      && Object.keys(savedPeer).sort().join(",") === "_,user_id"
      && savedPeer._ === "peerUser"
      && typeof savedPeer.user_id === "number"
      && Number.isSafeInteger(savedPeer.user_id)
      && savedPeer.user_id === rootId
      && !nonempty(model.fwd_from)
    );
    const masksKnown = [model.flags, model.flags2].every((value) => value === undefined
      || (typeof value === "number" && Number.isInteger(value) && Number.isSafeInteger(value)));
    const plain = flagsKnown
      && masksKnown
      && Object.keys(model).every((key) => allowedKeys.includes(key))
      && Object.keys(flags).every((flag) => allowedFlags.includes(flag) && flags[flag] === true)
      && model.pending === undefined
      && model.error === undefined
      && model.random_id === undefined
      && model.send === undefined
      && Array.isArray(finalEntities)
      && finalEntities.length <= 128
      && Array.isArray(totalEntities)
      && totalEntities.length <= 256
      && savedPeerKnown
      && !nonempty(model.reply_to)
      && !nonempty(model.reply_to_mid)
      && !forbiddenFields.some((field) => !["saved_peer_id", "totalEntities"].includes(field) && nonempty(model[field]))
      && !forbiddenFlags.some((flag) => flags[flag] === true);
    return {
      known: true,
      plain,
      message: model.message,
      entities: finalEntities,
      totalEntities,
    };
  }, {
    peerId: expectedPeerId,
    mid: messageId,
    forbiddenFields: COMPLEX_PLAIN_TEXT_MESSAGE_FIELDS,
    forbiddenFlags: COMPLEX_PLAIN_TEXT_MESSAGE_FLAGS,
    allowedKeys: PLAIN_TEXT_MESSAGE_ALLOWED_KEYS,
    allowedFlags: PLAIN_TEXT_MESSAGE_ALLOWED_PFLAGS,
  });
  if (!state?.known) {
    fail("TELEGRAM_WEB_UI_UNSUPPORTED", "Telegram Web could not authoritatively bind the exact outgoing edit source model.");
  }
  const authoritativeEntities = state?.plain
    ? await deriveLiveWebKAutomaticEntities(page, state.message)
    : null;
  if (authoritativeEntities) assertNoMutationLinkPreview(authoritativeEntities);
  const entitySemanticsSafe = state?.plain
    && automaticEntitiesExactlyMatch(authoritativeEntities, state.totalEntities)
    && automaticEntitiesAreExactSubset(authoritativeEntities, state.entities);
  if (!entitySemanticsSafe) {
    fail(
      "TELEGRAM_WEB_UNSUPPORTED_OPERATION",
      "Editing formatted, media, grouped, forwarded, bot-authored, scheduled, effect-bearing, paid/suggested, sponsored, restricted, expiring, reply-markup, quick-reply, pending, or otherwise complex Telegram messages is outside the verified plain-text edit surface. No edit submit click was made.",
      { operation: "edit-complex-message", fallbackEligible: true },
    );
  }
  return true;
};

const boundStructuredResult = (payload, messagesKey = "messages") => {
  let serialized = JSON.stringify(payload);
  if (Buffer.byteLength(serialized, "utf8") <= MAX_RESULT_BYTES) return payload;
  const items = Array.isArray(payload[messagesKey]) ? [...payload[messagesKey]] : [];
  while (items.length > 1) {
    items.shift();
    const candidate = {
      ...payload,
      [messagesKey]: items,
      incomplete: true,
      incompleteReasons: [...new Set([...(payload.incompleteReasons || []), "json_byte_limit"])],
    };
    serialized = JSON.stringify(candidate);
    if (Buffer.byteLength(serialized, "utf8") <= MAX_RESULT_BYTES) return candidate;
  }
  fail("TELEGRAM_WEB_RESULT_TOO_LARGE", "A single Telegram Web result item exceeded the safe JSON byte limit.");
};

const findMessageTarget = async (page, messageId, { outgoingOnly = false, expectedPeerId } = {}) => {
  if (!isExactPositiveSafeDecimal(messageId)) fail("TELEGRAM_WEB_INVALID_ARGUMENT", "An exact positive safe --message-id is required.");
  expectedPeerId = requireExactSafePeerId(expectedPeerId);
  await assertOpenPeer(page, expectedPeerId);
  const candidates = page.locator(`.bubbles-inner .bubble[data-mid="${messageId}"], .bubbles-inner .grouped-item[data-mid="${messageId}"]`);
  const matches = [];
  for (let index = 0; index < await candidates.count(); index += 1) {
    const locator = candidates.nth(index);
    if (!await locator.isVisible().catch(() => false)) continue;
    const targetState = await locator.evaluate((element) => {
      const bubble = element.closest('.bubble[data-peer-id]');
      return { outgoing: Boolean(element.closest('.bubble.is-out')), peerId: bubble?.getAttribute("data-peer-id") || null };
    }).catch(() => ({ outgoing: false, peerId: null }));
    if (targetState.peerId !== expectedPeerId) continue;
    const { outgoing } = targetState;
    if (outgoingOnly && !outgoing) continue;
    matches.push({ locator, outgoing });
  }
  if (matches.length !== 1) {
    fail("TELEGRAM_WEB_MESSAGE_NOT_FOUND", "Exactly one loaded Telegram message must match --message-id. Read enough bounded history and retry once if no mutation was attempted.");
  }
  return matches[0];
};

const findComposer = async (page) => {
  const candidates = page.locator('.chat-input .input-message-input[contenteditable="true"], .input-message-input[contenteditable="true"]');
  const visible = [];
  for (let index = 0; index < await candidates.count(); index += 1) {
    const candidate = candidates.nth(index);
    if (await candidate.isVisible().catch(() => false)) visible.push(candidate);
  }
  if (visible.length !== 1) fail("TELEGRAM_WEB_UI_UNSUPPORTED", "Could not identify one safe Telegram message composer.");
  return visible[0];
};

const PLAIN_AUTOMATIC_ENTITY_TYPES = Object.freeze([
  "messageEntityMention",
  "messageEntityEmail",
  "messageEntityUrl",
  "messageEntityLinebreak",
  "messageEntityEmoji",
  "messageEntityHashtag",
  "messageEntityTimestamp",
]);

/**
 * Validate only the closed structural shape emitted by the live Web K parser
 * under the source-validated contract. This deliberately does not try to
 * reproduce Web K's URL/TLD,
 * mention, timestamp, or emoji grammar: a hand-written approximation already
 * proved too permissive. Semantic authority comes exclusively from
 * `deriveLiveWebKAutomaticEntities` below.
 */
const automaticEntityListHasClosedShape = (entities) => {
  if (!Array.isArray(entities)) return false;
  let previousEnd = 0;
  return entities.every((entity) => {
    if (!entity || typeof entity !== "object" || typeof entity._ !== "string") return false;
    if (!Number.isInteger(entity.offset)
      || !Number.isInteger(entity.length)
      || entity.offset < previousEnd
      || entity.length <= 0
      || entity.offset + entity.length > Number.MAX_SAFE_INTEGER) return false;
    const baseKeys = ["_", "offset", "length"];
    const exactKeys = (additional) => {
      const expected = [...baseKeys, ...additional];
      const actual = Object.keys(entity);
      return actual.length === expected.length && expected.every((key) => Object.hasOwn(entity, key));
    };
    let shapeSafe = PLAIN_AUTOMATIC_ENTITY_TYPES.includes(entity._);
    if (["messageEntityMention", "messageEntityEmail", "messageEntityUrl", "messageEntityLinebreak", "messageEntityHashtag"].includes(entity._)) {
      shapeSafe = shapeSafe && exactKeys([]);
    } else if (entity._ === "messageEntityEmoji") {
      shapeSafe = exactKeys(["unicode"])
        && typeof entity.unicode === "string"
        && /^[0-9a-f-]+$/iu.test(entity.unicode);
    } else if (entity._ === "messageEntityTimestamp") {
      shapeSafe = exactKeys(["raw", "time"])
        && typeof entity.raw === "string"
        && Number.isSafeInteger(entity.time)
        && entity.time >= 0;
    }
    previousEnd = entity.offset + entity.length;
    return shapeSafe;
  });
};

const automaticEntitiesExactlyMatch = (authoritative, candidate) => (
  automaticEntityListHasClosedShape(authoritative)
  && automaticEntityListHasClosedShape(candidate)
  && canonicalJson(authoritative) === canonicalJson(candidate)
);

const automaticEntitiesAreExactSubset = (authoritative, candidate) => {
  if (!automaticEntityListHasClosedShape(authoritative)
    || !automaticEntityListHasClosedShape(candidate)) return false;
  const remaining = new Map();
  for (const entity of authoritative) {
    const key = canonicalJson(entity);
    remaining.set(key, (remaining.get(key) || 0) + 1);
  }
  for (const entity of candidate) {
    const key = canonicalJson(entity);
    const count = remaining.get(key) || 0;
    if (count < 1) return false;
    remaining.set(key, count - 1);
  }
  return true;
};

const assertNoMutationLinkPreview = (entities) => {
  if (entities.some((entity) => entity?._ === "messageEntityUrl")) {
    fail(
      "TELEGRAM_WEB_UNSUPPORTED_OPERATION",
      "URL text mutations are outside the verified pilot because Telegram Web can attach an asynchronous link preview after the bounded composer proof.",
      { operation: "link-preview", fallbackEligible: true },
    );
  }
};

/**
 * Ask the live Web K ChatInput implementation covered by the source-validated
 * contract to derive automatic
 * entities from a detached plain-text contenteditable. This is the same
 * `getRichValueWithCaret` + `parseEntities` + `mergeEntities` path used for
 * sending, so URL grammar, emoji allowlisting, mention length and timestamp
 * bounds cannot drift into a weaker local imitation.
 */
const deriveLiveWebKAutomaticEntities = async (page, approvedMessage) => {
  if (typeof approvedMessage !== "string") {
    fail("TELEGRAM_WEB_UI_UNSUPPORTED", "Telegram Web automatic entity derivation requires exact text.");
  }
  const state = await page.evaluate(({ approved }) => {
    const input = globalThis.appImManager?.chat?.input;
    if (typeof input?.getValueAndEntities !== "function"
      || typeof document?.createElement !== "function"
      || !document.body
      || typeof document.body.append !== "function") return { known: false };
    const detached = document.createElement("div");
    try {
      detached.contentEditable = "true";
      detached.setAttribute("aria-hidden", "true");
      detached.style.position = "fixed";
      detached.style.left = "-100000px";
      detached.style.top = "-100000px";
      detached.textContent = approved;
      document.body.append(detached);
      const exact = input.getValueAndEntities(detached);
      if (!exact
        || exact.value !== approved
        || !Array.isArray(exact.totalEntities)
        || exact.totalEntities.length > 256) return { known: false };
      return {
        known: true,
        value: exact.value,
        totalEntities: structuredClone(exact.totalEntities),
      };
    } catch {
      return { known: false };
    } finally {
      detached.remove();
    }
  }, { approved: approvedMessage });
  if (!state?.known || state.value !== approvedMessage) {
    fail("TELEGRAM_WEB_UI_UNSUPPORTED", "The live Telegram Web build did not expose the source-validated automatic-entity parser contract for the approved text.");
  }
  if (!automaticEntityListHasClosedShape(state.totalEntities)
    || state.totalEntities.some((entity) => entity.offset + entity.length > approvedMessage.length)) {
    fail(
      "TELEGRAM_WEB_UNSUPPORTED_OPERATION",
      "Telegram Web derived a formatting, bot-command, hidden-target, malformed, or unknown entity outside the verified plain-text surface.",
      { operation: "rich-text-transform", fallbackEligible: true },
    );
  }
  return state.totalEntities;
};

const assertFinalPlainTextModelEntities = async (page, expectedPeerId, messageId, approvedMessage) => {
  expectedPeerId = requireExactSafePeerId(expectedPeerId);
  const snapshot = await page.evaluate(async ({ peerId, mid, approved }) => {
    const manager = globalThis.rootScope?.managers?.appMessagesManager;
    const numericPeerId = Number(peerId);
    const numericMid = Number(mid);
    if (typeof manager?.getMessageByPeer !== "function"
      || !Number.isSafeInteger(numericPeerId)
      || numericPeerId === 0
      || !Number.isSafeInteger(numericMid)
      || numericMid <= 0) return { known: false };
    try {
      const model = await Promise.resolve(manager.getMessageByPeer(numericPeerId, numericMid));
      const entities = model?.entities === undefined || model?.entities === null ? [] : model.entities;
      const totalEntities = model?.totalEntities === undefined || model?.totalEntities === null ? [] : model.totalEntities;
      if (model?._ !== "message"
        || typeof model.peerId !== "number"
        || !Number.isSafeInteger(model.peerId)
        || String(model.peerId) !== peerId
        || typeof model.mid !== "number"
        || !Number.isSafeInteger(model.mid)
        || String(model.mid) !== mid
        || model.message !== approved
        || !Array.isArray(entities)
        || entities.length > 128
        || !Array.isArray(totalEntities)
        || totalEntities.length > 256) return { known: false };
      return { known: true, entities, totalEntities };
    } catch {
      return { known: false };
    }
  }, { peerId: expectedPeerId, mid: String(messageId), approved: approvedMessage });
  const authoritativeEntities = snapshot?.known
    ? await deriveLiveWebKAutomaticEntities(page, approvedMessage)
    : null;
  if (authoritativeEntities) assertNoMutationLinkPreview(authoritativeEntities);
  if (!snapshot?.known
    || !automaticEntitiesExactlyMatch(authoritativeEntities, snapshot.totalEntities)
    || !automaticEntitiesAreExactSubset(authoritativeEntities, snapshot.entities)) {
    fail(
      "TELEGRAM_WEB_UNSUPPORTED_OPERATION",
      "Telegram Web's final message model contained formatting, hidden targets, or entity semantics not exactly derived from the approved text.",
      { operation: "rich-text-transform", fallbackEligible: false },
    );
  }
  return snapshot;
};

const assertOutgoingComposerSafe = async (page, expectedPeerId, {
  expectedReplyToMessageId = null,
  requireEmpty = false,
  allowMediaPopup = false,
  expectedMessage = null,
  allowRuntimeCreatedEntities = false,
  allowRuntimeCreatedWebPage = false,
} = {}) => {
  expectedPeerId = requireExactSafePeerId(expectedPeerId);
  await assertOpenPeer(page, expectedPeerId);
  const state = await page.evaluate(async ({
    peerId,
    expectedReply,
    emptyRequired,
    mediaPopupAllowed,
    approvedMessage,
    runtimeWebPageAllowed,
  }) => {
    const visible = (node) => {
      if (!(node instanceof Element)) return false;
      const rectangle = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      return rectangle.width > 1 && rectangle.height > 1 && style.display !== "none" && style.visibility !== "hidden";
    };
    const chat = globalThis.appImManager?.chat;
    const input = chat?.input;
    const manager = globalThis.rootScope?.managers?.appMessagesManager;
    const liveMyId = globalThis.rootScope?.myId;
    const myId = typeof liveMyId === "number" && Number.isSafeInteger(liveMyId) && liveMyId > 0
      ? String(liveMyId)
      : "";
    const numericPeerId = Number(peerId);
    const numericMyId = Number(myId);
    if (!Number.isSafeInteger(numericPeerId)
      || numericPeerId === 0
      || !Number.isSafeInteger(numericMyId)
      || numericMyId <= 0
      || !input
      || typeof input.getReplyTo !== "function"
      || typeof input.isInputEmpty !== "function"
      || typeof input.getValueAndEntities !== "function"
      || !input.messageInput
      || typeof manager?.isAnonymousSending !== "function"
      || !/^\d{1,24}$/u.test(myId)) {
      return { known: false, reason: "model_api" };
    }
    if (typeof chat?.peerId !== "number"
      || !Number.isSafeInteger(chat.peerId)
      || chat.peerId === 0
      || String(chat.peerId) !== peerId
      || chat?.type !== "chat"
      || chat?.isMonoforum === true) {
      return { known: false, reason: "chat_surface" };
    }
    let reply;
    let anonymous;
    let effect;
    try {
      reply = await Promise.resolve(input.getReplyTo());
      anonymous = await Promise.resolve(manager.isAnonymousSending(numericPeerId));
      effect = typeof input.effect === "function" ? await Promise.resolve(input.effect()) : input.effect;
    } catch {
      return { known: false, reason: "model_api" };
    }
    if (typeof anonymous !== "boolean") return { known: false, reason: "anonymous" };
    if (typeof chat.isAnonymousSending !== "boolean" || chat.isAnonymousSending !== anonymous) return { known: false, reason: "anonymous" };
    const nonempty = (value) => value !== undefined && value !== null && value !== false && value !== "" && value !== 0 && value !== "0";
    const replyAbsent = reply === undefined || reply === null || reply === false;
    if (expectedReply === null) {
      if (!replyAbsent) return { known: true, safe: false, reason: "reply" };
    } else {
      if (replyAbsent || !reply || typeof reply !== "object" || Array.isArray(reply)) {
        return { known: true, safe: false, reason: "reply" };
      }
      const replyId = String(reply.replyToMsgId ?? "");
      const replyPeer = reply.replyToPeerId;
      const unknownReplyKeys = Object.keys(reply).some((key) => ![
        "replyToMsgId", "replyToStoryId", "replyToQuote", "replyToPollOption",
        "replyToPeerId", "replyToMonoforumPeerId",
      ].includes(key));
      if (unknownReplyKeys
        || replyId !== expectedReply
        || (nonempty(replyPeer) && String(replyPeer) !== peerId)
        || nonempty(reply.replyToStoryId)
        || nonempty(reply.replyToQuote)
        || nonempty(reply.replyToPollOption)
        || nonempty(reply.replyToMonoforumPeerId)) {
        return { known: true, safe: false, reason: "reply" };
      }
    }
    const editActive = nonempty(input.editMessage) || nonempty(input.editMsgId);
    const scheduled = nonempty(input.scheduleDate) || nonempty(input.scheduleRepeatPeriod);
    const silent = input.sendSilent === true || nonempty(input.sendSilent);
    const suggested = nonempty(input.suggestedPost);
    const effectActive = nonempty(effect);
    const forwarding = nonempty(input.forwarding);
    const webPage = nonempty(input.willSendWebPage);
    const pendingWebPage = nonempty(input.getWebPagePromise);
    const noWebPage = nonempty(input.noWebPage);
    const webPageOptions = input.webPageOptions;
    const webPageOptionsUnsafe = !webPageOptions
      || typeof webPageOptions !== "object"
      || Array.isArray(webPageOptions)
      || Object.keys(webPageOptions).length !== 0;
    const invertMedia = nonempty(input.invertMedia);
    const savedReaction = chat.savedReaction;
    const savedReactionUnsafe = savedReaction !== undefined
      && savedReaction !== null
      && (!Array.isArray(savedReaction) || savedReaction.length !== 0);
    const sendAs = input.sendAsPeerId;
    const sendAsUnsafe = nonempty(sendAs) && String(sendAs) !== myId;
    if (editActive || scheduled || silent || suggested || effectActive || forwarding
      || (!runtimeWebPageAllowed && (webPage || pendingWebPage || noWebPage || webPageOptionsUnsafe || invertMedia))
      || savedReactionUnsafe || sendAsUnsafe || anonymous || nonempty(input.recording)) {
      return { known: true, safe: false, reason: "send_parameters" };
    }
    let modelValue;
    let modelEntities;
    let modelEmpty;
    try {
      modelEmpty = input.isInputEmpty();
      const exact = input.getValueAndEntities(input.messageInput);
      modelValue = exact?.value;
      modelEntities = exact?.totalEntities;
    } catch {
      return { known: false, reason: "composer_model" };
    }
    if (typeof modelEmpty !== "boolean" || typeof modelValue !== "string" || !Array.isArray(modelEntities)) return { known: false, reason: "composer_model" };
    if (emptyRequired && (!modelEmpty || modelValue !== "" || modelEntities.length !== 0)) return { known: true, safe: false, reason: "draft" };
    if (approvedMessage !== null) {
      if (modelValue !== approvedMessage) return { known: true, safe: false, reason: "payload" };
    }
    const composers = Array.from(document.querySelectorAll('.chat-input .input-message-input[contenteditable="true"]')).filter(visible);
    if (composers.length !== 1) return { known: false, reason: "composer" };
    if (emptyRequired && String(composers[0].textContent || "") !== "") return { known: true, safe: false, reason: "draft" };
    const helpers = Array.from(document.querySelectorAll('.input-helper .edit, .input-helper .forward, .chat-input .edit-message, .chat-input .forward, .chat-input .schedule-helper, .chat-input .send-silent, .chat-input .suggested-post')).filter(visible);
    if (helpers.length) return { known: true, safe: false, reason: "helper" };
    const mediaPopups = Array.from(document.querySelectorAll('.popup.popup-new-media')).filter(visible);
    if ((!mediaPopupAllowed && mediaPopups.length !== 0) || (mediaPopupAllowed && mediaPopups.length !== 1)) {
      return { known: true, safe: false, reason: "media_popup" };
    }
    return { known: true, safe: true, modelValue, modelEntities };
  }, {
    peerId: String(expectedPeerId),
    expectedReply: expectedReplyToMessageId,
    emptyRequired: requireEmpty,
    mediaPopupAllowed: allowMediaPopup,
    approvedMessage: expectedMessage,
    runtimeWebPageAllowed: allowRuntimeCreatedWebPage,
  });
  if (state?.known && state.safe && expectedMessage !== null && !allowRuntimeCreatedEntities) {
    const authoritativeEntities = await deriveLiveWebKAutomaticEntities(page, expectedMessage);
    assertNoMutationLinkPreview(authoritativeEntities);
    if (state.modelValue !== expectedMessage
      || !automaticEntitiesExactlyMatch(authoritativeEntities, state.modelEntities)) {
      state.safe = false;
      state.reason = state.modelValue === expectedMessage ? "rich_entities" : "payload";
    }
  }
  if (!state?.known || !state.safe) {
    fail(
      "TELEGRAM_WEB_COMPOSER_CONFLICT",
      "Telegram Web composer is not pristine or its sender/reply/schedule/silent/effect state cannot be proven safe. The runtime preserved the existing draft and made no send click.",
      { conflict: state?.reason || "unknown" },
    );
  }
  return state;
};

const assertExactEditComposer = async (
  page,
  expectedPeerId,
  expectedMessageId,
  expectedMessage = null,
  { allowRuntimeCreatedEntities = false, allowRuntimeCreatedWebPage = false } = {},
) => {
  expectedPeerId = requireExactSafePeerId(expectedPeerId);
  if (!isExactPositiveSafeDecimal(expectedMessageId)) {
    fail("TELEGRAM_WEB_UI_UNSUPPORTED", "Edit composer safety requires exact peer and message identities.");
  }
  await assertOpenPeer(page, expectedPeerId);
  const state = await page.evaluate(async ({ peerId, messageId, approvedMessage, runtimeWebPageAllowed }) => {
    const chat = globalThis.appImManager?.chat;
    const input = chat?.input;
    const manager = globalThis.rootScope?.managers?.appMessagesManager;
    const liveMyId = globalThis.rootScope?.myId;
    const myId = typeof liveMyId === "number" && Number.isSafeInteger(liveMyId) && liveMyId > 0
      ? String(liveMyId)
      : "";
    const numericPeerId = Number(peerId);
    const numericMyId = Number(myId);
    if (!Number.isSafeInteger(numericPeerId)
      || numericPeerId === 0
      || !Number.isSafeInteger(numericMyId)
      || numericMyId <= 0
      || !input
      || typeof input.getReplyTo !== "function"
      || typeof input.getValueAndEntities !== "function"
      || !input.messageInput
      || typeof manager?.isAnonymousSending !== "function"
      || !/^\d{1,24}$/u.test(myId)) return { known: false };
    if (typeof chat?.peerId !== "number"
      || !Number.isSafeInteger(chat.peerId)
      || chat.peerId === 0
      || String(chat.peerId) !== peerId
      || chat?.type !== "chat"
      || chat?.isMonoforum === true) return { known: false };
    let reply;
    let anonymous;
    let effect;
    try {
      reply = await Promise.resolve(input.getReplyTo());
      anonymous = await Promise.resolve(manager.isAnonymousSending(numericPeerId));
      effect = typeof input.effect === "function" ? await Promise.resolve(input.effect()) : input.effect;
    } catch {
      return { known: false };
    }
    const editValue = input.editMsgId ?? input.editMessage;
    const editId = String(
      editValue && typeof editValue === "object"
        ? editValue.mid ?? editValue.messageId ?? editValue.id ?? ""
        : editValue ?? "",
    );
    const nonempty = (value) => value !== undefined && value !== null && value !== false && value !== "" && value !== 0 && value !== "0";
    const sendAs = input.sendAsPeerId;
    let modelValue = null;
    let modelEntities = null;
    if (approvedMessage !== null) {
      let exact;
      try {
        exact = input.getValueAndEntities(input.messageInput);
      } catch {
        return { known: false };
      }
      modelValue = exact?.value;
      modelEntities = exact?.totalEntities;
    }
    const webPageOptions = input.webPageOptions;
    const webPageOptionsSafe = webPageOptions
      && typeof webPageOptions === "object"
      && !Array.isArray(webPageOptions)
      && Object.keys(webPageOptions).length === 0;
    const savedReaction = chat.savedReaction;
    const savedReactionSafe = savedReaction === undefined
      || savedReaction === null
      || (Array.isArray(savedReaction) && savedReaction.length === 0);
    const editPeer = input.editMessage?.peerId;
    const safe = editId === messageId
      && Number.isSafeInteger(Number(editId))
      && (editPeer === undefined || editPeer === null || String(editPeer) === peerId)
      && !nonempty(input.editMessage?.media)
      && (reply === undefined || reply === null || reply === false)
      && !nonempty(input.scheduleDate)
      && !nonempty(input.scheduleRepeatPeriod)
      && !nonempty(input.sendSilent)
      && !nonempty(input.forwarding)
      && (runtimeWebPageAllowed || (
        !nonempty(input.willSendWebPage)
        && !nonempty(input.getWebPagePromise)
        && !nonempty(input.noWebPage)
        && webPageOptionsSafe
        && !nonempty(input.invertMedia)
      ))
      && !nonempty(input.suggestedPost)
      && !nonempty(effect)
      && (!nonempty(sendAs) || String(sendAs) === myId)
      && anonymous === false
      && !nonempty(input.recording)
      && savedReactionSafe;
    return {
      known: typeof anonymous === "boolean"
        && typeof chat.isAnonymousSending === "boolean"
        && chat.isAnonymousSending === anonymous
        && (approvedMessage === null || (typeof modelValue === "string" && Array.isArray(modelEntities))),
      safe,
      modelValue,
      modelEntities,
    };
  }, {
    peerId: String(expectedPeerId),
    messageId: String(expectedMessageId),
    approvedMessage: expectedMessage,
    runtimeWebPageAllowed: allowRuntimeCreatedWebPage,
  });
  if (state?.known && state.safe && expectedMessage !== null && !allowRuntimeCreatedEntities) {
    const authoritativeEntities = await deriveLiveWebKAutomaticEntities(page, expectedMessage);
    assertNoMutationLinkPreview(authoritativeEntities);
    if (state.modelValue !== expectedMessage
      || !automaticEntitiesExactlyMatch(authoritativeEntities, state.modelEntities)) state.safe = false;
  }
  if (!state?.known || !state.safe) {
    fail("TELEGRAM_WEB_COMPOSER_CONFLICT", "Telegram Web edit composer is not bound only to the exact approved message and current-account sender. No edit submit click was made.");
  }
  return state;
};

const composerRepairRequired = (originalError, accountSlot = null) => {
  const canonicalSlot = Number.isInteger(accountSlot) && accountSlot >= 1 && accountSlot <= 4
    ? accountSlot
    : null;
  fail(
    "TELEGRAM_WEB_COMPOSER_REPAIR_REQUIRED",
    canonicalSlot === null
      ? "Telegram Web made no decisive mutation click, but the runtime could not prove exact removal of only the helper/draft state it created. Open the dedicated profile through the headed inspect command and repair the composer manually before retrying."
      : `Telegram Web made no decisive mutation click, but the runtime could not prove exact removal of only the helper/draft state it created. Run inspect --account ${canonicalSlot} --hold-ms 600000, then inspect and repair the visible composer manually before retrying.`,
    {
      originalCode: originalError?.code || "TELEGRAM_WEB_UI_UNSUPPORTED",
      safeToRetry: false,
      accountSlot: canonicalSlot,
      recoveryCommand: canonicalSlot === null
        ? "inspect --account SLOT --hold-ms 600000"
        : `inspect --account ${canonicalSlot} --hold-ms 600000`,
      repairVerified: false,
    },
  );
};

/**
 * Remove only a composer state whose peer, helper target and raw payload are
 * exact consequences of this invocation.  Unknown/partial state is left in
 * place and escalated for manual repair rather than risking somebody else's
 * pre-existing draft.
 */
const clearExactRuntimeComposer = async (page, expectedPeerId, options, {
  replyToMessageId = null,
  editMessageId = null,
  allowedPayloads,
  sourceMessage = null,
  originalError,
}) => {
  try {
    await assertSelectedAccountUnchanged(page, options, "composer cleanup");
    await assertOpenPeer(page, expectedPeerId);
    let matchedPayload = null;
    for (const payload of [...new Set(allowedPayloads)]) {
      try {
        if (editMessageId) {
          await assertExactEditComposer(page, expectedPeerId, editMessageId, payload, {
            allowRuntimeCreatedEntities: true,
            allowRuntimeCreatedWebPage: true,
          });
        } else {
          await assertOutgoingComposerSafe(page, expectedPeerId, {
            expectedReplyToMessageId: replyToMessageId,
            requireEmpty: false,
            allowMediaPopup: false,
            expectedMessage: payload,
            allowRuntimeCreatedEntities: true,
            allowRuntimeCreatedWebPage: true,
          });
        }
        matchedPayload = payload;
        break;
      } catch (error) {
        if (!(error instanceof TelegramWebRuntimeError) || error.code !== "TELEGRAM_WEB_COMPOSER_CONFLICT") throw error;
      }
    }
    if (matchedPayload === null) composerRepairRequired(originalError, options.account);

    // A pristine non-reply outgoing composer needs no mutation at all.
    if (!editMessageId && !replyToMessageId && matchedPayload === "") return;
    const cleared = await page.evaluate(async ({ mustClearHelper }) => {
      const input = globalThis.appImManager?.chat?.input;
      if (!input || typeof input.clearInput !== "function" || (mustClearHelper && typeof input.clearHelper !== "function")) return false;
      try {
        if (mustClearHelper) await Promise.resolve(input.clearHelper());
        await Promise.resolve(input.clearInput());
        return true;
      } catch {
        return false;
      }
    }, { mustClearHelper: Boolean(editMessageId || replyToMessageId) });
    if (!cleared) composerRepairRequired(originalError, options.account);
    await assertOutgoingComposerSafe(page, expectedPeerId, {
      expectedReplyToMessageId: null,
      requireEmpty: true,
      allowMediaPopup: false,
      expectedMessage: "",
    });
    if (sourceMessage) {
      const source = await exactLoadedMessageDescriptor(page, sourceMessage.messageId, {
        outgoingOnly: Boolean(editMessageId),
        expectedPeerId,
      });
      if (canonicalJson(source) !== canonicalJson(sourceMessage)) composerRepairRequired(originalError, options.account);
    }
  } catch (error) {
    if (error instanceof TelegramWebRuntimeError && error.code === "TELEGRAM_WEB_COMPOSER_REPAIR_REQUIRED") throw error;
    composerRepairRequired(originalError || error, options.account);
  }
};

const assertPopupCaptionExact = async (popup, expectedMessage) => {
  const captions = popup.locator('.input-message-input[contenteditable="true"]').filter({ visible: true });
  if (await captions.count() !== 1) fail("TELEGRAM_WEB_UI_UNSUPPORTED", "Telegram attachment popup did not preserve one exact caption composer.");
  const exact = await captions.first().evaluate((node) => ({
    value: String(node.textContent || ""),
    hasRichPayload: Boolean(node.querySelector('[data-doc-id], img, video, audio, [contenteditable="false"]')),
  }));
  if (exact.value !== expectedMessage || exact.hasRichPayload) {
    fail("TELEGRAM_WEB_COMPOSER_CONFLICT", "Telegram attachment caption did not exactly match the approved plain-text payload. No attachment send click was made.");
  }
};

const DOCUMENT_POPUP_PROOF_STATE_KEY = "__trelioTelegramWebDocumentPopupProofsV1";

/**
 * Feed the immutable Node snapshot to Web K's own ChatInput file input. The
 * file chooser is armed by the official `onAttachClick(true)` document path;
 * Playwright receives bytes from the retained Buffer and never re-reads the
 * approved local path after browser launch.
 */
const selectExactDocumentSnapshot = async (page, expectedPeerId, snapshot, timeoutMs, proofToken) => {
  expectedPeerId = requireExactSafePeerId(expectedPeerId);
  if (typeof proofToken !== "string" || !/^[0-9a-f-]{36}$/iu.test(proofToken)) {
    fail("TELEGRAM_WEB_UNSAFE_STATE", "Telegram Web document selection requires one fresh runtime proof token.");
  }
  const inputMarker = `trelio-${randomUUID()}`;
  const armed = await page.evaluate(({ key, peerId, marker, token }) => {
    const chat = globalThis.appImManager?.chat;
    const input = chat?.input;
    const Popup = globalThis.PopupNewMedia;
    let popups;
    try {
      popups = typeof Popup?.getPopups === "function" ? Popup.getPopups(Popup) : null;
    } catch {
      return false;
    }
    if (typeof chat?.peerId !== "number"
      || !Number.isSafeInteger(chat.peerId)
      || String(chat.peerId) !== peerId
      || chat.type !== "chat"
      || chat.isMonoforum === true
      || !input
      || typeof input.onAttachClick !== "function"
      || !(input.fileInput instanceof HTMLInputElement)
      || input.fileInput.type !== "file"
      || input.fileInput.multiple !== true
      || !input.fileInput.isConnected
      || !Array.isArray(popups)
      || popups.length !== 0
      || document.querySelectorAll('.popup.popup-new-media.active').length !== 0) return false;
    const registry = globalThis[key] instanceof Map ? globalThis[key] : new Map();
    if (registry.has(token)) return false;
    input.fileInput.setAttribute("data-trelio-document-input", marker);
    registry.set(token, {
      phase: "armed",
      chat,
      input,
      originalFile: null,
      popup: null,
      file: null,
      digest: null,
      normalizedMimeType: null,
    });
    globalThis[key] = registry;
    return true;
  }, { key: DOCUMENT_POPUP_PROOF_STATE_KEY, peerId: expectedPeerId, marker: inputMarker, token: proofToken });
  if (!armed) {
    fail("TELEGRAM_WEB_COMPOSER_CONFLICT", "Telegram Web did not expose one pristine official document file input for the exact chat.");
  }

  let chooser;
  try {
    const chooserPromise = page.waitForEvent("filechooser", { timeout: Math.min(timeoutMs, 5_000) });
    const invoked = await page.evaluate(async ({ key, token, peerId, marker }) => {
      const chat = globalThis.appImManager?.chat;
      const input = chat?.input;
      const proof = globalThis[key]?.get?.(token);
      if (typeof chat?.peerId !== "number"
        || String(chat.peerId) !== peerId
        || proof?.phase !== "armed"
        || proof.chat !== chat
        || proof.input !== input
        || input?.fileInput?.getAttribute("data-trelio-document-input") !== marker
        || typeof input?.onAttachClick !== "function") return false;
      try {
        await Promise.resolve(input.onAttachClick(true));
        return input.willAttachType === "document"
          && input.fileInput.getAttribute("accept") === null;
      } catch {
        return false;
      }
    }, { key: DOCUMENT_POPUP_PROOF_STATE_KEY, token: proofToken, peerId: expectedPeerId, marker: inputMarker });
    if (!invoked) fail("TELEGRAM_WEB_UI_UNSUPPORTED", "Telegram Web did not arm its source-validated document attachment path.");
    chooser = await chooserPromise;
    const chooserExact = await chooser.element().then((handle) => handle.evaluate(
      (node, marker) => node.getAttribute("data-trelio-document-input") === marker,
      inputMarker,
    ));
    if (!chooserExact) fail("TELEGRAM_WEB_UI_UNSUPPORTED", "Telegram Web opened a file chooser for a different input.");
    await chooser.setFiles({
      name: snapshot.name,
      mimeType: snapshot.selectionMimeType,
      buffer: snapshot.buffer,
    });
    const boundOriginal = await page.evaluate(({ key, token, marker, expectedName, expectedSize }) => {
      const proof = globalThis[key]?.get?.(token);
      const input = proof?.input;
      const files = input?.fileInput?.files;
      // Web K clears the input value after its change handler. Depending on the
      // browser, FileList may already be empty here, so absence is acceptable;
      // if one File remains it must be the exact chooser payload.
      if (!proof || proof.phase !== "armed" || input?.fileInput?.getAttribute("data-trelio-document-input") !== marker) return false;
      if (files?.length === 1) {
        const originalFile = files[0];
        if (originalFile.name !== expectedName || originalFile.size !== expectedSize) return false;
        proof.originalFile = originalFile;
      } else if (files?.length !== 0) {
        return false;
      }
      proof.phase = "selected";
      return true;
    }, {
      key: DOCUMENT_POPUP_PROOF_STATE_KEY,
      token: proofToken,
      marker: inputMarker,
      expectedName: snapshot.name,
      expectedSize: snapshot.sizeBytes,
    });
    if (!boundOriginal) fail("TELEGRAM_WEB_INPUT_CHANGED", "Telegram Web document chooser changed the exact selected local snapshot identity.");
  } catch (error) {
    if (error instanceof TelegramWebRuntimeError) throw error;
    fail("TELEGRAM_WEB_UI_UNSUPPORTED", "Telegram Web could not accept the immutable approved document snapshot.");
  } finally {
    await page.locator(`[data-trelio-document-input="${inputMarker}"]`).evaluateAll((nodes) => {
      nodes.forEach((node) => node.removeAttribute("data-trelio-document-input"));
    }).catch(() => undefined);
  }
};

/**
 * Bind one fresh PopupNewMedia instance to one exact selected File object,
 * hash the bytes after selection, force the source-backed ungrouped document
 * option, and retain only an in-page Weak-style object proof for later bounded
 * pre-click rechecks. File bytes are immutable; later checks prove object
 * identity rather than repeatedly hashing up to 64 MiB inside the consent
 * lease.
 */
const captureExactDocumentPopup = async (page, expectedPeerId, snapshot, timeoutMs, token) => {
  expectedPeerId = requireExactSafePeerId(expectedPeerId);
  if (typeof token !== "string" || !/^[0-9a-f-]{36}$/iu.test(token)) {
    fail("TELEGRAM_WEB_UNSAFE_STATE", "Telegram Web document popup capture requires its exact selection proof token.");
  }
  try {
    await page.waitForFunction(({ peerId }) => {
      const Popup = globalThis.PopupNewMedia;
      const chat = globalThis.appImManager?.chat;
      if (typeof Popup?.getPopups !== "function"
        || typeof chat?.peerId !== "number"
        || String(chat.peerId) !== peerId) return false;
      try {
        const popups = Popup.getPopups(Popup);
        return Array.isArray(popups)
          && popups.length === 1
          && popups[0]?.chat === chat
          && popups[0]?.element?.classList?.contains("active")
          && popups[0]?.files?.length === 1
          && popups[0]?.willAttach?.sendFileDetails?.length === 1;
      } catch {
        return false;
      }
    }, { peerId: expectedPeerId }, { timeout: Math.min(timeoutMs, 10_000) });
  } catch {
    fail("TELEGRAM_WEB_UI_UNSUPPORTED", "Telegram Web did not expose one complete fresh document popup after exact file selection.");
  }
  const captured = await page.evaluate(async ({
    key,
    proofToken,
    peerId,
    expectedName,
    expectedSize,
    expectedSha256,
  }) => {
    const Popup = globalThis.PopupNewMedia;
    const chat = globalThis.appImManager?.chat;
    if (typeof Popup?.getPopups !== "function" || !chat) return { known: false };
    let popups;
    try {
      popups = Popup.getPopups(Popup);
    } catch {
      return { known: false };
    }
    if (!Array.isArray(popups) || popups.length !== 1) return { known: false };
    const registry = globalThis[key];
    const proof = registry?.get?.(proofToken);
    const popup = popups[0];
    if (!proof
      || proof.phase !== "selected"
      || proof.chat !== chat
      || proof.input !== chat?.input
      || popup.chat !== chat
      || typeof chat.peerId !== "number"
      || String(chat.peerId) !== peerId
      || !Array.isArray(popup.files)
      || popup.files.length !== 1
      || typeof popup.changeGroup !== "function") return { known: false };
    try {
      popup.changeGroup(false);
    } catch {
      return { known: false };
    }
    const file = popup.files[0];
    if (!file
      || typeof file.arrayBuffer !== "function"
      || file.name !== expectedName
      || file.size !== expectedSize
      || !(popup.convertedFiles instanceof WeakMap)
      || popup.convertedFiles.has(file)) return { known: false };
    let digest;
    try {
      const hash = await globalThis.crypto.subtle.digest("SHA-256", await file.arrayBuffer());
      digest = Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
    } catch {
      return { known: false };
    }
    if (digest !== expectedSha256) return { known: true, safe: false, reason: "selected_bytes" };
    const normalizedMimeType = String(file.type || "").toLowerCase();
    if (normalizedMimeType.startsWith("audio/")
      || normalizedMimeType === "video/ogg"
      || normalizedMimeType === "image/gif"
      || normalizedMimeType === "application/x-tgsticker"
      || file.name.toLowerCase().endsWith(".tgs")) {
      return { known: true, safe: false, reason: "semantic_media", normalizedMimeType };
    }
    popup.element?.setAttribute?.("data-trelio-document-popup", proofToken);
    popup.btnConfirm?.setAttribute?.("data-trelio-document-confirm", proofToken);
    Object.assign(proof, {
      phase: "popup",
      popup,
      file,
      digest,
      normalizedMimeType,
    });
    return {
      known: true,
      safe: true,
      normalizedMimeType,
      lastModified: Number(file.lastModified),
    };
  }, {
    key: DOCUMENT_POPUP_PROOF_STATE_KEY,
    proofToken: token,
    peerId: expectedPeerId,
    expectedName: snapshot.name,
    expectedSize: snapshot.sizeBytes,
    expectedSha256: snapshot.sha256,
  });
  if (captured?.reason === "semantic_media") {
    fail(
      "TELEGRAM_WEB_UNSUPPORTED_OPERATION",
      "Telegram Web reclassified the selected file into audio, OGG, GIF, or TGS sticker semantics instead of the approved generic document lane. Those uploads are unsupported in 1.0.2; no send click was made.",
      { operation: "semantic-document-remap", fallbackEligible: true, normalizedMimeType: captured.normalizedMimeType },
    );
  }
  if (!captured?.known || !captured.safe) {
    fail("TELEGRAM_WEB_INPUT_CHANGED", "Telegram Web selected document bytes did not exactly match the immutable approved local snapshot.");
  }
  try {
    await page.waitForFunction(({ key, proofToken }) => {
      const proof = globalThis[key]?.get?.(proofToken);
      return proof?.popup?.willAttach?.group === false
        && proof.popup.willAttach?.sendFileDetails?.length === 1
        && proof.popup.willAttach.sendFileDetails[0]?.file === proof.file;
    }, { key: DOCUMENT_POPUP_PROOF_STATE_KEY, proofToken: token }, { timeout: Math.min(timeoutMs, 5_000) });
  } catch {
    fail("TELEGRAM_WEB_UI_UNSUPPORTED", "Telegram Web did not settle one ungrouped document attachment model.");
  }
  return { token, normalizedMimeType: captured.normalizedMimeType, lastModified: captured.lastModified };
};

const assertExactDocumentPopupState = async (
  page,
  expectedPeerId,
  token,
  snapshot,
  caption,
) => {
  expectedPeerId = requireExactSafePeerId(expectedPeerId);
  const state = await page.evaluate(({
    key,
    proofToken,
    peerId,
    expectedName,
    expectedSize,
    expectedSha256,
    expectedCaption,
  }) => {
    const nonempty = (value) => value !== undefined && value !== null && value !== false && value !== "" && value !== 0 && value !== "0";
    const proof = globalThis[key]?.get?.(proofToken);
    const Popup = globalThis.PopupNewMedia;
    const chat = globalThis.appImManager?.chat;
    if (!proof || typeof Popup?.getPopups !== "function" || !chat) return { known: false };
    let popups;
    try {
      popups = Popup.getPopups(Popup);
    } catch {
      return { known: false };
    }
    if (!Array.isArray(popups) || popups.length !== 1 || popups[0] !== proof.popup) return { known: true, safe: false, reason: "popup_identity" };
    const popup = proof.popup;
    const file = proof.file;
    const details = popup.willAttach?.sendFileDetails;
    const captionField = popup.messageInputField;
    const inputNode = captionField?.input;
    let effect;
    let totalStars;
    let totalMessages;
    let canSendDocs;
    let captionModelSafe = false;
    try {
      effect = typeof popup.effect === "function" ? popup.effect() : popup.effect;
      totalStars = typeof popup.starsState?.totalStars === "function" ? popup.starsState.totalStars() : null;
      totalMessages = typeof popup.starsState?.totalMessages === "function" ? popup.starsState.totalMessages() : null;
      canSendDocs = typeof Popup.canSend === "function"
        ? Popup.canSend(chat.getMessageSendingParams())
        : null;
      const raw = globalThis.getRichValueWithCaret?.(inputNode, true, false);
      const parsed = raw && typeof globalThis.parseMarkdown === "function"
        ? globalThis.parseMarkdown(raw.value, structuredClone(raw.entities))
        : null;
      captionModelSafe = raw?.value === expectedCaption
        && Array.isArray(raw.entities)
        && raw.entities.length === 0
        && Array.isArray(parsed)
        && parsed.length === 2
        && parsed[0] === expectedCaption
        && Array.isArray(parsed[1])
        && parsed[1].length === 0;
    } catch {
      return { known: false };
    }
    const richCaption = inputNode?.querySelector?.(
      'a, b, strong, i, em, code, pre, blockquote, img, video, audio, [data-doc-id], [contenteditable="false"]',
    );
    const willAttachKeysSafe = Object.keys(popup.willAttach || {}).every((keyName) => [
      "type", "sendFileDetails", "group", "isMedia", "invertMedia", "stars",
    ].includes(keyName));
    const baseSafe = typeof chat.peerId === "number"
      && Number.isSafeInteger(chat.peerId)
      && String(chat.peerId) === peerId
      && chat.type === "chat"
      && chat.isMonoforum !== true
      && popup.chat === chat
      && popup.element?.getAttribute?.("data-trelio-document-popup") === proofToken
      && popup.element?.classList?.contains("active")
      && popup.btnConfirm?.getAttribute?.("data-trelio-document-confirm") === proofToken
      && popup.btnConfirm?.disabled === false
      && Array.isArray(popup.files)
      && popup.files.length === 1
      && popup.files[0] === file
      && proof.phase === "popup"
      && file.name === expectedName
      && file.size === expectedSize
      && typeof proof.normalizedMimeType === "string"
      && String(file.type || "").toLowerCase() === proof.normalizedMimeType
      && !proof.normalizedMimeType.startsWith("audio/")
      && proof.normalizedMimeType !== "video/ogg"
      && proof.digest === expectedSha256
      && Array.isArray(details)
      && details.length === 1
      && details[0]?.file === file
      && !nonempty(details[0]?.scaledBlob)
      && !nonempty(details[0]?.editResult)
      && !nonempty(details[0]?.mediaSpoiler)
      && !nonempty(details[0]?.spoiler)
      && !nonempty(details[0]?.isAnimated)
      && popup.willAttach.type === "document"
      && popup.willAttach.group === false
      && !nonempty(popup.willAttach.isMedia)
      && !nonempty(popup.willAttach.invertMedia)
      && !nonempty(popup.willAttach.stars)
      && willAttachKeysSafe
      && !nonempty(popup.gifDocument)
      && popup.isMediaEditorOpen !== true
      && popup.fileConversions instanceof Map
      && popup.fileConversions.size === 0
      && popup.convertedFiles instanceof WeakMap
      && popup.convertedFiles.has(file) === false
      && !nonempty(effect)
      && totalStars === 0
      && totalMessages === 1
      && captionField?.value === expectedCaption
      && inputNode instanceof HTMLElement
      && !richCaption
      && captionModelSafe
      && popup.captionLengthMax >= expectedCaption.length
      && popup.wasDraft === undefined
      && popup.ignoreInputValue !== true;
    if (!baseSafe) return { known: true, safe: false, reason: "document_options" };
    return Promise.resolve(canSendDocs).then((rights) => ({
      known: true,
      safe: rights
        && typeof rights === "object"
        && rights.send_docs === true
        && ["send_photos", "send_videos", "send_docs", "send_audios", "send_gifs"]
          .every((keyName) => typeof rights[keyName] === "boolean"),
      reason: "document_rights",
    })).catch(() => ({ known: false }));
  }, {
    key: DOCUMENT_POPUP_PROOF_STATE_KEY,
    proofToken: token,
    peerId: expectedPeerId,
    expectedName: snapshot.name,
    expectedSize: snapshot.sizeBytes,
    expectedSha256: snapshot.sha256,
    expectedCaption: caption,
  });
  if (!state?.known || !state.safe) {
    fail(
      "TELEGRAM_WEB_COMPOSER_CONFLICT",
      "Telegram Web document popup no longer matches the exact approved file, caption, free-send rights, and document-only options. No document send click was made.",
      { conflict: state?.reason || "unknown" },
    );
  }
  await assertPopupCaptionExact(
    page.locator(`[data-trelio-document-popup="${token}"]`).filter({ visible: true }),
    caption,
  );
  return state;
};

const cleanupExactDocumentPopupProof = async (page, token) => {
  await page.evaluate(({ key, proofToken }) => {
    const proof = globalThis[key]?.get?.(proofToken);
    proof?.popup?.element?.removeAttribute?.("data-trelio-document-popup");
    proof?.popup?.btnConfirm?.removeAttribute?.("data-trelio-document-confirm");
    globalThis[key]?.delete?.(proofToken);
  }, { key: DOCUMENT_POPUP_PROOF_STATE_KEY, proofToken: token }).catch(() => undefined);
};

/**
 * A failure after file selection but before the one decisive confirmation may
 * leave Web K's private media popup alive. Close it only when the sticky proof
 * still identifies the exact invocation-owned chat, popup, File bytes and sole
 * active PopupNewMedia instance. Unknown state is deliberately left visible
 * and escalated for manual repair.
 */
const clearExactRuntimeDocumentPopup = async (page, expectedPeerId, options, {
  token,
  snapshot,
  originalError,
}) => {
  try {
    await assertSelectedAccountUnchanged(page, options, "document popup cleanup");
    await assertOpenPeer(page, expectedPeerId);
    const closed = await page.evaluate(async ({
      key,
      proofToken,
      peerId,
      expectedName,
      expectedSize,
      expectedSha256,
    }) => {
      const proof = globalThis[key]?.get?.(proofToken);
      const Popup = globalThis.PopupNewMedia;
      const chat = globalThis.appImManager?.chat;
      if (!proof
        || !["armed", "selected", "popup"].includes(proof.phase)
        || proof.chat !== chat
        || proof.input !== chat?.input
        || typeof chat?.peerId !== "number"
        || !Number.isSafeInteger(chat.peerId)
        || String(chat.peerId) !== peerId
        || typeof Popup?.getPopups !== "function") return false;
      let popups;
      try {
        popups = Popup.getPopups(Popup);
      } catch {
        return false;
      }
      if (!Array.isArray(popups) || popups.length > 1) return false;
      if (popups.length === 1) {
        const popup = popups[0];
        if ((proof.popup && proof.popup !== popup)
          || popup.chat !== chat
          || !Array.isArray(popup.files)
          || popup.files.length !== 1
          || typeof popup.forceHide !== "function") return false;
        const file = popup.files[0];
        if (!file
          || typeof file.arrayBuffer !== "function"
          || file.name !== expectedName
          || file.size !== expectedSize) return false;
        let digest;
        try {
          const hash = await globalThis.crypto.subtle.digest("SHA-256", await file.arrayBuffer());
          digest = Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
        } catch {
          return false;
        }
        if (digest !== expectedSha256) return false;
        popup.element?.removeAttribute?.("data-trelio-document-popup");
        popup.btnConfirm?.removeAttribute?.("data-trelio-document-confirm");
        try {
          popup.forceHide();
        } catch {
          return false;
        }
      }
      globalThis[key].delete(proofToken);
      const fileInput = proof.input?.fileInput;
      return (!fileInput || (
        fileInput instanceof HTMLInputElement
        && fileInput.type === "file"
        && fileInput.value === ""
        && fileInput.files?.length === 0
      ));
    }, {
      key: DOCUMENT_POPUP_PROOF_STATE_KEY,
      proofToken: token,
      peerId: requireExactSafePeerId(expectedPeerId),
      expectedName: snapshot.name,
      expectedSize: snapshot.sizeBytes,
      expectedSha256: snapshot.sha256,
    });
    if (!closed) composerRepairRequired(originalError, options.account);
    await page.waitForFunction(({ key, proofToken }) => {
      const Popup = globalThis.PopupNewMedia;
      let popups;
      try {
        popups = typeof Popup?.getPopups === "function" ? Popup.getPopups(Popup) : null;
      } catch {
        return false;
      }
      return Array.isArray(popups)
        && popups.length === 0
        && !globalThis[key]?.has?.(proofToken)
        && document.querySelectorAll('.popup.popup-new-media.active').length === 0;
    }, { key: DOCUMENT_POPUP_PROOF_STATE_KEY, proofToken: token }, { timeout: Math.min(options.timeoutMs, 5_000) });
    await assertOutgoingComposerSafe(page, expectedPeerId, {
      expectedReplyToMessageId: null,
      requireEmpty: true,
      allowMediaPopup: false,
      expectedMessage: "",
    });
  } catch (error) {
    if (error instanceof TelegramWebRuntimeError && error.code === "TELEGRAM_WEB_COMPOSER_REPAIR_REQUIRED") throw error;
    composerRepairRequired(originalError || error, options.account);
  }
};

const findUniqueAction = async (menu, label) => {
  const items = menu.locator('.btn-menu-item').filter({ visible: true });
  const matches = [];
  for (let index = 0; index < await items.count(); index += 1) {
    const item = items.nth(index);
    const text = String(await item.locator('.btn-menu-item-text').first().innerText().catch(() => "")).trim();
    if (label.test(text)) matches.push(item);
  }
  if (matches.length !== 1) fail("TELEGRAM_WEB_UI_UNSUPPORTED", "The exact supported Telegram context menu did not expose one unique requested action.");
  return matches[0];
};

const clickUniqueAction = async (menu, label, timeoutMs) => {
  const action = await findUniqueAction(menu, label);
  await action.click({ timeout: timeoutMs });
};

const openNewVisiblePopup = async (page, selector, trigger, timeoutMs, label) => {
  const marker = `trelio-${randomUUID()}`;
  await page.locator(selector).evaluateAll((nodes, value) => {
    nodes.forEach((node) => node.setAttribute("data-trelio-popup-preexisting", value));
  }, marker);
  try {
    await trigger();
    await page.waitForFunction(({ popupSelector, value }) => {
      const visible = (node) => {
        const rectangle = node.getBoundingClientRect();
        const style = getComputedStyle(node);
        return rectangle.width > 1 && rectangle.height > 1 && style.display !== "none" && style.visibility !== "hidden";
      };
      const fresh = Array.from(document.querySelectorAll(popupSelector))
        .filter((node) => visible(node) && node.getAttribute("data-trelio-popup-preexisting") !== value);
      if (fresh.length !== 1) return false;
      fresh[0].setAttribute("data-trelio-popup-open", value);
      return true;
    }, { popupSelector: selector, value: marker }, { timeout: Math.min(timeoutMs, 5_000) });
  } catch {
    fail("TELEGRAM_WEB_UI_UNSUPPORTED", `Telegram Web did not open one fresh exact ${label} popup.`);
  } finally {
    await page.locator(`[data-trelio-popup-preexisting="${marker}"]`).evaluateAll((nodes) => {
      nodes.forEach((node) => node.removeAttribute("data-trelio-popup-preexisting"));
    }).catch(() => undefined);
  }
  const popup = page.locator(`${selector}[data-trelio-popup-open="${marker}"]`).filter({ visible: true });
  if (await popup.count() !== 1) fail("TELEGRAM_WEB_UI_AMBIGUOUS", `Telegram Web exposed multiple fresh ${label} popups.`);
  return popup.first();
};

const openMessageContextMenu = async (target, page, timeoutMs) => {
  if (await target.count() !== 1) fail("TELEGRAM_WEB_UI_AMBIGUOUS", "The exact Telegram message target was missing or ambiguous.");
  const marker = `trelio-${randomUUID()}`;
  const identity = await target.evaluate((node, value) => {
    node.setAttribute("data-trelio-message-menu-target", value);
    const messageNode = node.closest('[data-mid]');
    const bubble = node.closest('.bubble[data-peer-id]');
    return {
      messageId: messageNode?.getAttribute("data-mid") || null,
      peerId: bubble?.getAttribute("data-peer-id") || node.getAttribute("data-peer-id") || null,
    };
  }, marker);
  let exactIdentityPeer = null;
  try {
    exactIdentityPeer = requireExactSafePeerId(identity.peerId);
  } catch {
    // Keep the public failure below free of raw provider identifiers.
  }
  if (!isExactPositiveSafeDecimal(identity.messageId) || exactIdentityPeer === null) {
    fail("TELEGRAM_WEB_UI_UNSUPPORTED", "The Telegram message target lacked exact peer and message identities before opening its menu.");
  }
  await page.evaluate((value) => {
    document.querySelectorAll('#bubble-contextmenu.btn-menu.contextmenu')
      .forEach((node) => node.setAttribute("data-trelio-message-menu-preexisting", value));
  }, marker);
  await target.scrollIntoViewIfNeeded();
  try {
    await target.click({ button: "right", timeout: timeoutMs });
    await page.waitForFunction(({ value, messageId, peerId }) => {
      const exactTarget = document.querySelector(`[data-trelio-message-menu-target="${value}"]`);
      if (!exactTarget?.isConnected) return false;
      const currentMessage = exactTarget.closest('[data-mid]');
      const currentBubble = exactTarget.closest('.bubble[data-peer-id]');
      if (currentMessage?.getAttribute("data-mid") !== messageId || currentBubble?.getAttribute("data-peer-id") !== peerId) return false;
      const menus = Array.from(document.querySelectorAll('#bubble-contextmenu.btn-menu.contextmenu')).filter((node) => {
        const rectangle = node.getBoundingClientRect();
        const style = window.getComputedStyle(node);
        return rectangle.width > 1
          && rectangle.height > 1
          && style.display !== "none"
          && style.visibility !== "hidden"
          && node.getAttribute("data-trelio-message-menu-preexisting") !== value;
      });
      if (menus.length !== 1) return false;
      menus[0].setAttribute("data-trelio-message-menu-open", value);
      return true;
    }, { value: marker, ...identity }, { timeout: Math.min(timeoutMs, 5_000) });
  } catch {
    fail("TELEGRAM_WEB_UI_UNSUPPORTED", "Telegram Web did not open the exact supported bubble context menu.");
  } finally {
    await page.evaluate((value) => {
      document.querySelectorAll(`[data-trelio-message-menu-target="${value}"], [data-trelio-message-menu-preexisting="${value}"]`)
        .forEach((node) => {
          node.removeAttribute("data-trelio-message-menu-target");
          node.removeAttribute("data-trelio-message-menu-preexisting");
        });
    }, marker).catch(() => undefined);
  }
  const menu = page.locator(`[data-trelio-message-menu-open="${marker}"]`).filter({ visible: true });
  if (await menu.count() !== 1) fail("TELEGRAM_WEB_UI_AMBIGUOUS", "Telegram Web exposed multiple bubble context menus.");
  return menu.first();
};

const openDialogContextMenu = async (row, page, timeoutMs) => {
  if (await row.count() !== 1) fail("TELEGRAM_WEB_UI_AMBIGUOUS", "The exact Telegram dialog row was missing or ambiguous.");
  const marker = `trelio-${randomUUID()}`;
  const rowIdentity = await row.evaluate((node, value) => {
    node.setAttribute("data-trelio-dialog-menu-target", value);
    const threadValues = [
      node.getAttribute("data-thread-id"),
      node.getAttribute("data-topic-id"),
      node.getAttribute("data-monoforum-thread-id"),
      node.getAttribute("data-monoforum-topic-id"),
      node.getAttribute("data-monoforum-peer-id"),
      node.getAttribute("data-monoforum-parent-peer-id"),
    ];
    return {
      peerId: node.getAttribute("data-peer-id"),
      threaded: threadValues.some((item) => item !== null && item !== "" && item !== "0"),
    };
  }, marker);
  const { peerId } = rowIdentity;
  requireExactSafePeerId(peerId, {
    message: "The Telegram dialog row lacked an exact safe peer identity before opening its menu.",
  });
  if (rowIdentity.threaded) {
    fail("TELEGRAM_WEB_UNSUPPORTED_OPERATION", "Telegram Web forum/topic dialog actions are not supported by this chat-only runtime release.", { operation: "topic", fallbackEligible: true });
  }
  await page.evaluate((value) => {
    document.querySelectorAll('.btn-menu.contextmenu:not(#bubble-contextmenu):not(#reaction-contextmenu)')
      .forEach((node) => node.setAttribute("data-trelio-dialog-menu-preexisting", value));
  }, marker);
  try {
    await row.click({ button: "right", timeout: timeoutMs });
    await page.waitForFunction(({ value, expectedPeerId }) => {
      const target = document.querySelector(`[data-trelio-dialog-menu-target="${value}"]`);
      if (!target?.classList.contains("menu-open") || target.getAttribute("data-peer-id") !== expectedPeerId) return false;
      const liveThreadValues = [
        target.getAttribute("data-thread-id"),
        target.getAttribute("data-topic-id"),
        target.getAttribute("data-monoforum-thread-id"),
        target.getAttribute("data-monoforum-topic-id"),
        target.getAttribute("data-monoforum-peer-id"),
        target.getAttribute("data-monoforum-parent-peer-id"),
      ];
      if (liveThreadValues.some((item) => item !== null && item !== "" && item !== "0")) return false;
      const menus = Array.from(document.querySelectorAll('.btn-menu.contextmenu:not(#bubble-contextmenu):not(#reaction-contextmenu)')).filter((node) => {
        const rectangle = node.getBoundingClientRect();
        const style = window.getComputedStyle(node);
        return rectangle.width > 1
          && rectangle.height > 1
          && style.display !== "none"
          && style.visibility !== "hidden"
          && node.getAttribute("data-trelio-dialog-menu-preexisting") !== value;
      });
      if (menus.length !== 1) return false;
      menus[0].setAttribute("data-trelio-dialog-menu-open", value);
      return true;
    }, { value: marker, expectedPeerId: peerId }, { timeout: Math.min(timeoutMs, 5_000) });
  } catch {
    fail("TELEGRAM_WEB_UI_UNSUPPORTED", "Telegram Web did not open one exact supported dialog context menu.");
  } finally {
    await page.evaluate((value) => {
      document.querySelectorAll(`[data-trelio-dialog-menu-target="${value}"], [data-trelio-dialog-menu-preexisting="${value}"]`)
        .forEach((node) => {
          node.removeAttribute("data-trelio-dialog-menu-target");
          node.removeAttribute("data-trelio-dialog-menu-preexisting");
        });
    }, marker).catch(() => undefined);
  }
  const menu = page.locator(`[data-trelio-dialog-menu-open="${marker}"]`).filter({ visible: true });
  if (await menu.count() !== 1) fail("TELEGRAM_WEB_UI_AMBIGUOUS", "Telegram Web exposed multiple dialog context menus.");
  return menu.first();
};

const readMessageText = async (target) => String(await target.locator('.message').first().innerText().catch(() => ""))
  .replace(/\s+/gu, " ").trim();

const validateCanonicalInputFilePath = (file) => {
  if (typeof file !== "string"
    || !path.isAbsolute(file)
    || file !== path.resolve(file)
    || file !== path.normalize(file)
    || DISPLAY_LABEL_UNSAFE_TEST_PATTERN.test(file)) {
    fail(
      "TELEGRAM_WEB_UNSAFE_INPUT_FILE",
      "A Telegram Web input file must use one canonical absolute path without dot segments, control characters, or bidirectional controls.",
    );
  }
  const name = path.basename(file);
  const nameBytes = Buffer.byteLength(name, "utf8");
  if (!name
    || name === "."
    || name === ".."
    || name !== name.normalize("NFC")
    || name !== name.trim()
    || nameBytes < 1
    || nameBytes > 255) {
    fail(
      "TELEGRAM_WEB_UNSAFE_INPUT_FILE",
      "A Telegram Web input filename must be a normalized non-empty portable name of at most 255 UTF-8 bytes.",
    );
  }
  return file;
};

/**
 * Input approval protects content only if another OS principal cannot replace
 * either the file or an ancestor after the SHA-256 snapshot. Reuse the strict
 * publication-parent proof for the full directory chain, then prove the leaf
 * owner/mode/ACL/canonical identity separately. The runtime is currently
 * qualified only on macOS, where `replace-protected` rejects every non-owner
 * ACL grant capable of modifying or replacing the leaf.
 */
const assertTrustedInputFilePath = async (file, environment = process.env) => {
  validateCanonicalInputFilePath(file);
  await assertTrustedDownloadOutputParent(path.dirname(file), environment);
  const currentUserId = typeof process.getuid === "function" ? process.getuid() : null;
  if (!Number.isInteger(currentUserId) || currentUserId < 0) {
    fail("TELEGRAM_WEB_UNSAFE_INPUT_FILE", "The current POSIX user identity is unavailable for Telegram Web input verification.");
  }
  const before = await lstat(file).catch(() => null);
  if (!before
    || before.isSymbolicLink()
    || !before.isFile()
    || before.uid !== currentUserId
    || (before.mode & 0o022) !== 0) {
    fail(
      "TELEGRAM_WEB_UNSAFE_INPUT_FILE",
      "A Telegram Web input must be a current-user regular non-symlink file that no other principal can modify.",
    );
  }
  if (await realpath(file) !== file) {
    fail("TELEGRAM_WEB_UNSAFE_INPUT_FILE", "A Telegram Web input path must not resolve through a symlinked component.");
  }
  await assertSafeMacExtendedAcl(file, "replace-protected", before.uid);
  const after = await lstat(file).catch(() => null);
  if (!after
    || after.isSymbolicLink()
    || !after.isFile()
    || after.dev !== before.dev
    || after.ino !== before.ino
    || after.mode !== before.mode
    || after.uid !== before.uid
    || after.gid !== before.gid
    || after.size !== before.size
    || after.mtimeNs !== before.mtimeNs) {
    fail("TELEGRAM_WEB_INPUT_CHANGED", "A Telegram Web input file changed identity during path and ACL verification.");
  }
  return after;
};

const readRegularFileSnapshot = async (file, maximumBytes, environment = process.env) => {
  validateCanonicalInputFilePath(file);
  await assertOutsideManagedTelegramNamespaces(file, environment, "Telegram Web input file");
  const pathMetadata = await assertTrustedInputFilePath(file, environment);
  const flags = fsConstants.O_RDONLY | (process.platform === "win32" ? 0 : (fsConstants.O_NOFOLLOW || 0));
  let handle;
  try {
    handle = await open(file, flags);
  } catch (error) {
    if (error?.code === "ELOOP") fail("TELEGRAM_WEB_UNSAFE_INPUT_FILE", "A Telegram Web input file cannot be a symlink.");
    fail("TELEGRAM_WEB_UNSAFE_INPUT_FILE", "A Telegram Web input file could not be opened safely.");
  }
  try {
    const before = await handleStatExact(handle);
    if (
      !before.isFile()
      || before.dev !== pathMetadata.dev
      || before.ino !== pathMetadata.ino
      || before.mode !== pathMetadata.mode
      || before.uid !== pathMetadata.uid
      || before.gid !== pathMetadata.gid
      || before.mtimeNs !== pathMetadata.mtimeNs
      || before.size < 1
      || before.size > maximumBytes
    ) {
      fail("TELEGRAM_WEB_UNSAFE_INPUT_FILE", `A Telegram Web input must be a non-empty regular file up to ${maximumBytes} bytes.`);
    }
    const chunks = [];
    let totalBytes = 0;
    while (true) {
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, maximumBytes + 1 - totalBytes));
      const { bytesRead } = await handle.read(chunk, 0, chunk.byteLength, null);
      if (bytesRead === 0) break;
      totalBytes += bytesRead;
      if (totalBytes > maximumBytes) {
        fail("TELEGRAM_WEB_UNSAFE_INPUT_FILE", `A Telegram Web input must remain at or below ${maximumBytes} bytes while it is snapshotted.`);
      }
      chunks.push(chunk.subarray(0, bytesRead));
    }
    const buffer = Buffer.concat(chunks, totalBytes);
    const [after, currentPath] = await Promise.all([handleStatExact(handle), lstat(file)]);
    if (
      currentPath.isSymbolicLink()
      || !currentPath.isFile()
      || currentPath.dev !== before.dev
      || currentPath.ino !== before.ino
      || currentPath.mode !== before.mode
      || currentPath.uid !== before.uid
      || currentPath.gid !== before.gid
      || currentPath.size !== before.size
      || currentPath.mtimeNs !== before.mtimeNs
      || buffer.byteLength !== before.size
      || after.dev !== before.dev
      || after.ino !== before.ino
      || after.mode !== before.mode
      || after.uid !== before.uid
      || after.gid !== before.gid
      || after.size !== before.size
      || after.mtimeNs !== before.mtimeNs
    ) {
      fail("TELEGRAM_WEB_INPUT_CHANGED", "A Telegram Web input file changed while it was being snapshotted.");
    }
    const finalPath = await assertTrustedInputFilePath(file, environment);
    if (finalPath.dev !== before.dev
      || finalPath.ino !== before.ino
      || finalPath.mode !== before.mode
      || finalPath.uid !== before.uid
      || finalPath.gid !== before.gid
      || finalPath.size !== before.size
      || finalPath.mtimeNs !== before.mtimeNs) {
      fail("TELEGRAM_WEB_INPUT_CHANGED", "A Telegram Web input file or ancestor changed after its immutable snapshot.");
    }
    return {
      path: file,
      name: path.basename(file),
      sizeBytes: buffer.byteLength,
      sha256: sha256(buffer),
      selectionMimeType: "application/octet-stream",
      transferMode: "document",
      buffer,
    };
  } finally {
    await handle.close();
  }
};

const readOutgoingMessage = async (options) => {
  let text = options.message;
  if (options.messageFile) {
    const snapshot = await readRegularFileSnapshot(
      options.messageFile,
      MAX_MESSAGE_FILE_BYTES,
      options.approvalContext?.environment || process.env,
    );
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(snapshot.buffer);
    } catch {
      fail("TELEGRAM_WEB_INVALID_ARGUMENT", "--message-file must contain valid UTF-8 text.");
    }
  }
  if (options.files.length && text.length > MAX_CAPTION_CHARS) {
    fail("TELEGRAM_WEB_INVALID_ARGUMENT", `Message text cannot exceed ${MAX_CAPTION_CHARS} characters for an attachment caption.`);
  }
  return text;
};

const messageDescriptor = async (options) => {
  if (options.approvalRequestPrepared?.message) return options.approvalRequestPrepared.message;
  const message = await readOutgoingMessage(options);
  if (message && !message.trim()) fail("TELEGRAM_WEB_INVALID_ARGUMENT", "Telegram message text must contain at least one non-whitespace character.");
  return {
    message,
    approval: { text: message, chars: message.length, sha256: sha256(message) },
  };
};

const prepareInputFiles = async (files, environment = process.env) => {
  const snapshots = [];
  let totalBytes = 0;
  for (const file of files) {
    const snapshot = await readRegularFileSnapshot(
      file,
      MAX_UPLOAD_FILE_BYTES,
      environment,
    );
    if (snapshot.sizeBytes < 1) {
      fail("TELEGRAM_WEB_UNSAFE_INPUT_FILE", "An outbound Telegram Web document must contain at least one byte.");
    }
    totalBytes += snapshot.sizeBytes;
    if (totalBytes > MAX_UPLOAD_TOTAL_BYTES) {
      fail("TELEGRAM_WEB_UPLOAD_TOO_LARGE", `One Telegram Web operation may snapshot at most ${MAX_UPLOAD_TOTAL_BYTES} bytes in total.`);
    }
    snapshots.push(snapshot);
  }
  return snapshots;
};

const approvalFile = ({ buffer: _buffer, ...descriptor }) => descriptor;

const approvalDocumentOptions = (files) => files.length ? {
  mode: "document",
  count: 1,
  grouped: false,
  album: false,
  mediaConversion: false,
  spoiler: false,
  captionPosition: "below",
  effect: null,
  paidStars: 0,
  silent: false,
  scheduled: false,
} : null;

// These mutations discover one exact source message through a bounded number
// of provider history pages. The bound can change both what source becomes
// available and Telegram's ordinary read-state side effects, so it is part of
// the immutable user-approved operation rather than an incidental CLI knob.
const HISTORY_PAGE_BOUND_MUTATIONS = new Set(["reply", "edit", "delete"]);

const approvalScopeForCommand = (command) => command === "forget"
  ? "entire_connection_profile_all_account_slots"
  : command === "logout"
    ? "selected_account_slot"
    : null;

/**
 * Build a browser-independent request envelope before any Telegram page can be
 * restored or navigated. It binds every CLI field capable of changing the
 * destination, source discovery, or mutation payload. Full resolved chat and
 * source descriptors are still bound later; this early digest exists to make
 * a changed --chat/--pages/message fail before browser launch.
 */
const buildApprovalRequestEnvelope = async (options, prepared = {}) => {
  const environment = options.approvalContext?.environment || process.env;
  const descriptor = prepared.message
    || options.approvalRequestPrepared?.message
    || await messageDescriptor(options);
  const files = prepared.files
    || options.approvalRequestPrepared?.files
    || await prepareInputFiles(options.files, environment);
  const avatar = options.avatar
    ? (prepared.avatar
      || options.approvalRequestPrepared?.avatar
      || await readRegularFileSnapshot(options.avatar, MAX_UPLOAD_FILE_BYTES, environment))
    : null;
  // Retain the exact pre-browser snapshots for the command body. A path cannot
  // change after request validation and be re-read into a different payload
  // only after the approved destination has already been opened.
  options.approvalRequestPrepared = { message: descriptor, files, avatar };
  const normalizeRequestChat = (reference) => {
    if (!reference) return null;
    const normalized = normalizeChatReference(reference, options.account);
    return { kind: normalized.kind, value: normalized.value };
  };
  return {
    schema: "telegram-web-approval-request/v1",
    command: options.command,
    accountSlot: options.command === "forget" ? null : options.account,
    scope: approvalScopeForCommand(options.command),
    chats: options.chats.map(normalizeRequestChat),
    toChat: normalizeRequestChat(options.toChat),
    contactUsername: options.contact ? normalizeUsername(options.contact) : null,
    members: options.members.map((member) => normalizeUsername(member, "--member")),
    messageId: options.messageId || null,
    historyPages: options.pages,
    timeoutMs: options.timeoutMs,
    holdMs: options.holdMs,
    // Login/logout are protected owner handoffs and force headed Chrome even
    // when the parsed default is false. Bind the effective surface so a normal
    // dry-run clone and its raw confirm invocation canonicalize identically.
    headed: ["login", "logout"].includes(options.command) ? true : options.headed,
    deleteScope: options.deleteScope || null,
    reaction: options.reaction || null,
    title: options.title || null,
    message: descriptor.approval,
    files: files.map(approvalFile),
    documentOptions: approvalDocumentOptions(files),
    avatar: avatar ? approvalFile(avatar) : null,
  };
};

const ensureApprovalRequestDigest = async (options, prepared = null) => {
  const existing = String(options.approvalRequestDigest || "");
  if (/^[0-9a-f]{64}$/u.test(existing) && !prepared) return existing;
  const digest = sha256(canonicalJson(await buildApprovalRequestEnvelope(options, prepared || {})));
  if (/^[0-9a-f]{64}$/u.test(existing) && existing !== digest) {
    fail("TELEGRAM_WEB_SOURCE_CHANGED", "The Telegram Web mutation payload changed between its pre-browser request proof and resolved dry-run operation.");
  }
  options.approvalRequestDigest = digest;
  return digest;
};

export const runtimeApprovalIdentityBinding = (identity) => sha256(canonicalJson({
  schema: "telegram-web-runtime-identity/v1",
  skillId: identity.skillId,
  runtimeVersion: identity.runtimeVersion,
  companyId: identity.companyId,
  memberId: identity.memberId,
  connectionId: identity.connectionId,
}));

const buildApprovalOperation = async (options, resolved = {}, prepared = {}) => {
  const descriptor = prepared.message || await messageDescriptor(options);
  const environment = options.approvalContext?.environment || process.env;
  const files = prepared.files || await prepareInputFiles(options.files, environment);
  const avatar = options.avatar
    ? (prepared.avatar || await readRegularFileSnapshot(options.avatar, MAX_UPLOAD_FILE_BYTES, environment))
    : null;
  const historyPages = HISTORY_PAGE_BOUND_MUTATIONS.has(options.command)
    ? options.pages
    : null;
  if (historyPages !== null && (!Number.isInteger(historyPages) || historyPages < 1 || historyPages > MAX_HISTORY_PAGES)) {
    fail("TELEGRAM_WEB_INVALID_ARGUMENT", "Telegram Web approval requires the exact bounded history page count.");
  }
  return {
    command: options.command,
    scope: approvalScopeForCommand(options.command),
    // Every account-bound mutation preview names the safe canonical slot so a
    // human can distinguish Saved Messages and identical chat titles across a
    // multi-account profile. Forget alone covers all slots and therefore uses
    // null. Raw Telegram ids and account digests never enter this envelope.
    accountSlot: options.command === "forget" ? null : options.account,
    chat: resolved.chat ? publicChat(resolved.chat) : null,
    toChat: resolved.toChat ? publicChat(resolved.toChat) : null,
    contact: resolved.contact ? publicChat(resolved.contact) : null,
    contactUsername: options.command === "create-direct" && options.contact
      ? normalizeUsername(options.contact)
      : null,
    members: resolved.members?.map((member) => publicChat(member)) || [],
    messageId: options.messageId || null,
    historyPages,
    deleteScope: options.deleteScope || null,
    sourceMessage: resolved.sourceMessage
      ? publicMessage(resolved.sourceMessage, resolved.chat || resolved.sourceChat)
      : null,
    message: descriptor.approval,
    reaction: options.reaction || null,
    title: options.title || null,
    files: files.map(approvalFile),
    documentOptions: approvalDocumentOptions(files),
    avatar: avatar ? approvalFile(avatar) : null,
  };
};

const approvalBindings = (options, operation) => {
  const runtimeIdentityBinding = String(options.runtimeIdentityBinding || "");
  if (!/^[0-9a-f]{64}$/u.test(runtimeIdentityBinding)) {
    fail("TELEGRAM_WEB_INVALID_IDENTITY", "Telegram Web approval identity binding is missing or invalid.");
  }
  const accountDigest = String(options.currentAccountDigest || "");
  const accountRequired = operation.command !== "forget";
  if (accountRequired && !/^[0-9a-f]{64}$/u.test(accountDigest)) {
    fail("TELEGRAM_WEB_ACCOUNT_ID_INVALID", "Telegram Web approval requires the exact current account binding.");
  }
  return {
    runtimeIdentityBinding,
    accountBinding: accountRequired ? sha256(`telegram-web-approval-account/v1\0${accountDigest}`) : null,
    // Forget intentionally ignores the selected slot because its visible,
    // exact scope is every slot in this one connection profile.
    accountSlot: accountRequired ? options.account : null,
    scope: operation.scope,
  };
};

const createApprovalMaterial = async (
  options,
  resolved = {},
  prepared = {},
  now = new Date(),
  nonce = randomBytes(32).toString("hex"),
) => {
  const operation = await buildApprovalOperation(options, resolved, prepared);
  const bindings = approvalBindings(options, operation);
  if (!/^[0-9a-f]{64}$/u.test(nonce)) fail("TELEGRAM_WEB_UNSAFE_STATE", "Telegram Web approval nonce generation failed.");
  const issuedAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + APPROVAL_TTL_MS).toISOString();
  const operationDigest = sha256(canonicalJson(operation));
  const requestDigest = await ensureApprovalRequestDigest(options, prepared);
  const nonceDigest = sha256(`telegram-web-approval-nonce/v1\0${nonce}`);
  const approvalHash = sha256(canonicalJson({
    schema: "telegram-web-mutation/v3",
    operationDigest,
    requestDigest,
    ...bindings,
    issuedAt,
    expiresAt,
    nonceDigest,
  }));
  return {
    operation,
    approvalHash,
    record: {
      schema: "telegram-web-pending-approval/v2",
      approvalHash,
      operationDigest,
      requestDigest,
      runtimeIdentityBinding: bindings.runtimeIdentityBinding,
      accountBinding: bindings.accountBinding,
      accountSlot: bindings.accountSlot,
      scope: bindings.scope,
      nonceDigest,
      issuedAt,
      expiresAt,
    },
  };
};

const publicApprovalPreview = ({ operation, approvalHash, record }) => ({
  ok: true,
  dryRun: true,
  confirmationRequired: true,
  accountSlot: operation.accountSlot,
  operation,
  approvalHash,
  expiresAt: record.expiresAt,
  oneUse: true,
  execute: "Repeat the exact command once with --confirm --approval-hash HASH instead of --dry-run.",
});

export const buildMutationPreview = async (options, resolved = {}, prepared = {}) => (
  publicApprovalPreview(await createApprovalMaterial(options, resolved, prepared))
);

const approvalRecordValidShape = (record) => Boolean(
  record
  && typeof record === "object"
  && !Array.isArray(record)
  && Object.keys(record).sort().join(",") === [
    "accountBinding", "accountSlot", "approvalHash", "expiresAt", "issuedAt",
    "nonceDigest", "operationDigest", "requestDigest", "runtimeIdentityBinding", "schema", "scope",
  ].sort().join(",")
  && record.schema === "telegram-web-pending-approval/v2"
  && [record.approvalHash, record.operationDigest, record.requestDigest, record.runtimeIdentityBinding, record.nonceDigest]
    .every((value) => /^[0-9a-f]{64}$/u.test(String(value || "")))
  && (record.accountBinding === null || /^[0-9a-f]{64}$/u.test(String(record.accountBinding)))
  && (record.accountSlot === null || (Number.isInteger(record.accountSlot) && record.accountSlot >= 1 && record.accountSlot <= 4))
  && (record.scope === null || typeof record.scope === "string")
  && typeof record.issuedAt === "string"
  && typeof record.expiresAt === "string"
  && Number.isFinite(Date.parse(record.issuedAt))
  && Number.isFinite(Date.parse(record.expiresAt))
  && new Date(Date.parse(record.issuedAt)).toISOString() === record.issuedAt
  && new Date(Date.parse(record.expiresAt)).toISOString() === record.expiresAt
);

const approvalHashFromRecord = (record) => sha256(canonicalJson({
  schema: "telegram-web-mutation/v3",
  operationDigest: record.operationDigest,
  requestDigest: record.requestDigest,
  runtimeIdentityBinding: record.runtimeIdentityBinding,
  accountBinding: record.accountBinding,
  accountSlot: record.accountSlot,
  scope: record.scope,
  issuedAt: record.issuedAt,
  expiresAt: record.expiresAt,
  nonceDigest: record.nonceDigest,
}));

const approvalContext = (options) => {
  const context = options.approvalContext;
  if (!context?.pendingApprovalFile || !context?.configHome || !context?.environment) {
    fail("TELEGRAM_WEB_UNSAFE_STATE", "Telegram Web approval storage context is missing.");
  }
  return context;
};

const validatePendingApprovalRequest = async (options, now = new Date()) => {
  const context = approvalContext(options);
  const record = await readBoundedJson(context.pendingApprovalFile, 16 * 1024, null);
  if (!approvalRecordValidShape(record)) {
    fail("TELEGRAM_WEB_APPROVAL_REQUIRED", "No valid one-use Telegram Web approval is pending. Run the exact command with --dry-run first.");
  }
  const expectedRequestDigest = await ensureApprovalRequestDigest(options);
  const expectedRuntimeBinding = String(options.runtimeIdentityBinding || "");
  const expectedScope = approvalScopeForCommand(options.command);
  const expectedSlot = options.command === "forget" ? null : options.account;
  const issuedAtMs = Date.parse(record.issuedAt);
  const expiresAtMs = Date.parse(record.expiresAt);
  if (record.approvalHash !== options.approvalHash
    || approvalHashFromRecord(record) !== record.approvalHash
    || record.requestDigest !== expectedRequestDigest
    || record.runtimeIdentityBinding !== expectedRuntimeBinding
    || record.accountSlot !== expectedSlot
    || record.scope !== expectedScope) {
    fail("TELEGRAM_WEB_APPROVAL_MISMATCH", "The one-use Telegram Web approval does not match this exact pre-browser request, account slot, runtime, or connection.");
  }
  if (
    expiresAtMs <= now.getTime()
    || issuedAtMs > now.getTime() + 5_000
    || expiresAtMs !== issuedAtMs + APPROVAL_TTL_MS
  ) {
    fail("TELEGRAM_WEB_APPROVAL_EXPIRED", "The one-use Telegram Web approval expired. Run the exact command with --dry-run again.");
  }
  return record;
};

const validatePendingApproval = async (options, operation, now = new Date()) => {
  const record = await validatePendingApprovalRequest(options, now);
  const bindings = approvalBindings(options, operation);
  if (
    record.operationDigest !== sha256(canonicalJson(operation))
    || record.runtimeIdentityBinding !== bindings.runtimeIdentityBinding
    || record.accountBinding !== bindings.accountBinding
    || record.accountSlot !== bindings.accountSlot
    || record.scope !== bindings.scope
  ) {
    fail("TELEGRAM_WEB_APPROVAL_MISMATCH", "The one-use Telegram Web approval does not match this exact operation, account slot, account, runtime, or connection.");
  }
  return record;
};

/**
 * Reject a changed approved mutation before persistent Chrome is launched.
 * Full account/resolved-source validation still runs inside the browser, but
 * no changed destination or history bound may be opened merely to discover
 * that its approval hash belongs to another request.
 */
const preflightContentMutationApproval = async (identity, options, environment = process.env) => {
  if (!MUTATING_COMMANDS.has(options.command)) return;
  const { sendMode } = await loadPolicy(identity, environment);
  if (sendMode === "read-only") {
    fail("TELEGRAM_WEB_READ_ONLY", "Local Telegram Web policy is read-only; mutations are disabled.");
  }
  if (sendMode === "autonomous" && !identity.allowAutonomous) {
    fail("TELEGRAM_WEB_AUTONOMOUS_FORBIDDEN", "The company connection forbids autonomous Telegram Web mutations.");
  }
  const explicitlyUsingApproval = options.dryRun || options.confirm || Boolean(options.approvalHash);
  const approvalRequired = STRUCTURAL_COMMANDS.has(options.command)
    || (options.command === "send" && options.files.length === 1)
    || sendMode === "confirm"
    || explicitlyUsingApproval;
  if (!approvalRequired) return;
  await ensureApprovalRequestDigest(options);
  if (options.dryRun) return;
  if (!options.confirm || !options.approvalHash) {
    fail("TELEGRAM_WEB_APPROVAL_REQUIRED", "This Telegram Web mutation requires a fresh --dry-run followed by exact --confirm --approval-hash.");
  }
  await validatePendingApprovalRequest(options);
};

const consumePendingApproval = async (options, operation, dependencies = {}) => {
  const context = approvalContext(options);
  const record = await validatePendingApproval(options, operation);
  const metadata = await lstat(context.pendingApprovalFile);
  const claim = `${context.pendingApprovalFile}.consume-${record.nonceDigest}-${randomUUID()}`;
  try {
    await dependencies.beforeAtomicRename?.();
    // rename is the single linearization point: it atomically removes exactly
    // one current pending leaf and moves it to our unique private claim. A new
    // dry-run written after this point remains at `pendingApprovalFile` and is
    // never unlinked by this consumer.
    await rename(context.pendingApprovalFile, claim).catch((error) => {
      if (error?.code === "ENOENT" || error?.code === "EEXIST") {
        fail("TELEGRAM_WEB_APPROVAL_ALREADY_USED", "The one-use Telegram Web approval was already consumed or replaced.");
      }
      throw error;
    });
    const claimed = await lstat(claim);
    if (claimed.dev !== metadata.dev || claimed.ino !== metadata.ino) {
      fail("TELEGRAM_WEB_APPROVAL_ALREADY_USED", "The one-use Telegram Web approval changed before consumption.");
    }
    const claimedRecord = await readBoundedJson(claim, 16 * 1024, null);
    if (canonicalJson(claimedRecord) !== canonicalJson(record)) {
      fail("TELEGRAM_WEB_APPROVAL_ALREADY_USED", "The one-use Telegram Web approval changed before consumption.");
    }
  } finally {
    await rm(claim, { force: true }).catch(() => undefined);
  }
};

const issuePendingApproval = async (options, resolved, prepared) => {
  const context = approvalContext(options);
  const material = await createApprovalMaterial(options, resolved, prepared);
  await writePrivateJson(context.pendingApprovalFile, material.record, context.configHome, context.environment);
  return publicApprovalPreview(material);
};

const assertStructuralApproval = async (options, resolved, prepared = {}) => {
  const operation = await buildApprovalOperation(options, resolved, prepared);
  if (options.dryRun) return issuePendingApproval(options, resolved, prepared);
  if (!options.confirm || !options.approvalHash) {
    fail("TELEGRAM_WEB_APPROVAL_REQUIRED", "Structural Telegram Web mutation requires a fresh --dry-run followed by exact --confirm --approval-hash.");
  }
  await validatePendingApproval(options, operation);
  options.pendingApprovalOperation = operation;
  return null;
};

const consumeStructuralApproval = async (options) => {
  if (!options.pendingApprovalOperation) return;
  const operation = options.pendingApprovalOperation;
  // Clear first: one invocation must never attempt the same decisive action
  // twice even when consumption itself discovers replacement or expiry.
  options.pendingApprovalOperation = null;
  await consumePendingApproval(options, operation);
};

const assertSelectedAccountUnchanged = async (page, options, stage = "operation") => {
  const currentDigest = await readCurrentTelegramAccountDigest(page, options.account);
  if (currentDigest !== options.currentAccountDigest) {
    fail("TELEGRAM_WEB_ACCOUNT_CHANGED", `The active Telegram account changed during the approved ${stage}.`);
  }
  return currentDigest;
};

/**
 * Central fail-closed gate for every decisive chat mutation.  It binds the
 * selected Telegram account and the visible/model chat to the exact approved
 * peer, and excludes every non-normal ChatType plus topic/monoforum state.
 */
const assertMutationSurface = async (page, expectedPeerId, options, stage = "mutation") => {
  const currentDigest = await assertSelectedAccountUnchanged(page, options, stage);
  if (!options.runtimeIdentityObject) fail("TELEGRAM_WEB_INVALID_IDENTITY", "Telegram Web mutation consent binding is missing.");
  await requireValidConsent(options.runtimeIdentityObject, currentDigest, options.approvalContext.environment);
  await assertOpenPeer(page, expectedPeerId);
};

/**
 * Capture only synchronously available Web K identity/surface state.  In
 * particular this final lease snapshot never awaits AccountController,
 * IndexedDB, Telegram managers, or the network.  page.waitForFunction supplies
 * a native hard timeout, so a navigation or wedged renderer cannot hold the
 * consent lock beyond the revoke deadline and later resume into a click.
 */
const readBoundedDecisiveSurface = async (page, expectedPeerId, options, stage) => {
  const exactPeerId = requireExactSafePeerId(expectedPeerId);
  let handle;
  try {
    handle = await page.waitForFunction(({ expectedSlot }) => {
      const visible = (node) => {
        const rectangle = node.getBoundingClientRect();
        const style = globalThis.getComputedStyle(node);
        return rectangle.width > 1
          && rectangle.height > 1
          && style.display !== "none"
          && style.visibility !== "hidden";
      };
      let currentAccount = null;
      let locationValid = false;
      try {
        const rawHref = String(globalThis.location.href || "");
        const canonical = /^https:\/\/web\.telegram\.org\/k\/(?:\?account=([2-4]))?(?:#(-?\d{1,24}))?$/u.exec(rawHref);
        // This intentionally implements the runtime's strict canonical subset
        // of Web K slot URLs, not upstream's permissive parseInt fallback:
        // absent means slot 1; only one exact canonical raw URL is accepted.
        currentAccount = canonical
          ? canonical[1] === undefined ? 1 : Number(canonical[1])
          : null;
        const peerCanonical = canonical?.[2] === undefined || (
          Number.isSafeInteger(Number(canonical[2]))
          && Number(canonical[2]) !== 0
          && String(Number(canonical[2])) === canonical[2]
        );
        locationValid = Boolean(canonical)
          && peerCanonical
          && currentAccount === expectedSlot;
      } catch {
        locationValid = false;
      }
      const peerIds = [...new Set(Array.from(globalThis.document?.querySelectorAll(
        '.chat-info .peer-title[data-peer-id], .chat.topbar .peer-title[data-peer-id]',
      ) || []).filter(visible).map((node) => node.getAttribute("data-peer-id")))];
      const chat = globalThis.appImManager?.chat;
      const nonemptyThread = (value) => value !== undefined && value !== null && value !== "" && value !== 0 && value !== "0";
      const rootId = globalThis.rootScope?.myId;
      const chatPeerId = chat?.peerId;
      return {
        rootId: typeof rootId === "number" && Number.isSafeInteger(rootId) && rootId > 0 ? String(rootId) : null,
        currentAccount,
        locationValid,
        peerIds,
        chatPeerId: typeof chatPeerId === "number" && Number.isSafeInteger(chatPeerId) && chatPeerId !== 0
          ? String(chatPeerId)
          : null,
        chatType: String(chat?.type ?? ""),
        threaded: nonemptyThread(chat?.threadId) || nonemptyThread(chat?.monoforumThreadId),
        monoforum: chat?.isMonoforum === true,
      };
    }, {
      expectedSlot: options.account,
    }, { timeout: CONSENT_LEASE_SURFACE_TIMEOUT_MS });
  } catch {
    fail(
      "TELEGRAM_WEB_UI_UNSUPPORTED",
      `Telegram Web could not complete the bounded final ${stage} surface snapshot before the consent lease deadline.`,
    );
  }
  const state = await handle.jsonValue();
  if (!state?.locationValid || !isExactPositiveSafeDecimal(state.rootId)) {
    fail("TELEGRAM_WEB_ACCOUNT_CHANGED", `The active Telegram account changed during the approved ${stage}.`);
  }
  const currentDigest = accountDigestFromTelegramUserId(state.rootId);
  if (currentDigest !== options.currentAccountDigest) {
    fail("TELEGRAM_WEB_ACCOUNT_CHANGED", `The active Telegram account changed during the approved ${stage}.`);
  }
  if (!Array.isArray(state.peerIds) || state.peerIds.length !== 1
    || requireExactSafePeerId(state.peerIds[0], {
      code: "TELEGRAM_WEB_CHAT_MISMATCH",
      message: "Telegram Web topbar changed to an unsafe or inexact peer before the decisive action.",
    }) !== exactPeerId
    || requireExactSafePeerId(state.chatPeerId, {
      code: "TELEGRAM_WEB_CHAT_MISMATCH",
      message: "Telegram Web model changed to an unsafe or inexact peer before the decisive action.",
    }) !== exactPeerId) {
    fail("TELEGRAM_WEB_CHAT_MISMATCH", "Telegram Web changed chat before the decisive action.");
  }
  if (state.chatType !== "chat" || state.threaded || state.monoforum) {
    fail(
      "TELEGRAM_WEB_UNSUPPORTED_OPERATION",
      "Telegram Web changed from the exact normal chat to a scheduled, topic, monoforum, or other unsupported surface before the decisive action.",
      { operation: "non-chat-surface", fallbackEligible: true },
    );
  }
  return { currentDigest, peerId: exactPeerId };
};

const withValidConsentLease = async (page, expectedPeerId, options, stage, callback) => {
  const identity = options.runtimeIdentityObject;
  const environment = options.approvalContext.environment;
  if (!identity) fail("TELEGRAM_WEB_INVALID_IDENTITY", "Telegram Web operation consent binding is missing.");
  options.commandLifecycle?.assertActive(`final ${stage} consent lease`);
  return acquireConsentStateLock(identity, async () => {
    options.commandLifecycle?.assertActive(`final ${stage} consent lease`);
    const { currentDigest } = await readBoundedDecisiveSurface(page, expectedPeerId, options, stage);
    const consent = await renderConsentStatusUnlocked(identity, currentDigest, new Date(), environment);
    assertConsentStatusValid(consent);
    return callback(CONSENT_LEASE_CLICK_TIMEOUT_MS);
  }, environment);
};

const assertNoPaidMessageCost = async (page, expectedPeerId, { corroborateOpenChat = true } = {}) => {
  expectedPeerId = requireExactSafePeerId(expectedPeerId);
  const result = await page.evaluate(async ({ peerId, corroborate }) => {
    const manager = globalThis.rootScope?.managers?.appPeersManager;
    if (typeof manager?.getStarsAmount !== "function") return { known: false };
    const numericPeerId = Number(peerId);
    if (!Number.isSafeInteger(numericPeerId) || numericPeerId === 0) return { known: false };
    let managerAmount;
    try {
      managerAmount = await Promise.resolve(manager.getStarsAmount(numericPeerId));
    } catch {
      return { known: false };
    }
    // Web K's paid-message interceptors deliberately return `undefined` for
    // an ordinary free destination. A fulfilled undefined is therefore the
    // exact official zero representation; null/malformed/rejected remain
    // unknown and fail closed.
    if (managerAmount === undefined) managerAmount = 0;
    if (typeof managerAmount !== "number" || !Number.isFinite(managerAmount) || managerAmount < 0) return { known: false };
    if (corroborate) {
      const chat = globalThis.appImManager?.chat;
      if (typeof chat?.peerId !== "number"
        || !Number.isSafeInteger(chat.peerId)
        || chat.peerId === 0
        || String(chat.peerId) !== peerId) return { known: false };
      if (chat?.starsAmount !== undefined) {
        const chatAmount = chat.starsAmount;
        if (!Number.isFinite(chatAmount) || chatAmount < 0 || chatAmount !== managerAmount) return { known: false };
      }
    }
    return { known: true, amount: managerAmount };
  }, { peerId: String(expectedPeerId), corroborate: corroborateOpenChat });
  if (!result?.known || result.amount !== 0) {
    fail(
      "TELEGRAM_WEB_UNSUPPORTED_OPERATION",
      "Telegram Web could not prove that sending to the exact destination costs zero Telegram Stars. Paid messages and every payment side effect are unsupported; no send click was made.",
      { operation: "paid-message", fallbackEligible: true },
    );
  }
};

const assertLiveSingleMessageLimit = async (page, message) => {
  if (typeof message !== "string" || !message.trim()) {
    fail("TELEGRAM_WEB_INVALID_ARGUMENT", "Telegram message text must be a non-empty string.");
  }
  const liveLimit = await page.evaluate(async () => {
    const manager = globalThis.rootScope?.managers?.apiManager;
    if (typeof manager?.getConfig !== "function") return null;
    try {
      const config = await Promise.resolve(manager.getConfig());
      return config?.message_length_max;
    } catch {
      return null;
    }
  });
  if (!Number.isSafeInteger(liveLimit) || liveLimit < 1 || liveLimit > 1_000_000) {
    fail("TELEGRAM_WEB_UI_UNSUPPORTED", "Telegram Web did not expose one valid live message_length_max before composer preparation.");
  }
  // JavaScript String.length is the same UTF-16 unit count used by Web K's
  // splitStringByLength preflight, including astral characters counting as 2.
  if (message.length > liveLimit) {
    fail(
      "TELEGRAM_WEB_UNSUPPORTED_OPERATION",
      "The approved text exceeds Telegram Web's live single-message limit. Automatic splitting into several sends is unsupported.",
      { operation: "message-splitting", fallbackEligible: true, liveLimit, utf16Length: message.length },
    );
  }
  return liveLimit;
};

/**
 * Re-run the exact production Web K text transform without touching the real
 * composer.  Dry-runs use a detached plain-text field; the final pre-click
 * call uses the actual composer and additionally proves that its raw rich
 * entities are exactly the ones that parseMarkdown will send.
 */
const assertExactProductionTextPayload = async (page, expectedPeerId, approvedMessage, {
  useComposer = false,
} = {}) => {
  await assertOpenPeer(page, expectedPeerId);
  const state = await page.evaluate(({ peerId, approved, fromComposer }) => {
    const chat = globalThis.appImManager?.chat;
    const input = chat?.input;
    const getRich = globalThis.getRichValueWithCaret;
    const parse = globalThis.parseMarkdown;
    if (typeof chat?.peerId !== "number"
      || !Number.isSafeInteger(chat.peerId)
      || chat.peerId === 0
      || String(chat.peerId) !== peerId
      || chat?.type !== "chat"
      || chat?.isMonoforum === true
      || typeof getRich !== "function"
      || typeof parse !== "function"
      || (fromComposer && !input?.messageInput)) return { known: false };

    let field = input?.messageInput;
    let detached = null;
    try {
      if (!fromComposer) {
        detached = document.createElement("div");
        detached.contentEditable = "true";
        detached.setAttribute("aria-hidden", "true");
        detached.style.position = "fixed";
        detached.style.left = "-100000px";
        detached.style.top = "-100000px";
        detached.textContent = approved;
        document.body.append(detached);
        field = detached;
      }
      const raw = getRich(field, true, false);
      if (!raw || typeof raw.value !== "string" || !Array.isArray(raw.entities)) return { known: false };
      const originalEntities = structuredClone(raw.entities);
      const parserInput = structuredClone(raw.entities);
      const transformed = parse(raw.value, parserInput);
      if (!Array.isArray(transformed)
        || transformed.length !== 2
        || typeof transformed[0] !== "string"
        || !Array.isArray(transformed[1])) return { known: false };
      return {
        known: true,
        rawValue: raw.value,
        rawEntities: originalEntities,
        wireText: transformed[0],
        wireEntities: transformed[1],
      };
    } catch {
      return { known: false };
    } finally {
      detached?.remove();
    }
  }, { peerId: String(expectedPeerId), approved: approvedMessage, fromComposer: useComposer });
  if (!state?.known) {
    fail("TELEGRAM_WEB_UI_UNSUPPORTED", "Telegram Web did not expose one trustworthy production text-transform path.");
  }
  const botCommand = state.wireEntities.some((entity) => entity?._ === "messageEntityBotCommand")
    || (!useComposer && /(?:^|\n)\/[A-Za-z0-9_]+(?:@[A-Za-z0-9_]+)?(?:\s|$)/u.test(approvedMessage));
  if (botCommand) {
    fail(
      "TELEGRAM_WEB_UNSUPPORTED_OPERATION",
      "Telegram Web recognized a bot command that can trigger bot-side actions. Bot-command sends are unsupported in the 1.0.2 runtime; no approval or send click was made.",
      { operation: "bot-command", fallbackEligible: true },
    );
  }
  const authoritativeEntities = await deriveLiveWebKAutomaticEntities(page, approvedMessage);
  assertNoMutationLinkPreview(authoritativeEntities);
  if (state.rawValue !== approvedMessage
    || state.wireText !== approvedMessage
    || canonicalJson(state.rawEntities) !== canonicalJson(state.wireEntities)
    || !automaticEntitiesAreExactSubset(authoritativeEntities, state.wireEntities)) {
    fail(
      "TELEGRAM_WEB_UNSUPPORTED_OPERATION",
      "Telegram Web would trim or transform the exact approved plain text, or add rich/target-bearing entities. Markdown and transformed rich text are unsupported; no mutation click was made.",
      { operation: "rich-text-transform", fallbackEligible: true },
    );
  }
  return state;
};

/**
 * Document captions use the narrowest safe 1.0.2 lane: exact plain text whose
 * live Web K parser produces no entity at all. This excludes links, mentions,
 * hashtags, bot commands, emoji entities and every hidden target before local
 * bytes are even selected into the provider UI.
 */
const assertEntityFreeDocumentCaption = async (page, expectedPeerId, caption) => {
  const transformed = await assertExactProductionTextPayload(page, expectedPeerId, caption);
  const automatic = await deriveLiveWebKAutomaticEntities(page, caption);
  if (transformed.rawEntities.length !== 0
    || transformed.wireEntities.length !== 0
    || automatic.length !== 0) {
    fail(
      "TELEGRAM_WEB_UNSUPPORTED_OPERATION",
      "Telegram Web document captions that produce mentions, links, bot commands, emoji, formatting, or any other entity are unsupported in 1.0.2; no file selection or send click was made.",
      { operation: "document-caption-entities", fallbackEligible: true },
    );
  }
  return transformed;
};

/** Match the hidden sendText branches which can turn text into media or send
 * to a migrated peer. Both are checked before approval and immediately before
 * the decisive send click. */
const assertExactTextSendDestination = async (page, expectedPeerId, approvedMessage) => {
  await assertOpenPeer(page, expectedPeerId);
  const state = await page.evaluate(async ({ peerId, approved }) => {
    const peers = globalThis.rootScope?.managers?.appPeersManager;
    const api = globalThis.rootScope?.managers?.apiManager;
    const numericPeerId = Number(peerId);
    if (!Number.isSafeInteger(numericPeerId)
      || numericPeerId === 0
      || typeof peers?.getPeerMigratedTo !== "function"
      || typeof api?.getAppConfig !== "function") return { known: false };
    try {
      const migrated = await Promise.resolve(peers.getPeerMigratedTo(numericPeerId));
      const appConfig = await Promise.resolve(api.getAppConfig());
      const dice = appConfig?.emojies_send_dice;
      if (dice !== undefined && (!Array.isArray(dice) || dice.some((item) => typeof item !== "string"))) {
        return { known: false };
      }
      const migratedAbsent = migrated === undefined || migrated === null || migrated === false || migrated === 0;
      const migratedPeerId = migratedAbsent ? null : String(migrated);
      return {
        known: migratedPeerId === null || (
          typeof migrated === "number"
          && Number.isSafeInteger(migrated)
          && migrated !== 0
          && String(migrated) === migratedPeerId
        ),
        migratedPeerId,
        dice: Array.isArray(dice) && dice.includes(approved.trim()),
      };
    } catch {
      return { known: false };
    }
  }, { peerId: String(expectedPeerId), approved: approvedMessage });
  if (!state?.known) {
    fail("TELEGRAM_WEB_UI_UNSUPPORTED", "Telegram Web did not expose trustworthy live dice-media and migrated-peer send preflights.");
  }
  if (state.dice) {
    fail(
      "TELEGRAM_WEB_UNSUPPORTED_OPERATION",
      "Telegram Web would convert the approved text into inputMediaDice. Dice-media sends are unsupported; no send click was made.",
      { operation: "dice-media", fallbackEligible: true },
    );
  }
  if (state.migratedPeerId !== null && state.migratedPeerId !== String(expectedPeerId)) {
    fail(
      "TELEGRAM_WEB_UNSUPPORTED_OPERATION",
      "Telegram Web would redirect the approved send to a migrated peer instead of the exact selected destination. No send click was made.",
      { operation: "migrated-peer-send", fallbackEligible: true },
    );
  }
};

const mutationAmbiguous = (message) => fail(
  "TELEGRAM_WEB_MUTATION_OUTCOME_AMBIGUOUS",
  `${message} Do not retry automatically or through telegram-mtproto. Re-read the exact live state first.`,
  { safeToRetry: false },
);

/**
 * Only the decisive browser dispatch and its postcondition live inside this
 * ambiguity boundary.  Every account/source/composer/Stars/approval gate must
 * run before calling this helper so a guaranteed zero-click failure preserves
 * its exact code and fallback semantics.
 */
const dispatchDecisiveMutation = async ({
  page,
  expectedPeerId,
  options,
  stage,
  beforeDispatch = async () => undefined,
  insideLease = async () => undefined,
  decisiveControl,
  verify,
  ambiguousMessage,
}) => {
  if (!decisiveControl || typeof decisiveControl.click !== "function") {
    fail("TELEGRAM_WEB_UI_UNSUPPORTED", "Telegram Web mutation did not bind one exact decisive Locator control.");
  }
  options.commandLifecycle?.assertActive(`preparing ${stage}`);
  // Potentially slow manager/config/source/approval checks deliberately run
  // before the lease. If revoke wins while one is blocked, the bounded lease
  // recheck below observes the tombstone and the Locator is never clicked.
  await beforeDispatch();
  // Hold the independent consent-state lock only across one bounded synchronous
  // surface proof and Playwright's cancellable Locator.click. A concurrent
  // revoke either wins before the lease (zero click) or begins after that one
  // decisive click has settled; no detached async callback survives unlock.
  await withValidConsentLease(page, expectedPeerId, options, stage, async (clickTimeoutMs) => {
    // Toggle-like provider handlers re-read their live model at click time.
    // Callers can therefore install one additional bounded authoritative
    // reproof inside the same consent lease, after account/surface validation.
    let timeout;
    try {
      await Promise.race([
        Promise.resolve().then(insideLease),
        new Promise((_, reject) => {
          timeout = setTimeout(() => reject(new TelegramWebRuntimeError(
            "TELEGRAM_WEB_UI_UNSUPPORTED",
            `Telegram Web could not complete the bounded final ${stage} source reproof before the consent lease deadline.`,
          )), CONSENT_LEASE_REPROOF_TIMEOUT_MS);
        }),
      ]);
    } finally {
      clearTimeout(timeout);
    }
    options.commandLifecycle?.markDecisive(stage);
    try {
      await decisiveControl.click({ timeout: clickTimeoutMs });
    } catch {
      mutationAmbiguous(ambiguousMessage);
    }
  });

  try {
    return await verify();
  } catch (error) {
    if (error instanceof TelegramWebRuntimeError && error.code === "TELEGRAM_WEB_MUTATION_OUTCOME_AMBIGUOUS") throw error;
    mutationAmbiguous(ambiguousMessage);
  }
};

const DOCUMENT_MESSAGE_ALLOWED_KEYS = Object.freeze([...PLAIN_TEXT_MESSAGE_ALLOWED_KEYS, "media"]);
const DOCUMENT_MODEL_ALLOWED_KEYS = Object.freeze([
  "_", "flags", "id", "access_hash", "file_reference", "date", "video_thumbs",
  "dc_id", "attributes", "thumbs", "type", "h", "w", "file_name", "file",
  "duration", "sticker", "stickerEmojiRaw", "stickerSetInput", "pFlags",
  "animated", "supportsStreaming", "size", "mime_type",
]);

const waitForFinalDocumentMessageModel = async (page, {
  expectedPeerId,
  messageId,
  caption,
  snapshot,
  timeoutMs,
}) => {
  await page.waitForFunction(async ({
    peerId,
    mid,
    approvedCaption,
    expectedName,
    expectedSize,
    expectedMimeType,
    forbiddenFields,
    forbiddenFlags,
    allowedKeys,
    allowedFlags,
    allowedDocumentKeys,
  }) => {
    const manager = globalThis.rootScope?.managers?.appMessagesManager;
    const chat = globalThis.appImManager?.chat;
    const numericPeerId = Number(peerId);
    const numericMid = Number(mid);
    if (typeof manager?.getMessageByPeer !== "function"
      || typeof chat?.isOutMessage !== "function"
      || !Number.isSafeInteger(numericPeerId)
      || numericPeerId === 0
      || !Number.isSafeInteger(numericMid)
      || numericMid <= 0) return false;
    try {
      const model = await Promise.resolve(manager.getMessageByPeer(numericPeerId, numericMid));
      const nonempty = (value) => value !== undefined
        && value !== null
        && value !== false
        && value !== ""
        && value !== 0
        && value !== 0n
        && value !== "0"
        && (!Array.isArray(value) || value.length > 0);
      const flags = model?.pFlags ?? {};
      const media = model?.media;
      const mediaFlags = media?.pFlags ?? {};
      const documentModel = media?.document;
      const documentFlags = documentModel?.pFlags ?? {};
      const plainObject = (value) => value
        && typeof value === "object"
        && !Array.isArray(value)
        && [Object.prototype, null].includes(Object.getPrototypeOf(value));
      const filenameAttributes = Array.isArray(documentModel?.attributes)
        ? documentModel.attributes.filter((attribute) => attribute?._ === "documentAttributeFilename")
        : [];
      const imageSizeAttributes = Array.isArray(documentModel?.attributes)
        ? documentModel.attributes.filter((attribute) => attribute?._ === "documentAttributeImageSize")
        : [];
      const attributesSafe = Array.isArray(documentModel?.attributes)
        && documentModel.attributes.every((attribute) => {
          if (!plainObject(attribute)) return false;
          if (attribute._ === "documentAttributeFilename") {
            return Object.keys(attribute).sort().join(",") === "_,file_name"
              && attribute.file_name === expectedName;
          }
          if (attribute._ === "documentAttributeImageSize") {
            return Object.keys(attribute).sort().join(",") === "_,h,w"
              && Number.isSafeInteger(attribute.w)
              && attribute.w > 0
              && Number.isSafeInteger(attribute.h)
              && attribute.h > 0;
          }
          return false;
        });
      const finalEntities = model?.entities ?? [];
      const totalEntities = model?.totalEntities ?? [];
      const rootId = globalThis.rootScope?.myId;
      const savedPeer = model?.saved_peer_id;
      const savedPeerPlain = plainObject(savedPeer);
      const savedPeerKnown = !nonempty(savedPeer) || (
        typeof rootId === "number"
        && Number.isSafeInteger(rootId)
        && rootId > 0
        && String(rootId) === peerId
        && savedPeerPlain
        && Object.keys(savedPeer).sort().join(",") === "_,user_id"
        && savedPeer?._ === "peerUser"
        && typeof savedPeer.user_id === "number"
        && Number.isSafeInteger(savedPeer.user_id)
        && savedPeer.user_id === rootId
        && !nonempty(model?.fwd_from)
      );
      return model?._ === "message"
        && plainObject(model)
        && Object.keys(model).every((key) => allowedKeys.includes(key))
        && typeof model.peerId === "number"
        && Number.isSafeInteger(model.peerId)
        && String(model.peerId) === peerId
        && typeof model.mid === "number"
        && Number.isSafeInteger(model.mid)
        && String(model.mid) === mid
        && typeof chat.peerId === "number"
        && Number.isSafeInteger(chat.peerId)
        && String(chat.peerId) === peerId
        && chat.type === "chat"
        && chat.isMonoforum !== true
        && chat.isOutMessage(model) === true
        && model.pFlags?.is_outgoing !== true
        && model.pending === undefined
        && model.error === undefined
        && model.random_id === undefined
        && model.send === undefined
        && model.uploadingFileName === undefined
        && model.message === approvedCaption
        && Array.isArray(finalEntities)
        && finalEntities.length === 0
        && Array.isArray(totalEntities)
        && totalEntities.length === 0
        && plainObject(flags)
        && Object.keys(flags).every((flag) => allowedFlags.includes(flag) && flags[flag] === true)
        && [model.flags, model.flags2].every((value) => value === undefined
          || (typeof value === "number" && Number.isSafeInteger(value)))
        && !forbiddenFields.some((field) => !["media", "saved_peer_id", "totalEntities"].includes(field) && nonempty(model[field]))
        && !forbiddenFlags.some((flag) => flags[flag] === true)
        && !nonempty(model.reply_to)
        && !nonempty(model.reply_to_mid)
        && !nonempty(model.grouped_id)
        && savedPeerKnown
        && media?._ === "messageMediaDocument"
        && plainObject(media)
        && Object.keys(media).every((key) => ["_", "flags", "pFlags", "document"].includes(key))
        && (media.flags === undefined || (Number.isSafeInteger(media.flags) && media.flags >= 0))
        && plainObject(mediaFlags)
        && Object.keys(mediaFlags).length === 0
        && !nonempty(media.ttl_seconds)
        && documentModel?._ === "document"
        && plainObject(documentModel)
        && Object.keys(documentModel).every((key) => allowedDocumentKeys.includes(key))
        && documentModel.file_name === expectedName
        && documentModel.size === expectedSize
        && typeof documentModel.mime_type === "string"
        && documentModel.mime_type === expectedMimeType
        && documentModel.mime_type.length >= 1
        && documentModel.mime_type.length <= 255
        && nonempty(documentModel.id)
        && nonempty(documentModel.access_hash)
        && Number.isSafeInteger(documentModel.date)
        && documentModel.date > 0
        && Number.isSafeInteger(documentModel.dc_id)
        && documentModel.dc_id > 0
        && (
          documentModel.file_reference instanceof Uint8Array
          || (Array.isArray(documentModel.file_reference)
            && documentModel.file_reference.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255))
        )
        && documentModel.file_reference.length > 0
        && attributesSafe
        && filenameAttributes.length === 1
        && filenameAttributes[0].file_name === expectedName
        && imageSizeAttributes.length <= 1
        && [undefined, null, "photo", "pdf"].includes(documentModel.type)
        && plainObject(documentFlags)
        && Object.keys(documentFlags).length === 0
        && !nonempty(documentModel.video_thumbs)
        && !nonempty(documentModel.duration)
        && !nonempty(documentModel.sticker)
        && !nonempty(documentModel.stickerEmojiRaw)
        && !nonempty(documentModel.stickerSetInput)
        && documentModel.animated !== true
        && documentModel.supportsStreaming !== true
        && documentModel.file === undefined
        && documentModel.promise === undefined
        && documentModel.uploadingFileName === undefined;
    } catch {
      return false;
    }
  }, {
    peerId: expectedPeerId,
    mid: messageId,
    approvedCaption: caption,
    expectedName: snapshot.name,
    expectedSize: snapshot.sizeBytes,
    expectedMimeType: snapshot.normalizedMimeType,
    forbiddenFields: COMPLEX_PLAIN_TEXT_MESSAGE_FIELDS,
    forbiddenFlags: COMPLEX_PLAIN_TEXT_MESSAGE_FLAGS,
    allowedKeys: DOCUMENT_MESSAGE_ALLOWED_KEYS,
    allowedFlags: PLAIN_TEXT_MESSAGE_ALLOWED_PFLAGS,
    allowedDocumentKeys: DOCUMENT_MODEL_ALLOWED_KEYS,
  }, { timeout: timeoutMs });
  const entities = await assertFinalPlainTextModelEntities(page, expectedPeerId, messageId, caption);
  if (entities.entities.length !== 0 || entities.totalEntities.length !== 0) {
    fail("TELEGRAM_WEB_UNSUPPORTED_OPERATION", "Telegram Web added entities to a document caption that was approved as entity-free.");
  }
  return page.evaluate(async ({ peerId, mid }) => {
    const model = await Promise.resolve(globalThis.rootScope.managers.appMessagesManager.getMessageByPeer(Number(peerId), Number(mid)));
    return {
      name: model.media.document.file_name,
      sizeBytes: model.media.document.size,
      mimeType: model.media.document.mime_type,
    };
  }, { peerId: expectedPeerId, mid: messageId });
};

const waitForVerifiedOutgoing = async (page, {
  message,
  beforeIds,
  timeoutMs,
  expectedFiles,
  replyToMessageId = null,
  expectedPeerId,
  expectedWireEntities = [],
}) => {
  let exactMessageId;
  let providerDocument = null;
  try {
    const handle = await page.waitForFunction(({ expected, previous, filesExpected, replyTo, peerId }) => {
      const matches = Array.from(document.querySelectorAll('.bubbles-inner .bubble.is-out[data-mid]')).filter((bubble) => {
        const id = bubble.getAttribute("data-mid");
        const text = String(bubble.querySelector('.message')?.innerText || "");
        const attachmentNodes = Array.from(bubble.querySelectorAll('.document-container, .document, .media-container img, .media-container video, audio-element, .grouped-item[data-mid]'));
        const topLevelAttachments = attachmentNodes.filter((node) => !attachmentNodes.some((other) => other !== node && other.contains(node)));
        const actualReplyTo = bubble.getAttribute("data-reply-to-mid");
        const numericId = Number(id);
        return id
          && /^\d{1,24}$/u.test(id)
          && Number.isSafeInteger(numericId)
          && numericId > 0
          && String(numericId) === id
          && bubble.getAttribute("data-peer-id") === peerId
          && !previous.includes(id)
          && (!expected || text === expected)
          && topLevelAttachments.length === filesExpected
          && (!replyTo || actualReplyTo === replyTo)
          && !bubble.classList.contains("is-outgoing")
          && !bubble.classList.contains("is-sending")
          && !bubble.classList.contains("is-error");
      });
      return matches.length === 1 ? [matches[0].getAttribute("data-mid")] : matches.length > 1 ? matches.map((item) => item.getAttribute("data-mid")) : false;
    }, {
      expected: message,
      previous: beforeIds,
      filesExpected: expectedFiles.length,
      replyTo: replyToMessageId,
      peerId: expectedPeerId,
    }, { timeout: timeoutMs });
    const ids = await handle.jsonValue();
    if (!Array.isArray(ids) || ids.length !== 1) mutationAmbiguous("Telegram Web exposed multiple possible outgoing messages for one send action.");
    exactMessageId = ids[0];
    // Hold a short quiet window after the first candidate. This catches a
    // concurrent matching send from another device/process before declaring
    // the approval bound to exactly one new bubble.
    await page.waitForTimeout(750);
    const stabilizedIds = await page.evaluate(({ expected, previous, filesExpected, replyTo, peerId }) => Array.from(
      document.querySelectorAll('.bubbles-inner .bubble.is-out[data-mid][data-peer-id]'),
    ).filter((bubble) => {
      const id = bubble.getAttribute("data-mid");
      const text = String(bubble.querySelector('.message')?.innerText || "");
      const attachments = Array.from(bubble.querySelectorAll('.document-container, .document, .media-container img, .media-container video, audio-element, .grouped-item[data-mid]'));
      const topLevel = attachments.filter((node) => !attachments.some((other) => other !== node && other.contains(node)));
      const numericId = Number(id);
      return id
        && /^\d{1,24}$/u.test(id)
        && Number.isSafeInteger(numericId)
        && numericId > 0
        && String(numericId) === id
        && !previous.includes(id)
        && bubble.getAttribute("data-peer-id") === peerId
        && (!expected || text === expected)
        && topLevel.length === filesExpected
        && (!replyTo || bubble.getAttribute("data-reply-to-mid") === replyTo)
        && !bubble.classList.contains("is-outgoing")
        && !bubble.classList.contains("is-sending")
        && !bubble.classList.contains("is-error");
    }).map((bubble) => bubble.getAttribute("data-mid")), {
      expected: message,
      previous: beforeIds,
      filesExpected: expectedFiles.length,
      replyTo: replyToMessageId,
      peerId: expectedPeerId,
    });
    if (stabilizedIds.length !== 1 || stabilizedIds[0] !== exactMessageId) {
      mutationAmbiguous("Telegram Web send candidates did not remain unique during the bounded stabilization window.");
    }
    if (expectedFiles.length === 1) {
      providerDocument = await waitForFinalDocumentMessageModel(page, {
        expectedPeerId,
        messageId: exactMessageId,
        caption: message,
        snapshot: expectedFiles[0],
        timeoutMs,
      });
    } else {
      await page.waitForFunction(async ({
      peerId,
      mid,
      approved,
      replyTo,
      approvedEntities,
      forbiddenFields,
      forbiddenFlags,
      allowedKeys,
      allowedFlags,
    }) => {
      const manager = globalThis.rootScope?.managers?.appMessagesManager;
      const peers = globalThis.rootScope?.managers?.appPeersManager;
      const chat = globalThis.appImManager?.chat;
      const numericPeerId = Number(peerId);
      const numericMid = Number(mid);
      if (typeof manager?.getMessageByPeer !== "function"
        || typeof chat?.isOutMessage !== "function"
        || !Number.isSafeInteger(numericPeerId)
        || !Number.isSafeInteger(numericMid)) return false;
      try {
        const model = await Promise.resolve(manager.getMessageByPeer(numericPeerId, numericMid));
        const nonempty = (value) => value !== undefined
          && value !== null
          && value !== false
          && value !== ""
          && value !== 0
          && value !== "0"
          && (!Array.isArray(value) || value.length > 0);
        const finalEntities = model?.entities === undefined || model?.entities === null ? [] : model.entities;
        const totalEntities = model?.totalEntities === undefined || model?.totalEntities === null ? [] : model.totalEntities;
        const flags = model?.pFlags === undefined || model?.pFlags === null ? {} : model.pFlags;
        const flagsPrototype = typeof flags === "object" && !Array.isArray(flags)
          ? Object.getPrototypeOf(flags)
          : null;
        const rootId = globalThis.rootScope?.myId;
        const savedPeer = model?.saved_peer_id;
        const savedPeerPrototype = savedPeer && typeof savedPeer === "object" && !Array.isArray(savedPeer)
          ? Object.getPrototypeOf(savedPeer)
          : null;
        const savedPeerKnown = !nonempty(savedPeer) || (
          typeof rootId === "number"
          && Number.isSafeInteger(rootId)
          && rootId > 0
          && String(rootId) === peerId
          && (savedPeerPrototype === Object.prototype || savedPeerPrototype === null)
          && Object.keys(savedPeer).sort().join(",") === "_,user_id"
          && savedPeer._ === "peerUser"
          && typeof savedPeer.user_id === "number"
          && Number.isSafeInteger(savedPeer.user_id)
          && savedPeer.user_id === rootId
          && !nonempty(model?.fwd_from)
        );
        if (model?._ !== "message"
          || typeof model.peerId !== "number"
          || !Number.isSafeInteger(model.peerId)
          || model.peerId === 0
          || String(model.peerId) !== peerId
          || typeof model.mid !== "number"
          || !Number.isSafeInteger(model.mid)
          || model.mid <= 0
          || String(model.mid) !== mid
          || typeof chat.peerId !== "number"
          || !Number.isSafeInteger(chat.peerId)
          || chat.peerId === 0
          || String(chat.peerId) !== peerId
          || chat.isOutMessage(model) !== true
          || model.pFlags?.is_outgoing === true
          || model.pending !== undefined
          || model.error !== undefined
          || model.random_id !== undefined
          || model.send !== undefined
          || Object.getPrototypeOf(model) !== Object.prototype && Object.getPrototypeOf(model) !== null
          || !Object.keys(model).every((key) => allowedKeys.includes(key))
          || typeof flags !== "object"
          || Array.isArray(flags)
          || (flagsPrototype !== Object.prototype && flagsPrototype !== null)
          || !Object.keys(flags).every((flag) => allowedFlags.includes(flag) && flags[flag] === true)
          || ![model.flags, model.flags2].every((value) => value === undefined
            || (typeof value === "number" && Number.isInteger(value) && Number.isSafeInteger(value)))
          || model.message !== approved
          || !Array.isArray(finalEntities)
          || finalEntities.length > 128
          || !Array.isArray(totalEntities)
          || totalEntities.length > 256
          || !savedPeerKnown
          || forbiddenFields.some((field) => !["totalEntities", "saved_peer_id"].includes(field) && nonempty(model[field]))
          || forbiddenFlags.some((flag) => flags[flag] === true)) return false;
        const exactPositiveSafeId = (value) => typeof value === "number"
          && Number.isSafeInteger(value)
          && value > 0;
        if (!replyTo) return !nonempty(model.reply_to_mid) && !nonempty(model.reply_to);
        const header = model.reply_to;
        if (!exactPositiveSafeId(model.reply_to_mid)
          || !exactPositiveSafeId(header?.reply_to_msg_id)
          || String(model.reply_to_mid ?? "") !== replyTo
          || header?._ !== "messageReplyHeader"
          || String(header.reply_to_msg_id ?? "") !== replyTo) return false;
        if (nonempty(header.reply_to_peer_id)) {
          if (typeof peers?.getPeerId !== "function") return false;
          const replyPeerId = peers.getPeerId(header.reply_to_peer_id);
          if (typeof replyPeerId !== "number"
            || !Number.isSafeInteger(replyPeerId)
            || replyPeerId === 0
            || String(replyPeerId) !== peerId) return false;
        }
        if (header.pFlags && typeof header.pFlags === "object" && Object.values(header.pFlags).some(Boolean)) return false;
        return ![
          header.reply_to_story_id,
          header.reply_to_top_id,
          header.reply_from,
          header.reply_media,
          header.quote_text,
          header.quote_entities,
          header.quote_offset,
          header.todo_item_id,
        ].some(nonempty);
      } catch {
        return false;
      }
    }, {
      peerId: expectedPeerId,
      mid: exactMessageId,
      approved: message,
      replyTo: replyToMessageId,
      approvedEntities: expectedWireEntities,
      forbiddenFields: COMPLEX_PLAIN_TEXT_MESSAGE_FIELDS,
      forbiddenFlags: COMPLEX_PLAIN_TEXT_MESSAGE_FLAGS,
      allowedKeys: PLAIN_TEXT_MESSAGE_ALLOWED_KEYS,
      allowedFlags: PLAIN_TEXT_MESSAGE_ALLOWED_PFLAGS,
    }, { timeout: timeoutMs });
      await assertFinalPlainTextModelEntities(page, expectedPeerId, exactMessageId, message);
    }
  } catch (error) {
    if (error instanceof TelegramWebRuntimeError && error.code === "TELEGRAM_WEB_MUTATION_OUTCOME_AMBIGUOUS") throw error;
    mutationAmbiguous("Telegram Web did not expose one verified sent message after the send action.");
  }
  const messages = await collectMessages(page, 10);
  const exact = messages.find((item) => item.direction === "outgoing" && item.peerId === expectedPeerId && item.messageId === exactMessageId);
  if (!exact) mutationAmbiguous("The verified Telegram send bubble changed before its exact structured result could be read.");
  if (exact.text !== message) mutationAmbiguous("Telegram Web message-model text did not exactly match the approved outgoing payload.");
  const exposedNames = exact.attachments.map((attachment) => attachment.name).filter(Boolean);
  const expectedNames = expectedFiles.map((file) => file.name).sort();
  if (expectedFiles.length && (
    exposedNames.length !== expectedNames.length
    || canonicalJson([...exposedNames].sort()) !== canonicalJson(expectedNames)
  )) {
    mutationAmbiguous("Telegram Web attachment names did not match the immutable approved upload snapshots.");
  }
  if (replyToMessageId && (exact.reply?.messageId !== replyToMessageId || exact.reply?.simple !== true)) {
    mutationAmbiguous("Telegram Web did not bind the new outgoing message to the exact approved reply target.");
  }
  if (expectedFiles.length === 1) {
    exact.document = {
      sourceName: expectedFiles[0].name,
      sourceSizeBytes: expectedFiles[0].sizeBytes,
      sourceSha256: expectedFiles[0].sha256,
      transferMode: "document",
      providerVerified: {
        name: providerDocument.name,
        sizeBytes: providerDocument.sizeBytes,
        mimeType: providerDocument.mimeType,
      },
    };
  }
  return exact;
};

const sendExactDocumentFromComposer = async (page, options, caption, snapshot, {
  expectedPeerId,
} = {}) => {
  expectedPeerId = requireExactSafePeerId(expectedPeerId);
  if (!snapshot?.buffer
    || !Buffer.isBuffer(snapshot.buffer)
    || snapshot.buffer.byteLength !== snapshot.sizeBytes
    || snapshot.sizeBytes < 1
    || snapshot.sizeBytes > MAX_UPLOAD_FILE_BYTES
    || snapshot.transferMode !== "document"
    || snapshot.selectionMimeType !== "application/octet-stream"
    || sha256(snapshot.buffer) !== snapshot.sha256) {
    fail("TELEGRAM_WEB_INPUT_CHANGED", "The immutable approved document snapshot is missing or no longer internally consistent.");
  }

  await assertSafeMutationPeer(page, expectedPeerId);
  await assertOutgoingComposerSafe(page, expectedPeerId, {
    expectedReplyToMessageId: null,
    requireEmpty: true,
    allowMediaPopup: false,
    expectedMessage: "",
  });
  await assertEntityFreeDocumentCaption(page, expectedPeerId, caption);
  await assertExactTextSendDestination(page, expectedPeerId, caption);
  await assertNoPaidMessageCost(page, expectedPeerId);
  await assertMutationSurface(page, expectedPeerId, options, "document selection preparation");
  // One local file crossing into Telegram is always a structural mutation,
  // including under autonomous text policy. Burn the exact one-use approval
  // before selecting bytes into Web K's File object.
  await consumeStructuralApproval(options);

  const beforeIds = await page.locator('.bubbles-inner .bubble.is-out[data-mid]').evaluateAll(
    (nodes) => nodes.map((node) => node.getAttribute("data-mid")),
  );
  const token = randomUUID();
  let runtimeStateCreated = false;
  try {
    await selectExactDocumentSnapshot(page, expectedPeerId, snapshot, options.timeoutMs, token);
    runtimeStateCreated = true;
    const capturedPopup = await captureExactDocumentPopup(page, expectedPeerId, snapshot, options.timeoutMs, token);
    const selectedSnapshot = {
      ...snapshot,
      normalizedMimeType: capturedPopup.normalizedMimeType,
    };
    const popup = page.locator(`[data-trelio-document-popup="${token}"]`).filter({ visible: true });
    if (await popup.count() !== 1) {
      fail("TELEGRAM_WEB_UI_UNSUPPORTED", "Telegram Web did not retain one exact runtime-owned document popup.");
    }
    if (caption) {
      const captionInputs = popup.locator('.input-message-input[contenteditable="true"]').filter({ visible: true });
      if (await captionInputs.count() !== 1) {
        fail("TELEGRAM_WEB_UI_UNSUPPORTED", "Telegram Web document popup did not expose one exact caption input.");
      }
      await fillLocator(captionInputs.first(), caption, page);
    }
    await assertExactDocumentPopupState(page, expectedPeerId, token, selectedSnapshot, caption);
    await assertOutgoingComposerSafe(page, expectedPeerId, {
      expectedReplyToMessageId: null,
      requireEmpty: true,
      allowMediaPopup: true,
      expectedMessage: "",
    });
    const confirm = page.locator(`[data-trelio-document-confirm="${token}"]`).filter({ visible: true });
    if (await confirm.count() !== 1) {
      fail("TELEGRAM_WEB_UI_UNSUPPORTED", "Telegram Web document popup did not expose one exact decisive confirmation control.");
    }

    const assertExactDocumentLeaseState = async () => {
      await assertSafeMutationPeer(page, expectedPeerId);
      await assertOutgoingComposerSafe(page, expectedPeerId, {
        expectedReplyToMessageId: null,
        requireEmpty: true,
        allowMediaPopup: true,
        expectedMessage: "",
      });
      await assertEntityFreeDocumentCaption(page, expectedPeerId, caption);
      await assertExactTextSendDestination(page, expectedPeerId, caption);
      await assertNoPaidMessageCost(page, expectedPeerId);
      await assertExactDocumentPopupState(page, expectedPeerId, token, selectedSnapshot, caption);
    };

    const sent = await dispatchDecisiveMutation({
      page,
      expectedPeerId,
      options,
      stage: "document send action",
      beforeDispatch: assertExactDocumentLeaseState,
      insideLease: assertExactDocumentLeaseState,
      decisiveControl: confirm.first(),
      verify: () => waitForVerifiedOutgoing(page, {
        message: caption,
        beforeIds,
        timeoutMs: options.timeoutMs,
        expectedFiles: [selectedSnapshot],
        replyToMessageId: null,
        expectedPeerId,
        expectedWireEntities: [],
      }),
      ambiguousMessage: "Telegram Web document send action had no uniquely verifiable outgoing result.",
    });
    await cleanupExactDocumentPopupProof(page, token);
    return sent;
  } catch (error) {
    if (options.commandLifecycle?.decisiveAttempted
      || (error instanceof TelegramWebRuntimeError && error.code === "TELEGRAM_WEB_MUTATION_OUTCOME_AMBIGUOUS")) {
      // After the decisive click begins, UI cleanup could hide the only
      // evidence of an upload that actually reached Telegram. Never touch it.
      throw error;
    }
    if (runtimeStateCreated || await page.evaluate(({ key, proofToken }) => Boolean(
      globalThis[key]?.has?.(proofToken),
    ), { key: DOCUMENT_POPUP_PROOF_STATE_KEY, proofToken: token }).catch(() => false)) {
      await clearExactRuntimeDocumentPopup(page, expectedPeerId, options, {
        token,
        snapshot,
        originalError: error,
      });
    }
    throw error;
  }
};

const sendFromComposer = async (page, options, message, {
  replyToMessageId = null,
  expectedPeerId,
  sourceMessage = null,
  prepareReply = null,
  requireContact = false,
  recheckExactDestination = null,
} = {}) => {
  expectedPeerId = requireExactSafePeerId(expectedPeerId);
  await assertSafeMutationPeer(page, expectedPeerId, { requireContact });

  // Burn a one-use approval before creating any helper/draft. Every gate in
  // this block is guaranteed to make no send click and leaves the user's
  // pristine composer untouched.
  await assertOutgoingComposerSafe(page, expectedPeerId, {
    expectedReplyToMessageId: null,
    requireEmpty: true,
    allowMediaPopup: false,
    expectedMessage: "",
  });
  await assertLiveSingleMessageLimit(page, message);
  const approvedWirePayload = await assertExactProductionTextPayload(page, expectedPeerId, message);
  await assertExactTextSendDestination(page, expectedPeerId, message);
  await assertNoPaidMessageCost(page, expectedPeerId);
  await assertMutationSurface(page, expectedPeerId, options, "send preparation");
  await consumeStructuralApproval(options);

  const beforeIds = await page.locator('.bubbles-inner .bubble.is-out[data-mid]').evaluateAll(
    (nodes) => nodes.map((node) => node.getAttribute("data-mid")),
  );
  let runtimeStateCreated = false;
  try {
    if (prepareReply) {
      const replyPreparation = await prepareReply();
      runtimeStateCreated = replyPreparation?.actionClicked === true;
      await assertOutgoingComposerSafe(page, expectedPeerId, {
        expectedReplyToMessageId: replyToMessageId,
        requireEmpty: false,
        allowMediaPopup: false,
        expectedMessage: "",
      });
    }

    const composer = await findComposer(page);
    runtimeStateCreated = true;
    await fillLocator(composer, message, page);
    const sendButtons = page.locator('.chat-input .btn-send.send');
    const visible = [];
    for (let index = 0; index < await sendButtons.count(); index += 1) {
      const button = sendButtons.nth(index);
      if (await button.isVisible().catch(() => false)) visible.push(button);
    }
    if (visible.length !== 1) fail("TELEGRAM_WEB_UI_UNSUPPORTED", "Could not identify one Telegram send button after preparing the message.");
    await assertOutgoingComposerSafe(page, expectedPeerId, {
      expectedReplyToMessageId: replyToMessageId,
      requireEmpty: false,
      allowMediaPopup: false,
      expectedMessage: message,
    });
    await assertLiveSingleMessageLimit(page, message);
    const preparedWirePayload = await assertExactProductionTextPayload(page, expectedPeerId, message, { useComposer: true });
    if (canonicalJson(preparedWirePayload.wireEntities) !== canonicalJson(approvedWirePayload.wireEntities)) {
      fail("TELEGRAM_WEB_SOURCE_CHANGED", "Telegram Web composer entities changed from the exact approved plain-text wire payload.");
    }
    await assertExactTextSendDestination(page, expectedPeerId, message);
    await assertNoPaidMessageCost(page, expectedPeerId);
    await assertMutationSurface(page, expectedPeerId, options, "send action");

    const assertExactSendLeaseState = async () => {
      await assertSafeMutationPeer(page, expectedPeerId, { requireContact });
      if (recheckExactDestination) await recheckExactDestination();
      if (sourceMessage) {
        const exactSource = await exactLoadedMessageDescriptor(page, sourceMessage.messageId, {
          expectedPeerId,
        });
        if (canonicalJson(exactSource) !== canonicalJson(sourceMessage)) {
          fail("TELEGRAM_WEB_SOURCE_CHANGED", "The exact Telegram reply source changed before the decisive send click.");
        }
      }
      await assertOutgoingComposerSafe(page, expectedPeerId, {
        expectedReplyToMessageId: replyToMessageId,
        requireEmpty: false,
        allowMediaPopup: false,
        expectedMessage: message,
      });
      await assertLiveSingleMessageLimit(page, message);
      const wire = await assertExactProductionTextPayload(page, expectedPeerId, message, { useComposer: true });
      if (canonicalJson(wire.wireEntities) !== canonicalJson(approvedWirePayload.wireEntities)) {
        fail("TELEGRAM_WEB_SOURCE_CHANGED", "Telegram Web composer entities changed after approval.");
      }
      await assertExactTextSendDestination(page, expectedPeerId, message);
      await assertNoPaidMessageCost(page, expectedPeerId);
    };
    return await dispatchDecisiveMutation({
      page,
      expectedPeerId,
      options,
      stage: "send action",
      beforeDispatch: assertExactSendLeaseState,
      insideLease: assertExactSendLeaseState,
      decisiveControl: visible[0],
      verify: () => waitForVerifiedOutgoing(page, {
        message,
        beforeIds,
        timeoutMs: options.timeoutMs,
        expectedFiles: [],
        replyToMessageId,
        expectedPeerId,
        expectedWireEntities: approvedWirePayload.wireEntities,
      }),
      ambiguousMessage: "Telegram Web send action had no uniquely verifiable outgoing result.",
    });
  } catch (error) {
    if (error instanceof TelegramWebRuntimeError && error.code === "TELEGRAM_WEB_MUTATION_OUTCOME_AMBIGUOUS") throw error;
    if (runtimeStateCreated) {
      await clearExactRuntimeComposer(page, expectedPeerId, options, {
        replyToMessageId,
        allowedPayloads: [message, ""],
        sourceMessage,
        originalError: error,
      });
    }
    throw error;
  }
};

const requireExactlyOneChat = (options) => {
  if (options.chats.length !== 1) fail("TELEGRAM_WEB_INVALID_ARGUMENT", `${options.command} requires exactly one --chat.`);
  return options.chats[0];
};

const runReadCommand = async (page, options, chat) => {
  const resolved = await resolveDialog(page, chat, options, { openChat: true });
  const { loadedPages, completionUnproven } = await loadHistoryPages(page, options.pages, options.timeoutMs);
  await assertOpenPeer(page, resolved.peerId);
  const messages = await collectMessages(page, options.limit);
  if (messages.some((message) => message.peerId !== resolved.peerId)) {
    fail("TELEGRAM_WEB_CHAT_MISMATCH", "The exact opened Telegram chat exposed message rows for a different peer.");
  }
  return boundStructuredResult({
    ok: true,
    command: "read",
    accountSlot: options.account,
    chat: publicChat(resolved),
    messages: messages.map((message) => publicMessage(message, resolved)),
    artifactContract: PUBLIC_MESSAGE_ARTIFACT_CONTRACT,
    loadedPages,
    incomplete: messages.length >= options.limit || loadedPages >= options.pages || completionUnproven,
    incompleteReasons: [
      ...(messages.length >= options.limit ? ["message_limit"] : []),
      ...(loadedPages >= options.pages ? ["page_limit"] : []),
      ...(completionUnproven ? ["history_completion_unproven"] : []),
    ],
    readStateSideEffects: "Opening the exact chat in Telegram Web can mark visible messages as read and expose normal online activity.",
  });
};

const buildDialogsResult = (rows, options) => {
  const expected = normalizeTitle(options.query);
  const matching = rows.filter((row) => normalizeTitle(row.title).includes(expected) || normalizeTitle(row.username).includes(expected));
  const bounded = matching
    .slice(0, options.limit)
    .map((row) => ({
      ...publicChat(row),
      username: sanitizePublicUsername(row.username),
      archived: row.folderId === 1,
      unread: row.unread,
      unreadCount: row.unreadCount,
      muted: row.muted,
      pinned: row.pinned,
    }));
  const incompleteReasons = [];
  if (matching.length > bounded.length) incompleteReasons.push("result_limit");
  // This command deliberately reads only Web K's already-materialized local
  // dialog index. It never opens the mixed sidebar search UI because that UI
  // also starts an account-wide message search. The local index cannot prove that every
  // server-side dialog has been materialized, even when it returns no match.
  incompleteReasons.push("runtime_local_dialog_index_only");
  if (rows.scanLimitHit === true || rows.length >= 100) incompleteReasons.push("dialog_scan_limit");
  return {
    ok: true,
    command: "dialogs",
    query: options.query,
    dialogs: bounded,
    incomplete: incompleteReasons.length > 0,
    incompleteReasons,
    previewsExcluded: true,
  };
};

const collectLocalDialogModels = async (page, query, limit = 100) => {
  const rows = await page.evaluate(async ({
    expectedQuery,
    maximum,
    unsafeDisplayPatternSource,
    maximumDisplayLabelChars,
  }) => {
    const managers = globalThis.rootScope?.managers;
    const storage = managers?.dialogsStorage;
    const peers = managers?.appPeersManager;
    const messages = managers?.appMessagesManager;
    const notifications = managers?.appNotificationsManager;
    const api = managers?.apiManager;
    const myId = globalThis.rootScope?.myId;
    const unsafeDisplayPattern = new RegExp(unsafeDisplayPatternSource, "gu");
    const boundedWellFormedLabel = (value, maximumLength) => {
      let output = "";
      for (let index = 0; index < value.length; index += 1) {
        const unit = value.charCodeAt(index);
        if (unit >= 0xD800 && unit <= 0xDBFF) {
          const next = value.charCodeAt(index + 1);
          if (next < 0xDC00 || next > 0xDFFF) continue;
          if (output.length + 2 > maximumLength) break;
          output += value[index] + value[index + 1];
          index += 1;
          continue;
        }
        if (unit >= 0xDC00 && unit <= 0xDFFF) continue;
        if (output.length + 1 > maximumLength) break;
        output += value[index];
      }
      return output;
    };
    const safeDisplayLabel = (value) => boundedWellFormedLabel(
      String(value ?? "")
        .normalize("NFKC")
        .replace(unsafeDisplayPattern, " ")
        .replace(/\s+/gu, " ")
        .trim(),
      maximumDisplayLabelChars,
    );
    if (typeof storage?.getDialogs !== "function"
      || typeof peers?.getPeer !== "function"
      || typeof peers?.getPeerActiveUsernames !== "function"
      || typeof messages?.isDialogUnread !== "function"
      || typeof notifications?.isPeerLocalMuted !== "function"
      || !api
      || typeof myId !== "number"
      || !Number.isSafeInteger(myId)
      || myId <= 0) return { known: false };
    const invokeNames = ["invokeApi", "invokeApiSingle", "invokeApiSingleProcess", "invokeApiAfter"]
      .filter((name) => typeof api[name] === "function");
    if (!invokeNames.length) return { known: false, reason: "api_boundary_missing" };
    const results = [];
    for (const filterId of [0, 1]) {
      const wrappers = [];
      let attempts = 0;
      let result;
      let callFailed = false;
      try {
        for (const methodName of invokeNames) {
          const original = api[methodName];
          const wrapped = function() {
            attempts += 1;
            throw new Error("TRELIO_TELEGRAM_WEB_LOCAL_DIALOG_API_BLOCKED");
          };
          api[methodName] = wrapped;
          if (api[methodName] !== wrapped) return { known: false, reason: "local_guard_install" };
          wrappers.push({ methodName, original, wrapped });
        }
        result = storage.getDialogs({
          query: expectedQuery,
          filterId,
          limit: maximum + 1,
          forceLocal: true,
        });
        if (result && typeof result.then === "function") {
          return { known: false, reason: "local_dialog_thenable" };
        }
      } catch {
        callFailed = true;
      } finally {
        for (const { methodName, original, wrapped } of [...wrappers].reverse()) {
          if (api[methodName] !== wrapped) return { known: false, reason: "local_guard_displaced" };
          api[methodName] = original;
          if (api[methodName] !== original) return { known: false, reason: "local_guard_restore" };
        }
      }
      if (attempts !== 0) return { known: false, reason: "local_dialog_api_attempt" };
      if (callFailed) return { known: false, reason: "local_dialog_failure" };
      results.push(result);
    }
    if (!Array.isArray(results)
      || results.length !== 2
      || results.some((result) => !result || !Array.isArray(result.dialogs))) return { known: false };
    const output = [];
    const seen = new Set();
    for (let filterId = 0; filterId <= 1; filterId += 1) for (const dialog of results[filterId].dialogs.slice(0, maximum + 1)) {
      const peerId = dialog?.peerId;
      if (typeof peerId !== "number" || !Number.isSafeInteger(peerId) || peerId === 0) return { known: false };
      const exactFolderId = dialog.folder_id ?? 0;
      if (exactFolderId !== filterId) return { known: false };
      // A peer present in both main/archive snapshots may be moving while the
      // two bounded calls run. Never guess which folder is authoritative.
      if (seen.has(peerId)) return { known: false, reason: "duplicate_dialog_peer" };
      seen.add(peerId);
      let peer;
      let activeUsernames;
      let unread;
      let muted;
      try {
        peer = peers.getPeer(peerId);
        activeUsernames = await Promise.resolve(peers.getPeerActiveUsernames(peerId));
        unread = await Promise.resolve(messages.isDialogUnread(dialog));
        muted = await Promise.resolve(notifications.isPeerLocalMuted({ peerId, threadId: undefined }));
      } catch {
        return { known: false };
      }
      if (!peer
        || !["user", "chat", "channel", "chatForbidden", "channelForbidden"].includes(peer._)
        || !Array.isArray(activeUsernames)
        || typeof unread !== "boolean"
        || typeof muted !== "boolean") return { known: false };
      const title = peer._ === "user"
        ? [peer.first_name, peer.last_name].filter((value) => typeof value === "string" && value).join(" ")
          || String(activeUsernames[0] || "")
        : String(peer.title || "");
      const usernames = activeUsernames
        .map((value) => String(value || ""))
        .filter((value) => /^[A-Za-z0-9_]{5,32}$/u.test(value));
      const unreadCount = dialog.unread_count ?? 0;
      const safeTitle = safeDisplayLabel(title);
      if (!safeTitle
        || !Number.isSafeInteger(unreadCount)
        || unreadCount < 0
        ) return { known: false };
      output.push({
        peerId: String(peerId),
        title: safeTitle,
        username: usernames[0] ? `@${usernames[0]}` : null,
        activeUsernames: usernames.map((value) => `@${value}`),
        isSelf: peerId === myId,
        unread,
        unreadCount: Math.max(unreadCount, unread ? 1 : 0),
        muted,
        pinned: dialog.pFlags?.pinned === true,
        folderId: exactFolderId,
      });
    }
    return {
      known: true,
      rows: output,
      scanLimitHit: output.length > maximum || results.some((result) => (
        result.dialogs.length > maximum || result.isEnd !== true
      )),
    };
  }, {
    expectedQuery: query,
    maximum: limit,
    unsafeDisplayPatternSource: DISPLAY_LABEL_UNSAFE_PATTERN_SOURCE,
    maximumDisplayLabelChars: MAX_DISPLAY_LABEL_CHARS,
  });
  if (!rows?.known || !Array.isArray(rows.rows)) {
    fail("TELEGRAM_WEB_UI_UNSUPPORTED", "Telegram Web did not expose a trustworthy bounded local dialog index.");
  }
  const bounded = rows.rows
    .slice(0, limit)
    .map((row) => ({
      ...row,
      title: sanitizeDisplayLabel(row?.title),
      username: sanitizePublicUsername(row?.username),
      activeUsernames: Array.isArray(row?.activeUsernames)
        ? row.activeUsernames.map(sanitizePublicUsername).filter(Boolean)
        : [],
    }))
    .filter((row) => row.title.length > 0);
  for (const row of bounded) requireExactSafePeerId(row.peerId);
  Object.defineProperty(bounded, "scanLimitHit", { value: rows.scanLimitHit === true, enumerable: false });
  return bounded;
};

const runDialogsCommand = async (page, options) => {
  if (!options.query) fail("TELEGRAM_WEB_INVALID_ARGUMENT", "dialogs requires a bounded --query; listing every dialog is prohibited.");
  const query = boundedString(options.query, 256, "--query");
  const rows = await collectLocalDialogModels(page, query, 100);
  return buildDialogsResult(rows, options);
};

const runUnreadCommand = async (page, options) => {
  if (!options.chats.length) fail("TELEGRAM_WEB_INVALID_ARGUMENT", "unread requires at least one exact --chat; global unread harvesting is prohibited.");
  const dialogs = [];
  for (const chat of options.chats) {
    await openTelegramHome(page, options);
    const resolved = await resolveDialog(page, chat, options);
    dialogs.push({
      ...publicChat(resolved),
      unread: resolved.unread,
      unreadCount: resolved.unreadCount,
      muted: resolved.muted,
    });
  }
  return boundStructuredResult({
    ok: true,
    command: "unread",
    dialogs,
    incomplete: false,
    incompleteReasons: [],
    previewsExcluded: true,
    readStateSideEffects: "Sidebar polling does not intentionally open chats or suppress Telegram receipts.",
  }, "dialogs");
};

const runWatchCommand = async (page, options, consentGuard = async () => undefined) => {
  if (!options.chats.length) fail("TELEGRAM_WEB_INVALID_ARGUMENT", "watch requires at least one exact --chat; global watching is prohibited.");
  const snapshots = [];
  let previous = new Map();
  for (let iteration = 0; iteration < options.iterations; iteration += 1) {
    await consentGuard();
    const currentResult = await runUnreadCommand(page, options);
    const changed = currentResult.dialogs.filter((dialog) => {
      const before = previous.get(dialog.semanticId || dialog.peerId);
      return !before || before.unread !== dialog.unread || before.unreadCount !== dialog.unreadCount;
    });
    snapshots.push({ iteration: iteration + 1, at: new Date().toISOString(), changed });
    previous = new Map(currentResult.dialogs.map((dialog) => [dialog.semanticId || dialog.peerId, dialog]));
    if (iteration + 1 < options.iterations) await page.waitForTimeout(options.intervalMs);
  }
  return boundStructuredResult({
    ok: true,
    command: "watch",
    snapshots,
    incomplete: false,
    incompleteReasons: [],
    previewsExcluded: true,
    readStateSideEffects: "Watch polls exact sidebar rows and never implements ghost mode or receipt tampering.",
  }, "snapshots");
};

const ACCOUNT_WIDE_SEARCH_GUARD_KEY = "__trelioTelegramWebAccountWideSearchGuardsV1";

/**
 * Web K's sidebar search couples dialog/contact discovery to an account-wide
 * message request. The runtime never needs that request: install a per-page
 * API boundary before every content command so an accidental future UI path
 * fails before the provider invocation instead of merely filtering its DOM
 * results afterwards. Only an in-chat message request carrying an explicit
 * non-empty peer remains available.
 */
const installAccountWideMessageSearchGuard = async (page) => {
  const token = randomUUID();
  const installed = await page.evaluate(({ key, guardToken }) => {
    const api = globalThis.rootScope?.managers?.apiManager;
    if (!api) return false;
    const methodNames = ["invokeApi", "invokeApiSingle", "invokeApiSingleProcess", "invokeApiAfter"]
      .filter((name) => typeof api[name] === "function");
    if (!methodNames.length) return false;
    const registry = globalThis[key] instanceof Map ? globalThis[key] : new Map();
    // Idempotence is part of the boundary: never stack wrappers in one live JS
    // realm. A clean intact record may be reused; a poisoned/displaced record
    // must stop the operation instead of being hidden by a fresh token.
    if (registry.size === 1) {
      const [existingToken, existing] = registry.entries().next().value;
      const intact = Array.isArray(existing?.wrappers)
        && existing.wrappers.every(({ api: wrappedApi, methodName, wrapped }) => wrappedApi?.[methodName] === wrapped);
      return existing?.attempts === 0 && intact
        ? { ok: true, token: existingToken }
        : { ok: false };
    }
    if (registry.size !== 0) return { ok: false };
    const state = { attempts: 0, wrappers: [] };
    const blockedMethods = new Set([
      ["messages", ["search", "Global"].join("")].join("."),
      ["contacts", "search"].join("."),
      ["channels", "searchPosts"].join("."),
    ]);
    const inChatMethod = ["messages", "search"].join(".");
    const emptyPeerKind = ["inputPeer", "Empty"].join("");
    const shouldBlock = (args) => {
      const descriptor = args[0];
      const method = typeof descriptor === "string" ? descriptor : descriptor?.method;
      const params = typeof descriptor === "string" ? args[1] : (descriptor?.params ?? args[1]);
      if (blockedMethods.has(method)) return true;
      if (method !== inChatMethod) return false;
      const peer = params?.peer;
      return !peer
        || typeof peer !== "object"
        || Array.isArray(peer)
        || typeof peer._ !== "string"
        || peer._ === emptyPeerKind;
    };
    for (const methodName of methodNames) {
      const original = api[methodName];
      const wrapped = function(...args) {
        if (shouldBlock(args)) {
          state.attempts += 1;
          throw new Error("TRELIO_TELEGRAM_WEB_FORBIDDEN_ACCOUNT_WIDE_SEARCH_BLOCKED");
        }
        return original.apply(this, args);
      };
      try {
        api[methodName] = wrapped;
      } catch {
        for (const installedWrapper of [...state.wrappers].reverse()) {
          if (installedWrapper.api?.[installedWrapper.methodName] === installedWrapper.wrapped) {
            installedWrapper.api[installedWrapper.methodName] = installedWrapper.original;
          }
        }
        return { ok: false };
      }
      if (api[methodName] !== wrapped) {
        for (const installedWrapper of [...state.wrappers].reverse()) {
          if (installedWrapper.api?.[installedWrapper.methodName] === installedWrapper.wrapped) {
            installedWrapper.api[installedWrapper.methodName] = installedWrapper.original;
          }
        }
        return { ok: false };
      }
      state.wrappers.push({ api, methodName, original, wrapped });
    }
    registry.set(guardToken, state);
    globalThis[key] = registry;
    return { ok: true, token: guardToken };
  }, { key: ACCOUNT_WIDE_SEARCH_GUARD_KEY, guardToken: token });
  if (!installed?.ok || typeof installed.token !== "string") {
    fail("TELEGRAM_WEB_UI_UNSUPPORTED", "Telegram Web could not install the mandatory account-wide message-search boundary.");
  }
  return installed.token;
};

const inspectAccountWideMessageSearchGuard = async (page, token) => page.evaluate(({ key, guardToken }) => {
    const proof = globalThis[key]?.get?.(guardToken);
    if (!proof || !Array.isArray(proof.wrappers)) return { known: false };
    const intact = proof.wrappers.every(({ api, methodName, wrapped }) => api?.[methodName] === wrapped);
    return { known: true, intact, attempts: proof.attempts };
  }, { key: ACCOUNT_WIDE_SEARCH_GUARD_KEY, guardToken: token });

const assertAccountWideMessageSearchGuardClean = async (page, token) => {
  const state = await inspectAccountWideMessageSearchGuard(page, token);
  if (!state?.known || !state.intact || state.attempts !== 0) {
    fail(
      "TELEGRAM_WEB_UNSUPPORTED_OPERATION",
      "Telegram Web attempted or displaced the mandatory account-wide message-search boundary; no content result was released.",
      { operation: "account-wide-message-search", fallbackEligible: false },
    );
  }
};

/**
 * Before destroying a live document, prove its current boundary was never
 * invoked or displaced. Clearing the Node-side token only after that proof
 * means a blocked request cannot be forgotten by a later navigation.
 */
const prepareAccountWideSearchGuardForNavigation = async (page, options) => {
  const token = options.accountWideMessageSearchGuardToken;
  if (!token) return;
  await assertAccountWideMessageSearchGuardClean(page, token);
  // Keep the wrapper installed while goto runs. Web K peer/hash transitions
  // can execute route handlers in the same JS realm; releasing here would
  // create an unguarded navigation window. A full document replacement simply
  // discards this realm and refresh installs a fresh record afterwards.
};

const refreshAccountWideMessageSearchGuard = async (page, options, { contextReset = false } = {}) => {
  const previous = options.accountWideMessageSearchGuardToken;
  if (previous) {
    const state = await inspectAccountWideMessageSearchGuard(page, previous);
    if (state?.known) {
      // Same-document refresh: the sticky counter and exact wrappers survive.
      // Never replace or heal them; a caught blocked attempt remains fatal.
      await assertAccountWideMessageSearchGuardClean(page, previous);
      options.accountWideMessageSearchGuardToken = await installAccountWideMessageSearchGuard(page);
      return options.accountWideMessageSearchGuardToken;
    }
    if (!contextReset) {
      fail("TELEGRAM_WEB_UI_UNSUPPORTED", "Telegram Web displaced the mandatory account-wide search boundary in the current document.");
    }
    // A proven navigation was the only authorized way for the old JS realm to
    // disappear. The new document receives its own one-record sticky guard.
    options.accountWideMessageSearchGuardToken = null;
  }
  options.accountWideMessageSearchGuardToken = await installAccountWideMessageSearchGuard(page);
  return options.accountWideMessageSearchGuardToken;
};

/**
 * Web K's ButtonIcon('search') puts only `.btn-icon` on the button and puts
 * `.tgico.button-icon` on its child glyph; it does not expose a stable
 * icon-specific `.tgico-search` button selector.  Use the official active-chat
 * model entrypoint after exact peer/surface proof, then bind the one resulting
 * search input.
 */
const openInChatSearch = async (page, expectedPeerId, timeoutMs, {
  onSearchStateCreated = () => undefined,
} = {}) => {
  expectedPeerId = requireExactSafePeerId(expectedPeerId);
  await assertOpenPeer(page, expectedPeerId);
  const opened = await page.evaluate(async (peerId) => {
    const chat = globalThis.appImManager?.chat;
    if (typeof chat?.peerId !== "number"
      || !Number.isSafeInteger(chat.peerId)
      || chat.peerId === 0
      || String(chat.peerId) !== peerId
      || chat?.type !== "chat"
      || chat?.isMonoforum === true
      || typeof chat?.initSearch !== "function") return false;
    try {
      await Promise.resolve(chat.initSearch());
      return true;
    } catch {
      return false;
    }
  }, expectedPeerId);
  if (!opened) fail("TELEGRAM_WEB_UI_UNSUPPORTED", "Telegram Web did not expose the official exact-chat search model entrypoint.");
  // Mark the state immediately after the authoritative model transition, not
  // after a later DOM wait. If rendering then times out, the exact model state
  // still belongs to this invocation and must be reset in its finally block.
  onSearchStateCreated();
  const inputs = page.locator('.topbar-search-input').filter({ visible: true });
  try {
    await inputs.first().waitFor({ state: "visible", timeout: Math.min(timeoutMs, 5_000) });
  } catch {
    fail("TELEGRAM_WEB_UI_UNSUPPORTED", "Telegram Web did not render one in-chat search input after the official model transition.");
  }
  if (await inputs.count() !== 1) fail("TELEGRAM_WEB_UI_UNSUPPORTED", "Could not identify one in-chat Telegram search input.");
  await assertOpenPeer(page, expectedPeerId);
  return inputs.first();
};

/**
 * Topbar search has an official `.is-connecting` transition. Arm before fill
 * so even a very fast add/remove pair is captured through MutationRecord
 * oldValue. An empty result is accepted only after true -> false and only via
 * Web K's explicit `chatlist.is-empty > ...results-empty` provider state.
 */
const armInChatSearchCompletion = async (page, query) => {
  const token = randomUUID();
  const armed = await page.evaluate(({ key, completionToken, expectedQuery }) => {
    const visible = (element) => {
      const rectangle = element?.getBoundingClientRect?.();
      const style = element ? globalThis.getComputedStyle?.(element) : null;
      return Boolean(rectangle && rectangle.width > 1 && rectangle.height > 1
        && style?.display !== "none" && style?.visibility !== "hidden");
    };
    const inputs = Array.from(document.querySelectorAll('.topbar-search-input')).filter(visible);
    const containers = Array.from(document.querySelectorAll('.topbar-search-input-container.input-search'))
      .filter((container) => visible(container) && inputs[0] && container.contains(inputs[0]));
    if (inputs.length !== 1 || containers.length !== 1 || typeof MutationObserver !== "function") return false;
    const input = inputs[0];
    const container = containers[0];
    const state = {
      token: completionToken,
      query: expectedQuery,
      input,
      container,
      sawInput: false,
      sawConnecting: false,
      sawSettled: false,
    };
    state.onInput = () => {
      if (input.value !== expectedQuery) return;
      state.sawInput = true;
      state.sawConnecting = container.classList.contains("is-connecting");
      state.sawSettled = false;
    };
    input.addEventListener("input", state.onInput);
    state.observer = new MutationObserver((records) => {
      if (!state.sawInput || input.value !== expectedQuery) return;
      for (const record of records) {
        if (record.type !== "attributes" || record.attributeName !== "class" || record.target !== container) continue;
        const previouslyConnecting = String(record.oldValue || "").split(/\s+/u).includes("is-connecting");
        const currentlyConnecting = container.classList.contains("is-connecting");
        if (previouslyConnecting || currentlyConnecting) state.sawConnecting = true;
        if (previouslyConnecting && !currentlyConnecting) state.sawSettled = true;
      }
    });
    state.observer.observe(container, { attributes: true, attributeFilter: ["class"], attributeOldValue: true });
    const registry = globalThis[key] instanceof Map ? globalThis[key] : new Map();
    registry.set(completionToken, state);
    globalThis[key] = registry;
    return true;
  }, { key: SEARCH_COMPLETION_STATE_KEY, completionToken: token, expectedQuery: query });
  if (!armed) {
    fail("TELEGRAM_WEB_SEARCH_INCOMPLETE", "Telegram Web in-chat search did not expose one exact provider loading surface; no empty result was inferred.");
  }
  return token;
};

const waitForInChatSearchCompletion = async (page, token, query, timeoutMs) => {
  try {
    const handle = await page.waitForFunction(({ key, completionToken, expectedQuery }) => {
      const state = globalThis[key]?.get?.(completionToken);
      if (!state
        || state.input?.value !== expectedQuery
        || !state.sawInput
        || !state.sawConnecting
        || !state.sawSettled
        || state.container?.classList?.contains("is-connecting")) return false;
      const results = document.querySelectorAll(
        '.topbar-search-left-chatlist .chatlist-chat[data-mid][data-peer-id], .topbar-search-left-results [data-mid][data-peer-id]',
      );
      const empty = document.querySelectorAll(
        '.topbar-search-left-chatlist.chatlist.is-empty > .topbar-search-left-results-empty',
      );
      if (results.length > 0) return { complete: true, empty: false };
      if (empty.length === 1) return { complete: true, empty: true };
      return false;
    }, { key: SEARCH_COMPLETION_STATE_KEY, completionToken: token, expectedQuery: query }, { timeout: timeoutMs });
    const result = await handle.jsonValue();
    if (result?.complete !== true) {
      fail("TELEGRAM_WEB_SEARCH_INCOMPLETE", "Telegram Web in-chat search did not expose one completed result or explicit empty state.");
    }
    return result;
  } catch (error) {
    if (error instanceof TelegramWebRuntimeError) throw error;
    fail("TELEGRAM_WEB_SEARCH_INCOMPLETE", "Telegram Web in-chat search completion could not be proven before timeout; no empty result was inferred.");
  }
};

const bindInChatSearchResults = async (page, results, dialogPeerId) => {
  dialogPeerId = requireExactSafePeerId(dialogPeerId);
  if (results.some((result) => {
    try {
      requireExactSafePeerId(result.displayPeerId);
      return !isExactPositiveSafeDecimal(result.messageId);
    } catch {
      return true;
    }
  })) {
    fail("TELEGRAM_WEB_UI_UNSUPPORTED", "In-chat search returned a malformed or missing provider message identity.");
  }
  return readExactMessageArtifacts(
    page,
    results.map(({ messageId }) => ({ messageId, authorHint: null })),
    dialogPeerId,
  );
};

const inChatSearchIncompleteReasons = (resultCount, requestedLimit, explicitEmpty) => {
  if (resultCount >= requestedLimit) return ["result_limit"];
  // Web K's official first search loader uses a 30-message page and owns a
  // private loadMore/isEnd continuation. This runtime deliberately does not
  // drive that unverified continuation in 1.0.2, so every non-empty result
  // below the caller limit remains honestly incomplete rather than pretending
  // that the first visible batch proved provider exhaustion.
  if (resultCount > 0) return ["search_pagination_unproven"];
  return explicitEmpty ? [] : ["search_completion_unproven"];
};

/**
 * Close Web K's official in-chat search model before another exact target is
 * opened. This prevents one chat's query/results from becoming an accidental
 * context or DOM source for the next target. Both the unified signal and the
 * visible search/result surfaces must be empty before control returns.
 */
const resetInChatSearch = async (page, expectedPeerId, timeoutMs) => {
  expectedPeerId = requireExactSafePeerId(expectedPeerId);
  await assertOpenPeer(page, expectedPeerId);
  const reset = await page.evaluate((peerId) => {
    const chat = globalThis.appImManager?.chat;
    if (typeof chat?.peerId !== "number"
      || !Number.isSafeInteger(chat.peerId)
      || String(chat.peerId) !== peerId
      || chat.type !== "chat"
      || chat.isMonoforum === true
      || typeof chat.resetSearch !== "function"
      || typeof chat.searchSignal !== "function") return false;
    try {
      chat.resetSearch();
      return true;
    } catch {
      return false;
    }
  }, expectedPeerId);
  if (!reset) fail("TELEGRAM_WEB_UI_UNSUPPORTED", "Telegram Web could not reset the exact in-chat search model.");
  try {
    await page.waitForFunction(({ peerId }) => {
      const visible = (node) => {
        const rectangle = node?.getBoundingClientRect?.();
        const style = node ? globalThis.getComputedStyle?.(node) : null;
        return Boolean(rectangle && rectangle.width > 1 && rectangle.height > 1
          && style?.display !== "none" && style?.visibility !== "hidden");
      };
      const chat = globalThis.appImManager?.chat;
      let signal;
      try {
        signal = chat?.searchSignal?.();
      } catch {
        return false;
      }
      return typeof chat?.peerId === "number"
        && Number.isSafeInteger(chat.peerId)
        && String(chat.peerId) === peerId
        && chat.type === "chat"
        && chat.isMonoforum !== true
        && signal === undefined
        && !Array.from(document.querySelectorAll(
          '.topbar-search-input, .topbar-search-left-chatlist, .topbar-search-left-results',
        )).some(visible);
    }, { peerId: expectedPeerId }, { timeout: Math.min(timeoutMs, 5_000) });
  } catch {
    fail("TELEGRAM_WEB_UI_UNSUPPORTED", "Telegram Web did not prove that the exact in-chat search state was cleared.");
  }
  await assertOpenPeer(page, expectedPeerId);
};

const runOneExactChatSearch = async (page, options, chat, query, dependencies = {}) => {
  const resolveExactDialog = dependencies.resolveDialog || resolveDialog;
  const enterInChatSearch = dependencies.openInChatSearch || openInChatSearch;
  const resetExactSearch = dependencies.resetInChatSearch || resetInChatSearch;
  let resolved = null;
  let searchStateCreated = false;
  try {
    resolved = await resolveExactDialog(page, chat, options, { openChat: true });
    const input = await enterInChatSearch(page, resolved.peerId, options.timeoutMs, {
      onSearchStateCreated: () => { searchStateCreated = true; },
    });
    const completionToken = await armInChatSearchCompletion(page, query);
    let completion;
    try {
      await fillLocator(input, query, page);
      completion = await waitForInChatSearchCompletion(page, completionToken, query, options.timeoutMs);
    } finally {
      await cleanupSearchCompletion(page, completionToken);
    }
    await assertOpenPeer(page, resolved.peerId);
    const results = await page.evaluate((maximum) => Array.from(document.querySelectorAll(
      '.topbar-search-left-chatlist .chatlist-chat[data-mid][data-peer-id], .topbar-search-left-results [data-mid][data-peer-id]',
    )).slice(0, maximum).map((node) => ({
      messageId: node.getAttribute("data-mid"),
      // Web K search rows use the sender as their display peer in many chats.
      displayPeerId: node.getAttribute("data-peer-id"),
      text: String(node.innerText || "").replace(/\s+/gu, " ").trim().slice(0, 4_000),
    })), options.limit);
    const modelResults = await bindInChatSearchResults(page, results, resolved.peerId);
    const incompleteReasons = inChatSearchIncompleteReasons(modelResults.length, options.limit, completion?.empty === true);
    return {
      chat: publicChat(resolved),
      requestedLimit: options.limit,
      returnedResults: modelResults.length,
      results: modelResults.map((result) => publicMessage(result, resolved)),
      complete: incompleteReasons.length === 0,
      truncated: incompleteReasons.length > 0,
      incomplete: incompleteReasons.length > 0,
      incompleteReasons,
    };
  } finally {
    // Never clear whichever chat merely happens to be active. Only a successful
    // `chat.initSearch()` transition creates runtime-owned state, and that exact
    // resolved peer is the sole cleanup target.
    if (searchStateCreated && resolved?.peerId) {
      await resetExactSearch(page, resolved.peerId, options.timeoutMs);
    }
  }
};

const boundMultiChatSearchResult = (payload) => {
  const copy = {
    ...payload,
    searches: payload.searches.map((item) => ({
      ...item,
      results: [...item.results],
      incompleteReasons: [...item.incompleteReasons],
    })),
  };
  const refresh = () => {
    copy.returnedResults = copy.searches.reduce((sum, item) => sum + item.results.length, 0);
    copy.complete = copy.searches.every((item) => item.complete === true);
    copy.truncated = copy.searches.some((item) => item.truncated === true);
    copy.incomplete = !copy.complete;
    copy.incompleteReasons = [...new Set(copy.searches.flatMap((item) => item.incompleteReasons))];
  };
  refresh();
  while (Buffer.byteLength(JSON.stringify(copy), "utf8") > MAX_RESULT_BYTES) {
    const target = [...copy.searches].reverse().find((item) => item.results.length > 0);
    if (!target) fail("TELEGRAM_WEB_RESULT_TOO_LARGE", "Telegram Web multi-chat search metadata exceeded the safe JSON byte limit.");
    target.results.pop();
    target.returnedResults = target.results.length;
    target.complete = false;
    target.truncated = true;
    target.incomplete = true;
    target.incompleteReasons = [...new Set([...target.incompleteReasons, "json_byte_limit"])];
    refresh();
  }
  return copy;
};

const runSearchCommand = async (page, options) => {
  if (!options.chats.length) {
    fail("TELEGRAM_WEB_INVALID_ARGUMENT", "search requires at least one explicit exact --chat; account-wide search is prohibited.");
  }
  if (!options.query) fail("TELEGRAM_WEB_INVALID_ARGUMENT", "search requires --query and searches only the explicitly selected exact chats.");
  if (options.chats.length * options.limit > MAX_SEARCH_RESULTS_TOTAL) {
    fail("TELEGRAM_WEB_INVALID_ARGUMENT", `search may return at most ${MAX_SEARCH_RESULTS_TOTAL} results in aggregate.`);
  }
  const query = boundedString(options.query, 512, "--query");
  const selfPeerId = await page.evaluate(() => {
    const myId = globalThis.rootScope?.myId;
    return typeof myId === "number" && Number.isSafeInteger(myId) && myId > 0
      ? String(myId)
      : null;
  });
  if (!selfPeerId) fail("TELEGRAM_WEB_UI_UNSUPPORTED", "Telegram Web did not expose the exact current-account identity for search target deduplication.");
  const canonicalTargets = options.chats.map((chat) => {
    const reference = normalizeChatReference(chat, options.account);
    if (reference.kind === "title") {
      fail("TELEGRAM_WEB_AMBIGUOUS_CHAT", "Multi-chat search accepts only exact PeerIds, canonical Web K peer URLs, or saved-messages.");
    }
    return reference.kind === "self" ? selfPeerId : reference.value;
  });
  if (new Set(canonicalTargets).size !== canonicalTargets.length) {
    fail("TELEGRAM_WEB_INVALID_ARGUMENT", "search contains repeated canonical chat targets, including equivalent PeerId/URL/Saved Messages aliases.");
  }
  const searches = [];
  for (let index = 0; index < options.chats.length; index += 1) {
    if (index > 0) await openTelegramHome(page, options);
    const exact = await runOneExactChatSearch(page, options, options.chats[index], query);
    searches.push(exact);
  }
  return boundMultiChatSearchResult({
    ok: true,
    command: "search",
    accountSlot: options.account,
    scope: "explicit_exact_chats_only",
    query,
    requestedChats: options.chats.length,
    perChatLimit: options.limit,
    aggregateResultLimit: MAX_SEARCH_RESULTS_TOTAL,
    artifactContract: PUBLIC_MESSAGE_ARTIFACT_CONTRACT,
    searches,
    runtimeSearchResultPersistence: "none",
    runtimeSearchIndexing: "none",
    providerBrowserProfilePersistence: "Telegram Web may retain its ordinary authenticated session, cache, and message data in the dedicated persistent browser profile.",
    readStateSideEffects: "In-chat Telegram search can load message content in each selected chat; the runtime does not manipulate read receipts.",
  });
};

const pathIsSameOrDescendant = (candidate, ancestor) => {
  const normalize = (value) => process.platform === "win32"
    ? path.resolve(value).toLocaleLowerCase("en-US")
    : path.resolve(value);
  const relative = path.relative(normalize(ancestor), normalize(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
};

/**
 * Resolve a possibly-not-yet-created path through its nearest existing real
 * ancestor.  This detects a symlinked parent without requiring the managed
 * namespace leaf itself to exist yet.
 */
const canonicalPathThroughExistingAncestor = async (candidate) => {
  let cursor = path.resolve(candidate);
  const suffix = [];
  while (true) {
    const metadata = await lstat(cursor).catch((error) => {
      if (error?.code === "ENOENT") return null;
      throw error;
    });
    if (metadata) {
      const canonicalAncestor = await realpath(cursor);
      return path.join(canonicalAncestor, ...suffix);
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) fail("TELEGRAM_WEB_UNSAFE_PATH", "Could not resolve a trustworthy existing ancestor for a local path.");
    suffix.unshift(path.basename(cursor));
    cursor = parent;
  }
};

const managedTelegramNamespaceRoots = (environment = process.env) => [
  path.join(resolveConfigHome(environment), "integrations", SKILL_ID),
  path.join(resolveCacheHome(environment), "runtimes", SKILL_ID),
];

const assertOutsideManagedTelegramNamespaces = async (candidate, environment = process.env, label = "Path") => {
  const absoluteCandidate = path.resolve(candidate);
  const canonicalCandidate = await canonicalPathThroughExistingAncestor(absoluteCandidate);
  for (const root of managedTelegramNamespaceRoots(environment)) {
    const absoluteRoot = path.resolve(root);
    const canonicalRoot = await canonicalPathThroughExistingAncestor(absoluteRoot);
    const lexicalOverlap = pathIsSameOrDescendant(absoluteCandidate, absoluteRoot)
      || pathIsSameOrDescendant(absoluteRoot, absoluteCandidate);
    const canonicalOverlap = pathIsSameOrDescendant(canonicalCandidate, canonicalRoot)
      || pathIsSameOrDescendant(canonicalRoot, canonicalCandidate);
    if (lexicalOverlap || canonicalOverlap) {
      fail(
        "TELEGRAM_WEB_UNSAFE_PATH",
        `${label} cannot overlap any connection profile/state or executable cache in the local Telegram Web namespace.`,
      );
    }
  }
};

const ensureOutputPathAvailable = async (outputPath, environment = process.env) => {
  if (!path.isAbsolute(outputPath)) fail("TELEGRAM_WEB_UNSAFE_PATH", "--output must be absolute.");
  if (outputPath !== path.resolve(outputPath)) {
    fail("TELEGRAM_WEB_UNSAFE_PATH", "--output must be one normalized canonical absolute file path without dot segments.");
  }
  if (existsSync(outputPath)) fail("TELEGRAM_WEB_OUTPUT_EXISTS", "Telegram Web download never overwrites an existing output file.");
  const parent = path.dirname(outputPath);
  const metadata = await lstat(parent).catch(() => null);
  if (!metadata || metadata.isSymbolicLink() || !metadata.isDirectory()) fail("TELEGRAM_WEB_UNSAFE_PATH", "The download output parent must already be a real directory.");
  await assertTrustedDownloadOutputParent(parent, environment);
  await assertOutsideManagedTelegramNamespaces(outputPath, environment, "--output");
};

export const saveDownloadExclusively = async (
  download,
  outputPath,
  environment = process.env,
  publishWithLease = async (callback) => callback(),
  transferOptions = {},
) => {
  // This helper is exported for deterministic regression testing, so it must
  // preserve the same parent-chain boundary even when called outside the CLI.
  await ensureOutputPathAvailable(outputPath, environment);
  const temporary = path.join(path.dirname(outputPath), `.${path.basename(outputPath)}.${process.pid}.${randomUUID()}.download`);
  let handle;
  let sizeBytes = 0;
  let linked = false;
  let originalIdentity = null;
  let stream = null;
  let absoluteTimer = null;
  let consentTimer = null;
  let guardRunning = false;
  let transferAbortError = null;
  let rejectTransferAbort;
  const transferAbort = new Promise((_, reject) => { rejectTransferAbort = reject; });
  // A rejection can happen while a file write is between iterator polls. Keep
  // the watchdog promise handled independently; each blocking provider wait
  // still races the original rejection below.
  transferAbort.catch(() => undefined);
  const timeoutMs = Number.isInteger(transferOptions.timeoutMs)
    && transferOptions.timeoutMs >= 1_000
    && transferOptions.timeoutMs <= 300_000
    ? transferOptions.timeoutMs
    : DEFAULT_TIMEOUT_MS;
  const consentGuard = typeof transferOptions.consentGuard === "function"
    ? transferOptions.consentGuard
    : async () => undefined;
  const abortTransfer = (error) => {
    if (transferAbortError) return;
    transferAbortError = error;
    stream?.destroy?.(error);
    // Cancellation is best-effort and must never become a second unbounded
    // wait. Playwright receives the request while the profile teardown remains
    // governed by the caller's normal bounded lifecycle.
    void Promise.resolve().then(() => download.cancel()).catch(() => undefined);
    rejectTransferAbort(error);
  };
  try {
    absoluteTimer = setTimeout(() => abortTransfer(new TelegramWebRuntimeError(
      "TELEGRAM_WEB_DOWNLOAD_TIMEOUT",
      "Telegram Web attachment transfer did not complete within the exact --timeout-ms bound and was cancelled.",
    )), timeoutMs);
    // The provider can return a promise/iterator that has no referenced I/O
    // handle.  Keep this exact transfer deadline referenced so Node 22 cannot
    // exit before cancellation, residue cleanup, and the timeout result.
    consentTimer = setInterval(() => {
      if (guardRunning || transferAbortError) return;
      guardRunning = true;
      Promise.resolve()
        .then(() => consentGuard())
        .catch((error) => abortTransfer(error))
        .finally(() => { guardRunning = false; });
    }, Math.min(500, Math.max(100, Math.floor(timeoutMs / 10))));
    consentTimer.unref?.();
    await Promise.race([Promise.resolve().then(() => consentGuard()), transferAbort]);
    handle = await open(temporary, "wx+", 0o600);
    if (process.platform !== "win32") await chmod(temporary, 0o600);
    await assertPrivatePath(temporary, "file", environment, true);
    stream = await Promise.race([
      Promise.resolve().then(() => download.createReadStream()),
      transferAbort,
    ]);
    if (!stream) fail("TELEGRAM_WEB_DOWNLOAD_FAILED", "Telegram Web did not expose the completed download bytes.");
    if (typeof stream[Symbol.asyncIterator] !== "function" || typeof stream.destroy !== "function") {
      fail("TELEGRAM_WEB_DOWNLOAD_FAILED", "Telegram Web download did not expose one cancellable Node readable stream.");
    }
    stream.on?.("error", () => undefined);
    const iterator = stream[Symbol.asyncIterator]();
    while (true) {
      const next = await Promise.race([iterator.next(), transferAbort]);
      if (next.done) break;
      const chunk = next.value;
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      sizeBytes += bytes.length;
      if (sizeBytes > MAX_DOWNLOAD_BYTES) {
        const error = new TelegramWebRuntimeError(
          "TELEGRAM_WEB_DOWNLOAD_TOO_LARGE",
          `Telegram Web download exceeded ${MAX_DOWNLOAD_BYTES} bytes.`,
        );
        abortTransfer(error);
        throw error;
      }
      let offset = 0;
      while (offset < bytes.length) {
        const { bytesWritten } = await handle.write(bytes, offset, bytes.length - offset, null);
        if (!Number.isInteger(bytesWritten) || bytesWritten <= 0) {
          fail("TELEGRAM_WEB_DOWNLOAD_FAILED", "Telegram Web download could not be written completely to the private temporary file.");
        }
        offset += bytesWritten;
      }
    }
    if (transferAbortError) throw transferAbortError;
    await handle.sync();
    const written = await handleStatExact(handle);
    if (!written.isFile() || written.size !== sizeBytes) {
      fail("TELEGRAM_WEB_DOWNLOAD_FAILED", "Telegram Web download byte count did not match the private temporary file.");
    }
    originalIdentity = { dev: written.dev, ino: written.ino, size: written.size, mtimeNs: written.mtimeNs };
    await assertPrivatePath(temporary, "file", environment);
    const digest = createHash("sha256");
    let verifiedBytes = 0;
    while (true) {
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, MAX_DOWNLOAD_BYTES + 1 - verifiedBytes));
      const { bytesRead } = await handle.read(chunk, 0, chunk.byteLength, verifiedBytes);
      if (bytesRead === 0) break;
      verifiedBytes += bytesRead;
      if (verifiedBytes > MAX_DOWNLOAD_BYTES) fail("TELEGRAM_WEB_DOWNLOAD_TOO_LARGE", "Telegram Web verified download exceeded the maximum safe byte count.");
      digest.update(chunk.subarray(0, bytesRead));
    }
    const [verifiedFd, verifiedPath] = await Promise.all([handleStatExact(handle), lstat(temporary)]);
    if (
      verifiedBytes !== sizeBytes
      || verifiedFd.dev !== originalIdentity.dev
      || verifiedFd.ino !== originalIdentity.ino
      || verifiedFd.size !== originalIdentity.size
      || verifiedFd.mtimeNs !== originalIdentity.mtimeNs
      || verifiedPath.isSymbolicLink()
      || !verifiedPath.isFile()
      || verifiedPath.dev !== originalIdentity.dev
      || verifiedPath.ino !== originalIdentity.ino
    ) fail("TELEGRAM_WEB_DOWNLOAD_FAILED", "Telegram Web download changed before final publication.");
    await publishWithLease(async () => {
      // Reprove the exact output chain inside the consent lease immediately
      // before publication; do not rely on the pre-transfer ACL snapshot.
      await ensureOutputPathAvailable(outputPath, environment);
      // hard-link creation is atomic and fails with EEXIST. Unlike rename it
      // cannot overwrite a path another process created during the download.
      await link(temporary, outputPath).catch((error) => {
        if (error?.code === "EEXIST") fail("TELEGRAM_WEB_OUTPUT_EXISTS", "The output path appeared during download; no file was overwritten.");
        throw error;
      });
      linked = true;
      const [published, currentTemporary] = await Promise.all([lstat(outputPath), lstat(temporary)]);
      if (
        published.isSymbolicLink()
        || !published.isFile()
        || published.dev !== originalIdentity.dev
        || published.ino !== originalIdentity.ino
        || currentTemporary.dev !== originalIdentity.dev
        || currentTemporary.ino !== originalIdentity.ino
      ) fail("TELEGRAM_WEB_DOWNLOAD_FAILED", "The private Telegram download path changed during exclusive publication.");
      if (process.platform !== "win32") await chmod(outputPath, 0o600);
      await assertPrivatePath(outputPath, "file", environment);
      await assertTrustedDownloadOutputParent(path.dirname(outputPath), environment);
    });
    return { sizeBytes, sha256: digest.digest("hex") };
  } catch (error) {
    if (linked) {
      // Never check-then-unlink the public path: another same-user process can
      // atomically replace it between lstat and rm. A failure after the hard
      // link therefore requires explicit inspection; preserving a possibly
      // unrelated replacement is safer than deleting it automatically.
      fail(
        "TELEGRAM_WEB_DOWNLOAD_PUBLICATION_REPAIR_REQUIRED",
        "Telegram Web published the exclusive output path but could not complete its final inode/privacy proof. Inspect that exact output manually; the runtime did not delete or overwrite it.",
        { output: outputPath, originalCode: error?.code || "TELEGRAM_WEB_DOWNLOAD_FAILED", safeToRetry: false },
      );
    }
    if (transferAbortError) throw transferAbortError;
    throw error;
  } finally {
    clearTimeout(absoluteTimer);
    clearInterval(consentTimer);
    stream?.destroy?.();
    await handle?.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
  }
};

const runDownloadCommand = async (page, identity, options) => {
  const chat = requireExactlyOneChat(options);
  if (!options.messageId || !options.output) fail("TELEGRAM_WEB_INVALID_ARGUMENT", "download requires --message-id and --output.");
  await ensureOutputPathAvailable(options.output, options.approvalContext.environment);
  const resolved = await resolveDialog(page, chat, options, { openChat: true });
  await loadHistoryPages(page, options.pages);
  const { locator } = await findMessageTarget(page, options.messageId, { expectedPeerId: resolved.peerId });
  const attachments = locator.locator('.document-container, .document, .media-container img, .media-container video, audio-element, .grouped-item[data-mid]');
  await attachments.evaluateAll((nodes) => {
    const topLevel = nodes.filter((node) => !nodes.some((other) => other !== node && other.contains(node)));
    topLevel.forEach((node, index) => node.setAttribute("data-trelio-telegram-attachment-index", String(index + 1)));
  });
  const attachment = locator.locator(`[data-trelio-telegram-attachment-index="${options.attachmentIndex}"]`);
  if (await attachment.count() !== 1) fail("TELEGRAM_WEB_ATTACHMENT_NOT_FOUND", "The exact loaded Telegram message has no unique top-level attachment at that index.");
  await attachment.scrollIntoViewIfNeeded();
  const menu = await openMessageContextMenu(attachment, page, options.timeoutMs);
  const downloads = [];
  const onDownload = (download) => {
    downloads.push(download);
    if (downloads.length > 1) void download.cancel().catch(() => undefined);
  };
  page.on("download", onDownload);
  let download;
  try {
    const downloadPromise = page.waitForEvent("download", { timeout: options.timeoutMs }).catch(() => null);
    const decisiveDownload = await findUniqueAction(menu, /^(?:Download|Скачать)$/iu);
    await withValidConsentLease(page, resolved.peerId, options, "download action", async (clickTimeoutMs) => {
      options.commandLifecycle?.markDecisive("download action");
      try {
        await decisiveDownload.click({ timeout: clickTimeoutMs });
      } catch {
        mutationAmbiguous("Telegram Web attachment download click had no uniquely verifiable start result.");
      }
    });
    download = await downloadPromise;
    await page.waitForTimeout(300);
  } finally {
    page.off("download", onDownload);
  }
  if (downloads.length !== 1) {
    await Promise.all(downloads.map((item) => item.cancel().catch(() => undefined)));
    fail("TELEGRAM_WEB_DOWNLOAD_FAILED", "Telegram Web emitted an unexpected number of download events for one exact attachment.");
  }
  if (!download) fail("TELEGRAM_WEB_DOWNLOAD_FAILED", "Telegram Web did not begin one verified attachment download.");
  const saved = await saveDownloadExclusively(
    download,
    options.output,
    options.approvalContext.environment,
    (publish) => withValidConsentLease(page, resolved.peerId, options, "download publication", publish),
    {
      timeoutMs: options.timeoutMs,
      consentGuard: async () => {
        const currentDigest = await readCurrentTelegramAccountDigest(page, options.account);
        if (currentDigest !== options.currentAccountDigest) {
          fail("TELEGRAM_WEB_ACCOUNT_CHANGED", "The active Telegram account changed during attachment transfer.");
        }
        await requireValidConsent(identity, currentDigest, options.approvalContext.environment);
        await assertOpenPeer(page, resolved.peerId);
      },
    },
  );
  return {
    ok: true,
    command: "download",
    chat: publicChat(resolved),
    messageId: options.messageId,
    attachmentIndex: options.attachmentIndex,
    output: options.output,
    sizeBytes: saved.sizeBytes,
    sha256: saved.sha256,
    readStateSideEffects: "Opening the exact chat for download can mark visible messages as read.",
  };
};

const runSendCommand = async (page, identity, options, { replyTo = null } = {}) => {
  const chat = requireExactlyOneChat(options);
  const preparedMessage = await messageDescriptor(options);
  const { message } = preparedMessage;
  const preparedFiles = options.approvalRequestPrepared?.files
    || await prepareInputFiles(options.files, options.approvalContext.environment);
  if (!message && preparedFiles.length === 0) {
    fail("TELEGRAM_WEB_INVALID_ARGUMENT", `${options.command} requires --message, --message-file, or one --file document.`);
  }
  if (replyTo && preparedFiles.length) {
    fail(
      "TELEGRAM_WEB_UNSUPPORTED_OPERATION",
      "Replying with a file is outside the verified 1.0.2 document lane; use a text reply or a separate exact send command.",
      { operation: "reply-file", fallbackEligible: true },
    );
  }
  const resolved = await resolveDialog(page, chat, options, { openChat: true });
  await assertSafeMutationPeer(page, resolved.peerId);
  if (replyTo) await loadHistoryPages(page, options.pages, options.timeoutMs);
  const sourceMessage = replyTo ? await exactLoadedMessageDescriptor(page, replyTo, { expectedPeerId: resolved.peerId }) : null;
  await assertOutgoingComposerSafe(page, resolved.peerId, {
    expectedReplyToMessageId: null,
    requireEmpty: true,
    allowMediaPopup: false,
    expectedMessage: "",
  });
  if (preparedFiles.length) {
    await assertEntityFreeDocumentCaption(page, resolved.peerId, message);
  } else {
    await assertLiveSingleMessageLimit(page, message);
    await assertExactProductionTextPayload(page, resolved.peerId, message);
  }
  await assertExactTextSendDestination(page, resolved.peerId, message);
  await assertNoPaidMessageCost(page, resolved.peerId);
  const policy = await loadPolicy(identity, options.approvalContext.environment);
  if (policy.sendMode === "read-only") {
    fail("TELEGRAM_WEB_READ_ONLY", "Local Telegram Web policy is read-only; mutations are disabled.");
  }
  const approvalRequired = preparedFiles.length > 0
    || options.dryRun
    || policy.sendMode === "confirm"
    || Boolean(options.approvalHash);
  if (approvalRequired) {
    const preview = await assertStructuralApproval(
      options,
      { chat: resolved, sourceMessage },
      { message: preparedMessage, files: preparedFiles },
    );
    if (preview) return preview;
  }
  await assertMutationAllowed(identity, options, options.approvalContext.environment);
  await openTelegramHome(page, options);
  const current = await resolveDialog(page, resolved.peerId, options, { openChat: true });
  await assertSafeMutationPeer(page, current.peerId);
  if (replyTo) await loadHistoryPages(page, options.pages, options.timeoutMs);
  if (current.peerId !== resolved.peerId) fail("TELEGRAM_WEB_SOURCE_CHANGED", "The exact Telegram destination changed after send approval.");
  if (preparedFiles.length === 1) {
    await assertOpenPeer(page, resolved.peerId);
    const sent = await sendExactDocumentFromComposer(page, options, message, preparedFiles[0], {
      expectedPeerId: resolved.peerId,
    });
    return {
      ok: true,
      command: options.command,
      chat: publicChat(resolved),
      sent: publicMessage(sent, resolved),
      verified: true,
      readStateSideEffects: "Sending a document through Telegram Web uses normal Telegram delivery and read-state behavior; ghost mode is not implemented.",
    };
  }
  const prepareReply = replyTo ? async () => {
    const currentSource = await exactLoadedMessageDescriptor(page, replyTo, { expectedPeerId: resolved.peerId });
    if (canonicalJson(currentSource) !== canonicalJson(sourceMessage)) {
      fail("TELEGRAM_WEB_SOURCE_CHANGED", "The exact Telegram reply source changed after approval.");
    }
    await assertOutgoingComposerSafe(page, resolved.peerId, {
      expectedReplyToMessageId: null,
      requireEmpty: true,
      allowMediaPopup: false,
    });
    const { locator } = await findMessageTarget(page, replyTo, { expectedPeerId: resolved.peerId });
    const menu = await openMessageContextMenu(locator, page, options.timeoutMs);
    await clickUniqueAction(menu, /^(?:Reply|Ответить)$/iu, options.timeoutMs);
    // Web K nests `.reply` inside an always-present `.reply-wrapper`, so a
    // union count is two on a valid active reply. sendFromComposer immediately
    // proves the authoritative input.getReplyTo() peer/message binding instead.
    return { actionClicked: true };
  } : null;
  await assertOpenPeer(page, resolved.peerId);
  const sent = await sendFromComposer(page, options, message, {
    replyToMessageId: replyTo,
    expectedPeerId: resolved.peerId,
    sourceMessage,
    prepareReply,
  });
  return {
    ok: true,
    command: options.command,
    chat: publicChat(resolved),
    sent: publicMessage(sent, resolved),
    verified: true,
    readStateSideEffects: "Sending or replying through Telegram Web uses normal Telegram delivery and read-state behavior; ghost mode is not implemented.",
  };
};

const runReactionCommand = async (page, identity, options) => {
  void page;
  void identity;
  void options;
  fail(
    "TELEGRAM_WEB_UNSUPPORTED_OPERATION",
    "Official Telegram Web K does not expose a stable DOM identity for quick-reaction choices in this runtime version. The runtime will not guess a canvas/Lottie target; use telegram-mtproto when routing permits.",
    { operation: "react", fallbackEligible: true },
  );
};

const waitForVerifiedEdit = async (page, {
  expectedPeerId,
  messageId,
  message,
  timeoutMs,
  expectedWireEntities = [],
}) => {
  await page.waitForFunction(async ({
    peerId,
    mid,
    approved,
    approvedEntities,
    forbiddenFields,
    forbiddenFlags,
    allowedKeys,
    allowedFlags,
  }) => {
    const bubbles = Array.from(document.querySelectorAll(`.bubbles-inner .bubble[data-mid="${mid}"][data-peer-id="${peerId}"]`));
    if (bubbles.length !== 1
      || !bubbles[0].classList.contains("is-out")
      || bubbles[0].classList.contains("is-outgoing")
      || bubbles[0].classList.contains("is-sending")
      || bubbles[0].classList.contains("is-error")) return false;
    const manager = globalThis.rootScope?.managers?.appMessagesManager;
    const chat = globalThis.appImManager?.chat;
    const numericPeerId = Number(peerId);
    const numericMessageId = Number(mid);
    if (typeof manager?.getMessageByPeer !== "function"
      || typeof chat?.isOutMessage !== "function"
      || !Number.isSafeInteger(numericPeerId)
      || !Number.isSafeInteger(numericMessageId)) return false;
    try {
      const model = await Promise.resolve(manager.getMessageByPeer(numericPeerId, numericMessageId));
      const nonempty = (value) => value !== undefined
        && value !== null
        && value !== false
        && value !== ""
        && value !== 0
        && value !== "0"
        && (!Array.isArray(value) || value.length > 0);
      const finalEntities = model?.entities === undefined || model?.entities === null ? [] : model.entities;
      const totalEntities = model?.totalEntities === undefined || model?.totalEntities === null ? [] : model.totalEntities;
      const flags = model?.pFlags === undefined || model?.pFlags === null ? {} : model.pFlags;
      const flagsPrototype = typeof flags === "object" && !Array.isArray(flags)
        ? Object.getPrototypeOf(flags)
        : null;
      const rootId = globalThis.rootScope?.myId;
      const savedPeer = model?.saved_peer_id;
      const savedPeerPrototype = savedPeer && typeof savedPeer === "object" && !Array.isArray(savedPeer)
        ? Object.getPrototypeOf(savedPeer)
        : null;
      const savedPeerKnown = !nonempty(savedPeer) || (
        typeof rootId === "number"
        && Number.isSafeInteger(rootId)
        && rootId > 0
        && String(rootId) === peerId
        && (savedPeerPrototype === Object.prototype || savedPeerPrototype === null)
        && Object.keys(savedPeer).sort().join(",") === "_,user_id"
        && savedPeer._ === "peerUser"
        && typeof savedPeer.user_id === "number"
        && Number.isSafeInteger(savedPeer.user_id)
        && savedPeer.user_id === rootId
        && !nonempty(model?.fwd_from)
      );
      return model?._ === "message"
        && typeof model.peerId === "number"
        && Number.isSafeInteger(model.peerId)
        && model.peerId !== 0
        && String(model.peerId) === peerId
        && typeof model.mid === "number"
        && Number.isSafeInteger(model.mid)
        && model.mid > 0
        && String(model.mid) === mid
        && typeof chat.peerId === "number"
        && Number.isSafeInteger(chat.peerId)
        && chat.peerId !== 0
        && String(chat.peerId) === peerId
        && chat.isOutMessage(model) === true
        && model.pending === undefined
        && model.error === undefined
        && model.random_id === undefined
        && model.send === undefined
        && (Object.getPrototypeOf(model) === Object.prototype || Object.getPrototypeOf(model) === null)
        && Object.keys(model).every((key) => allowedKeys.includes(key))
        && typeof flags === "object"
        && !Array.isArray(flags)
        && (flagsPrototype === Object.prototype || flagsPrototype === null)
        && Object.keys(flags).every((flag) => allowedFlags.includes(flag) && flags[flag] === true)
        && [model.flags, model.flags2].every((value) => value === undefined
          || (typeof value === "number" && Number.isInteger(value) && Number.isSafeInteger(value)))
        && typeof model.message === "string"
        && model.message === approved
        && Array.isArray(finalEntities)
        && finalEntities.length <= 128
        && Array.isArray(totalEntities)
        && totalEntities.length <= 256
        && savedPeerKnown
        && !forbiddenFields.some((field) => !["totalEntities", "saved_peer_id"].includes(field) && nonempty(model[field]))
        && !forbiddenFlags.some((flag) => flags[flag] === true);
    } catch {
      return false;
    }
  }, {
    peerId: String(expectedPeerId),
    mid: String(messageId),
    approved: message,
    approvedEntities: expectedWireEntities,
    forbiddenFields: COMPLEX_PLAIN_TEXT_MESSAGE_FIELDS,
    forbiddenFlags: COMPLEX_PLAIN_TEXT_MESSAGE_FLAGS,
    allowedKeys: PLAIN_TEXT_MESSAGE_ALLOWED_KEYS,
    allowedFlags: PLAIN_TEXT_MESSAGE_ALLOWED_PFLAGS,
  }, { timeout: timeoutMs });
  await assertFinalPlainTextModelEntities(page, expectedPeerId, messageId, message);
  const updated = await exactLoadedMessageDescriptor(page, messageId, {
    outgoingOnly: true,
    expectedPeerId,
  });
  if (updated.text !== message) mutationAmbiguous("Telegram Web message-model text did not exactly match the approved edit payload.");
  return updated;
};

const runEditCommand = async (page, identity, options) => {
  const chat = requireExactlyOneChat(options);
  if (!options.messageId) fail("TELEGRAM_WEB_INVALID_ARGUMENT", "edit requires --message-id.");
  const preparedMessage = await messageDescriptor(options);
  const { message } = preparedMessage;
  if (!message) fail("TELEGRAM_WEB_INVALID_ARGUMENT", "edit requires non-empty --message or --message-file.");
  const resolved = await resolveDialog(page, chat, options, { openChat: true });
  await assertSafeMutationPeer(page, resolved.peerId);
  await loadHistoryPages(page, options.pages, options.timeoutMs);
  const sourceMessage = await exactLoadedMessageDescriptor(page, options.messageId, { outgoingOnly: true, expectedPeerId: resolved.peerId });
  await assertPlainEditableSourceModel(page, resolved.peerId, options.messageId);
  if (sourceMessage.attachments.length) {
    fail(
      "TELEGRAM_WEB_UNSUPPORTED_OPERATION",
      "Editing captions or media-bearing Telegram messages is outside the verified plain-text edit surface.",
      { operation: "edit-media", fallbackEligible: true },
    );
  }
  await assertOutgoingComposerSafe(page, resolved.peerId, {
    expectedReplyToMessageId: null,
    requireEmpty: true,
    allowMediaPopup: false,
    expectedMessage: "",
  });
  await assertLiveSingleMessageLimit(page, message);
  const approvedWirePayload = await assertExactProductionTextPayload(page, resolved.peerId, message);
  const preview = await assertStructuralApproval(options, { chat: resolved, sourceMessage }, { message: preparedMessage });
  if (preview) return preview;
  await assertMutationAllowed(identity, options, options.approvalContext.environment);
  await assertOpenPeer(page, resolved.peerId);
  await assertSafeMutationPeer(page, resolved.peerId);
  const { locator } = await findMessageTarget(page, options.messageId, { outgoingOnly: true, expectedPeerId: resolved.peerId });
  const currentSource = await exactLoadedMessageDescriptor(page, options.messageId, { outgoingOnly: true, expectedPeerId: resolved.peerId });
  if (canonicalJson(currentSource) !== canonicalJson(sourceMessage)) fail("TELEGRAM_WEB_SOURCE_CHANGED", "The exact Telegram message changed after edit approval.");
  await assertPlainEditableSourceModel(page, resolved.peerId, options.messageId);
  await assertOutgoingComposerSafe(page, resolved.peerId, {
    expectedReplyToMessageId: null,
    requireEmpty: true,
    allowMediaPopup: false,
  });
  await assertMutationSurface(page, resolved.peerId, options, "edit preparation");
  await consumeStructuralApproval(options);
  let runtimeStateCreated = false;
  try {
    const menu = await openMessageContextMenu(locator, page, options.timeoutMs);
    await clickUniqueAction(menu, /^(?:Edit|Изменить|Редактировать)$/iu, options.timeoutMs);
    runtimeStateCreated = true;
    const composer = await findComposer(page);
    const editState = page.locator('.chat-input .btn-send.edit, .input-helper .edit').filter({ visible: true });
    if (!await editState.count()) fail("TELEGRAM_WEB_UI_UNSUPPORTED", "Telegram Web did not render a visible edit helper for the exact model-bound edit state.");
    await assertExactEditComposer(page, resolved.peerId, options.messageId);
    await fillLocator(composer, message, page);
    const send = page.locator('.chat-input .btn-send.edit').filter({ visible: true });
    if (await send.count() !== 1) fail("TELEGRAM_WEB_UI_UNSUPPORTED", "Could not identify the exact Telegram edit submit control.");
    await assertExactEditComposer(page, resolved.peerId, options.messageId, message);
    await assertLiveSingleMessageLimit(page, message);
    const preparedWirePayload = await assertExactProductionTextPayload(page, resolved.peerId, message, { useComposer: true });
    if (canonicalJson(preparedWirePayload.wireEntities) !== canonicalJson(approvedWirePayload.wireEntities)) {
      fail("TELEGRAM_WEB_SOURCE_CHANGED", "Telegram Web edit entities changed from the exact approved plain-text wire payload.");
    }
    await assertMutationSurface(page, resolved.peerId, options, "edit action");
    const assertExactEditLeaseState = async () => {
      await assertSafeMutationPeer(page, resolved.peerId);
      const exactSource = await exactLoadedMessageDescriptor(page, options.messageId, {
        outgoingOnly: true,
        expectedPeerId: resolved.peerId,
      });
      if (canonicalJson(exactSource) !== canonicalJson(sourceMessage)) {
        fail("TELEGRAM_WEB_SOURCE_CHANGED", "The exact Telegram message changed before the edit submit click.");
      }
      await assertPlainEditableSourceModel(page, resolved.peerId, options.messageId);
      await assertExactEditComposer(page, resolved.peerId, options.messageId, message);
      await assertLiveSingleMessageLimit(page, message);
      const wire = await assertExactProductionTextPayload(page, resolved.peerId, message, { useComposer: true });
      if (canonicalJson(wire.wireEntities) !== canonicalJson(approvedWirePayload.wireEntities)) {
        fail("TELEGRAM_WEB_SOURCE_CHANGED", "Telegram Web edit entities changed after approval.");
      }
    };
    await dispatchDecisiveMutation({
      page,
      expectedPeerId: resolved.peerId,
      options,
      stage: "edit action",
      beforeDispatch: assertExactEditLeaseState,
      insideLease: assertExactEditLeaseState,
      decisiveControl: send,
      verify: () => waitForVerifiedEdit(page, {
        expectedPeerId: resolved.peerId,
        messageId: options.messageId,
        message,
        timeoutMs: options.timeoutMs,
        expectedWireEntities: approvedWirePayload.wireEntities,
      }),
      ambiguousMessage: "Telegram Web did not verify the edited text on the exact outgoing message.",
    });
  } catch (error) {
    if (error instanceof TelegramWebRuntimeError && error.code === "TELEGRAM_WEB_MUTATION_OUTCOME_AMBIGUOUS") throw error;
    if (runtimeStateCreated) {
      await clearExactRuntimeComposer(page, resolved.peerId, options, {
        editMessageId: options.messageId,
        allowedPayloads: [message, sourceMessage.text, ""],
        sourceMessage,
        originalError: error,
      });
    }
    throw error;
  }
  return { ok: true, command: "edit", chat: publicChat(resolved), messageId: options.messageId, verified: true };
};

const runDeleteCommand = async (page, identity, options) => {
  const chat = requireExactlyOneChat(options);
  if (!options.messageId || !options.deleteScope) fail("TELEGRAM_WEB_INVALID_ARGUMENT", "delete requires --message-id and explicit --delete-scope me|everyone.");
  const resolved = await resolveDialog(page, chat, options, { openChat: true });
  await assertSafeMutationPeer(page, resolved.peerId);
  await loadHistoryPages(page, options.pages, options.timeoutMs);
  const sourceMessage = await exactLoadedMessageDescriptor(page, options.messageId, { outgoingOnly: true, expectedPeerId: resolved.peerId });
  if (resolved.isSelf && options.deleteScope === "everyone") {
    fail(
      "TELEGRAM_WEB_UNSUPPORTED_OPERATION",
      "Saved Messages has no delete-for-everyone scope in official Telegram Web K; use explicit --delete-scope me.",
      { operation: "delete-everyone-saved-messages", fallbackEligible: true },
    );
  }
  const preview = await assertStructuralApproval(options, { chat: resolved, sourceMessage });
  if (preview) return preview;
  await assertMutationAllowed(identity, options, options.approvalContext.environment);
  await assertOpenPeer(page, resolved.peerId);
  await assertSafeMutationPeer(page, resolved.peerId);
  const { locator } = await findMessageTarget(page, options.messageId, { outgoingOnly: true, expectedPeerId: resolved.peerId });
  const currentSource = await exactLoadedMessageDescriptor(page, options.messageId, { outgoingOnly: true, expectedPeerId: resolved.peerId });
  if (canonicalJson(currentSource) !== canonicalJson(sourceMessage)) fail("TELEGRAM_WEB_SOURCE_CHANGED", "The exact Telegram message changed after delete approval.");
  const menu = await openMessageContextMenu(locator, page, options.timeoutMs);
  const popup = await openNewVisiblePopup(
    page,
    ".popup.popup-delete-chat",
    () => clickUniqueAction(menu, /^(?:Delete|Удалить)$/iu, options.timeoutMs),
    options.timeoutMs,
    "delete confirmation",
  );
  const scopeControl = popup.locator('label, .checkbox-field, .checkbox').filter({ hasText: /also delete|delete for|также удалить|удалить.*для/iu });
  const scopeCount = await scopeControl.count();
  if ((!resolved.isSelf && scopeCount !== 1) || (resolved.isSelf && scopeCount !== 0)) {
    fail(
      "TELEGRAM_WEB_UNSUPPORTED_OPERATION",
      resolved.isSelf
        ? "Saved Messages unexpectedly exposed a delete-scope checkbox; the runtime could not prove official delete-for-me semantics."
        : "Telegram Web did not expose one explicit delete-scope checkbox, so this runtime cannot prove whether deletion would affect only the current account or everyone.",
      { operation: "delete", fallbackEligible: true },
    );
  }
  if (resolved.isSelf) {
    // Web K intentionally renders zero scope checkboxes for peerId===myId and
    // calls deleteMessages(..., false): this is the provider's exact inherent
    // delete-for-me path, not an ambiguous missing control.
    if (options.deleteScope !== "me") fail("TELEGRAM_WEB_DELETE_SCOPE_UNAVAILABLE", "Saved Messages supports only delete-for-me.");
  } else if (options.deleteScope === "everyone") {
    const checkbox = scopeControl.locator('input[type="checkbox"]');
    if (await checkbox.count() === 1) {
      if (!await checkbox.isChecked()) await scopeControl.click({ timeout: options.timeoutMs });
      if (!await checkbox.isChecked()) fail("TELEGRAM_WEB_DELETE_SCOPE_UNAVAILABLE", "Could not select delete-for-everyone exactly.");
    } else {
      fail("TELEGRAM_WEB_DELETE_SCOPE_UNAVAILABLE", "Delete-for-everyone did not expose a verifiable checkbox.");
    }
  } else {
    const checkbox = scopeControl.locator('input[type="checkbox"]');
    if (await checkbox.count() !== 1) fail("TELEGRAM_WEB_DELETE_SCOPE_UNAVAILABLE", "Delete-for-me did not expose a verifiable checkbox state.");
    if (await checkbox.isChecked()) {
      await scopeControl.click({ timeout: options.timeoutMs });
      if (await checkbox.isChecked()) fail("TELEGRAM_WEB_DELETE_SCOPE_UNAVAILABLE", "Could not select delete-for-me exactly.");
    }
  }
  const confirm = popup.getByRole("button", { name: /^(?:Delete|Удалить)$/iu }).filter({ visible: true });
  if (await confirm.count() !== 1) fail("TELEGRAM_WEB_UI_AMBIGUOUS", "Telegram delete confirmation was missing or ambiguous.");
  await assertMutationSurface(page, resolved.peerId, options, "delete action");
  const assertDeleteScopeBound = async () => {
    await assertSafeMutationPeer(page, resolved.peerId);
    const exactSource = await exactLoadedMessageDescriptor(page, options.messageId, {
      outgoingOnly: true,
      expectedPeerId: resolved.peerId,
    });
    if (canonicalJson(exactSource) !== canonicalJson(sourceMessage)) {
      fail("TELEGRAM_WEB_SOURCE_CHANGED", "The exact Telegram message changed before the delete confirmation click.");
    }
    if (await popup.count() !== 1 || !await popup.isVisible().catch(() => false) || await confirm.count() !== 1) {
      fail("TELEGRAM_WEB_UI_UNSUPPORTED", "Telegram Web did not preserve one exact fresh delete confirmation popup.");
    }
    const exactCheckbox = scopeControl.locator('input[type="checkbox"]');
    if (resolved.isSelf) {
      const selfBound = await page.evaluate((peerId) => {
        const myId = globalThis.rootScope?.myId;
        const chatPeerId = globalThis.appImManager?.chat?.peerId;
        return typeof myId === "number"
          && Number.isSafeInteger(myId)
          && myId > 0
          && String(myId) === peerId
          && typeof chatPeerId === "number"
          && Number.isSafeInteger(chatPeerId)
          && chatPeerId !== 0
          && String(chatPeerId) === peerId;
      }, resolved.peerId);
      if (!selfBound || await scopeControl.count() !== 0 || await exactCheckbox.count() !== 0 || options.deleteScope !== "me") {
        fail("TELEGRAM_WEB_DELETE_SCOPE_UNAVAILABLE", "Saved Messages delete-for-me binding changed before the decisive confirmation click.");
      }
      return;
    }
    if (await exactCheckbox.count() !== 1
      || await exactCheckbox.isChecked() !== (options.deleteScope === "everyone")) {
      fail("TELEGRAM_WEB_DELETE_SCOPE_UNAVAILABLE", "Telegram Web delete scope changed before the decisive confirmation click.");
    }
  };
  await dispatchDecisiveMutation({
    page,
    expectedPeerId: resolved.peerId,
    options,
    stage: "delete action",
    beforeDispatch: async () => {
      await assertDeleteScopeBound();
      await consumeStructuralApproval(options);
    },
    insideLease: assertDeleteScopeBound,
    decisiveControl: confirm,
    verify: async () => {
      await locator.waitFor({ state: "detached", timeout: options.timeoutMs });
      try {
        await page.waitForFunction(async ({ peerId, mid }) => {
          const manager = globalThis.rootScope?.managers?.appMessagesManager;
          const numericPeerId = Number(peerId);
          const numericMid = Number(mid);
          if (typeof manager?.getMessageByPeer !== "function"
            || !Number.isSafeInteger(numericPeerId)
            || !Number.isSafeInteger(numericMid)) return false;
          try {
            const model = await Promise.resolve(manager.getMessageByPeer(numericPeerId, numericMid));
            if (model === undefined || model === null) return true;
            return model?._ === "messageEmpty"
              && typeof model.peerId === "number"
              && Number.isSafeInteger(model.peerId)
              && model.peerId !== 0
              && String(model.peerId) === peerId
              && typeof model.mid === "number"
              && Number.isSafeInteger(model.mid)
              && model.mid > 0
              && String(model.mid) === mid;
          } catch {
            return false;
          }
        }, { peerId: resolved.peerId, mid: options.messageId }, { timeout: options.timeoutMs });
      } catch {
        mutationAmbiguous("Telegram Web removed the bubble but did not remove or empty the exact authoritative message model.");
      }
      for (let pass = 0; pass < 2; pass += 1) {
        await page.waitForTimeout(250);
        await assertOpenPeer(page, resolved.peerId);
        const modelAbsent = await page.evaluate(async ({ peerId, mid }) => {
          const manager = globalThis.rootScope?.managers?.appMessagesManager;
          const numericPeerId = Number(peerId);
          const numericMid = Number(mid);
          if (typeof manager?.getMessageByPeer !== "function"
            || !Number.isSafeInteger(numericPeerId)
            || !Number.isSafeInteger(numericMid)) return false;
          try {
            const model = await Promise.resolve(manager.getMessageByPeer(numericPeerId, numericMid));
            if (model === undefined || model === null) return true;
            return model?._ === "messageEmpty"
              && typeof model.peerId === "number"
              && Number.isSafeInteger(model.peerId)
              && model.peerId !== 0
              && String(model.peerId) === peerId
              && typeof model.mid === "number"
              && Number.isSafeInteger(model.mid)
              && model.mid > 0
              && String(model.mid) === mid;
          } catch {
            return false;
          }
        }, { peerId: resolved.peerId, mid: options.messageId });
        if (!modelAbsent) mutationAmbiguous("Telegram Web restored the exact authoritative message model after deletion.");
        const replacementCount = await page.locator(
        `.bubbles-inner .bubble[data-mid="${options.messageId}"][data-peer-id="${resolved.peerId}"], `
        + `.bubbles-inner .grouped-item[data-mid="${options.messageId}"][data-peer-id="${resolved.peerId}"], `
        + `.bubbles-inner .bubble[data-peer-id="${resolved.peerId}"] .grouped-item[data-mid="${options.messageId}"]`,
        ).count();
        if (replacementCount !== 0) mutationAmbiguous("Telegram Web replaced the detached message node with the same exact message identity after deletion.");
      }
    },
    ambiguousMessage: "Telegram Web did not verify removal of the exact outgoing message.",
  });
  return { ok: true, command: "delete", chat: publicChat(resolved), messageId: options.messageId, deleteScope: options.deleteScope, verified: true };
};


const openArchiveList = async (page, options) => {
  await openTelegramHome(page, options);
  const archive = page.locator('archive-dialog').filter({ visible: true });
  if (await archive.count() !== 1) fail("TELEGRAM_WEB_ARCHIVE_UNAVAILABLE", "Telegram Web did not expose one supported Archived Chats row.");
  await archive.click({ timeout: options.timeoutMs });
  const heading = page.getByText(/^(?:Archived Chats|Архив)$/iu, { exact: true }).filter({ visible: true });
  try {
    await heading.first().waitFor({ state: "visible", timeout: options.timeoutMs });
  } catch {
    fail("TELEGRAM_WEB_UI_UNSUPPORTED", "Telegram Web did not open a verifiable archive list before the bounded deadline.");
  }
  if (await heading.count() !== 1) fail("TELEGRAM_WEB_UI_UNSUPPORTED", "Telegram Web archive heading was missing or ambiguous.");
};

const resolveArchivedDialog = async (page, chat, options, { openChat = false } = {}) => {
  const reference = normalizeChatReference(chat, options.account);
  if (reference.kind === "self") fail("TELEGRAM_WEB_INVALID_ARGUMENT", "Saved Messages cannot be archived.");
  if (reference.kind === "title") {
    fail(
      "TELEGRAM_WEB_AMBIGUOUS_CHAT",
      "Archived Telegram chats cannot be addressed by title because bounded search cannot prove uniqueness. Use one exact PeerId or Web K URL.",
    );
  }
  const rows = await collectDialogRows(page, 100);
  const selected = selectExactDialog(rows, reference);
  if (openChat) {
    const locator = await bindExactDialogRowLocator(page, selected);
    await locator.click({ timeout: options.timeoutMs });
    await waitForExactOpenPeer(page, selected.peerId, options.timeoutMs);
  }
  return selected;
};

const readAuthoritativeDialogState = async (page, expectedPeerId, timeoutMs = CONSENT_LEASE_SURFACE_TIMEOUT_MS) => {
  expectedPeerId = requireExactSafePeerId(expectedPeerId);
  try {
    const handle = await page.waitForFunction(async ({ peerId }) => {
      const messages = globalThis.rootScope?.managers?.appMessagesManager;
      const notifications = globalThis.rootScope?.managers?.appNotificationsManager;
      const numericPeerId = Number(peerId);
      if (typeof messages?.getDialogOnly !== "function"
        || typeof messages?.isDialogUnread !== "function"
        || typeof notifications?.isPeerLocalMuted !== "function"
        || typeof notifications?.getPeerLocalSettings !== "function"
        || !Number.isSafeInteger(numericPeerId)
        || numericPeerId === 0) return false;
      try {
        const dialog = await Promise.resolve(messages.getDialogOnly(numericPeerId));
        if (!dialog
          || typeof dialog.peerId !== "number"
          || !Number.isSafeInteger(dialog.peerId)
          || dialog.peerId === 0
          || String(dialog.peerId) !== peerId) return false;
        const unread = await Promise.resolve(messages.isDialogUnread(dialog));
        const muted = await Promise.resolve(notifications.isPeerLocalMuted({ peerId: numericPeerId, threadId: undefined }));
        const notifySettings = await Promise.resolve(notifications.getPeerLocalSettings({
          peerId: numericPeerId,
          threadId: undefined,
          respectType: false,
        }));
        const muteUntil = notifySettings?.mute_until;
        const folder = dialog.folder_id;
        const presentUnreadCount = dialog.unread_count;
        if (typeof unread !== "boolean"
          || typeof muted !== "boolean"
          || (presentUnreadCount !== undefined
            && presentUnreadCount !== null
            && (!Number.isSafeInteger(presentUnreadCount) || presentUnreadCount < 0))
          || (muteUntil !== undefined && muteUntil !== null && (!Number.isInteger(muteUntil) || muteUntil < 0))
          || ![undefined, null, 0, 1].includes(folder)) return false;
        const rawUnreadCount = presentUnreadCount ?? 0;
        return {
          peerId,
          archived: folder === 1,
          pinned: dialog.pFlags?.pinned === true,
          unread,
          unreadCount: Math.max(rawUnreadCount, unread ? 1 : 0),
          muted,
          muteUntil: muteUntil ?? null,
        };
      } catch {
        return false;
      }
    }, { peerId: expectedPeerId }, { timeout: Math.min(timeoutMs, CONSENT_LEASE_SURFACE_TIMEOUT_MS) });
    const state = await handle.jsonValue();
    if (!state || state.peerId !== expectedPeerId
      || [state.archived, state.pinned, state.unread, state.muted].some((value) => typeof value !== "boolean")
      || !Number.isSafeInteger(state.unreadCount) || state.unreadCount < 0
      || (state.muteUntil !== null && (!Number.isInteger(state.muteUntil) || state.muteUntil < 0))) {
      fail("TELEGRAM_WEB_UI_UNSUPPORTED", "Telegram Web did not expose one exact authoritative dialog state snapshot.");
    }
    return state;
  } catch (error) {
    if (error instanceof TelegramWebRuntimeError) throw error;
    fail("TELEGRAM_WEB_UI_UNSUPPORTED", "Telegram Web did not expose one exact authoritative dialog state snapshot before the bounded deadline.");
  }
};

const dialogCommandTarget = (command) => ({
  archive: ["archived", true],
  unarchive: ["archived", false],
  pin: ["pinned", true],
  unpin: ["pinned", false],
  "mark-unread": ["unread", true],
  mute: ["muted", true],
  unmute: ["muted", false],
})[command] || null;

const assertDialogCommandPreState = async (page, expectedPeerId, command) => {
  const target = dialogCommandTarget(command);
  if (!target) fail("TELEGRAM_WEB_UNSUPPORTED_OPERATION", "The requested Telegram dialog action has no exact authoritative target state.");
  const [field, desired] = target;
  const state = await readAuthoritativeDialogState(page, expectedPeerId);
  const sourceMatches = command === "mute"
    ? state.muted === false
    : command === "unmute"
      ? state.muted === true
      : state[field] === !desired;
  if (!sourceMatches) {
    fail(
      "TELEGRAM_WEB_SOURCE_CHANGED",
      `The exact Telegram dialog ${field} state changed after approval; the toggle action was not clicked.`,
    );
  }
  return state;
};

const waitForVerifiedDialogState = async (page, expectedPeerId, command, timeoutMs) => {
  expectedPeerId = requireExactSafePeerId(expectedPeerId);
  const target = dialogCommandTarget(command);
  if (!target) fail("TELEGRAM_WEB_UNSUPPORTED_OPERATION", "The requested Telegram dialog action has no exact authoritative target state.");
  const [field, desired] = target;
  try {
    await page.waitForFunction(async ({ peerId, expectedField, expectedValue }) => {
      const messages = globalThis.rootScope?.managers?.appMessagesManager;
      const notifications = globalThis.rootScope?.managers?.appNotificationsManager;
      const numericPeerId = Number(peerId);
      if (typeof messages?.getDialogOnly !== "function"
        || typeof messages?.isDialogUnread !== "function"
        || typeof notifications?.isPeerLocalMuted !== "function"
        || typeof notifications?.getPeerLocalSettings !== "function"
        || !Number.isSafeInteger(numericPeerId)
        || numericPeerId === 0) return false;
      try {
        const dialog = await Promise.resolve(messages.getDialogOnly(numericPeerId));
        if (!dialog
          || typeof dialog.peerId !== "number"
          || !Number.isSafeInteger(dialog.peerId)
          || dialog.peerId === 0
          || String(dialog.peerId) !== peerId) return false;
        const unread = await Promise.resolve(messages.isDialogUnread(dialog));
        const muted = await Promise.resolve(notifications.isPeerLocalMuted({ peerId: numericPeerId, threadId: undefined }));
        const notifySettings = await Promise.resolve(notifications.getPeerLocalSettings({
          peerId: numericPeerId,
          threadId: undefined,
          respectType: false,
        }));
        const muteUntil = notifySettings?.mute_until;
        const folder = dialog.folder_id;
        if (typeof unread !== "boolean"
          || typeof muted !== "boolean"
          || (muteUntil !== undefined && muteUntil !== null && (!Number.isInteger(muteUntil) || muteUntil < 0))
          || ![undefined, null, 0, 1].includes(folder)) return false;
        const state = {
          archived: folder === 1,
          pinned: dialog.pFlags?.pinned === true,
          unread,
          muted,
          muteUntil: muteUntil ?? null,
        };
        if (expectedField === "muted") {
          return expectedValue
            ? state.muted === true && state.muteUntil === 0x7fffffff
            : state.muted === false && (state.muteUntil === null || state.muteUntil === 0);
        }
        return state[expectedField] === expectedValue;
      } catch {
        return false;
      }
    }, { peerId: expectedPeerId, expectedField: field, expectedValue: desired }, { timeout: timeoutMs });
  } catch {
    mutationAmbiguous(`Telegram Web did not verify the exact authoritative ${field}=${desired} dialog transition.`);
  }
};

const waitForVerifiedArchiveState = (page, expectedPeerId, archived, timeoutMs) => waitForVerifiedDialogState(
  page,
  expectedPeerId,
  archived ? "archive" : "unarchive",
  timeoutMs,
);

const runDialogAction = async (page, identity, options) => {
  const chat = requireExactlyOneChat(options);
  let resolved;
  if (options.command === "unarchive") {
    await openArchiveList(page, options);
    resolved = await resolveArchivedDialog(page, chat, options);
  } else {
    resolved = await resolveDialog(page, chat, options);
  }
  const preview = await assertStructuralApproval(options, { chat: resolved });
  if (preview) return preview;
  await assertMutationAllowed(identity, options, options.approvalContext.environment);
  if (options.command === "unarchive") await openArchiveList(page, options);
  else await openTelegramHome(page, options);
  const current = options.command === "unarchive"
    ? await resolveArchivedDialog(page, resolved.peerId, options, { openChat: true })
    : await resolveDialog(page, resolved.peerId, options, { openChat: true });
  if (current.peerId !== resolved.peerId) fail("TELEGRAM_WEB_SOURCE_CHANGED", "The exact Telegram dialog changed after action approval.");
  const rows = await collectDialogRows(page, 100);
  const currentRow = rows.find((row) => row.peerId === current.peerId);
  if (!currentRow || !Number.isInteger(currentRow.domIndex)) fail("TELEGRAM_WEB_UI_UNSUPPORTED", "The exact Telegram dialog row disappeared before its action.");
  const row = await bindExactDialogRowLocator(page, currentRow);
  const menu = await openDialogContextMenu(row, page, options.timeoutMs);
  if (options.command === "mute") {
    const popup = await openNewVisiblePopup(
      page,
      ".popup.popup-mute",
      () => clickUniqueAction(menu, ACTION_LABELS.mute, options.timeoutMs),
      options.timeoutMs,
      "mute duration",
    );
    const forever = popup.locator('input[type="radio"][value="-1"]');
    const checkedDurations = popup.locator('input[type="radio"]:checked');
    if (await forever.count() !== 1 || await checkedDurations.count() !== 1 || !await forever.isChecked()) {
      fail("TELEGRAM_WEB_UI_UNSUPPORTED", "Telegram Web mute popup did not expose the exact default Forever duration.");
    }
    const confirm = popup.getByRole("button", { name: /^(?:Mute|Отключить уведомления)$/iu }).filter({ visible: true });
    if (await confirm.count() !== 1) fail("TELEGRAM_WEB_UI_UNSUPPORTED", "Telegram Web mute popup did not expose one exact Mute confirmation.");
    await assertMutationSurface(page, current.peerId, options, "mute action");
    await dispatchDecisiveMutation({
      page,
      expectedPeerId: current.peerId,
      options,
      stage: "mute action",
      beforeDispatch: async () => {
        // Prove the approved source state before burning the one-use approval.
        await assertDialogCommandPreState(page, current.peerId, options.command);
        await consumeStructuralApproval(options);
      },
      // Web K's handler reads current live state. Reprove inside the consent
      // lease so a second-device toggle after menu creation cannot reverse the
      // approved operation.
      insideLease: () => assertDialogCommandPreState(page, current.peerId, options.command),
      decisiveControl: confirm,
      verify: () => waitForVerifiedDialogState(page, current.peerId, options.command, options.timeoutMs),
      ambiguousMessage: "Telegram Web mute confirmation had no uniquely verifiable state transition.",
    });
  } else {
    await assertMutationSurface(page, current.peerId, options, `${options.command} action`);
    const decisiveAction = await findUniqueAction(menu, ACTION_LABELS[options.command]);
    await dispatchDecisiveMutation({
      page,
      expectedPeerId: current.peerId,
      options,
      stage: `${options.command} action`,
      beforeDispatch: async () => {
        await assertDialogCommandPreState(page, current.peerId, options.command);
        await consumeStructuralApproval(options);
      },
      insideLease: () => assertDialogCommandPreState(page, current.peerId, options.command),
      decisiveControl: decisiveAction,
      verify: () => waitForVerifiedDialogState(page, current.peerId, options.command, options.timeoutMs),
      ambiguousMessage: `Telegram Web ${options.command} action had no uniquely verifiable state transition.`,
    });
  }
  return {
    ok: true,
    command: options.command,
    chat: publicChat(current),
    verified: true,
    readStateSideEffects: "Opening the exact chat to bind this dialog action can mark visible messages as read through normal Telegram Web behavior before the requested state transition.",
  };
};

const normalizeUsername = (value, label = "contact") => {
  const normalized = String(value || "").trim();
  if (!/^@[A-Za-z0-9_]{5,32}$/u.test(normalized)) fail("TELEGRAM_WEB_INVALID_ARGUMENT", `${label} must be one exact Telegram @username.`);
  return normalized.toLowerCase();
};

const resolveExactContact = async (page, reference, options, { openChat = false } = {}) => {
  const username = normalizeUsername(reference);
  const selected = await page.evaluate(async (exactUsername) => {
    const managers = globalThis.rootScope?.managers;
    const users = managers?.appUsersManager;
    const peers = managers?.appPeersManager;
    const messages = managers?.appMessagesManager;
    const notifications = managers?.appNotificationsManager;
    if (typeof users?.resolveUsername !== "function"
      || typeof peers?.getPeerId !== "function"
      || typeof peers?.getPeerActiveUsernames !== "function"
      || typeof peers?.isContact !== "function"
      || typeof peers?.isBot !== "function"
      || typeof messages?.getDialogOnly !== "function"
      || typeof messages?.isDialogUnread !== "function"
      || typeof notifications?.isPeerLocalMuted !== "function") return { known: false };
    let peer;
    let peerId;
    let activeUsernames;
    let contact;
    let bot;
    try {
      peer = await Promise.resolve(users.resolveUsername(exactUsername));
      peerId = peers.getPeerId(peer);
      activeUsernames = await Promise.resolve(peers.getPeerActiveUsernames(peerId));
      contact = await Promise.resolve(peers.isContact(peerId));
      bot = await Promise.resolve(peers.isBot(peerId));
    } catch {
      return { known: false };
    }
    if (!peer
      || peer._ !== "user"
      || peer.pFlags?.deleted === true
      || peer.pFlags?.support === true
      || typeof peerId !== "number"
      || !Number.isSafeInteger(peerId)
      || peerId <= 0
      || !Array.isArray(activeUsernames)
      || typeof contact !== "boolean"
      || typeof bot !== "boolean") return { known: false };
    const normalizedNames = activeUsernames
      .map((value) => String(value || "").toLowerCase())
      .filter((value) => /^[a-z0-9_]{5,32}$/u.test(value));
    if (normalizedNames.filter((value) => `@${value}` === exactUsername).length !== 1
      || contact !== true
      || bot !== false) return { known: true, exact: false };
    let dialog = null;
    let unread = false;
    let unreadCount = 0;
    let muted = false;
    let pinned = false;
    try {
      dialog = await Promise.resolve(messages.getDialogOnly(peerId));
      if (dialog) {
        if (typeof dialog.peerId !== "number" || dialog.peerId !== peerId) return { known: false };
        unread = await Promise.resolve(messages.isDialogUnread(dialog));
        muted = await Promise.resolve(notifications.isPeerLocalMuted({ peerId, threadId: undefined }));
        unreadCount = dialog.unread_count ?? 0;
        pinned = dialog.pFlags?.pinned === true;
      }
    } catch {
      return { known: false };
    }
    if (typeof unread !== "boolean"
      || typeof muted !== "boolean"
      || !Number.isSafeInteger(unreadCount)
      || unreadCount < 0) return { known: false };
    const title = [peer.first_name, peer.last_name]
      .filter((value) => typeof value === "string" && value)
      .join(" ") || exactUsername;
    return {
      known: true,
      exact: true,
      peerId: String(peerId),
      title: String(title).replace(/\s+/gu, " ").trim().slice(0, 512),
      username: exactUsername,
      activeUsernames: normalizedNames.map((value) => `@${value}`),
      isSelf: peerId === globalThis.rootScope?.myId,
      unread,
      unreadCount: Math.max(unreadCount, unread ? 1 : 0),
      muted,
      pinned,
      domIndex: null,
    };
  }, username);
  if (!selected?.known || !selected.exact) {
    fail("TELEGRAM_WEB_CONTACT_NOT_FOUND", "One exact existing non-bot Telegram contact did not resolve from the explicit @username.");
  }
  requireExactSafePeerId(selected.peerId);
  selected.title = sanitizeDisplayLabel(selected.title);
  selected.username = sanitizePublicUsername(selected.username);
  selected.activeUsernames = Array.isArray(selected.activeUsernames)
    ? selected.activeUsernames.map(sanitizePublicUsername).filter(Boolean)
    : [];
  if (openChat) {
    if (options.blockAccountWideMessageSearch === true) {
      await prepareAccountWideSearchGuardForNavigation(page, options);
    }
    await page.goto(telegramWebUrlForAccount(options.account, selected.peerId), {
      waitUntil: "domcontentloaded",
      timeout: options.timeoutMs,
    });
    assertTrustedPage(page, options.account);
    await waitForExactOpenPeer(page, selected.peerId, options.timeoutMs);
    if (options.blockAccountWideMessageSearch === true) {
      await refreshAccountWideMessageSearchGuard(page, options, { contextReset: true });
    }
  }
  return selected;
};

const resolveExactMembers = async (page, members, options) => {
  const unique = [...new Set(members.map((member) => normalizeUsername(member, "--member")))];
  if (unique.length !== members.length) fail("TELEGRAM_WEB_INVALID_ARGUMENT", "Repeated Telegram member references are not allowed.");
  const resolved = [];
  for (const member of unique) {
    await openTelegramHome(page, options);
    resolved.push(await resolveExactContact(page, member, options));
  }
  return resolved;
};

const runCreateDirectCommand = async (page, identity, options) => {
  if (!options.contact) fail("TELEGRAM_WEB_INVALID_ARGUMENT", "create-direct requires one exact --contact @username.");
  if (options.files.length) {
    fail(
      "TELEGRAM_WEB_UNSUPPORTED_OPERATION",
      "create-direct does not accept files in the verified 1.0.2 document lane; use one separate exact send --file operation.",
      { operation: "create-direct-file", fallbackEligible: true },
    );
  }
  const preparedMessage = await messageDescriptor(options);
  const preparedFiles = [];
  if (!preparedMessage.message) {
    fail("TELEGRAM_WEB_INVALID_ARGUMENT", "create-direct requires --message or --message-file.");
  }
  const contact = await resolveExactContact(page, options.contact, options);
  if (contact.isSelf) fail("TELEGRAM_WEB_INVALID_ARGUMENT", "create-direct cannot target the current account; use --chat saved-messages instead.");
  const openedContact = await resolveExactContact(page, options.contact, options, { openChat: true });
  if (openedContact.peerId !== contact.peerId || openedContact.isSelf) {
    fail("TELEGRAM_WEB_SOURCE_CHANGED", "The exact Telegram contact changed before create-direct approval.");
  }
  await assertSafeMutationPeer(page, contact.peerId, { requireContact: true });
  await assertOutgoingComposerSafe(page, contact.peerId, {
    expectedReplyToMessageId: null,
    requireEmpty: true,
    allowMediaPopup: false,
    expectedMessage: "",
  });
  await assertLiveSingleMessageLimit(page, preparedMessage.message);
  await assertExactProductionTextPayload(page, contact.peerId, preparedMessage.message);
  await assertExactTextSendDestination(page, contact.peerId, preparedMessage.message);
  await assertNoPaidMessageCost(page, contact.peerId);
  const preview = await assertStructuralApproval(
    options,
    { contact },
    { message: preparedMessage, files: preparedFiles },
  );
  if (preview) return preview;
  await assertMutationAllowed(identity, options, options.approvalContext.environment);
  await openTelegramHome(page, options);
  const current = await resolveExactContact(page, options.contact, options, { openChat: true });
  if (current.isSelf || current.peerId !== contact.peerId) {
    fail("TELEGRAM_WEB_SOURCE_CHANGED", "The exact Telegram contact changed after create-direct approval.");
  }
  await assertSafeMutationPeer(page, contact.peerId, { requireContact: true });
  const sent = await sendFromComposer(page, options, preparedMessage.message, {
    expectedPeerId: contact.peerId,
    requireContact: true,
    recheckExactDestination: async () => {
      const exactContact = await resolveExactContact(page, options.contact, options);
      if (exactContact.peerId !== contact.peerId || exactContact.isSelf) {
        fail("TELEGRAM_WEB_SOURCE_CHANGED", "The exact active @username no longer resolves to the approved contact before the decisive send click.");
      }
    },
  });
  return {
    ok: true,
    command: "create-direct",
    chat: publicChat(contact),
    sent: publicMessage(sent, contact),
    verified: true,
  };
};

const removePrivateStateFile = async (file, environment = process.env) => {
  await ensurePrivateTree(resolveConfigHome(environment), path.dirname(file), environment);
  const metadata = await lstat(file).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (!metadata) return false;
  // An exact leaf symlink is safe to unlink without following it. This keeps
  // revoke/forget available even when the preference leaf itself is hostile;
  // every ancestor was verified above and directories/special files remain a
  // fail-closed error.
  if (metadata.isSymbolicLink()) {
    return rm(file, { force: false }).then(() => true).catch((error) => {
      if (error?.code === "ENOENT") return false;
      throw error;
    });
  }
  await assertPrivatePath(file, "file", environment);
  return rm(file, { force: false }).then(() => true).catch((error) => {
    if (error?.code === "ENOENT") return false;
    throw error;
  });
};

const revokeConsentUnlocked = async (identity, environment = process.env) => removePrivateStateFile(
  runtimeLocations(identity, environment).consentFile,
  environment,
);

const invalidatePendingApproval = async (identity, environment = process.env) => removePrivateStateFile(
  runtimeLocations(identity, environment).pendingApprovalFile,
  environment,
);

const revokeConsent = async (identity, environment = process.env) => acquireConsentStateLock(
  identity,
  async () => {
    // The tombstone becomes authoritative before the old consent is removed.
    // A crash at any later point therefore remains revoked, and a consent page
    // opened against the prior generation cannot resurrect the record.
    await rotateConsentGenerationUnlocked(identity, environment);
    await revokeConsentUnlocked(identity, environment);
    await invalidatePendingApproval(identity, environment);
  },
  environment,
);

const runPolicyCommand = async (identity, options, environment = process.env) => {
  if (options.subcommand === "show") return { ok: true, command: "policy", policy: await loadPolicy(identity, environment) };
  if (options.subcommand !== "set") fail("TELEGRAM_WEB_INVALID_ARGUMENT", "policy requires show or set.");
  if (!options.confirm) fail("TELEGRAM_WEB_CONFIRMATION_REQUIRED", "policy set requires the user's explicit --confirm.");
  if (!POLICY_MODES.has(options.sendMode)) fail("TELEGRAM_WEB_INVALID_ARGUMENT", "policy set requires --send-mode confirm|autonomous|read-only.");
  if (options.sendMode === "autonomous" && !identity.allowAutonomous) {
    fail("TELEGRAM_WEB_AUTONOMOUS_FORBIDDEN", "The company connection forbids autonomous Telegram Web mutations.");
  }
  await acquireProfileLock(identity, async () => {
    await writePrivateJson(
      runtimeLocations(identity, environment).policyFile,
      { sendMode: options.sendMode },
      resolveConfigHome(environment),
      environment,
    );
    await invalidatePendingApproval(identity, environment);
  }, environment);
  return { ok: true, command: "policy", policy: { sendMode: options.sendMode } };
};

const runDoctorCommand = async (identity, environment = process.env) => {
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  const browser = await findChromeExecutable(environment);
  const consentPresent = Boolean(await lstat(runtimeLocations(identity, environment).consentFile).catch(() => null));
  return {
    ok: true,
    command: "doctor",
    supported: nodeMajor >= 22 && Boolean(browser),
    node: { major: nodeMajor, supported: nodeMajor >= 22 },
    browser: { found: Boolean(browser), family: browser ? path.basename(browser) : null },
    browserRuntime: { ready: await hasPinnedPlaywright(identity, environment), playwrightVersion: PLAYWRIGHT_VERSION },
    profileIsolation: "dedicated-per-connection",
    chromiumSandboxRequired: true,
    headlessAfterLogin: true,
    consentRecordPresent: consentPresent,
    policy: await loadPolicy(identity, environment),
    capabilities: {
      verified: VERIFIED_PILOT_OPERATIONS,
      unsupported: [...UNSUPPORTED_PILOT_OPERATIONS].sort(),
    },
  };
};

const PROBE_FAILURE_STAGES = Object.freeze({
  browserDiscovery: "browser_discovery",
  runtimeInspection: "runtime_inspection",
  browserSession: "browser_session",
  telegramHome: "telegram_home",
  accountIdentity: "account_identity",
  consentState: "consent_state",
});

const runProbePhase = async (stage, callback) => {
  try {
    return await callback();
  } catch (error) {
    // Domain/security errors already carry a deliberate public contract and
    // must retain it exactly. Native Playwright, filesystem, and injected-test
    // errors are reduced to a fixed phase name: never expose their message,
    // stack, path, URL, page content, private account digest, or a causal chain.
    if (error instanceof TelegramWebRuntimeError) throw error;
    fail(
      "TELEGRAM_WEB_PROBE_FAILED",
      "Telegram Web probe stopped during a bounded local verification phase.",
      { stage },
    );
  }
};

const runProbeCommand = async (identity, options, environment = process.env, dependencies = {}) => {
  // Browser discovery is injectable only through the exported in-process test
  // seam.  The executable CLI supplies no dependency object and therefore
  // always performs the real canonical-path/ACL checks below.
  const discoverBrowser = dependencies.findChromeExecutable || findChromeExecutable;
  const inspectRuntime = dependencies.hasPinnedPlaywright || hasPinnedPlaywright;
  const browserRunner = dependencies.withTelegramBrowser || withTelegramBrowser;
  const openHome = dependencies.openTelegramHome || openTelegramHome;
  const readAccountDigest = dependencies.readCurrentTelegramAccountDigest || readCurrentTelegramAccountDigest;
  const readConsentStatus = dependencies.renderConsentStatus || renderConsentStatus;
  const browser = await runProbePhase(
    PROBE_FAILURE_STAGES.browserDiscovery,
    () => discoverBrowser(environment),
  );
  const runtimeReady = await runProbePhase(
    PROBE_FAILURE_STAGES.runtimeInspection,
    () => inspectRuntime(identity, environment),
  );
  if (!runtimeReady || !browser) {
    return withPublicAccountSlot({
      ok: true,
      command: options.command,
      accessStatus: "not_configured",
      runtimeReady,
      browserFound: Boolean(browser),
      webClient: "K",
      adapterVersion: ADAPTER_VERSION,
    }, options.account);
  }
  return runProbePhase(
    PROBE_FAILURE_STAGES.browserSession,
    () => browserRunner(identity, options, async ({ page }) => {
      const surface = await runProbePhase(
        PROBE_FAILURE_STAGES.telegramHome,
        () => openHome(page, options, { allowLoggedOut: true }),
      );
      if (!surface.loggedIn) return withPublicAccountSlot({
        ok: true,
        command: options.command,
        accessStatus: "needs_reconnect",
        loggedIn: false,
        locked: surface.locked,
        webClient: "K",
        adapterVersion: ADAPTER_VERSION,
      }, options.account);
      const digest = await runProbePhase(
        PROBE_FAILURE_STAGES.accountIdentity,
        () => readAccountDigest(page, options.account),
      );
      const consent = await runProbePhase(
        PROBE_FAILURE_STAGES.consentState,
        () => readConsentStatus(identity, digest, new Date(), environment),
      );
      return withPublicAccountSlot({
        ok: true,
        command: options.command,
        accessStatus: consent.valid ? "connected" : "consent_required",
        loggedIn: true,
        consent,
        webClient: "K",
        adapterVersion: ADAPTER_VERSION,
        chromiumSandbox: true,
        headless: !options.headed,
        capabilities: {
          verified: VERIFIED_PILOT_OPERATIONS,
          unsupported: [...UNSUPPORTED_PILOT_OPERATIONS].sort(),
        },
      }, options.account);
    }, environment),
  );
};

const runLoginCommand = async (identity, options, environment = process.env, dependencies = {}) => {
  const bootstrapRuntime = dependencies.bootstrapBrowserRuntime || bootstrapBrowserRuntime;
  const browserRunner = dependencies.withTelegramBrowser || withTelegramBrowser;
  const openHome = dependencies.openTelegramHome || openTelegramHome;
  const waitForAuthenticatedAccount = dependencies.waitForAuthenticatedTelegramAccount
    || waitForAuthenticatedTelegramAccount;
  const invalidateApproval = dependencies.invalidatePendingApproval || invalidatePendingApproval;
  const saveAccount = dependencies.savePreferredAccount || savePreferredAccount;
  await bootstrapRuntime(identity, environment);
  const loginOptions = { ...options, headed: true };
  const result = await browserRunner(identity, loginOptions, async ({ page }) => {
    await openHome(page, loginOptions, { allowLoggedOut: true });
    // Browser setup/navigation has its own deadline. Arm a fresh full owner
    // handoff only when the guarded Telegram page is actually ready, so QR and
    // 2FA receive every millisecond promised by --hold-ms.
    loginOptions.commandLifecycle?.beginOwnerHandoff(options.holdMs, "login owner handoff deadline");
    await page.bringToFront();
    // Always use the complete proof, including for an apparently restored chat
    // shell: hidden stale DOM and an already-populated manager identity can
    // coexist with Telegram's still-visible two-step verification screen.
    await waitForAuthenticatedAccount(page, options.account, options.holdMs);
    await invalidateApproval(identity, environment);
    await saveAccount(identity, options.account, environment);
    return withPublicAccountSlot({
      ok: true,
      command: "login",
      loggedIn: true,
      dedicatedProfile: true,
      webClient: "K",
    }, options.account);
  }, environment);
  return result;
};

const publicInspectionSurface = (surface) => ({
  authenticationState: surface?.loggedIn
    ? "logged_in"
    : surface?.locked
      ? "locked"
      : "needs_reconnect",
  loggedIn: surface?.loggedIn === true,
  locked: surface?.locked === true,
  hasChatList: surface?.hasChatList === true,
  hasComposer: surface?.hasComposer === true,
});

/**
 * Open a recovery window without consuming content consent or touching the
 * Telegram composer. The account owner may inspect (and, if they choose,
 * manually repair) the visible UI. Runtime-side work is limited to canonical
 * account navigation, bring-to-front, a bounded wait, and structural auth/UI
 * readback; it never clicks, types, clears, or claims a repair succeeded.
 */
const runInspectCommand = async (identity, options, environment = process.env, dependencies = {}) => {
  const inspectOptions = { ...options, headed: true };
  const browserRunner = dependencies.withTelegramBrowser || withTelegramBrowser;
  const openHome = dependencies.openTelegramHome || openTelegramHome;
  const classifySurface = dependencies.classifyTelegramSurface || classifyTelegramSurface;
  const readAccountDigest = dependencies.readCurrentTelegramAccountDigest || readCurrentTelegramAccountDigest;
  const waitForInspection = dependencies.waitForInspection
    || ((page, holdMs) => page.waitForTimeout(holdMs));
  const emitInspectionEvent = dependencies.emitInspectionEvent
    || ((payload) => process.stderr.write(`${JSON.stringify(payload)}\n`));
  return browserRunner(identity, inspectOptions, async ({ page }) => {
    const initialSurface = await openHome(page, inspectOptions, { allowLoggedOut: true });
    if (!initialSurface.loggedIn && !initialSurface.locked) {
      fail(
        "TELEGRAM_WEB_LOGIN_REQUIRED",
        `Telegram Web account slot ${options.account} is not authenticated. Use headed login before inspect; inspect never performs login.`,
        { accountSlot: options.account },
      );
    }
    const initialDigest = initialSurface.loggedIn
      ? await readAccountDigest(page, options.account)
      : null;
    inspectOptions.commandLifecycle?.beginOwnerHandoff(options.holdMs, "inspection owner handoff deadline");
    await page.bringToFront();
    const canonicalHomeUrl = telegramWebUrlForAccount(options.account);
    emitInspectionEvent({
      ok: true,
      event: "TELEGRAM_WEB_MANUAL_INSPECTION_READY",
      command: "inspect",
      accountSlot: options.account,
      canonicalHomeUrl,
      visibleSlotProof: options.account === 1
        ? "The canonical address bar has no account query for slot 1."
        : `The canonical address bar contains the exact account=${options.account} query.`,
      action: "Inspect the visible dedicated Telegram Web composer. Any repair is your manual action; the runtime will not click, type, or clear anything.",
      timeoutMs: options.holdMs,
      repairVerified: false,
    });
    await waitForInspection(page, options.holdMs);
    assertTrustedPage(page, options.account);
    const finalSurface = await classifySurface(page);
    if (!finalSurface?.supported) {
      fail("TELEGRAM_WEB_UI_UNSUPPORTED", "Telegram Web did not expose a supported authentication or chat surface after the manual inspection window.");
    }
    if (finalSurface.loggedIn) {
      const finalDigest = await readAccountDigest(page, options.account);
      if (initialDigest && finalDigest !== initialDigest) {
        fail("TELEGRAM_WEB_ACCOUNT_CHANGED", "The Telegram account identity changed during the headed inspection window; no repair state was asserted.");
      }
    }
    return withPublicAccountSlot({
      ok: true,
      command: "inspect",
      headed: true,
      dedicatedProfile: true,
      canonicalHomeUrl,
      visibleSlotProof: options.account === 1
        ? "canonical_slot_1_has_no_account_query"
        : `canonical_query_account_${options.account}`,
      runtimeReadOnly: true,
      runtimeMutationsPerformed: false,
      contentConsentRequired: false,
      contentConsentChecked: false,
      initialSurface: publicInspectionSurface(initialSurface),
      finalSurface: publicInspectionSurface(finalSurface),
      inspectionWindowOutcome: "hold_elapsed",
      repairState: "not_asserted",
      repairVerified: false,
    }, options.account);
  }, environment);
};

const readConfiguredAccountCount = async (page) => page.evaluate(async () => {
  const unknown = () => ({ known: false, count: 0, activeIdentityPresent: null });
  if (typeof globalThis.AccountController?.get !== "function") return unknown();
  let count = 0;
  for (let slot = 1; slot <= 4; slot += 1) {
    let record;
    try {
      record = await globalThis.AccountController.get(slot);
    } catch {
      // AccountController.get normally returns {} for an absent slot. A
      // rejection is provider-state uncertainty, never proof of absence.
      return unknown();
    }
    if (!record || typeof record !== "object" || Array.isArray(record)) return unknown();
    const prototype = Object.getPrototypeOf(record);
    if (prototype !== Object.prototype && prototype !== null) return unknown();
    if (Object.keys(record).length === 0) continue;
    const rawUserId = record.userId;
    if (typeof rawUserId !== "number"
      || !Number.isSafeInteger(rawUserId)
      || rawUserId <= 0) return unknown();
    count += 1;
  }
  const activeIdentity = globalThis.rootScope?.myId;
  const activeIdentityAbsent = activeIdentity === undefined
    || activeIdentity === null
    || activeIdentity === 0;
  if (!activeIdentityAbsent && (
    typeof activeIdentity !== "number"
    || !Number.isSafeInteger(activeIdentity)
    || activeIdentity <= 0
  )) return unknown();
  return { known: true, count, activeIdentityPresent: !activeIdentityAbsent };
});

const requireVerifiedLoggedOutProviderState = async (page) => {
  const loggedOutState = await readConfiguredAccountCount(page);
  if (!loggedOutState?.known
    || loggedOutState.count !== 0
    || loggedOutState.activeIdentityPresent !== false) {
    fail("TELEGRAM_WEB_UI_UNSUPPORTED", "Telegram Web did not prove zero configured accounts and no valid active account identity.");
  }
  return loggedOutState;
};

const runLogoutCommand = async (identity, options, environment = process.env, dependencies = {}) => {
  const logoutOptions = { ...options, headed: true };
  const browserRunner = dependencies.withTelegramBrowser || withTelegramBrowser;
  return browserRunner(identity, logoutOptions, async ({ page }) => {
    const surface = await openTelegramHome(page, logoutOptions, { allowLoggedOut: true });
    if (surface.locked) {
      fail("TELEGRAM_WEB_UNLOCK_REQUIRED", "Telegram Web is passcode-locked. Run headed login and unlock it personally before account-bound logout; the runtime never reads or types the passcode.");
    }
    if (!surface.loggedIn) {
      await requireVerifiedLoggedOutProviderState(page);
      await revokeConsent(identity, environment);
      await invalidatePendingApproval(identity, environment);
      return withPublicAccountSlot({
        ok: true,
        command: "logout",
        loggedIn: false,
        alreadyLoggedOut: true,
        verified: true,
      }, options.account);
    }
    const configuredAccounts = await readConfiguredAccountCount(page);
    if (!configuredAccounts?.known || configuredAccounts.count < 1) {
      fail("TELEGRAM_WEB_UI_UNSUPPORTED", "Telegram Web could not verify the official multi-account controller before logout.");
    }
    if (configuredAccounts.count > 1) {
      fail(
        "TELEGRAM_WEB_UNSUPPORTED_OPERATION",
        "Account-specific runtime logout is not verified for a multi-account Telegram Web profile because official slot numbers can shift. Log out from the visible Telegram UI or use forget to remove the entire local connection profile.",
        { operation: "logout", fallbackEligible: false },
      );
    }
    options.currentAccountDigest = await readCurrentTelegramAccountDigest(page, options.account);
    logoutOptions.currentAccountDigest = options.currentAccountDigest;
    const preview = await assertStructuralApproval(logoutOptions, {});
    if (preview) return preview;
    await assertSelectedAccountUnchanged(page, logoutOptions, "logout action");
    await consumeStructuralApproval(logoutOptions);
    logoutOptions.commandLifecycle?.markDecisive("headed account-owner logout handoff");
    logoutOptions.commandLifecycle?.beginOwnerHandoff(options.holdMs, "logout owner handoff deadline");
    await page.bringToFront();
    // Logout is intentionally an account-owner handoff in 1.0.2. Web K does
    // not expose a stable, source-verified single-account logout action across
    // its settings variants, so the runtime never pretends that waiting alone
    // performed a click. The owner completes it in the visible dedicated UI.
    process.stderr.write(`${JSON.stringify({
      ok: true,
      event: "TELEGRAM_WEB_USER_ACTION_REQUIRED",
      command: "logout",
      accountSlot: options.account,
      action: "Complete logout in the visible dedicated Telegram Web window.",
      timeoutMs: options.holdMs,
    })}\n`);
    try {
      // Logout is also available before content consent. Reuse the exact
      // authenticated-surface selector shared by the canonical classifier;
      // a composer-only authenticated page plus a broad canvas must never be
      // mistaken for a completed logout.
      await waitForVerifiedLoggedOutSurface(page, options.holdMs);
    } catch {
      // Revoke while the same profile lock is still held. The operation is
      // ambiguous and its one-use approval remains consumed.
      await revokeConsent(identity, environment).catch(() => undefined);
      mutationAmbiguous("Telegram Web logout was not verifiably completed in the visible dedicated browser.");
    }
    await revokeConsent(identity, environment);
    await invalidatePendingApproval(identity, environment);
    return withPublicAccountSlot({
      ok: true,
      command: "logout",
      scope: "selected_account_slot",
      loggedIn: false,
      verified: true,
      performedBy: "account-owner-in-headed-telegram-web",
    }, options.account);
  }, environment);
};

const runForgetCommand = async (identity, options, environment = process.env, dependencies = {}) => {
  const locations = runtimeLocations(identity, environment);
  return acquireProfileLock(identity, async () => {
    const preview = await assertStructuralApproval(options, {});
    if (preview) return preview;
    await consumeStructuralApproval(options);
    const metadata = await lstat(locations.browserDirectory).catch((error) => {
      if (error?.code === "ENOENT") return null;
      throw error;
    });
    if (metadata) {
      if (metadata.isSymbolicLink() || !metadata.isDirectory()) fail("TELEGRAM_WEB_UNSAFE_STATE", "Telegram Web browser state path has an unsafe type.");
      const relative = path.relative(locations.root, locations.browserDirectory);
      if (relative !== "browser") fail("TELEGRAM_WEB_UNSAFE_PATH", "Telegram Web browser state escaped its exact connection root.");
      await assertRealPrivateDirectory(locations.browserDirectory, false, environment);
      await removeOwnedDirectoryByRename({ path: locations.browserDirectory, identity: metadata }, environment, {
        changedCode: "TELEGRAM_WEB_FORGET_REPAIR_REQUIRED",
        changedMessage: "Telegram Web browser state changed identity during forget; no replacement directory was recursively removed.",
        dependencies,
      });
      if (await lstat(locations.browserDirectory).catch(() => null)) {
        fail("TELEGRAM_WEB_UNSAFE_STATE", "Telegram Web could not verify removal of its exact local browser state.");
      }
    }
    await revokeConsent(identity, environment);
    await removePrivateStateFile(locations.accountFile, environment);
    await invalidatePendingApproval(identity, environment);
    return {
      ok: true,
      command: "forget",
      scope: "browser_auth_profile_all_account_slots_and_named_authorization_state",
      profileRemoved: true,
      downloadStagingRemoved: true,
      consentRevoked: true,
      removedState: ["browser", "consent", "account_preference", "pending_approval"],
      retainedState: ["local_send_policy", "consent_revocation_tombstone", "connection_directories"],
      recoverable: false,
    };
  }, environment);
};

const UNSUPPORTED_PILOT_OPERATIONS = new Set([
  "admin-action",
  "bot-command",
  "bulk-mutation",
  "call",
  "chat-update",
  "create-group",
  "dice-media",
  "forward",
  "markdown-rich-text",
  "member-add",
  "member-remove",
  "members",
  "message-splitting",
  "migrated-peer-send",
  "mini-app",
  "non-chat-surface",
  "paid-message",
  "payment",
  "react",
  "topic-monoforum",
  "watch-loop",
]);

const VERIFIED_PILOT_OPERATIONS = Object.freeze([
  "inspect", "dialogs", "read", "search", "unread", "watch", "download", "send", "reply",
  "edit", "delete", "archive", "unarchive", "mute", "unmute", "pin",
  "unpin", "mark-unread", "create-direct",
]);

const validateNodeRuntime = () => {
  if (Number(process.versions.node.split(".")[0]) < 22) {
    fail("TELEGRAM_WEB_UNSUPPORTED_ENVIRONMENT", "Telegram Web runtime requires local Node.js 22 or newer.");
  }
};

const validateSupportedPlatform = (platform = process.platform) => {
  if (platform !== "darwin") {
    fail(
      "TELEGRAM_WEB_UNSUPPORTED_OPERATION",
      "Telegram Web 1.0.2 is qualified only for a local macOS host; this OS lane is disabled fail-closed.",
      { operation: "unsupported-platform", fallbackEligible: true, platform },
    );
  }
  return platform;
};

export const runCli = async (argv = process.argv.slice(2), environment = process.env, dependencies = {}) => {
  const options = parseArguments(argv);
  if (options.command === "help") return withPublicAccountSlot({ ok: true, command: "help", usage: usage() }, null);
  // Keep unqualified OS lanes out before doctor/bootstrap can materialize
  // cache/profile state. Unit regressions inject an explicit supported lane;
  // the executable path always uses the actual process platform.
  validateSupportedPlatform(dependencies.platform ?? process.platform);
  const identity = requireRuntimeIdentity(environment);
  options.runtimeIdentityObject = identity;
  options.runtimeIdentityBinding = runtimeApprovalIdentityBinding(identity);
  options.approvalContext = {
    pendingApprovalFile: runtimeLocations(identity, environment).pendingApprovalFile,
    configHome: resolveConfigHome(environment),
    environment,
  };
  if (options.command === "doctor") return withPublicAccountSlot(await runDoctorCommand(identity, environment), null);
  validateNodeRuntime();
  if (options.command === "bootstrap") return withPublicAccountSlot(await bootstrapBrowserRuntime(identity, environment), null);
  if (options.command === "policy") return withPublicAccountSlot(await runPolicyCommand(identity, options, environment), null);

  if (UNSUPPORTED_PILOT_OPERATIONS.has(options.command)) {
    fail(
      "TELEGRAM_WEB_UNSUPPORTED_OPERATION",
      `${options.command} is not in the verified Telegram Web 1.0.2 pilot mutation surface. Use telegram-mtproto only when integration routing permits fallback.`,
      { operation: options.command, fallbackEligible: true },
    );
  }
  if (["reply", "create-direct"].includes(options.command) && options.files.length) {
    const operation = options.command === "reply" ? "reply-file" : "create-direct-file";
    fail(
      "TELEGRAM_WEB_UNSUPPORTED_OPERATION",
      `${options.command} does not accept files in the verified 1.0.2 document lane. Use one separate exact send --file operation.`,
      { operation, fallbackEligible: true },
    );
  }
  if (options.command === "watch" && (options.iterations !== 1 || options.providedFlags.has("--interval-ms"))) {
    fail(
      "TELEGRAM_WEB_UNSUPPORTED_OPERATION",
      "Long-running in-process Telegram Web watch loops are unsupported because they would hold the profile lock and delay consent revocation. Use one bounded watch snapshot and schedule a fresh invocation externally.",
      { operation: "watch-loop", fallbackEligible: false },
    );
  }
  // These connection-wide privacy controls must remain available even when a
  // corrupt or hostile account preference file prevents selecting a slot.
  if (options.command === "forget") return withPublicAccountSlot(await runForgetCommand(identity, options, environment), null);
  if (options.command === "consent" && options.subcommand === "revoke") {
    if (!options.confirm) fail("TELEGRAM_WEB_CONFIRMATION_REQUIRED", "consent revoke requires --confirm.");
    await revokeConsent(identity, environment);
    return withPublicAccountSlot({ ok: true, command: "consent", subcommand: "revoke", revoked: true }, null);
  }

  options.account = await resolvePreferredAccount(identity, options, environment);

  if (options.command === "login") return runLoginCommand(identity, options, environment);
  if (options.command === "inspect") return runInspectCommand(identity, options, environment, dependencies);
  if (options.command === "logout") {
    await ensureApprovalRequestDigest(options);
    if (!options.dryRun) {
      if (!options.confirm || !options.approvalHash) {
        fail("TELEGRAM_WEB_APPROVAL_REQUIRED", "Logout requires a fresh --dry-run followed by exact --confirm --approval-hash.");
      }
      await validatePendingApprovalRequest(options);
    }
    return runLogoutCommand(identity, options, environment, dependencies);
  }
  if (options.command === "probe" || options.command === "access-status") {
    return runProbeCommand(identity, options, environment, dependencies);
  }

  if (options.command === "consent") {
    if (!["status", "accept", "revoke"].includes(options.subcommand)) fail("TELEGRAM_WEB_INVALID_ARGUMENT", "consent requires status, accept, or revoke.");
    if (!await hasPinnedPlaywright(identity, environment) || !await findChromeExecutable(environment)) {
      if (options.subcommand === "status") {
        return withPublicAccountSlot({
          ok: true,
          command: "consent",
          subcommand: "status",
          valid: false,
          reason: "bootstrap_required",
        }, options.account);
      }
      await bootstrapBrowserRuntime(identity, environment);
    }
    const consentResult = await withTelegramBrowser(identity, options, async ({ page }) => {
      const surface = await openTelegramHome(page, options, { allowLoggedOut: true });
      if (!surface.loggedIn) return { digest: null };
      const digest = await readCurrentTelegramAccountDigest(page, options.account);
      if (options.subcommand === "accept") {
        // Keep the exact profile lock for the complete loopback consent flow,
        // including the atomic private write. Revoke/logout/forget therefore
        // cannot race a delayed valid browser submission and be resurrected.
        await acceptConsentInProtectedBrowser(identity, digest, environment, {
          commandLifecycle: options.commandLifecycle,
        });
        await invalidatePendingApproval(identity, environment);
      }
      return {
        digest,
        status: await renderConsentStatus(identity, digest, new Date(), environment),
      };
    }, environment);
    if (!consentResult.digest) {
      if (options.subcommand === "status") return withPublicAccountSlot({
        ok: true,
        command: "consent",
        subcommand: "status",
        valid: false,
        reason: "login_required",
      }, options.account);
      fail("TELEGRAM_WEB_LOGIN_REQUIRED", "Login to the selected Telegram account before accepting protected processing consent.");
    }
    return withPublicAccountSlot({
      ok: true,
      command: "consent",
      subcommand: options.subcommand,
      ...consentResult.status,
    }, options.account);
  }

  if (!CONTENT_COMMANDS.has(options.command)) fail("TELEGRAM_WEB_UNSUPPORTED_COMMAND", `Unsupported Telegram Web command: ${options.command}.`);
  for (const chat of options.chats || []) {
    if (normalizeChatReference(chat, options.account).kind === "title") {
      fail(
        "TELEGRAM_WEB_AMBIGUOUS_CHAT",
        "Telegram Web cannot prove title uniqueness. Run dialogs to discover the exact provider PeerId, then retry with that PeerId, a canonical Web K URL, or saved-messages.",
      );
    }
  }
  // Local five-field/tombstone/expiry validation is deliberately outside the
  // persistent-profile lock and before Chrome launch. A denied grant must not
  // restore a Telegram page or emit any Telegram network request.
  await requireLocalConsentPreflight(identity, environment);
  // Bind every mutation request to its dry-run envelope before Chrome launch.
  // This must precede even a read-only destination navigation because opening
  // a changed chat or loading extra history can create ordinary read effects.
  await preflightContentMutationApproval(identity, options, environment);
  // Reject an unsafe shared output directory before acquiring the persistent
  // profile lock or launching Chrome. The in-browser download path repeats
  // this check immediately before resolving/clicking the exact attachment.
  if (options.command === "download") {
    if (!options.messageId || !options.output) fail("TELEGRAM_WEB_INVALID_ARGUMENT", "download requires --message-id and --output.");
    await ensureOutputPathAvailable(options.output, environment);
  }
  options.blockAccountWideMessageSearch = true;
  const contentBrowserRunner = dependencies.withTelegramBrowser || withTelegramBrowser;
  return contentBrowserRunner(identity, options, async ({ page }) => {
    let digest = null;
    if (page.url() !== "about:blank") {
      assertTrustedPage(page, options.account);
      const restoredSurface = await classifyTelegramSurface(page);
      if (restoredSurface.loggedIn) {
        digest = await readCurrentTelegramAccountDigest(page, options.account);
        await requireValidConsent(identity, digest, environment);
      }
    }
    await openTelegramHome(page, options);
    const currentDigest = await readCurrentTelegramAccountDigest(page, options.account);
    if (digest && currentDigest !== digest) {
      fail("TELEGRAM_WEB_ACCOUNT_CHANGED", "The active Telegram account changed while binding the restored page to local consent.");
    }
    digest = currentDigest;
    await requireValidConsent(identity, currentDigest, environment);
    options.currentAccountDigest = digest;
    let result;
    switch (options.command) {
      case "dialogs": result = await runDialogsCommand(page, options); break;
      case "read": result = await runReadCommand(page, options, requireExactlyOneChat(options)); break;
      case "search": result = await runSearchCommand(page, options); break;
      case "unread": result = await runUnreadCommand(page, options); break;
      case "watch": result = await runWatchCommand(page, options, async () => {
        const currentDigest = await readCurrentTelegramAccountDigest(page, options.account);
        if (currentDigest !== digest) fail("TELEGRAM_WEB_ACCOUNT_CHANGED", "The active Telegram account changed during watch.");
        await requireValidConsent(identity, currentDigest, environment);
      }); break;
      case "download": result = await runDownloadCommand(page, identity, options); break;
      case "send": result = await runSendCommand(page, identity, options); break;
      case "reply": {
        if (!options.messageId) fail("TELEGRAM_WEB_INVALID_ARGUMENT", "reply requires --message-id.");
        result = await runSendCommand(page, identity, options, { replyTo: options.messageId });
        break;
      }
      case "edit": result = await runEditCommand(page, identity, options); break;
      case "delete": result = await runDeleteCommand(page, identity, options); break;
      case "create-direct": result = await runCreateDirectCommand(page, identity, options); break;
      case "archive":
      case "unarchive":
      case "mute":
      case "unmute":
      case "pin":
      case "unpin":
      case "mark-unread": result = await runDialogAction(page, identity, options); break;
      default: fail("TELEGRAM_WEB_UNSUPPORTED_OPERATION", `${options.command} is not implemented by this runtime release.`);
    }
    await assertAccountWideMessageSearchGuardClean(page, options.accountWideMessageSearchGuardToken);
    // Never release content collected under one account after Telegram Web
    // silently switched the selected account mid-command. This postcondition
    // runs before stdout receives any result payload.
    const finalDigest = await readCurrentTelegramAccountDigest(page, options.account);
    if (finalDigest !== digest) fail("TELEGRAM_WEB_ACCOUNT_CHANGED", "The active Telegram account changed before the operation result could be released.");
    await requireValidConsent(identity, finalDigest, environment);
    return withPublicAccountSlot(result, options.account);
  }, environment);
};

// Export narrowly scoped internals for deterministic security regressions.
// The signed runtime does not call this object at run time; keeping the exact
// helpers testable prevents browser/UI drift from silently weakening a gate.
export const __testing = Object.freeze({
  acquireProfileLock,
  approvalRecordValidShape,
  armInChatSearchCompletion,
  bindInChatSearchResults,
  bindExactDialogRowLocator,
  boundedPageProxy,
  buildDialogsResult,
  assertExactEditComposer,
  assertExactDocumentPopupState,
  assertEntityFreeDocumentCaption,
  assertAccountWideMessageSearchGuardClean,
  assertFinalPlainTextModelEntities,
  assertExactProductionTextPayload,
  assertExactTextSendDestination,
  assertLiveSingleMessageLimit,
  assertNoPaidMessageCost,
  assertOpenPeer,
  assertOutgoingComposerSafe,
  assertPlainEditableSourceModel,
  assertSafeMutationPeer,
  assertOutsideManagedTelegramNamespaces,
  assertStructuralApproval,
  assertTrustedPosixExecutableChain,
  buildApprovalOperation,
  blockedNavigationError,
  canonicalPathThroughExistingAncestor,
  clearExactRuntimeComposer,
  closePersistentContextVerified,
  capturedBrowserProcessGroupAlive,
  collectDialogRows,
  collectLocalDialogModels,
  collectMessages,
  consumePendingApproval,
  consumeStructuralApproval,
  createCommandLifecycle,
  createApprovalMaterial,
  dispatchDecisiveMutation,
  digestTrustedPackageTree,
  deriveLiveWebKAutomaticEntities,
  captureExactDocumentPopup,
  clearExactRuntimeDocumentPopup,
  installPlaywrightCommonJsLoadGuard,
  ensurePrivateTree,
  ensureDedicatedBaseDirectory,
  ensureOutputPathAvailable,
  exactPathIdentity,
  findChromeExecutable,
  assertTrustedDownloadOutputParent,
  inspectPinnedPlaywright,
  inspectPinnedPlaywrightRoot,
  launchPersistentContextWithProcess,
  loadPlaywright,
  inChatSearchIncompleteReasons,
  inspectAccountWideMessageSearchGuard,
  installAccountWideMessageSearchGuard,
  invalidatePendingApproval,
  openDialogContextMenu,
  openTelegramHome,
  openInChatSearch,
  openMessageContextMenu,
  openNewVisiblePopup,
  prepareSinglePersistentPage,
  prepareInputFiles,
  publicMessage,
  readRegularFileSnapshot,
  requireLocalConsentPreflight,
  readAuthoritativeDialogState,
  readBoundedDecisiveSurface,
  readConfiguredAccountCount,
  readExactMessageArtifacts,
  removeLockIfUnchanged,
  removeOwnedDirectoryByRename,
  removePrivateStateFile,
  resolveDialog,
  resolveCacheHome,
  resolveConfigHome,
  revokeConsent,
  resetDownloadStaging,
  resetInChatSearch,
  refreshAccountWideMessageSearchGuard,
  requireVerifiedLoggedOutProviderState,
  runForgetCommand,
  runInspectCommand,
  runLoginCommand,
  runOneExactChatSearch,
  runSearchCommand,
  sanitizeDisplayLabel,
  sanitizeBootstrapEnvironment,
  validateDedicatedBase,
  validateSupportedPlatform,
  validatePendingApproval,
  selectExactDocumentSnapshot,
  sendExactDocumentFromComposer,
  boundMultiChatSearchResult,
  boundStructuredResult,
  waitForFinalDocumentMessageModel,
  waitForVerifiedEdit,
  waitForVerifiedArchiveState,
  waitForVerifiedDialogState,
  waitForVerifiedOutgoing,
  waitForExactOpenPeer,
  waitForInChatSearchCompletion,
  waitForAuthenticatedTelegramAccount,
  waitForVerifiedLoggedOutSurface,
  verifyExactRuntimeRootShape,
  withValidConsentLease,
  withPublicAccountSlot,
});

const emitCliError = (error) => {
  const known = error instanceof TelegramWebRuntimeError;
  const payload = {
    ok: false,
    code: known ? error.code : "TELEGRAM_WEB_INTERNAL_ERROR",
    message: known ? error.message : "Telegram Web runtime stopped on an unexpected local error.",
    ...(known && error.details !== undefined ? { details: error.details } : {}),
  };
  process.stderr.write(`${JSON.stringify(payload)}\n`);
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runCli().then(
    (result) => process.stdout.write(`${JSON.stringify(result)}\n`),
    (error) => {
      emitCliError(error);
      process.exitCode = 1;
    },
  );
}
