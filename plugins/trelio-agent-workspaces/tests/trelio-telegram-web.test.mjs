import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  ADAPTER_VERSION,
  assertMutationAllowed,
  assertSendAllowed,
  buildMutationPreview,
  connectionRoot,
  createReadState,
  loadPolicy,
  normalizeContactReference,
  normalizeDialogTitle,
  openHome,
  parseArguments,
  policyPath,
  selectExactContactResult,
  selectExactDialogResult,
  waitForLoginHandoff,
  writePrivateJson,
} from "../scripts/trelio-telegram-web.mjs";

const identityArguments = [
  "--company-id",
  "11111111-1111-1111-1111-111111111111",
  "--member-id",
  "22222222-2222-2222-2222-222222222222",
  "--connection-id",
  "33333333-3333-3333-3333-333333333333",
];

test("Telegram Web local policy defaults to confirm and keeps state outside workspace", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "trelio-telegram-web-test-"));
  const previousConfigHome = process.env.TRELIO_CONFIG_HOME;
  process.env.TRELIO_CONFIG_HOME = temporary;
  try {
    const options = parseArguments([...identityArguments, "doctor"]);
    assert.deepEqual(loadPolicy(options), { sendMode: "confirm" });
    assert.equal(
      connectionRoot(options).includes(
        path.join("integrations", "telegram-web"),
      ),
      true,
    );
    assert.doesNotMatch(connectionRoot(options), /\.trelio/u);
  } finally {
    if (previousConfigHome === undefined) delete process.env.TRELIO_CONFIG_HOME;
    else process.env.TRELIO_CONFIG_HOME = previousConfigHome;
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("Telegram Web exposes a versioned, content-free live probe command", () => {
  const options = parseArguments([...identityArguments, "probe"]);
  assert.equal(options.command, "probe");
  assert.equal(ADAPTER_VERSION, "2");
});

test("Telegram Web login handoff finishes as soon as the owner closes the visible window", async () => {
  let closed = false;
  let closeWindow = null;
  const page = {
    isClosed: () => closed,
    waitForEvent: (event, options) => {
      assert.equal(event, "close");
      assert.deepEqual(options, { timeout: 0 });
      return new Promise((resolve) => {
        closeWindow = () => {
          closed = true;
          resolve();
        };
      });
    },
  };

  const handoff = waitForLoginHandoff(page, 1_000);
  assert.equal(typeof closeWindow, "function");
  closeWindow();
  assert.equal(await handoff, "window_closed");
});

test("Telegram Web login handoff keeps a bounded timeout when the window is not closed", async () => {
  const page = {
    isClosed: () => false,
    waitForEvent: () => new Promise(() => undefined),
  };

  assert.equal(await waitForLoginHandoff(page, 5), "hold_expired");
  assert.throws(
    () => parseArguments([...identityArguments, "login", "--hold-ms", "4999"]),
    /--hold-ms must be from 5000 to 600000/u,
  );
});

test("Telegram Web skill tells the owner to close the login window and requires a fresh probe", () => {
  const skillSource = fs.readFileSync(
    new URL("../skills/trelio-skill-catalog/SKILL.md", import.meta.url),
    "utf8",
  );

  assert.match(skillSource, /После входа в Telegram Web закройте окно\./u);
  assert.match(skillSource, /immediately run one fresh\s+`probe`/u);
  assert.doesNotMatch(skillSource, /не закрывайте (?:его|окно)/iu);
});

test("Telegram Web parses bounded history, repeated files and exact member references", () => {
  const options = parseArguments([
    ...identityArguments,
    "create-group",
    "--title",
    "Проект Альфа",
    "--member",
    "@one",
    "--member",
    "https://t.me/two",
    "--file",
    "/tmp/one.txt",
    "--file",
    "/tmp/two.txt",
    "--pages",
    "3",
  ]);
  assert.equal(options.title, "Проект Альфа");
  assert.deepEqual(options.members, ["@one", "https://t.me/two"]);
  // `parseArguments` intentionally resolves local files with the host path
  // implementation. Keep the assertion portable instead of hard-coding a
  // POSIX spelling that becomes `D:\\tmp\\...` on GitHub's Windows runner.
  assert.deepEqual(options.files, [
    path.resolve("/tmp/one.txt"),
    path.resolve("/tmp/two.txt"),
  ]);
  assert.equal(options.pages, 3);
  assert.throws(
    () => parseArguments([...identityArguments, "read", "--pages", "21"]),
    /--pages must be an integer/u,
  );
  assert.throws(
    () => parseArguments([...identityArguments, "admin-add", "--chat", "Команда", "--member", "@one"]),
    /Unsupported Telegram Web browser command/u,
  );
  assert.throws(
    () => parseArguments([...identityArguments, "invite-link", "--chat", "Команда"]),
    /Unsupported Telegram Web browser command/u,
  );
});

test("Telegram Web retries one blank SPA shell before probing the authenticated UI", async () => {
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
    evaluate: async () => ({ authVisible: false, appVisible: true }),
  };

  const result = await openHome(page, { timeoutMs: 60_000 });
  assert.deepEqual(result, { uiReady: true });
  assert.equal(readinessChecks, 2);
  assert.equal(reloads, 1);
});

