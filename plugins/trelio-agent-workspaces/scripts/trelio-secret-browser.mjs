import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const DEVTOOLS_ACTIVE_PORT_FILE = "DevToolsActivePort";
const DEFAULT_BROWSER_START_TIMEOUT_MS = 15_000;
const DEFAULT_FILL_TIMEOUT_MS = 60_000;
const DEVTOOLS_REQUEST_TIMEOUT_MS = 10_000;
const CONTROLLER_WORLD_NAME = "trelio-secret-browser";
const SAFE_REASON_CODES = new Set([
  "adapter_error",
  "browser_closed",
  "browser_unavailable",
  "field_ambiguous",
  "field_not_found",
  "field_selector_invalid",
  "field_write_failed",
  "target_origin_changed",
  "target_url_changed",
  "timeout",
]);

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export class SecretBrowserFillError extends Error {
  constructor(message, reasonCode = "adapter_error", options = undefined) {
    super(message, options);
    this.reasonCode = SAFE_REASON_CODES.has(reasonCode) ? reasonCode : "adapter_error";
  }
}

const hashSecretBrowserTargetUrl = (targetUrl) => (
  crypto.createHash("sha256").update(targetUrl, "utf8").digest("hex")
);

export const normalizeSecretBrowserTarget = (rawTargetUrl, expectedOrigin, expectedUrlSha256) => {
  let targetUrl;
  try {
    targetUrl = new URL(String(rawTargetUrl || ""));
  } catch {
    throw new SecretBrowserFillError("Browser fill target URL некорректен.", "target_origin_changed");
  }
  if (
    targetUrl.protocol !== "https:"
    || targetUrl.username
    || targetUrl.password
    || targetUrl.toString().length > 2048
    || targetUrl.origin !== expectedOrigin
  ) {
    throw new SecretBrowserFillError(
      "Browser fill target не совпадает с HTTPS origin одноразового grant.",
      "target_origin_changed",
    );
  }
  const normalizedTargetUrl = targetUrl.toString();
  if (
    !/^[0-9a-f]{64}$/u.test(String(expectedUrlSha256 || ""))
    || hashSecretBrowserTargetUrl(normalizedTargetUrl) !== expectedUrlSha256
  ) {
    throw new SecretBrowserFillError(
      "Browser fill target не совпадает с exact URL одноразового grant.",
      "target_url_changed",
    );
  }
  return normalizedTargetUrl;
};

export const normalizeSecretBrowserFieldSelector = (rawSelector) => {
  const selector = String(rawSelector || "").trim();
  if (!selector || selector.length > 512 || /[\0-\x1f\x7f]/u.test(selector)) {
    throw new SecretBrowserFillError(
      "Browser fill field selector некорректен.",
      "field_selector_invalid",
    );
  }
  return selector;
};

const candidateBrowserPaths = ({ platform, environment }) => {
  if (platform === "darwin") {
    return [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
    ];
  }
  if (platform === "win32") {
    const roots = [
      environment.PROGRAMFILES,
      environment["PROGRAMFILES(X86)"],
      environment.LOCALAPPDATA,
    ].filter((value) => typeof value === "string" && path.win32.isAbsolute(value));
    return roots.flatMap((root) => [
      path.win32.join(root, "Google", "Chrome", "Application", "chrome.exe"),
      path.win32.join(root, "Microsoft", "Edge", "Application", "msedge.exe"),
      path.win32.join(root, "Chromium", "Application", "chrome.exe"),
    ]);
  }
  return [
    "/usr/bin/google-chrome-stable",
    "/usr/bin/google-chrome",
    "/usr/bin/microsoft-edge-stable",
    "/usr/bin/microsoft-edge",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ];
};

