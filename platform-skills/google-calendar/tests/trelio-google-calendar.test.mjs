import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
  CalendarRuntimeError,
  buildCreateResource,
  buildUpdatePatch,
  accountRoot,
  connectionRoot,
  loadPolicy,
  loadRuntimeContext,
  normalizeAccountAlias,
  normalizeConnectionConfig,
  normalizePurposeDescription,
  normalizePurposeLabel,
  parseArgs,
  requiresInvitationUpdates,
  run,
  safeGoogleError,
  selectRuntimeAccount,
  validateOAuthCallbackRequest,
} from "../scripts/trelio-google-calendar.mjs";

const COMPANY_ID = "11111111-1111-4111-8111-111111111111";
const MEMBER_ID = "22222222-2222-4222-8222-222222222222";
const CONNECTION_ID = "33333333-3333-4333-8333-333333333333";
const CLIENT_ID = "123456789-test.apps.googleusercontent.com";
const CLIENT_SECRET = "test-desktop-client-secret";

function runtimeEnvironment(configHome) {
  return {
    ...process.env,
    TRELIO_CONFIG_HOME: configHome,
    TRELIO_SKILL_COMPANY_ID: COMPANY_ID,
    TRELIO_SKILL_MEMBER_ID: MEMBER_ID,
    TRELIO_SKILL_CONNECTION_ID: CONNECTION_ID,
    TRELIO_SKILL_CONNECTION_CONFIG_JSON: JSON.stringify({
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      allowAutonomous: true,
    }),
  };
}

test("argument parser keeps mutation flags separate from values", () => {
  assert.deepEqual(parseArgs([
    "create-event",
    "--calendar",
    "primary",
    "--summary=Встреча",
    "--apply",
  ]), {
    _: ["create-event"],
    calendar: "primary",
    summary: "Встреча",
    apply: true,
  });
});

test("purpose metadata accepts free-form text with explicit character limits", () => {
  assert.equal(normalizePurposeLabel("Рабочие встречи"), "Рабочие встречи");
  assert.equal(
    normalizePurposeDescription("Созвоны с подрядчиками.\nВнутренние встречи тоже сюда."),
    "Созвоны с подрядчиками.\nВнутренние встречи тоже сюда.",
  );
  assert.throws(() => normalizePurposeLabel("x".repeat(121)), /120 characters/u);
  assert.throws(() => normalizePurposeLabel("Первая строка\nВторая строка"), /one line/u);
  assert.throws(() => normalizePurposeDescription("x".repeat(2_001)), /2000 characters/u);
  assert.throws(() => normalizePurposeDescription("Нельзя\u0000так"), /control characters/u);
});

test("skill offers optional purpose setup after connecting an account with several calendars", () => {
  const source = fs.readFileSync(
    path.resolve("platform-skills/google-calendar/SKILL.md"),
    "utf8",
  );

  assert.match(source, /calendarCount > 1/u);
  assert.match(source, /calendars --account ALIAS --max 100/u);
  assert.match(source, /calendar-purpose list/u);
  assert.match(source, /describe only the calendars the agent should use/u);
  assert.match(source, /reader.*freeBusyReader.*read-only/su);
  assert.match(source, /do not\s+repeat the setup prompt/u);
  assert.match(source, /If exactly one calendar is available[\s\S]*do not force purpose setup/u);
  assert.match(source, /exact ID-based mappings/u);
});

test("runtime config accepts the protected platform OAuth client and autonomous ceiling", () => {
  assert.deepEqual(normalizeConnectionConfig({
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    allowAutonomous: false,
  }), {
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    allowAutonomous: false,
  });
  assert.throws(
    () => normalizeConnectionConfig({ clientId: CLIENT_ID }),
    CalendarRuntimeError,
  );
  assert.throws(
    () => normalizeConnectionConfig({
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      refreshToken: "must-not-exist",
    }),
    CalendarRuntimeError,
  );
  assert.throws(
    () => normalizeConnectionConfig({
      clientId: "not-a-google-client",
      clientSecret: CLIENT_SECRET,
    }),
    /installed-app client/u,
  );
});