test("Telegram Web fails closed when the SPA stays blank after one controlled reload", async () => {
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
    /Telegram Web home rendered no visible interactive UI/u,
  );
  assert.equal(reloads, 1);
});

test("Telegram Web action selection requires one exact normalized dialog title", () => {
  const results = [
    { index: 0, title: "ООО Вкус моря" },
    { index: 1, title: "  ООО   ВКУС  " },
  ];

  assert.equal(normalizeDialogTitle(" ООО  Вкус "), "ооо вкус");
  assert.equal(selectExactDialogResult(results, "ООО Вкус").index, 1);
  assert.throws(
    () => selectExactDialogResult([results[0]], "ООО Вкус"),
    /No exact visible Telegram Web dialog matched/u,
  );
  assert.throws(
    () => selectExactDialogResult(
      [
        { index: 0, title: "ООО Вкус" },
        { index: 1, title: "ооо вкус" },
      ],
      "ООО Вкус",
    ),
    /Ambiguous exact Telegram Web dialog title/u,
  );
});

test("Telegram Web read-only and autonomous modes are enforced by runtime code", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "trelio-telegram-web-test-"));
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

test("Telegram Web reports ordinary provider read semantics without a protocol interception claim", () => {
  assert.deepEqual(createReadState(), {
    mode: "ordinary-telegram-web",
    mayMarkVisibleMessagesRead: true,
    note: "Opening a Telegram Web dialog may mark its visible messages as read.",
  });
});

test("Telegram Web exact contact resolver accepts t.me identity and rejects ambiguity", () => {
  const results = [
    { stableId: "ivan", title: "Иван", text: "Иван @ivan" },
    { stableId: "ivan-work", title: "Иван", text: "Иван @ivan-work" },
  ];
  assert.equal(normalizeContactReference("https://t.me/Ivan/"), "ivan");
  assert.equal(selectExactContactResult(results, "@ivan").stableId, "ivan");
  assert.throws(
    () => selectExactContactResult(results, "Иван"),
    /Several exact Telegram Web contacts/u,
  );
});

test("Telegram Web structural mutations bind confirmation to the exact dry-run payload", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "trelio-telegram-web-test-"));
  const previousConfigHome = process.env.TRELIO_CONFIG_HOME;
  process.env.TRELIO_CONFIG_HOME = temporary;
  try {
    const options = parseArguments([
      ...identityArguments,
      "create-group",
      "--title",
      "Проект Альфа",
      "--member",
      "@one",
      "--dry-run",
    ]);
    const preview = buildMutationPreview(options);
    assert.equal(preview.operation.command, "create-group");
    assert.equal(preview.confirmationRequired, true);

    options.dryRun = false;
    options.confirm = true;
    options.approvalHash = preview.approvalHash;
    assert.equal(assertMutationAllowed(options), "confirm");

    options.title = "Другой чат";
    assert.throws(
      () => assertMutationAllowed(options),
      /exact --approval-hash/u,
    );
  } finally {
    if (previousConfigHome === undefined) delete process.env.TRELIO_CONFIG_HOME;
    else process.env.TRELIO_CONFIG_HOME = previousConfigHome;
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});
