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
  installPassiveReadGuard,
  loadPolicy,
  normalizeContactReference,
  normalizeDialogTitle,
  openHome,
  parseArguments,
  passiveReadFrameMarker,
  policyPath,
  selectExactContactResult,
  selectExactDialogResult,
  shouldBlockPassiveReadFrame,
  waitForLoginHandoff,
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
    assert.equal(
      connectionRoot(options).includes(
        path.join("integrations", "max-web"),
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

test("MAX exposes a versioned, content-free live probe command", () => {
  const options = parseArguments([...identityArguments, "probe"]);
  assert.equal(options.command, "probe");
  assert.equal(ADAPTER_VERSION, "2");
});

test("MAX login handoff finishes as soon as the owner closes the visible window", async () => {
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

test("MAX login handoff keeps a bounded timeout when the window is not closed", async () => {
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

test("MAX skill tells the owner to close the login window and requires a fresh probe", () => {
  const skillSource = fs.readFileSync(
    new URL("../skills/trelio-skill-catalog/SKILL.md", import.meta.url),
    "utf8",
  );

  assert.match(skillSource, /После входа в MAX закройте окно\./u);
  assert.match(skillSource, /immediately run one fresh\s+`probe`/u);
  assert.doesNotMatch(skillSource, /не закрывайте (?:его|окно)/iu);
});

test("MAX parses bounded history, repeated files and exact member references", () => {
  const options = parseArguments([
    ...identityArguments,
    "create-group",
    "--title",
    "Проект Альфа",
    "--member",
    "@one",
    "--member",
    "https://max.ru/u/two",
    "--file",
    "/tmp/one.txt",
    "--file",
    "/tmp/two.txt",
    "--pages",
    "3",
  ]);
  assert.equal(options.title, "Проект Альфа");
  assert.deepEqual(options.members, ["@one", "https://max.ru/u/two"]);
  assert.deepEqual(options.files, ["/tmp/one.txt", "/tmp/two.txt"]);
  assert.equal(options.pages, 3);
  assert.throws(
    () => parseArguments([...identityArguments, "read", "--pages", "21"]),
    /--pages must be an integer/u,
  );
  assert.throws(
    () => parseArguments([...identityArguments, "admin-add", "--chat", "Команда", "--member", "@one"]),
    /Unsupported MAX browser command/u,
  );
  assert.throws(
    () => parseArguments([...identityArguments, "invite-link", "--chat", "Команда"]),
    /Unsupported MAX browser command/u,
  );
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

test("MAX passive read guard blocks binary read receipts and forwards other traffic", async () => {
  let routeHandler = null;
  const context = {
    routeWebSocket: async (_pattern, handler) => {
      routeHandler = handler;
    },
  };
  const forwarded = [];
  let clientMessageHandler = null;
  const client = {
    connectToServer: () => ({ send: (message) => forwarded.push(message) }),
    onMessage: (handler) => {
      clientMessageHandler = handler;
    },
  };
  const state = await installPassiveReadGuard(context);
  routeHandler(client);

  const receipt = Buffer.from([0x81, ...Buffer.from("READ_MESSAGE", "utf8"), 0x01]);
  assert.equal(passiveReadFrameMarker(receipt), "READ_MESSAGE");
  assert.equal(shouldBlockPassiveReadFrame(receipt), true);
  clientMessageHandler(receipt);
  assert.equal(forwarded.length, 0);
  assert.equal(state.blockedFrames, 1);

  const historyRequest = Buffer.from("LOAD_MESSAGES", "utf8");
  clientMessageHandler(historyRequest);
  assert.deepEqual(forwarded, [historyRequest]);

  state.allowReadReceipts = true;
  clientMessageHandler(Buffer.from("READ_REACTION", "utf8"));
  assert.equal(forwarded.length, 2);
  assert.equal(state.forwardedReadFrames, 1);
});

test("MAX exact contact resolver prefers stable /u identity and rejects ambiguity", () => {
  const results = [
    { stableId: "ivan", title: "Иван", text: "Иван @ivan" },
    { stableId: "ivan-work", title: "Иван", text: "Иван @ivan-work" },
  ];
  assert.equal(normalizeContactReference("https://max.ru/u/Ivan/"), "ivan");
  assert.equal(selectExactContactResult(results, "@ivan").stableId, "ivan");
  assert.throws(
    () => selectExactContactResult(results, "Иван"),
    /Several exact MAX contacts/u,
  );
});

test("MAX structural mutations bind confirmation to the exact dry-run payload", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "trelio-max-test-"));
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