export const resolveTrustedSecretBrowserExecutable = async ({
  platform = process.platform,
  environment = process.env,
  filesystem = fs,
} = {}) => {
  for (const candidate of candidateBrowserPaths({ platform, environment })) {
    const canonical = await filesystem.realpath(candidate).catch(() => null);
    if (!canonical || !path.isAbsolute(canonical)) continue;
    const metadata = await filesystem.lstat(canonical).catch(() => null);
    if (!metadata || !metadata.isFile() || metadata.isSymbolicLink()) continue;
    if (platform !== "win32" && ((metadata.mode & 0o111) === 0 || (metadata.mode & 0o022) !== 0)) continue;
    return canonical;
  }
  throw new SecretBrowserFillError(
    "Не найден поддерживаемый системный Chrome, Edge или Chromium для Trelio Secret Browser.",
    "browser_unavailable",
  );
};

// Chrome 137+ больше не принимает --load-extension в branded builds. Поэтому
// browser-fill использует одноразовый loopback DevTools transport выделенного
// профиля, а не расширение и не постоянное разрешение на все HTTPS-сайты.
export const buildSecretBrowserArguments = ({ profileDirectory }) => [
  `--user-data-dir=${profileDirectory}`,
  "--profile-directory=Default",
  "--remote-debugging-address=127.0.0.1",
  "--remote-debugging-port=0",
  "--disable-save-password-bubble",
  "--disable-sync",
  "--disable-features=PasswordManagerOnboarding",
  "--no-default-browser-check",
  "--no-first-run",
  "--new-window",
  "about:blank",
];

