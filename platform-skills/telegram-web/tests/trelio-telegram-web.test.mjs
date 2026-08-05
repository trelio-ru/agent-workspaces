import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import http from "node:http";
import {
  chmodSync,
  mkdirSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import { createRequire } from "node:module";
import { EventEmitter } from "node:events";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  CONSENT_STATEMENTS,
  CONSENT_STATEMENT_DIGEST,
  CONSENT_TERMS_VERSION,
  CONSENT_VALID_DAYS,
  TelegramWebRuntimeError,
  __testing,
  acceptConsentInProtectedBrowser,
  accountDigestFromTelegramUserId,
  bootstrapBrowserRuntime,
  buildChromiumLaunchOptions,
  classifyTelegramSurface,
  isAllowedTelegramTopLevelUrl,
  normalizeChatReference,
  parseArguments,
  readCurrentTelegramAccountDigest,
  renderConsentStatus,
  requireRuntimeIdentity,
  runCli as runCliRuntime,
  runtimeApprovalIdentityBinding,
  runtimeLocations,
  sanitizeBrowserEnvironment,
  saveDownloadExclusively,
  telegramWebUrlForAccount,
} from "../scripts/trelio-telegram-web.mjs";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const skillDirectory = path.resolve(testDirectory, "..");
const runtimePath = path.join(skillDirectory, "scripts", "trelio-telegram-web.mjs");
const integrationContractPath = path.resolve(skillDirectory, "..", "..", "docs", "maintainers", "integration-contracts.md");
const companyId = "11111111-1111-4111-8111-111111111111";
const memberId = "22222222-2222-4222-8222-222222222222";
const connectionId = "33333333-3333-4333-8333-333333333333";
const accountDigest = "a".repeat(64);
const noncanonicalSlotOneUrls = [
  "https://web.telegram.org/k/?",
  "https://user:pass@web.telegram.org/k/",
  "https://web.telegram.org:443/k/",
  "https://web.telegram.org/foo/../k/",
  "https://web.telegram.org/k/\t",
  "https://web.telegram.org/k/\n",
  "HTTPS://WEB.TELEGRAM.ORG/k/",
];
const noncanonicalSlotTwoUrls = [
  "https://web.telegram.org/k/?account=%32",
  "https://web.telegram.org/k/?%61ccount=2",
  "https://web.telegram.org/k/?acc%6funt=2",
  "https://web.telegram.org/k/?account=2&",
];
const unsafeDisplayCodePoints = [
  "\u00AD",
  "\u034F",
  "\u180E",
  "\u200B",
  "\u200C",
  "\u200D",
  "\u2060",
  "\u206A",
  "\uFE0F",
];

// The deterministic suite also runs on Linux CI even though the production
// runtime intentionally rejects that unqualified host lane. Every behavioral
// run injects a supported lane; the dedicated platform regression below tests
// the real fail-closed decision directly.
const runCli = (argv, environment, dependencies = {}) => runCliRuntime(
  argv,
  environment,
  { platform: "darwin", ...dependencies },
);

const environmentFor = (temporaryDirectory, overrides = {}) => ({
  ...process.env,
  TRELIO_CONFIG_HOME: path.join(temporaryDirectory, "config"),
  TRELIO_CACHE_HOME: path.join(temporaryDirectory, "cache"),
  TRELIO_SKILL_ID: "telegram-web",
  TRELIO_SKILL_RUNTIME_VERSION: "1.0.1",
  TRELIO_SKILL_COMPANY_ID: companyId,
  TRELIO_SKILL_MEMBER_ID: memberId,
  TRELIO_SKILL_CONNECTION_ID: connectionId,
  TRELIO_SKILL_CONNECTION_CONFIG_JSON: JSON.stringify({ allowAutonomous: false }),
  ...overrides,
});

const identityFor = (environment) => requireRuntimeIdentity(environment);

const expectCode = async (action, code) => {
  await assert.rejects(action, (error) => {
    assert.equal(error instanceof TelegramWebRuntimeError, true);
    assert.equal(error.code, code);
    return true;
  });
};

const attachApprovalContext = (options, identity, environment) => {
  const locations = runtimeLocations(identity, environment);
  options.runtimeIdentityBinding = runtimeApprovalIdentityBinding(identity);
  options.runtimeIdentityObject = identity;
  options.currentAccountDigest = accountDigest;
  if (!options.account) options.account = 1;
  options.approvalContext = {
    pendingApprovalFile: locations.pendingApprovalFile,
    configHome: environment.TRELIO_CONFIG_HOME,
    environment,
  };
  return options;
};

