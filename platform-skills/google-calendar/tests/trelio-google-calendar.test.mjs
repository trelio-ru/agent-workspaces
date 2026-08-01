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
  connectionRoot,
  loadPolicy,
  loadRuntimeContext,
  normalizeConnectionConfig,
  parseArgs,
  requiresInvitationUpdates,
  run,
  validateOAuthCallbackRequest,
} from "../scripts/trelio-google-calendar.mjs";

const COMPANY_ID = "11111111-1111-4111-8111-111111111111";
const MEMBER_ID = "22222222-2222-4222-8222-222222222222";
const CONNECTION_ID = "33333333-3333-4333-8333-333333333333";
const CLIENT_ID = "123456789-test.apps.googleusercontent.com";
const CLIENT_SECRET = "company-secret-that-must-not-leak";

function runtimeEnvironment(configHome) {
  return {
    ...process.env,
    TRELIO_CONFIG_HOME: configHome,
    TRELIO_SKILL_COMPANY_ID: COMPANY_ID,
    TRELIO_SKILL_MEMBER_ID: MEMBER_ID,
    TRELIO_SKILL_CONNECTION_ID: CONNECTION_ID,
    TRELIO_SKILL_CONNECTION_CONFIG_JSON: JSON.stringify({
      clientId: CLIENT_ID,
      allowAutonomous: true,
    }),
    TRELIO_GOOGLE_CALENDAR_CLIENT_SECRET: CLIENT_SECRET,
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

test("company config accepts only a public client id and autonomous ceiling", () => {
  assert.deepEqual(normalizeConnectionConfig({
    clientId: CLIENT_ID,
    allowAutonomous: false,
  }), {
    clientId: CLIENT_ID,
    allowAutonomous: false,
  });
  assert.throws(
    () => normalizeConnectionConfig({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET }),
    CalendarRuntimeError,
  );
  assert.throws(
    () => normalizeConnectionConfig({ clientId: "not-a-google-client" }),
    /installed-app client/u,
  );
});

test("runtime identity produces a stable per-member namespace", () => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "trelio-google-calendar-test-"));
  try {
    const environment = runtimeEnvironment(temporaryDirectory);
    const context = loadRuntimeContext(environment);
    assert.equal(context.clientSecret, CLIENT_SECRET);
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
    assert.deepEqual(loadPolicy(context, environment), { writeMode: "confirm" });
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

test("help works without credentials and doctor never prints the company secret", async () => {
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
    assert.doesNotMatch(result.stdout, new RegExp(CLIENT_SECRET, "u"));
    assert.doesNotMatch(result.stderr, new RegExp(CLIENT_SECRET, "u"));
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});