const prepareSecretBrowserProfile = async ({ profileDirectory, ensurePrivateDirectory }) => {
  await ensurePrivateDirectory(profileDirectory);
  const defaultProfileDirectory = path.join(profileDirectory, "Default");
  await ensurePrivateDirectory(defaultProfileDirectory);

  const preferencesPath = path.join(defaultProfileDirectory, "Preferences");
  const existingMetadata = await fs.lstat(preferencesPath).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (existingMetadata?.isSymbolicLink() || (existingMetadata && !existingMetadata.isFile())) {
    throw new SecretBrowserFillError(
      "Preferences выделенного browser-профиля имеют небезопасный тип.",
      "browser_unavailable",
    );
  }

  let preferences = {};
  if (existingMetadata) {
    try {
      preferences = JSON.parse(await fs.readFile(preferencesPath, "utf8"));
    } catch {
      throw new SecretBrowserFillError(
        "Preferences выделенного browser-профиля повреждены.",
        "browser_unavailable",
      );
    }
  }
  if (!preferences || typeof preferences !== "object" || Array.isArray(preferences)) {
    throw new SecretBrowserFillError(
      "Preferences выделенного browser-профиля имеют некорректный формат.",
      "browser_unavailable",
    );
  }

  const profileSettingsAreSafe = preferences.profile
    && typeof preferences.profile === "object"
    && !Array.isArray(preferences.profile);
  if (
    existingMetadata
    && preferences.credentials_enable_service === false
    && profileSettingsAreSafe
    && preferences.profile.password_manager_enabled === false
  ) {
    return;
  }

  preferences.credentials_enable_service = false;
  preferences.profile = profileSettingsAreSafe ? preferences.profile : {};
  preferences.profile.password_manager_enabled = false;

  const temporaryPath = `${preferencesPath}.trelio-${crypto.randomUUID()}.tmp`;
  let renamed = false;
  try {
    await fs.writeFile(temporaryPath, JSON.stringify(preferences), {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    if (process.platform !== "win32") await fs.chmod(temporaryPath, 0o600);
    await fs.rename(temporaryPath, preferencesPath);
    renamed = true;
  } finally {
    if (!renamed) await fs.unlink(temporaryPath).catch(() => undefined);
  }
};

const launchSecretBrowser = async ({ executable, args, spawnProcess = spawn }) => {
  await new Promise((resolve, reject) => {
    const child = spawnProcess(executable, args, {
      detached: true,
      shell: false,
      stdio: "ignore",
      windowsHide: false,
    });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
};

const parseDevToolsEndpoint = (contents) => {
  const [rawPort, rawWebSocketPath] = String(contents).trim().split(/\r?\n/u);
  const port = Number(rawPort);
  if (
    !Number.isInteger(port)
    || port < 1
    || port > 65_535
    || !/^\/devtools\/browser\/[A-Za-z0-9-]{8,128}$/u.test(rawWebSocketPath || "")
  ) {
    return null;
  }
  return `ws://127.0.0.1:${port}${rawWebSocketPath}`;
};

class DevToolsClient {
  constructor(socket) {
    this.socket = socket;
    this.nextRequestId = 1;
    this.pending = new Map();

    socket.addEventListener("message", (event) => {
      let message;
      try {
        message = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (!Number.isInteger(message.id)) return;
      const request = this.pending.get(message.id);
      if (!request) return;
      this.pending.delete(message.id);
      clearTimeout(request.timeoutHandle);
      if (message.error) {
        request.reject(new SecretBrowserFillError("Локальный DevTools request отклонён браузером."));
      } else {
        request.resolve(message.result || {});
      }
    });

    const rejectPending = () => {
      for (const request of this.pending.values()) {
        clearTimeout(request.timeoutHandle);
        request.reject(new SecretBrowserFillError("Trelio Secret Browser был закрыт.", "browser_closed"));
      }
      this.pending.clear();
    };
    socket.addEventListener("close", rejectPending);
    socket.addEventListener("error", rejectPending);
  }

  static async connect(webSocketUrl, timeoutMs = DEVTOOLS_REQUEST_TIMEOUT_MS) {
    if (typeof WebSocket !== "function") {
      throw new SecretBrowserFillError("Node.js runtime не поддерживает локальный WebSocket.", "browser_unavailable");
    }
    return await new Promise((resolve, reject) => {
      const socket = new WebSocket(webSocketUrl);
      const timeoutHandle = setTimeout(() => {
        socket.close();
        reject(new SecretBrowserFillError("Trelio Secret Browser не открыл DevTools transport.", "browser_unavailable"));
      }, timeoutMs);
      socket.addEventListener("open", () => {
        clearTimeout(timeoutHandle);
        resolve(new DevToolsClient(socket));
      }, { once: true });
      socket.addEventListener("error", () => {
        clearTimeout(timeoutHandle);
        reject(new SecretBrowserFillError("Trelio Secret Browser не открыл DevTools transport.", "browser_unavailable"));
      }, { once: true });
    });
  }

  request(method, params = {}, sessionId = undefined) {
    return new Promise((resolve, reject) => {
      const id = this.nextRequestId;
      this.nextRequestId += 1;
      const timeoutHandle = setTimeout(() => {
        this.pending.delete(id);
        reject(new SecretBrowserFillError("Локальный DevTools request превысил timeout."));
      }, DEVTOOLS_REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timeoutHandle });
      this.socket.send(JSON.stringify({
        id,
        method,
        params,
        ...(sessionId ? { sessionId } : {}),
      }));
    });
  }

  close() {
    this.socket.close();
  }
}

const readProfileDevToolsEndpoint = async (profileDirectory) => {
  const activePortPath = path.join(profileDirectory, DEVTOOLS_ACTIVE_PORT_FILE);
  const metadata = await fs.lstat(activePortPath).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!metadata) return null;
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new SecretBrowserFillError("DevToolsActivePort имеет небезопасный тип.", "browser_unavailable");
  }
  return parseDevToolsEndpoint(await fs.readFile(activePortPath, "utf8"));
};

const tryConnectProfileDevTools = async (profileDirectory) => {
  const endpoint = await readProfileDevToolsEndpoint(profileDirectory);
  if (!endpoint) return null;
  return await DevToolsClient.connect(endpoint, 500).catch(() => null);
};

const acquireSecretBrowser = async ({
  profileDirectory,
  args,
  resolveBrowserExecutable,
  launchBrowser,
  browserStartTimeoutMs,
}) => {
  const existingClient = await tryConnectProfileDevTools(profileDirectory);
  if (existingClient) return existingClient;

  const activePortPath = path.join(profileDirectory, DEVTOOLS_ACTIVE_PORT_FILE);
  const staleMetadata = await fs.lstat(activePortPath).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (staleMetadata) {
    if (!staleMetadata.isFile() || staleMetadata.isSymbolicLink()) {
      throw new SecretBrowserFillError("DevToolsActivePort имеет небезопасный тип.", "browser_unavailable");
    }
    await fs.unlink(activePortPath);
  }

  const executable = await resolveBrowserExecutable();
  await launchBrowser({ executable, args });

  const deadline = Date.now() + browserStartTimeoutMs;
  while (Date.now() < deadline) {
    const client = await tryConnectProfileDevTools(profileDirectory);
    if (client) return client;
    await wait(100);
  }
  throw new SecretBrowserFillError(
    "Trelio Secret Browser не открыл локальный DevTools transport.",
    "browser_unavailable",
  );
};

// Код исполняется в отдельном isolated world DevTools. Он автоматически
// разрешает exact server-bound selector, но не угадывает поле: допустимо ровно
// одно top-level совпадение. Сайт видит только значение после native setter и
// не получает handle, callback или loopback endpoint Trelio.
const installSecretBrowserController = (expectedOrigin, fieldSelector) => {
  if (globalThis.__trelioSecretBrowserController) return;

  const state = {
    status: "waiting",
    reasonCode: null,
    target: null,
  };

  const isSupportedField = (element) => {
    if (element instanceof HTMLTextAreaElement) return !element.disabled && !element.readOnly;
    if (!(element instanceof HTMLInputElement) || element.disabled || element.readOnly) return false;
    return ["email", "password", "search", "tel", "text", "url"].includes(element.type);
  };

  const isVisible = (element) => {
    if (!element.isConnected) return false;
    const box = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return box.width >= 2
      && box.height >= 2
      && style.display !== "none"
      && style.visibility !== "hidden";
  };

  const resolveTarget = () => {
    if (state.status !== "waiting") return;
    let matches;
    try {
      matches = document.querySelectorAll(fieldSelector);
    } catch {
      state.status = "failed";
      state.reasonCode = "field_selector_invalid";
      return;
    }
    if (matches.length === 0) return;
    if (matches.length !== 1) {
      state.status = "failed";
      state.reasonCode = "field_ambiguous";
      return;
    }
    const [target] = matches;
    if (!isSupportedField(target) || !isVisible(target)) return;
    state.target = target;
    state.status = "ready";
  };

  globalThis.__trelioSecretBrowserController = () => {
    resolveTarget();
    return {
      status: state.status,
      ...(state.reasonCode ? { reasonCode: state.reasonCode } : {}),
    };
  };

  globalThis.__trelioSecretBrowserApply = (value) => {
    try {
      if (location.origin !== expectedOrigin || state.status !== "ready") {
        throw new Error("origin_or_state_changed");
      }
      const target = state.target;
      let matches;
      try {
        matches = document.querySelectorAll(fieldSelector);
      } catch {
        throw new Error("selector_changed");
      }
      if (
        !target?.isConnected
        || matches.length !== 1
        || matches[0] !== target
        || !isSupportedField(target)
        || !isVisible(target)
      ) {
        throw new Error("field_changed");
      }

      const prototype = target instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
      if (typeof setter !== "function") throw new Error("setter_missing");

      setter.call(target, value);
      target.dispatchEvent(new InputEvent("input", {
        bubbles: true,
        composed: true,
        inputType: "insertText",
        data: null,
      }));
      target.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
      if (target.value !== value) throw new Error("value_not_retained");
      state.target = null;
      state.status = "succeeded";
      return { outcome: "succeeded" };
    } catch {
      state.target = null;
      state.status = "failed";
      state.reasonCode = "field_write_failed";
      return { outcome: "failed", reasonCode: state.reasonCode };
    }
  };
};

export const createSecretBrowserControllerExpression = (targetOrigin, fieldSelector) => (
  `(${installSecretBrowserController.toString()})(${JSON.stringify(targetOrigin)},${JSON.stringify(fieldSelector)})`
);

const targetOriginFromUrl = (rawUrl) => {
  try {
    return new URL(rawUrl).origin;
  } catch {
    return null;
  }
};

const readExactTargetInfo = async ({
  client,
  targetId,
  targetOrigin,
  targetUrlSha256,
  allowInitialBlank = false,
}) => {
  const { targetInfo } = await client.request("Target.getTargetInfo", { targetId });
  const currentUrl = String(targetInfo?.url || "");
  if (allowInitialBlank && currentUrl === "about:blank") return null;
  if (targetOriginFromUrl(currentUrl) !== targetOrigin) {
    throw new SecretBrowserFillError(
      "Вкладка Trelio Secret Browser ушла с закреплённого HTTPS origin.",
      "target_origin_changed",
    );
  }
  let normalizedCurrentUrl;
  try {
    normalizedCurrentUrl = new URL(currentUrl).toString();
  } catch {
    throw new SecretBrowserFillError(
      "Вкладка Trelio Secret Browser открыла некорректный URL.",
      "target_url_changed",
    );
  }
  if (hashSecretBrowserTargetUrl(normalizedCurrentUrl) !== targetUrlSha256) {
    throw new SecretBrowserFillError(
      "Вкладка Trelio Secret Browser ушла с exact URL одноразового grant.",
      "target_url_changed",
    );
  }
  return targetInfo;
};

const createControllerWorld = async ({ client, sessionId, targetOrigin, fieldSelector }) => {
  const { frameTree } = await client.request("Page.getFrameTree", {}, sessionId);
  const frameId = frameTree?.frame?.id;
  if (typeof frameId !== "string") {
    throw new SecretBrowserFillError("Не удалось определить top-level browser frame.");
  }
  const { executionContextId } = await client.request("Page.createIsolatedWorld", {
    frameId,
    worldName: CONTROLLER_WORLD_NAME,
    grantUniveralAccess: false,
  }, sessionId);
  if (!Number.isInteger(executionContextId)) {
    throw new SecretBrowserFillError("Не удалось создать изолированный browser context.");
  }
  await client.request("Runtime.evaluate", {
    contextId: executionContextId,
    expression: createSecretBrowserControllerExpression(targetOrigin, fieldSelector),
    returnByValue: true,
  }, sessionId);
  return executionContextId;
};

const evaluateController = async ({ client, sessionId, executionContextId, expression }) => {
  const response = await client.request("Runtime.evaluate", {
    contextId: executionContextId,
    expression,
    returnByValue: true,
    awaitPromise: true,
  }, sessionId);
  if (response.exceptionDetails) {
    throw new SecretBrowserFillError("Изолированный browser controller завершился ошибкой.");
  }
  return response.result?.value;
};

export const controlSecretBrowserViaDevTools = async ({
  client,
  secretValue,
  targetUrl,
  targetOrigin,
  targetUrlSha256,
  fieldSelector,
  fillTimeoutMs = DEFAULT_FILL_TIMEOUT_MS,
}) => {
  const { targetId } = await client.request("Target.createTarget", {
    url: targetUrl,
    newWindow: true,
  });
  if (typeof targetId !== "string") {
    throw new SecretBrowserFillError("Не удалось открыть вкладку Trelio Secret Browser.", "browser_unavailable");
  }
  await client.request("Target.activateTarget", { targetId });

  const deadline = Date.now() + fillTimeoutMs;
  while (Date.now() < deadline) {
    const targetInfo = await readExactTargetInfo({
      client,
      targetId,
      targetOrigin,
      targetUrlSha256,
      allowInitialBlank: true,
    });
    if (targetInfo) break;
    await wait(100);
  }
  if (Date.now() >= deadline) {
    throw new SecretBrowserFillError("Trelio Secret Browser не открыл exact target URL вовремя.", "timeout");
  }

  const { sessionId } = await client.request("Target.attachToTarget", { targetId, flatten: true });
  if (typeof sessionId !== "string") {
    throw new SecretBrowserFillError("Не удалось подключить изолированный browser controller.");
  }
  await client.request("Page.enable", {}, sessionId);
  await client.request("Runtime.enable", {}, sessionId);

  let executionContextId = await createControllerWorld({
    client,
    sessionId,
    targetOrigin,
    fieldSelector,
  });
  while (Date.now() < deadline) {
    await readExactTargetInfo({ client, targetId, targetOrigin, targetUrlSha256 });
    let state;
    try {
      state = await evaluateController({
        client,
        sessionId,
        executionContextId,
        expression: "globalThis.__trelioSecretBrowserController?.()",
      });
    } catch {
      // Exact-origin reload destroys the previous isolated world. Recreate it;
      // a cross-origin navigation is rejected above before any value is sent.
      executionContextId = await createControllerWorld({
        client,
        sessionId,
        targetOrigin,
        fieldSelector,
      });
      await wait(100);
      continue;
    }

    if (state?.status === "ready") {
      const expression = `globalThis.__trelioSecretBrowserApply(${JSON.stringify(secretValue)})`;
      const result = await evaluateController({
        client,
        sessionId,
        executionContextId,
        expression,
      }).catch(() => null);
      if (result?.outcome === "succeeded") return { outcome: "succeeded" };
      return { outcome: "failed", reasonCode: "field_write_failed" };
    }
    if (state?.status === "failed") {
      return {
        outcome: "failed",
        reasonCode: SAFE_REASON_CODES.has(state.reasonCode)
          ? state.reasonCode
          : "field_write_failed",
      };
    }
    await wait(150);
  }
  throw new SecretBrowserFillError(
    "Exact browser field не появился автоматически вовремя.",
    "field_not_found",
  );
};

export const runSecretBrowserFill = async ({
  secretValue,
  targetUrl,
  targetOrigin,
  targetUrlSha256,
  fieldSelector,
  profileDirectory,
  ensurePrivateDirectory,
  resolveBrowserExecutable = resolveTrustedSecretBrowserExecutable,
  launchBrowser = launchSecretBrowser,
  acquireBrowser = acquireSecretBrowser,
  controlBrowser = controlSecretBrowserViaDevTools,
  browserStartTimeoutMs = DEFAULT_BROWSER_START_TIMEOUT_MS,
  fillTimeoutMs = DEFAULT_FILL_TIMEOUT_MS,
}) => {
  const normalizedTargetUrl = normalizeSecretBrowserTarget(
    targetUrl,
    targetOrigin,
    targetUrlSha256,
  );
  const normalizedFieldSelector = normalizeSecretBrowserFieldSelector(fieldSelector);
  await prepareSecretBrowserProfile({ profileDirectory, ensurePrivateDirectory });
  const args = buildSecretBrowserArguments({ profileDirectory });

  let client;
  try {
    client = await acquireBrowser({
      profileDirectory,
      args,
      resolveBrowserExecutable,
      launchBrowser,
      browserStartTimeoutMs,
    });
    return await controlBrowser({
      client,
      secretValue,
      targetUrl: normalizedTargetUrl,
      targetOrigin,
      targetUrlSha256,
      fieldSelector: normalizedFieldSelector,
      fillTimeoutMs,
    });
  } catch (error) {
    if (error instanceof SecretBrowserFillError) throw error;
    throw new SecretBrowserFillError(
      "Trelio Secret Browser завершился локальной ошибкой.",
      "adapter_error",
      { cause: error },
    );
  } finally {
    client?.close?.();
  }
};
