/**
 * Built-in browser transport. Only value-free preflight can select a fallback.
 * After consume the selected native process receives values through its private
 * stdin pipe exactly once. Neither native diagnostics nor arbitrary exceptions
 * are copied into tool output. This is not a vault against other same-user code.
 */
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  normalizeSecretBrowserTarget,
  normalizeSecretBrowserFieldSelector,
  runSecretBrowserFill,
  SecretBrowserFillError,
} from "./trelio-secret-browser.mjs";

const SOURCE_DIRECTORY = fileURLToPath(new URL("./native-secret-browser/", import.meta.url));
const MAX_PROTOCOL_BYTES = 8 * 1024 * 1024;
const NATIVE_UNAVAILABLE = new Set([
  "platform_unsupported", "client_unsupported", "helper_unavailable",
  "access_required", "application_unavailable", "accessibility_unavailable",
  "selector_unsupported", "step_unsupported", "backend_unavailable",
]);

export class EmbeddedBrowserUnavailable extends SecretBrowserFillError {
  constructor(nativeReason) {
    const reason = NATIVE_UNAVAILABLE.has(nativeReason) ? nativeReason : "helper_unavailable";
    // These value-free explanations distinguish missing Run provenance from
    // an unsupported browser. Never copy native diagnostics, URLs or DOM data.
    const hint = reason === "client_unsupported"
      ? " В Agent Run нет поддерживаемого hook-verified клиента Codex/Claude Code; проверьте runtime identity Run."
      : reason === "selector_unsupported"
        ? " Native поля и submitSelector требуют точный id. Для финальной кнопки без id подготовьте заполнение без submitSelector с browser=embedded, затем нажмите заранее найденную кнопку штатным browser tool без чтения полей."
        : "";
    super("Встроенный browser transport недоступен: " + reason + "." + hint, "browser_unavailable");
    this.nativeReason = reason;
  }
}

export const normalizeSecretBrowserMode = (value = "auto") => {
  if (!["auto", "embedded", "chrome"].includes(value)) {
    throw new SecretBrowserFillError("Browser mode должен быть auto, embedded или chrome.");
  }
  return value;
};