const installValidConsent = async (identity, environment, digest) => {
  const locations = runtimeLocations(identity, environment);
  await __testing.ensurePrivateTree(environment.TRELIO_CONFIG_HOME, path.dirname(locations.consentFile), environment);
  const acceptedAt = new Date();
  const record = {
    termsVersion: CONSENT_TERMS_VERSION,
    statementDigest: CONSENT_STATEMENT_DIGEST,
    accountDigest: digest,
    acceptedAt: acceptedAt.toISOString(),
    expiresAt: new Date(acceptedAt.getTime() + CONSENT_VALID_DAYS * 86_400_000).toISOString(),
  };
  await writeFile(locations.consentFile, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  if (process.platform !== "win32") await chmod(locations.consentFile, 0o600);
  return record;
};

// Deterministic fixtures for the live Web K parser under the source-validated
// contract. These are
// intentionally not a general parser imitation: each case states what the
// authoritative `ChatInput.getValueAndEntities` mock returns for one regression
// payload, including malformed lookalikes that Web K does not recognize.
const pinnedAutomaticEntitiesFixture = (text) => {
  if (text === "https://example.com") {
    return [{ _: "messageEntityUrl", offset: 0, length: text.length }];
  }
  if (text === "@alice") {
    return [{ _: "messageEntityMention", offset: 0, length: text.length }];
  }
  if (text === "hello @alice https://x.test 😀") {
    const url = "https://x.test";
    return [{ _: "messageEntityUrl", offset: text.indexOf(url), length: url.length }];
  }
  if (text === "😀") {
    return [{ _: "messageEntityEmoji", offset: 0, length: text.length, unicode: "1f600" }];
  }
  if (text === "/start") {
    return [{ _: "messageEntityBotCommand", offset: 0, length: text.length, unsafe: true }];
  }
  return [];
};

const makePinnedEntityParserSurface = (querySelectorAll = () => []) => {
  const body = { append: () => undefined };
  const document = {
    body,
    querySelectorAll,
    createElement: () => ({
      contentEditable: "false",
      style: {},
      textContent: "",
      setAttribute: () => undefined,
      remove: () => undefined,
    }),
  };
  const input = {
    getValueAndEntities: (element) => ({
      value: String(element.textContent || ""),
      totalEntities: pinnedAutomaticEntitiesFixture(String(element.textContent || "")),
    }),
  };
  return { document, input };
};

const decisiveBrowserGlobals = (peerId = "123", userId = "987654321") => {
  const topbar = {
    getAttribute: (name) => name === "data-peer-id" ? peerId : null,
    getBoundingClientRect: () => ({ width: 100, height: 20 }),
  };
  const parserSurface = makePinnedEntityParserSurface(
    (selector) => selector.includes("peer-title[data-peer-id]") ? [topbar] : [],
  );
  return {
    location: { href: "https://web.telegram.org/k/" },
    document: parserSurface.document,
    getComputedStyle: () => ({ display: "block", visibility: "visible" }),
    rootScope: { myId: Number(userId) },
    appImManager: { chat: {
      peerId: Number(peerId),
      type: "chat",
      isMonoforum: false,
      input: parserSurface.input,
    } },
  };
};

const withBrowserGlobals = async (values, callback) => {
  const previous = new Map();
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  try {
    return await callback();
  } finally {
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  }
};

const makeModelPage = ({ peerId = "123", waitPolls = 40 } = {}) => ({
  locator: () => ({
    evaluateAll: async () => [peerId],
  }),
  evaluate: async (callback, argument) => callback(argument),
  waitForFunction: async (callback, argument) => {
    for (let pass = 0; pass < waitPolls; pass += 1) {
      const value = await callback(argument);
      if (value) return { jsonValue: async () => value };
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    throw new Error("timeout");
  },
  waitForTimeout: async () => undefined,
});

test("CLI advertises the exact verified text/document surface and rejects broad operations before browser launch", async () => {
  const help = await runCli(["help"]);
  assert.equal(help.accountSlot, null);
  assert.match(help.usage, /edit --chat EXACT --message-id ID --message TEXT --pages N --dry-run/u);
  assert.match(help.usage, /logout --dry-run \(headed owner handoff\)/u);
  assert.match(help.usage, /inspect --account SLOT \[--hold-ms MS\] \(headed read-only\)/u);
  assert.match(help.usage, /send --chat EXACT \(--message TEXT \| --file ABSOLUTE_PATH \[--message CAPTION\]\) --dry-run/u);
  assert.match(help.usage, /forward/u);
  for (const argv of [
    ["reply", "--chat", "Target", "--message-id", "1", "--message", "x", "--pages", "3", "--dry-run"],
    ["edit", "--chat", "Target", "--message-id", "1", "--message", "x", "--pages", "3", "--dry-run"],
    ["delete", "--chat", "Target", "--message-id", "1", "--delete-scope", "me", "--pages", "3", "--dry-run"],
  ]) assert.equal(parseArguments(argv).pages, 3);
  assert.throws(
    () => parseArguments(["inspect", "--hold-ms", "10000"]),
    (error) => error.code === "TELEGRAM_WEB_INVALID_ARGUMENT" && /explicit canonical --account/u.test(error.message),
  );
  assert.throws(
    () => parseArguments(["inspect", "--account", "1", "--headless"]),
    (error) => error.code === "TELEGRAM_WEB_INVALID_ARGUMENT" && /rejects --headless/u.test(error.message),
  );

  const temporaryDirectory = await realpath(await mkdtemp(path.join(os.homedir(), ".telegram-web-cli-")));
  try {
    const environment = environmentFor(temporaryDirectory);
    const unsupportedBeforeBrowser = [
      ["react", "--chat", "Target", "--message-id", "1", "--reaction", "👍", "--confirm"],
      ["forward", "--chat", "Source", "--message-id", "1", "--to-chat", "Target"],
      ["create-group", "--title", "Group", "--member", "@firstuser", "--member", "@seconduser", "--dry-run"],
      ["members", "--chat", "Target", "--limit", "10"],
      ["member-add", "--chat", "Target", "--member", "@firstuser", "--dry-run"],
      ["member-remove", "--chat", "Target", "--member", "@firstuser", "--dry-run"],
      ["chat-update", "--chat", "Target", "--title", "Renamed", "--dry-run"],
      ["reply", "--chat", "123", "--message-id", "1", "--message", "x", "--file", "/does/not/exist"],
      ["create-direct", "--contact", "@firstuser", "--message", "x", "--file", "/does/not/exist"],
      ["watch", "--chat", "Target", "--iterations", "2"],
    ];
    for (const argv of unsupportedBeforeBrowser) {
      await expectCode(() => runCli(argv, environment), "TELEGRAM_WEB_UNSUPPORTED_OPERATION");
    }
    assert.equal(await lstat(environment.TRELIO_CONFIG_HOME).catch(() => null), null);
    assert.equal(await lstat(environment.TRELIO_CACHE_HOME).catch(() => null), null);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test("unqualified Linux and Windows hosts fail before doctor, bootstrap, or profile state", async () => {
  assert.equal(__testing.validateSupportedPlatform("darwin"), "darwin");
  for (const platform of ["linux", "win32"]) {
    await expectCode(
      () => Promise.resolve().then(() => __testing.validateSupportedPlatform(platform)),
      "TELEGRAM_WEB_UNSUPPORTED_OPERATION",
    );
  }
  const temporaryDirectory = await realpath(await mkdtemp(path.join(os.homedir(), ".telegram-web-platform-")));
  try {
    const environment = environmentFor(temporaryDirectory);
    await expectCode(
      () => runCliRuntime(["doctor"], environment, { platform: "linux" }),
      "TELEGRAM_WEB_UNSUPPORTED_OPERATION",
    );
    assert.equal(await lstat(environment.TRELIO_CONFIG_HOME).catch(() => null), null);
    assert.equal(await lstat(environment.TRELIO_CACHE_HOME).catch(() => null), null);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test("account slots use the strict canonical safe subset of official URL selection and never expose raw account IDs", () => {
  assert.equal(telegramWebUrlForAccount(1), "https://web.telegram.org/k/");
  assert.equal(telegramWebUrlForAccount(2), "https://web.telegram.org/k/?account=2");
  assert.equal(telegramWebUrlForAccount(4, "-123"), "https://web.telegram.org/k/?account=4#-123");
  assert.throws(() => telegramWebUrlForAccount(5), /slot/u);
  assert.match(accountDigestFromTelegramUserId("987654321"), /^[0-9a-f]{64}$/u);
  assert.doesNotMatch(accountDigestFromTelegramUserId("987654321"), /987654321/u);
  assert.equal(isAllowedTelegramTopLevelUrl("https://web.telegram.org/k/", 1), true);
  assert.equal(isAllowedTelegramTopLevelUrl("https://web.telegram.org/k/?account=2#123", 2), true);
  for (const href of [...noncanonicalSlotOneUrls, ...noncanonicalSlotTwoUrls]) {
    assert.equal(isAllowedTelegramTopLevelUrl(href), false, href);
  }
  assert.equal(isAllowedTelegramTopLevelUrl("https://web.telegram.org/k/#"), false);
  for (const unsafe of ["0", "00", "01", "9007199254740992", "999999999999999999999999"]) {
    assert.throws(
      () => accountDigestFromTelegramUserId(unsafe),
      (error) => error.code === "TELEGRAM_WEB_ACCOUNT_ID_INVALID",
    );
  }
});

test("public probe/readback exposes only the selected canonical account slot", async () => {
  const temporaryDirectory = await realpath(await mkdtemp(path.join(os.homedir(), ".telegram-web-public-slot-")));
  try {
    const environment = environmentFor(temporaryDirectory);
    // The probe envelope is platform-neutral; real browser path/ACL discovery
    // has separate regressions and must not depend on whichever Chrome symlink
    // a hosted CI image happens to preinstall.
    const probe = await runCli(["probe", "--account", "3"], environment, {
      findChromeExecutable: async () => null,
    });
    assert.equal(probe.accountSlot, 3);
    assert.equal(probe.accessStatus, "not_configured");
    assert.equal(JSON.stringify(probe).includes(accountDigest), false);
    assert.equal(JSON.stringify(probe).includes("987654321"), false);
    assert.deepEqual(__testing.withPublicAccountSlot({ ok: true, command: "read" }, 4), {
      ok: true,
      command: "read",
      accountSlot: 4,
    });
    assert.throws(
      () => __testing.withPublicAccountSlot({ ok: true, accountSlot: 2 }, 3),
      (error) => error.code === "TELEGRAM_WEB_ACCOUNT_CHANGED",
    );
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test("headed inspect is consent-independent, slot-visible, read-only, and never asserts repair", async () => {
  const temporaryDirectory = await realpath(await mkdtemp(path.join(os.homedir(), ".telegram-web-inspect-")));
  try {
    const environment = environmentFor(temporaryDirectory);
    let broughtToFront = 0;
    let held = 0;
    let browserCalls = 0;
    let digestReads = 0;
    const inspectionEvents = [];
    const page = {
      url: () => "https://web.telegram.org/k/?account=3",
      bringToFront: async () => { broughtToFront += 1; },
    };
    const dependencies = {
      withTelegramBrowser: async (_identity, options, callback) => {
        browserCalls += 1;
        assert.equal(options.command, "inspect");
        assert.equal(options.account, 3);
        assert.equal(options.headed, true);
        return callback({ page });
      },
      openTelegramHome: async (_page, options, contract) => {
        assert.equal(options.account, 3);
        assert.deepEqual(contract, { allowLoggedOut: true });
        return { supported: true, loggedIn: true, locked: false, hasChatList: true, hasComposer: true };
      },
      classifyTelegramSurface: async () => ({
        supported: true,
        loggedIn: true,
        locked: false,
        hasChatList: true,
        hasComposer: true,
      }),
      readCurrentTelegramAccountDigest: async (_page, account) => {
        digestReads += 1;
        assert.equal(account, 3);
        return accountDigest;
      },
      waitForInspection: async (_page, holdMs) => {
        held += 1;
        assert.equal(holdMs, 10_000);
      },
      emitInspectionEvent: (event) => { inspectionEvents.push(event); },
    };
    // No consent record is installed: inspect is an authentication/recovery
    // surface and must remain usable after consent revocation.
    const inspected = await runCli([
      "inspect", "--account", "3", "--hold-ms", "10000",
    ], environment, dependencies);
    assert.equal(browserCalls, 1);
    assert.equal(broughtToFront, 1);
    assert.equal(held, 1);
    assert.equal(digestReads, 2);
    assert.equal(inspectionEvents.length, 1);
    assert.equal(inspectionEvents[0].accountSlot, 3);
    assert.equal(inspectionEvents[0].repairVerified, false);
    assert.equal(inspected.accountSlot, 3);
    assert.equal(inspected.headed, true);
    assert.equal(inspected.runtimeReadOnly, true);
    assert.equal(inspected.runtimeMutationsPerformed, false);
    assert.equal(inspected.contentConsentRequired, false);
    assert.equal(inspected.contentConsentChecked, false);
    assert.equal(inspected.repairState, "not_asserted");
    assert.equal(inspected.repairVerified, false);
    assert.equal(inspected.canonicalHomeUrl, "https://web.telegram.org/k/?account=3");
    assert.equal(JSON.stringify(inspected).includes(accountDigest), false);

    let loggedOutHeld = 0;
    await expectCode(() => runCli([
      "inspect", "--account", "3", "--hold-ms", "10000",
    ], environment, {
      ...dependencies,
      openTelegramHome: async () => ({
        supported: true,
        loggedIn: false,
        login: true,
        locked: false,
        hasChatList: false,
        hasComposer: false,
      }),
      waitForInspection: async () => { loggedOutHeld += 1; },
    }), "TELEGRAM_WEB_LOGIN_REQUIRED");
    assert.equal(loggedOutHeld, 0);

    let identityRead = 0;
    await expectCode(() => runCli([
      "inspect", "--account", "3", "--hold-ms", "10000",
    ], environment, {
      ...dependencies,
      readCurrentTelegramAccountDigest: async () => {
        identityRead += 1;
        return identityRead === 1 ? "a".repeat(64) : "b".repeat(64);
      },
    }), "TELEGRAM_WEB_ACCOUNT_CHANGED");
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test("pre-consent surface classification is structural and never reads broad body text", async () => {
  const classify = async (surface) => {
    let bodyTextReads = 0;
    const visibleElement = {
      getBoundingClientRect: () => ({ width: 100, height: 40 }),
    };
    const body = {};
    Object.defineProperty(body, "innerText", {
      get() {
        bodyTextReads += 1;
        throw new Error("body chat content must never be read before consent");
      },
    });
    const document = {
      body,
      querySelectorAll: (selector) => {
        if (surface === "logged_in" && selector === ".chatlist-chat[data-peer-id]") return [visibleElement];
        if (surface === "login" && selector.includes("canvas,")) return [visibleElement];
        if (surface === "locked" && selector.includes('input[type="password"]')) return [visibleElement];
        if (surface === "locked" && selector === ".btn-primary.btn-color-primary") return [visibleElement];
        return [];
      },
    };
    const result = await withBrowserGlobals({
      document,
      getComputedStyle: () => ({ display: "block", visibility: "visible" }),
    }, () => classifyTelegramSurface({
      evaluate: async (callback, argument) => callback(argument),
    }));
    assert.equal(bodyTextReads, 0);
    return result;
  };

  assert.deepEqual(await classify("logged_in"), {
    loggedIn: true,
    login: false,
    locked: false,
    supported: true,
    hasChatList: true,
    hasComposer: false,
  });
  assert.equal((await classify("login")).login, true);
  assert.equal((await classify("locked")).locked, true);
});

test("login owner handoff survives virtual 30 seconds, keeps 2FA protected, and never reads or types its password", async () => {
  let virtualNow = 0;
  let forbiddenCredentialAccesses = 0;
  let digestReads = 0;
  let firstFinalDigestReadAt = null;
  let observedProtectedSurfaceAfterThirtySeconds = false;
  const secretSentinel = "never-expose-this-2fa-password";
  const visible = {
    getBoundingClientRect: () => ({ width: 120, height: 40 }),
  };
  const hidden = {
    getBoundingClientRect: () => ({ width: 0, height: 0 }),
  };
  const password = new Proxy(visible, {
    get(target, property, receiver) {
      if (["value", "textContent", "innerText", "innerHTML", "outerHTML", "getAttribute"].includes(property)) {
        forbiddenCredentialAccesses += 1;
        throw new Error(secretSentinel);
      }
      return Reflect.get(target, property, receiver);
    },
  });
  const document = {
    querySelectorAll: (selector) => {
      const transientAuthenticatedShell = virtualNow >= 10_000 && virtualNow < 10_500;
      const twoFactorVisible = virtualNow >= 30_000 && virtualNow < 45_000;
      const authenticated = transientAuthenticatedShell || virtualNow >= 45_000;
      if (selector === ".chatlist-chat[data-peer-id]") return authenticated ? [visible] : [];
      if (selector === '.input-message-input[contenteditable="true"]') {
        // Web K may keep a stale chat composer mounted behind the 2FA card.
        // Make it visible here as the stronger regression: password wins even
        // over a background authenticated-looking surface.
        return twoFactorVisible ? [visible] : [hidden];
      }
      if (selector === ".bubbles-inner") return [];
      if (selector.includes('input[type="password"]')) return twoFactorVisible ? [password] : [];
      if (selector === ".btn-primary.btn-color-primary") return twoFactorVisible ? [visible] : [];
      if (selector.includes("canvas,")) {
        return virtualNow < 30_000 && !transientAuthenticatedShell ? [visible] : [];
      }
      return [];
    },
  };
  const page = new Proxy({
    evaluate: async (callback, argument) => callback(argument),
    waitForTimeout: async (delayMs) => {
      virtualNow += delayMs;
      if (virtualNow > 30_000 && virtualNow < 45_000) {
        observedProtectedSurfaceAfterThirtySeconds = true;
      }
    },
  }, {
    get(target, property, receiver) {
      if (["fill", "type", "inputValue", "press", "keyboard"].includes(property)) {
        forbiddenCredentialAccesses += 1;
        throw new Error(secretSentinel);
      }
      return Reflect.get(target, property, receiver);
    },
  });

  const digest = await withBrowserGlobals({
    document,
    getComputedStyle: () => ({ display: "block", visibility: "visible" }),
    location: { href: "https://web.telegram.org/k/" },
    rootScope: { myId: 123 },
    AccountController: { get: async () => ({ userId: 123 }) },
    appStorage: { get: async () => ({ id: 123 }) },
    crypto: globalThis.crypto,
    TextEncoder: globalThis.TextEncoder,
  }, async () => __testing.waitForAuthenticatedTelegramAccount(page, 1, 60_000, {
    now: () => virtualNow,
    readCurrentTelegramAccountDigest: async (...args) => {
      digestReads += 1;
      if (virtualNow >= 45_000 && firstFinalDigestReadAt === null) firstFinalDigestReadAt = virtualNow;
      return readCurrentTelegramAccountDigest(...args);
    },
  }));

  assert.match(digest, /^[0-9a-f]{64}$/u);
  assert.equal(observedProtectedSurfaceAfterThirtySeconds, true);
  assert.equal(firstFinalDigestReadAt, 45_000);
  assert.equal(virtualNow, 46_000);
  assert.equal(digestReads >= 6, true);
  assert.equal(forbiddenCredentialAccesses, 0);
  assert.equal(JSON.stringify({ digest }).includes(secretSentinel), false);
});

test("login hold expires at its own deadline beyond 30 seconds and releases the profile lock", async () => {
  const temporaryDirectory = await realpath(await mkdtemp(path.join(os.homedir(), ".telegram-web-login-hold-")));
  try {
    const environment = environmentFor(temporaryDirectory);
    const identity = identityFor(environment);
    const locations = runtimeLocations(identity, environment);
    let virtualNow = 0;
    const page = {};
    await expectCode(() => __testing.acquireProfileLock(identity, async () => (
      __testing.waitForAuthenticatedTelegramAccount(page, 1, 60_000, {
        now: () => virtualNow,
        classifyTelegramSurface: async () => ({
          supported: true,
          loggedIn: false,
          login: false,
          locked: true,
          hasChatList: false,
          hasComposer: false,
        }),
        waitForPoll: async (delayMs) => { virtualNow += delayMs; },
      })
    ), environment), "TELEGRAM_WEB_LOGIN_TIMEOUT");
    assert.equal(virtualNow, 60_000);
    assert.equal(await lstat(locations.lockFile).catch(() => null), null);
    let reacquired = false;
    await __testing.acquireProfileLock(identity, async () => { reacquired = true; }, environment);
    assert.equal(reacquired, true);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test("login call-site rearms the referenced lifecycle after setup and never restores one long provider wait", async () => {
  const options = {
    command: "login",
    account: 1,
    holdMs: 160,
    timeoutMs: 90,
    headed: false,
  };
  let teardownVerified = false;
  let abortTeardowns = 0;
  let broughtToFront = false;
  let waitForFunctionReads = 0;
  const rawPage = {
    bringToFront: async () => { broughtToFront = true; },
  };
  Object.defineProperty(rawPage, "waitForFunction", {
    get() {
      waitForFunctionReads += 1;
      throw new Error("login must use bounded structural polls");
    },
  });

  const result = await __testing.runLoginCommand({}, options, {}, {
    bootstrapBrowserRuntime: async () => undefined,
    openTelegramHome: async () => {
      // Consume most of the setup deadline before the browser is ready. The
      // full owner handoff must start after this phase, not at process start.
      await new Promise((resolve) => setTimeout(resolve, 60));
      return { supported: true, loggedIn: false, login: true, locked: false };
    },
    waitForAuthenticatedTelegramAccount: async (page, account, holdMs) => {
      assert.equal(account, 1);
      assert.equal(holdMs, 160);
      assert.equal(page.bringToFront instanceof Function, true);
      // Setup + this wait exceeds the original 90 ms deadline. A stale outer
      // race timer would abort here even though the fresh handoff is healthy.
      await new Promise((resolve) => setTimeout(resolve, 70));
      return "f".repeat(64);
    },
    invalidatePendingApproval: async () => undefined,
    savePreferredAccount: async () => undefined,
    withTelegramBrowser: async (_identity, effectiveOptions, callback) => {
      const lifecycle = __testing.createCommandLifecycle(effectiveOptions);
      effectiveOptions.commandLifecycle = lifecycle;
      lifecycle.setAbortHandler(() => {
        abortTeardowns += 1;
        teardownVerified = true;
      });
      const page = __testing.boundedPageProxy(rawPage, lifecycle, effectiveOptions);
      try {
        return await lifecycle.race(callback({ page }), "running login call-site regression");
      } finally {
        lifecycle.stop();
        delete effectiveOptions.commandLifecycle;
        teardownVerified = true;
      }
    },
  });

  assert.equal(result.command, "login");
  assert.equal(result.loggedIn, true);
  assert.equal(broughtToFront, true);
  assert.equal(teardownVerified, true);
  assert.equal(abortTeardowns, 0);
  assert.equal(waitForFunctionReads, 0);
});

test("logout and inspect owner handoffs replace the setup deadline without weakening outcome classification", async () => {
  const exercise = async (command, decisive) => {
    const lifecycle = __testing.createCommandLifecycle({
      command,
      holdMs: 240,
      timeoutMs: 120,
    });
    try {
      // Start the same unbounded outer race used by withTelegramBrowser before
      // the handoff is armed. It must follow the rearmed global deadline rather
      // than retaining a stale local setup timer.
      const outer = lifecycle.race(
        new Promise((resolve) => setTimeout(() => resolve(command), 170)),
        `${command} outer command`,
      );
      await new Promise((resolve) => setTimeout(resolve, 80));
      if (decisive) lifecycle.markDecisive(`${command} decisive handoff`);
      lifecycle.beginOwnerHandoff(240, `${command} owner handoff deadline`);
      assert.equal(await outer, command);
      lifecycle.assertActive(`${command} completed inside fresh handoff`);
      assert.equal(lifecycle.decisiveAttempted, decisive);
    } finally {
      lifecycle.stop();
    }
  };

  await Promise.all([
    exercise("logout", true),
    exercise("inspect", false),
  ]);
});

test("logout proof rejects composer/auth overlap and requires zero provider accounts with no active identity", async () => {
  const runStructural = (composerPresent) => {
    let virtualNow = 0;
    const visible = { getBoundingClientRect: () => ({ width: 100, height: 40 }) };
    const page = { evaluate: async (callback, argument) => callback(argument) };
    return withBrowserGlobals({
      getComputedStyle: () => ({ display: "block", visibility: "visible" }),
      document: {
        querySelectorAll: (selector) => {
          if (selector.includes("canvas,")) return [visible];
          if (composerPresent && selector === '.input-message-input[contenteditable="true"]') return [visible];
          return [];
        },
      },
    }, () => __testing.waitForVerifiedLoggedOutSurface(page, 1_000, {
      now: () => virtualNow,
      waitForPoll: async (delayMs) => { virtualNow += delayMs; },
      readConfiguredAccountCount: async () => ({
        known: true,
        count: 0,
        activeIdentityPresent: false,
      }),
    }));
  };
  await assert.rejects(() => runStructural(true), /LOGOUT_SURFACE_NOT_VERIFIED/u);
  assert.equal(await runStructural(false), true);

  let longHandoffNow = 0;
  assert.equal(await __testing.waitForVerifiedLoggedOutSurface({}, 60_000, {
    now: () => longHandoffNow,
    classifyTelegramSurface: async () => longHandoffNow < 45_000
      ? { loggedIn: true, locked: false, login: false }
      : { loggedIn: false, locked: false, login: true },
    readConfiguredAccountCount: async () => ({
      known: true,
      count: 0,
      activeIdentityPresent: false,
    }),
    waitForPoll: async (delayMs) => { longHandoffNow += delayMs; },
  }), true);
  assert.equal(longHandoffNow, 45_000);

  // The visible QR/login shell may lead AccountController cleanup by a few
  // frames. Completion requires both proofs in the same poll loop.
  let providerCleanupNow = 0;
  assert.equal(await __testing.waitForVerifiedLoggedOutSurface({}, 2_000, {
    now: () => providerCleanupNow,
    classifyTelegramSurface: async () => ({ loggedIn: false, locked: false, login: true }),
    readConfiguredAccountCount: async () => providerCleanupNow < 750
      ? { known: true, count: 1, activeIdentityPresent: true }
      : { known: true, count: 0, activeIdentityPresent: false },
    waitForPoll: async (delayMs) => { providerCleanupNow += delayMs; },
  }), true);
  assert.equal(providerCleanupNow, 750);

  const providerPage = { evaluate: async (callback) => callback() };
  const providerState = (records, activeIdentity = undefined) => withBrowserGlobals({
    ...(activeIdentity === undefined ? {} : { rootScope: { myId: activeIdentity } }),
    AccountController: { get: async (slot) => records[slot - 1] },
  }, () => __testing.requireVerifiedLoggedOutProviderState(providerPage));
  assert.deepEqual(await providerState([{}, {}, {}, {}]), {
    known: true,
    count: 0,
    activeIdentityPresent: false,
  });
  await expectCode(
    () => providerState([{ userId: 123 }, {}, {}, {}]),
    "TELEGRAM_WEB_UI_UNSUPPORTED",
  );
  await expectCode(
    () => providerState([{}, {}, {}, {}], 123),
    "TELEGRAM_WEB_UI_UNSUPPORTED",
  );
});

test("decisive lease rejects every noncanonical account query before a click", async () => {
  const userId = "987654321";
  const digest = accountDigestFromTelegramUserId(userId);
  const assertSurface = async (href, account, expectedCode = null) => withBrowserGlobals({
    ...decisiveBrowserGlobals("123", userId),
    location: { href },
  }, async () => {
    const operation = () => __testing.readBoundedDecisiveSurface(
      makeModelPage({ peerId: "123" }),
      "123",
      { account, currentAccountDigest: digest },
      "test action",
    );
    if (expectedCode) return expectCode(operation, expectedCode);
    return operation();
  });

  assert.equal((await assertSurface("https://web.telegram.org/k/", 1)).currentDigest, digest);
  assert.equal((await assertSurface("https://web.telegram.org/k/?account=2", 2)).currentDigest, digest);
  for (const href of [
    "https://web.telegram.org/k/?account=02",
    "https://web.telegram.org/k/?account=1",
    "https://web.telegram.org/k/?account=",
    "https://web.telegram.org/k/?account=2junk",
    "https://web.telegram.org/k/?account=2&account=2",
  ]) await assertSurface(href, 1, "TELEGRAM_WEB_ACCOUNT_CHANGED");
  for (const href of noncanonicalSlotOneUrls) {
    await assertSurface(href, 1, "TELEGRAM_WEB_ACCOUNT_CHANGED");
  }
  for (const href of noncanonicalSlotTwoUrls) {
    await assertSurface(href, 2, "TELEGRAM_WEB_ACCOUNT_CHANGED");
  }
});

test("unsafe message IDs fail during argument parsing before every chat side effect", () => {
  const commands = [
    (messageId) => ["reply", "--chat", "Target", "--message-id", messageId, "--message", "x", "--dry-run"],
    (messageId) => ["edit", "--chat", "Target", "--message-id", messageId, "--message", "x", "--dry-run"],
    (messageId) => ["delete", "--chat", "Target", "--message-id", messageId, "--delete-scope", "me", "--dry-run"],
    (messageId) => ["download", "--chat", "Target", "--message-id", messageId, "--output", "/tmp/not-used"],
  ];
  for (const unsafe of ["0", "00", "01", "9007199254740992", "99999999999999999999"]) {
    for (const argv of commands.map((build) => build(unsafe))) {
      assert.throws(() => parseArguments(argv), (error) => error.code === "TELEGRAM_WEB_INVALID_ARGUMENT");
    }
  }
  assert.equal(parseArguments(commands[0]("9007199254740991")).messageId, "9007199254740991");
});

test("relative download output is preserved and rejected instead of being rebound to cwd", async () => {
  const parsed = parseArguments([
    "download", "--chat", "Target", "--message-id", "1", "--output", "relative.bin",
  ]);
  assert.equal(parsed.output, "relative.bin");
  await expectCode(
    () => __testing.ensureOutputPathAvailable(parsed.output, process.env),
    "TELEGRAM_WEB_UNSAFE_PATH",
  );
});

test("current account digest rejects unsafe or malformed root, controller and legacy identities", async () => {
  const runRecords = (rootId, controllerRecord, legacyRecord = null) => withBrowserGlobals({
    location: { href: "https://web.telegram.org/k/" },
    rootScope: { myId: rootId },
    AccountController: { get: async () => controllerRecord },
    appStorage: { get: async () => legacyRecord },
    crypto: globalThis.crypto,
    TextEncoder: globalThis.TextEncoder,
  }, () => readCurrentTelegramAccountDigest({ evaluate: async (callback, argument) => callback(argument) }, 1));
  const run = (rootId, controllerId, legacyId = undefined) => runRecords(
    rootId,
    { userId: controllerId },
    legacyId === undefined ? null : { id: legacyId },
  );

  assert.match(await run(123, 123, 123), /^[0-9a-f]{64}$/u);
  for (const [rootId, controllerId, legacyId] of [
    [0, 0, 0],
    ["01", "01", "01"],
    ["9007199254740992", "9007199254740992", "9007199254740992"],
    [123, 0, 123],
    [123, 123, "9007199254740992"],
  ]) await expectCode(() => run(rootId, controllerId, legacyId), "TELEGRAM_WEB_ACCOUNT_ID_INVALID");
  await expectCode(() => runRecords(123, Object.assign([], { userId: 123 }), { id: 123 }), "TELEGRAM_WEB_ACCOUNT_ID_INVALID");
  await expectCode(() => runRecords(123, Object.assign(Object.create({}), { userId: 123 }), { id: 123 }), "TELEGRAM_WEB_ACCOUNT_ID_INVALID");
  await expectCode(() => runRecords(123, { userId: 123 }, Object.assign([], { id: 123 })), "TELEGRAM_WEB_ACCOUNT_ID_INVALID");
  await expectCode(() => runRecords(123, { userId: 123 }, Object.assign(Object.create({}), { id: 123 })), "TELEGRAM_WEB_ACCOUNT_ID_INVALID");
});

test("account digest rejects noncanonical slot queries before AccountController access", async () => {
  for (const href of [
    "https://web.telegram.org/k/?account=02",
    "https://web.telegram.org/k/?account=1",
    "https://web.telegram.org/k/?account=",
    "https://web.telegram.org/k/?account=2junk",
    "https://web.telegram.org/k/?account=2&account=2",
    ...noncanonicalSlotOneUrls,
    ...noncanonicalSlotTwoUrls,
  ]) {
    let controllerCalls = 0;
    await withBrowserGlobals({
      location: { href },
      rootScope: { myId: 123 },
      AccountController: { get: async () => { controllerCalls += 1; return { userId: 123 }; } },
      appStorage: { get: async () => ({ id: 123 }) },
      crypto: globalThis.crypto,
      TextEncoder: globalThis.TextEncoder,
    }, async () => {
      await expectCode(
        () => readCurrentTelegramAccountDigest({ evaluate: async (callback, argument) => callback(argument) }, null),
        "TELEGRAM_WEB_ACCOUNT_ID_INVALID",
      );
    });
    assert.equal(controllerCalls, 0);
  }
});

test("unsafe numeric PeerIds fail before URL navigation, manager access or a row click", async () => {
  const unsafe = "9007199254740993";
  assert.throws(() => normalizeChatReference(unsafe), (error) => error.code === "TELEGRAM_WEB_INVALID_CHAT");
  assert.throws(() => telegramWebUrlForAccount(1, unsafe), (error) => error.code === "TELEGRAM_WEB_INVALID_CHAT");

  const calls = { goto: 0, evaluate: 0, click: 0, manager: 0 };
  const page = {
    goto: async () => { calls.goto += 1; },
    evaluate: async () => { calls.evaluate += 1; return []; },
    locator: () => ({
      count: async () => 1,
      click: async () => { calls.click += 1; },
    }),
  };
  await expectCode(
    () => __testing.resolveDialog(page, unsafe, { account: 1, timeoutMs: 100 }, { openChat: true }),
    "TELEGRAM_WEB_INVALID_CHAT",
  );
  assert.deepEqual(calls, { goto: 0, evaluate: 0, click: 0, manager: 0 });

  const unsafeRow = {
    getAttribute: (name) => name === "data-peer-id" ? unsafe : null,
    getBoundingClientRect: () => ({ width: 100, height: 40 }),
    querySelector: (selector) => selector === ".peer-title" ? { textContent: "Unsafe" } : null,
    classList: { contains: () => false },
    setAttribute: () => undefined,
  };
  await withBrowserGlobals({
    document: { querySelectorAll: () => [unsafeRow] },
    getComputedStyle: () => ({ display: "block", visibility: "visible" }),
    window: { getComputedStyle: () => ({ display: "block", visibility: "visible" }) },
    rootScope: { myId: 123, managers: { appPeersManager: {
      getPeerActiveUsernames: async () => { calls.manager += 1; return []; },
    } } },
  }, async () => {
    await expectCode(() => __testing.collectDialogRows({
      evaluate: async (callback, argument) => callback(argument),
    }), "TELEGRAM_WEB_UI_UNSUPPORTED");
  });
  assert.equal(calls.manager, 0);
});

test("noncanonical account URL aliases fail before manager access, navigation, or click", async () => {
  const calls = { goto: 0, evaluate: 0, click: 0, manager: 0 };
  const page = {
    goto: async () => { calls.goto += 1; },
    evaluate: async () => { calls.evaluate += 1; calls.manager += 1; return []; },
    locator: () => ({
      count: async () => 1,
      click: async () => { calls.click += 1; },
    }),
  };
  for (const [href, account] of [
    ...noncanonicalSlotOneUrls.map((href) => [href, 1]),
    ...noncanonicalSlotTwoUrls.map((href) => [href, 2]),
  ]) {
    assert.throws(
      () => normalizeChatReference(`${href}#123`, account),
      (error) => error.code === "TELEGRAM_WEB_INVALID_CHAT",
      href,
    );
    await expectCode(
      () => __testing.resolveDialog(page, `${href}#123`, { account, timeoutMs: 100 }, { openChat: true }),
      "TELEGRAM_WEB_INVALID_CHAT",
    );
  }
  assert.deepEqual(calls, { goto: 0, evaluate: 0, click: 0, manager: 0 });
});

test("opaque chat references are never trimmed or Unicode-normalized into a PeerId", async () => {
  assert.deepEqual(normalizeChatReference("１２３"), { kind: "title", value: "１２３" });
  assert.deepEqual(
    normalizeChatReference("ｈｔｔｐｓ：／／ｗｅｂ．ｔｅｌｅｇｒａｍ．ｏｒｇ／ｋ／＃１２３"),
    {
      kind: "title",
      value: "ｈｔｔｐｓ：／／ｗｅｂ．ｔｅｌｅｇｒａｍ．ｏｒｇ／ｋ／＃１２３",
    },
  );
  assert.throws(
    () => normalizeChatReference("https://web.telegram.org/k/#１２３"),
    (error) => error.code === "TELEGRAM_WEB_INVALID_CHAT",
  );
  assert.deepEqual(normalizeChatReference(" 123"), { kind: "title", value: " 123" });
  assert.deepEqual(normalizeChatReference("123 "), { kind: "title", value: "123 " });

  const calls = { goto: 0, evaluate: 0, click: 0 };
  const page = {
    goto: async () => { calls.goto += 1; },
    evaluate: async () => { calls.evaluate += 1; return []; },
    locator: () => ({ click: async () => { calls.click += 1; } }),
  };
  for (const reference of [
    "１２３",
    "ｈｔｔｐｓ：／／ｗｅｂ．ｔｅｌｅｇｒａｍ．ｏｒｇ／ｋ／＃１２３",
    " 123",
    "123 ",
  ]) {
    await expectCode(
      () => __testing.resolveDialog(page, reference, { account: 1, timeoutMs: 100 }, { openChat: true }),
      "TELEGRAM_WEB_AMBIGUOUS_CHAT",
    );
  }
  assert.deepEqual(calls, { goto: 0, evaluate: 0, click: 0 });
});

test("content addressing by title fails before bounded sidebar search can guess uniqueness", async () => {
  const calls = { locator: 0, evaluate: 0, goto: 0, click: 0 };
  const page = {
    locator: () => { calls.locator += 1; return {}; },
    evaluate: async () => { calls.evaluate += 1; return null; },
    goto: async () => { calls.goto += 1; },
  };
  await expectCode(
    () => __testing.resolveDialog(page, "Duplicate title", { account: 1, timeoutMs: 100 }, { openChat: true }),
    "TELEGRAM_WEB_AMBIGUOUS_CHAT",
  );
  assert.deepEqual(calls, { locator: 0, evaluate: 0, goto: 0, click: 0 });
});

test("Saved Messages avatar classes corroborate rootScope.myId without replacing it", async () => {
  const makeRow = (peerId, hasSavedIcon) => ({
    getAttribute: (name) => name === "data-peer-id" ? peerId : null,
    getBoundingClientRect: () => ({ width: 100, height: 40 }),
    querySelector: (selector) => selector === ".peer-title"
      ? { textContent: "Saved Messages" }
      : selector.includes("avatar-icon") && hasSavedIcon
        ? {}
        : null,
    classList: { contains: () => false },
    setAttribute: () => undefined,
  });
  const run = (row) => withBrowserGlobals({
    document: { querySelectorAll: () => [row] },
    getComputedStyle: () => ({ display: "block", visibility: "visible" }),
    window: { getComputedStyle: () => ({ display: "block", visibility: "visible" }) },
    rootScope: { myId: 123, managers: {
      appPeersManager: { getPeerActiveUsernames: async () => [] },
      appMessagesManager: {
        getDialogOnly: async (peerId) => ({ peerId, unread_count: 0, pFlags: {} }),
        isDialogUnread: () => false,
      },
      appNotificationsManager: { isPeerLocalMuted: () => false },
    } },
  }, () => __testing.collectDialogRows({ evaluate: async (callback, argument) => callback(argument) }));
  const valid = await run(makeRow("123", true));
  assert.equal(valid[0].isSelf, true);
  await expectCode(() => run(makeRow("456", true)), "TELEGRAM_WEB_UI_UNSUPPORTED");
});

test("browser and opener child environment is an allowlist with fixed system PATH", () => {
  const sanitized = sanitizeBrowserEnvironment({
    HOME: "/safe/home",
    DISPLAY: ":0",
    WAYLAND_DISPLAY: "wayland-0",
    XAUTHORITY: "/safe/xauth",
    DBUS_SESSION_BUS_ADDRESS: "unix:path=/safe/dbus",
    PATH: "/hostile/bin:/usr/bin",
    SHELL: "/tmp/evil-shell",
    LD_PRELOAD: "/tmp/inject.so",
    LD_LIBRARY_PATH: "/tmp/libs",
    DYLD_INSERT_LIBRARIES: "/tmp/inject.dylib",
    SSLKEYLOGFILE: "/tmp/tls.keys",
    NODE_OPTIONS: "--require /tmp/inject.cjs",
    PLAYWRIGHT_BROWSERS_PATH: "/tmp/pw",
    SECRET_TOKEN: "secret",
  });
  assert.equal(sanitized.HOME, "/safe/home");
  assert.equal(sanitized.DISPLAY, ":0");
  assert.equal(sanitized.XAUTHORITY, "/safe/xauth");
  assert.equal(sanitized.PATH.includes("/hostile"), false);
  for (const key of ["SHELL", "LD_PRELOAD", "LD_LIBRARY_PATH", "DYLD_INSERT_LIBRARIES", "SSLKEYLOGFILE", "NODE_OPTIONS", "PLAYWRIGHT_BROWSERS_PATH", "SECRET_TOKEN"]) {
    assert.equal(Object.hasOwn(sanitized, key), false, key);
  }

  const bootstrap = __testing.sanitizeBootstrapEnvironment({ ...sanitized, NODE_PATH: "/tmp/node" }, {
    cache: "/tmp/npm-cache",
    userConfig: "/tmp/npm-user-config",
    globalConfig: "/tmp/npm-global-config",
  });
  assert.equal(bootstrap.NODE_PATH, undefined);
  assert.equal(bootstrap.npm_config_ignore_scripts, "true");
  assert.equal(bootstrap.npm_config_registry, "https://registry.npmjs.org/");
});

test("automatic entities come from the live source-validated Web K parser and reject bot commands", async () => {
  const parserSurface = makePinnedEntityParserSurface();
  await withBrowserGlobals({
    document: parserSurface.document,
    appImManager: { chat: { input: parserSurface.input } },
    structuredClone: globalThis.structuredClone,
  }, async () => {
    for (const [message, type] of [
      ["https://example.com", "messageEntityUrl"],
      ["@alice", "messageEntityMention"],
      ["😀", "messageEntityEmoji"],
    ]) {
      const entities = await __testing.deriveLiveWebKAutomaticEntities(makeModelPage(), message);
      assert.equal(entities.length, 1);
      assert.equal(entities[0]._, type);
    }
    await expectCode(
      () => __testing.deriveLiveWebKAutomaticEntities(makeModelPage(), "/start"),
      "TELEGRAM_WEB_UNSUPPORTED_OPERATION",
    );
  });
});

test("final model validates entities and totalEntities independently from exact text", async () => {
  const peerId = "123";
  const messageId = "7";
  let model;
  const parserSurface = makePinnedEntityParserSurface();
  await withBrowserGlobals({
    document: parserSurface.document,
    appImManager: { chat: { input: parserSurface.input } },
    rootScope: { managers: { appMessagesManager: { getMessageByPeer: () => model } } },
    structuredClone: globalThis.structuredClone,
  }, async () => {
    const mention = "@alice";
    const mentionEntity = { _: "messageEntityMention", offset: 0, length: mention.length };
    for (const [entities, totalEntities] of [
      [[], [mentionEntity]],
      [[mentionEntity], [mentionEntity]],
    ]) {
      model = {
        _: "message",
        peerId: 123,
        mid: 7,
        message: mention,
        entities,
        totalEntities,
      };
      assert.equal((await __testing.assertFinalPlainTextModelEntities(
        makeModelPage({ peerId }), peerId, messageId, mention,
      )).known, true);
    }
    model = {
      _: "message",
      peerId: 123,
      mid: 7,
      message: "https://example.com",
      entities: [],
      totalEntities: [{ _: "messageEntityUrl", offset: 0, length: "https://example.com".length }],
    };
    await expectCode(
      () => __testing.assertFinalPlainTextModelEntities(
        makeModelPage({ peerId }), peerId, messageId, "https://example.com",
      ),
      "TELEGRAM_WEB_UNSUPPORTED_OPERATION",
    );
    const emoji = "😀";
    model = {
      _: "message",
      peerId: 123,
      mid: 7,
      message: emoji,
      entities: [],
      totalEntities: [{ _: "messageEntityEmoji", offset: 0, length: emoji.length, unicode: "1f600" }],
    };
    await __testing.assertFinalPlainTextModelEntities(makeModelPage({ peerId }), peerId, messageId, emoji);
    for (const [message, unsafeEntity] of [
      [emoji, { _: "messageEntityEmoji", offset: 0, length: emoji.length, unicode: "1f601" }],
      ["x", { _: "messageEntityEmoji", offset: 0, length: 1, unicode: "78" }],
      ["javascript:alert(1)", { _: "messageEntityUrl", offset: 0, length: 19 }],
      ["@abc", { _: "messageEntityMention", offset: 0, length: 4 }],
      ["99:99", { _: "messageEntityTimestamp", offset: 0, length: 5, raw: "99:99", time: 6039 }],
      ["x", { _: "messageEntityBold", offset: 0, length: 1 }],
      ["x", { _: "messageEntityTextUrl", offset: 0, length: 1, url: "https://evil.example" }],
    ]) {
      model = {
        _: "message",
        peerId: 123,
        mid: 7,
        message,
        entities: [],
        totalEntities: [unsafeEntity],
      };
      await expectCode(
        () => __testing.assertFinalPlainTextModelEntities(makeModelPage({ peerId }), peerId, messageId, message),
        "TELEGRAM_WEB_UNSUPPORTED_OPERATION",
      );
    }
  });
});

test("Stars preflight treats fulfilled undefined as official free and fails closed otherwise", async () => {
  const runCase = async ({ amount, throws = false, chatAmount = undefined }, expectedCode = null) => {
    const chat = { peerId: 123 };
    if (chatAmount !== undefined) chat.starsAmount = chatAmount;
    return withBrowserGlobals({
      appImManager: { chat },
      rootScope: {
        managers: {
          appPeersManager: {
            getStarsAmount: throws ? async () => { throw new Error("network"); } : async () => amount,
          },
        },
      },
    }, async () => {
      const page = makeModelPage();
      if (expectedCode) return expectCode(() => __testing.assertNoPaidMessageCost(page, "123"), expectedCode);
      return __testing.assertNoPaidMessageCost(page, "123");
    });
  };
  await runCase({ amount: undefined });
  await runCase({ amount: 0, chatAmount: 0 });
  for (const input of [
    { amount: 1 },
    { amount: null },
    { amount: Number.NaN },
    { amount: -1 },
    { amount: 0, chatAmount: 1 },
    { amount: undefined, throws: true },
  ]) await runCase(input, "TELEGRAM_WEB_UNSUPPORTED_OPERATION");
});

test("live single-message limit uses UTF-16 units and rejects unknown or split payloads", async () => {
  const runLimit = (liveLimit, message) => withBrowserGlobals({
    rootScope: { managers: { apiManager: { getConfig: async () => ({ message_length_max: liveLimit }) } } },
  }, () => __testing.assertLiveSingleMessageLimit(makeModelPage(), message));
  assert.equal(await runLimit(4, "😀😀"), 4);
  await expectCode(() => runLimit(3, "😀😀"), "TELEGRAM_WEB_UNSUPPORTED_OPERATION");
  await expectCode(() => runLimit(undefined, "x"), "TELEGRAM_WEB_UI_UNSUPPORTED");
  await expectCode(() => runLimit(Number.NaN, "x"), "TELEGRAM_WEB_UI_UNSUPPORTED");
});

test("production text transform blocks trim, Markdown, bot command and missing globals before click", async () => {
  const peerId = "123";
  const runTransform = async (message, parse, getRich = (field) => ({ value: field.textContent, entities: [], caretPos: -1 })) => {
    const parserSurface = makePinnedEntityParserSurface();
    return withBrowserGlobals({
      document: parserSurface.document,
      appImManager: { chat: {
        peerId: 123,
        type: "chat",
        isMonoforum: false,
        input: parserSurface.input,
      } },
      getRichValueWithCaret: getRich,
      parseMarkdown: parse,
    }, () => __testing.assertExactProductionTextPayload(makeModelPage({ peerId }), peerId, message));
  };

  await expectCode(
    () => runTransform("hello @alice https://x.test 😀", (text, entities) => [text, entities]),
    "TELEGRAM_WEB_UNSUPPORTED_OPERATION",
  );
  await runTransform("\\**literal**", (text, entities) => [text, entities]);
  await expectCode(() => runTransform(" **bold** ", (text) => [text.trim().replaceAll("**", ""), [{ _: "messageEntityBold", offset: 0, length: 4 }]]), "TELEGRAM_WEB_UNSUPPORTED_OPERATION");
  await expectCode(() => runTransform("[x](https://x.test)", () => ["x", [{ _: "messageEntityTextUrl", offset: 0, length: 1, url: "https://x.test" }]]), "TELEGRAM_WEB_UNSUPPORTED_OPERATION");
  await expectCode(() => runTransform("/start", (text, entities) => [text, entities]), "TELEGRAM_WEB_UNSUPPORTED_OPERATION");
  const parserSurface = makePinnedEntityParserSurface();
  await expectCode(() => withBrowserGlobals({
    document: parserSurface.document,
    appImManager: { chat: {
      peerId: 123,
      type: "chat",
      isMonoforum: false,
      input: parserSurface.input,
    } },
  }, () => __testing.assertExactProductionTextPayload(makeModelPage({ peerId }), peerId, "hello")), "TELEGRAM_WEB_UI_UNSUPPORTED");
});

test("text-send preflight blocks dice media, migrated peers and malformed live config", async () => {
  const runCase = async ({ dice, migrated, malformed = false }, expectedCode = null) => withBrowserGlobals({
    appImManager: { chat: { peerId: 123, type: "chat", isMonoforum: false } },
    rootScope: {
      managers: {
        appPeersManager: { getPeerMigratedTo: () => migrated },
        apiManager: { getAppConfig: async () => ({ emojies_send_dice: malformed ? [1] : dice }) },
      },
    },
  }, async () => {
    const action = () => __testing.assertExactTextSendDestination(makeModelPage(), "123", "🎲");
    if (expectedCode) return expectCode(action, expectedCode);
    return action();
  });
  await runCase({ dice: ["🎯"], migrated: undefined });
  await runCase({ dice: ["🎲"], migrated: undefined }, "TELEGRAM_WEB_UNSUPPORTED_OPERATION");
  await runCase({ dice: [], migrated: 456 }, "TELEGRAM_WEB_UNSUPPORTED_OPERATION");
  await runCase({ dice: [], migrated: 123 });
  await runCase({ malformed: true }, "TELEGRAM_WEB_UI_UNSUPPORTED");
});

test("normal-chat guard rejects scheduled/topic/monoforum surfaces", async () => {
  const runChat = (chat, expectedCode = null) => withBrowserGlobals({ appImManager: { chat } }, async () => {
    const action = () => __testing.assertOpenPeer(makeModelPage(), "123");
    if (expectedCode) return expectCode(action, expectedCode);
    return action();
  });
  await runChat({ peerId: 123, type: "chat", isMonoforum: false });
  await runChat({ peerId: 123, type: "scheduled", isMonoforum: false }, "TELEGRAM_WEB_UNSUPPORTED_OPERATION");
  await runChat({ peerId: 123, type: "chat", threadId: 9, isMonoforum: false }, "TELEGRAM_WEB_UNSUPPORTED_OPERATION");
  await runChat({ peerId: 123, type: "chat", isMonoforum: true }, "TELEGRAM_WEB_UNSUPPORTED_OPERATION");
});

test("message mutations reject bots and create-direct requires an existing non-bot contact", async () => {
  const base = decisiveBrowserGlobals("123");
  const run = (peers, requireContact = false) => withBrowserGlobals({
    ...base,
    rootScope: { ...base.rootScope, managers: { appPeersManager: {
      getPeer: () => ({ _: "user", pFlags: {} }),
      ...peers,
    } } },
  }, () => __testing.assertSafeMutationPeer(makeModelPage({ peerId: "123" }), "123", { requireContact }));

  await run({ isBot: () => false });
  await expectCode(() => run({ isBot: () => true }), "TELEGRAM_WEB_UNSUPPORTED_OPERATION");
  await expectCode(() => run({}, false), "TELEGRAM_WEB_UI_UNSUPPORTED");
  await run({ isBot: () => false, isContact: () => true }, true);
  await expectCode(
    () => run({ isBot: () => false, isContact: () => false }, true),
    "TELEGRAM_WEB_UNSUPPORTED_OPERATION",
  );
});

test("bot classification flip inside the consent lease prevents the decisive click", async () => {
  const temporaryDirectory = await realpath(await mkdtemp(path.join(os.homedir(), ".telegram-web-bot-flip-")));
  try {
    const environment = environmentFor(temporaryDirectory);
    const identity = identityFor(environment);
    const userId = "987654321";
    const digest = accountDigestFromTelegramUserId(userId);
    await installValidConsent(identity, environment, digest);
    const options = attachApprovalContext(parseArguments([
      "send", "--chat", "123", "--message", "hello", "--confirm",
    ]), identity, environment);
    options.currentAccountDigest = digest;
    let classifierCalls = 0;
    let clicks = 0;
    const base = decisiveBrowserGlobals("123", userId);
    await withBrowserGlobals({
      ...base,
      rootScope: {
        ...base.rootScope,
        managers: { appPeersManager: {
          getPeer: () => ({ _: "user", pFlags: {} }),
          isBot: () => ++classifierCalls >= 2,
        } },
      },
    }, async () => {
      await expectCode(() => __testing.dispatchDecisiveMutation({
        page: makeModelPage({ peerId: "123" }),
        expectedPeerId: "123",
        options,
        stage: "send action",
        beforeDispatch: () => __testing.assertSafeMutationPeer(makeModelPage({ peerId: "123" }), "123"),
        insideLease: () => __testing.assertSafeMutationPeer(makeModelPage({ peerId: "123" }), "123"),
        decisiveControl: { click: async () => { clicks += 1; } },
        verify: async () => ({ ok: true }),
        ambiguousMessage: "unexpected",
      }), "TELEGRAM_WEB_UNSUPPORTED_OPERATION");
    });
    assert.equal(classifierCalls, 2);
    assert.equal(clicks, 0);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test("in-chat search uses Web K chat.initSearch without a nonexistent tgico-search button", async () => {
  let modelCalls = 0;
  let waited = 0;
  const input = {
    waitFor: async ({ state }) => { assert.equal(state, "visible"); waited += 1; },
  };
  const inputs = {
    filter: () => inputs,
    first: () => input,
    count: async () => 1,
  };
  const page = {
    locator: (selector) => selector === ".topbar-search-input"
      ? inputs
      : { evaluateAll: async () => ["123"] },
    evaluate: async (callback, argument) => callback(argument),
  };
  await withBrowserGlobals({
    appImManager: { chat: {
      peerId: 123,
      type: "chat",
      isMonoforum: false,
      initSearch: async () => { modelCalls += 1; },
    } },
  }, async () => {
    assert.equal(await __testing.openInChatSearch(page, "123", 60_000), input);
  });
  assert.equal(modelCalls, 1);
  assert.equal(waited, 1);
});

test("search binds message IDs to the active dialog model when row display peer is a sender", async () => {
  const exactDialogPeerId = "-100123";
  const managerCalls = [];
  const page = { evaluate: async (callback, argument) => callback(argument) };
  await withBrowserGlobals({
    rootScope: { myId: 500, managers: {
      appMessagesManager: {
        getMessageByPeer: async (peerId, messageId) => {
          managerCalls.push([peerId, messageId]);
          if (messageId === 6) return {
            _: "message",
            peerId: Number(exactDialogPeerId),
            mid: 6,
            fromId: 500,
            date: 1_799_999_900,
            message: "one-level source",
            entities: [],
            access_hash: "must-not-leak",
          };
          if (messageId === 7) return {
            _: "message",
            peerId: Number(exactDialogPeerId),
            mid: 7,
            fromId: 987654321,
            date: 1_800_000_000,
            message: "visit https://example.com",
            entities: [{ _: "messageEntityUrl", offset: 6, length: 19 }],
            reply_to_mid: 6,
            reply_to: { _: "messageReplyHeader", reply_to_msg_id: 6 },
            media: {
              _: "messageMediaDocument",
              document: {
                _: "document",
                id: "provider-document-id",
                access_hash: "provider-document-access-hash",
                file_reference: [1, 2, 3],
                file_name: "report.pdf",
                size: 1234,
                mime_type: "application/pdf",
                attributes: [{ _: "documentAttributeFilename", file_name: "report.pdf" }],
              },
            },
            access_hash: "must-not-leak",
          };
          return {
            _: "message",
            peerId: Number(exactDialogPeerId),
            mid: messageId,
            date: 1_800_000_100,
            message: messageId === 8 ? "me" : `text-${messageId}`,
            entities: messageId === 8
              ? [{ _: "messageEntityTextUrl", offset: 0, length: 2, url: "tg://user?id=500" }]
              : [],
            totalEntities: messageId === 8
              ? [{ _: "messageEntityMentionName", offset: 0, length: 2, user_id: 500 }]
              : [],
            access_hash: "must-not-leak",
          };
        },
      },
      appPeersManager: {
        getPeerTitle: (peerId) => ({ 456: "Bob", 987654321: "Alice" })[peerId] || null,
      },
    } },
    appImManager: { chat: {
      peerId: Number(exactDialogPeerId),
      type: "chat",
      isMonoforum: false,
      isOutMessage: (message) => message.mid === 8,
    } },
  }, async () => {
    const bound = await __testing.bindInChatSearchResults(page, [
      { messageId: "7", displayPeerId: "987654321" },
      { messageId: "8", displayPeerId: "456" },
    ], exactDialogPeerId);
    assert.deepEqual(bound, [
      {
        messageId: "7",
        peerId: exactDialogPeerId,
        author: "Alice",
        authorPeerId: "987654321",
        authorSemanticId: null,
        timestamp: new Date(1_800_000_000 * 1_000).toISOString(),
        direction: "incoming",
        text: "visit https://example.com",
        linkEntities: [{
          type: "url",
          offsetUtf16: 6,
          lengthUtf16: 19,
          text: "https://example.com",
          target: "https://example.com",
        }],
        linkEntitiesTruncated: false,
        attachments: [{
          index: 1,
          kind: "document",
          name: "report.pdf",
          sizeBytes: 1234,
          mimeType: "application/pdf",
        }],
        reply: {
          messageId: "6",
          contextAvailable: true,
          simple: null,
          author: null,
          authorPeerId: null,
          authorSemanticId: "self",
          timestamp: new Date(1_799_999_900 * 1_000).toISOString(),
          text: "one-level source",
          linkEntities: [],
          linkEntitiesTruncated: false,
        },
      },
      {
        messageId: "8",
        peerId: exactDialogPeerId,
        author: null,
        authorPeerId: null,
        authorSemanticId: "self",
        timestamp: new Date(1_800_000_100 * 1_000).toISOString(),
        direction: "outgoing",
        text: "me",
        linkEntities: [{
          type: "text_url",
          offsetUtf16: 0,
          lengthUtf16: 2,
          text: "me",
          target: null,
        }],
        linkEntitiesTruncated: false,
        attachments: [],
        reply: null,
      },
    ]);
    assert.equal(JSON.stringify(bound).includes("access_hash"), false);
    assert.equal(JSON.stringify(bound).includes("must-not-leak"), false);
    assert.equal(JSON.stringify(bound).includes("provider-document"), false);
    assert.equal(JSON.stringify(bound).includes("500"), false, "raw current-account id must not occur anywhere in public search JSON");
  });
  assert.deepEqual(managerCalls, [[-100123, 7], [-100123, 6], [-100123, 8]]);

  await withBrowserGlobals({
    rootScope: { managers: { appMessagesManager: {
      getMessageByPeer: async (_peerId, messageId) => ({ _: "message", peerId: 999, mid: messageId, message: "wrong" }),
    } } },
  }, async () => {
    await expectCode(() => __testing.bindInChatSearchResults(page, [
      { messageId: "7", displayPeerId: "987654321" },
    ], exactDialogPeerId), "TELEGRAM_WEB_UI_UNSUPPORTED");
  });
});

test("message artifacts bound link entities and null unsafe hidden targets", async () => {
  const parts = Array.from({ length: 40 }, (_, index) => `https://e.test/${String(index).padStart(2, "0")}`);
  const textValue = parts.join(" ");
  let cursor = 0;
  const entities = parts.map((part, index) => {
    const entity = {
      _: index === 0 ? "messageEntityTextUrl" : "messageEntityUrl",
      offset: cursor,
      length: part.length,
      ...(index === 0 ? { url: "javascript:alert(1)" } : {}),
    };
    cursor += part.length + 1;
    return entity;
  });
  const page = { evaluate: async (callback, argument) => callback(argument) };
  const [artifact] = await withBrowserGlobals({
    rootScope: { managers: {
      appMessagesManager: { getMessageByPeer: async () => ({
        _: "message",
        peerId: 123,
        mid: 1,
        date: 1_800_000_000,
        message: textValue,
        entities,
        access_hash: "never-public",
      }) },
      appPeersManager: {},
    } },
  }, () => __testing.readExactMessageArtifacts(page, [{ messageId: "1" }], "123"));
  assert.equal(artifact.linkEntities.length, 32);
  assert.equal(artifact.linkEntitiesTruncated, true);
  assert.equal(artifact.linkEntities[0].type, "text_url");
  assert.equal(artifact.linkEntities[0].target, null);
  assert.equal(JSON.stringify(artifact).includes("javascript"), false);
  assert.equal(JSON.stringify(artifact).includes("access_hash"), false);
  assert.equal(JSON.stringify(artifact).includes("never-public"), false);
});

test("hidden Telegram and Web K self targets fail closed across duplicate, malformed, and nested encodings", async () => {
  const nestedTelegram = `tg://msg_url?url=${encodeURIComponent("tg://user?id=500")}`;
  const multiplyEncodedTelegram = `tg://msg_url?url=${encodeURIComponent(encodeURIComponent("tg://user?id=%35%30%30"))}`;
  const wrap = (target) => `https://example.test/?next=${encodeURIComponent(target)}`;
  const nestedHttpFour = wrap(wrap(wrap(wrap("https://web.telegram.org/k/#500"))));
  const nestedHttpFive = wrap(nestedHttpFour);
  const cases = [
    ["tg://user?id=500", null, true],
    ["tg://user?id=500&id=999", null, true],
    ["tg://user?id=999&id=500", null, true],
    ["tg://user?id=500&id=500", null, true],
    ["tg://user?id=501&id=501", null, false],
    ["tg://user", null, false],
    ["tg://user?id=", null, false],
    ["tg://user?id=0500", null, true],
    ["tg://user?id=500x", null, true],
    ["tg://user?id=9007199254740992", null, false],
    ["tg://user?id=501&hash=x", null, false],
    ["tg:%75ser?id=500", null, true],
    ["tg://user/500?id=999", null, true],
    ["tg://500@user?id=999", null, true],
    ["tg://resolve?domain=x#500", null, true],
    ["tg://resolve?user_id=500", null, true],
    ["https://web.telegram.org/k/#500", null, true],
    ["https://web.telegram.org/k#500", null, true],
    ["https://web.telegram.org./k/#500", null, true],
    ["https://web.telegram.org/a/#500", null, true],
    ["https://web.telegram.org/z/#500?x", null, true],
    ["https://web.telegram.org/k/#500/", null, true],
    ["https://web.telegram.org/k/#500suffix", null, true],
    ["https://web.telegram.org/k/#0500", null, true],
    ["https://web.telegram.org/k/#000500?x=1", null, true],
    ["https://web.telegram.org/k/#5e2", null, true],
    ["https://web.telegram.org/k/#.5e3", null, true],
    ["https://web.telegram.org/k/#0x1f4", null, true],
    ["https://web.telegram.org/k/#0o764", null, true],
    ["https://web.telegram.org/k/#0b111110100", null, true],
    ["https://web.telegram.org/k/#%30%35%30%30", null, true],
    ["https://web.telegram.org/k/#/im?p=0500", null, true],
    ["https://web.telegram.org/k/#/im?p=5e2", null, true],
    ["https://web.telegram.org/k/#/im?p=0b111110100", null, true],
    ["https://web.telegram.org/k/?account=2#500", null, true],
    ["https://web.telegram.org/k/#self", null, false],
    ["https://web.telegram.org/k/#SELF", null, false],
    ["https://web.telegram.org/k/#/%73elf/", null, false],
    ["https://web.telegram.org/k/#%2573elf", null, false],
    ["https://web.telegram.org/k/#se\u200Blf", null, false],
    ["https://web.telegram.org/k/#se\u2060lf", null, false],
    ["https://example.test/safe\u206Apath", null, false],
    ["https://web.telegram.org/k/#se%E2%80%8Blf", null, false],
    ["https://web.telegram.org/k/#se%25E2%2580%258Blf", null, false],
    ["https://example.test/a%E2%81%AAb", null, false],
    ["tg://msg_url?url=https%3A%2F%2Fweb.telegram.org%2Fk%2F%23se%25E2%2580%258Blf", null, false],
    ["tg://msg_url?url=https%3A%2F%2Fweb.telegram.org%2Fk%2F%23self", null, false],
    ["tg://msg_url?url=https%3A%2F%2Fweb.telegram.org%2Fk%2F%23500", null, true],
    [nestedTelegram, null, true],
    [multiplyEncodedTelegram, null, true],
    [nestedHttpFour, null, true],
    [nestedHttpFive, null, true],
    ...unsafeDisplayCodePoints.map((unsafe) => [
      `https://web.telegram.org/k/#se${unsafe}lf`,
      null,
      false,
    ]),
    ["tg://user?id=501", "tg://user?id=501", false],
    ["tg:%75ser?id=501", "tg:%75ser?id=501", false],
  ];
  const page = { evaluate: async (callback, argument) => callback(argument) };
  for (const [target, expectedTarget, containsEncodedSelf] of cases) {
    const [artifact] = await withBrowserGlobals({
      rootScope: { myId: 500, managers: {
        appMessagesManager: { getMessageByPeer: async () => ({
          _: "message",
          peerId: 123,
          mid: 1,
          message: "link",
          entities: [{ _: "messageEntityTextUrl", offset: 0, length: 4, url: target }],
        }) },
        appPeersManager: {},
      } },
    }, () => __testing.readExactMessageArtifacts(page, [{ messageId: "1" }], "123"));
    assert.equal(artifact.linkEntities[0].target, expectedTarget, target);
    const publicArtifact = __testing.publicMessage(artifact, { isSelf: false, peerId: "123" });
    if (containsEncodedSelf) {
      assert.equal(
        JSON.stringify(publicArtifact).includes("500"),
        false,
        `raw current-account id escaped through ${target}`,
      );
    }
  }
});

test("message and reply authors plus attachment names use the full display-label sanitizer", async () => {
  const page = { evaluate: async (callback, argument) => callback(argument) };
  for (const unsafe of unsafeDisplayCodePoints) {
    const modelFor = (messageId) => messageId === 2
      ? {
        _: "message",
        peerId: 123,
        mid: 2,
        fromId: 456,
        date: 1_800_000_000,
        message: "document",
        entities: [],
        reply_to_mid: 1,
        reply_to: { _: "messageReplyHeader", reply_to_msg_id: 1 },
        media: {
          _: "messageMediaDocument",
          document: {
            _: "document",
            file_name: `safe${unsafe}name.txt`,
            size: 4,
            mime_type: "text/plain",
            attributes: [{
              _: "documentAttributeFilename",
              file_name: `safe${unsafe}name.txt`,
            }],
          },
        },
      }
      : {
        _: "message",
        peerId: 123,
        mid: 1,
        fromId: 789,
        date: 1_799_999_900,
        message: "reply",
        entities: [],
      };
    const [artifact] = await withBrowserGlobals({
      rootScope: { myId: 999, managers: {
        appMessagesManager: {
          getMessageByPeer: async (_peerId, messageId) => modelFor(messageId),
        },
        appPeersManager: {
          getPeerTitle: (peerId) => ({
            456: `Ali${unsafe}ce`,
            789: `Bo${unsafe}b`,
          })[peerId] || null,
        },
      } },
      appImManager: { chat: {
        peerId: 123,
        type: "chat",
        isMonoforum: false,
        isOutMessage: () => false,
      } },
    }, () => __testing.readExactMessageArtifacts(page, [{ messageId: "2" }], "123"));
    assert.equal(artifact.author, "Ali ce");
    assert.equal(artifact.attachments[0].name, "safe name.txt");
    assert.equal(artifact.reply.author, "Bo b");
    assert.doesNotMatch(
      JSON.stringify(artifact),
      /[\u200B\u2060\u206A]/u,
    );
  }
});

test("dialog discovery excludes message results and non-dialog global-contact rows", async () => {
  const makeRow = ({ peerId, title, messageId = null, domUnread = true }) => {
    const attributes = new Map([
      ["data-peer-id", peerId],
      ...(messageId ? [["data-mid", messageId]] : []),
    ]);
    return {
      getAttribute: (name) => attributes.get(name) ?? null,
      setAttribute: (name, value) => attributes.set(name, value),
      getBoundingClientRect: () => ({ width: 200, height: 40 }),
      classList: { contains: (name) => name === "is-muted" },
      querySelector: (selector) => {
        if (selector === ".peer-title") return { textContent: title };
        if (selector === ".dialog-subtitle-badge-unread" && domUnread) return { textContent: "99" };
        if (selector === ".dialog-subtitle-badge-pinned") return {};
        return null;
      },
    };
  };
  const rows = [
    makeRow({ peerId: "111", title: "Real\u202E dialog\u2066\u0007 safe" }),
    makeRow({ peerId: "222", title: "Message result", messageId: "7" }),
    makeRow({ peerId: "333", title: "Global contact" }),
    makeRow({ peerId: "444", title: `${"a".repeat(511)}😀` }),
  ];
  await withBrowserGlobals({
    document: { querySelectorAll: () => rows },
    getComputedStyle: () => ({ display: "block", visibility: "visible" }),
    window: { getComputedStyle: () => ({ display: "block", visibility: "visible" }) },
    rootScope: { myId: 999, managers: {
      appPeersManager: {
        getPeerActiveUsernames: async (peerId) => peerId === 333 ? ["exactcontact"] : [],
      },
      appMessagesManager: {
        getDialogOnly: async (peerId) => [111, 444].includes(peerId)
          ? { peerId, unread_count: 0, pFlags: {} }
          : peerId === 222
            ? { peerId, unread_count: 50, pFlags: { pinned: true } }
            : null,
        isDialogUnread: () => false,
      },
      appNotificationsManager: { isPeerLocalMuted: () => false },
    } },
  }, async () => {
    const collected = await __testing.collectDialogRows(
      { evaluate: async (callback, argument) => callback(argument) },
      100,
    );
    assert.deepEqual(collected.map((row) => row.peerId), ["111", "444"]);
    assert.equal(collected[0].title, "Real dialog safe");
    assert.doesNotMatch(collected[0].title, /[\u0000-\u001f\u202a-\u202e\u2060-\u206f]/u);
    assert.equal(collected[1].title, "a".repeat(511));
    assert.doesNotMatch(collected[1].title, /[\uD800-\uDFFF]/u);
    assert.deepEqual(__testing.buildDialogsResult(collected, { query: "real", limit: 10 }).dialogs[0], {
      semanticId: null,
      peerId: "111",
      title: "Real dialog safe",
      isSelf: false,
      username: null,
      archived: false,
      unread: false,
      unreadCount: 0,
      muted: false,
      pinned: false,
    });
    assert.deepEqual(collected.map((row) => [row.unread, row.unreadCount, row.muted, row.pinned]), [
      [false, 0, false, false],
      [false, 0, false, false],
    ]);
  });
});

test("display-label bounds never emit lone UTF-16 surrogates at direct or public boundaries", () => {
  const crossingPair = `${"a".repeat(511)}😀`;
  assert.equal(__testing.sanitizeDisplayLabel(crossingPair, 512), "a".repeat(511));
  assert.equal(__testing.sanitizeDisplayLabel(`before\uD83Dmiddle\uDC00after`, 512), "beforemiddleafter");

  const publicResult = __testing.buildDialogsResult([{
    peerId: "123",
    title: crossingPair,
    username: null,
    isSelf: false,
    unread: false,
    unreadCount: 0,
    muted: false,
    pinned: false,
  }], { query: "", limit: 10 });
  assert.equal(publicResult.dialogs[0].title, "a".repeat(511));
  assert.doesNotMatch(JSON.stringify(publicResult), /\\ud[89ab][0-9a-f]{2}|\\ud[c-f][0-9a-f]{2}/iu);
});

test("dialogs reports the exact 100-row provider scan bound independently of result limit", () => {
  const rows = Array.from({ length: 100 }, (_, index) => ({
    peerId: String(index + 1),
    title: `match ${index + 1}`,
    username: null,
    isSelf: false,
    unread: false,
    unreadCount: 0,
    muted: false,
    pinned: false,
  }));
  const scanBound = __testing.buildDialogsResult(rows, { query: "match", limit: 100 });
  assert.equal(scanBound.dialogs.length, 100);
  assert.equal(scanBound.incomplete, true);
  assert.deepEqual(scanBound.incompleteReasons, [
    "runtime_local_dialog_index_only",
    "dialog_scan_limit",
  ]);

  const resultBound = __testing.buildDialogsResult(rows.slice(0, 3), { query: "match", limit: 2 });
  assert.equal(resultBound.dialogs.length, 2);
  assert.deepEqual(resultBound.incompleteReasons, [
    "result_limit",
    "runtime_local_dialog_index_only",
  ]);
});

test("dialog scan bound survives filtering of the 100th raw mixed-DOM batch", async () => {
  const rawRows = Array.from({ length: 100 }, (_, index) => {
    const attributes = new Map([
      ["data-peer-id", String(index + 1)],
      ...(index === 0 ? [["data-mid", "1"]] : []),
    ]);
    return {
      getAttribute: (name) => attributes.get(name) ?? null,
      setAttribute: (name, value) => attributes.set(name, value),
      getBoundingClientRect: () => ({ width: 200, height: 40 }),
      classList: { contains: () => false },
      querySelector: (selector) => selector === ".peer-title" ? { textContent: `match ${index + 1}` } : null,
    };
  });
  await withBrowserGlobals({
    document: { querySelectorAll: () => rawRows },
    getComputedStyle: () => ({ display: "block", visibility: "visible" }),
    window: { getComputedStyle: () => ({ display: "block", visibility: "visible" }) },
    rootScope: { myId: 500, managers: {
      appPeersManager: { getPeerActiveUsernames: async () => [] },
      appMessagesManager: {
        getDialogOnly: async (peerId) => ({ peerId, unread_count: 0, pFlags: {} }),
        isDialogUnread: () => false,
      },
      appNotificationsManager: { isPeerLocalMuted: () => false },
    } },
  }, async () => {
    const retained = await __testing.collectDialogRows(
      { evaluate: async (callback, argument) => callback(argument) },
      100,
    );
    assert.equal(retained.length, 99);
    assert.equal(retained.scanLimitHit, true);
    const result = __testing.buildDialogsResult(retained, { query: "match", limit: 100 });
    assert.equal(result.incomplete, true);
    assert.equal(result.incompleteReasons.includes("dialog_scan_limit"), true);
  });
});

test("in-chat search never claims first-page exhaustion without official pagination proof", () => {
  assert.deepEqual(__testing.inChatSearchIncompleteReasons(30, 100, false), ["search_pagination_unproven"]);
  assert.deepEqual(__testing.inChatSearchIncompleteReasons(3, 100, false), ["search_pagination_unproven"]);
  assert.deepEqual(__testing.inChatSearchIncompleteReasons(20, 20, false), ["result_limit"]);
  assert.deepEqual(__testing.inChatSearchIncompleteReasons(0, 100, true), []);
  assert.deepEqual(__testing.inChatSearchIncompleteReasons(0, 100, false), ["search_completion_unproven"]);
});

test("account-wide API guard is sticky, idempotent, and allows only exact-peer message search", async () => {
  const proofKey = "__trelioTelegramWebAccountWideSearchGuardsV1";
  let providerCalls = 0;
  const original = (...args) => {
    providerCalls += 1;
    return args;
  };
  const apiManager = {
    invokeApi: original,
    invokeApiSingle: original,
    invokeApiSingleProcess: original,
    invokeApiAfter: original,
  };
  const page = { evaluate: async (callback, argument) => callback(argument) };
  await withBrowserGlobals({ rootScope: { managers: { apiManager } }, [proofKey]: new Map() }, async () => {
    const token = await __testing.installAccountWideMessageSearchGuard(page);
    const wrapper = apiManager.invokeApi;
    assert.deepEqual(apiManager.invokeApi("messages.search", {
      peer: { _: "inputPeerUser", user_id: 123, access_hash: 456n },
      q: "bounded",
    }), ["messages.search", {
      peer: { _: "inputPeerUser", user_id: 123, access_hash: 456n },
      q: "bounded",
    }]);
    assert.deepEqual(apiManager.invokeApi("contacts.resolveUsername", { username: "exactuser" }), [
      "contacts.resolveUsername", { username: "exactuser" },
    ]);
    assert.equal(providerCalls, 2);

    const options = { accountWideMessageSearchGuardToken: token };
    assert.equal(await __testing.refreshAccountWideMessageSearchGuard(page, options), token);
    assert.equal(apiManager.invokeApi, wrapper);

    const forbidden = [
      ["messages.searchGlobal", { q: "never" }],
      ["contacts.search", { q: "never" }],
      ["channels.searchPosts", { hashtag: "never" }],
      ["messages.search", { q: "missing peer" }],
      ["messages.search", { peer: { _: "inputPeerEmpty" }, q: "empty peer" }],
    ];
    for (const [method, params] of forbidden) {
      assert.throws(() => apiManager.invokeApi(method, params), /FORBIDDEN_ACCOUNT_WIDE_SEARCH_BLOCKED/u);
    }
    assert.equal(providerCalls, 2, "forbidden methods must fail before the provider original");
    await expectCode(
      () => __testing.assertAccountWideMessageSearchGuardClean(page, token),
      "TELEGRAM_WEB_UNSUPPORTED_OPERATION",
    );
    await expectCode(
      () => __testing.refreshAccountWideMessageSearchGuard(page, options),
      "TELEGRAM_WEB_UNSUPPORTED_OPERATION",
    );
  });
});

test("account-wide API guard refuses displaced wrappers instead of healing them", async () => {
  const proofKey = "__trelioTelegramWebAccountWideSearchGuardsV1";
  const original = () => undefined;
  const apiManager = { invokeApi: original };
  const page = { evaluate: async (callback, argument) => callback(argument) };
  await withBrowserGlobals({ rootScope: { managers: { apiManager } }, [proofKey]: new Map() }, async () => {
    const token = await __testing.installAccountWideMessageSearchGuard(page);
    apiManager.invokeApi = original;
    await expectCode(
      () => __testing.refreshAccountWideMessageSearchGuard(page, {
        accountWideMessageSearchGuardToken: token,
      }),
      "TELEGRAM_WEB_UNSUPPORTED_OPERATION",
    );
  });
});

test("local dialog discovery is synchronous, force-local, folder-bounded, and zero-API", async () => {
  const calls = [];
  let originalApiCalls = 0;
  const apiManager = { invokeApi: () => { originalApiCalls += 1; } };
  const managerSurface = (getDialogs) => ({
    dialogsStorage: { getDialogs },
    apiManager,
    appPeersManager: {
      getPeer: (peerId) => peerId === 10
        ? { _: "user", first_name: "Alice\u202E \u2066\u0007Safe", last_name: "", pFlags: {} }
        : { _: "chat", title: `${"a".repeat(511)}😀`, pFlags: {} },
      getPeerActiveUsernames: (peerId) => peerId === 10 ? ["alice_user"] : [],
    },
    appMessagesManager: { isDialogUnread: () => false },
    appNotificationsManager: { isPeerLocalMuted: () => false },
  });
  const page = { evaluate: async (callback, argument) => callback(argument) };
  await withBrowserGlobals({
    rootScope: {
      myId: 999,
      managers: managerSurface((request) => {
        calls.push(request);
        return {
          dialogs: request.filterId === 0
            ? [{ peerId: 10, folder_id: 0, unread_count: 0, pFlags: {} }]
            : [{ peerId: -20, folder_id: 1, unread_count: 0, pFlags: { pinned: true } }],
          isEnd: true,
        };
      }),
    },
  }, async () => {
    const rows = await __testing.collectLocalDialogModels(page, "ali", 100);
    assert.deepEqual(rows.map(({ peerId, folderId }) => [peerId, folderId]), [["10", 0], ["-20", 1]]);
    assert.deepEqual(rows.map(({ title }) => title), ["Alice Safe", "a".repeat(511)]);
    assert.equal(JSON.stringify(rows).includes("\u202E"), false);
    assert.doesNotMatch(rows[1].title, /[\uD800-\uDFFF]/u);
    const discovery = __testing.buildDialogsResult(rows, { query: "alice", limit: 10 });
    assert.equal(discovery.dialogs[0].title, "Alice Safe");
    assert.equal(discovery.dialogs[0].peerId, "10");
    assert.deepEqual(calls, [
      { query: "ali", filterId: 0, limit: 101, forceLocal: true },
      { query: "ali", filterId: 1, limit: 101, forceLocal: true },
    ]);
  });
  assert.equal(originalApiCalls, 0);

  await withBrowserGlobals({
    rootScope: {
      myId: 999,
      managers: managerSurface(() => Promise.resolve({ dialogs: [], isEnd: true })),
    },
  }, () => expectCode(
    () => __testing.collectLocalDialogModels(page, "ali", 100),
    "TELEGRAM_WEB_UI_UNSUPPORTED",
  ));

  await withBrowserGlobals({
    rootScope: {
      myId: 999,
      managers: managerSurface(() => {
        apiManager.invokeApi("messages.getDialogs", {});
        return { dialogs: [], isEnd: true };
      }),
    },
  }, () => expectCode(
    () => __testing.collectLocalDialogModels(page, "ali", 100),
    "TELEGRAM_WEB_UI_UNSUPPORTED",
  ));
  assert.equal(originalApiCalls, 0, "temporary local guard must throw before the original API method");
});

test("search reset belongs only to the exact chat whose initSearch transition succeeded", async () => {
  const options = { timeoutMs: 1000, limit: 20 };
  const resetPeers = [];
  const resolveFailure = new TelegramWebRuntimeError("TELEGRAM_WEB_CHAT_NOT_FOUND", "missing");
  await assert.rejects(
    () => __testing.runOneExactChatSearch({}, options, "123", "needle", {
      resolveDialog: async () => { throw resolveFailure; },
      resetInChatSearch: async (page, peerId) => { void page; resetPeers.push(peerId); },
    }),
    (error) => error === resolveFailure,
  );
  assert.deepEqual(resetPeers, []);

  const renderFailure = new TelegramWebRuntimeError("TELEGRAM_WEB_SEARCH_INCOMPLETE", "render failed");
  await assert.rejects(
    () => __testing.runOneExactChatSearch({}, options, "456", "needle", {
      resolveDialog: async () => ({ peerId: "456" }),
      openInChatSearch: async (_page, _peerId, _timeout, { onSearchStateCreated }) => {
        onSearchStateCreated();
        throw renderFailure;
      },
      resetInChatSearch: async (_page, peerId) => { resetPeers.push(peerId); },
    }),
    (error) => error === renderFailure,
  );
  assert.deepEqual(resetPeers, ["456"]);

  await assert.rejects(
    () => __testing.runOneExactChatSearch({}, options, "789", "needle", {
      resolveDialog: async () => { throw resolveFailure; },
      resetInChatSearch: async (_page, peerId) => { resetPeers.push(peerId); },
    }),
    (error) => error === resolveFailure,
  );
  assert.deepEqual(resetPeers, ["456"], "a later resolve failure must not reset the prior/default chat");
});

test("multi-chat search rejects canonical aliases and prunes only affected chat metadata", async () => {
  const options = parseArguments([
    "search", "--chat", "123", "--chat", "https://web.telegram.org/k/#123", "--query", "x", "--limit", "20",
  ]);
  options.account = 1;
  await withBrowserGlobals({ rootScope: { myId: 999 } }, () => expectCode(
    () => __testing.runSearchCommand({ evaluate: async (callback) => callback() }, options),
    "TELEGRAM_WEB_INVALID_ARGUMENT",
  ));
  assert.throws(
    () => parseArguments([
      "search",
      ...Array.from({ length: 6 }, (_, index) => ["--chat", String(index + 1)]).flat(),
      "--query", "x", "--limit", "20",
    ]),
    (error) => error.code === "TELEGRAM_WEB_INVALID_ARGUMENT",
  );

  const bigResults = (prefix) => Array.from({ length: 40 }, (_, index) => ({
    messageId: String(index + 1), peerId: prefix, text: "x".repeat(8_000),
  }));
  const bounded = __testing.boundMultiChatSearchResult({
    ok: true,
    command: "search",
    accountSlot: 4,
    searches: [
      { chat: { peerId: "1" }, results: bigResults("1"), returnedResults: 40, complete: false, truncated: true, incomplete: true, incompleteReasons: ["search_pagination_unproven"] },
      { chat: { peerId: "2" }, results: bigResults("2"), returnedResults: 40, complete: false, truncated: true, incomplete: true, incompleteReasons: ["search_pagination_unproven"] },
    ],
  });
  assert.ok(Buffer.byteLength(JSON.stringify(bounded), "utf8") <= 512 * 1024);
  assert.equal(bounded.searches[0].results.length, 40);
  assert.ok(bounded.searches[1].results.length < 40);
  assert.equal(bounded.searches[0].incompleteReasons.includes("json_byte_limit"), false);
  assert.equal(bounded.searches[1].incompleteReasons.includes("json_byte_limit"), true);
  assert.equal(bounded.incompleteReasons.includes("json_byte_limit"), true);
  const publicSearch = __testing.withPublicAccountSlot(bounded, 4);
  assert.equal(publicSearch.accountSlot, 4);
  assert.ok(Buffer.byteLength(JSON.stringify(publicSearch), "utf8") <= 512 * 1024);

  const boundedRead = __testing.boundStructuredResult({
    ok: true,
    command: "read",
    accountSlot: 4,
    messages: Array.from({ length: 100 }, (_, index) => ({
      messageId: String(index + 1),
      peerId: "1",
      text: "x".repeat(8_000),
    })),
    incomplete: false,
    incompleteReasons: [],
  });
  const publicRead = __testing.withPublicAccountSlot(boundedRead, 4);
  assert.equal(publicRead.accountSlot, 4);
  assert.equal(publicRead.incompleteReasons.includes("json_byte_limit"), true);
  assert.ok(Buffer.byteLength(JSON.stringify(publicRead), "utf8") <= 512 * 1024);
});

test("provider message and reply IDs must be canonical positive safe integers", async () => {
  const makeBubble = ({ messageId, replyTo = null }) => ({
    getAttribute: (name) => ({
      "data-mid": messageId,
      "data-peer-id": "123",
      "data-timestamp": "1",
      "data-reply-to-mid": replyTo,
    })[name] ?? null,
    querySelector: () => null,
    querySelectorAll: () => [],
    classList: { contains: () => false },
  });
  const run = (
    bubble,
    model = { _: "message", peerId: 123, mid: 1, message: "x" },
    peersManager = {},
  ) => withBrowserGlobals({
    document: { querySelectorAll: () => [bubble] },
    rootScope: { managers: {
      appMessagesManager: { getMessageByPeer: async () => model },
      appPeersManager: peersManager,
    } },
  }, () => __testing.collectMessages({ evaluate: async (callback, argument) => callback(argument) }, 10));

  await expectCode(() => run(makeBubble({ messageId: "0001" })), "TELEGRAM_WEB_UI_UNSUPPORTED");
  await expectCode(() => run(makeBubble({ messageId: "9007199254740992" })), "TELEGRAM_WEB_UI_UNSUPPORTED");
  await expectCode(() => run(makeBubble({ messageId: "1", replyTo: "0001" })), "TELEGRAM_WEB_UI_UNSUPPORTED");
  await expectCode(() => run(makeBubble({ messageId: "1", replyTo: "2" }), {
    _: "message",
    peerId: 123,
    mid: 1,
    message: "x",
    reply_to_mid: "02",
    reply_to: { _: "messageReplyHeader", reply_to_msg_id: "02" },
  }), "TELEGRAM_WEB_UI_UNSUPPORTED");
  await expectCode(() => run(makeBubble({ messageId: "1", replyTo: "2" }), {
    _: "message",
    peerId: 123,
    mid: 1,
    message: "x",
    reply_to_mid: 2,
    reply_to: { _: "messageReplyHeader", reply_to_msg_id: 2, reply_to_peer_id: { _: "peerUser", user_id: 123 } },
  }, { getPeerId: () => "123" }), "TELEGRAM_WEB_UI_UNSUPPORTED");
  await expectCode(() => run(makeBubble({ messageId: "1", replyTo: "2" }), {
    _: "message",
    peerId: 123,
    mid: 1,
    message: "x",
    reply_to_mid: "2",
    reply_to: { _: "messageReplyHeader", reply_to_msg_id: "2" },
  }), "TELEGRAM_WEB_UI_UNSUPPORTED");
});

test("collected messages never restore an all-control raw DOM author after model sanitization", async () => {
  const authorNode = { textContent: "\u200B\u2060" };
  const bubble = {
    getAttribute: (name) => ({
      "data-mid": "1",
      "data-peer-id": "123",
      "data-timestamp": "1800000000",
      "data-reply-to-mid": null,
    })[name] ?? null,
    querySelector: (selector) => selector.includes("peer-title") ? authorNode : null,
    querySelectorAll: () => [],
    classList: { contains: () => false },
  };
  const page = { evaluate: async (callback, argument) => callback(argument) };
  const messages = await withBrowserGlobals({
    document: { querySelectorAll: () => [bubble] },
    rootScope: { myId: 999, managers: {
      appMessagesManager: { getMessageByPeer: async () => ({
        _: "message",
        peerId: 123,
        mid: 1,
        date: 1_800_000_000,
        message: "x",
        entities: [],
      }) },
      appPeersManager: {},
    } },
    appImManager: { chat: {
      peerId: 123,
      type: "chat",
      isMonoforum: false,
      isOutMessage: () => false,
    } },
  }, () => __testing.collectMessages(page, 10));
  assert.equal(messages.length, 1);
  assert.equal(messages[0].author, null);
  assert.doesNotMatch(JSON.stringify(messages[0]), /[\u200B\u2060]/u);
});

test("collected message direction is bound to chat.isOutMessage and must match the DOM class", async () => {
  const bubble = {
    getAttribute: (name) => ({
      "data-mid": "1",
      "data-peer-id": "123",
      "data-timestamp": "1",
      "data-reply-to-mid": null,
    })[name] ?? null,
    querySelector: () => null,
    querySelectorAll: () => [],
    classList: { contains: (name) => name === "is-out" },
  };
  await withBrowserGlobals({
    document: { querySelectorAll: () => [bubble] },
    appImManager: { chat: {
      peerId: 123,
      type: "chat",
      isMonoforum: false,
      isOutMessage: () => false,
    } },
    rootScope: { managers: {
      appMessagesManager: { getMessageByPeer: async () => ({
        _: "message", peerId: 123, mid: 1, message: "incoming",
      }) },
      appPeersManager: {},
    } },
  }, async () => {
    await expectCode(
      () => __testing.collectMessages({ evaluate: async (callback, argument) => callback(argument) }, 10),
      "TELEGRAM_WEB_UI_UNSUPPORTED",
    );
  });
});

test("read artifacts expose bounded author/date/link/reply context without provider secrets", async () => {
  const link = "https://example.com";
  const bubble = {
    getAttribute: (name) => ({
      "data-mid": "7",
      "data-peer-id": "123",
      "data-timestamp": "1800000000",
      "data-reply-to-mid": "6",
    })[name] ?? null,
    querySelector: (selector) => {
      if (selector.includes(".colored-name")) return { textContent: "Alice" };
      if (selector === ".reply, .reply-summary") return { innerText: "one-level source" };
      return null;
    },
    querySelectorAll: () => [],
    classList: { contains: () => false },
  };
  const modelFor = (messageId) => messageId === 7
    ? {
      _: "message",
      peerId: 123,
      mid: 7,
      fromId: 456,
      date: 1_800_000_000,
      message: `visit ${link}`,
      entities: [{ _: "messageEntityUrl", offset: 6, length: link.length }],
      reply_to_mid: 6,
      reply_to: { _: "messageReplyHeader", reply_to_msg_id: 6 },
      media: {
        _: "messageMediaDocument",
        document: {
          _: "document",
          id: "never-public-document-id",
          access_hash: "never-public-document-hash",
          file_reference: [7, 8, 9],
          file_name: "read-contract.txt",
          size: 42,
          mime_type: "text/plain",
          attributes: [{ _: "documentAttributeFilename", file_name: "read-contract.txt" }],
        },
      },
      access_hash: "never-public",
    }
    : {
      _: "message",
      peerId: 123,
      mid: 6,
      fromId: 789,
      date: 1_799_999_900,
      message: "one-level source",
      entities: [],
      reply_to_mid: 5,
      reply_to: { _: "messageReplyHeader", reply_to_msg_id: 5 },
      access_hash: "never-public",
    };
  const page = { evaluate: async (callback, argument) => callback(argument) };
  const messages = await withBrowserGlobals({
    document: { querySelectorAll: () => [bubble] },
    rootScope: { myId: 999, managers: {
      appMessagesManager: { getMessageByPeer: async (_peerId, messageId) => modelFor(messageId) },
      appPeersManager: { getPeerTitle: (peerId) => ({ 456: "Alice", 789: "Bob" })[peerId] || null },
    } },
    appImManager: { chat: {
      peerId: 123,
      type: "chat",
      isMonoforum: false,
      isOutMessage: () => false,
    } },
  }, () => __testing.collectMessages(page, 10));
  assert.equal(messages.length, 1);
  assert.deepEqual(messages[0], {
    messageId: "7",
    peerId: "123",
    author: "Alice",
    timestamp: new Date(1_800_000_000 * 1_000).toISOString(),
    direction: "incoming",
    text: `visit ${link}`,
    reply: {
      messageId: "6",
      contextAvailable: true,
      simple: true,
      author: "Bob",
      authorPeerId: "789",
      authorSemanticId: null,
      timestamp: new Date(1_799_999_900 * 1_000).toISOString(),
      text: "one-level source",
      linkEntities: [],
      linkEntitiesTruncated: false,
    },
    attachments: [{
      index: 1,
      kind: "document",
      name: "read-contract.txt",
      sizeBytes: 42,
      mimeType: "text/plain",
    }],
    authorPeerId: "456",
    authorSemanticId: null,
    linkEntities: [{
      type: "url",
      offsetUtf16: 6,
      lengthUtf16: link.length,
      text: link,
      target: link,
    }],
    linkEntitiesTruncated: false,
  });
  assert.equal(JSON.stringify(messages).includes("access_hash"), false);
  assert.equal(JSON.stringify(messages).includes("never-public"), false);
  assert.equal(JSON.stringify(messages).includes("file_reference"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(messages[0].reply, "reply"), false);

  const saved = __testing.publicMessage(messages[0], {
    isSelf: true,
    peerId: "999",
    title: "Saved Messages",
  });
  assert.equal(saved.peerId, null);
  assert.equal(saved.chatSemanticId, "saved-messages");
  assert.equal(saved.authorPeerId, null);
  assert.equal(saved.authorSemanticId, "self");
  assert.equal(saved.reply.authorPeerId, null);
  assert.equal(saved.reply.authorSemanticId, "self");
  assert.equal(JSON.stringify(saved).includes("999"), false);

  const unavailableSavedReply = __testing.publicMessage({
    ...messages[0],
    reply: {
      messageId: "5",
      contextAvailable: false,
      simple: null,
      author: null,
      authorPeerId: null,
      authorSemanticId: null,
      timestamp: null,
      text: null,
      linkEntities: [],
      linkEntitiesTruncated: false,
    },
  }, {
    isSelf: true,
    peerId: "999",
    title: "Saved Messages",
  });
  assert.equal(unavailableSavedReply.reply.authorPeerId, null);
  assert.equal(unavailableSavedReply.reply.authorSemanticId, null);
  assert.equal(unavailableSavedReply.reply.contextAvailable, false);
});

test("read keeps a missing model timestamp null instead of leaking a localized DOM label", async () => {
  const bubble = {
    getAttribute: (name) => ({
      "data-mid": "1",
      "data-peer-id": "123",
      "data-timestamp": null,
      "data-reply-to-mid": null,
    })[name] ?? null,
    querySelector: (selector) => selector === ".time, .time-inner, time"
      ? { getAttribute: () => null, textContent: "10:45" }
      : null,
    querySelectorAll: () => [],
    classList: { contains: () => false },
  };
  const [message] = await withBrowserGlobals({
    document: { querySelectorAll: () => [bubble] },
    rootScope: { myId: 999, managers: {
      appMessagesManager: { getMessageByPeer: async () => ({
        _: "message",
        peerId: 123,
        mid: 1,
        message: "no model date",
        entities: [],
      }) },
      appPeersManager: {},
    } },
    appImManager: { chat: {
      peerId: 123,
      type: "chat",
      isMonoforum: false,
      isOutMessage: () => false,
    } },
  }, () => __testing.collectMessages({
    evaluate: async (callback, argument) => callback(argument),
  }, 10));
  assert.equal(message.timestamp, null);
  assert.equal(JSON.stringify(message).includes("10:45"), false);
});

test("zero-click composer cleanup removes only the exact runtime draft/reply and preserves unknown state", async () => {
  class FakeElement {
    constructor(text = "") { this.textContent = text; }
    getBoundingClientRect() { return { width: 120, height: 30 }; }
  }
  const userId = "987654321";
  const digest = accountDigestFromTelegramUserId(userId);
  const environment = environmentFor("/private/tmp/telegram-web-composer-fixture");
  const identity = identityFor(environment);
  const options = attachApprovalContext(parseArguments(["send", "--chat", "123", "--message", "hello"]), identity, environment);
  options.currentAccountDigest = digest;

  const runCase = async ({ initialValue, replyTo = null, editMessageId = null, allowedPayloads, expectedCode = null }) => {
    let value = initialValue;
    let reply = replyTo ? { replyToMsgId: replyTo, replyToPeerId: 123 } : null;
    let clearInputCalls = 0;
    let clearHelperCalls = 0;
    const composer = new FakeElement(initialValue);
    const parserSurface = makePinnedEntityParserSurface(
      (selector) => selector.includes('input-message-input[contenteditable="true"]') ? [composer] : [],
    );
    const input = {
      messageInput: composer,
      webPageOptions: {},
      editMsgId: editMessageId,
      getReplyTo: async () => reply,
      isInputEmpty: () => value === "",
      getValueAndEntities: (element) => element === composer
        ? { value, totalEntities: pinnedAutomaticEntitiesFixture(value) }
        : {
          value: String(element.textContent || ""),
          totalEntities: pinnedAutomaticEntitiesFixture(String(element.textContent || "")),
        },
      clearInput: async () => {
        clearInputCalls += 1;
        value = "";
        composer.textContent = "";
      },
      clearHelper: async () => {
        clearHelperCalls += 1;
        reply = null;
        input.editMsgId = null;
        input.editMessage = null;
      },
    };
    const globals = {
      Element: FakeElement,
      document: parserSurface.document,
      getComputedStyle: () => ({ display: "block", visibility: "visible" }),
      location: { href: "https://web.telegram.org/k/" },
      AccountController: { get: async () => ({ userId: Number(userId) }) },
      appStorage: { get: async () => ({ id: Number(userId) }) },
      appImManager: { chat: { peerId: 123, type: "chat", isMonoforum: false, isAnonymousSending: false, savedReaction: [], input } },
      rootScope: { myId: Number(userId), managers: { appMessagesManager: { isAnonymousSending: async () => false } } },
    };
    await withBrowserGlobals(globals, async () => {
      const action = () => __testing.clearExactRuntimeComposer(makeModelPage({ peerId: "123" }), "123", options, {
        replyToMessageId: replyTo,
        editMessageId,
        allowedPayloads,
        originalError: new TelegramWebRuntimeError("TEST_FAILURE", "test"),
      });
      if (expectedCode) await expectCode(action, expectedCode);
      else await action();
    });
    return { value, reply, clearInputCalls, clearHelperCalls };
  };

  assert.deepEqual(await runCase({ initialValue: "hello", allowedPayloads: ["hello", ""] }), {
    value: "", reply: null, clearInputCalls: 1, clearHelperCalls: 0,
  });
  assert.deepEqual(await runCase({ initialValue: "hello", replyTo: "7", allowedPayloads: ["hello", ""] }), {
    value: "", reply: null, clearInputCalls: 1, clearHelperCalls: 1,
  });
  assert.deepEqual(await runCase({ initialValue: "hello", editMessageId: "7", allowedPayloads: ["hello", ""] }), {
    value: "", reply: null, clearInputCalls: 1, clearHelperCalls: 1,
  });
  assert.deepEqual(await runCase({ initialValue: "", allowedPayloads: [""] }), {
    value: "", reply: null, clearInputCalls: 0, clearHelperCalls: 0,
  });
  assert.deepEqual(await runCase({
    initialValue: "user draft",
    allowedPayloads: ["hello", ""],
    expectedCode: "TELEGRAM_WEB_COMPOSER_REPAIR_REQUIRED",
  }), {
    value: "user draft", reply: null, clearInputCalls: 0, clearHelperCalls: 0,
  });
});

test("approval is account/connection bound, one-use, concurrent-safe and ABA fail-closed", async () => {
  const temporaryDirectory = await realpath(await mkdtemp(path.join(os.homedir(), ".telegram-web-approval-")));
  try {
    const environment = environmentFor(temporaryDirectory);
    const identity = identityFor(environment);
    const prepared = { message: { message: "hello", approval: { text: "hello", chars: 5, sha256: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824" } }, files: [] };
    const resolved = { chat: { isSelf: false, peerId: "123", title: "Test" } };
    const dry = attachApprovalContext(parseArguments(["send", "--chat", "Test", "--message", "hello", "--dry-run"]), identity, environment);
    const preview = await __testing.assertStructuralApproval(dry, resolved, prepared);
    assert.match(preview.approvalHash, /^[0-9a-f]{64}$/u);
    assert.equal(preview.accountSlot, 1);
    assert.equal(preview.operation.accountSlot, 1);
    assert.equal(JSON.stringify(preview).includes(accountDigest), false);

    const wrongSlot = attachApprovalContext(parseArguments([
      "send", "--account", "2", "--chat", "Test", "--message", "hello",
      "--confirm", "--approval-hash", preview.approvalHash,
    ]), identity, environment);
    await expectCode(
      () => __testing.assertStructuralApproval(wrongSlot, resolved, prepared),
      "TELEGRAM_WEB_APPROVAL_MISMATCH",
    );

    const confirmed = attachApprovalContext(parseArguments(["send", "--chat", "Test", "--message", "hello", "--confirm", "--approval-hash", preview.approvalHash]), identity, environment);
    await __testing.assertStructuralApproval(confirmed, resolved, prepared);
    await expectCode(
      () => __testing.validatePendingApproval(
        confirmed,
        confirmed.pendingApprovalOperation,
        new Date(Date.parse(preview.expiresAt) + 1),
      ),
      "TELEGRAM_WEB_APPROVAL_EXPIRED",
    );
    await __testing.consumeStructuralApproval(confirmed);
    await expectCode(() => __testing.validatePendingApproval(confirmed, confirmed.pendingApprovalOperation || {}), "TELEGRAM_WEB_APPROVAL_REQUIRED");

    // The history bound is an observable part of source discovery and can
    // cause additional ordinary Telegram read-state effects. A confirmation
    // cannot silently expand it after the dry-run even when the same source
    // message remains visible and every other field is unchanged.
    const sourceMessage = {
      messageId: "7",
      peerId: "123",
      author: "Me",
      timestamp: "2026-01-01T00:00:00.000Z",
      direction: "outgoing",
      text: "source",
      reply: null,
      attachments: [],
    };
    const pageBoundResolved = { ...resolved, sourceMessage };
    const pageBoundDry = attachApprovalContext(parseArguments([
      "reply", "--chat", "123", "--message-id", "7", "--message", "hello",
      "--pages", "1", "--dry-run",
    ]), identity, environment);
    const pageBoundPreview = await __testing.assertStructuralApproval(pageBoundDry, pageBoundResolved, prepared);
    assert.equal(pageBoundPreview.operation.historyPages, 1);
    const expandedConfirm = attachApprovalContext(parseArguments([
      "reply", "--chat", "123", "--message-id", "7", "--message", "hello",
      "--pages", "10", "--confirm", "--approval-hash", pageBoundPreview.approvalHash,
    ]), identity, environment);
    await expectCode(
      () => __testing.assertStructuralApproval(expandedConfirm, pageBoundResolved, prepared),
      "TELEGRAM_WEB_APPROVAL_MISMATCH",
    );

    const secondPreview = await __testing.assertStructuralApproval(dry, resolved, prepared);
    const firstConcurrent = attachApprovalContext(parseArguments(["send", "--chat", "Test", "--message", "hello", "--confirm", "--approval-hash", secondPreview.approvalHash]), identity, environment);
    const secondConcurrent = attachApprovalContext(parseArguments(["send", "--chat", "Test", "--message", "hello", "--confirm", "--approval-hash", secondPreview.approvalHash]), identity, environment);
    await __testing.assertStructuralApproval(firstConcurrent, resolved, prepared);
    await __testing.assertStructuralApproval(secondConcurrent, resolved, prepared);
    const outcomes = await Promise.allSettled([
      __testing.consumeStructuralApproval(firstConcurrent),
      __testing.consumeStructuralApproval(secondConcurrent),
    ]);
    assert.equal(outcomes.filter((outcome) => outcome.status === "fulfilled").length, 1);
    assert.equal(outcomes.filter((outcome) => outcome.status === "rejected").length, 1);

    const oldPreview = await __testing.assertStructuralApproval(dry, resolved, prepared);
    const oldConfirmed = attachApprovalContext(parseArguments(["send", "--chat", "Test", "--message", "hello", "--confirm", "--approval-hash", oldPreview.approvalHash]), identity, environment);
    await __testing.assertStructuralApproval(oldConfirmed, resolved, prepared);
    const oldOperation = oldConfirmed.pendingApprovalOperation;
    const replacementDry = attachApprovalContext(parseArguments(["send", "--chat", "Test", "--message", "replacement", "--dry-run"]), identity, environment);
    const replacementPrepared = { message: { message: "replacement", approval: { text: "replacement", chars: 11, sha256: "replacement-digest" } }, files: [] };
    await expectCode(() => __testing.consumePendingApproval(oldConfirmed, oldOperation, {
      beforeAtomicRename: () => __testing.assertStructuralApproval(replacementDry, resolved, replacementPrepared),
    }), "TELEGRAM_WEB_APPROVAL_ALREADY_USED");
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test("changed approved chat or history bound fails before any browser invocation", async () => {
  const temporaryDirectory = await realpath(await mkdtemp(path.join(os.homedir(), ".telegram-web-approval-envelope-")));
  try {
    const environment = environmentFor(temporaryDirectory);
    const identity = identityFor(environment);
    await installValidConsent(identity, environment, accountDigest);
    const prepared = {
      message: {
        message: "hello",
        approval: {
          text: "hello",
          chars: 5,
          sha256: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
        },
      },
      files: [],
    };
    const sourceMessage = {
      messageId: "7",
      peerId: "123",
      author: "Me",
      timestamp: "2026-01-01T00:00:00.000Z",
      direction: "outgoing",
      text: "source",
      reply: null,
      attachments: [],
    };
    const resolved = {
      chat: { isSelf: false, peerId: "123", title: "Exact" },
      sourceMessage,
    };
    const dry = attachApprovalContext(parseArguments([
      "reply", "--account", "1", "--chat", "123", "--message-id", "7",
      "--message", "hello", "--pages", "1", "--dry-run",
    ]), identity, environment);
    const preview = await __testing.assertStructuralApproval(dry, resolved, prepared);

    for (const changed of [
      ["--chat", "123", "--pages", "10"],
      ["--chat", "456", "--pages", "1"],
    ]) {
      let browserInvocations = 0;
      await expectCode(() => runCli([
        "reply", "--account", "1", ...changed, "--message-id", "7",
        "--message", "hello", "--confirm", "--approval-hash", preview.approvalHash,
      ], environment, {
        withTelegramBrowser: async () => {
          browserInvocations += 1;
          throw new Error("approval mismatch must stop before browser launch");
        },
      }), "TELEGRAM_WEB_APPROVAL_MISMATCH");
      assert.equal(browserInvocations, 0);
    }

    // A dry-run material cannot combine one resolved operation with a later
    // independently re-read payload. The request digest and operation must be
    // derived from the same immutable prepared snapshot.
    const changedPrepared = {
      message: {
        message: "changed",
        approval: { text: "changed", chars: 7, sha256: "b".repeat(64) },
      },
      files: [],
    };
    await expectCode(
      () => __testing.createApprovalMaterial(dry, resolved, changedPrepared),
      "TELEGRAM_WEB_SOURCE_CHANGED",
    );
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test("changed logout slot or owner handoff bound fails before headed browser invocation", async () => {
  const temporaryDirectory = await realpath(await mkdtemp(path.join(os.homedir(), ".telegram-web-logout-envelope-")));
  try {
    const environment = environmentFor(temporaryDirectory);
    const identity = identityFor(environment);
    const parsedDry = attachApprovalContext(parseArguments([
      "logout", "--account", "1", "--hold-ms", "60000", "--dry-run",
    ]), identity, environment);
    // runLogoutCommand creates this exact effective headed clone for a real
    // dry-run, while the subsequent raw confirm parses headed=false by default.
    // Request canonicalization must make those semantically identical.
    const dry = { ...parsedDry, headed: true };
    const preview = await __testing.assertStructuralApproval(dry, {});
    let unchangedBrowserInvocations = 0;
    await assert.rejects(() => runCli([
      "logout", "--account", "1", "--hold-ms", "60000",
      "--confirm", "--approval-hash", preview.approvalHash,
    ], environment, {
      withTelegramBrowser: async () => {
        unchangedBrowserInvocations += 1;
        throw new Error("unchanged logout reached headed browser");
      },
    }), /unchanged logout reached headed browser/u);
    assert.equal(unchangedBrowserInvocations, 1);
    for (const changed of [
      ["--account", "2", "--hold-ms", "60000"],
      ["--account", "1", "--hold-ms", "70000"],
    ]) {
      let browserInvocations = 0;
      await expectCode(() => runCli([
        "logout", ...changed, "--confirm", "--approval-hash", preview.approvalHash,
      ], environment, {
        withTelegramBrowser: async () => {
          browserInvocations += 1;
          throw new Error("logout mismatch must stop before headed browser launch");
        },
      }), "TELEGRAM_WEB_APPROVAL_MISMATCH");
      assert.equal(browserInvocations, 0);
    }
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test("consent record has exactly five account-bound fields and revoke tombstone wins", async () => {
  const temporaryDirectory = await realpath(await mkdtemp(path.join(os.homedir(), ".telegram-web-consent-")));
  try {
    const environment = environmentFor(temporaryDirectory);
    const identity = identityFor(environment);
    const locations = runtimeLocations(identity, environment);
    await __testing.ensurePrivateTree(environment.TRELIO_CONFIG_HOME, path.dirname(locations.consentFile), environment);
    const acceptedAt = new Date();
    const record = {
      termsVersion: CONSENT_TERMS_VERSION,
      statementDigest: CONSENT_STATEMENT_DIGEST,
      accountDigest,
      acceptedAt: acceptedAt.toISOString(),
      expiresAt: new Date(acceptedAt.getTime() + CONSENT_VALID_DAYS * 86_400_000).toISOString(),
    };
    await writeFile(locations.consentFile, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    if (process.platform !== "win32") await chmod(locations.consentFile, 0o600);
    const status = await renderConsentStatus(identity, accountDigest, new Date(), environment);
    assert.equal(status.valid, true);
    assert.deepEqual(Object.keys(JSON.parse(await readFile(locations.consentFile, "utf8"))).sort(), [
      "acceptedAt", "accountDigest", "expiresAt", "statementDigest", "termsVersion",
    ]);
    assert.equal(JSON.stringify(status).includes(accountDigest), false);

    await __testing.revokeConsent(identity, environment);
    const revoked = await renderConsentStatus(identity, accountDigest, new Date(), environment);
    assert.equal(revoked.valid, false);
    assert.equal(revoked.reason, "revoked");
    assert.equal(await lstat(locations.consentFile).catch(() => null), null);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test("missing, revoked, expired and old-terms consent stop before any browser runner", async () => {
  const temporaryDirectory = await realpath(await mkdtemp(path.join(os.homedir(), ".telegram-web-consent-preflight-")));
  try {
    for (const fixture of ["missing", "revoked", "expired", "old-terms"]) {
      const environment = environmentFor(path.join(temporaryDirectory, fixture));
      const identity = identityFor(environment);
      if (fixture !== "missing") {
        const record = await installValidConsent(identity, environment, accountDigest);
        if (fixture === "revoked") {
          await __testing.revokeConsent(identity, environment);
        } else {
          const locations = runtimeLocations(identity, environment);
          const changed = { ...record };
          if (fixture === "expired") {
            const acceptedAt = new Date(Date.now() - (CONSENT_VALID_DAYS + 1) * 86_400_000);
            changed.acceptedAt = acceptedAt.toISOString();
            changed.expiresAt = new Date(acceptedAt.getTime() + CONSENT_VALID_DAYS * 86_400_000).toISOString();
          } else {
            changed.termsVersion = "telegram-ai-processing/obsolete";
          }
          await writeFile(locations.consentFile, `${JSON.stringify(changed)}\n`, { mode: 0o600 });
          if (process.platform !== "win32") await chmod(locations.consentFile, 0o600);
        }
      }
      let launches = 0;
      await expectCode(() => runCli(["dialogs"], environment, {
        withTelegramBrowser: async () => {
          launches += 1;
          throw new Error("browser runner must not be reached");
        },
      }), "TELEGRAM_WEB_CONSENT_REQUIRED");
      assert.equal(launches, 0, fixture);
      assert.equal(await lstat(runtimeLocations(identity, environment).profileDirectory).catch(() => null), null);
    }
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test("title-addressed content fails before consent and browser launch", async () => {
  const temporaryDirectory = await realpath(await mkdtemp(path.join(os.homedir(), ".telegram-web-title-preflight-")));
  try {
    const environment = environmentFor(temporaryDirectory);
    const identity = identityFor(environment);
    await installValidConsent(identity, environment, accountDigest);
    let launches = 0;
    await expectCode(() => runCli(["read", "--chat", "Visible duplicate title"], environment, {
      withTelegramBrowser: async () => {
        launches += 1;
        throw new Error("browser runner must not be reached");
      },
    }), "TELEGRAM_WEB_AMBIGUOUS_CHAT");
    assert.equal(launches, 0);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test("revoke wins while a slow pre-dispatch gate is blocked and no delayed click survives", async () => {
  const temporaryDirectory = await realpath(await mkdtemp(path.join(os.homedir(), ".telegram-web-consent-lease-")));
  try {
    const environment = environmentFor(temporaryDirectory);
    const identity = identityFor(environment);
    const userId = "987654321";
    const digest = accountDigestFromTelegramUserId(userId);
    await installValidConsent(identity, environment, digest);
    const options = attachApprovalContext(parseArguments(["send", "--chat", "123", "--message", "hello"]), identity, environment);
    options.currentAccountDigest = digest;

    let releaseGate;
    let announceStarted;
    const gate = new Promise((resolve) => { releaseGate = resolve; });
    const started = new Promise((resolve) => { announceStarted = resolve; });
    let clicks = 0;
    let verifications = 0;
    await withBrowserGlobals(decisiveBrowserGlobals("123", userId), async () => {
      const mutation = __testing.dispatchDecisiveMutation({
        page: makeModelPage({ peerId: "123" }),
        expectedPeerId: "123",
        options,
        stage: "send action",
        beforeDispatch: async () => {
          announceStarted();
          await gate;
        },
        decisiveControl: { click: async () => { clicks += 1; } },
        verify: async () => { verifications += 1; },
        ambiguousMessage: "unexpected",
      });
      await started;
      await __testing.revokeConsent(identity, environment);
      releaseGate();
      await expectCode(() => mutation, "TELEGRAM_WEB_CONSENT_REQUIRED");
    });
    assert.equal(clicks, 0);
    assert.equal(verifications, 0);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test("decisive consent lease passes a fixed short click deadline and revoke settles after the click", async () => {
  const temporaryDirectory = await realpath(await mkdtemp(path.join(os.homedir(), ".telegram-web-consent-click-")));
  try {
    const environment = environmentFor(temporaryDirectory);
    const identity = identityFor(environment);
    const userId = "987654321";
    const digest = accountDigestFromTelegramUserId(userId);
    await installValidConsent(identity, environment, digest);
    const options = attachApprovalContext(parseArguments(["send", "--chat", "123", "--message", "hello", "--timeout-ms", "300000"]), identity, environment);
    options.currentAccountDigest = digest;

    let releaseClick;
    let announceClick;
    const clickGate = new Promise((resolve) => { releaseClick = resolve; });
    const clickStarted = new Promise((resolve) => { announceClick = resolve; });
    const order = [];
    let receivedTimeout = null;
    await withBrowserGlobals(decisiveBrowserGlobals("123", userId), async () => {
      const mutation = __testing.dispatchDecisiveMutation({
        page: makeModelPage({ peerId: "123" }),
        expectedPeerId: "123",
        options,
        stage: "send action",
        decisiveControl: {
          click: async ({ timeout }) => {
            receivedTimeout = timeout;
            announceClick();
            await clickGate;
            order.push("click");
          },
        },
        verify: async () => ({ ok: true }),
        ambiguousMessage: "unexpected",
      });
      await clickStarted;
      const revoke = __testing.revokeConsent(identity, environment).then(() => order.push("revoke"));
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(order, []);
      releaseClick();
      assert.deepEqual(await mutation, { ok: true });
      await revoke;
    });
    assert.equal(receivedTimeout, 3_000);
    assert.deepEqual(order, ["click", "revoke"]);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

const submitProtectedConsent = async (url, inspectHtml = () => undefined) => {
  const landing = await new Promise((resolve, reject) => {
    http.get(url, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({ response, body: Buffer.concat(chunks).toString("utf8") }));
    }).on("error", reject);
  });
  assert.match(landing.body, /Codex.*Claude Code/su);
  inspectHtml(landing.body);
  assert.match(new URL(url).pathname, /^\/consent\/[A-Za-z0-9_-]{43}$/u);
  const cookie = landing.response.headers["set-cookie"]?.[0]?.split(";", 1)[0];
  const formAction = landing.body.match(/<form method="post" action="([^"]+)"/u)?.[1];
  assert.match(formAction || "", /^\/confirm\/[A-Za-z0-9_-]{43}$/u);
  const target = new URL(formAction, url);

  // The protected landing capability is single-admission. A competing local
  // request cannot refresh it to obtain another authorization cookie.
  const repeatedLandingStatus = await new Promise((resolve, reject) => {
    http.get(url, (response) => {
      response.resume();
      response.on("end", () => resolve(response.statusCode));
    }).on("error", reject);
  });
  assert.equal(repeatedLandingStatus, 410);
  await new Promise((resolve, reject) => {
    const request = http.request(target, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "content-length": Buffer.byteLength("affirm=yes"),
        cookie,
        origin: target.origin,
        "sec-fetch-site": "same-origin",
        "sec-fetch-mode": "navigate",
        "sec-fetch-dest": "document",
      },
    }, (response) => {
      response.resume();
      response.on("end", () => response.statusCode === 200 ? resolve() : reject(new Error(`status ${response.statusCode}`)));
    });
    request.on("error", reject);
    request.end("affirm=yes");
  });
};

test("protected local consent page grants Codex and Claude Code together without extra fields", async () => {
  const temporaryDirectory = await realpath(await mkdtemp(path.join(os.homedir(), ".telegram-web-consent-http-")));
  try {
    const environment = environmentFor(temporaryDirectory);
    const identity = identityFor(environment);
    let written = null;
    const accepted = await acceptConsentInProtectedBrowser(identity, accountDigest, environment, {
      openBrowser: async (url) => {
        // Knowing only the loopback origin/port is insufficient: historical
        // fixed routes expose neither the landing cookie nor confirmation.
        const origin = new URL(url).origin;
        for (const pathname of ["/", "/confirm"]) {
          const status = await new Promise((resolve, reject) => {
            http.get(new URL(pathname, origin), (response) => {
              response.resume();
              response.on("end", () => resolve(response.statusCode));
            }).on("error", reject);
          });
          assert.equal(status, 404);
        }
        return submitProtectedConsent(url, (html) => {
          assert.match(html, /явные, информированные, актуальные и продолжающиеся/u);
          assert.match(html, /для каждого конкретного чата, материала и контекста/u);
          assert.match(html, /При отзыве такого согласия я прекращу обработку и отзову это разрешение/u);
          assert.match(html, /365 дней/u);
          assert.match(html, /не является согласием за других людей/u);
          assert.match(html, /доказательством наличия или сохранения их согласия/u);
          assert.match(html, /подтверждением соблюдения закона/u);
          assert.match(html, /разрешением Telegram/u);
        });
      },
      writeConsent: async (record) => { written = structuredClone(record); },
    });
    assert.deepEqual(accepted, written);
    assert.deepEqual(Object.keys(accepted).sort(), ["acceptedAt", "accountDigest", "expiresAt", "statementDigest", "termsVersion"]);
    assert.equal(accepted.accountDigest, accountDigest);
    assert.equal(CONSENT_STATEMENTS.length, 2);
    assert.equal(CONSENT_TERMS_VERSION, "telegram-ai-processing/2026-08-04");
    assert.equal(CONSENT_STATEMENT_DIGEST, "b00d8274303f49f1c8304c85870d0b9171aa3297587a4ede62f0091cbbf21aa8");
    assert.equal(
      CONSENT_STATEMENT_DIGEST,
      createHash("sha256").update(JSON.stringify({ statements: CONSENT_STATEMENTS })).digest("hex"),
    );
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test("lifecycle abort during a late consent write can never publish a valid grant", async () => {
  const temporaryDirectory = await realpath(await mkdtemp(path.join(os.homedir(), ".telegram-web-consent-lifecycle-")));
  let releaseWrite = () => undefined;
  try {
    const environment = environmentFor(temporaryDirectory);
    const identity = identityFor(environment);
    const locations = runtimeLocations(identity, environment);
    const abortHandlers = new Set();
    const abortError = new TelegramWebRuntimeError(
      "TELEGRAM_WEB_COMMAND_TIMEOUT",
      "forced lifecycle deadline",
      { safeToRetry: false },
    );
    let aborted = false;
    const lifecycle = {
      assertActive: () => {
        if (aborted) throw abortError;
      },
      onAbort: (handler) => {
        abortHandlers.add(handler);
        return () => abortHandlers.delete(handler);
      },
      abort: () => {
        aborted = true;
        for (const handler of abortHandlers) handler(abortError);
      },
    };
    let announceWrite;
    let announceWriteReturned;
    const writeStarted = new Promise((resolve) => { announceWrite = resolve; });
    const writeReturned = new Promise((resolve) => { announceWriteReturned = resolve; });
    const writeGate = new Promise((resolve) => { releaseWrite = resolve; });
    const acceptance = acceptConsentInProtectedBrowser(identity, accountDigest, environment, {
      commandLifecycle: lifecycle,
      openBrowser: submitProtectedConsent,
      writeConsent: async (record) => {
        announceWrite();
        await writeGate;
        await writeFile(locations.consentFile, `${JSON.stringify(record)}\n`, { mode: 0o600 });
        if (process.platform !== "win32") await chmod(locations.consentFile, 0o600);
        announceWriteReturned();
      },
    });
    await writeStarted;
    lifecycle.abort();
    await expectCode(() => acceptance, "TELEGRAM_WEB_COMMAND_TIMEOUT");
    releaseWrite();
    await writeReturned;
    // renderConsentStatus takes the same state lock, so returning here proves
    // the delayed handler finished its publication fence/rollback first.
    const status = await renderConsentStatus(identity, accountDigest, new Date(), environment);
    assert.equal(status.valid, false);
    assert.equal(status.reason, "revoked");
    assert.notEqual(await lstat(locations.consentGenerationFile).catch(() => null), null);
  } finally {
    releaseWrite();
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test("concurrent revoke after consent submission removes the just-written grant", async () => {
  const temporaryDirectory = await realpath(await mkdtemp(path.join(os.homedir(), ".telegram-web-consent-accept-race-")));
  let acceptance = null;
  let revocation = null;
  let releaseWrite = () => undefined;
  try {
    const environment = environmentFor(temporaryDirectory);
    const identity = identityFor(environment);
    const locations = runtimeLocations(identity, environment);
    await __testing.ensurePrivateTree(environment.TRELIO_CONFIG_HOME, path.dirname(locations.consentFile), environment);
    let announceWrite;
    const writeStarted = new Promise((resolve) => { announceWrite = resolve; });
    const writeGate = new Promise((resolve) => { releaseWrite = resolve; });
    acceptance = acceptConsentInProtectedBrowser(identity, accountDigest, environment, {
      openBrowser: submitProtectedConsent,
      writeConsent: async (record) => {
        announceWrite();
        await writeGate;
        await writeFile(locations.consentFile, `${JSON.stringify(record)}\n`, { mode: 0o600 });
        if (process.platform !== "win32") await chmod(locations.consentFile, 0o600);
      },
    });
    await writeStarted;
    revocation = __testing.revokeConsent(identity, environment);
    releaseWrite();
    await acceptance;
    await revocation;
    const status = await renderConsentStatus(identity, accountDigest, new Date(), environment);
    assert.equal(status.valid, false);
    assert.equal(status.reason, "revoked");
    assert.equal(await lstat(locations.consentFile).catch(() => null), null);
  } finally {
    releaseWrite();
    await Promise.allSettled([acceptance, revocation].filter(Boolean));
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test("managed Telegram namespaces cannot be read as outbound text or used as download output", async () => {
  const temporaryDirectory = await realpath(await mkdtemp(path.join(os.homedir(), ".telegram-web-paths-")));
  try {
    const environment = environmentFor(temporaryDirectory);
    const identity = identityFor(environment);
    const locations = runtimeLocations(identity, environment);
    const managedFile = path.join(environment.TRELIO_CONFIG_HOME, "integrations", "telegram-web", "other-connection", "secret.txt");
    await mkdir(path.dirname(managedFile), { recursive: true, mode: 0o700 });
    await writeFile(managedFile, "secret", { mode: 0o600 });
    await expectCode(() => __testing.readRegularFileSnapshot(managedFile, 1024, environment), "TELEGRAM_WEB_UNSAFE_PATH");

    const runtimeCacheFile = path.join(environment.TRELIO_CACHE_HOME, "runtimes", "telegram-web", "1.0.1", "node_modules", "secret.txt");
    await mkdir(path.dirname(runtimeCacheFile), { recursive: true, mode: 0o700 });
    await writeFile(runtimeCacheFile, "cache-secret", { mode: 0o600 });
    await expectCode(() => __testing.readRegularFileSnapshot(runtimeCacheFile, 1024, environment), "TELEGRAM_WEB_UNSAFE_PATH");

    const alias = path.join(temporaryDirectory, "alias");
    await symlink(path.dirname(managedFile), alias, "dir");
    await expectCode(() => __testing.readRegularFileSnapshot(path.join(alias, "secret.txt"), 1024, environment), "TELEGRAM_WEB_UNSAFE_PATH");

    const ordinary = path.join(temporaryDirectory, "ordinary.txt");
    await writeFile(ordinary, "ordinary", { mode: 0o600 });
    assert.equal((await __testing.readRegularFileSnapshot(ordinary, 1024, environment)).buffer.toString("utf8"), "ordinary");

    await expectCode(() => __testing.ensureOutputPathAvailable(path.join(path.dirname(managedFile), "download.bin"), environment), "TELEGRAM_WEB_UNSAFE_PATH");
    await expectCode(() => __testing.ensureOutputPathAvailable(path.join(path.dirname(runtimeCacheFile), "download.bin"), environment), "TELEGRAM_WEB_UNSAFE_PATH");
    assert.equal(locations.root.includes(connectionId), true);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test("outbound document snapshots require canonical private non-empty regular files", async (context) => {
  if (process.platform === "win32") {
    context.skip("The 1.0.1 input-file lane is macOS/POSIX-only; Windows is fail-closed before state.");
    return;
  }
  const temporaryDirectory = await realpath(await mkdtemp(path.join(os.homedir(), ".telegram-web-input-")));
  const environment = environmentFor(temporaryDirectory);
  const file = path.join(temporaryDirectory, "approved.pdf");
  try {
    await chmod(temporaryDirectory, 0o700);
    await writeFile(file, Buffer.from("exact-document-bytes"), { mode: 0o600 });
    const snapshot = await __testing.readRegularFileSnapshot(file, 64 * 1024 * 1024, environment);
    assert.equal(snapshot.path, file);
    assert.equal(snapshot.name, "approved.pdf");
    assert.equal(snapshot.sizeBytes, 20);
    assert.equal(snapshot.selectionMimeType, "application/octet-stream");
    assert.equal(snapshot.transferMode, "document");
    assert.deepEqual(snapshot.buffer, Buffer.from("exact-document-bytes"));

    await expectCode(
      () => __testing.readRegularFileSnapshot(path.relative(process.cwd(), file), 64 * 1024 * 1024, environment),
      "TELEGRAM_WEB_UNSAFE_INPUT_FILE",
    );
    await expectCode(
      () => __testing.readRegularFileSnapshot(`${temporaryDirectory}/./approved.pdf`, 64 * 1024 * 1024, environment),
      "TELEGRAM_WEB_UNSAFE_INPUT_FILE",
    );
    for (const unsafe of unsafeDisplayCodePoints) {
      const hiddenName = path.join(temporaryDirectory, `safe${unsafe}name.txt`);
      await writeFile(hiddenName, "hidden-display-name", { mode: 0o600 });
      await expectCode(
        () => __testing.readRegularFileSnapshot(hiddenName, 64 * 1024 * 1024, environment),
        "TELEGRAM_WEB_UNSAFE_INPUT_FILE",
      );
    }

    const empty = path.join(temporaryDirectory, "empty.txt");
    await writeFile(empty, Buffer.alloc(0), { mode: 0o600 });
    await expectCode(
      () => __testing.readRegularFileSnapshot(empty, 64 * 1024 * 1024, environment),
      "TELEGRAM_WEB_UNSAFE_INPUT_FILE",
    );

    const symlinkFile = path.join(temporaryDirectory, "alias.pdf");
    await symlink(file, symlinkFile);
    await expectCode(
      () => __testing.readRegularFileSnapshot(symlinkFile, 64 * 1024 * 1024, environment),
      "TELEGRAM_WEB_UNSAFE_INPUT_FILE",
    );

    await chmod(file, 0o622);
    await expectCode(
      () => __testing.readRegularFileSnapshot(file, 64 * 1024 * 1024, environment),
      "TELEGRAM_WEB_UNSAFE_INPUT_FILE",
    );
    await chmod(file, 0o600);

    const unsafeParent = path.join(temporaryDirectory, "shared");
    await mkdir(unsafeParent, { mode: 0o777 });
    await chmod(unsafeParent, 0o777);
    const unsafeChild = path.join(unsafeParent, "child.txt");
    await writeFile(unsafeChild, "x", { mode: 0o600 });
    await expectCode(
      () => __testing.readRegularFileSnapshot(unsafeChild, 64 * 1024 * 1024, environment),
      "TELEGRAM_WEB_UNSAFE_PATH",
    );
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test("document approval binds one source snapshot, caption, destination and all document-only options", async () => {
  const temporaryDirectory = await realpath(await mkdtemp(path.join(os.homedir(), ".telegram-web-file-approval-")));
  try {
    const environment = environmentFor(temporaryDirectory);
    const identity = identityFor(environment);
    const options = attachApprovalContext(parseArguments([
      "send", "--account", "3", "--chat", "saved-messages", "--file", "/private/source.pdf", "--message", "caption", "--dry-run",
    ]), identity, environment);
    options.approvalRequestPrepared = {
      message: { message: "caption", approval: { text: "caption", chars: 7, sha256: "x".repeat(64) } },
      files: [{
        path: "/private/source.pdf",
        name: "source.pdf",
        sizeBytes: 42,
        sha256: "b".repeat(64),
        selectionMimeType: "application/octet-stream",
        transferMode: "document",
        buffer: Buffer.from("not serialized"),
      }],
      avatar: null,
    };
    const operation = await __testing.buildApprovalOperation(options, {
      chat: { peerId: "987654321", title: "Saved Messages", isSelf: true },
    }, options.approvalRequestPrepared);
    assert.equal(operation.accountSlot, 3);
    assert.deepEqual(operation.files, [{
      path: "/private/source.pdf",
      name: "source.pdf",
      sizeBytes: 42,
      sha256: "b".repeat(64),
      selectionMimeType: "application/octet-stream",
      transferMode: "document",
    }]);
    assert.deepEqual(operation.documentOptions, {
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
    });
    assert.equal(operation.message.text, "caption");
    assert.deepEqual(operation.chat, {
      semanticId: "saved-messages",
      peerId: null,
      title: "Saved Messages",
      isSelf: true,
    });
    assert.equal(JSON.stringify(operation).includes("987654321"), false);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test("one-document send still requires dry-run approval under autonomous text policy before browser launch", async (context) => {
  if (process.platform === "win32") {
    context.skip("The 1.0.1 input-file lane is macOS/POSIX-only; Windows is fail-closed before state.");
    return;
  }
  const temporaryDirectory = await realpath(await mkdtemp(path.join(os.homedir(), ".telegram-web-file-policy-")));
  try {
    await chmod(temporaryDirectory, 0o700);
    const environment = environmentFor(temporaryDirectory, {
      TRELIO_SKILL_CONNECTION_CONFIG_JSON: JSON.stringify({ allowAutonomous: true }),
    });
    const identity = identityFor(environment);
    await installValidConsent(identity, environment, accountDigest);
    await runCli(["policy", "set", "--send-mode", "autonomous", "--confirm"], environment);
    const source = path.join(temporaryDirectory, "source.pdf");
    await writeFile(source, "document", { mode: 0o600 });
    let browserCalls = 0;
    await expectCode(() => runCli([
      "send", "--chat", "123", "--file", source,
    ], environment, {
      withTelegramBrowser: async () => { browserCalls += 1; },
    }), "TELEGRAM_WEB_APPROVAL_REQUIRED");
    assert.equal(browserCalls, 0);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test("document popup accepts source-backed document MIME and rejects Web K audio remapping before click", async () => {
  const proofKey = "__trelioTelegramWebDocumentPopupProofsV1";
  const makeNode = () => {
    const attributes = new Map();
    return {
      classList: { contains: (name) => name === "active" },
      setAttribute: (name, value) => attributes.set(name, value),
      getAttribute: (name) => attributes.get(name) ?? null,
      removeAttribute: (name) => attributes.delete(name),
    };
  };
  const runCase = async (name, mimeType, expectedCode = null) => {
    const bytes = Buffer.from(`bytes:${name}`);
    const digest = createHash("sha256").update(bytes).digest("hex");
    const file = new File([bytes], name, { type: mimeType, lastModified: 1 });
    const chat = { peerId: 123, type: "chat", isMonoforum: false, input: {} };
    const popup = {
      chat,
      files: [file],
      convertedFiles: new WeakMap(),
      element: makeNode(),
      btnConfirm: makeNode(),
      willAttach: { type: "document", group: true, sendFileDetails: [{ file }] },
      changeGroup(group) {
        this.willAttach = { type: "document", group, sendFileDetails: [{ file }] };
      },
    };
    const registry = new Map([[
      "11111111-1111-4111-8111-111111111111",
      { phase: "selected", chat, input: chat.input, popup: null, file: null, digest: null },
    ]]);
    const page = makeModelPage();
    await withBrowserGlobals({
      appImManager: { chat },
      PopupNewMedia: { getPopups: () => [popup] },
      [proofKey]: registry,
    }, async () => {
      const action = () => __testing.captureExactDocumentPopup(page, "123", {
        name,
        sizeBytes: bytes.length,
        sha256: digest,
      }, 1_000, "11111111-1111-4111-8111-111111111111");
      if (expectedCode) return expectCode(action, expectedCode);
      const captured = await action();
      assert.equal(captured.normalizedMimeType, mimeType);
      assert.equal(popup.willAttach.group, false);
      assert.equal(popup.willAttach.sendFileDetails[0].file, file);
    });
  };

  await runCase("report.pdf", "application/pdf");
  await runCase("notes.txt", "text/plain");
  await runCase("image.png", "image/png");
  await runCase("sound.mp3", "audio/mpeg", "TELEGRAM_WEB_UNSUPPORTED_OPERATION");
  await runCase("sound.ogg", "audio/ogg", "TELEGRAM_WEB_UNSUPPORTED_OPERATION");
  await runCase("sound.wav", "audio/wav", "TELEGRAM_WEB_UNSUPPORTED_OPERATION");
  await runCase("voice.ogg", "video/ogg", "TELEGRAM_WEB_UNSUPPORTED_OPERATION");
  await runCase("animation.gif", "image/gif", "TELEGRAM_WEB_UNSUPPORTED_OPERATION");
  await runCase("AnimatedSticker.tgs", "application/x-tgsticker", "TELEGRAM_WEB_UNSUPPORTED_OPERATION");
  await runCase("custom.tgs", "application/octet-stream", "TELEGRAM_WEB_UNSUPPORTED_OPERATION");
});

test("document popup proves real send_docs rights, entity-free caption, and exact ungrouped options", async () => {
  const proofKey = "__trelioTelegramWebDocumentPopupProofsV1";
  const token = "11111111-1111-4111-8111-111111111111";
  class MockHTMLElement {
    constructor(text = "") { this.textContent = text; }
    querySelector() { return null; }
  }
  const makeAttributes = (initial = {}) => {
    const values = new Map(Object.entries(initial));
    return {
      classList: { contains: (name) => name === "active" },
      disabled: false,
      getAttribute: (name) => values.get(name) ?? null,
      setAttribute: (name, value) => values.set(name, value),
      removeAttribute: (name) => values.delete(name),
    };
  };
  const run = (sendDocs, mutate = () => undefined) => {
    const bytes = Buffer.from("pdf");
    const file = new File([bytes], "report.pdf", { type: "application/pdf" });
    const inputNode = new MockHTMLElement("caption");
    const chat = {
      peerId: 123,
      type: "chat",
      isMonoforum: false,
      getMessageSendingParams: () => ({ peerId: 123 }),
    };
    const popup = {
      chat,
      files: [file],
      element: makeAttributes({ "data-trelio-document-popup": token }),
      btnConfirm: makeAttributes({ "data-trelio-document-confirm": token }),
      willAttach: { type: "document", sendFileDetails: [{ file }], group: false },
      messageInputField: { input: inputNode, value: "caption" },
      fileConversions: new Map(),
      convertedFiles: new WeakMap(),
      effect: () => undefined,
      starsState: { totalStars: () => 0, totalMessages: () => 1 },
      captionLengthMax: 1024,
    };
    mutate(popup);
    const registry = new Map([[token, {
      phase: "popup",
      chat,
      popup,
      file,
      digest: createHash("sha256").update(bytes).digest("hex"),
      normalizedMimeType: "application/pdf",
    }]]);
    const captionLocator = {
      filter() { return this; },
      count: async () => 1,
      first() { return this; },
      evaluate: async (callback) => callback(inputNode),
    };
    const popupLocator = {
      filter() { return this; },
      locator: () => captionLocator,
    };
    const page = {
      evaluate: async (callback, argument) => callback(argument),
      locator: () => popupLocator,
    };
    return withBrowserGlobals({
      HTMLElement: MockHTMLElement,
      appImManager: { chat },
      PopupNewMedia: {
        getPopups: () => [popup],
        canSend: async () => ({
          send_photos: true,
          send_videos: true,
          send_docs: sendDocs,
          send_audios: true,
          send_gifs: true,
        }),
      },
      getRichValueWithCaret: () => ({ value: "caption", entities: [] }),
      parseMarkdown: (value, entities) => [value, entities],
      [proofKey]: registry,
    }, () => __testing.assertExactDocumentPopupState(page, "123", token, {
      name: "report.pdf",
      sizeBytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    }, "caption"));
  };
  await run(true);
  await expectCode(() => run(false), "TELEGRAM_WEB_COMPOSER_CONFLICT");
  await expectCode(() => run(true, (popup) => { popup.willAttach.group = true; }), "TELEGRAM_WEB_COMPOSER_CONFLICT");
  await expectCode(() => run(true, (popup) => {
    popup.convertedFiles.set(popup.files[0], {
      file: new File([Buffer.from("converted")], "report.pdf", { type: "application/pdf" }),
    });
  }), "TELEGRAM_WEB_COMPOSER_CONFLICT");
});

test("final document model binds exact MIME/name/size and rejects semantic media types and attributes", async () => {
  const peerId = "123";
  const messageId = "55";
  const makeModel = ({ mimeType = "application/pdf", documentType = "pdf", attributes = null } = {}) => ({
    _: "message",
    pFlags: { out: true },
    id: 55,
    date: 1_800_000_000,
    message: "caption",
    mid: 55,
    peerId: 123,
    entities: [],
    totalEntities: [],
    media: {
      _: "messageMediaDocument",
      pFlags: {},
      document: {
        _: "document",
        pFlags: {},
        id: "1000",
        access_hash: "2000",
        file_reference: new Uint8Array([1, 2, 3]),
        date: 1_800_000_000,
        dc_id: 2,
        attributes: attributes || [{ _: "documentAttributeFilename", file_name: "report.pdf" }],
        file_name: "report.pdf",
        size: 42,
        mime_type: mimeType,
        type: documentType,
      },
    },
  });
  const run = async (model, normalizedMimeType = "application/pdf") => {
    const base = decisiveBrowserGlobals(peerId);
    return withBrowserGlobals({
      ...base,
      rootScope: {
        ...base.rootScope,
        managers: { appMessagesManager: { getMessageByPeer: () => model } },
      },
      appImManager: { chat: {
        ...base.appImManager.chat,
        peerId: 123,
        type: "chat",
        isMonoforum: false,
        isOutMessage: () => true,
      } },
    }, () => __testing.waitForFinalDocumentMessageModel(makeModelPage({ peerId, waitPolls: 2 }), {
      expectedPeerId: peerId,
      messageId,
      caption: "caption",
      snapshot: { name: "report.pdf", sizeBytes: 42, normalizedMimeType },
      timeoutMs: 100,
    }));
  };
  assert.deepEqual(await run(makeModel()), {
    name: "report.pdf",
    sizeBytes: 42,
    mimeType: "application/pdf",
  });
  await assert.rejects(() => run(makeModel({ mimeType: "audio/mpeg" })));
  await assert.rejects(() => run(
    makeModel({ mimeType: "image/gif", documentType: "gif" }),
    "image/gif",
  ));
  await assert.rejects(() => run(
    makeModel({ mimeType: "application/octet-stream", documentType: "gif" }),
    "application/octet-stream",
  ));
  for (const attribute of [
    { _: "documentAttributeAudio", pFlags: {}, duration: 1 },
    { _: "documentAttributeVideo", pFlags: {}, duration: 1, w: 1, h: 1 },
    { _: "documentAttributeAnimated" },
    { _: "documentAttributeSticker", alt: "x", stickerset: { _: "inputStickerSetEmpty" } },
    { _: "documentAttributeCustomEmoji", pFlags: {}, alt: "x", stickerset: { _: "inputStickerSetEmpty" } },
  ]) {
    await assert.rejects(() => run(makeModel({
      attributes: [
        { _: "documentAttributeFilename", file_name: "report.pdf" },
        attribute,
      ],
    })));
  }
});

test("default host cache is allowed only from its exact materialized skill-runtime subtree", async () => {
  const temporaryDirectory = await realpath(await mkdtemp(path.join(os.homedir(), ".telegram-web-host-cache-")));
  const previousCwd = process.cwd();
  try {
    const cacheBase = path.join(temporaryDirectory, "cache");
    const materialized = path.join(cacheBase, "workspace-bridge", "skill-runtimes", "telegram-web", "1.0.1");
    await mkdir(materialized, { recursive: true, mode: 0o700 });
    process.chdir(materialized);
    assert.equal(
      __testing.validateDedicatedBase(cacheBase, "default cache", { allowMaterializedRuntimeAncestor: true }),
      cacheBase,
    );
    assert.throws(
      () => __testing.validateDedicatedBase(cacheBase, "custom cache"),
      (error) => error.code === "TELEGRAM_WEB_UNSAFE_PATH",
    );
    const unrelatedAncestor = path.join(temporaryDirectory, "unrelated");
    await mkdir(unrelatedAncestor, { mode: 0o700 });
    assert.throws(
      () => __testing.validateDedicatedBase(temporaryDirectory, "broad cache", { allowMaterializedRuntimeAncestor: true }),
      (error) => error.code === "TELEGRAM_WEB_UNSAFE_PATH",
    );
  } finally {
    process.chdir(previousCwd);
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test("runtime cache accepts an owned 0755 base but rejects unsafe descendants before package load", async (context) => {
  if (process.platform === "win32") {
    context.skip("POSIX-only regression; the Windows ACL path requires its own qualification lane");
    return;
  }
  const temporaryDirectory = await realpath(await mkdtemp(path.join(os.homedir(), ".telegram-web-cache-trust-")));
  try {
    const environment = environmentFor(temporaryDirectory);
    const identity = identityFor(environment);
    const cacheBase = environment.TRELIO_CACHE_HOME;
    const runtimeRoot = path.join(cacheBase, "runtimes", "telegram-web", "1.0.1");
    await mkdir(cacheBase, { mode: 0o755 });
    await chmod(cacheBase, 0o755);
    await __testing.ensurePrivateTree(cacheBase, runtimeRoot, environment);
    assert.equal((await stat(cacheBase)).mode & 0o777, 0o755);
    assert.equal((await stat(path.join(cacheBase, "runtimes", "telegram-web"))).mode & 0o777, 0o700);
    assert.deepEqual(await __testing.inspectPinnedPlaywright(identity, environment), { ready: false, entryReal: null });

    await chmod(path.join(cacheBase, "runtimes", "telegram-web"), 0o777);
    await expectCode(
      () => __testing.inspectPinnedPlaywright(identity, environment),
      "TELEGRAM_WEB_UNSAFE_PATH",
    );

    await chmod(path.join(cacheBase, "runtimes", "telegram-web"), 0o700);
    const packageFixture = path.join(runtimeRoot, "node_modules", "playwright-core");
    await mkdir(path.join(packageFixture, "lib"), { recursive: true, mode: 0o700 });
    await writeFile(path.join(packageFixture, "index.js"), "module.exports = 1;\n", { mode: 0o600 });
    await writeFile(path.join(packageFixture, "lib", "nested.js"), "module.exports = 2;\n", { mode: 0o600 });
    const beforeTamper = await __testing.digestTrustedPackageTree(packageFixture, environment);
    await writeFile(path.join(packageFixture, "lib", "nested.js"), "module.exports = 3;\n", { mode: 0o600 });
    const afterTamper = await __testing.digestTrustedPackageTree(packageFixture, environment);
    assert.notEqual(afterTamper.sha256, beforeTamper.sha256);
    await writeFile(path.join(packageFixture, "extra.js"), "module.exports = 4;\n", { mode: 0o600 });
    const afterExtra = await __testing.digestTrustedPackageTree(packageFixture, environment);
    assert.notEqual(afterExtra.sha256, afterTamper.sha256);
    await mkdir(path.join(packageFixture, "unexpected-empty"), { mode: 0o700 });
    await expectCode(
      () => __testing.digestTrustedPackageTree(packageFixture, environment),
      "TELEGRAM_WEB_RUNTIME_INTEGRITY_FAILED",
    );
    await rm(path.join(packageFixture, "unexpected-empty"), { recursive: true, force: true });
    await symlink(path.join(packageFixture, "index.js"), path.join(packageFixture, "linked.js"));
    await expectCode(
      () => __testing.digestTrustedPackageTree(packageFixture, environment),
      "TELEGRAM_WEB_RUNTIME_INTEGRITY_FAILED",
    );
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test("POSIX browser executable chain rejects arbitrary group/world writable code", async (context) => {
  if (process.platform === "win32") {
    context.skip("POSIX-only executable trust regression; Windows Program Files/DACL requires its own qualification lane");
    return;
  }
  const temporaryDirectory = await realpath(await mkdtemp(path.join(os.homedir(), ".telegram-web-browser-chain-")));
  try {
    const executable = path.join(temporaryDirectory, "browser", "chrome");
    await mkdir(path.dirname(executable), { mode: 0o700 });
    await writeFile(executable, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    await chmod(executable, 0o755);
    assert.equal(await __testing.assertTrustedPosixExecutableChain(executable), executable);

    await chmod(executable, 0o775);
    await expectCode(() => __testing.assertTrustedPosixExecutableChain(executable), "TELEGRAM_WEB_UNSAFE_PATH");
    await chmod(executable, 0o757);
    await expectCode(() => __testing.assertTrustedPosixExecutableChain(executable), "TELEGRAM_WEB_UNSAFE_PATH");
    await chmod(executable, 0o755);
    await chmod(path.dirname(executable), 0o775);
    await expectCode(() => __testing.assertTrustedPosixExecutableChain(executable), "TELEGRAM_WEB_UNSAFE_PATH");
    await chmod(path.dirname(executable), 0o700);
    const replacement = path.join(path.dirname(executable), "replacement");
    await writeFile(replacement, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    await rm(executable);
    await symlink(replacement, executable);
    await expectCode(() => __testing.assertTrustedPosixExecutableChain(executable), "TELEGRAM_WEB_UNSAFE_PATH");
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test("exact bigint path identity distinguishes APFS inodes that collapse as Number", async (context) => {
  if (process.platform !== "darwin") {
    context.skip("APFS large-inode collision regression");
    return;
  }
  const leftPath = "/bin/[";
  const rightPath = "/bin/ls";
  const [leftNumber, rightNumber] = await Promise.all([lstat(leftPath), lstat(rightPath)]);
  assert.equal(leftNumber.isFile(), true);
  assert.equal(rightNumber.isFile(), true);
  // This is the real collision that made Number-valued Stats unsuitable as
  // an identity token on the qualified macOS lane.
  assert.equal(leftNumber.dev, rightNumber.dev);
  assert.equal(leftNumber.ino, rightNumber.ino);
  const [leftExact, rightExact] = await Promise.all([
    __testing.exactPathIdentity(leftPath),
    __testing.exactPathIdentity(rightPath),
  ]);
  assert.equal(leftExact.dev, rightExact.dev);
  assert.notEqual(leftExact.ino, rightExact.ino);
});

test("macOS extended ALLOW ACL is rejected despite private mode bits while benign home DENY remains valid", async (context) => {
  if (process.platform !== "darwin") {
    context.skip("macOS extended-ACL regression");
    return;
  }
  const temporaryDirectory = await realpath(await mkdtemp(path.join(os.homedir(), ".telegram-web-acl-")));
  try {
    const environment = environmentFor(temporaryDirectory);
    const ordinaryDownloads = path.join(os.homedir(), "Downloads");
    if (await lstat(ordinaryDownloads).catch(() => null)) {
      // The live macOS folder commonly renders as `@` plus a benign
      // `group:everyone deny delete` ACL entry; it must remain usable.
      await __testing.assertTrustedDownloadOutputParent(ordinaryDownloads, environment);
    }
    const outputParent = path.join(temporaryDirectory, "Downloads");
    await mkdir(outputParent, { mode: 0o700 });
    await __testing.assertTrustedDownloadOutputParent(outputParent, environment);

    const outputAncestor = path.join(temporaryDirectory, "output-ancestor");
    const nestedOutputParent = path.join(outputAncestor, "nested");
    await mkdir(nestedOutputParent, { recursive: true, mode: 0o700 });
    execFileSync("/bin/chmod", ["+a", "group:everyone allow add_file,delete_child", outputAncestor], {
      cwd: "/",
      env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "C", LC_ALL: "C" },
      stdio: "ignore",
    });
    await expectCode(
      () => __testing.assertTrustedDownloadOutputParent(nestedOutputParent, environment),
      "TELEGRAM_WEB_UNSAFE_PATH",
    );
    execFileSync("/bin/chmod", ["-N", outputAncestor], { cwd: "/", stdio: "ignore" });

    execFileSync("/bin/chmod", ["+a", "group:everyone allow add_file,delete_child", outputParent], {
      cwd: "/",
      env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "C", LC_ALL: "C" },
      stdio: "ignore",
    });
    await expectCode(
      () => __testing.assertTrustedDownloadOutputParent(outputParent, environment),
      "TELEGRAM_WEB_UNSAFE_PATH",
    );
    execFileSync("/bin/chmod", ["-N", outputParent], { cwd: "/", stdio: "ignore" });

    const privateDirectory = path.join(environment.TRELIO_CONFIG_HOME, "integrations", "telegram-web", connectionId);
    await __testing.ensurePrivateTree(environment.TRELIO_CONFIG_HOME, privateDirectory, environment);
    execFileSync("/bin/chmod", ["+a", "group:everyone allow read,write,delete", privateDirectory], {
      cwd: "/",
      stdio: "ignore",
    });
    await expectCode(
      () => __testing.ensurePrivateTree(environment.TRELIO_CONFIG_HOME, privateDirectory, environment),
      "TELEGRAM_WEB_UNSAFE_PATH",
    );

    const executableParent = path.join(temporaryDirectory, "executable-chain");
    const executable = path.join(executableParent, "chrome");
    await mkdir(executableParent, { mode: 0o700 });
    await writeFile(executable, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    await chmod(executable, 0o755);
    execFileSync("/bin/chmod", ["+a", "group:everyone allow write,delete", executable], {
      cwd: "/",
      env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "C", LC_ALL: "C" },
      stdio: "ignore",
    });
    await expectCode(
      () => __testing.assertTrustedPosixExecutableChain(executable),
      "TELEGRAM_WEB_UNSAFE_PATH",
    );
    execFileSync("/bin/chmod", ["-N", executable], { cwd: "/", stdio: "ignore" });
    execFileSync("/bin/chmod", ["+a", "group:everyone allow add_file,delete_child", executableParent], {
      cwd: "/",
      env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "C", LC_ALL: "C" },
      stdio: "ignore",
    });
    await expectCode(
      () => __testing.assertTrustedPosixExecutableChain(executable),
      "TELEGRAM_WEB_UNSAFE_PATH",
    );
    execFileSync("/bin/chmod", ["-N", executableParent], { cwd: "/", stdio: "ignore" });

    const hostileNearestAncestor = path.join(temporaryDirectory, "hostile-base-ancestor");
    const missingBase = path.join(hostileNearestAncestor, "missing", "config");
    await mkdir(hostileNearestAncestor, { mode: 0o700 });
    execFileSync("/bin/chmod", ["+a", "group:everyone allow add_file,delete_child", hostileNearestAncestor], {
      cwd: "/",
      env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "C", LC_ALL: "C" },
      stdio: "ignore",
    });
    await expectCode(
      () => __testing.ensureDedicatedBaseDirectory(missingBase, environment),
      "TELEGRAM_WEB_UNSAFE_PATH",
    );
    assert.equal(await lstat(path.join(hostileNearestAncestor, "missing")).catch(() => null), null);
    execFileSync("/bin/chmod", ["-N", hostileNearestAncestor], { cwd: "/", stdio: "ignore" });
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test("runtime root shape rejects npmrc and sibling packages before any code load", async () => {
  const temporaryDirectory = await realpath(await mkdtemp(path.join(os.homedir(), ".telegram-web-runtime-shape-")));
  try {
    const environment = environmentFor(temporaryDirectory);
    const identity = identityFor(environment);
    const root = path.join(environment.TRELIO_CACHE_HOME, "runtimes", "telegram-web", identity.runtimeVersion);
    const nodeModules = path.join(root, "node_modules");
    await __testing.ensurePrivateTree(environment.TRELIO_CACHE_HOME, path.join(nodeModules, "playwright-core"), environment);
    await writeFile(path.join(root, "package.json"), "{}\n", { mode: 0o600 });
    await writeFile(path.join(root, "package-lock.json"), "{}\n", { mode: 0o600 });
    await writeFile(path.join(nodeModules, ".package-lock.json"), "{}\n", { mode: 0o600 });

    await writeFile(path.join(root, ".npmrc"), "ignore-scripts=false\n", { mode: 0o600 });
    await expectCode(() => __testing.verifyExactRuntimeRootShape(root, environment), "TELEGRAM_WEB_RUNTIME_INTEGRITY_FAILED");
    await rm(path.join(root, ".npmrc"));

    await mkdir(path.join(nodeModules, "unexpected-package"), { mode: 0o700 });
    await expectCode(() => __testing.verifyExactRuntimeRootShape(root, environment), "TELEGRAM_WEB_RUNTIME_INTEGRITY_FAILED");
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test("component-wise base creation rejects a symlink replacement before creating descendants", async (context) => {
  if (process.platform === "win32") {
    context.skip("POSIX symlink race regression; Windows uses reparse-point/DACL qualification");
    return;
  }
  const temporaryDirectory = await realpath(await mkdtemp(path.join(os.homedir(), ".telegram-web-base-race-")));
  try {
    const environment = environmentFor(temporaryDirectory);
    const existingAncestor = path.join(temporaryDirectory, "existing");
    const replacementTarget = path.join(temporaryDirectory, "replacement-target");
    const requestedBase = path.join(existingAncestor, "first", "second");
    await mkdir(existingAncestor, { mode: 0o700 });
    await mkdir(replacementTarget, { mode: 0o700 });
    let replaced = false;
    await expectCode(() => __testing.ensureDedicatedBaseDirectory(requestedBase, environment, {
      afterComponentMkdir: async (createdPath, { created }) => {
        if (!created || replaced || path.basename(createdPath) !== "first") return;
        replaced = true;
        await rm(createdPath, { recursive: true, force: false });
        await symlink(replacementTarget, createdPath);
      },
    }), "TELEGRAM_WEB_UNSAFE_PATH");
    assert.equal(replaced, true);
    assert.deepEqual(await readdir(replacementTarget), []);
    assert.equal(await lstat(path.join(replacementTarget, "second")).catch(() => null), null);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test("transient npm diagnostics retry a corrupt fresh stage but non-transient failure stops", async () => {
  const temporaryDirectory = await realpath(await mkdtemp(path.join(os.homedir(), ".telegram-web-bootstrap-retry-")));
  try {
    const environment = environmentFor(temporaryDirectory);
    const identity = identityFor(environment);
    const trustedRoot = path.join(temporaryDirectory, "trusted-node");
    const fakeNode = path.join(trustedRoot, "bin", "node");
    const fakeNpm = path.join(trustedRoot, "lib", "npm-cli.js");
    await mkdir(path.dirname(fakeNode), { recursive: true, mode: 0o700 });
    await mkdir(path.dirname(fakeNpm), { recursive: true, mode: 0o700 });
    await writeFile(fakeNode, "#!/bin/sh\nexit 1\n", { mode: 0o700 });
    await chmod(fakeNode, 0o700);
    await writeFile(fakeNpm, "// deterministic fake npm entry\n", { mode: 0o600 });

    const prefixes = [];
    const fakeSpawnSync = (_executable, args) => {
      const prefix = args[args.indexOf("--prefix") + 1];
      prefixes.push(prefix);
      // Create a malformed candidate on every attempt. The first transport
      // error is transient, so this corrupt stage must be discarded and a
      // different fresh stage attempted. The second E401 is non-transient and
      // must stop bounded retry classification.
      mkdirSync(path.join(prefix, "node_modules", "playwright-core", "unexpected-empty"), {
        recursive: true,
        mode: 0o700,
      });
      writeFileSync(path.join(prefix, "node_modules", ".package-lock.json"), "{}\n", { mode: 0o600 });
      return prefixes.length === 1
        ? { status: 1, stderr: "ECONNRESET", stdout: "", error: { code: "ECONNRESET" } }
        : { status: 1, stderr: "E401 unauthorized", stdout: "" };
    };

    await expectCode(() => bootstrapBrowserRuntime(identity, environment, {
      nodeExecutable: fakeNode,
      npmCliPath: fakeNpm,
      testOnlyNpmLayout: true,
      spawnSync: fakeSpawnSync,
    }), "TELEGRAM_WEB_BOOTSTRAP_FAILED");
    assert.equal(prefixes.length, 2);
    assert.notEqual(prefixes[0], prefixes[1]);
    const persistentRoot = path.join(environment.TRELIO_CACHE_HOME, "runtimes", "telegram-web", identity.runtimeVersion);
    assert.equal(prefixes.some((prefix) => prefix === persistentRoot), false);
    assert.equal(await lstat(persistentRoot).catch(() => null), null);
    const parentEntries = await readdir(path.dirname(persistentRoot));
    assert.equal(parentEntries.some((entry) => entry.includes(".install.") || entry.includes(".npm.")), false);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test("lifetime CommonJS guard blocks bare and escaping loads from the verified package root", async () => {
  const temporaryDirectory = await realpath(await mkdtemp(path.join(os.homedir(), ".telegram-web-cjs-guard-")));
  try {
    const packageRoot = path.join(temporaryDirectory, "playwright-core");
    const outsidePackage = path.join(temporaryDirectory, "node_modules", "unexpected-package");
    await mkdir(packageRoot, { mode: 0o700 });
    await mkdir(outsidePackage, { recursive: true, mode: 0o700 });
    await writeFile(path.join(packageRoot, "entry.cjs"), "// guarded require anchor\n", { mode: 0o600 });
    await writeFile(path.join(packageRoot, "local.cjs"), "module.exports = 'local';\n", { mode: 0o600 });
    await writeFile(path.join(packageRoot, "safe.cjs"), "module.exports = require('node:path').basename('/x') + ':' + require('./local.cjs');\n", { mode: 0o600 });
    await writeFile(path.join(packageRoot, "bare.cjs"), "module.exports = require('unexpected-package');\n", { mode: 0o600 });
    await writeFile(path.join(packageRoot, "escape.cjs"), "module.exports = require('../outside.cjs');\n", { mode: 0o600 });
    await writeFile(path.join(outsidePackage, "index.js"), "module.exports = 'unexpected';\n", { mode: 0o600 });
    await writeFile(path.join(temporaryDirectory, "outside.cjs"), "module.exports = 'outside';\n", { mode: 0o600 });

    __testing.installPlaywrightCommonJsLoadGuard(packageRoot);
    const guardedRequire = createRequire(path.join(packageRoot, "entry.cjs"));
    assert.equal(guardedRequire("./safe.cjs"), "x:local");
    for (const target of ["./bare.cjs", "./escape.cjs"]) {
      assert.throws(() => guardedRequire(target), (error) => error?.code === "MODULE_NOT_FOUND");
    }
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test("download output requires an owned non-shared canonical ancestor chain", async (context) => {
  if (process.platform === "win32") {
    context.skip("POSIX-only mode regression; the Windows no-reparse/DACL chain requires its own qualification lane");
    return;
  }
  const safeRoot = await realpath(await mkdtemp(path.join(os.homedir(), ".telegram-web-output-")));
  try {
    const environment = environmentFor(safeRoot);
    const safeParent = path.join(safeRoot, "Downloads");
    await mkdir(safeParent, { mode: 0o700 });
    await __testing.ensureOutputPathAvailable(path.join(safeParent, "safe.bin"), environment);

    const groupWritable = path.join(safeRoot, "group-shared");
    await mkdir(groupWritable, { mode: 0o770 });
    await chmod(groupWritable, 0o770);
    await expectCode(
      () => __testing.ensureOutputPathAvailable(path.join(groupWritable, "blocked.bin"), environment),
      "TELEGRAM_WEB_UNSAFE_PATH",
    );

    const worldWritable = path.join(safeRoot, "world-shared");
    await mkdir(worldWritable, { mode: 0o707 });
    await chmod(worldWritable, 0o707);
    await expectCode(
      () => __testing.ensureOutputPathAvailable(path.join(worldWritable, "blocked.bin"), environment),
      "TELEGRAM_WEB_UNSAFE_PATH",
    );

    await expectCode(
      () => __testing.ensureOutputPathAvailable(path.join(path.parse(safeRoot).root, "tmp", "telegram-web-blocked.bin"), environment),
      "TELEGRAM_WEB_UNSAFE_PATH",
    );
  } finally {
    await rm(safeRoot, { recursive: true, force: true });
  }
});

test("download publication is exclusive, consent-gated and never deletes a raced replacement", async (context) => {
  if (process.platform === "win32") {
    context.skip("POSIX rename-over-existing semantics are required for the forced replacement regression");
    return;
  }
  // The output-chain contract deliberately rejects shared /tmp ancestors.
  // Keep this publication/ABA fixture below the user's private home instead.
  const temporaryDirectory = await realpath(await mkdtemp(path.join(os.homedir(), ".telegram-web-download-")));
  try {
    const environment = environmentFor(temporaryDirectory);
    const download = () => ({
      createReadStream: async () => Readable.from([Buffer.from("verified bytes")]),
      cancel: async () => undefined,
    });
    const success = path.join(temporaryDirectory, "success.bin");
    const saved = await saveDownloadExclusively(download(), success, environment);
    assert.equal(saved.sizeBytes, 14);
    assert.equal((await stat(success)).mode & 0o777, 0o600);

    const revoked = path.join(temporaryDirectory, "revoked.bin");
    await expectCode(() => saveDownloadExclusively(download(), revoked, environment, async () => {
      throw new TelegramWebRuntimeError("TELEGRAM_WEB_CONSENT_REQUIRED", "revoked");
    }), "TELEGRAM_WEB_CONSENT_REQUIRED");
    assert.equal(await lstat(revoked).catch(() => null), null);

    const raced = path.join(temporaryDirectory, "raced.bin");
    await expectCode(() => saveDownloadExclusively(download(), raced, environment, async (publish) => {
      await publish();
      const replacement = path.join(temporaryDirectory, "replacement.bin");
      await writeFile(replacement, "replacement", { mode: 0o600 });
      await rename(replacement, raced);
      throw new Error("forced post-link failure");
    }), "TELEGRAM_WEB_DOWNLOAD_PUBLICATION_REPAIR_REQUIRED");
    assert.equal(await readFile(raced, "utf8"), "replacement");
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test("download transfer deadline cancels create-stream and iterator stalls without residue", async (context) => {
  if (process.platform === "win32") {
    context.skip("private POSIX home fixture; Windows DACL behavior belongs to its qualification lane");
    return;
  }
  const temporaryDirectory = await realpath(await mkdtemp(path.join(os.homedir(), ".telegram-web-download-stall-")));
  try {
    const environment = environmentFor(temporaryDirectory);
    const cases = [
      {
        name: "create-stream",
        createReadStream: () => new Promise(() => undefined),
      },
      {
        name: "iterator-next",
        createReadStream: async () => new Readable({ read() {} }),
      },
    ];
    for (const fixture of cases) {
      let cancellations = 0;
      const output = path.join(temporaryDirectory, `${fixture.name}.bin`);
      await expectCode(() => saveDownloadExclusively({
        createReadStream: fixture.createReadStream,
        cancel: async () => { cancellations += 1; },
      }, output, environment, undefined, { timeoutMs: 1_000 }), "TELEGRAM_WEB_DOWNLOAD_TIMEOUT");
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(cancellations, 1);
      assert.equal(await lstat(output).catch(() => null), null);
      assert.deepEqual((await readdir(temporaryDirectory)).filter((name) => name.includes(".download")), []);
    }
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test("download revoke guard cancels a stalled stream without masking consent error", async (context) => {
  if (process.platform === "win32") {
    context.skip("private POSIX home fixture; Windows DACL behavior belongs to its qualification lane");
    return;
  }
  const temporaryDirectory = await realpath(await mkdtemp(path.join(os.homedir(), ".telegram-web-download-revoke-")));
  try {
    const environment = environmentFor(temporaryDirectory);
    const output = path.join(temporaryDirectory, "revoked-stall.bin");
    let cancellations = 0;
    let guards = 0;
    await expectCode(() => saveDownloadExclusively({
      createReadStream: async () => new Readable({ read() {} }),
      cancel: async () => { cancellations += 1; },
    }, output, environment, undefined, {
      timeoutMs: 3_000,
      consentGuard: async () => {
        guards += 1;
        if (guards >= 2) throw new TelegramWebRuntimeError("TELEGRAM_WEB_CONSENT_REQUIRED", "revoked");
      },
    }), "TELEGRAM_WEB_CONSENT_REQUIRED");
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(cancellations, 1);
    assert.equal(await lstat(output).catch(() => null), null);
    assert.deepEqual((await readdir(temporaryDirectory)).filter((name) => name.includes(".download")), []);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test("send postcondition waits for a final Saved Messages model without requiring pFlags.out", async () => {
  const peerId = "123";
  const messageId = "7";
  // Web K can keep visible-derived automatic entities only in `totalEntities`
  // while the authoritative `entities` array remains empty. Exercise that
  // exact representation through the integrated send verifier so a future
  // equality shortcut cannot silently regress the call site.
  const sentText = "@alice";
  const automaticMention = { _: "messageEntityMention", offset: 0, length: sentText.length };
  let domReads = 0;
  let modelReads = 0;
  let domFinal = false;
  const bubble = {
    classList: {
      contains: (name) => name === "is-out"
        || (name === "is-outgoing" && !domFinal),
    },
    getAttribute: (name) => ({
      "data-mid": messageId,
      "data-peer-id": peerId,
      "data-timestamp": "1",
      "data-reply-to-mid": null,
    })[name] ?? null,
    querySelector: (selector) => selector === ".message" ? { innerText: sentText } : null,
    querySelectorAll: () => [],
  };
  const parserSurface = makePinnedEntityParserSurface(() => {
      domReads += 1;
      if (domReads >= 3) domFinal = true;
      return [bubble];
  });
  const getMessageByPeer = () => {
    modelReads += 1;
    return {
      _: "message",
      peerId: 123,
      mid: 7,
      fromId: 123,
      message: sentText,
      saved_peer_id: { _: "peerUser", user_id: 123 },
      entities: [],
      totalEntities: [automaticMention],
      ...(modelReads < 3 ? { pending: true, random_id: "temporary" } : {}),
    };
  };
  await withBrowserGlobals({
    document: parserSurface.document,
    appImManager: { chat: {
      peerId: 123,
      type: "chat",
      isMonoforum: false,
      isOutMessage: (candidate) => candidate?.fromId === 123,
      input: parserSurface.input,
    } },
    rootScope: {
      myId: 123,
      managers: {
        appMessagesManager: { getMessageByPeer },
        appPeersManager: {},
      },
    },
  }, async () => {
    const sent = await __testing.waitForVerifiedOutgoing(makeModelPage({ peerId }), {
      message: sentText,
      beforeIds: [],
      timeoutMs: 100,
      expectedFiles: [],
      expectedPeerId: peerId,
    });
    assert.equal(sent.messageId, messageId);
    assert.equal(sent.text, sentText);
    assert.equal(modelReads >= 3, true);
    assert.equal(domFinal, true);
  });
});

test("edit postcondition polls the exact model until delayed text arrives", async () => {
  const peerId = "123";
  const messageId = "7";
  // Keep this integrated edit fixture asymmetric for the same reason as the
  // send fixture above: both arrays are valid independently against the exact
  // approved text and are not required to be byte-for-byte equal.
  const editedText = "@alice";
  const automaticMention = { _: "messageEntityMention", offset: 0, length: editedText.length };
  const bubble = {
    classList: { contains: (name) => name === "is-out" },
    getAttribute: (name) => ({ "data-mid": messageId, "data-peer-id": peerId, "data-timestamp": "1" })[name] || null,
    querySelector: (selector) => selector === ".message" ? { innerText: editedText } : null,
    querySelectorAll: () => [],
  };
  let reads = 0;
  const parserSurface = makePinnedEntityParserSurface(() => [bubble]);
  const model = () => ({
    _: "message",
    peerId: 123,
    mid: 7,
    fromId: 123,
    message: ++reads >= 3 ? editedText : "old",
    saved_peer_id: { _: "peerUser", user_id: 123 },
    entities: [],
    totalEntities: [automaticMention],
  });
  await withBrowserGlobals({
    document: parserSurface.document,
    appImManager: { chat: {
      peerId: 123,
      type: "chat",
      isMonoforum: false,
      // Saved Messages is outgoing according to Web K's authoritative helper
      // even when the final model has no pFlags.out field.
      isOutMessage: (candidate) => candidate?.fromId === 123,
      input: parserSurface.input,
    } },
    rootScope: { myId: 123, managers: { appMessagesManager: { getMessageByPeer: model } } },
  }, async () => {
    const updated = await __testing.waitForVerifiedEdit(makeModelPage({ peerId }), {
      expectedPeerId: peerId,
      messageId,
      message: editedText,
      timeoutMs: 100,
    });
    assert.equal(updated.text, editedText);
    assert.equal(reads >= 3, true);
  });
});

test("edit postcondition rejects permanent old text and wrong peer/id", async () => {
  const bubble = {
    classList: { contains: (name) => name === "is-out" },
    getAttribute: (name) => ({ "data-mid": "7", "data-peer-id": "123" })[name] || null,
    querySelector: () => null,
    querySelectorAll: () => [],
  };
  await withBrowserGlobals({
    document: { querySelectorAll: () => [bubble] },
    appImManager: { chat: {
      peerId: 123,
      type: "chat",
      isMonoforum: false,
      isOutMessage: () => true,
    } },
    rootScope: { managers: { appMessagesManager: { getMessageByPeer: () => ({
      _: "message", peerId: 999, mid: 7, fromId: 123, message: "old",
    }) } } },
  }, async () => {
    await assert.rejects(() => __testing.waitForVerifiedEdit(makeModelPage({ peerId: "123", waitPolls: 3 }), {
      expectedPeerId: "123",
      messageId: "7",
      message: "edited",
      timeoutMs: 20,
    }), /timeout/u);
  });
});

test("plain edit source guard rejects every complex authoritative model field before a submit click", async () => {
  const peerId = "123";
  const messageId = "7";
  const baseModel = { _: "message", peerId: 123, mid: 7, message: "plain" };
  let model = baseModel;
  let decisiveClicks = 0;
  const globals = decisiveBrowserGlobals(peerId, "987654321");
  await withBrowserGlobals({
    ...globals,
    appImManager: { chat: {
      ...globals.appImManager.chat,
      isOutMessage: () => true,
    } },
    rootScope: {
      ...globals.rootScope,
      managers: { appMessagesManager: { getMessageByPeer: () => model } },
    },
  }, async () => {
    assert.equal(await __testing.assertPlainEditableSourceModel(
      makeModelPage({ peerId }), peerId, messageId,
    ), true);
    const automaticMention = { _: "messageEntityMention", offset: 0, length: 6 };
    model = {
      ...baseModel,
      message: "@alice",
      entities: [automaticMention],
      totalEntities: [automaticMention],
    };
    assert.equal(await __testing.assertPlainEditableSourceModel(
      makeModelPage({ peerId }), peerId, messageId,
    ), true);
    model = {
      ...baseModel,
      flags: 1,
      flags2: 0,
      pFlags: { out: true },
      entities: [],
      totalEntities: [],
      storageKey: "123_7",
    };
    assert.equal(await __testing.assertPlainEditableSourceModel(
      makeModelPage({ peerId }), peerId, messageId,
    ), true);
    const unsafeVariants = [
      { pFlags: { is_outgoing: true } },
      { pending: false },
      { error: false },
      { random_id: 1 },
      { send: false },
      { media: { _: "messageMediaPhoto" } },
      { grouped_id: 1 },
      { fwd_from: { from_id: 1 } },
      { via_bot_id: 1 },
      { via_business_bot_id: 1 },
      { effect: { id: 1 } },
      { effect_id: 1 },
      { paid_message_stars: 1 },
      { schedule_date: 1 },
      { pFlags: { from_scheduled: true } },
      { reply_markup: { _: "replyInlineMarkup" } },
      { factcheck: { text: "fact" } },
      { suggested_post: { price: 1 } },
      { rich_message: { text: "rich" } },
      { quick_reply_shortcut_id: 1 },
      { guestchat_via_from: { _: "peerUser", user_id: 1 } },
      { sponsoredMessage: { random_id: 1 } },
      { schedule_repeat_period: 60 },
      { paid_suggested_post_stars: true },
      { paid_suggested_post_ton: true },
      { saved_peer_id: { _: "peerUser", user_id: 1 } },
      { post_author: "channel" },
      { replies: { replies: 1 } },
      { restriction_reason: [{ text: "restricted" }] },
      { ttl_period: 60 },
      { report_delivery_until_date: 1 },
      { promise: Promise.resolve() },
      { uploadingFileName: "file.bin" },
      { repayRequest: { amount: 1 } },
      { clear_history: true },
      { totalEntities: [{ _: "messageEntityBold", offset: 0, length: 1 }] },
      { savedFrom: { peerId: 1 } },
      { viaBotId: 1 },
      { fwdFromId: 1 },
      { entities: [{ _: "messageEntityBold", offset: 0, length: 1 }] },
      { reply_to: { _: "messageReplyHeader", reply_to_msg_id: 1 } },
      { reply_to_mid: 1 },
      { pFlags: { silent: true } },
      { pFlags: { post: true } },
      { pFlags: { noforwards: true } },
      { pFlags: { invert_media: true } },
      { pFlags: { offline: true } },
      { pFlags: { video_processing_pending: true } },
      { pFlags: { paid_suggested_post_stars: true } },
      { pFlags: { paid_suggested_post_ton: true } },
      { pFlags: { is_scheduled: true } },
      { pFlags: { sponsored: true } },
      { pFlags: { local: true } },
      { pFlags: { currentlyTyping: true } },
      { pFlags: { fakeForSavedMusic: true } },
      { future_complex_field: { enabled: true } },
      { pFlags: { future_complex_flag: true } },
    ];
    for (const extra of unsafeVariants) {
      model = { ...baseModel, ...extra };
      await expectCode(
        () => __testing.assertPlainEditableSourceModel(makeModelPage({ peerId }), peerId, messageId),
        "TELEGRAM_WEB_UNSUPPORTED_OPERATION",
      );
    }
    // The eligibility proof has no control reference and therefore cannot
    // dispatch the edit; runEditCommand invokes it again inside the lease.
    assert.equal(decisiveClicks, 0);
  });

  const selfPeerId = "987654321";
  const selfGlobals = decisiveBrowserGlobals(selfPeerId, selfPeerId);
  let selfModel = {
    _: "message",
    peerId: Number(selfPeerId),
    mid: 7,
    message: "plain saved text",
    saved_peer_id: { _: "peerUser", user_id: Number(selfPeerId) },
    totalEntities: [],
  };
  await withBrowserGlobals({
    ...selfGlobals,
    appImManager: { chat: {
      ...selfGlobals.appImManager.chat,
      isOutMessage: () => true,
    } },
    rootScope: {
      ...selfGlobals.rootScope,
      managers: { appMessagesManager: { getMessageByPeer: () => selfModel } },
    },
  }, async () => {
    assert.equal(await __testing.assertPlainEditableSourceModel(
      makeModelPage({ peerId: selfPeerId }), selfPeerId, messageId,
    ), true);
    for (const unsafeSaved of [
      { saved_peer_id: { _: "peerUser", user_id: 1 } },
      { saved_peer_id: { _: "peerChat", chat_id: Number(selfPeerId) } },
      {
        saved_peer_id: { _: "peerUser", user_id: Number(selfPeerId) },
        fwd_from: { saved_from_peer: { _: "peerUser", user_id: 1 } },
      },
    ]) {
      selfModel = { ...selfModel, ...unsafeSaved };
      await expectCode(
        () => __testing.assertPlainEditableSourceModel(makeModelPage({ peerId: selfPeerId }), selfPeerId, messageId),
        "TELEGRAM_WEB_UNSUPPORTED_OPERATION",
      );
    }
  });
});

test("archive verification requires authoritative dialog folder state, not a matching search row", async () => {
  const peerId = "123";
  const runFolder = (folderId, archived, waitPolls = 4) => withBrowserGlobals({
    // A matching UI row deliberately exists in every case; it is not proof.
    document: { querySelectorAll: () => [{ getAttribute: () => peerId }] },
    rootScope: { managers: {
      appMessagesManager: {
        getDialogOnly: async () => ({ peerId: 123, folder_id: folderId, unread_count: 0, pFlags: {} }),
        isDialogUnread: () => false,
      },
      appNotificationsManager: {
        isPeerLocalMuted: () => false,
        getPeerLocalSettings: () => ({}),
      },
    } },
  }, () => __testing.waitForVerifiedArchiveState(
    makeModelPage({ peerId, waitPolls }),
    peerId,
    archived,
    50,
  ));
  await runFolder(1, true);
  await runFolder(0, false);
  await runFolder(undefined, false);
  await expectCode(() => runFolder(0, true, 2), "TELEGRAM_WEB_MUTATION_OUTCOME_AMBIGUOUS");
  await expectCode(() => withBrowserGlobals({
    rootScope: { managers: {
      appMessagesManager: {
        getDialogOnly: async () => ({ peerId: 999, folder_id: 1, unread_count: 0, pFlags: {} }),
        isDialogUnread: () => false,
      },
      appNotificationsManager: {
        isPeerLocalMuted: () => false,
        getPeerLocalSettings: () => ({}),
      },
    } },
  }, () => __testing.waitForVerifiedArchiveState(makeModelPage({ peerId, waitPolls: 2 }), peerId, true, 20)), "TELEGRAM_WEB_MUTATION_OUTCOME_AMBIGUOUS");
});

test("authoritative dialog state rejects malformed present unread counts", async () => {
  const peerId = "123";
  const run = (unreadCount, unread = false, waitPolls = 3, dialogPeerId = 123) => withBrowserGlobals({
    rootScope: { managers: {
      appMessagesManager: {
        getDialogOnly: async () => ({ peerId: dialogPeerId, unread_count: unreadCount, pFlags: {} }),
        isDialogUnread: () => unread,
      },
      appNotificationsManager: {
        isPeerLocalMuted: () => false,
        getPeerLocalSettings: () => ({}),
      },
    } },
  }, () => __testing.readAuthoritativeDialogState(makeModelPage({ peerId, waitPolls }), peerId, 20));

  assert.equal((await run(undefined, false)).unreadCount, 0);
  assert.equal((await run(null, true)).unreadCount, 1);
  for (const malformed of ["2", -1, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
    await expectCode(() => run(malformed), "TELEGRAM_WEB_UI_UNSUPPORTED");
  }
  await expectCode(() => run(0, false, 3, "123"), "TELEGRAM_WEB_UI_UNSUPPORTED");
});

test("logout account-count proof rejects rejected, string and unsafe secondary account records", async () => {
  const run = (records) => withBrowserGlobals({
    AccountController: {
      get: async (slot) => {
        const value = records[slot - 1];
        if (value instanceof Error) throw value;
        return value;
      },
    },
  }, () => __testing.readConfiguredAccountCount({ evaluate: async (callback) => callback() }));

  assert.deepEqual(await run([{ userId: 123 }, {}, {}, {}]), {
    known: true, count: 1, activeIdentityPresent: false,
  });
  assert.deepEqual(await run([{ userId: 123 }, { userId: 456 }, {}, {}]), {
    known: true, count: 2, activeIdentityPresent: false,
  });
  for (const malformed of [
    [{ userId: 123 }, new Error("unavailable"), {}, {}],
    [{ userId: 123 }, { userId: "456" }, {}, {}],
    [{ userId: 123 }, { userId: 0 }, {}, {}],
    [{ userId: 123 }, { userId: Number.MAX_SAFE_INTEGER + 1 }, {}, {}],
    [{ userId: 123 }, { unexpected: true }, {}, {}],
  ]) assert.deepEqual(await run(malformed), {
    known: false, count: 0, activeIdentityPresent: null,
  });
});

test("restored extra pages are closed and persistent teardown is verified", async () => {
  const extra = {
    closed: false,
    close: async () => { extra.closed = true; },
    isClosed: () => extra.closed,
  };
  const primary = {};
  const context = { pages: () => [primary, extra] };
  assert.equal(await __testing.prepareSinglePersistentPage(context), primary);
  assert.equal(extra.closed, true);

  let connected = true;
  let closeCalls = 0;
  const closeContext = {
    browser: () => ({ isConnected: () => connected }),
    close: async () => { closeCalls += 1; connected = false; },
  };
  await __testing.closePersistentContextVerified(closeContext, {
    browserProcess: { pid: 2_000_000_000, detached: true, exitCode: 0, signalCode: null },
  });
  assert.equal(closeCalls, 1);
});

test("first-installed page guard catches a tab created during awaited route setup", async () => {
  const context = new EventEmitter();
  const primary = { isClosed: () => false };
  const unexpected = { isClosed: () => false };
  const pages = [primary];
  context.pages = () => [...pages];
  const seen = [];
  assert.equal(await __testing.prepareSinglePersistentPage(context, {
    onUnexpectedPage: (page) => seen.push(page),
  }), primary);
  // Simulate the exact withTelegramBrowser gap while context.route() is
  // awaited. The helper's first listener must remain active for the lifetime.
  pages.push(unexpected);
  context.emit("page", unexpected);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(seen, [unexpected]);
});

test("persistent teardown without an exact captured process preserves the profile lock", async () => {
  let connected = false;
  const context = {
    browser: () => ({ isConnected: () => connected }),
    close: async () => { connected = false; },
  };
  await expectCode(
    () => __testing.closePersistentContextVerified(context),
    "TELEGRAM_WEB_PROFILE_TEARDOWN_UNVERIFIED",
  );
});

test("captured detached browser group is TERM/KILL fenced after a hung provider evaluation", async (context) => {
  if (process.platform === "win32") {
    context.skip("POSIX process-group regression; Windows uses trusted taskkill /T /F");
    return;
  }
  const temporaryDirectory = await realpath(await mkdtemp(path.join(os.homedir(), ".telegram-web-browser-process-")));
  let browserProcess = null;
  try {
    const executable = path.join(temporaryDirectory, "fake-chrome");
    const profile = path.join(temporaryDirectory, "profile");
    await writeFile(executable, "#!/bin/sh\nwhile true; do /bin/sleep 10; done\n", { mode: 0o700 });
    await chmod(executable, 0o700);
    await mkdir(profile, { mode: 0o700 });
    const localRequire = createRequire(import.meta.url);
    let connected = true;
    const browser = { isConnected: () => connected };
    const contextObject = {
      browser: () => browser,
      close: () => new Promise(() => undefined),
    };
    const chromium = {
      launchPersistentContext: async (userDataDirectory, launchOptions) => {
        const child = localRequire("node:child_process").spawn(
          launchOptions.executablePath,
          [`--user-data-dir=${userDataDirectory}`],
          { detached: true, stdio: "ignore" },
        );
        child.once("close", () => { connected = false; });
        return contextObject;
      },
    };
    ({ browserProcess } = await __testing.launchPersistentContextWithProcess({
      chromium,
      userDataDirectory: profile,
      launchOptions: { executablePath: executable },
    }));
    assert.equal(Number.isSafeInteger(browserProcess.pid), true);
    assert.equal(browserProcess.detached, true);
    process.kill(browserProcess.pid, 0);

    const lifecycle = __testing.createCommandLifecycle({ command: "edit", timeoutMs: 100 });
    lifecycle.markDecisive("forced provider evaluation");
    let termination = null;
    const terminationSignals = [];
    lifecycle.setAbortHandler(() => {
      termination ||= __testing.closePersistentContextVerified(contextObject, {
        browserProcess,
        closeTimeoutMs: 50,
        terminateBrowserProcess: async (captured, force) => {
          terminationSignals.push(force ? "KILL" : "TERM");
          // Force the stronger branch deterministically: the first signal is
          // intentionally ineffective, while KILL targets the exact PGID.
          if (force) process.kill(-captured.pid, "SIGKILL");
        },
      });
      return termination;
    });
    const boundedPage = __testing.boundedPageProxy({
      evaluate: () => new Promise(() => undefined),
    }, lifecycle, { timeoutMs: 100 });
    await expectCode(
      () => boundedPage.evaluate(() => true),
      "TELEGRAM_WEB_MUTATION_OUTCOME_AMBIGUOUS",
    );
    while (!termination) await new Promise((resolve) => setImmediate(resolve));
    await termination;
    lifecycle.stop();
    assert.deepEqual(terminationSignals, ["TERM", "KILL"]);
    assert.equal(connected, false);
    assert.equal(__testing.capturedBrowserProcessGroupAlive(browserProcess), false);
  } finally {
    if (browserProcess && __testing.capturedBrowserProcessGroupAlive(browserProcess)) {
      try { process.kill(-browserProcess.pid, "SIGKILL"); } catch { /* already gone */ }
    }
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test("navigation violations become ambiguous only after decisive dispatch", () => {
  const before = __testing.blockedNavigationError(false);
  assert.equal(before.code, "TELEGRAM_WEB_EXTERNAL_NAVIGATION_BLOCKED");
  const after = __testing.blockedNavigationError(true);
  assert.equal(after.code, "TELEGRAM_WEB_MUTATION_OUTCOME_AMBIGUOUS");
  assert.equal(after.details.safeToRetry, false);
  assert.match(after.message, /do not retry automatically or through telegram-mtproto/iu);
});

test("parent exit never substitutes for detached descendant process-group proof", async (context) => {
  if (process.platform === "win32") {
    context.skip("POSIX process-group regression");
    return;
  }
  const localRequire = createRequire(import.meta.url);
  const leaderSource = [
    "const { spawn } = require('node:child_process');",
    "const descendant = spawn(process.execPath, ['-e', `process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);`], { stdio: 'ignore' });",
    "descendant.unref();",
    "setTimeout(() => process.exit(0), 100);",
  ].join("\n");
  const child = localRequire("node:child_process").spawn(
    process.execPath,
    ["-e", leaderSource],
    { detached: true, stdio: "ignore" },
  );
  const browserProcess = {
    pid: child.pid,
    detached: true,
    get exitCode() { return child.exitCode; },
    get signalCode() { return child.signalCode; },
  };
  try {
    await new Promise((resolve) => child.once("exit", resolve));
    assert.notEqual(browserProcess.exitCode, null);
    assert.equal(__testing.capturedBrowserProcessGroupAlive(browserProcess), true);
    const signals = [];
    await __testing.closePersistentContextVerified({
      browser: () => ({ isConnected: () => false }),
      close: async () => undefined,
    }, {
      browserProcess,
      closeTimeoutMs: 50,
      terminateBrowserProcess: async (captured, force) => {
        signals.push(force ? "KILL" : "TERM");
        process.kill(-captured.pid, force ? "SIGKILL" : "SIGTERM");
      },
    });
    assert.deepEqual(signals, ["TERM", "KILL"]);
    assert.equal(__testing.capturedBrowserProcessGroupAlive(browserProcess), false);
  } finally {
    if (__testing.capturedBrowserProcessGroupAlive(browserProcess)) {
      try { process.kill(-browserProcess.pid, "SIGKILL"); } catch { /* already gone */ }
    }
  }
});

test("awaited browser, consent, lifecycle and transfer deadlines stay referenced until cleanup", async () => {
  const source = await readFile(runtimePath, "utf8");
  // Node 22 may have no referenced provider handle while an awaited promise or
  // async iterator is stalled.  Only the periodic consent recheck may be
  // unreferenced because the independently referenced absolute transfer timer
  // still owns liveness and performs cancellation/cleanup.
  assert.doesNotMatch(source, /\b(?:absoluteTimer|globalTimer|timer)\.unref\?\.\(\);/u);
  assert.deepEqual(
    source.match(/\b[A-Za-z_$][\w$]*\.unref\?\.\(\);/gu) || [],
    ["consentTimer.unref?.();"],
  );
  assert.match(source, /absoluteTimer = setTimeout[\s\S]*?consentTimer = setInterval[\s\S]*?consentTimer\.unref\?\.\(\);/u);
});

test("actual pinned Playwright renderer hang releases the profile lock only after exact Chrome exit proof", {
  skip: process.env.TELEGRAM_WEB_REAL_BROWSER_TEST !== "1",
}, async () => {
  const temporaryDirectory = await realpath(await mkdtemp(path.join(os.homedir(), ".telegram-web-real-browser-")));
  let browserProcess = null;
  try {
    const environment = environmentFor(temporaryDirectory);
    const identity = identityFor(environment);
    await bootstrapBrowserRuntime(identity, environment);
    const browserExecutable = await __testing.findChromeExecutable(environment);
    assert.equal(typeof browserExecutable, "string");
    const locations = runtimeLocations(identity, environment);
    await __testing.ensurePrivateTree(environment.TRELIO_CONFIG_HOME, locations.profileDirectory, environment);
    await __testing.ensurePrivateTree(environment.TRELIO_CONFIG_HOME, locations.downloadStagingDirectory, environment);
    const { chromium } = await __testing.loadPlaywright(identity, environment);
    let capturedError = null;
    await assert.rejects(() => __testing.acquireProfileLock(identity, async () => {
      const launched = await __testing.launchPersistentContextWithProcess({
        chromium,
        userDataDirectory: locations.profileDirectory,
        launchOptions: buildChromiumLaunchOptions({
          executablePath: browserExecutable,
          headless: true,
          downloadsPath: locations.downloadStagingDirectory,
          timeoutMs: 10_000,
          environment,
        }),
      });
      const { context: browserContext } = launched;
      browserProcess = launched.browserProcess;
      const browser = browserContext.browser();
      assert.equal(browser.isConnected(), true);
      process.kill(browserProcess.pid, 0);
      const page = browserContext.pages()[0] || await browserContext.newPage();
      const lifecycle = __testing.createCommandLifecycle({ command: "edit", timeoutMs: 250 });
      lifecycle.markDecisive("real pinned renderer evaluation");
      let termination = null;
      lifecycle.setAbortHandler(() => {
        termination ||= __testing.closePersistentContextVerified({
          browser: () => browser,
          // Force the verified OS process path instead of relying on a
          // graceful BrowserContext.close while the renderer is wedged.
          close: () => new Promise(() => undefined),
        }, {
          browserProcess,
          closeTimeoutMs: 100,
          environment,
        });
        return termination;
      });
      const boundedPage = __testing.boundedPageProxy(page, lifecycle, { timeoutMs: 250 });
      try {
        await boundedPage.evaluate(() => new Promise(() => undefined));
      } catch (error) {
        capturedError = error;
      }
      while (!termination) await new Promise((resolve) => setImmediate(resolve));
      await termination;
      lifecycle.stop();
      assert.equal(browser.isConnected(), false);
      assert.equal(__testing.capturedBrowserProcessGroupAlive(browserProcess), false);
      throw capturedError;
    }, environment), (error) => error?.code === "TELEGRAM_WEB_MUTATION_OUTCOME_AMBIGUOUS");
    assert.equal(capturedError?.details?.safeToRetry, false);
    assert.equal(await lstat(locations.lockFile).catch(() => null), null);
  } finally {
    if (browserProcess && __testing.capturedBrowserProcessGroupAlive(browserProcess)) {
      try { process.kill(-browserProcess.pid, "SIGKILL"); } catch { /* already gone */ }
    }
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test("source contains exact security contracts for headless watch, logout, Windows and default host-cache layout", async () => {
  const source = await readFile(runtimePath, "utf8");
  const skill = await readFile(path.join(skillDirectory, "SKILL.md"), "utf8");
  const agentMetadata = await readFile(path.join(skillDirectory, "agents", "openai.yaml"), "utf8");
  const integrationContract = await readFile(integrationContractPath, "utf8");
  assert.match(source, /headlessAfterLogin: true/u);
  assert.match(source, /Long-running in-process Telegram Web watch loops are unsupported/u);
  assert.match(source, /TELEGRAM_WEB_USER_ACTION_REQUIRED/u);
  assert.match(source, /performedBy: "account-owner-in-headed-telegram-web"/u);
  assert.match(source, /cwd: path\.dirname\(executable\)/u);
  assert.match(source, /path\.parse\(systemRoot\)\.root/u);
  assert.match(source, /workspace-bridge", "skill-runtimes/u);
  assert.match(source, /runtimeSearchResultPersistence: "none"/u);
  assert.match(source, /runtimeSearchIndexing: "none"/u);
  assert.match(source, /providerBrowserProfilePersistence: "Telegram Web may retain its ordinary authenticated session, cache, and message data/u);
  assert.match(source, /\["login", "logout", "inspect"\]\.includes\(options\.command\)/u);
  assert.match(source, /recoveryCommand:[\s\S]*inspect --account/u);
  assert.match(source, /MAX_LINK_ENTITIES_PER_MESSAGE = 32/u);
  assert.match(source, /MAX_REPLY_CONTEXT_CHARS = 2_000/u);
  assert.match(source, /MAX_ATTACHMENT_METADATA_PER_MESSAGE = 1/u);
  assert.doesNotMatch(source, /document\.body\??\.innerText/u);
  assert.match(source, /const protectedCredentialSurface = passwordInput/u);
  assert.match(source, /LOGIN_AUTH_STABILITY_MS = 1_000/u);
  assert.match(source, /loginOptions\.commandLifecycle\?\.beginOwnerHandoff/u);
  assert.match(source, /inspectOptions\.commandLifecycle\?\.beginOwnerHandoff/u);
  assert.match(source, /logoutOptions\.commandLifecycle\?\.beginOwnerHandoff/u);
  assert.match(source, /providerState\?\.known === true[\s\S]*providerState\.count === 0[\s\S]*providerState\.activeIdentityPresent === false/u);
  assert.match(source, /requireVerifiedLoggedOutProviderState/u);
  assert.match(source, /DISPLAY_LABEL_UNSAFE_PATTERN_SOURCE/u);
  assert.doesNotMatch(source, /rm\(outputPath/u);
  assert.match(source, /args: \["--lang=en-US"\]/u);
  assert.match(skill, /captionless document sent to Saved Messages/u);
  assert.match(skill, /exact output parent must belong[\s\S]*ancestors may be current-user- or[\s\S]*root-owned/u);
  assert.match(skill, /native skill-invocation syntax/u);
  assert.match(skill, /MUST NOT re-prompt for consent for each non-self chat/u);
  assert.match(skill, /Ask for consent again only when the annual grant is/u);
  assert.match(skill, /exact opaque PeerId as an inline[\s\S]*code literal, and `accountSlot`/u);
  assert.match(agentMetadata, /default_prompt: "Use \$telegram-web\b/u);
  assert.match(integrationContract, /captionless document в собственные Saved Messages/u);
  assert.match(integrationContract, /opaque `peerId` допустим только как[\s\S]*routing\/disambiguation/u);
  assert.match(integrationContract, /canonical `accountSlot` 1–4/u);
  assert.match(integrationContract, /Именно в MTProto export[\s\S]*структурированные ссылки включаются opt-in/u);
  assert.match(integrationContract, /Telegram Web[\s\S]*всегда возвращают bounded `linkEntities`/u);
  assert.match(integrationContract, /display title[\s\S]*opaque PeerId как отдельный code literal/u);
});
