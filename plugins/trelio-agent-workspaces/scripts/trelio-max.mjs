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
const ADAPTER_VERSION = "1";
const MAX_UI_READY_TIMEOUT_MS = 10_000;

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
    message: "",
    messageFile: "",
    file: "",
    limit: 20,
    confirm: false,
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
    else if (argument === "--message") options.message = value();
    else if (argument === "--message-file") options.messageFile = path.resolve(value());
    else if (argument === "--file") options.file = path.resolve(value());
    else if (argument === "--limit") options.limit = Number(value());
    else if (argument === "--confirm") options.confirm = true;
    else if (argument === "--help" || argument === "-h") options.command = "help";
    else throw new Error(`Unknown argument: ${argument}`);
  }

  if (!options.companyId || !options.memberId || !options.connectionId) {
    throw new Error("--company-id, --member-id and --connection-id are required.");
  }
  options.companyId = normalizeIdentityPart(options.companyId, "company-id");
  options.memberId = normalizeIdentityPart(options.memberId, "member-id");
  options.connectionId = normalizeIdentityPart(options.connectionId, "connection-id");
  if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 100) {
    throw new Error("--limit must be an integer from 1 to 100.");
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
  trelio-max.mjs --company-id UUID --member-id UUID --connection-id UUID read --chat "Название" --limit 20
  trelio-max.mjs --company-id UUID --member-id UUID --connection-id UUID send --chat "Название" --message "Текст" --confirm
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

const collectDialogResults = (page, query) => page.evaluate((needle) => {
  const normalized = String(needle || "").toLowerCase();
  const nodes = Array.from(document.querySelectorAll('a, button, [role="button"], [role="option"], [role="listitem"]'));
  const results = [];
  for (const node of nodes) {
    const visibleLines = String(node.innerText || "")
      .split(/\n+/u)
      .map((line) => line.replace(/\s+/gu, " ").trim())
      .filter(Boolean);
    const text = visibleLines.join(" ");
    // MAX search can return several messages from one dialog. Match and
    // de-duplicate by the visible dialog title so one chat is not reported as
    // an ambiguous reference merely because several messages matched.
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
    if (!text || !title || text.length > 500 || !title.toLowerCase().includes(normalized)) continue;
    if (rect.width < 20 || rect.height < 10 || style.display === "none" || style.visibility === "hidden") continue;
    if (results.some((item) => item.title.toLowerCase() === title.toLowerCase())) continue;
    node.setAttribute("data-trelio-max-dialog", String(results.length));
    results.push({ index: results.length, title, text });
    if (results.length >= 20) break;
  }
  return results;
}, query);

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

const visibleMessages = (page, limit) => page.evaluate((maxCount) => {
  const nodes = Array.from(document.querySelectorAll(
    '[class*="message" i], [data-testid*="message" i], [aria-label*="сообщ" i], [aria-label*="message" i]',
  ));
  const results = [];
  const seen = new Set();
  for (const node of nodes) {
    if (!(node instanceof HTMLElement)) continue;
    const rect = node.getBoundingClientRect();
    const style = window.getComputedStyle(node);
    const text = (node.innerText || node.textContent || "").replace(/\s+/gu, " ").trim();
    if (!text || text.length > 4_000 || rect.width < 40 || rect.height < 12) continue;
    if (style.display === "none" || style.visibility === "hidden") continue;
    if (window.innerWidth >= 900 && rect.right < window.innerWidth * 0.28) continue;
    if (seen.has(text)) continue;
    seen.add(text);
    results.push({ text });
  }
  return results.slice(-maxCount);
}, limit);

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

const outgoingMessage = (options) => {
  if (options.messageFile) {
    ensurePrivateFile(options.messageFile);
    return fs.readFileSync(options.messageFile, "utf8");
  }
  return options.message;
};

const uploadFile = async (page, file, timeoutMs) => {
  const inputs = page.locator('input[type="file"]');
  if (await inputs.count()) {
    await inputs.last().setInputFiles(file, { timeout: timeoutMs });
    return;
  }
  const button = page.getByRole("button", { name: /загрузить|прикрепить|attach|файл/iu }).last();
  const chooserPromise = page.waitForEvent("filechooser", { timeout: timeoutMs });
  await button.click({ timeout: timeoutMs });
  const chooser = await chooserPromise;
  await chooser.setFiles(file);
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
    args: ["--no-first-run", "--disable-blink-features=AutomationControlled"],
  });
  try {
    const page = context.pages()[0] || await context.newPage();
    return await callback(page);
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

const runBrowserCommand = async (options) => withBrowser(options, async (page) => {
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
      diagnosticPolicy: "No chat text, message text, cookies or credentials are included.",
    };
  }
  if (options.command === "dialogs") {
    if (!options.query) throw new Error("dialogs requires --query.");
    await openHome(page, options);
    const search = await findSearchInput(page, options.timeoutMs);
    await fillLocator(search, options.query, page);
    await page.waitForTimeout(1_800);
    return { query: options.query, dialogs: await collectDialogResults(page, options.query) };
  }
  if (options.command === "read") {
    if (!options.chat) throw new Error("read requires --chat.");
    const opened = await openChat(page, options);
    return {
      opened,
      messages: await visibleMessages(page, options.limit),
      note: "Only currently visible MAX messages are returned.",
      securityBoundary: "chat-only",
    };
  }
  if (options.command === "send") {
    if (!options.chat) throw new Error("send requires --chat.");
    const message = outgoingMessage(options);
    if (!message && !options.file) throw new Error("send requires --message, --message-file or --file.");
    if (options.file && (!fs.existsSync(options.file) || !fs.statSync(options.file).isFile())) {
      throw new Error(`Attachment was not found: ${options.file}`);
    }
    const policyMode = assertSendAllowed(options);
    const opened = await openChat(page, options);
    if (options.file) await uploadFile(page, options.file, options.timeoutMs);
    const composer = message ? await findComposer(page) : null;
    if (message) await fillLocator(composer, message, page);
    const method = await sendCurrentComposer(page, options.timeoutMs, Boolean(message));
    await page.waitForTimeout(1_200);
    const verification = message
      ? await verifyTextSend(page, composer, message, options.timeoutMs)
      : "attachment-dispatched-without-text-verification";
    return {
      sent: true,
      opened,
      policyMode,
      method,
      verification,
      retryPolicy: "Do not retry automatically after an ambiguous failure.",
    };
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
  output({ ok: true, ...(await runBrowserCommand(options)) });
};

export {
  ADAPTER_VERSION,
  assertSendAllowed,
  connectionRoot,
  loadPolicy,
  normalizeDialogTitle,
  openHome,
  parseArguments,
  policyPath,
  selectExactDialogResult,
  writePrivateJson,
};

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    output({ ok: false, error: error instanceof Error ? error.message : String(error) });
    process.exitCode = 2;
  });
}
