import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const scriptsDirectory = fileURLToPath(new URL("../scripts/", import.meta.url));
const origin = "https://example.test";
const skillAction = {
  schemaVersion: 1,
  operation: "skill_run",
  parameters: {
    companyId: "11111111-1111-4111-8111-111111111111",
    skillId: "example-skill",
    releaseId: "22222222-2222-4222-8222-222222222222",
    arguments: ["inspect"],
  },
};

// Import the real facade before replacing only this disposable copy's bridge
// entrypoint. The subprocess then exercises the production execFile path without
// connecting to Trelio, resolving a provider package or reading any credentials.
const bridgeProbe = `
import fs from "node:fs/promises";
await fs.appendFile(process.env.TRELIO_TEST_EXECUTIONS, "started\\n");
if (process.env.TRELIO_TEST_CHILD_FAILURE === "1") {
  process.stderr.write("synthetic bridge failure");
  process.exitCode = 7;
} else {
  process.stdout.write(JSON.stringify({
    cwd: process.cwd(), executable: process.execPath, argv: process.argv.slice(2),
  }));
}
`;

const hostProbe = `
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
const options = JSON.parse(process.argv[2]);
const initialCwd = await fs.stat(".");
const entrypoint = path.join(options.pluginDirectory, "scripts", "trelio-workspace.mjs");
const { handleTrelioWorkspaceActionOperation } = await import(pathToFileURL(
  path.join(options.pluginDirectory, "scripts", "trelio-local-context.mjs"),
));
await fs.writeFile(entrypoint, ${JSON.stringify(bridgeProbe)});

// A separate host process lets POSIX remove its actual cwd inode without ever
// changing the test runner's cwd or racing another test's filesystem operations.
if (options.removeHostDirectory) await fs.rmdir(process.cwd());
if (options.removal === "plugin" || options.removal === "plugin_replaced_by_file") {
  await fs.rm(options.pluginDirectory, { recursive: true });
  if (options.removal === "plugin_replaced_by_file") {
    await fs.writeFile(options.pluginDirectory, "unavailable plugin");
  }
} else if (options.removal === "entrypoint" || options.removal === "entrypoint_directory") {
  await fs.rm(entrypoint);
  if (options.removal === "entrypoint_directory") await fs.mkdir(entrypoint);
} else if (options.removal === "before_spawn" || options.removal === "access_denied") {
  const originalStat = fs.stat;
  fs.stat = async (target, ...args) => {
    if (target === entrypoint && options.removal === "access_denied") {
      throw Object.assign(new Error("synthetic access denial"), { code: "EACCES" });
    }
    const result = await originalStat(target, ...args);
    // Make the preflight succeed, then remove the exact plugin before execFile.
    // This deterministically covers the update race without sleep-based timing.
    if (target === entrypoint && options.removal === "before_spawn") {
      await fs.rm(options.pluginDirectory, { recursive: true });
    }
    return result;
  };
}

let outcome;
const controller = new AbortController();
if (options.abortBeforeLaunch) controller.abort();
try {
  const result = await handleTrelioWorkspaceActionOperation(options.origin, options.action, {
    signal: controller.signal,
  });
  outcome = { result, child: JSON.parse(result.stdout) };
} catch (error) {
  outcome = { error: { name: error.name, code: error.code, message: error.message, details: error.details } };
}
const finalCwd = await fs.stat(".");
outcome.parentCwdUnchanged = initialCwd.dev === finalCwd.dev && initialCwd.ino === finalCwd.ino;
try { outcome.parentCwd = process.cwd(); }
catch (error) { outcome.parentCwdError = error.code; }
process.stdout.write(JSON.stringify(outcome));
`;

const createFixture = async (t) => {
  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "trelio-action-process-"));
  t.after(() => fs.rm(temporaryDirectory, { recursive: true, force: true }));
  // Resolve macOS /var and /private/var once so paths returned by process.cwd()
  // can be compared directly. A space also exercises the no-shell launch route.
  const root = await fs.realpath(temporaryDirectory);
  const pluginDirectory = path.join(root, "loaded plugin");
  const hostDirectory = path.join(root, "host");
  const workspaceDirectory = path.join(root, "task workspace");
  await fs.cp(scriptsDirectory, path.join(pluginDirectory, "scripts"), { recursive: true });
  await fs.mkdir(hostDirectory);
  await fs.mkdir(workspaceDirectory);
  const hostPath = path.join(root, "host.mjs");
  const executionsPath = path.join(root, "executions.log");
  await fs.writeFile(hostPath, hostProbe);
  const run = async ({ childFailure = false, ...options } = {}) => {
    const { stdout, stderr } = await execFileAsync(process.execPath, [
      hostPath,
      JSON.stringify({ pluginDirectory, origin, action: skillAction, ...options }),
    ], {
      cwd: hostDirectory,
      env: {
        ...process.env,
        TRELIO_TEST_EXECUTIONS: executionsPath,
        TRELIO_TEST_CHILD_FAILURE: childFailure ? "1" : "0",
      },
      timeout: 20_000,
      windowsHide: true,
    });
    assert.equal(stderr, "");
    const executions = await fs.readFile(executionsPath, "utf8").catch((error) => {
      if (error.code === "ENOENT") return "";
      throw error;
    });
    return { ...JSON.parse(stdout), executions };
  };
  return { run, pluginDirectory, hostDirectory, workspaceDirectory };
};

