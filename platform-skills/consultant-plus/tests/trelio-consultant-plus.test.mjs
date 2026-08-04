import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const runtimePath = path.resolve(testDirectory, "../scripts/trelio-consultant-plus.mjs");
const companyId = "11111111-1111-4111-8111-111111111111";
const memberId = "22222222-2222-4222-8222-222222222222";

const readInstructionBundle = async () => {
  const skillDirectory = path.resolve(testDirectory, "..");
  return readFile(path.join(skillDirectory, "SKILL.md"), "utf8");
};

const runRuntime = async (configHome, args, extraEnvironment = {}) => {
  const result = await execFileAsync(process.execPath, [runtimePath, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      TRELIO_CONFIG_HOME: configHome,
      TRELIO_SKILL_ID: "consultant-plus",
      TRELIO_SKILL_COMPANY_ID: companyId,
      TRELIO_SKILL_MEMBER_ID: memberId,
      ...extraEnvironment,
    },
  });
  return JSON.parse(result.stdout);
};

test("runtime persists browser access state without credentials", async () => {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "trelio-consultant-plus-"));
  const configHome = path.join(temporaryDirectory, "config");

  try {
    assert.deepEqual(await runRuntime(configHome, ["status"]), {
      ok: true,
      accessState: "unknown",
      browserPreference: null,
      configured: false,
      canUseConsultantPlus: false,
      lastVerifiedAt: null,
      updatedAt: null,
      storesCredentials: false,
    });

    const connected = await runRuntime(configHome, [
      "set-connected",
      "--browser",
      "codex-chrome",
    ]);
    assert.equal(connected.accessState, "connected");
    assert.equal(connected.browserPreference, "codex-chrome");
    assert.equal(connected.canUseConsultantPlus, true);
    assert.match(connected.lastVerifiedAt, /^\d{4}-\d{2}-\d{2}T/u);

    const stateFile = path.join(
      configHome,
      "integrations",
      "consultant-plus",
      companyId,
      memberId,
      "browser",
      "state",
      "access.json",
    );
    const stored = JSON.parse(await readFile(stateFile, "utf8"));
    assert.equal(stored.accessState, "connected");
    assert.equal(stored.browserPreference, "codex-chrome");
    assert.equal(Object.hasOwn(stored, "cookie"), false);
    assert.equal(Object.hasOwn(stored, "password"), false);

    if (process.platform !== "win32") {
      assert.equal((await stat(path.dirname(stateFile))).mode & 0o777, 0o700);
      assert.equal((await stat(stateFile)).mode & 0o777, 0o600);
    }

    const reconnect = await runRuntime(configHome, ["set-needs-reconnect"]);
    assert.equal(reconnect.accessState, "needs_reconnect");
    assert.equal(reconnect.browserPreference, "codex-chrome");
    assert.equal(reconnect.lastVerifiedAt, null);

    const noAccess = await runRuntime(configHome, ["set-no-access"]);
    assert.equal(noAccess.accessState, "no_access");
    assert.equal(noAccess.browserPreference, null);

    const reset = await runRuntime(configHome, ["reset", "--confirm"]);
    assert.equal(reset.accessState, "unknown");
    assert.equal(reset.configured, false);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test("runtime rejects invalid identity, browser and symlinked private paths", async () => {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "trelio-consultant-plus-safe-"));
  const configHome = path.join(temporaryDirectory, "config");

  try {
    await assert.rejects(
      runRuntime(configHome, ["status"], { TRELIO_SKILL_MEMBER_ID: "not-a-uuid" }),
      /TRELIO_SKILL_MEMBER_ID/u,
    );
    await assert.rejects(
      runRuntime(configHome, ["set-connected", "--browser", "safari"]),
      /поддерживаемый --browser/u,
    );

    await mkdir(configHome, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") await chmod(configHome, 0o700);
    const externalDirectory = path.join(temporaryDirectory, "external");
    await mkdir(externalDirectory);
    await symlink(externalDirectory, path.join(configHome, "integrations"), "dir");

    await assert.rejects(
      runRuntime(configHome, ["set-no-access"]),
      /Небезопасный путь локального состояния/u,
    );
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test("skill keeps onboarding, browser handoff, export and fallback decisions explicit", async () => {
  const instructions = await readInstructionBundle();

  assert.match(instructions, /ask once whether the user wants this skill and has access/u);
  assert.match(instructions, /`no_access`: do not ask again/u);
  assert.match(instructions, /`unavailable_on_surface`.*do not\s+overwrite/su);
  assert.match(instructions, /Codex in-app Browser/u);
  assert.match(instructions, /Claude in Chrome/u);
  assert.match(instructions, /visible browser surface as a temporary handoff/u);
  assert.match(instructions, /hide or collapse the\s+in-app Browser side panel without closing its tab or session/su);
  assert.match(instructions, /Continue routine search, navigation, bounded DOM reading, export and download\s+verification in the background/su);
  assert.match(instructions, /Reopen it only when the user must act/u);
  assert.match(instructions, /without\s+asking for an extra confirmation/su);
  assert.match(instructions, /Prefer DOCX/u);
  assert.match(instructions, /Prefer PDF for forms/u);
  assert.match(instructions, /Unicode text/u);
  assert.match(instructions, /Do not bulk\s+export/su);
  assert.match(instructions, /Never request, receive, store\s+or inspect a ConsultantPlus login/su);
  assert.match(instructions, /independent legal source/u);
  assert.match(instructions, /Never enter the same protected ConsultantPlus system/u);
});
