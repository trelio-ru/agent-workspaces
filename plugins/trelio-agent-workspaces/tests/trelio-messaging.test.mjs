import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
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
} from "../scripts/trelio-max.mjs";

const identityArguments = [
  "--company-id",
  "11111111-1111-1111-1111-111111111111",
  "--member-id",
  "22222222-2222-2222-2222-222222222222",
  "--connection-id",
  "33333333-3333-3333-3333-333333333333",
];

test("MAX local policy defaults to confirm and keeps state outside workspace", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "trelio-max-test-"));
  const previousConfigHome = process.env.TRELIO_CONFIG_HOME;
  process.env.TRELIO_CONFIG_HOME = temporary;
  try {
    const options = parseArguments([...identityArguments, "doctor"]);
    assert.deepEqual(loadPolicy(options), { sendMode: "confirm" });
    assert.match(connectionRoot(options), /integrations\/max-web/u);
    assert.doesNotMatch(connectionRoot(options), /\.trelio/u);
  } finally {
    if (previousConfigHome === undefined) delete process.env.TRELIO_CONFIG_HOME;
    else process.env.TRELIO_CONFIG_HOME = previousConfigHome;
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("MAX exposes a versioned, content-free live probe command", () => {
  const options = parseArguments([...identityArguments, "probe"]);
  assert.equal(options.command, "probe");
  assert.equal(ADAPTER_VERSION, "1");
});

test("MAX retries one blank SPA shell before probing the authenticated UI", async () => {
  let readinessChecks = 0;
  let reloads = 0;
  const page = {
    goto: async () => undefined,
    reload: async () => {
      reloads += 1;
    },
    waitForFunction: async () => {
      readinessChecks += 1;
      if (readinessChecks === 1) throw new Error("blank shell");
    },
    evaluate: async () => "чаты поиск",
  };

  const result = await openHome(page, { timeoutMs: 60_000 });
  assert.deepEqual(result, { uiReady: true });
  assert.equal(readinessChecks, 2);
  assert.equal(reloads, 1);
});

test("MAX fails closed when the SPA stays blank after one controlled reload", async () => {
  let reloads = 0;
  const page = {
    goto: async () => undefined,
    reload: async () => {
      reloads += 1;
    },
    waitForFunction: async () => {
      throw new Error("blank shell");
    },
  };

  await assert.rejects(
    () => openHome(page, { timeoutMs: 60_000 }),
    /MAX home rendered no visible interactive UI/u,
  );
  assert.equal(reloads, 1);
});

test("MAX action selection requires one exact normalized dialog title", () => {
  const results = [
    { index: 0, title: "ООО Вкус моря" },
    { index: 1, title: "  ООО   ВКУС  " },
  ];

  assert.equal(normalizeDialogTitle(" ООО  Вкус "), "ооо вкус");
  assert.equal(selectExactDialogResult(results, "ООО Вкус").index, 1);
  assert.throws(
    () => selectExactDialogResult([results[0]], "ООО Вкус"),
    /No exact visible MAX dialog matched/u,
  );
  assert.throws(
    () => selectExactDialogResult(
      [
        { index: 0, title: "ООО Вкус" },
        { index: 1, title: "ооо вкус" },
      ],
      "ООО Вкус",
    ),
    /Ambiguous exact MAX dialog title/u,
  );
});

test("MAX read-only and autonomous modes are enforced by runtime code", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "trelio-max-test-"));
  const previousConfigHome = process.env.TRELIO_CONFIG_HOME;
  process.env.TRELIO_CONFIG_HOME = temporary;
  try {
    const options = parseArguments([...identityArguments, "send", "--chat", "test", "--message", "hello"]);
    writePrivateJson(policyPath(options), { sendMode: "read-only" });
    assert.throws(() => assertSendAllowed(options), /read-only/u);

    writePrivateJson(policyPath(options), { sendMode: "autonomous" });
    assert.equal(assertSendAllowed(options), "autonomous");
    options.companyAllowsAutonomous = false;
    assert.throws(() => assertSendAllowed(options), /company connection/u);
  } finally {
    if (previousConfigHome === undefined) delete process.env.TRELIO_CONFIG_HOME;
    else process.env.TRELIO_CONFIG_HOME = previousConfigHome;
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});