test("Workspace bridge uses its exact loaded plugin cwd and current Node executable", async (t) => {
  const fixture = await createFixture(t);
  const outcome = await fixture.run();
  assert.equal(outcome.error, undefined);
  assert.equal(outcome.child.cwd, fixture.pluginDirectory);
  assert.equal(outcome.child.executable, process.execPath);
  assert.deepEqual(outcome.child.argv.slice(-4), ["--origin", origin, "--", "inspect"]);
  assert.equal(outcome.parentCwd, fixture.hostDirectory);
  assert.equal(outcome.executions, "started\n");
});

test("Workspace bridge starts when a long-lived host inherited a deleted cwd", {
  skip: process.platform === "win32" ? "Windows locks the current directory against deletion" : false,
}, async (t) => {
  const fixture = await createFixture(t);
  const outcome = await fixture.run({ removeHostDirectory: true });
  assert.equal(outcome.error, undefined);
  assert.equal(outcome.child.cwd, fixture.pluginDirectory);
  // Node can cache the parent's old cwd string. Check the actual directory
  // removal and cwd inode, rather than relying on another process.cwd() call.
  await assert.rejects(fs.stat(fixture.hostDirectory), { code: "ENOENT" });
  assert.equal(outcome.parentCwdUnchanged, true);
  assert.equal(outcome.executions, "started\n");
});

test("Workspace bridge preserves the action's explicit working directory", async (t) => {
  const fixture = await createFixture(t);
  const outcome = await fixture.run({ action: {
    schemaVersion: 1, operation: "status", parameters: {},
    workingDirectory: fixture.workspaceDirectory,
  } });
  assert.equal(outcome.error, undefined);
  assert.equal(outcome.child.cwd, fixture.workspaceDirectory);
  assert.equal(outcome.parentCwd, fixture.hostDirectory);
});

for (const removal of ["plugin", "plugin_replaced_by_file", "entrypoint", "entrypoint_directory", "before_spawn"]) {
  test(`Workspace bridge requires a client restart for missing loaded files: ${removal}`, async (t) => {
    const fixture = await createFixture(t);
    const outcome = await fixture.run({ removal });
    assert.equal(outcome.error?.code, "TRELIO_PLUGIN_RESTART_REQUIRED");
    assert.match(outcome.error.message, /restart.*Codex.*Claude Code/iu);
    assert.deepEqual(outcome.error.details, {
      requiredAction: "restart_client", reason: "loaded_plugin_unavailable",
    });
    assert.equal(outcome.executions, "");
    assert.equal(outcome.parentCwd, fixture.hostDirectory);
  });
}

test("Workspace bridge does not substitute the plugin cwd for a missing task directory", async (t) => {
  const fixture = await createFixture(t);
  const outcome = await fixture.run({ action: {
    schemaVersion: 1, operation: "status", parameters: {},
    workingDirectory: path.join(fixture.workspaceDirectory, "missing"),
  } });
  assert.equal(outcome.error?.code, "TRELIO_WORKSPACE_ACTION_FAILED");
  assert.equal(outcome.executions, "");
});

test("Workspace bridge does not classify permission denial as a removed plugin", async (t) => {
  const fixture = await createFixture(t);
  const outcome = await fixture.run({ removal: "access_denied" });
  assert.equal(outcome.error?.code, "TRELIO_WORKSPACE_ACTION_FAILED");
  assert.equal(outcome.executions, "");
});

test("Workspace bridge preserves a child failure without restarting or replaying it", async (t) => {
  const fixture = await createFixture(t);
  const outcome = await fixture.run({ childFailure: true });
  assert.equal(outcome.error?.code, "TRELIO_WORKSPACE_ACTION_FAILED");
  assert.equal(outcome.error.message, "synthetic bridge failure");
  assert.equal(outcome.executions, "started\n");
});

test("Workspace bridge preserves cancellation before checking removed plugin files", async (t) => {
  const fixture = await createFixture(t);
  const outcome = await fixture.run({ removal: "plugin", abortBeforeLaunch: true });
  assert.equal(outcome.error?.name, "AbortError");
  assert.equal(outcome.executions, "");
});