test("runtime identity produces a stable per-member namespace", () => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "trelio-google-calendar-test-"));
  try {
    const environment = runtimeEnvironment(temporaryDirectory);
    const context = loadRuntimeContext(environment);
    assert.equal(
      connectionRoot(context, environment),
      path.join(
        temporaryDirectory,
        "integrations",
        "google-calendar",
        COMPANY_ID,
        MEMBER_ID,
        CONNECTION_ID,
      ),
    );
    const accountContext = selectRuntimeAccount(context, "work");
    assert.equal(
      accountRoot(context, "work", environment),
      path.join(
        temporaryDirectory,
        "integrations",
        "google-calendar",
        COMPANY_ID,
        MEMBER_ID,
        CONNECTION_ID,
        "accounts",
        "work",
      ),
    );
    assert.deepEqual(loadPolicy(accountContext, environment), { writeMode: "confirm" });
    assert.equal(normalizeAccountAlias("WORK"), "work");
    assert.throws(() => normalizeAccountAlias("../work"), /lowercase Latin/u);
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test("timed and all-day event resources preserve Google date semantics", () => {
  assert.deepEqual(buildCreateResource({
    summary: "Звонок",
    start: "2026-08-04T11:00:00+03:00",
    end: "2026-08-04T11:30:00+03:00",
    reminderMinutes: "60,1440",
  }), {
    summary: "Звонок",
    start: { dateTime: "2026-08-04T11:00:00+03:00" },
    end: { dateTime: "2026-08-04T11:30:00+03:00" },
    reminders: {
      useDefault: false,
      overrides: [
        { method: "popup", minutes: 60 },
        { method: "popup", minutes: 1440 },
      ],
    },
  });
  assert.deepEqual(buildCreateResource({
    summary: "День рождения",
    allDay: true,
    start: "2026-08-04",
    end: "2026-08-05",
    recurrence: "RRULE:FREQ=YEARLY",
    seriesConfirmed: true,
  }), {
    summary: "День рождения",
    start: { date: "2026-08-04" },
    end: { date: "2026-08-05" },
    recurrence: ["RRULE:FREQ=YEARLY"],
  });
  assert.throws(
    () => buildCreateResource({
      summary: "Неверный день",
      allDay: true,
      start: "2026-02-30",
      end: "2026-03-01",
    }),
    /real calendar date/u,
  );
  assert.throws(
    () => buildCreateResource({
      summary: "Еженедельная встреча",
      start: "2026-08-04T11:00:00+03:00",
      end: "2026-08-04T12:00:00+03:00",
      recurrence: "RRULE:FREQ=WEEKLY",
      seriesConfirmed: true,
    }),
    /requires --time-zone/u,
  );
});

test("attendees and recurring series require explicit side-effect flags", () => {
  assert.throws(
    () => buildCreateResource({
      summary: "Встреча",
      start: "2026-08-04T11:00:00+03:00",
      end: "2026-08-04T12:00:00+03:00",
      attendees: "person@example.com",
    }),
    /external invitations/u,
  );
  assert.throws(
    () => buildUpdatePatch({ recurrence: "RRULE:FREQ=YEARLY" }),
    /series-confirmed/u,
  );
  assert.deepEqual(buildUpdatePatch({
    attendees: "person@example.com,person@example.com",
    sendInvitations: true,
  }), {
    attendees: [{ email: "person@example.com" }],
  });
  assert.equal(requiresInvitationUpdates({ attendees: [{ email: "person@example.com", self: false }] }), true);
  assert.equal(requiresInvitationUpdates({ attendees: [{ email: "me@example.com", self: true }] }), false);
  assert.equal(requiresInvitationUpdates({ attendees: [] }, { attendees: [] }), true);
});

test("OAuth callback requires loopback, exact Host, path and state", () => {
  const request = {
    method: "GET",
    url: "/oauth/callback?state=expected&code=authorization-code",
    headers: { host: "127.0.0.1:43123" },
    socket: { remoteAddress: "127.0.0.1" },
  };
  assert.equal(validateOAuthCallbackRequest(request, 43123, "expected"), "authorization-code");
  assert.throws(
    () => validateOAuthCallbackRequest({
      ...request,
      headers: { host: "localhost:43123" },
    }, 43123, "expected"),
    /Host is invalid/u,
  );
  assert.throws(
    () => validateOAuthCallbackRequest({
      ...request,
      socket: { remoteAddress: "192.0.2.10" },
    }, 43123, "expected"),
    /not loopback/u,
  );
});

test("Desktop OAuth keeps the required client secret out of the authorization URL", () => {
  const source = fs.readFileSync(
    path.resolve("platform-skills/google-calendar/scripts/trelio-google-calendar.mjs"),
    "utf8",
  );
  assert.match(source, /prompt: "select_account consent"/u);
  assert.match(source, /code_challenge_method: "S256"/u);
  assert.match(source, /code_verifier: verifier/u);
  assert.match(source, /client_secret: context\.config\.clientSecret/u);
  const authorizationStart = source.indexOf("authorizationUrl.search");
  const authorizationEnd = source.indexOf("const timer", authorizationStart);
  assert.ok(authorizationStart > 0 && authorizationEnd > authorizationStart);
  assert.doesNotMatch(
    source.slice(authorizationStart, authorizationEnd),
    /clientSecret|client_secret/u,
  );
});

test("Google errors normalize both Calendar API and OAuth token payloads", () => {
  assert.deepEqual(safeGoogleError({
    error: {
      status: "PERMISSION_DENIED",
      message: "Calendar access was denied.",
    },
  }), {
    providerCode: "PERMISSION_DENIED",
    providerMessage: "Calendar access was denied.",
  });
  assert.deepEqual(safeGoogleError({
    error: "invalid_grant",
    error_description: "Bad authorization code.\nTry again.",
  }), {
    providerCode: "invalid_grant",
    providerMessage: "Bad authorization code. Try again.",
  });
});

test("help works without a token and doctor reports the selected local account", async () => {
  assert.equal((await run(["help"], {})).command, "help");
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "trelio-google-calendar-cli-"));
  try {
    const scriptPath = path.resolve(
      "platform-skills/google-calendar/scripts/trelio-google-calendar.mjs",
    );
    const result = spawnSync(process.execPath, [scriptPath, "doctor"], {
      cwd: path.resolve("."),
      env: runtimeEnvironment(temporaryDirectory),
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /"status": "needs_connect"/u);
    assert.match(result.stdout, /"account": "default"/u);
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test("accounts lists isolated aliases and local purpose mappings without OAuth network access", async () => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "trelio-google-calendar-accounts-"));
  try {
    const environment = runtimeEnvironment(temporaryDirectory);
    const context = loadRuntimeContext(environment);
    const workRoot = accountRoot(context, "work", environment);
    const personalRoot = accountRoot(context, "personal", environment);
    fs.mkdirSync(path.join(workRoot, "state"), { recursive: true, mode: 0o700 });
    fs.mkdirSync(path.join(personalRoot, "state"), { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(workRoot, "state", "oauth-token.json"), "{}\n", { mode: 0o600 });
    fs.writeFileSync(path.join(personalRoot, "state", "oauth-token.json"), "{}\n", { mode: 0o600 });
    const purposesDirectory = path.join(connectionRoot(context, environment), "config");
    fs.mkdirSync(purposesDirectory, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(purposesDirectory, "calendar-purposes.json"), JSON.stringify({
      purposes: {
        work: {
          account: "work",
          calendarId: "work@example.com",
          label: "Рабочие встречи",
          description: "Созвоны, планёрки и встречи с подрядчиками.",
          summary: "Рабочий",
          accessRole: "owner",
          updatedAt: "2026-08-01T00:00:00.000Z",
        },
        personal: {
          account: "personal",
          calendarId: "personal@example.com",
          summary: "Личный",
          accessRole: "owner",
          updatedAt: "2026-08-01T00:00:00.000Z",
        },
      },
    }), { mode: 0o600 });

    const result = await run(["accounts"], environment);
    assert.deepEqual(result.accounts.map((account) => account.alias), ["personal", "work"]);
    assert.equal(result.purposes.work.calendarId, "work@example.com");
    assert.equal(result.purposes.work.label, "Рабочие встречи");
    assert.equal(result.purposes.work.description, "Созвоны, планёрки и встречи с подрядчиками.");
    assert.equal(result.purposes.personal.account, "personal");
    assert.equal(result.purposes.personal.label, "personal");
    assert.equal(result.purposes.personal.description, null);
    await assert.rejects(
      () => run(["doctor"], environment),
      (error) => error instanceof CalendarRuntimeError && error.code === "GOOGLE_CALENDAR_ACCOUNT_REQUIRED",
    );
    await assert.rejects(
      () => run(["events", "--purpose", "work", "--account", "personal"], environment),
      /conflicts with the supplied --account/u,
    );
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});
