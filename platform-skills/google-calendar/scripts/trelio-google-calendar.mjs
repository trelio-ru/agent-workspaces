#!/usr/bin/env node

/**
 * Dependency-free Google Calendar runtime for Trelio Agent Skills.
 *
 * Security boundaries are deliberately enforced here instead of relying on
 * the Markdown instruction alone:
 *
 * - the company OAuth client secret is accepted only through a one-use Agent
 *   Secret environment checkout and is never persisted by this process;
 * - each member's refresh token lives outside Git and Agent Workspaces in the
 *   stable Trelio integration namespace;
 * - OAuth uses a loopback callback, exact state, PKCE and an exact Host check;
 * - writes use a preview/apply contract bound to a plan hash and current ETag;
 * - ambiguous writes are never blindly retried.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

const CONNECTION_CONFIG_ENV = "TRELIO_SKILL_CONNECTION_CONFIG_JSON";
const CLIENT_SECRET_ENV = "TRELIO_GOOGLE_CALENDAR_CLIENT_SECRET";
const API_ORIGIN = "https://www.googleapis.com";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const AUTHORIZATION_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const OAUTH_SCOPES = Object.freeze([
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/calendar.readonly",
]);
const POLICY_MODES = new Set(["confirm", "autonomous", "read-only"]);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const CLIENT_ID_PATTERN = /^[0-9]+-[a-z0-9._-]+\.apps\.googleusercontent\.com$/iu;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;
const RFC3339_WITH_ZONE_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/u;
const GOOGLE_EVENT_ID_PATTERN = /^[0-9a-v]{5,1024}$/u;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_EVENT_RESULTS = 250;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_OAUTH_TIMEOUT_MS = 5 * 60_000;
const SAFE_RETRY_COUNT = 3;

export class CalendarRuntimeError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = "CalendarRuntimeError";
    this.code = code;
    this.details = details;
  }
}

class NetworkTransportError extends CalendarRuntimeError {
  constructor(message, details = undefined) {
    super("GOOGLE_CALENDAR_NETWORK_ERROR", message, details);
    this.name = "NetworkTransportError";
  }
}

export function parseArgs(argv) {
  const result = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith("--")) {
      result._.push(value);
      continue;
    }

    const separatorIndex = value.indexOf("=");
    const rawKey = separatorIndex === -1 ? value.slice(2) : value.slice(2, separatorIndex);
    const inlineValue = separatorIndex === -1 ? undefined : value.slice(separatorIndex + 1);
    const key = rawKey.replace(/-([a-z])/gu, (_match, character) => character.toUpperCase());
    if (inlineValue !== undefined) {
      result[key] = inlineValue;
      continue;
    }

    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith("--")) {
      result[key] = next;
      index += 1;
    } else {
      result[key] = true;
    }
  }
  return result;
}

function jsonOut(payload) {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseJsonObject(rawValue, label) {
  try {
    const value = JSON.parse(rawValue);
    if (!isPlainObject(value)) throw new Error("expected an object");
    return value;
  } catch (error) {
    throw new CalendarRuntimeError(
      "GOOGLE_CALENDAR_CONFIGURATION_INVALID",
      `${label} is not valid JSON: ${error instanceof Error ? error.message : "unknown error"}.`,
    );
  }
}

function requireString(value, label, maximumLength = 2_048) {
  if (typeof value !== "string" || !value.trim() || value.length > maximumLength) {
    throw new CalendarRuntimeError(
      "GOOGLE_CALENDAR_INPUT_INVALID",
      `${label} must be a non-empty string no longer than ${maximumLength} characters.`,
    );
  }
  return value.trim();
}

function optionalString(value, label, maximumLength = 2_048) {
  if (value === undefined) return undefined;
  return requireString(value, label, maximumLength);
}

function integerInRange(value, label, minimum, maximum, fallback = undefined) {
  if ((value === undefined || value === "") && fallback !== undefined) return fallback;
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < minimum || normalized > maximum) {
    throw new CalendarRuntimeError(
      "GOOGLE_CALENDAR_INPUT_INVALID",
      `${label} must be an integer from ${minimum} to ${maximum}.`,
    );
  }
  return normalized;
}

function validateUuid(value, label) {
  const normalized = requireString(value, label, 64).toLowerCase();
  if (!UUID_PATTERN.test(normalized)) {
    throw new CalendarRuntimeError("GOOGLE_CALENDAR_CONFIGURATION_INVALID", `${label} is not a UUID.`);
  }
  return normalized;
}

export function normalizeConnectionConfig(rawConfig) {
  if (!isPlainObject(rawConfig)) {
    throw new CalendarRuntimeError(
      "GOOGLE_CALENDAR_CONFIGURATION_INVALID",
      "Google Calendar company connection is missing.",
    );
  }
  const unexpectedKeys = Object.keys(rawConfig).filter(
    (key) => !["clientId", "allowAutonomous"].includes(key),
  );
  if (unexpectedKeys.length > 0) {
    throw new CalendarRuntimeError(
      "GOOGLE_CALENDAR_CONFIGURATION_INVALID",
      `Google Calendar company connection has unsupported fields: ${unexpectedKeys.join(", ")}.`,
    );
  }
  const clientId = requireString(rawConfig.clientId, "Google OAuth client ID", 512);
  if (!CLIENT_ID_PATTERN.test(clientId)) {
    throw new CalendarRuntimeError(
      "GOOGLE_CALENDAR_CONFIGURATION_INVALID",
      "Google OAuth client ID must be an installed-app client ending in .apps.googleusercontent.com.",
    );
  }
  return {
    clientId,
    allowAutonomous: rawConfig.allowAutonomous !== false,
  };
}

export function loadRuntimeContext(environment = process.env) {
  const rawConfig = environment[CONNECTION_CONFIG_ENV];
  if (!rawConfig) {
    throw new CalendarRuntimeError(
      "GOOGLE_CALENDAR_CONNECTION_REQUIRED",
      "A company administrator must configure the Google Calendar connection in Trelio.",
    );
  }
  const clientSecret = requireString(
    environment[CLIENT_SECRET_ENV],
    "Google OAuth client secret Agent Secret checkout",
    2_048,
  );
  return {
    identity: {
      companyId: validateUuid(environment.TRELIO_SKILL_COMPANY_ID, "company ID"),
      memberId: validateUuid(environment.TRELIO_SKILL_MEMBER_ID, "member ID"),
      connectionId: validateUuid(environment.TRELIO_SKILL_CONNECTION_ID, "connection ID"),
    },
    config: normalizeConnectionConfig(parseJsonObject(rawConfig, "Google Calendar company connection")),
    clientSecret,
  };
}

function defaultConfigHome(environment = process.env) {
  if (environment.TRELIO_CONFIG_HOME) return path.resolve(environment.TRELIO_CONFIG_HOME);
  if (process.platform === "win32") {
    const localAppData = environment.LOCALAPPDATA;
    if (!localAppData) {
      throw new CalendarRuntimeError(
        "GOOGLE_CALENDAR_LOCAL_STORAGE_UNAVAILABLE",
        "LOCALAPPDATA is required on Windows when TRELIO_CONFIG_HOME is not set.",
      );
    }
    return path.join(localAppData, "Trelio");
  }
  return path.join(os.homedir(), ".config", "trelio");
}

export function connectionRoot(context, environment = process.env) {
  return path.join(
    defaultConfigHome(environment),
    "integrations",
    "google-calendar",
    context.identity.companyId,
    context.identity.memberId,
    context.identity.connectionId,
  );
}

function ensurePrivateDirectory(directoryPath) {
  fs.mkdirSync(directoryPath, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") fs.chmodSync(directoryPath, 0o700);
}

function assertPrivateFile(filePath) {
  if (!fs.existsSync(filePath) || process.platform === "win32") return;
  const mode = fs.statSync(filePath).mode & 0o777;
  if ((mode & 0o077) !== 0) {
    throw new CalendarRuntimeError(
      "GOOGLE_CALENDAR_LOCAL_STORAGE_UNSAFE",
      `Unsafe permissions on ${filePath}: expected 600, got ${mode.toString(8)}.`,
    );
  }
}

function writePrivateJson(filePath, payload) {
  ensurePrivateDirectory(path.dirname(filePath));
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  if (process.platform !== "win32") fs.chmodSync(temporaryPath, 0o600);
  fs.renameSync(temporaryPath, filePath);
  if (process.platform !== "win32") fs.chmodSync(filePath, 0o600);
}

function readPrivateJson(filePath, label) {
  if (!fs.existsSync(filePath)) {
    throw new CalendarRuntimeError(
      "GOOGLE_CALENDAR_NOT_CONNECTED",
      `${label} is not available. Run connect and complete Google OAuth in the browser.`,
    );
  }
  assertPrivateFile(filePath);
  try {
    const payload = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (!isPlainObject(payload)) throw new Error("expected an object");
    return payload;
  } catch (error) {
    throw new CalendarRuntimeError(
      "GOOGLE_CALENDAR_LOCAL_STATE_INVALID",
      `${label} is invalid: ${error instanceof Error ? error.message : "unknown error"}.`,
    );
  }
}

function tokenPath(context, environment = process.env) {
  return path.join(connectionRoot(context, environment), "state", "oauth-token.json");
}

function policyPath(context, environment = process.env) {
  return path.join(connectionRoot(context, environment), "config", "policy.json");
}

export function loadPolicy(context, environment = process.env) {
  const filePath = policyPath(context, environment);
  if (!fs.existsSync(filePath)) return { writeMode: "confirm" };
  const payload = readPrivateJson(filePath, "Google Calendar local policy");
  if (!POLICY_MODES.has(payload.writeMode)) {
    throw new CalendarRuntimeError(
      "GOOGLE_CALENDAR_LOCAL_STATE_INVALID",
      "Google Calendar local policy contains an unsupported write mode.",
    );
  }
  return { writeMode: payload.writeMode };
}

function setPolicy(context, mode, environment = process.env) {
  if (!POLICY_MODES.has(mode)) {
    throw new CalendarRuntimeError(
      "GOOGLE_CALENDAR_INPUT_INVALID",
      "Policy mode must be confirm, autonomous or read-only.",
    );
  }
  if (mode === "autonomous" && context.config.allowAutonomous === false) {
    throw new CalendarRuntimeError(
      "GOOGLE_CALENDAR_POLICY_BLOCKED",
      "The company connection does not allow autonomous Google Calendar writes.",
    );
  }
  writePrivateJson(policyPath(context, environment), { writeMode: mode });
  return { writeMode: mode };
}

function assertWriteAllowed(context, args, environment = process.env) {
  const policy = loadPolicy(context, environment);
  if (policy.writeMode === "read-only") {
    throw new CalendarRuntimeError(
      "GOOGLE_CALENDAR_POLICY_BLOCKED",
      "Local Google Calendar policy is read-only; writes are disabled.",
    );
  }
  if (policy.writeMode === "autonomous" && context.config.allowAutonomous === false) {
    throw new CalendarRuntimeError(
      "GOOGLE_CALENDAR_POLICY_BLOCKED",
      "The company connection no longer allows the local autonomous mode.",
    );
  }
  if (policy.writeMode === "confirm" && args.confirm !== true) {
    throw new CalendarRuntimeError(
      "GOOGLE_CALENDAR_CONFIRMATION_REQUIRED",
      "This exact write requires --confirm after the user approves the preview.",
    );
  }
  return policy;
}

function base64Url(buffer) {
  return Buffer.from(buffer).toString("base64url");
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]),
    );
  }
  return value;
}

function planHash(payload) {
  return crypto.createHash("sha256").update(JSON.stringify(canonicalize(payload))).digest("hex");
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function retryDelayMilliseconds(attempt, response = undefined) {
  const retryAfter = response?.headers?.get?.("retry-after");
  if (retryAfter && /^\d+$/u.test(retryAfter)) {
    return Math.min(10_000, Number(retryAfter) * 1_000);
  }
  return Math.min(8_000, 500 * (2 ** attempt));
}

async function readBoundedBody(response) {
  const contentLength = Number(response.headers.get("content-length") || "0");
  if (contentLength > MAX_RESPONSE_BYTES) {
    throw new CalendarRuntimeError(
      "GOOGLE_CALENDAR_RESPONSE_TOO_LARGE",
      `Google response exceeded the ${MAX_RESPONSE_BYTES}-byte limit.`,
    );
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new CalendarRuntimeError(
        "GOOGLE_CALENDAR_RESPONSE_TOO_LARGE",
        `Google response exceeded the ${MAX_RESPONSE_BYTES}-byte limit.`,
      );
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
}

function safeGoogleError(payload) {
  const nestedError = isPlainObject(payload?.error) ? payload.error : null;
  const code = typeof nestedError?.status === "string" ? nestedError.status.slice(0, 80) : null;
  const message = typeof nestedError?.message === "string"
    ? nestedError.message.replace(/[\r\n\t]+/gu, " ").slice(0, 240)
    : null;
  return { providerCode: code, providerMessage: message };
}

async function fetchJson(url, options = {}, safety = {}) {
  const method = String(options.method || "GET").toUpperCase();
  const retries = safety.safeToRetry === true ? SAFE_RETRY_COUNT : 0;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const abortController = new AbortController();
    const timeout = setTimeout(
      () => abortController.abort(),
      safety.timeoutMs || DEFAULT_REQUEST_TIMEOUT_MS,
    );
    try {
      const response = await fetch(url, { ...options, signal: abortController.signal, redirect: "error" });
      if (
        attempt < retries
        && (response.status === 429 || response.status === 500 || response.status === 502 || response.status === 503 || response.status === 504)
      ) {
        await response.body?.cancel();
        await sleep(retryDelayMilliseconds(attempt, response));
        continue;
      }
      const rawBody = await readBoundedBody(response);
      let payload = null;
      if (rawBody) {
        try {
          payload = JSON.parse(rawBody);
        } catch {
          payload = null;
        }
      }
      if (!response.ok && !safety.allowedStatuses?.includes(response.status)) {
        throw new CalendarRuntimeError(
          "GOOGLE_CALENDAR_HTTP_ERROR",
          `Google Calendar request failed with HTTP ${response.status}.`,
          { httpStatus: response.status, ...safeGoogleError(payload) },
        );
      }
      return { response, payload };
    } catch (error) {
      if (error instanceof CalendarRuntimeError) throw error;
      if (attempt < retries) {
        await sleep(retryDelayMilliseconds(attempt));
        continue;
      }
      throw new NetworkTransportError(
        error?.name === "AbortError"
          ? "Google Calendar request timed out."
          : "Google Calendar network request failed.",
        { stage: safety.stage || "request", attempts: attempt + 1 },
      );
    } finally {
      clearTimeout(timeout);
    }
  }
  throw new NetworkTransportError("Google Calendar request failed after safe retries.");
}

async function tokenRequest(parameters) {
  const { payload } = await fetchJson(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(parameters).toString(),
  }, { safeToRetry: true, stage: "oauth_token" });
  if (!isPlainObject(payload) || typeof payload.access_token !== "string") {
    throw new CalendarRuntimeError(
      "GOOGLE_CALENDAR_OAUTH_REJECTED",
      "Google OAuth did not return a usable access token.",
    );
  }
  return payload;
}

function normalizeStoredToken(payload, expectedClientId) {
  if (payload.clientId !== expectedClientId) {
    throw new CalendarRuntimeError(
      "GOOGLE_CALENDAR_CONNECTION_CHANGED",
      "The company Google OAuth client changed. Run connect again before using the stored token.",
    );
  }
  const refreshToken = requireString(payload.refreshToken, "Google OAuth refresh token", 8_192);
  const accessToken = typeof payload.accessToken === "string" ? payload.accessToken : null;
  const expiresAt = Number(payload.expiresAt || 0);
  return {
    refreshToken,
    accessToken,
    expiresAt: Number.isFinite(expiresAt) ? expiresAt : 0,
    scope: typeof payload.scope === "string" ? payload.scope : "",
    tokenType: typeof payload.tokenType === "string" ? payload.tokenType : "Bearer",
  };
}

async function accessToken(context, environment = process.env) {
  const filePath = tokenPath(context, environment);
  const token = normalizeStoredToken(
    readPrivateJson(filePath, "Google Calendar OAuth token"),
    context.config.clientId,
  );
  if (token.accessToken && token.expiresAt > Date.now() + 60_000) return token.accessToken;

  const refreshed = await tokenRequest({
    client_id: context.config.clientId,
    client_secret: context.clientSecret,
    refresh_token: token.refreshToken,
    grant_type: "refresh_token",
  });
  const nextToken = {
    clientId: context.config.clientId,
    refreshToken: token.refreshToken,
    accessToken: refreshed.access_token,
    expiresAt: Date.now() + Number(refreshed.expires_in || 3_600) * 1_000,
    scope: typeof refreshed.scope === "string" ? refreshed.scope : token.scope,
    tokenType: typeof refreshed.token_type === "string" ? refreshed.token_type : token.tokenType,
  };
  writePrivateJson(filePath, nextToken);
  return nextToken.accessToken;
}

function apiUrl(pathname, searchParameters = undefined) {
  if (!pathname.startsWith("/calendar/v3/") || pathname.includes("..")) {
    throw new CalendarRuntimeError("GOOGLE_CALENDAR_INTERNAL_ERROR", "Unsafe Google Calendar API path.");
  }
  const url = new URL(pathname, API_ORIGIN);
  if (searchParameters) {
    for (const [key, value] of Object.entries(searchParameters)) {
      if (value !== undefined && value !== null && value !== "") {
        url.searchParams.set(key, String(value));
      }
    }
  }
  return url;
}

async function calendarApi(context, pathname, options = {}, safety = {}) {
  const bearerToken = await accessToken(context);
  const headers = new Headers(options.headers || {});
  headers.set("authorization", `Bearer ${bearerToken}`);
  if (options.body !== undefined) headers.set("content-type", "application/json; charset=utf-8");
  return fetchJson(apiUrl(pathname, safety.search), {
    ...options,
    headers,
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
  }, safety);
}

function loopbackAddress(value) {
  return value === "127.0.0.1" || value === "::ffff:127.0.0.1" || value === "::1";
}

export function validateOAuthCallbackRequest(request, port, expectedState) {
  if (!loopbackAddress(request.socket?.remoteAddress)) {
    throw new CalendarRuntimeError("GOOGLE_CALENDAR_OAUTH_CALLBACK_REJECTED", "OAuth callback is not loopback.");
  }
  if (request.method !== "GET") {
    throw new CalendarRuntimeError("GOOGLE_CALENDAR_OAUTH_CALLBACK_REJECTED", "OAuth callback must use GET.");
  }
  if (request.headers.host !== `127.0.0.1:${port}`) {
    throw new CalendarRuntimeError("GOOGLE_CALENDAR_OAUTH_CALLBACK_REJECTED", "OAuth callback Host is invalid.");
  }
  const requestUrl = new URL(request.url || "/", `http://127.0.0.1:${port}`);
  if (requestUrl.pathname !== "/oauth/callback") {
    throw new CalendarRuntimeError("GOOGLE_CALENDAR_OAUTH_CALLBACK_REJECTED", "OAuth callback path is invalid.");
  }
  if (requestUrl.searchParams.get("state") !== expectedState) {
    throw new CalendarRuntimeError("GOOGLE_CALENDAR_OAUTH_CALLBACK_REJECTED", "OAuth callback state is invalid.");
  }
  const providerError = requestUrl.searchParams.get("error");
  if (providerError) {
    throw new CalendarRuntimeError(
      "GOOGLE_CALENDAR_OAUTH_REJECTED",
      `Google OAuth was not completed (${providerError.slice(0, 80)}).`,
    );
  }
  return requireString(requestUrl.searchParams.get("code"), "OAuth authorization code", 8_192);
}

function oauthResponse(response, statusCode, title, message) {
  const body = `<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${title}</title><body><main><h1>${title}</h1><p>${message}</p></main></body></html>`;
  response.writeHead(statusCode, {
    "content-type": "text/html; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store, max-age=0",
    pragma: "no-cache",
    "referrer-policy": "no-referrer",
    "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    "x-content-type-options": "nosniff",
  });
  response.end(body);
}

async function spawnAndWait(command, args) {
  return new Promise((resolve) => {
    let settled = false;
    const child = spawn(command, args, { detached: false, stdio: "ignore", shell: false });
    child.once("error", () => {
      if (!settled) {
        settled = true;
        resolve(false);
      }
    });
    child.once("exit", (code) => {
      if (!settled) {
        settled = true;
        resolve(code === 0);
      }
    });
  });
}

async function openBrowser(url) {
  if (process.env.TRELIO_GOOGLE_CALENDAR_NO_OPEN === "1") return false;
  if (process.platform === "darwin") {
    if (await spawnAndWait("/usr/bin/open", [url])) return true;
    if (await spawnAndWait("/usr/bin/open", ["-a", "Google Chrome", url])) return true;
    return spawnAndWait("/usr/bin/open", ["-a", "Safari", url]);
  }
  if (process.platform === "win32") {
    // rundll32 receives the URL as an argv item and avoids cmd.exe parsing of
    // OAuth query delimiters such as `&` as shell control characters.
    return spawnAndWait("rundll32.exe", ["url.dll,FileProtocolHandler", url]);
  }
  return spawnAndWait("xdg-open", [url]);
}

async function connect(context, args, environment = process.env) {
  const state = base64Url(crypto.randomBytes(32));
  const verifier = base64Url(crypto.randomBytes(48));
  const challenge = base64Url(crypto.createHash("sha256").update(verifier).digest());
  const timeoutMs = integerInRange(args.timeoutMs, "OAuth timeout", 30_000, 10 * 60_000, DEFAULT_OAUTH_TIMEOUT_MS);

  let settleCallback;
  let rejectCallback;
  let completed = false;
  const callbackPromise = new Promise((resolve, reject) => {
    settleCallback = resolve;
    rejectCallback = reject;
  });

  const server = http.createServer((request, response) => {
    if (completed) {
      oauthResponse(response, 410, "Ссылка уже использована", "Вернитесь в приложение.");
      return;
    }
    try {
      const code = validateOAuthCallbackRequest(request, server.address().port, state);
      completed = true;
      oauthResponse(response, 200, "Google Calendar подключён", "Можно закрыть эту вкладку и вернуться к работе.");
      settleCallback(code);
    } catch (error) {
      completed = true;
      oauthResponse(response, 400, "Подключение не завершено", "Вернитесь в приложение и запустите подключение ещё раз.");
      rejectCallback(error);
    }
  });
  server.keepAliveTimeout = 1_000;
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  const port = server.address().port;
  const redirectUri = `http://127.0.0.1:${port}/oauth/callback`;
  const authorizationUrl = new URL(AUTHORIZATION_ENDPOINT);
  authorizationUrl.search = new URLSearchParams({
    client_id: context.config.clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: OAUTH_SCOPES.join(" "),
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  }).toString();

  const timer = setTimeout(() => {
    if (!completed) {
      completed = true;
      rejectCallback(new CalendarRuntimeError(
        "GOOGLE_CALENDAR_OAUTH_TIMEOUT",
        "Timed out waiting for Google OAuth in the browser.",
      ));
    }
  }, timeoutMs);

  try {
    const opened = await openBrowser(authorizationUrl.toString());
    if (!opened) {
      throw new CalendarRuntimeError(
        "GOOGLE_CALENDAR_BROWSER_UNAVAILABLE",
        "The protected Google OAuth page could not be opened in a browser.",
      );
    }
    const code = await callbackPromise;
    const token = await tokenRequest({
      client_id: context.config.clientId,
      client_secret: context.clientSecret,
      code,
      code_verifier: verifier,
      grant_type: "authorization_code",
      redirect_uri: redirectUri,
    });
    if (typeof token.refresh_token !== "string" || !token.refresh_token) {
      throw new CalendarRuntimeError(
        "GOOGLE_CALENDAR_REFRESH_TOKEN_MISSING",
        "Google OAuth did not return a refresh token. Revoke the old grant if needed and connect again.",
      );
    }
    writePrivateJson(tokenPath(context, environment), {
      clientId: context.config.clientId,
      refreshToken: token.refresh_token,
      accessToken: token.access_token,
      expiresAt: Date.now() + Number(token.expires_in || 3_600) * 1_000,
      scope: typeof token.scope === "string" ? token.scope : OAUTH_SCOPES.join(" "),
      tokenType: typeof token.token_type === "string" ? token.token_type : "Bearer",
    });
    const calendars = await listCalendars(context, { max: 10 });
    return {
      command: "connect",
      status: "connected",
      calendarCount: calendars.items.length,
      primaryCalendar: calendars.items.find((item) => item.primary === true) || null,
    };
  } finally {
    clearTimeout(timer);
    await new Promise((resolve) => server.close(resolve));
    server.closeAllConnections?.();
  }
}

function normalizeCalendar(item) {
  return {
    id: item.id || null,
    summary: item.summary || null,
    description: item.description || null,
    location: item.location || null,
    timeZone: item.timeZone || null,
    accessRole: item.accessRole || null,
    primary: item.primary === true,
    selected: item.selected === true,
  };
}

export function normalizeEvent(event) {
  return {
    id: event.id || null,
    etag: event.etag || null,
    status: event.status || null,
    summary: event.summary || null,
    description: event.description || null,
    location: event.location || null,
    start: event.start || null,
    end: event.end || null,
    recurrence: Array.isArray(event.recurrence) ? event.recurrence.slice(0, 10) : [],
    recurringEventId: event.recurringEventId || null,
    originalStartTime: event.originalStartTime || null,
    reminders: event.reminders || null,
    attendees: Array.isArray(event.attendees)
      ? event.attendees.slice(0, 100).map((attendee) => ({
          email: attendee.email || null,
          displayName: attendee.displayName || null,
          responseStatus: attendee.responseStatus || null,
          organizer: attendee.organizer === true,
          self: attendee.self === true,
        }))
      : [],
    transparency: event.transparency || "opaque",
    visibility: event.visibility || "default",
    htmlLink: typeof event.htmlLink === "string" ? event.htmlLink : null,
    created: event.created || null,
    updated: event.updated || null,
  };
}

async function listCalendars(context, args) {
  const maxResults = integerInRange(args.max, "max", 1, 250, 100);
  const { payload } = await calendarApi(context, "/calendar/v3/users/me/calendarList", {}, {
    safeToRetry: true,
    stage: "list_calendars",
    search: { maxResults },
  });
  return {
    command: "calendars",
    items: Array.isArray(payload?.items) ? payload.items.slice(0, maxResults).map(normalizeCalendar) : [],
    nextPageToken: payload?.nextPageToken || null,
  };
}

function calendarIdFromArgs(args) {
  return requireString(args.calendar || "primary", "calendar ID", 1_024);
}

function eventIdFromArgs(args) {
  return requireString(args.eventId, "event ID", 1_024);
}

function encoded(value) {
  return encodeURIComponent(value);
}

async function listEvents(context, args) {
  const calendarId = calendarIdFromArgs(args);
  const maxResults = integerInRange(args.max, "max", 1, MAX_EVENT_RESULTS, 50);
  const days = integerInRange(args.days, "days", 1, 366, 14);
  const timeMin = args.timeMin
    ? validateRfc3339(args.timeMin, "time-min")
    : new Date().toISOString();
  const timeMax = args.timeMax
    ? validateRfc3339(args.timeMax, "time-max")
    : new Date(Date.parse(timeMin) + days * 24 * 60 * 60_000).toISOString();
  if (Date.parse(timeMax) <= Date.parse(timeMin)) {
    throw new CalendarRuntimeError("GOOGLE_CALENDAR_INPUT_INVALID", "time-max must be later than time-min.");
  }
  if (Date.parse(timeMax) - Date.parse(timeMin) > 366 * 24 * 60 * 60_000) {
    throw new CalendarRuntimeError(
      "GOOGLE_CALENDAR_INPUT_INVALID",
      "An event-list range cannot exceed 366 days.",
    );
  }
  const query = optionalString(args.query, "query", 512);
  const { payload } = await calendarApi(
    context,
    `/calendar/v3/calendars/${encoded(calendarId)}/events`,
    {},
    {
      safeToRetry: true,
      stage: "list_events",
      search: {
        timeMin,
        timeMax,
        maxResults,
        singleEvents: args.singleEvents === false ? "false" : "true",
        orderBy: args.singleEvents === false ? undefined : "startTime",
        q: query,
        pageToken: optionalString(args.pageToken, "page token", 4_096),
      },
    },
  );
  return {
    command: "events",
    calendarId,
    timeMin,
    timeMax,
    items: Array.isArray(payload?.items) ? payload.items.slice(0, maxResults).map(normalizeEvent) : [],
    nextPageToken: payload?.nextPageToken || null,
  };
}

async function getEvent(context, args, allowedNotFound = false) {
  const calendarId = calendarIdFromArgs(args);
  const eventId = eventIdFromArgs(args);
  const { response, payload } = await calendarApi(
    context,
    `/calendar/v3/calendars/${encoded(calendarId)}/events/${encoded(eventId)}`,
    {},
    {
      safeToRetry: true,
      stage: "get_event",
      ...(allowedNotFound ? { allowedStatuses: [404, 410] } : {}),
    },
  );
  if (response.status === 404 || response.status === 410) return null;
  return normalizeEvent(payload || {});
}

function validateRfc3339(value, label) {
  const normalized = requireString(value, label, 64);
  if (!RFC3339_WITH_ZONE_PATTERN.test(normalized) || !Number.isFinite(Date.parse(normalized))) {
    throw new CalendarRuntimeError(
      "GOOGLE_CALENDAR_INPUT_INVALID",
      `${label} must be RFC3339 with an explicit UTC offset or Z.`,
    );
  }
  return normalized;
}

function validateDate(value, label) {
  const normalized = requireString(value, label, 10);
  if (!DATE_PATTERN.test(normalized)) {
    throw new CalendarRuntimeError("GOOGLE_CALENDAR_INPUT_INVALID", `${label} must use YYYY-MM-DD.`);
  }
  const parsed = new Date(`${normalized}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== normalized) {
    throw new CalendarRuntimeError("GOOGLE_CALENDAR_INPUT_INVALID", `${label} is not a real calendar date.`);
  }
  return normalized;
}

function validateTimeZone(value) {
  const normalized = requireString(value, "time zone", 128);
  try {
    new Intl.DateTimeFormat("en", { timeZone: normalized }).format(new Date(0));
  } catch {
    throw new CalendarRuntimeError(
      "GOOGLE_CALENDAR_INPUT_INVALID",
      "time zone must be a supported IANA time-zone name.",
    );
  }
  return normalized;
}

function normalizeDateRange(args, required) {
  const hasStart = args.start !== undefined;
  const hasEnd = args.end !== undefined;
  if (required && (!hasStart || !hasEnd)) {
    throw new CalendarRuntimeError("GOOGLE_CALENDAR_INPUT_INVALID", "Both --start and --end are required.");
  }
  if (hasStart !== hasEnd) {
    throw new CalendarRuntimeError(
      "GOOGLE_CALENDAR_INPUT_INVALID",
      "Changing event time requires both --start and --end.",
    );
  }
  if (!hasStart) return undefined;
  if (args.allDay === true) {
    const start = validateDate(args.start, "start");
    const end = validateDate(args.end, "end");
    if (end <= start) {
      throw new CalendarRuntimeError(
        "GOOGLE_CALENDAR_INPUT_INVALID",
        "All-day end is exclusive and must be later than start.",
      );
    }
    return { start: { date: start }, end: { date: end } };
  }
  const start = validateRfc3339(args.start, "start");
  const end = validateRfc3339(args.end, "end");
  if (Date.parse(end) <= Date.parse(start)) {
    throw new CalendarRuntimeError("GOOGLE_CALENDAR_INPUT_INVALID", "Event end must be later than start.");
  }
  const timeZone = args.timeZone === undefined ? undefined : validateTimeZone(args.timeZone);
  return {
    start: { dateTime: start, ...(timeZone ? { timeZone } : {}) },
    end: { dateTime: end, ...(timeZone ? { timeZone } : {}) },
  };
}

function parseReminderMinutes(value) {
  if (value === undefined) return undefined;
  const values = String(value).split(",").map((item) => item.trim()).filter(Boolean);
  if (values.length < 1 || values.length > 5) {
    throw new CalendarRuntimeError("GOOGLE_CALENDAR_INPUT_INVALID", "Use one to five reminder values.");
  }
  const minutes = [...new Set(values.map((item) => integerInRange(item, "reminder minutes", 0, 40_320)))];
  return { useDefault: false, overrides: minutes.map((item) => ({ method: "popup", minutes: item })) };
}

function parseAttendees(value) {
  if (value === undefined) return undefined;
  const values = String(value).split(",").map((item) => item.trim().toLowerCase()).filter(Boolean);
  if (values.length < 1 || values.length > 20) {
    throw new CalendarRuntimeError("GOOGLE_CALENDAR_INPUT_INVALID", "Use one to twenty attendee addresses.");
  }
  const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;
  if (values.some((item) => item.length > 254 || !emailPattern.test(item))) {
    throw new CalendarRuntimeError("GOOGLE_CALENDAR_INPUT_INVALID", "Attendees contain an invalid email address.");
  }
  return [...new Set(values)].map((email) => ({ email }));
}

function parseRecurrence(value) {
  if (value === undefined) return undefined;
  const normalized = requireString(value, "recurrence", 500).toUpperCase();
  if (!/^(?:RRULE|RDATE|EXDATE):[A-Z0-9=,;:+-]+$/u.test(normalized)) {
    throw new CalendarRuntimeError(
      "GOOGLE_CALENDAR_INPUT_INVALID",
      "Recurrence must be one bounded RRULE, RDATE or EXDATE value.",
    );
  }
  return [normalized];
}

function optionalEnum(value, label, allowedValues) {
  if (value === undefined) return undefined;
  const normalized = requireString(value, label, 64);
  if (!allowedValues.includes(normalized)) {
    throw new CalendarRuntimeError(
      "GOOGLE_CALENDAR_INPUT_INVALID",
      `${label} must be one of: ${allowedValues.join(", ")}.`,
    );
  }
  return normalized;
}

export function buildCreateResource(args) {
  const summary = requireString(args.summary, "summary", 1_024);
  const dateRange = normalizeDateRange(args, true);
  const reminders = parseReminderMinutes(args.reminderMinutes);
  const attendees = parseAttendees(args.attendees);
  const recurrence = parseRecurrence(args.recurrence);
  if (attendees && args.sendInvitations !== true) {
    throw new CalendarRuntimeError(
      "GOOGLE_CALENDAR_INVITATION_CONFIRMATION_REQUIRED",
      "Attendees send external invitations; add --send-invitations after verifying every address.",
    );
  }
  if (recurrence && args.seriesConfirmed !== true) {
    throw new CalendarRuntimeError(
      "GOOGLE_CALENDAR_SERIES_CONFIRMATION_REQUIRED",
      "Creating a recurring series requires --series-confirmed after the recurrence is explicit.",
    );
  }
  if (recurrence && dateRange.start.dateTime && !dateRange.start.timeZone) {
    throw new CalendarRuntimeError(
      "GOOGLE_CALENDAR_INPUT_INVALID",
      "A recurring timed event requires --time-zone with an IANA time-zone name.",
    );
  }
  return {
    summary,
    ...dateRange,
    ...(args.description !== undefined ? { description: String(args.description).slice(0, 8_192) } : {}),
    ...(args.location !== undefined ? { location: String(args.location).slice(0, 1_024) } : {}),
    ...(reminders ? { reminders } : {}),
    ...(attendees ? { attendees } : {}),
    ...(recurrence ? { recurrence } : {}),
    ...(args.transparency !== undefined
      ? { transparency: optionalEnum(args.transparency, "transparency", ["opaque", "transparent"]) }
      : {}),
    ...(args.visibility !== undefined
      ? { visibility: optionalEnum(args.visibility, "visibility", ["default", "public", "private", "confidential"]) }
      : {}),
  };
}

export function buildUpdatePatch(args) {
  const patch = {};
  if (args.summary !== undefined) patch.summary = requireString(args.summary, "summary", 1_024);
  const dateRange = normalizeDateRange(args, false);
  if (dateRange) Object.assign(patch, dateRange);
  if (args.description !== undefined) patch.description = String(args.description).slice(0, 8_192);
  if (args.clearDescription === true) patch.description = "";
  if (args.location !== undefined) patch.location = String(args.location).slice(0, 1_024);
  if (args.clearLocation === true) patch.location = "";
  const reminders = parseReminderMinutes(args.reminderMinutes);
  if (reminders) patch.reminders = reminders;
  if (args.clearReminders === true) patch.reminders = { useDefault: false, overrides: [] };
  const attendees = parseAttendees(args.attendees);
  if (attendees) patch.attendees = attendees;
  if (args.clearAttendees === true) patch.attendees = [];
  if ((attendees || args.clearAttendees === true) && args.sendInvitations !== true) {
    throw new CalendarRuntimeError(
      "GOOGLE_CALENDAR_INVITATION_CONFIRMATION_REQUIRED",
      "Changing attendees may send external updates; add --send-invitations after verifying the exact list.",
    );
  }
  const recurrence = parseRecurrence(args.recurrence);
  if (recurrence) patch.recurrence = recurrence;
  if (args.clearRecurrence === true) patch.recurrence = [];
  if ((recurrence || args.clearRecurrence === true) && args.seriesConfirmed !== true) {
    throw new CalendarRuntimeError(
      "GOOGLE_CALENDAR_SERIES_CONFIRMATION_REQUIRED",
      "Changing recurrence requires --series-confirmed after the series scope is explicit.",
    );
  }
  if (args.transparency !== undefined) {
    patch.transparency = optionalEnum(args.transparency, "transparency", ["opaque", "transparent"]);
  }
  if (args.visibility !== undefined) {
    patch.visibility = optionalEnum(args.visibility, "visibility", ["default", "public", "private", "confidential"]);
  }
  if (Object.keys(patch).length === 0) {
    throw new CalendarRuntimeError("GOOGLE_CALENDAR_INPUT_INVALID", "Update requires at least one changed field.");
  }
  return patch;
}

function requirePlanHash(args, expectedPlanHash) {
  const supplied = requireString(args.expectedPlanHash, "expected plan hash", 64).toLowerCase();
  if (!/^[0-9a-f]{64}$/u.test(supplied) || supplied !== expectedPlanHash) {
    throw new CalendarRuntimeError(
      "GOOGLE_CALENDAR_PLAN_CHANGED",
      "The Google Calendar write preview changed. Show the new preview before applying it.",
    );
  }
}

function requestIdFromArgs(args, required) {
  if (args.requestId === undefined && !required) {
    // Google event IDs use base32hex. A random hexadecimal value is valid and
    // gives create operations a stable external id for ambiguity recovery.
    return crypto.randomBytes(20).toString("hex");
  }
  const value = requireString(args.requestId, "request ID", 1_024).toLowerCase();
  if (!GOOGLE_EVENT_ID_PATTERN.test(value)) {
    throw new CalendarRuntimeError("GOOGLE_CALENDAR_INPUT_INVALID", "request ID is not a valid Google event ID.");
  }
  return value;
}

function recurringSeriesWarning(event) {
  return Array.isArray(event.recurrence) && event.recurrence.length > 0;
}

function assertSeriesTargetConfirmed(event, args) {
  if (recurringSeriesWarning(event) && args.seriesConfirmed !== true) {
    throw new CalendarRuntimeError(
      "GOOGLE_CALENDAR_SERIES_CONFIRMATION_REQUIRED",
      "This event is the recurring-series master. Add --series-confirmed only after the user chose the whole series.",
    );
  }
}

export function requiresInvitationUpdates(event, patch = undefined) {
  return event.attendees.some((attendee) => attendee.self !== true)
    || Array.isArray(patch?.attendees);
}

function assertInvitationUpdatesConfirmed(event, args, patch = undefined) {
  if (requiresInvitationUpdates(event, patch) && args.sendInvitations !== true) {
    throw new CalendarRuntimeError(
      "GOOGLE_CALENDAR_INVITATION_CONFIRMATION_REQUIRED",
      "This event has external attendees. Add --send-invitations only after the user approves Google notifications to them.",
    );
  }
}

function valuesMatch(actual, expected) {
  if (Array.isArray(expected)) {
    return Array.isArray(actual)
      && actual.length === expected.length
      && expected.every((value, index) => valuesMatch(actual[index], value));
  }
  if (isPlainObject(expected)) {
    return isPlainObject(actual) && Object.entries(expected).every(([key, value]) => valuesMatch(actual[key], value));
  }
  return actual === expected;
}

async function createEvent(context, args) {
  const calendarId = calendarIdFromArgs(args);
  const resource = buildCreateResource(args);
  const requestId = requestIdFromArgs(args, args.apply === true);
  const writePlan = { action: "create", calendarId, requestId, resource };
  const expectedPlanHash = planHash(writePlan);
  if (args.apply !== true) {
    return {
      command: "create-event",
      mode: "preview",
      ...writePlan,
      expectedPlanHash,
      warnings: resource.attendees?.length ? ["Google will send invitations to the listed attendees."] : [],
    };
  }
  requirePlanHash(args, expectedPlanHash);
  const policy = assertWriteAllowed(context, args);
  const body = { id: requestId, ...resource };
  try {
    const { payload } = await calendarApi(
      context,
      `/calendar/v3/calendars/${encoded(calendarId)}/events`,
      { method: "POST", body },
      {
        stage: "create_event",
        search: { sendUpdates: resource.attendees?.length ? "all" : "none" },
      },
    );
    return { command: "create-event", mode: "applied", policy: policy.writeMode, event: normalizeEvent(payload || {}) };
  } catch (error) {
    if (!(error instanceof NetworkTransportError)) throw error;
    const recovered = await getEvent(context, { calendar: calendarId, eventId: requestId }, true).catch(() => null);
    if (recovered && valuesMatch(recovered, resource)) {
      return { command: "create-event", mode: "recovered-after-ambiguous-response", policy: policy.writeMode, event: recovered };
    }
    throw new CalendarRuntimeError(
      "GOOGLE_CALENDAR_MUTATION_AMBIGUOUS",
      "Google Calendar create result is ambiguous. Do not repeat it until the event is checked by request ID.",
      { requestId },
    );
  }
}

async function updateEvent(context, args) {
  const calendarId = calendarIdFromArgs(args);
  const eventId = eventIdFromArgs(args);
  const current = await getEvent(context, { calendar: calendarId, eventId });
  assertSeriesTargetConfirmed(current, args);
  const patch = buildUpdatePatch(args);
  assertInvitationUpdatesConfirmed(current, args, patch);
  const writePlan = { action: "update", calendarId, eventId, expectedEtag: current.etag, patch };
  const expectedPlanHash = planHash(writePlan);
  if (args.apply !== true) {
    return { command: "update-event", mode: "preview", current, patch, expectedEtag: current.etag, expectedPlanHash };
  }
  if (args.expectedEtag !== current.etag) {
    throw new CalendarRuntimeError(
      "GOOGLE_CALENDAR_EVENT_CHANGED",
      "The Google Calendar event changed after preview. Read it again before applying an update.",
    );
  }
  requirePlanHash(args, expectedPlanHash);
  const policy = assertWriteAllowed(context, args);
  try {
    const { payload } = await calendarApi(
      context,
      `/calendar/v3/calendars/${encoded(calendarId)}/events/${encoded(eventId)}`,
      { method: "PATCH", headers: { "if-match": current.etag }, body: patch },
      {
        stage: "update_event",
        search: { sendUpdates: requiresInvitationUpdates(current, patch) ? "all" : "none" },
      },
    );
    return { command: "update-event", mode: "applied", policy: policy.writeMode, event: normalizeEvent(payload || {}) };
  } catch (error) {
    if (!(error instanceof NetworkTransportError)) throw error;
    const recovered = await getEvent(context, { calendar: calendarId, eventId }, true).catch(() => null);
    if (recovered && valuesMatch(recovered, patch)) {
      return { command: "update-event", mode: "recovered-after-ambiguous-response", policy: policy.writeMode, event: recovered };
    }
    throw new CalendarRuntimeError(
      "GOOGLE_CALENDAR_MUTATION_AMBIGUOUS",
      "Google Calendar update result is ambiguous. Do not repeat it until the event is read again.",
      { eventId },
    );
  }
}

async function deleteEvent(context, args) {
  const calendarId = calendarIdFromArgs(args);
  const eventId = eventIdFromArgs(args);
  const current = await getEvent(context, { calendar: calendarId, eventId });
  assertSeriesTargetConfirmed(current, args);
  assertInvitationUpdatesConfirmed(current, args);
  const writePlan = { action: "delete", calendarId, eventId, expectedEtag: current.etag };
  const expectedPlanHash = planHash(writePlan);
  if (args.apply !== true) {
    return { command: "delete-event", mode: "preview", current, expectedEtag: current.etag, expectedPlanHash };
  }
  if (args.expectedEtag !== current.etag) {
    throw new CalendarRuntimeError(
      "GOOGLE_CALENDAR_EVENT_CHANGED",
      "The Google Calendar event changed after preview. Read it again before deleting it.",
    );
  }
  requirePlanHash(args, expectedPlanHash);
  const policy = assertWriteAllowed(context, args);
  try {
    await calendarApi(
      context,
      `/calendar/v3/calendars/${encoded(calendarId)}/events/${encoded(eventId)}`,
      { method: "DELETE", headers: { "if-match": current.etag } },
      {
        stage: "delete_event",
        search: { sendUpdates: requiresInvitationUpdates(current) ? "all" : "none" },
      },
    );
  } catch (error) {
    if (!(error instanceof NetworkTransportError)) throw error;
    const recovered = await getEvent(context, { calendar: calendarId, eventId }, true).catch(() => undefined);
    if (recovered === null) {
      return { command: "delete-event", mode: "recovered-after-ambiguous-response", policy: policy.writeMode, eventId };
    }
    throw new CalendarRuntimeError(
      "GOOGLE_CALENDAR_MUTATION_AMBIGUOUS",
      "Google Calendar delete result is ambiguous. Do not repeat it until the event is checked again.",
      { eventId },
    );
  }
  const verification = await getEvent(context, { calendar: calendarId, eventId }, true);
  if (verification !== null) {
    throw new CalendarRuntimeError(
      "GOOGLE_CALENDAR_MUTATION_NOT_VERIFIED",
      "Google accepted the delete request, but the event is still readable.",
      { eventId },
    );
  }
  return { command: "delete-event", mode: "applied", policy: policy.writeMode, eventId };
}

async function doctor(context, environment = process.env) {
  const filePath = tokenPath(context, environment);
  if (!fs.existsSync(filePath)) {
    return {
      command: "doctor",
      status: "needs_connect",
      companyConnection: { configured: true, clientIdConfigured: true },
      localToken: { exists: false },
      policy: loadPolicy(context, environment),
    };
  }
  assertPrivateFile(filePath);
  const calendars = await listCalendars(context, { max: 10 });
  return {
    command: "doctor",
    status: "connected",
    companyConnection: { configured: true, clientIdConfigured: true },
    localToken: { exists: true, fileMode: process.platform === "win32" ? null : (fs.statSync(filePath).mode & 0o777).toString(8) },
    policy: loadPolicy(context, environment),
    calendarCount: calendars.items.length,
    primaryCalendar: calendars.items.find((item) => item.primary === true) || null,
  };
}

function forgetCredentials(context, args, environment = process.env) {
  if (args.confirm !== true) {
    throw new CalendarRuntimeError(
      "GOOGLE_CALENDAR_CONFIRMATION_REQUIRED",
      "Removing the local OAuth token requires --confirm.",
    );
  }
  const filePath = tokenPath(context, environment);
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  return {
    command: "forget-credentials",
    status: "removed",
    note: "The local token was removed. Revoke the Google grant separately if required.",
  };
}

function help() {
  return {
    command: "help",
    commands: {
      connect: "Open Google OAuth in the browser and save the member token locally.",
      doctor: "Check company configuration, local token, policy and live Calendar API access.",
      calendars: "List accessible calendars: [--max 100].",
      events: "List/search a bounded range: --calendar primary [--days 14 | --time-min RFC3339 --time-max RFC3339] [--query TEXT] [--max 50].",
      "get-event": "Read one event: --calendar ID --event-id ID.",
      "create-event": "Preview, then apply with --apply --request-id ID --expected-plan-hash HASH and policy confirmation.",
      "update-event": "Preview, then apply with --apply --expected-etag ETAG --expected-plan-hash HASH and policy confirmation.",
      "delete-event": "Preview, then apply with --apply --expected-etag ETAG --expected-plan-hash HASH and policy confirmation.",
      policy: "policy show | policy set --mode confirm|autonomous|read-only.",
      "forget-credentials": "Remove only the local member token with --confirm.",
    },
  };
}

export async function run(argv, environment = process.env) {
  const args = parseArgs(argv);
  const command = args._[0] || "help";
  if (["help", "--help", "-h"].includes(command)) return help();
  const context = loadRuntimeContext(environment);
  switch (command) {
    case "connect":
      return connect(context, args, environment);
    case "doctor":
      return doctor(context, environment);
    case "calendars":
      return listCalendars(context, args);
    case "events":
      return listEvents(context, args);
    case "get-event":
      return { command: "get-event", calendarId: calendarIdFromArgs(args), event: await getEvent(context, args) };
    case "create-event":
      return createEvent(context, args);
    case "update-event":
      return updateEvent(context, args);
    case "delete-event":
      return deleteEvent(context, args);
    case "policy": {
      const policyCommand = args._[1] || "show";
      if (policyCommand === "show") {
        return { command: "policy", policy: loadPolicy(context, environment), allowAutonomous: context.config.allowAutonomous };
      }
      if (policyCommand === "set") {
        return { command: "policy", policy: setPolicy(context, args.mode, environment), allowAutonomous: context.config.allowAutonomous };
      }
      throw new CalendarRuntimeError("GOOGLE_CALENDAR_INPUT_INVALID", "policy command must be show or set.");
    }
    case "forget-credentials":
      return forgetCredentials(context, args, environment);
    default:
      throw new CalendarRuntimeError("GOOGLE_CALENDAR_INPUT_INVALID", `Unknown command: ${command}.`);
  }
}

async function main() {
  try {
    jsonOut(await run(process.argv.slice(2)));
  } catch (error) {
    const normalized = error instanceof CalendarRuntimeError
      ? error
      : new CalendarRuntimeError("GOOGLE_CALENDAR_INTERNAL_ERROR", "Google Calendar runtime failed safely.");
    process.stderr.write(`${JSON.stringify({
      error: {
        code: normalized.code,
        message: normalized.message,
        ...(normalized.details ? { details: normalized.details } : {}),
      },
    }, null, 2)}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