// AXDOMIdentifier / UIA AutomationId are DOM ids. Do not approximate CSS via
// labels, focus or keystrokes: a broad selector could silently select another
// field. Unsupported syntax is a capability miss before any checkout.
export const nativeIdFromSecretSelector = (selector) => {
  const value = normalizeSecretBrowserFieldSelector(selector);
  const hash = /^#([A-Za-z_][A-Za-z0-9_-]*)$/u.exec(value);
  const attribute = /^\[id=(["'])([A-Za-z_][A-Za-z0-9_.:-]*)\1\]$/u.exec(value);
  if (!hash && !attribute) throw new EmbeddedBrowserUnavailable("selector_unsupported");
  return hash?.[1] ?? attribute[2];
};

export const browserFillBinding = (context) => {
  if (!context || context.deliveryMode !== "browser" || context.executable !== "trelio-workspace"
    || !Array.isArray(context.fieldKeys) || context.fieldKeys.length < 1
    || context.fieldKeys.some((key) => !/^[a-z][a-z0-9_]{0,63}$/u.test(key))
    || new Set(context.fieldKeys).size !== context.fieldKeys.length
    || !/^[0-9a-f]{64}$/u.test(context.targetUrlSha256 || "")) {
    throw new SecretBrowserFillError("Некорректный browser-fill context.");
  }
  const steps = context.browserSteps?.length ? context.browserSteps : [{
    targetOrigin: context.targetOrigin,
    targetUrlSha256: context.targetUrlSha256,
    fields: [{ fieldKey: context.fieldKeys[0], selector: context.browserFieldSelector }],
  }];
  const seen = new Set();
  if (steps.length > 10) throw new SecretBrowserFillError("Некорректный browser-fill context.");
  const normalized = steps.map((step) => {
    const url = new URL(step.targetOrigin);
    if (url.protocol !== "https:" || url.origin !== step.targetOrigin
      || !/^[0-9a-f]{64}$/u.test(step.targetUrlSha256 || "")
      || !Array.isArray(step.fields) || !step.fields.length) {
      throw new SecretBrowserFillError("Некорректный browser step.");
    }
    const fields = step.fields.map(({ fieldKey, selector }) => {
      if (!context.fieldKeys.includes(fieldKey) || seen.has(fieldKey)) {
        throw new SecretBrowserFillError("Browser step не совпадает с полями grant.");
      }
      seen.add(fieldKey);
      return { fieldKey, selector: normalizeSecretBrowserFieldSelector(selector) };
    });
    if (new Set(fields.map((field) => field.selector)).size !== fields.length) {
      throw new SecretBrowserFillError("Несколько secret fields назначены одному browser field.", "field_ambiguous");
    }
    return {
      targetOrigin: step.targetOrigin,
      targetUrlSha256: step.targetUrlSha256,
      fields,
      ...(step.submitSelector ? { submitSelector: normalizeSecretBrowserFieldSelector(step.submitSelector) } : {}),
    };
  });
  if (seen.size !== context.fieldKeys.length || normalized[0].targetOrigin !== context.targetOrigin
    || normalized[0].targetUrlSha256 !== context.targetUrlSha256) {
    throw new SecretBrowserFillError("Browser context не совпадает с grant.");
  }
  return {
    grantId: context.grantId, runId: context.runId, secretVersion: context.secretVersion,
    deliveryMode: context.deliveryMode, executable: context.executable,
    fieldKeys: context.fieldKeys, clientFamily: context.clientFamily ?? null,
    targetOrigin: context.targetOrigin, targetUrlSha256: context.targetUrlSha256,
    browserSteps: normalized,
  };
};

export const assertBrowserFillBindingUnchanged = (expected, actual) => {
  if (JSON.stringify(browserFillBinding(expected)) !== JSON.stringify(browserFillBinding(actual))) {
    throw new SecretBrowserFillError("Browser grant изменился после preflight. Не повторяйте выдачу.");
  }
};

const safeNativeEnvironment = (platform) => {
  if (platform === "win32") {
    const systemRoot = process.env.SystemRoot || "C:\\Windows";
    if (!/^[a-z]:\\Windows$/iu.test(systemRoot)) throw new EmbeddedBrowserUnavailable("helper_unavailable");
    return { SystemRoot: systemRoot, WINDIR: systemRoot, PATH: path.win32.join(systemRoot, "System32") };
  }
  return { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "en_US.UTF-8" };
};

const runCompiler = (executable, args, options) => new Promise((resolve, reject) => {
  // Compiler output can contain source snippets/paths; runtime diagnostics are
  // intentionally fixed. The build itself never receives any credential.
  const child = spawn(executable, args, { ...options, shell: false, stdio: "ignore", windowsHide: true });
  const timer = setTimeout(() => { child.kill(); reject(new EmbeddedBrowserUnavailable("helper_unavailable")); }, 60_000);
  child.once("error", () => { clearTimeout(timer); reject(new EmbeddedBrowserUnavailable("helper_unavailable")); });
  child.once("exit", (code) => {
    clearTimeout(timer);
    code === 0 ? resolve() : reject(new EmbeddedBrowserUnavailable("helper_unavailable"));
  });
});

const regularPrivateFile = async (file, platform) => {
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || (platform !== "win32" && (stat.mode & 0o077))) {
    throw new SecretBrowserFillError("Нативный browser helper имеет небезопасные права.");
  }
};

// A source-addressed build avoids binaries inside plugin/workspace directories.
// Build products inherit the existing bridge owner-only ACL. No downloads, PATH
// compilers, elevated process or automatic Accessibility permission changes.
export const buildNativeSecretBrowserHelper = async ({
  directory, ensurePrivateDirectory, platform = process.platform,
}) => {
  if (!["darwin", "win32"].includes(platform)) throw new EmbeddedBrowserUnavailable("platform_unsupported");
  const sourceName = platform === "darwin" ? "SecretBrowser.swift" : "SecretBrowser.cs";
  const sourceBytes = await fs.readFile(path.join(SOURCE_DIRECTORY, sourceName));
  const digest = createHash("sha256").update(sourceBytes).update(platform + process.arch + "-v2").digest("hex");
  await ensurePrivateDirectory(directory);
  const buildDirectory = path.join(directory, digest);
  await ensurePrivateDirectory(buildDirectory);
  const executable = path.join(buildDirectory, platform === "darwin" ? "TrelioSecretBrowser" : "TrelioSecretBrowser.exe");
  const manifest = path.join(buildDirectory, "build.json");
  try {
    await regularPrivateFile(executable, platform);
    await regularPrivateFile(manifest, platform);
    const expected = JSON.parse(await fs.readFile(manifest, "utf8"));
    const actual = createHash("sha256").update(await fs.readFile(executable)).digest("hex");
    if (expected.source !== digest || expected.binary !== actual) throw new SecretBrowserFillError("Нативный browser helper изменён.");
    return executable;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  // Independent sessions may build the same source. A contender can fall back
  // before checkout; it must never execute another process's partial output.
  const lock = path.join(buildDirectory, "build.lock");
  try { await fs.mkdir(lock, { mode: 0o700 }); }
  catch { throw new EmbeddedBrowserUnavailable("helper_unavailable"); }
  // csc derives AssemblyName from the output basename. Keep it stable while
  // building atomically in a private temporary directory; renaming a UUID.exe
  // would leave a different internal assembly identity in the final helper.
  const temporaryDirectory = path.join(buildDirectory, "build-" + randomUUID());
  const temporary = path.join(temporaryDirectory, path.basename(executable));
  try {
    await ensurePrivateDirectory(temporaryDirectory);
    const env = safeNativeEnvironment(platform);
    const sourceFile = path.join(SOURCE_DIRECTORY, sourceName);
    if (platform === "darwin") {
      await runCompiler("/usr/bin/swiftc", ["-O", sourceFile, "-o", temporary], { env, cwd: buildDirectory });
    } else {
      const framework = path.win32.join(env.SystemRoot, "Microsoft.NET", "Framework64", "v4.0.30319");
      const compiler = path.win32.join(framework, "csc.exe");
      await runCompiler(compiler, [
        "/nologo", "/optimize+", "/target:exe", "/out:" + temporary,
        "/reference:" + path.win32.join(framework, "WPF", "UIAutomationClient.dll"),
        "/reference:" + path.win32.join(framework, "WPF", "UIAutomationTypes.dll"),
        "/reference:" + path.win32.join(framework, "WPF", "WindowsBase.dll"),
        "/reference:System.Web.Extensions.dll", sourceFile,
      ], { env, cwd: buildDirectory });
    }
    await fs.chmod(temporary, 0o700);
    await fs.rename(temporary, executable);
    const binary = createHash("sha256").update(await fs.readFile(executable)).digest("hex");
    await fs.writeFile(manifest, JSON.stringify({ source: digest, binary }) + "\n", { mode: 0o600, flag: "wx" });
    return executable;
  } finally {
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
    await fs.rm(lock, { recursive: true, force: true });
  }
};

export const openNativeSecretBrowserChannel = ({ executable, platform = process.platform, timeoutMs = 60_000 }) => {
  const child = spawn(executable, [], {
    env: safeNativeEnvironment(platform), shell: false, windowsHide: true, stdio: ["pipe", "pipe", "ignore"],
  });
  const exited = new Promise((resolve) => child.once("close", resolve));
  let pending = null;
  let buffer = "";
  let closed = false;
  const fail = () => {
    const reject = pending?.reject;
    clearTimeout(pending?.timer);
    pending = null;
    closed = true;
    child.kill();
    reject?.(new SecretBrowserFillError("Нативный browser transport прерван.", "adapter_error"));
  };
  child.on("error", fail);
  child.on("exit", fail);
  child.stdin.on("error", fail);
  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    if (buffer.length > 4096) return fail();
    const end = buffer.indexOf("\n");
    if (end < 0) return;
    const line = buffer.slice(0, end);
    buffer = buffer.slice(end + 1);
    if (!pending || buffer.length) return fail();
    let reply;
    try { reply = JSON.parse(line); } catch { return fail(); }
    // The child must only emit a fixed status/reason, never DOM, URL or values.
    if (!reply || Object.keys(reply).some((key) => !["status", "reasonCode"].includes(key))) return fail();
    const { resolve, timer } = pending;
    pending = null;
    clearTimeout(timer);
    resolve(reply);
  });
  return {
    request: (payload) => new Promise((resolve, reject) => {
      if (closed || pending) return reject(new SecretBrowserFillError("Нативный browser transport закрыт."));
      const message = JSON.stringify(payload) + "\n";
      if (Buffer.byteLength(message) > MAX_PROTOCOL_BYTES) return reject(new SecretBrowserFillError("Browser request превышает лимит."));
      pending = { resolve, reject, timer: setTimeout(fail, timeoutMs) };
      child.stdin.write(message);
    }),
    close: () => { fail(); return exited; },
  };
};

export const prepareSecretBrowserSession = async ({
  context, targetUrl, mode = "auto", directory, ensurePrivateDirectory,
  platform = process.platform, buildHelper = buildNativeSecretBrowserHelper,
  openChannel = openNativeSecretBrowserChannel, runChrome = runSecretBrowserFill,
}) => {
  mode = normalizeSecretBrowserMode(mode);
  let channel = null;
  const chrome = (fallbackReason) => ({
    surface: "chrome", fallbackReason,
    fill: (args) => runChrome(args),
    close: () => {},
  });
  if (mode === "chrome") return chrome(null);
  try {
    if (!context) throw new EmbeddedBrowserUnavailable("backend_unavailable");
    const binding = browserFillBinding(context);
    normalizeSecretBrowserTarget(targetUrl, binding.targetOrigin, binding.targetUrlSha256);
    if (!["darwin", "win32"].includes(platform)) throw new EmbeddedBrowserUnavailable("platform_unsupported");
    if (!["codex", "claude-code"].includes(binding.clientFamily)) throw new EmbeddedBrowserUnavailable("client_unsupported");
    const steps = binding.browserSteps.map((step, index) => {
      if (index < binding.browserSteps.length - 1 && !step.submitSelector) throw new EmbeddedBrowserUnavailable("step_unsupported");
      const fields = step.fields.map(({ fieldKey, selector }) => ({ fieldKey, id: nativeIdFromSecretSelector(selector) }));
      if (new Set(fields.map((field) => field.id)).size !== fields.length) {
        throw new SecretBrowserFillError("Browser selectors разрешаются в одно поле.", "field_ambiguous");
      }
      return {
        targetOrigin: step.targetOrigin, targetUrlSha256: step.targetUrlSha256,
        fields,
        ...(step.submitSelector ? { submitId: nativeIdFromSecretSelector(step.submitSelector) } : {}),
      };
    });
    const executable = await buildHelper({ directory, ensurePrivateDirectory, platform });
    channel = openChannel({ executable, platform });
    const ready = await channel.request({ command: "prepare", clientFamily: binding.clientFamily, steps });
    if (ready.status === "unavailable" && NATIVE_UNAVAILABLE.has(ready.reasonCode)) {
      throw new EmbeddedBrowserUnavailable(ready.reasonCode);
    }
    if (ready.status !== "ready") throw new SecretBrowserFillError("Проверка встроенной вкладки отклонена.", ready.reasonCode);
    let used = false;
    return {
      surface: "embedded", fallbackReason: null,
      fill: async ({ secretValues }) => {
        if (used) throw new SecretBrowserFillError("Повторная передача секрета запрещена.");
        used = true;
        // No catch-to-Chrome exists below this boundary. Even a broken pipe may
        // mean the first setter ran; recovery needs a fresh auth-state check.
        const result = await channel.request({ command: "fill", values: secretValues });
        return result.status === "succeeded"
          ? { outcome: "succeeded" }
          : { outcome: "failed", reasonCode: new SecretBrowserFillError("", result.reasonCode).reasonCode };
      },
      close: () => channel.close(),
    };
  } catch (error) {
    await channel?.close();
    if (mode === "auto" && error instanceof EmbeddedBrowserUnavailable) return chrome(error.nativeReason);
    throw error;
  }
};
