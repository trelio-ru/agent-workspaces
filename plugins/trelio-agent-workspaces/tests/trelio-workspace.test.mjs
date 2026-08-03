import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { EventEmitter } from "node:events";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  AGENT_WORKSPACE_DEFAULT_WORKLOG_MARKDOWN,
  AGENT_WORKSPACE_RUNTIME_AGENTS_MARKDOWN,
  AGENT_WORKSPACE_RUNTIME_CLAUDE_MARKDOWN,
  BRIDGE_VERSION,
  LEGACY_WORKSPACE_CONTEXT_FILE_NAME,
  WORKSPACE_CONTEXT_FILE_NAME,
  BridgePluginUpgradeRequiredError,
  BrowserOpenError,
  WINDOWS_PRIVATE_ACL_SCRIPT,
  applyAgentRulesHandshake,
  buildAgentWorkspaceRuntimeAgentsMarkdown,
  buildAgentSkillPackage,
  buildAgentSkillRuntimeEnvironment,
  buildWindowsPrivateAclPowerShellInvocation,
  buildRunContextSpecifications,
  buildBridgeRequestHeaders,
  hardenWindowsPrivatePath,
  getGitStatus,
  inspectWorkspaceFile,
  isCodexPluginAutoUpdateEnvironment,
  isProtectedWorkspaceControlPath,
  isStableVersionAtLeast,
  isTransientCodexMarketplaceUpdateError,
  materializeRuntimeControlFiles,
  resolveWorkspaceContextFileName,
  ensureWorkspaceWorklog,
  normalizeAgentSkillPackagePath,
  normalizeResolvedSkillRuntimeArtifact,
  openBrowser,
  parseAndValidateAgentSkillPackage,
  parseWorkspaceObjectPointer,
  recoverBridgePluginUpgrade,
  restoreRetainedCodexPluginInstallations,
  retainLoadedCodexPluginInstallation,
  request,
  resolveWorkspaceBridgeConfigDirectory,
  updateCodexPluginMarketplace,
  validateHandoffTaskOutcome,
} from "../scripts/trelio-workspace.mjs";

const execFileAsync = promisify(execFile);
const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const pluginDirectory = path.resolve(testDirectory, "..");
const bridgePath = path.resolve(testDirectory, "../scripts/trelio-workspace.mjs");
const runId = "11111111-1111-4111-8111-111111111111";
const companyWorkspaceId = "22222222-2222-4222-8222-222222222222";
const relatedWorkspaceId = "33333333-3333-4333-8333-333333333333";
const companyHead = "a".repeat(40);
const relatedHead = "b".repeat(40);

/**
 * Read a skill together with its one-level Markdown references.
 *
 * Worker procedures intentionally use progressive disclosure, so regression
 * tests must validate the complete semantic bundle rather than forcing every
 * invariant back into the always-loaded SKILL.md.
 */
const readSkillBundle = async (skillName) => {
  const skillDirectory = path.join(pluginDirectory, "skills", skillName);
  const main = await readFile(path.join(skillDirectory, "SKILL.md"), "utf8");
  const referencesDirectory = path.join(skillDirectory, "references");
  const referenceNames = await readdir(referencesDirectory).catch(() => []);
  const references = await Promise.all(referenceNames
    .filter((name) => name.endsWith(".md"))
    .sort()
    .map((name) => readFile(path.join(referencesDirectory, name), "utf8")));

  return [main, ...references].join("\n\n");
};

const runGit = (workingDirectory, args, options = {}) => execFileAsync(
  "git",
  ["-c", "core.hooksPath=/dev/null", "-c", "init.templateDir=", ...args],
  {
    cwd: workingDirectory,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
    },
    ...options,
  },
);

const readRequestBody = async (request) => {
  const chunks = [];

  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return Buffer.concat(chunks);
};

const writeTestCredential = async (homeDirectory, origin) => {
  const credentialDirectory = path.join(
    homeDirectory,
    ".config",
    "trelio",
    "workspace-bridge",
  );
  await mkdir(credentialDirectory, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") {
    await chmod(credentialDirectory, 0o700);
  }
  await writeFile(
    path.join(credentialDirectory, "credentials.json"),
    `${JSON.stringify({ [origin]: { accessToken: "integration-token" } }, null, 2)}\n`,
    { mode: 0o600 },
  );
};

const createExportBundle = async (temporaryDirectory, files) => {
  const repositoryDirectory = path.join(temporaryDirectory, "repository");
  const bundlePath = path.join(temporaryDirectory, "workspace.bundle");
  await mkdir(repositoryDirectory, { recursive: true });
  await runGit(repositoryDirectory, ["init", "--initial-branch=main"]);
  await runGit(repositoryDirectory, ["config", "user.name", "Trelio Bridge Test"]);
  await runGit(repositoryDirectory, ["config", "user.email", "bridge-test@trelio.local"]);

  for (const [relativePath, contents] of Object.entries(files)) {
    const filePath = path.join(repositoryDirectory, relativePath);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, contents);
  }

  await runGit(repositoryDirectory, ["add", "--all"]);
  await runGit(repositoryDirectory, ["commit", "-m", "Test workspace"]);
  const head = (await runGit(repositoryDirectory, ["rev-parse", "HEAD"])).stdout.trim();
  await runGit(repositoryDirectory, ["update-ref", `refs/trelio/exports/${head}`, head]);
  await runGit(repositoryDirectory, [
    "bundle",
    "create",
    bundlePath,
    `refs/trelio/exports/${head}`,
  ]);

  return { bundle: await readFile(bundlePath), head };
};

const pathExists = async (filePath) => {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
};

test("platform rules handshake reuses a matching hash and verifies updated bytes", async () => {
  const rulesMarkdown = "# Platform rules\n\nLink only human-facing results.\n";
  const sha256 = createHash("sha256").update(rulesMarkdown, "utf8").digest("hex");
  const cached = {
    revisionId: "44444444-4444-4444-8444-444444444444",
    version: 3,
    sha256,
    rulesMarkdown,
  };

  assert.deepEqual(
    await applyAgentRulesHandshake("https://trelio.ru", {
      status: "current",
      revisionId: cached.revisionId,
      version: cached.version,
      sha256,
    }, cached),
    cached,
  );

  let restoredMetadata = null;
  const restored = await applyAgentRulesHandshake("https://trelio.ru", {
    status: "current",
    revisionId: "55555555-5555-4555-8555-555555555555",
    version: 4,
    sha256,
  }, cached, {
    cacheRules: async (_origin, snapshot) => {
      restoredMetadata = snapshot;
      return snapshot;
    },
  });
  assert.equal(restored.version, 4);
  assert.equal(restored.rulesMarkdown, rulesMarkdown);
  assert.equal(restoredMetadata.revisionId, restored.revisionId);

  let saved = null;
  const updated = await applyAgentRulesHandshake("https://trelio.ru", {
    status: "update_required",
    ...cached,
  }, null, {
    cacheRules: async (origin, snapshot) => {
      saved = { origin, snapshot };
      return snapshot;
    },
  });
  assert.equal(updated.sha256, sha256);
  assert.equal(saved.origin, "https://trelio.ru");
  assert.equal(saved.snapshot.rulesMarkdown, rulesMarkdown);

  await assert.rejects(
    applyAgentRulesHandshake("https://trelio.ru", {
      status: "update_required",
      ...cached,
      rulesMarkdown: `${rulesMarkdown}tampered`,
    }, null, {
      cacheRules: async () => {
        throw new Error("tampered rules must not reach cache");
      },
    }),
    /SHA-256/u,
  );
});

test("Codex plugin updater is scoped to an active Codex task and supports opt-out", () => {
  assert.equal(isCodexPluginAutoUpdateEnvironment({
    CODEX_THREAD_ID: "11111111-1111-4111-8111-111111111111",
  }), true);
  assert.equal(isCodexPluginAutoUpdateEnvironment({
    CODEX_THREAD_ID: "11111111-1111-4111-8111-111111111111",
    TRELIO_WORKSPACE_DISABLE_AUTO_UPDATE: "1",
  }), false);
  assert.equal(isCodexPluginAutoUpdateEnvironment({
    CODEX_THREAD_ID: "11111111-1111-4111-8111-111111111111",
    CLAUDE_CODE_ENTRYPOINT: "cli",
  }), false);
  assert.equal(isCodexPluginAutoUpdateEnvironment({}), false);
});

test("every bridge transport request preserves upgrade compatibility for recovery", async () => {
  const server = createServer((_request, response) => {
    response.writeHead(409, { "content-type": "application/json" });
    response.end(JSON.stringify({
      code: "AGENT_WORKSPACE_PLUGIN_UPGRADE_REQUIRED",
      message: "upgrade required",
      packageName: "trelio-ru/agent-workspaces",
      installedVersion: "1.5.10",
      minimumVersion: "1.5.11",
      supported: false,
      update: {
        automaticCodexUpdate: true,
        sameTaskRetryAllowed: true,
      },
    }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    await assert.rejects(
      request(
        `http://127.0.0.1:${address.port}`,
        "bridge-session",
        "/api/agent-workspaces/example",
      ),
      (error) => (
        error instanceof BridgePluginUpgradeRequiredError
        && error.compatibility.minimumVersion === "1.5.11"
        && error.compatibility.update.sameTaskRetryAllowed === true
      ),
    );
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (
      error ? reject(error) : resolve()
    )));
  }
});

test("runtime-host upgrade uses the same quiet plugin recovery contract", async () => {
  const server = createServer((_request, response) => {
    response.writeHead(409, { "content-type": "application/json" });
    response.end(JSON.stringify({
      code: "AGENT_SKILL_RUNTIME_HOST_UPGRADE_REQUIRED",
      message: "runtime host upgrade required",
      installedVersion: "1.5.11",
      minimumVersion: "1.5.12",
      updateCommand: "codex plugin marketplace upgrade trelio-plugins",
      update: {
        automaticCodexUpdate: true,
        sameTaskRetryAllowed: true,
      },
    }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    await assert.rejects(
      request(
        `http://127.0.0.1:${address.port}`,
        "bridge-session",
        "/api/agent-skills/runtime/resolve",
      ),
      (error) => (
        error instanceof BridgePluginUpgradeRequiredError
        && error.compatibility.minimumVersion === "1.5.12"
        && error.compatibility.update.sameTaskRetryAllowed === true
      ),
    );
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (
      error ? reject(error) : resolve()
    )));
  }
});

test("Codex plugin updater retries transient network failures and validates exact install", async () => {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "trelio-plugin-update-"));
  const installedPath = path.join(temporaryDirectory, "trelio-agent-workspaces", "1.5.12");
  const invocations = [];
  const waits = [];
  let marketplaceAttempt = 0;

  try {
    await Promise.all([
      mkdir(path.join(installedPath, ".codex-plugin"), { recursive: true }),
      mkdir(path.join(installedPath, "scripts"), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(
        path.join(installedPath, ".codex-plugin", "plugin.json"),
        JSON.stringify({ name: "trelio-agent-workspaces", version: "1.5.12" }),
      ),
      writeFile(
        path.join(installedPath, "scripts", "trelio-workspace.mjs"),
        "export const BRIDGE_VERSION = '1.5.12';\n",
      ),
    ]);

    const installation = await updateCodexPluginMarketplace({
      minimumVersion: "1.5.12",
      preserveLoadedPlugin: false,
      environment: {
        CODEX_THREAD_ID: "11111111-1111-4111-8111-111111111111",
      },
      waitForRetry: async (milliseconds) => {
        waits.push(milliseconds);
      },
      execFileCommand: async (command, args, options) => {
        invocations.push({ command, args, options });

        if (args[1] === "marketplace" && args[2] === "list") {
          return {
            stdout: JSON.stringify({
              marketplaces: [{
                name: "trelio-plugins",
                root: temporaryDirectory,
                marketplaceSource: {
                  sourceType: "git",
                  source: "https://github.com/trelio-ru/agent-workspaces.git",
                },
              }],
            }),
            stderr: "",
          };
        }

        if (args[1] === "marketplace" && args[2] === "upgrade") {
          marketplaceAttempt += 1;
          if (marketplaceAttempt < 3) {
            const error = new Error("temporary marketplace failure");
            error.stderr = marketplaceAttempt === 1
              ? "SSL_ERROR_SYSCALL in connection to github.com"
              : "git ls-remote failed: ECONNRESET";
            throw error;
          }
          return {
            stdout: JSON.stringify({
              selectedMarketplaces: ["trelio-plugins"],
              upgradedRoots: [temporaryDirectory],
              errors: [],
            }),
            stderr: "",
          };
        }

        assert.deepEqual(args, [
          "plugin",
          "add",
          "trelio-agent-workspaces@trelio-plugins",
          "--json",
        ]);
        return {
          stdout: JSON.stringify({
            pluginId: "trelio-agent-workspaces@trelio-plugins",
            name: "trelio-agent-workspaces",
            marketplaceName: "trelio-plugins",
            version: "1.5.12",
            installedPath,
          }),
          stderr: "",
        };
      },
    });

    assert.equal(installation.version, "1.5.12");
    assert.equal(installation.bridgePath, path.join(
      installedPath,
      "scripts",
      "trelio-workspace.mjs",
    ));
    assert.deepEqual(waits, [1_000, 3_000]);
    assert.equal(invocations.length, 5);
    for (const invocation of invocations) {
      assert.equal(invocation.command, "codex");
      assert.equal(invocation.options.shell, false);
      assert.equal(invocation.options.timeout, 120_000);
      assert.equal(invocation.options.env.GIT_TERMINAL_PROMPT, "0");
    }
    assert.equal(isTransientCodexMarketplaceUpdateError({
      stderr: "fatal: unable to access repository: TLS handshake failed",
    }), true);
    assert.equal(isTransientCodexMarketplaceUpdateError({
      killed: true,
      message: "Command failed without stderr",
    }), true);
    assert.equal(isStableVersionAtLeast("1.5.12", "1.5.11"), true);
    assert.equal(isStableVersionAtLeast("1.5.10", "1.5.11"), false);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test("Codex plugin updater retains exact versioned skill paths across repeated cache pruning", async () => {
  const temporaryDirectory = await mkdtemp(path.join(
    os.tmpdir(),
    "trelio-plugin-retention-",
  ));
  const pluginCacheDirectory = path.join(
    temporaryDirectory,
    "plugins",
    "cache",
    "trelio-plugins",
    "trelio-agent-workspaces",
  );
  const retentionDirectory = path.join(
    temporaryDirectory,
    "private",
    "codex-plugin-retention",
  );

  const createPluginVersion = async (version) => {
    const installedPath = path.join(pluginCacheDirectory, version);
    await Promise.all([
      mkdir(path.join(installedPath, ".codex-plugin"), { recursive: true }),
      mkdir(path.join(installedPath, "scripts"), { recursive: true }),
      mkdir(path.join(
        installedPath,
        "skills",
        "trelio-skill-catalog",
      ), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(
        path.join(installedPath, ".codex-plugin", "plugin.json"),
        JSON.stringify({ name: "trelio-agent-workspaces", version }),
      ),
      writeFile(
        path.join(installedPath, "scripts", "trelio-workspace.mjs"),
        `export const BRIDGE_VERSION = ${JSON.stringify(version)};\n`,
      ),
      writeFile(
        path.join(
          installedPath,
          "skills",
          "trelio-skill-catalog",
          "SKILL.md",
        ),
        `exact skill ${version}\n`,
      ),
    ]);
    return installedPath;
  };

  const pruneAndInstall = async (version) => {
    const names = await readdir(pluginCacheDirectory).catch(() => []);
    await Promise.all(names.map((name) => rm(
      path.join(pluginCacheDirectory, name),
      { recursive: true, force: true },
    )));
    return createPluginVersion(version);
  };

  const updateFrom = async (loadedVersion, installedVersion) => {
    const loadedPluginDirectory = path.join(
      pluginCacheDirectory,
      loadedVersion,
    );
    const installedPath = path.join(pluginCacheDirectory, installedVersion);
    let marketplaceAttempt = 0;
    return updateCodexPluginMarketplace({
      minimumVersion: installedVersion,
      loadedPluginDirectory,
      loadedPluginVersion: loadedVersion,
      retentionDirectory,
      waitForRetry: async () => {},
      execFileCommand: async (_command, args) => {
        if (args[1] === "marketplace" && args[2] === "list") {
          return {
            stdout: JSON.stringify({
              marketplaces: [{
                name: "trelio-plugins",
                marketplaceSource: {
                  sourceType: "git",
                  source: "https://github.com/trelio-ru/agent-workspaces.git",
                },
              }],
            }),
            stderr: "",
          };
        }
        if (args[1] === "marketplace" && args[2] === "upgrade") {
          marketplaceAttempt += 1;
          if (loadedVersion === "1.6.19" && marketplaceAttempt === 1) {
            await pruneAndInstall(installedVersion);
            const error = new Error("marketplace connection reset after cleanup");
            error.code = "ECONNRESET";
            throw error;
          }
          if (loadedVersion === "1.6.19" && marketplaceAttempt === 2) {
            assert.equal(
              await readFile(path.join(
                loadedPluginDirectory,
                "skills",
                "trelio-skill-catalog",
                "SKILL.md",
              ), "utf8"),
              "exact skill 1.6.19\n",
              "failed mutation must restore the old skill before retry",
            );
          }
          await pruneAndInstall(installedVersion);
          return {
            stdout: JSON.stringify({
              selectedMarketplaces: ["trelio-plugins"],
              upgradedRoots: [pluginCacheDirectory],
              errors: [],
            }),
            stderr: "",
          };
        }

        assert.deepEqual(args, [
          "plugin",
          "add",
          "trelio-agent-workspaces@trelio-plugins",
          "--json",
        ]);
        // Codex currently performs the same old-version cleanup for `add`,
        // even when the requested plugin is already installed.
        await pruneAndInstall(installedVersion);
        return {
          stdout: JSON.stringify({
            pluginId: "trelio-agent-workspaces@trelio-plugins",
            name: "trelio-agent-workspaces",
            marketplaceName: "trelio-plugins",
            version: installedVersion,
            installedPath,
          }),
          stderr: "",
        };
      },
    });
  };

  try {
    const version119Path = await createPluginVersion("1.6.19");
    const firstUpdate = await updateFrom("1.6.19", "1.6.20");
    assert.equal(firstUpdate.version, "1.6.20");
    assert.equal(
      await readFile(path.join(
        version119Path,
        "skills",
        "trelio-skill-catalog",
        "SKILL.md",
      ), "utf8"),
      "exact skill 1.6.19\n",
    );

    const version120Path = path.join(pluginCacheDirectory, "1.6.20");
    const secondUpdate = await updateFrom("1.6.20", "1.6.21");
    assert.equal(secondUpdate.version, "1.6.21");
    assert.equal(
      await readFile(path.join(
        version119Path,
        "skills",
        "trelio-skill-catalog",
        "SKILL.md",
      ), "utf8"),
      "exact skill 1.6.19\n",
    );
    assert.equal(
      await readFile(path.join(
        version120Path,
        "skills",
        "trelio-skill-catalog",
        "SKILL.md",
      ), "utf8"),
      "exact skill 1.6.20\n",
    );

    const version121Path = path.join(pluginCacheDirectory, "1.6.21");
    await retainLoadedCodexPluginInstallation({
      loadedPluginDirectory: version121Path,
      loadedPluginVersion: "1.6.21",
      retentionDirectory,
    });
    await Promise.all([
      rm(version119Path, { recursive: true, force: true }),
      rm(version120Path, { recursive: true, force: true }),
    ]);
    assert.equal(
      await restoreRetainedCodexPluginInstallations({ retentionDirectory }),
      3,
    );
    assert.equal(
      await readFile(path.join(
        version119Path,
        "skills",
        "trelio-skill-catalog",
        "SKILL.md",
      ), "utf8"),
      "exact skill 1.6.19\n",
    );
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test("Codex plugin updater refuses a marketplace name redirected to another source", async () => {
  let invocationCount = 0;

  await assert.rejects(
    updateCodexPluginMarketplace({
      preserveLoadedPlugin: false,
      execFileCommand: async () => {
        invocationCount += 1;
        return {
          stdout: JSON.stringify({
            marketplaces: [{
              name: "trelio-plugins",
              root: "/tmp/not-official",
              marketplaceSource: {
                sourceType: "git",
                source: "https://example.com/lookalike.git",
              },
            }],
          }),
          stderr: "",
        };
      },
    }),
    /только для официального Git marketplace Trelio/u,
  );
  assert.equal(invocationCount, 1);
});

test("Codex plugin updater does not report success when the required release is absent", async () => {
  await assert.rejects(
    updateCodexPluginMarketplace({
      minimumVersion: "1.5.12",
      preserveLoadedPlugin: false,
      execFileCommand: async (_command, args) => {
        if (args[1] === "marketplace" && args[2] === "list") {
          return {
            stdout: JSON.stringify({
              marketplaces: [{
                name: "trelio-plugins",
                marketplaceSource: {
                  sourceType: "git",
                  source: "https://github.com/trelio-ru/agent-workspaces.git",
                },
              }],
            }),
            stderr: "",
          };
        }
        if (args[1] === "marketplace" && args[2] === "upgrade") {
          return {
            stdout: JSON.stringify({
              selectedMarketplaces: ["trelio-plugins"],
              upgradedRoots: [],
              errors: [],
            }),
            stderr: "",
          };
        }
        return {
          stdout: JSON.stringify({
            pluginId: "trelio-agent-workspaces@trelio-plugins",
            marketplaceName: "trelio-plugins",
            version: "1.5.11",
            installedPath: "/unused/below-minimum",
          }),
          stderr: "",
        };
      },
    }),
    /не установил требуемую стабильную версию v1\.5\.12/u,
  );
});

test("upgrade-required re-dispatches the exact installed bridge in the same Codex task", async () => {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "trelio-plugin-reexec-"));
  const installedPath = path.join(temporaryDirectory, "trelio-agent-workspaces", "1.5.12");
  const bridgePath = path.join(installedPath, "scripts", "trelio-workspace.mjs");
  const spawned = [];

  try {
    await Promise.all([
      mkdir(path.join(installedPath, ".codex-plugin"), { recursive: true }),
      mkdir(path.dirname(bridgePath), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(
        path.join(installedPath, ".codex-plugin", "plugin.json"),
        JSON.stringify({ name: "trelio-agent-workspaces", version: "1.5.12" }),
      ),
      writeFile(bridgePath, "export const BRIDGE_VERSION = '1.5.12';\n"),
    ]);

    const environment = {
      CODEX_THREAD_ID: "11111111-1111-4111-8111-111111111111",
    };
    const recovery = await recoverBridgePluginUpgrade(
      new BridgePluginUpgradeRequiredError({
        minimumVersion: "1.5.12",
        update: {
          sameTaskRetryAllowed: true,
          codexCommand: "codex plugin marketplace upgrade trelio-plugins",
        },
      }),
      {
        rawArguments: ["open", "--workspace", companyWorkspaceId],
        environment,
        preserveLoadedPlugin: false,
        execFileCommand: async (command, args, options) => {
          assert.equal(command, "codex");
          if (args[1] === "marketplace") {
            assert.deepEqual(args, [
              "plugin",
              "marketplace",
              "list",
              "--json",
            ]);
            return {
              stdout: JSON.stringify({
                marketplaces: [{
                  name: "trelio-plugins",
                  root: temporaryDirectory,
                  marketplaceSource: {
                    sourceType: "git",
                    source: "https://github.com/trelio-ru/agent-workspaces.git",
                  },
                }],
              }),
              stderr: "",
            };
          }
          assert.deepEqual(args, [
            "plugin",
            "add",
            "trelio-agent-workspaces@trelio-plugins",
            "--json",
          ]);
          assert.equal(options.shell, false);
          return {
            stdout: JSON.stringify({
              pluginId: "trelio-agent-workspaces@trelio-plugins",
              name: "trelio-agent-workspaces",
              marketplaceName: "trelio-plugins",
              version: "1.5.12",
              installedPath,
            }),
            stderr: "",
          };
        },
        spawnProcess: (command, args, options) => {
          const child = new EventEmitter();
          spawned.push({ command, args, options });
          queueMicrotask(() => child.emit("exit", 0, null));
          return child;
        },
      },
    );

    assert.deepEqual(recovery, { handled: true, exitCode: 0 });
    assert.equal(spawned.length, 1);
    assert.equal(spawned[0].command, process.execPath);
    assert.deepEqual(spawned[0].args, [
      bridgePath,
      "open",
      "--workspace",
      companyWorkspaceId,
    ]);
    assert.equal(spawned[0].options.shell, false);
    assert.equal(spawned[0].options.env.TRELIO_WORKSPACE_AUTO_UPDATE_REEXEC, "1");
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test("browser opener waits for a successful process exit instead of spawn", async () => {
  const child = new EventEmitter();
  let invocation;
  let resolved = false;
  const opening = openBrowser("http://127.0.0.1:45678/?nonce=private", {
    platform: "darwin",
    spawnProcess: (command, args, options) => {
      invocation = { command, args, options };
      return child;
    },
  }).then(() => {
    resolved = true;
  });

  child.emit("spawn");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(resolved, false, "spawn alone must not acknowledge browser handoff");

  child.emit("close", 0, null);
  await opening;
  assert.equal(resolved, true);
  assert.equal(invocation.command, "/usr/bin/open");
  assert.deepEqual(invocation.args, ["http://127.0.0.1:45678/?nonce=private"]);
  assert.equal(invocation.options.detached, undefined);
});

test("browser opener rejects a non-zero exit without exposing its URL", async () => {
  const child = new EventEmitter();
  const secretUrl = "http://127.0.0.1:45678/?nonce=must-not-leak";
  const opening = openBrowser(secretUrl, {
    platform: "darwin",
    spawnProcess: () => child,
  });
  child.emit("close", 1, null);

  await assert.rejects(opening, (error) => (
    error instanceof BrowserOpenError
    && error.code === "BROWSER_OPEN_FAILED"
    && /код 1/u.test(error.message)
    && !error.message.includes(secretUrl)
    && !error.message.includes("must-not-leak")
  ));
});

test("browser opener converts a spawn error to a nonce-safe diagnostic", async () => {
  const child = new EventEmitter();
  const opening = openBrowser("http://127.0.0.1:45678/?nonce=must-not-leak", {
    platform: "darwin",
    spawnProcess: () => child,
  });
  child.emit("error", new Error("LaunchServices unavailable"));

  await assert.rejects(opening, (error) => (
    error instanceof BrowserOpenError
    && error.code === "BROWSER_OPEN_FAILED"
    && !error.message.includes("must-not-leak")
  ));
});

test("browser opener cancellation stops its short-lived child immediately", async () => {
  const child = new EventEmitter();
  let killCalls = 0;
  child.kill = () => {
    killCalls += 1;
  };
  const controller = new AbortController();
  const cancellation = new Error("test cancellation");
  const opening = openBrowser("http://127.0.0.1:45678/?nonce=must-not-leak", {
    platform: "darwin",
    spawnProcess: () => child,
    openerTimeoutMs: 10_000,
    signal: controller.signal,
  });
  controller.abort(cancellation);

  await assert.rejects(opening, (error) => error === cancellation);
  assert.equal(killCalls, 1);
});

test("bridge maps parent and related contexts to stable read-only paths", () => {
  const contexts = buildRunContextSpecifications(runId, {
    company: { workspaceId: companyWorkspaceId, head: companyHead },
    related: [{
      workspaceId: relatedWorkspaceId,
      head: relatedHead,
      scopeType: "task",
      scopeKey: "task:with/slash",
    }],
  });

  assert.equal(contexts.length, 2);
  assert.deepEqual(contexts.map((context) => context.dependencyKind), ["company", "related"]);
  assert.equal(contexts[0].relativeDirectory, path.join("context", "company"));
  assert.equal(
    contexts[1].relativeDirectory,
    path.join("context", "related", relatedWorkspaceId),
    "untrusted scopeKey must not become a local path segment",
  );
  assert.equal(
    contexts[1].endpoint,
    `/api/agent-workspaces/runs/${runId}/context/related/${relatedWorkspaceId}/bundle`,
  );
});

test("bridge rejects duplicate workspace ids and malformed pinned heads", () => {
  assert.throws(() => buildRunContextSpecifications(runId, {
    company: { workspaceId: companyWorkspaceId, head: companyHead },
    related: [{ workspaceId: companyWorkspaceId, head: relatedHead, scopeType: "company" }],
  }), /повторяется/);
  assert.throws(() => buildRunContextSpecifications(runId, {
    related: [{ workspaceId: relatedWorkspaceId, head: "main", scopeType: "task" }],
  }), /Git head/);
});

test("bridge open keeps a large parent context pointer-first and downloads zero object bytes", {
  timeout: 15_000,
}, async () => {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "trelio-bridge-lazy-open-"));
  const homeDirectory = path.join(temporaryDirectory, "home");
  const rootDirectory = path.join(temporaryDirectory, "materialized-run");
  const writableWorkspaceId = "44444444-4444-4444-8444-444444444444";
  const platformRulesRevisionId = "88888888-8888-4888-8888-888888888888";
  const platformRulesMarkdown = [
    "# Платформенные правила Agent Workspaces",
    "",
    "Маркер проверенного правила локальных ссылок.",
    "",
  ].join("\n");
  const platformRulesSha256 = createHash("sha256")
    .update(platformRulesMarkdown, "utf8")
    .digest("hex");
  const largeDigest = "d".repeat(64);
  const largePointer = [
    "version https://trelio.ru/spec/workspace-object/v1",
    `oid sha256:${largeDigest}`,
    `size ${757 * 1024 * 1024}`,
    "content-type application/pdf",
    "",
  ].join("\n");
  const [baseExport, companyExport] = await Promise.all([
    createExportBundle(path.join(temporaryDirectory, "base"), {
      "WORKSPACE_CONTEXT.md": "# Task context\n",
    }),
    createExportBundle(path.join(temporaryDirectory, "company"), {
      "WORKSPACE_CONTEXT.md": "# Company context\n",
      "sources/large-parent.pdf": largePointer,
    }),
  ]);
  const seenUrls = [];
  let compatibilityRequests = 0;
  let serverError = null;

  const server = createServer(async (request, response) => {
    try {
      seenUrls.push(request.url || "");
      assert.equal(request.headers["x-trelio-agent-workspaces-version"], BRIDGE_VERSION);
      assert.equal(request.headers.authorization, "Bearer integration-token");

      if (request.url === "/api/agent-workspaces/bridge-compatibility") {
        compatibilityRequests += 1;
        response.setHeader("content-type", "application/json");
        const hasCurrentRules = (
          request.headers["x-trelio-agent-rules-sha256"]
          === platformRulesSha256
        );
        response.end(JSON.stringify({
          supported: true,
          minimumVersion: BRIDGE_VERSION,
          agentRules: {
            status: hasCurrentRules ? "current" : "update_required",
            revisionId: platformRulesRevisionId,
            version: 1,
            sha256: platformRulesSha256,
            ...(hasCurrentRules ? {} : { rulesMarkdown: platformRulesMarkdown }),
          },
        }));
        return;
      }

      if (
        request.method === "POST"
        && request.url === `/api/agent-workspaces/workspaces/${writableWorkspaceId}/runs`
      ) {
        const startPayload = JSON.parse(
          (await readRequestBody(request)).toString("utf8"),
        );
        assert.equal(startPayload.platformRulesSha256, platformRulesSha256);
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({
          run: {
            id: runId,
            leaseId: "55555555-5555-4555-8555-555555555555",
            fencingToken: 1,
            baseHead: baseExport.head,
            contextHeadsJson: {
              company: {
                workspaceId: companyWorkspaceId,
                head: companyExport.head,
                scopeType: "company",
                scopeKey: "company",
              },
            },
            agentInstructionsSnapshotJson: {
              // Backend может добавлять управляемые policy metadata без
              // обновления transport: bridge обязан материализовать exact
              // compiledMarkdown и не отбрасывать новую инструкцию.
              schemaVersion: 3,
              platform: {
                revisionId: platformRulesRevisionId,
                version: 1,
                sha256: platformRulesSha256,
                rulesMarkdown: platformRulesMarkdown,
              },
              company: null,
              project: null,
              followUpPolicy: {
                mode: "confirm",
                revisionId: null,
                version: 0,
                instructionsMarkdown: "Спроси пользователя перед созданием автопроверки.",
              },
              compiledMarkdown: [
                "# Рабочие правила агентов Trelio",
                "",
                platformRulesMarkdown.trim(),
                "",
                "## Плановые проверки агентом",
                "",
                "Спроси пользователя перед созданием автопроверки.",
                "",
              ].join("\n"),
            },
            userProfileSnapshotJson: {
              schemaVersion: 1,
              profile: {
                revisionId: "77777777-7777-4777-8777-777777777777",
                version: 3,
                instructionsMarkdown: "Пиши коротко.\n",
              },
              compiledMarkdown: "# Как агенту работать со мной\n\nПиши коротко.\n",
            },
          },
          workspace: { id: writableWorkspaceId },
        }));
        return;
      }

      if (request.url === `/api/agent-workspaces/runs/${runId}/bundle`) {
        response.setHeader("content-type", "application/octet-stream");
        response.end(baseExport.bundle);
        return;
      }

      if (request.url === `/api/agent-workspaces/runs/${runId}/context/company/bundle`) {
        response.setHeader("content-type", "application/octet-stream");
        response.end(companyExport.bundle);
        return;
      }

      if (request.url?.includes("/objects/") || request.url?.includes("/context-objects/")) {
        throw new Error(`open must not request external object bytes: ${request.url}`);
      }

      response.statusCode = 404;
      response.end();
    } catch (error) {
      serverError = error;
      response.statusCode = 500;
      response.end(error instanceof Error ? error.message : String(error));
    }
  });

  try {
    await mkdir(homeDirectory, { recursive: true });
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const serverAddress = server.address();
    assert.ok(serverAddress && typeof serverAddress === "object");
    const origin = `http://127.0.0.1:${serverAddress.port}`;
    await writeTestCredential(homeDirectory, origin);

    const opened = await execFileAsync(
      process.execPath,
      [
        bridgePath,
        "open",
        "--origin",
        origin,
        "--workspace",
        writableWorkspaceId,
        "--dir",
        rootDirectory,
      ],
      {
        cwd: temporaryDirectory,
        encoding: "utf8",
        timeout: 10_000,
        env: { ...process.env, HOME: homeDirectory },
      },
    );

    assert.equal(opened.stdout.trim(), path.join(rootDirectory, "workspace"));
    assert.equal(
      await readFile(path.join(rootDirectory, "workspace", "AGENTS.md"), "utf8"),
      AGENT_WORKSPACE_RUNTIME_AGENTS_MARKDOWN,
    );
    assert.match(
      AGENT_WORKSPACE_RUNTIME_AGENTS_MARKDOWN,
      /Перед корпоративными данными или внешней системой вызови `list_agent_skills`/u,
    );
    assert.match(AGENT_WORKSPACE_RUNTIME_AGENTS_MARKDOWN, /`remoteMcpExecution`/u);
    assert.match(
      AGENT_WORKSPACE_RUNTIME_AGENTS_MARKDOWN,
      /Не обходи доступный навык браузером, Computer Use, прямым HTTP, альтернативным MCP или скриптом/u,
    );
    assert.match(
      AGENT_WORKSPACE_RUNTIME_AGENTS_MARKDOWN,
      /Fallback допустим, когда релевантного навыка нет/u,
    );
    assert.match(AGENT_WORKSPACE_RUNTIME_AGENTS_MARKDOWN, /`no_access` \/ `needs_reconnect`/u);
    assert.match(AGENT_WORKSPACE_RUNTIME_AGENTS_MARKDOWN, /а не отказывайся из-за отсутствия или недоступности навыка/u);
    assert.match(AGENT_WORKSPACE_RUNTIME_AGENTS_MARKDOWN, /ту же защищённую систему другим путём/u);
    assert.match(
      AGENT_WORKSPACE_RUNTIME_AGENTS_MARKDOWN,
      /Trelio MCP и bundled bridge остаются штатным workflow/u,
    );
    assert.match(
      AGENT_WORKSPACE_RUNTIME_AGENTS_MARKDOWN,
      /не ищи для этих операций отдельный catalog skill/u,
    );
    assert.equal(
      await readFile(path.join(rootDirectory, "workspace", "CLAUDE.md"), "utf8"),
      AGENT_WORKSPACE_RUNTIME_CLAUDE_MARKDOWN,
    );
    assert.equal(
      await readFile(path.join(rootDirectory, "context", "user-profile.md"), "utf8"),
      "# Как агенту работать со мной\n\nПиши коротко.\n",
    );
    assert.match(
      await readFile(path.join(rootDirectory, "context", "agent-instructions.md"), "utf8"),
      /Маркер проверенного правила локальных ссылок/u,
    );
    assert.match(
      await readFile(path.join(rootDirectory, "context", "agent-instructions.md"), "utf8"),
      /Спроси пользователя перед созданием автопроверки/u,
    );
    const contextIndex = JSON.parse(
      await readFile(path.join(rootDirectory, "context", "index.json"), "utf8"),
    );
    assert.equal(contextIndex.userProfile.profile.revisionId, "77777777-7777-4777-8777-777777777777");
    assert.match(AGENT_WORKSPACE_RUNTIME_AGENTS_MARKDOWN, /plan_my_agent_profile_update/u);
    assert.match(AGENT_WORKSPACE_RUNTIME_AGENTS_MARKDOWN, /user-profile\.md/u);
    assert.match(
      AGENT_WORKSPACE_RUNTIME_AGENTS_MARKDOWN,
      /render_task_comment_proposal/u,
    );
    assert.match(AGENT_WORKSPACE_RUNTIME_AGENTS_MARKDOWN, /publicCommentsSnapshot/u);
    assert.match(AGENT_WORKSPACE_RUNTIME_AGENTS_MARKDOWN, /dismiss_task_comment_proposal/u);
    assert.match(AGENT_WORKSPACE_RUNTIME_AGENTS_MARKDOWN, /private\/unpublished/u);
    assert.match(
      AGENT_WORKSPACE_RUNTIME_AGENTS_MARKDOWN,
      /не блокируй handoff\/submit из-за manual comment/u,
    );
    assert.match(AGENT_WORKSPACE_RUNTIME_AGENTS_MARKDOWN, /filePaths/u);
    assert.match(
      AGENT_WORKSPACE_RUNTIME_AGENTS_MARKDOWN,
      /не все workspace-файлы/u,
    );
    assert.equal(
      await getGitStatus(path.join(rootDirectory, "workspace")),
      "",
      "runtime control files and an untouched reproducible WORKLOG fallback must not make the Run dirty",
    );
    assert.equal(
      (await runGit(path.join(rootDirectory, "workspace"), ["status", "--porcelain"])).stdout,
      "?? WORKLOG.md\n",
      "the default WORKLOG stays a normal candidate file once substantive Run changes exist",
    );
    assert.equal(
      (await runGit(path.join(rootDirectory, "workspace"), [
        "ls-files",
        "--",
        "AGENTS.md",
        "CLAUDE.md",
      ])).stdout,
      "",
      "format-v4 accepted Git must not track runtime control files",
    );
    assert.equal(
      await readFile(
        path.join(rootDirectory, "context", "company", "sources", "large-parent.pdf"),
        "utf8",
      ),
      largePointer,
    );
    assert.equal(
      seenUrls.filter((url) => url.includes("/objects/") || url.includes("/context-objects/")).length,
      0,
    );
    assert.equal(
      compatibilityRequests,
      2,
      "bridge must confirm the freshly cached SHA-256 in a second preflight",
    );
    assert.ifError(serverError);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    if (process.platform !== "win32") {
      await execFileAsync("chmod", ["-R", "u+w", temporaryDirectory]).catch(() => undefined);
    }
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test("blocker checkpoint transfers the exact draft and continuation state to another device", {
  timeout: 20_000,
}, async () => {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "trelio-bridge-draft-resume-"));
  const firstHomeDirectory = path.join(temporaryDirectory, "home-first");
  const secondHomeDirectory = path.join(temporaryDirectory, "home-second");
  const firstRootDirectory = path.join(temporaryDirectory, "run-first");
  const secondRootDirectory = path.join(temporaryDirectory, "run-second");
  const draftRepository = path.join(temporaryDirectory, "draft-repository");
  const baseImportPath = path.join(temporaryDirectory, "base-import.bundle");
  const draftUploadPath = path.join(temporaryDirectory, "uploaded-draft.bundle");
  const draftExportPath = path.join(temporaryDirectory, "exported-draft.bundle");
  const writableWorkspaceId = "44444444-4444-4444-8444-444444444444";
  const firstLeaseId = "55555555-5555-4555-8555-555555555555";
  const secondLeaseId = "66666666-6666-4666-8666-666666666666";
  const checkpointId = "77777777-7777-4777-8777-777777777777";
  const baseExport = await createExportBundle(path.join(temporaryDirectory, "base"), {
    "WORKSPACE_CONTEXT.md": "# Task context\n",
  });
  let draftHead = null;
  let draftBundle = null;
  let checkpointPayload = null;
  let currentStatus = "running";
  let fencingToken = 1;
  let serverError = null;

  await mkdir(draftRepository, { recursive: true });
  await runGit(draftRepository, ["init", "--initial-branch=main"]);
  // Реальный backend уже хранит pinned base commit в bare repository. Fake
  // server импортирует его заранее, потому что draft bundle намеренно передаёт
  // только delta и перечисляет base commit как prerequisite.
  await writeFile(baseImportPath, baseExport.bundle);
  await runGit(draftRepository, [
    "fetch",
    baseImportPath,
    "+refs/trelio/exports/*:refs/remotes/base-export/*",
  ]);

  const serializeRun = () => ({
    id: runId,
    status: currentStatus,
    leaseId: fencingToken === 1 ? firstLeaseId : secondLeaseId,
    fencingToken,
    baseHead: baseExport.head,
    draftHead,
    contextHeadsJson: {},
    agentInstructionsSnapshotJson: {
      schemaVersion: 1,
      company: null,
      project: null,
      compiledMarkdown: "# Рабочие правила агентов Trelio\n",
    },
    userProfileSnapshotJson: {
      schemaVersion: 1,
      profile: null,
      compiledMarkdown: "# Как агенту работать со мной\n",
    },
  });

  const server = createServer(async (request, response) => {
    try {
      const body = request.method === "POST" ? await readRequestBody(request) : Buffer.alloc(0);
      assert.equal(request.headers["x-trelio-agent-workspaces-version"], BRIDGE_VERSION);
      assert.equal(request.headers.authorization, "Bearer integration-token");

      if (request.url === "/api/agent-workspaces/bridge-compatibility") {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ supported: true, minimumVersion: BRIDGE_VERSION }));
        return;
      }

      if (
        request.method === "POST"
        && request.url === `/api/agent-workspaces/workspaces/${writableWorkspaceId}/runs`
      ) {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({
          run: serializeRun(),
          workspace: { id: writableWorkspaceId, acceptedHead: baseExport.head },
        }));
        return;
      }

      if (request.url === `/api/agent-workspaces/runs/${runId}/heartbeat`) {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({
          ...serializeRun(),
          leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
        }));
        return;
      }

      if (
        request.method === "POST"
        && request.url === `/api/agent-workspaces/runs/${runId}/draft`
      ) {
        assert.ok(body.byteLength > 0, "blocker must upload a non-empty draft bundle");
        await writeFile(draftUploadPath, body);
        await runGit(draftRepository, [
          "fetch",
          draftUploadPath,
          "+refs/heads/trelio-candidate:refs/heads/draft",
        ]);
        draftHead = (await runGit(draftRepository, ["rev-parse", "refs/heads/draft"])).stdout.trim();
        assert.notEqual(draftHead, baseExport.head);
        await runGit(draftRepository, [
          "update-ref",
          `refs/trelio/exports/${runId}`,
          draftHead,
        ]);
        await runGit(draftRepository, [
          "bundle",
          "create",
          draftExportPath,
          `refs/trelio/exports/${runId}`,
        ]);
        draftBundle = await readFile(draftExportPath);
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({
          run: {
            ...serializeRun(),
            draftUpdatedAt: new Date().toISOString(),
          },
          draft: { head: draftHead, baseHead: baseExport.head },
        }));
        return;
      }

      if (
        request.method === "POST"
        && request.url === `/api/agent-workspaces/runs/${runId}/checkpoints`
      ) {
        checkpointPayload = JSON.parse(body.toString("utf8"));
        assert.equal(checkpointPayload.checkpointType, "blocker");
        assert.equal(checkpointPayload.draftHead, draftHead);
        assert.deepEqual(checkpointPayload.openQuestions, ["Какой вариант согласовать?"]);
        assert.equal(
          checkpointPayload.nextAction.instruction,
          "Выберите вариант, затем продолжите этот Run.",
        );
        currentStatus = "waiting_for_human";
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({
          id: checkpointId,
          runId,
          checkpointType: "blocker",
          candidateHead: draftHead,
          summary: checkpointPayload.summary,
          evidenceJson: [],
          filesChangedJson: checkpointPayload.filesChanged || [],
          openQuestionsJson: checkpointPayload.openQuestions,
          nextActionJson: checkpointPayload.nextAction,
          createdAt: new Date().toISOString(),
        }));
        return;
      }

      if (
        request.method === "GET"
        && request.url === `/api/agent-workspaces/workspaces/${writableWorkspaceId}`
      ) {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({
          workspace: { id: writableWorkspaceId, acceptedHead: baseExport.head },
          runs: [serializeRun()],
          checkpoints: checkpointPayload
            ? [{
                id: checkpointId,
                runId,
                checkpointType: "blocker",
                candidateHead: draftHead,
                summary: checkpointPayload.summary,
                evidenceJson: [],
                filesChangedJson: checkpointPayload.filesChanged || [],
                openQuestionsJson: checkpointPayload.openQuestions,
                nextActionJson: checkpointPayload.nextAction,
                createdAt: new Date().toISOString(),
              }]
            : [],
        }));
        return;
      }

      if (
        request.method === "POST"
        && request.url === `/api/agent-workspaces/runs/${runId}/claim`
      ) {
        const claim = JSON.parse(body.toString("utf8"));
        assert.equal(currentStatus, "waiting_for_human");
        assert.equal(claim.expectedFencingToken, fencingToken);
        fencingToken += 1;
        currentStatus = "running";
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify(serializeRun()));
        return;
      }

      if (request.url === `/api/agent-workspaces/runs/${runId}/bundle`) {
        response.setHeader("content-type", "application/vnd.git.bundle");
        response.end(draftBundle || baseExport.bundle);
        return;
      }

      response.statusCode = 404;
      response.end();
    } catch (error) {
      serverError = error;
      response.statusCode = 500;
      response.end(error instanceof Error ? error.message : String(error));
    }
  });

  try {
    await Promise.all([
      mkdir(firstHomeDirectory, { recursive: true }),
      mkdir(secondHomeDirectory, { recursive: true }),
    ]);
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const serverAddress = server.address();
    assert.ok(serverAddress && typeof serverAddress === "object");
    const origin = `http://127.0.0.1:${serverAddress.port}`;
    await Promise.all([
      writeTestCredential(firstHomeDirectory, origin),
      writeTestCredential(secondHomeDirectory, origin),
    ]);

    await execFileAsync(
      process.execPath,
      [
        bridgePath,
        "open",
        "--origin",
        origin,
        "--workspace",
        writableWorkspaceId,
        "--dir",
        firstRootDirectory,
      ],
      {
        cwd: temporaryDirectory,
        encoding: "utf8",
        timeout: 10_000,
        env: { ...process.env, HOME: firstHomeDirectory },
      },
    );
    const firstWorkspaceDirectory = path.join(firstRootDirectory, "workspace");
    await mkdir(path.join(firstWorkspaceDirectory, "artifacts"), { recursive: true });
    await writeFile(
      path.join(firstWorkspaceDirectory, "artifacts", "decision.md"),
      "# Варианты решения\n\nDraft с первого компьютера.\n",
      "utf8",
    );

    const checkpointed = await execFileAsync(
      process.execPath,
      [
        bridgePath,
        "checkpoint",
        "--type",
        "blocker",
        "--summary",
        "Подготовлены варианты, нужен выбор человека.",
        "--question",
        "Какой вариант согласовать?",
        "--next-action",
        "Выберите вариант, затем продолжите этот Run.",
      ],
      {
        cwd: firstWorkspaceDirectory,
        encoding: "utf8",
        timeout: 10_000,
        env: { ...process.env, HOME: firstHomeDirectory },
      },
    );
    assert.match(checkpointed.stdout, /Draft snapshot сохранён/u);
    assert.match(checkpointed.stdout, /Checkpoint сохранён/u);
    assert.equal(currentStatus, "waiting_for_human");
    assert.ok(draftHead);

    await execFileAsync(
      process.execPath,
      [
        bridgePath,
        "open",
        "--origin",
        origin,
        "--workspace",
        writableWorkspaceId,
        "--run",
        runId,
        "--dir",
        secondRootDirectory,
      ],
      {
        cwd: temporaryDirectory,
        encoding: "utf8",
        timeout: 10_000,
        env: { ...process.env, HOME: secondHomeDirectory },
      },
    );

    assert.equal(
      await readFile(
        path.join(secondRootDirectory, "workspace", "artifacts", "decision.md"),
        "utf8",
      ),
      "# Варианты решения\n\nDraft с первого компьютера.\n",
    );
    const transferredCheckpoint = JSON.parse(
      await readFile(
        path.join(secondRootDirectory, "context", "run-checkpoint.json"),
        "utf8",
      ),
    );
    assert.equal(transferredCheckpoint.checkpointId, checkpointId);
    assert.equal(transferredCheckpoint.draftHead, draftHead);
    assert.deepEqual(transferredCheckpoint.openQuestions, ["Какой вариант согласовать?"]);
    assert.equal(
      transferredCheckpoint.nextAction.instruction,
      "Выберите вариант, затем продолжите этот Run.",
    );
    assert.equal(currentStatus, "running");
    assert.equal(
      baseExport.head,
      JSON.parse(
        await readFile(path.join(secondRootDirectory, ".trelio-run.json"), "utf8"),
      ).baseHead,
      "server draft must not replace the accepted base head",
    );
    assert.ifError(serverError);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    if (process.platform !== "win32") {
      await execFileAsync("chmod", ["-R", "u+w", temporaryDirectory]).catch(() => undefined);
    }
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test("context fetch downloads one exact path, reuses verified cache and rejects tampered cache", {
  timeout: 15_000,
}, async () => {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "trelio-bridge-context-fetch-"));
  const homeDirectory = path.join(temporaryDirectory, "home");
  const objectBytes = Buffer.from("exact lazy workspace object bytes", "utf8");
  const objectDigest = createHash("sha256").update(objectBytes).digest("hex");
  const pointer = [
    "version https://trelio.ru/spec/workspace-object/v1",
    `oid sha256:${objectDigest}`,
    `size ${objectBytes.byteLength}`,
    "content-type application/octet-stream",
    "",
  ].join("\n");
  const runIds = [
    runId,
    "66666666-6666-4666-8666-666666666666",
    "77777777-7777-4777-8777-777777777777",
  ];
  let authorizationRequests = 0;
  let objectDownloads = 0;
  let serverError = null;

  const server = createServer(async (request, response) => {
    try {
      if (request.url?.startsWith("/api/agent-workspaces/runs/")) {
        authorizationRequests += 1;
        const url = new URL(request.url, "http://127.0.0.1");
        assert.equal(url.searchParams.get("head"), companyHead);
        assert.equal(url.searchParams.get("path"), "sources/exact.bin");
        assert.equal(url.searchParams.get("sha256"), objectDigest);
        assert.equal(url.searchParams.get("sizeBytes"), String(objectBytes.byteLength));
        assert.match(
          url.pathname,
          new RegExp(`/context-objects/${companyWorkspaceId}$`),
        );
        const address = server.address();
        assert.ok(address && typeof address === "object");
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({
          workspaceId: companyWorkspaceId,
          workspaceHead: companyHead,
          filePath: "sources/exact.bin",
          sha256: objectDigest,
          sizeBytes: objectBytes.byteLength,
          contentType: "application/octet-stream",
          url: `http://127.0.0.1:${address.port}/signed-object`,
        }));
        return;
      }

      if (request.url === "/signed-object") {
        objectDownloads += 1;
        response.setHeader("content-type", "application/octet-stream");
        response.end(objectBytes);
        return;
      }

      response.statusCode = 404;
      response.end();
    } catch (error) {
      serverError = error;
      response.statusCode = 500;
      response.end(error instanceof Error ? error.message : String(error));
    }
  });

  const createMaterializedRun = async (origin, currentRunId, suffix) => {
    const rootDirectory = path.join(temporaryDirectory, `run-${suffix}`);
    const workspaceDirectory = path.join(rootDirectory, "workspace");
    const contextDirectory = path.join(rootDirectory, "context", "company");
    const objectPath = path.join(contextDirectory, "sources", "exact.bin");
    await mkdir(workspaceDirectory, { recursive: true });
    await mkdir(path.dirname(objectPath), { recursive: true });
    await writeFile(objectPath, pointer, "utf8");
    await writeFile(
      path.join(rootDirectory, ".trelio-run.json"),
      `${JSON.stringify({
        schemaVersion: 3,
        origin,
        pluginVersion: BRIDGE_VERSION,
        workspaceId: "44444444-4444-4444-8444-444444444444",
        runId: currentRunId,
        workspaceDirectory,
        contexts: [{
          dependencyKind: "company",
          workspaceId: companyWorkspaceId,
          head: companyHead,
          directory: contextDirectory,
        }],
        objects: [],
      }, null, 2)}\n`,
      { mode: 0o600 },
    );
    return { rootDirectory, workspaceDirectory, objectPath };
  };

  try {
    await mkdir(homeDirectory, { recursive: true });
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const serverAddress = server.address();
    assert.ok(serverAddress && typeof serverAddress === "object");
    const origin = `http://127.0.0.1:${serverAddress.port}`;
    await writeTestCredential(homeDirectory, origin);

    const firstRun = await createMaterializedRun(origin, runIds[0], "first");
    const firstFetch = await execFileAsync(
      process.execPath,
      [bridgePath, "context", "fetch", "--path", firstRun.objectPath],
      {
        cwd: firstRun.rootDirectory,
        encoding: "utf8",
        env: { ...process.env, HOME: homeDirectory },
      },
    );
    assert.match(firstFetch.stdout, /Trelio object storage/);
    assert.deepEqual(await readFile(firstRun.objectPath), objectBytes);
    assert.equal(authorizationRequests, 1);
    assert.equal(objectDownloads, 1);

    const secondRun = await createMaterializedRun(origin, runIds[1], "second");
    const secondFetch = await execFileAsync(
      process.execPath,
      [bridgePath, "context", "fetch", "--path", secondRun.objectPath],
      {
        cwd: secondRun.rootDirectory,
        encoding: "utf8",
        env: { ...process.env, HOME: homeDirectory },
      },
    );
    assert.match(secondFetch.stdout, /локальный cache/);
    assert.deepEqual(await readFile(secondRun.objectPath), objectBytes);
    assert.equal(authorizationRequests, 2, "every Run still requires exact backend authorization");
    assert.equal(objectDownloads, 1, "the second Run must not redownload verified bytes");

    const cachePath = path.join(
      homeDirectory,
      ".cache",
      "trelio",
      "workspace-bridge",
      "objects",
      objectDigest.slice(0, 2),
      objectDigest,
    );
    await writeFile(cachePath, Buffer.alloc(objectBytes.byteLength, 0x78));
    const thirdRun = await createMaterializedRun(origin, runIds[2], "third");
    const thirdFetch = await execFileAsync(
      process.execPath,
      [bridgePath, "context", "fetch", "--path", thirdRun.objectPath],
      {
        cwd: thirdRun.rootDirectory,
        encoding: "utf8",
        env: { ...process.env, HOME: homeDirectory },
      },
    );
    assert.match(thirdFetch.stdout, /Trelio object storage/);
    assert.deepEqual(await readFile(thirdRun.objectPath), objectBytes);
    assert.equal(authorizationRequests, 3);
    assert.equal(objectDownloads, 2, "tampered cache bytes must be discarded and downloaded again");
    assert.ifError(serverError);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    if (process.platform !== "win32") {
      await execFileAsync("chmod", ["-R", "u+w", temporaryDirectory]).catch(() => undefined);
    }
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test("clean lists exact reclaimable roots and never removes active, unknown or dirty Runs", {
  timeout: 15_000,
}, async () => {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "trelio-bridge-clean-"));
  const homeDirectory = path.join(temporaryDirectory, "home");
  const configDirectory = path.join(homeDirectory, ".config", "trelio", "workspace-bridge");
  const workspaceId = "44444444-4444-4444-8444-444444444444";
  const acceptedRunId = runId;
  const dirtyRunId = "66666666-6666-4666-8666-666666666666";
  const activeRunId = "77777777-7777-4777-8777-777777777777";
  const unknownRunId = "88888888-8888-4888-8888-888888888888";
  const roots = new Map();
  let serverError = null;

  const createLocalRunRoot = async (origin, name, currentRunId, dirty = false) => {
    const rootDirectory = path.join(temporaryDirectory, name);
    const workspaceDirectory = path.join(rootDirectory, "workspace");
    await mkdir(workspaceDirectory, { recursive: true });
    await runGit(workspaceDirectory, ["init", "--initial-branch=trelio-candidate"]);
    await runGit(workspaceDirectory, ["config", "user.name", "Trelio Bridge Test"]);
    await runGit(workspaceDirectory, ["config", "user.email", "bridge-test@trelio.local"]);
    await writeFile(path.join(workspaceDirectory, "README.md"), "# Clean test\n", "utf8");
    await runGit(workspaceDirectory, ["add", "README.md"]);
    await runGit(workspaceDirectory, ["commit", "-m", "Clean base"]);

    if (dirty) {
      await writeFile(path.join(workspaceDirectory, "local-draft.md"), "Do not delete\n", "utf8");
    }

    await writeFile(
      path.join(rootDirectory, ".trelio-run.json"),
      `${JSON.stringify({
        schemaVersion: 3,
        origin,
        pluginVersion: BRIDGE_VERSION,
        workspaceId,
        runId: currentRunId,
        workspaceDirectory,
        objects: [],
        contextObjects: [],
      }, null, 2)}\n`,
      { mode: 0o600 },
    );
    roots.set(name, rootDirectory);
    return rootDirectory;
  };

  const server = createServer(async (request, response) => {
    try {
      assert.equal(request.headers["x-trelio-agent-workspaces-version"], BRIDGE_VERSION);
      assert.equal(request.headers.authorization, "Bearer integration-token");

      if (request.url === "/api/agent-workspaces/bridge-compatibility") {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ supported: true, minimumVersion: BRIDGE_VERSION }));
        return;
      }

      if (request.url === `/api/agent-workspaces/workspaces/${workspaceId}`) {
        const oldTimestamp = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({
          runs: [
            { id: acceptedRunId, status: "accepted", acceptedAt: oldTimestamp },
            { id: dirtyRunId, status: "accepted", acceptedAt: oldTimestamp },
            { id: activeRunId, status: "active", updatedAt: oldTimestamp },
          ],
        }));
        return;
      }

      response.statusCode = 404;
      response.end();
    } catch (error) {
      serverError = error;
      response.statusCode = 500;
      response.end(error instanceof Error ? error.message : String(error));
    }
  });

  try {
    await mkdir(homeDirectory, { recursive: true });
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const serverAddress = server.address();
    assert.ok(serverAddress && typeof serverAddress === "object");
    const origin = `http://127.0.0.1:${serverAddress.port}`;
    await writeTestCredential(homeDirectory, origin);
    const acceptedRoot = await createLocalRunRoot(origin, "accepted-clean", acceptedRunId);
    const dirtyRoot = await createLocalRunRoot(origin, "accepted-dirty", dirtyRunId, true);
    const activeRoot = await createLocalRunRoot(origin, "active", activeRunId);
    const unknownRoot = await createLocalRunRoot(origin, "unknown", unknownRunId);
    await mkdir(configDirectory, { recursive: true });
    await writeFile(
      path.join(configDirectory, "settings.json"),
      `${JSON.stringify({
        terminalRunRetentionDays: 1,
        objectCacheMaxAgeDays: 30,
        objectCacheMaxBytes: 10 * 1024 * 1024 * 1024,
      }, null, 2)}\n`,
      { mode: 0o600 },
    );
    await writeFile(
      path.join(configDirectory, "runs.json"),
      `${JSON.stringify({
        schemaVersion: 1,
        roots: [acceptedRoot, dirtyRoot, activeRoot, unknownRoot],
      }, null, 2)}\n`,
      { mode: 0o600 },
    );

    const preview = await execFileAsync(
      process.execPath,
      [bridgePath, "clean", "--dry-run", "--origin", origin],
      {
        cwd: temporaryDirectory,
        encoding: "utf8",
        env: { ...process.env, HOME: homeDirectory },
      },
    );
    assert.match(preview.stdout, /Terminal Run roots: 1/);
    assert.match(preview.stdout, /accepted-clean/);
    assert.doesNotMatch(preview.stdout, /accepted-dirty/);
    assert.equal(await pathExists(acceptedRoot), true, "dry-run must not delete candidates");

    const cleaned = await execFileAsync(
      process.execPath,
      [bridgePath, "clean", "--origin", origin],
      {
        cwd: temporaryDirectory,
        encoding: "utf8",
        env: { ...process.env, HOME: homeDirectory },
      },
    );
    assert.match(cleaned.stdout, /Очистка завершена/);
    assert.equal(await pathExists(acceptedRoot), false);
    assert.equal(await pathExists(dirtyRoot), true);
    assert.equal(await pathExists(activeRoot), true);
    assert.equal(await pathExists(unknownRoot), true);
    assert.ifError(serverError);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test("bridge release version stays synchronized across executable and manifests", async () => {
  const codexManifest = JSON.parse(await readFile(
    path.join(pluginDirectory, ".codex-plugin", "plugin.json"),
    "utf8",
  ));
  const claudeManifest = JSON.parse(await readFile(
    path.join(pluginDirectory, ".claude-plugin", "plugin.json"),
    "utf8",
  ));
  const mcpManifest = JSON.parse(await readFile(
    path.join(pluginDirectory, ".mcp.json"),
    "utf8",
  ));
  const claudeMarketplace = JSON.parse(await readFile(
    path.resolve(pluginDirectory, "..", "..", ".claude-plugin", "marketplace.json"),
    "utf8",
  ));
  const claudeMarketplaceEntry = claudeMarketplace.plugins.find(
    (plugin) => plugin.name === "trelio-agent-workspaces",
  );

  assert.equal(BRIDGE_VERSION, "1.6.21");
  assert.equal(codexManifest.version, BRIDGE_VERSION);
  assert.equal(claudeManifest.version, BRIDGE_VERSION);
  assert.equal(claudeMarketplaceEntry?.version, BRIDGE_VERSION);
  assert.deepEqual(mcpManifest.mcpServers["trelio-remote-skills"], {
    command: "node",
    args: ["./scripts/trelio-remote-mcp.mjs"],
    cwd: ".",
    tool_timeout_sec: 660,
  });
});

test("compact protected runtime keeps the complete agent safety contract", () => {
  // The runtime text is intentionally short, so pin semantic identifiers and
  // boundaries instead of the former long prose. This catches accidental rule
  // loss without making harmless editorial changes fail the regression.
  for (const identifier of [
    "plan_my_agent_profile_update",
    "plan_agent_instructions_update",
    "list_agent_skills",
    "get_agent_skill",
    "AGENT_SKILL_RELEASE_CHANGED",
    "get_task_comment_proposal_context",
    "render_task_comment_proposal",
    "dismiss_task_comment_proposal",
    "publish_task_comment_proposal",
    "create_comment",
    "get_task",
    "create_task_control",
    "update_task_control",
    "clear_task_control",
    "work_completed",
    "review_passed",
    "direct_completion",
    "no_status_change",
  ]) {
    assert.match(AGENT_WORKSPACE_RUNTIME_AGENTS_MARKDOWN, new RegExp(identifier, "u"));
  }

  for (const invariant of [
    /Не изменяй `AGENTS\.md`, `CLAUDE\.md`, `\.trelio\/\*\*`/u,
    /`\.\.\/context\/agent-instructions\.md`.*`\.\.\/context\/user-profile\.md`.*`\.\.\/context\/run-checkpoint\.json`.*`WORKSPACE_CONTEXT\.md`.*`WORKLOG\.md`/u,
    /не меняй attestation, hook или `\.trelio-run\.json`/u,
    /Fallback допустим, когда релевантного навыка нет/u,
    /`no_access` \/ `needs_reconnect`/u,
    /а не отказывайся из-за отсутствия или недоступности навыка/u,
    /ту же защищённую систему другим путём/u,
    /Недоступность каталога и transient network failure сами по себе не равны `no_access`/u,
    /не блокируй handoff\/submit из-за manual comment/u,
    /дата не уведомляет/u,
    /не расширяй personal в shared без полномочия/u,
    /передавай в `filePaths` только важные итоговые/u,
    /Перед блокирующим вопросом успешно сохрани переносимый checkpoint `blocker`/u,
    /Trelio примет его при актуальном base head/u,
  ]) {
    assert.match(AGENT_WORKSPACE_RUNTIME_AGENTS_MARKDOWN, invariant);
  }
});

test("workspace worker routes every high-risk scenario to a mandatory reference", async () => {
  const workerDirectory = path.join(pluginDirectory, "skills", "trelio-workspace-worker");
  const mainSkill = await readFile(path.join(workerDirectory, "SKILL.md"), "utf8");
  const references = [
    "setup-and-recovery.md",
    "instruction-management.md",
    "meetings.md",
    "scope-and-context.md",
    "dossier-transfer.md",
    "task-controls.md",
    "agent-run.md",
    "task-run.md",
    "ocr-and-vision.md",
  ];

  assert.match(mainSkill, /Read every matching reference below\s+completely before its first related tool call/u);
  assert.match(mainSkill, /If the scenario changes during\s+the task, pause and read the newly relevant reference/u);
  for (const referenceName of references) {
    assert.match(mainSkill, new RegExp(`references/${referenceName.replaceAll(".", "\\.")}`, "u"));
    const reference = await readFile(path.join(workerDirectory, "references", referenceName), "utf8");
    assert.match(reference, /Read this file completely/u);
  }
});

test("plugin exposes safe project onboarding before ordinary task work", async () => {
  const codexManifest = JSON.parse(await readFile(
    path.join(pluginDirectory, ".codex-plugin", "plugin.json"),
    "utf8",
  ));
  const workerAgentMetadata = await readFile(
    path.join(
      pluginDirectory,
      "skills",
      "trelio-workspace-worker",
      "agents",
      "openai.yaml",
    ),
    "utf8",
  );
  const onboardingSkill = await readFile(
    path.join(pluginDirectory, "skills", "trelio-project-onboarding", "SKILL.md"),
    "utf8",
  );

  assert.deepEqual(codexManifest.interface.defaultPrompt, [
    "Настрой Trelio и доступные навыки для текущего проекта.",
    "Возьми доступную задачу Trelio, выполни её, содержательно сообщи результат и сохрани материалы в рабочем пространстве.",
  ]);
  assert.match(onboardingSkill, /<!-- trelio-agent-workspaces:start -->/u);
  assert.match(onboardingSkill, /AGENTS\.override\.md/u);
  assert.match(onboardingSkill, /get_agent_instructions/u);
  assert.match(onboardingSkill, /trelio-workspace login/u);
  assert.match(onboardingSkill, /codex mcp list --json/u);
  assert.match(onboardingSkill, /Get-Command node -ErrorAction SilentlyContinue/u);
  assert.match(onboardingSkill, /winget install --id OpenJS\.NodeJS\.LTS -e/u);
  assert.match(onboardingSkill, /brew install node/u);
  assert.match(onboardingSkill, /Ask one\s+concise explicit confirmation/u);
  assert.match(onboardingSkill, /Do not install\s+`trelio-workspace` globally/u);
  assert.match(onboardingSkill, /требуется настройка администратором компании/u);
  assert.match(onboardingSkill, /Do not open a company workspace/u);
  assert.match(onboardingSkill, /full restart only if the new task/u);
  assert.doesNotMatch(onboardingSkill, /fully restart Codex, and start a new task/u);
  assert.doesNotMatch(onboardingSkill, /\[TODO:/u);
  assert.match(workerAgentMetadata, /для работы с Trelio и безопасного сохранения результата/u);
  assert.doesNotMatch(workerAgentMetadata, /массовым обычным поиском/u);
});

test("workspace skill recovers stale OAuth grants without discarding existing scopes", async () => {
  const workspaceSkill = await readSkillBundle("trelio-workspace-worker");

  assert.match(workspaceSkill, /mcp\/www_authenticate/u);
  assert.match(workspaceSkill, /`codex mcp login trelio`/u);
  assert.match(workspaceSkill, /Do not log\s+out first/u);
  assert.match(workspaceSkill, /request only the newly missing scope/u);
  assert.match(workspaceSkill, /user must review and approve/u);
  assert.match(workspaceSkill, /retry the exact low-risk read once/u);
});

test("project access skill preserves owner-only plan/apply and moderator confirmation", async () => {
  const projectAccessSkill = await readFile(
    path.join(pluginDirectory, "skills", "trelio-project-access", "SKILL.md"),
    "utf8",
  );

  // Эти проверки намеренно фиксируют не текст целиком, а ключевые policy
  // инварианты, без которых агент мог бы обойти точечный MCP-контракт.
  assert.match(projectAccessSkill, /company owner or a company\s+administrator/u);
  assert.match(projectAccessSkill, /plan_project_access_change/u);
  assert.match(projectAccessSkill, /apply_project_access_change/u);
  assert.match(projectAccessSkill, /expectedStateHash/u);
  assert.match(projectAccessSkill, /mcp:project-access:manage/u);
  assert.match(projectAccessSkill, /Granting or revoking moderator rights always/u);
  assert.match(projectAccessSkill, /project moderator cannot initiate/u);
  assert.match(projectAccessSkill, /Existing connections do not acquire the new scope/u);
  assert.match(projectAccessSkill, /may target their own direct project role/u);
  assert.match(projectAccessSkill, /does not remove their company-wide\s+project access/u);
  assert.match(projectAccessSkill, /self-change does not create a redundant\s+self-notification/u);
  assert.doesNotMatch(
    projectAccessSkill,
    /Never attempt to change the authenticated user's own direct project role/u,
  );
  assert.match(projectAccessSkill, /full project PATCH/u);
  assert.doesNotMatch(projectAccessSkill, /\[TODO:/u);
});

test("workspace skill transfers dossiers only with two-sided management authority", async () => {
  const workspaceSkill = await readSkillBundle("trelio-workspace-worker");

  assert.match(workspaceSkill, /plan_dossier_transfer/u);
  assert.match(workspaceSkill, /apply_dossier_transfer/u);
  assert.match(workspaceSkill, /manage both sides/u);
  assert.match(workspaceSkill, /Read inherited from a linked task never satisfies this check/u);
  assert.match(workspaceSkill, /confirmCompanyWideAccess: true/u);
  assert.match(workspaceSkill, /DOSSIER_TRANSFER_OUTDATED/u);
  assert.match(workspaceSkill, /Do not\s+cancel another Run/u);
  assert.match(workspaceSkill, /Dossier UUID, accepted Git history, revisions,\s+and task links must remain unchanged/u);
});

test("task handoff requires an explicit outcome and keeps unresolved work out of completion", () => {
  assert.throws(
    () => validateHandoffTaskOutcome({
      scopeType: "task",
      checkpointType: "handoff",
      taskOutcome: "",
      openQuestions: [],
    }),
    /обязательно укажите --task-outcome/u,
  );
  assert.doesNotThrow(() => validateHandoffTaskOutcome({
    scopeType: "task",
    checkpointType: "handoff",
    taskOutcome: "work_completed",
    openQuestions: [],
  }));
  assert.doesNotThrow(() => validateHandoffTaskOutcome({
    scopeType: "task",
    checkpointType: "handoff",
    taskOutcome: "no_status_change",
    openQuestions: ["Кто согласует результат?"],
  }));
  assert.throws(
    () => validateHandoffTaskOutcome({
      scopeType: "task",
      checkpointType: "handoff",
      taskOutcome: "review_passed",
      openQuestions: ["Кто согласует результат?"],
    }),
    /незакрытыми вопросами/u,
  );
  assert.throws(
    () => validateHandoffTaskOutcome({
      scopeType: "task",
      checkpointType: "draft",
      taskOutcome: "direct_completion",
      openQuestions: [],
    }),
    /только для checkpoint типа handoff/u,
  );
});

test("workspace skill keeps comment proposals non-blocking and handoff comment-free", async () => {
  const skillMarkdown = await readSkillBundle("trelio-workspace-worker");
  const bridgeSource = await readFile(bridgePath, "utf8");

  assert.match(skillMarkdown, /Do not publish automatically/u);
  assert.match(skillMarkdown, /get_task_comment_proposal_context/u);
  assert.match(skillMarkdown, /render_task_comment_proposal/u);
  assert.match(skillMarkdown, /dismiss_task_comment_proposal/u);
  assert.match(skillMarkdown, /publish_task_comment_proposal/u);
  assert.match(skillMarkdown, /publicCommentsSnapshot/u);
  assert.match(skillMarkdown, /visibility=unpublished/u);
  assert.match(skillMarkdown, /snapshotSha256/u);
  assert.match(skillMarkdown, /no public semantic delta/u);
  assert.match(skillMarkdown, /Never use `create_comment` for this proposal/u);
  assert.match(skillMarkdown, /or pause work because the proposal remains\s+unpublished/u);
  assert.match(skillMarkdown, /After acceptance/u);
  assert.match(skillMarkdown, /Include exact `filePaths`/u);
  assert.match(skillMarkdown, /Do not\s+attach all workspace files/u);
  assert.match(skillMarkdown, /Ordinary task attachments\s+are created only when the operator publishes/u);
  assert.match(skillMarkdown, /A meaningful handoff is required;\s+a manual task comment is not/u);
  assert.match(skillMarkdown, /work_completed/u);
  assert.match(skillMarkdown, /review_passed/u);
  assert.match(skillMarkdown, /direct_completion/u);
  assert.match(skillMarkdown, /no_status_change/u);
  assert.match(bridgeSource, /--task-outcome/u);
  assert.doesNotMatch(skillMarkdown, /--task-comment/u);
  assert.doesNotMatch(bridgeSource, /task-comment/u);
});

test("workspace skill keeps meeting storage private and distribution explicitly staged", async () => {
  const skillMarkdown = await readSkillBundle("trelio-workspace-worker");

  for (const toolName of [
    "create_meeting",
    "set_meeting_access",
    "record_meeting_result",
    "plan_meeting_context_updates",
    "confirm_meeting_context_updates",
    "record_meeting_context_update_outcome",
  ]) {
    assert.match(skillMarkdown, new RegExp(toolName, "u"));
  }

  assert.match(skillMarkdown, /not an Agent\s+Workspace scope/u);
  assert.match(skillMarkdown, /Do not copy\s+the full transcript/u);
  assert.match(skillMarkdown, /merely\s+mentioned or unresolved/u);
  assert.match(skillMarkdown, /expectedAccessRevision/u);
  assert.match(skillMarkdown, /one free-form Markdown document/u);
  assert.match(skillMarkdown, /one or many tasks, dossiers, projects, or the company/u);
  assert.match(skillMarkdown, /Show the complete target-grouped plan/u);
  assert.match(skillMarkdown, /never grants task\s+participants meeting access/u);
  assert.match(skillMarkdown, /never silently rewrite already\s+distributed workspaces/u);
});

test("workspace skill and protected runtime preserve task control privacy and notification semantics", async () => {
  const skillMarkdown = await readSkillBundle("trelio-workspace-worker");
  const bridgeSource = await readFile(bridgePath, "utf8");

  for (const toolName of ["create_task_control", "update_task_control", "clear_task_control"]) {
    assert.match(skillMarkdown, new RegExp(toolName, "u"));
    assert.match(bridgeSource, new RegExp(toolName, "u"));
  }

  assert.match(skillMarkdown, /Reaching `controlDate` never sends a notification/u);
  assert.match(skillMarkdown, /Never\s+widen personal to shared/u);
  assert.match(skillMarkdown, /Clearing a shared control also notifies/u);
  assert.match(skillMarkdown, /Do not clear a control because the Run completed or task status changed/u);
  assert.match(bridgeSource, /дата не уведомляет/u);
  assert.match(bridgeSource, /personal остаются приватными/u);
});

test("skills resolve the logical bridge launcher before runtime execution", async () => {
  const catalogSkill = await readFile(
    path.join(pluginDirectory, "skills", "trelio-skill-catalog", "SKILL.md"),
    "utf8",
  );
  const workspaceSkill = await readSkillBundle("trelio-workspace-worker");
  const bridgeSource = await readFile(bridgePath, "utf8");

  for (const instructions of [catalogSkill, workspaceSkill, bridgeSource]) {
    assert.match(instructions, /logical launcher|логическ(?:ий|им) launcher/u);
    assert.match(instructions, /Node\.js 22\+/u);
    assert.match(instructions, /scan plugin caches|сканируй cache/u);
  }
  assert.match(catalogSkill, /fail merely to discover it/u);
  assert.match(workspaceSkill, /merely to discover failure/u);
  assert.match(bridgeSource, /пробный failure/u);
  assert.match(catalogSkill, /not a fallback/u);
  assert.match(catalogSkill, /Do not announce/u);
  assert.match(workspaceSkill, /announce a normally missing PATH entry/u);
  assert.match(bridgeSource, /не сообщай о штатно отсутствующем PATH/u);
});

test("1C EDO secret checkout instructions avoid a nested bridge executable", async () => {
  const skillMarkdown = await readFile(
    path.resolve(pluginDirectory, "..", "..", "platform-skills", "1c-edo", "SKILL.md"),
    "utf8",
  );

  // prepare_agent_secret_checkout returns an argv prefix that already starts
  // the bridge executable. Keeping this phrase under regression prevents an
  // agent from appending the full runtime command and accidentally executing
  // `trelio-workspace ... -- trelio-workspace skill run ...`.
  assert.match(
    skillMarkdown,
    /without its first `trelio-workspace` token/,
  );
  assert.match(
    skillMarkdown,
    /trelio-workspace secret exec --grant \.\.\. -- skill run/,
  );
});

test("secret checkout self-dispatches trelio-workspace without resolving PATH", {
  timeout: 10_000,
}, async () => {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "trelio-secret-self-dispatch-"));
  const homeDirectory = path.join(temporaryDirectory, "home");
  const emptyPathDirectory = path.join(temporaryDirectory, "empty-path");
  const rootDirectory = path.join(temporaryDirectory, "run");
  const workspaceDirectory = path.join(rootDirectory, "workspace");
  const grantId = "66666666-6666-4666-8666-666666666666";
  const secretValue = "must-not-appear-in-output";
  let serverError = null;
  let consumeCount = 0;

  const server = createServer(async (request, response) => {
    try {
      assert.equal(request.method, "POST");
      assert.equal(
        request.url,
        `/api/agent-secrets/checkout-grants/${grantId}/consume`,
      );
      assert.equal(request.headers.authorization, "Bearer integration-token");
      assert.equal(
        request.headers["x-trelio-agent-workspaces-version"],
        BRIDGE_VERSION,
      );
      assert.deepEqual(
        JSON.parse((await readRequestBody(request)).toString("utf8")),
        { runId },
      );
      consumeCount += 1;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({
        runId,
        executable: "trelio-workspace",
        deliveryMode: "env",
        environmentVariable: "TRELIO_TEST_SECRET",
        value: secretValue,
      }));
    } catch (error) {
      serverError = error;
      response.statusCode = 500;
      response.end(error instanceof Error ? error.message : String(error));
    }
  });

  try {
    await Promise.all([
      mkdir(homeDirectory, { recursive: true }),
      mkdir(emptyPathDirectory, { recursive: true }),
      mkdir(workspaceDirectory, { recursive: true }),
    ]);
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const origin = `http://127.0.0.1:${address.port}`;
    await writeTestCredential(homeDirectory, origin);
    await writeFile(
      path.join(rootDirectory, ".trelio-run.json"),
      `${JSON.stringify({ schemaVersion: 3, origin, runId }, null, 2)}\n`,
      "utf8",
    );

    const result = await execFileAsync(
      process.execPath,
      [
        bridgePath,
        "secret",
        "exec",
        "--grant",
        grantId,
        "--",
        "trelio-workspace",
        "help",
      ],
      {
        cwd: workspaceDirectory,
        encoding: "utf8",
        timeout: 8_000,
        env: {
          ...process.env,
          HOME: homeDirectory,
          PATH: emptyPathDirectory,
          TRELIO_WORKSPACE_DISABLE_KEYCHAIN: "1",
        },
      },
    );

    assert.match(result.stdout, /Trelio Agent Workspace Bridge/u);
    assert.equal(result.stdout.includes(secretValue), false);
    assert.equal(result.stderr, "");
    assert.equal(consumeCount, 1);
    assert.ifError(serverError);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test("bridge private credential path and Windows ACL are explicit and user-scoped", () => {
  assert.equal(
    resolveWorkspaceBridgeConfigDirectory({
      platform: "win32",
      environment: {
        LOCALAPPDATA: "C:\\Users\\vlad\\AppData\\Local",
      },
      homeDirectory: "C:\\Users\\vlad",
    }),
    "C:\\Users\\vlad\\AppData\\Local\\Trelio\\workspace-bridge",
  );
  assert.equal(
    resolveWorkspaceBridgeConfigDirectory({
      platform: "linux",
      environment: {},
      homeDirectory: "/home/vlad",
    }),
    "/home/vlad/.config/trelio/workspace-bridge",
  );
  assert.match(WINDOWS_PRIVATE_ACL_SCRIPT, /SetAccessRuleProtection\(\$true, \$false\)/u);
  assert.match(WINDOWS_PRIVATE_ACL_SCRIPT, /WindowsIdentity\]::GetCurrent\(\)\.User/u);
  assert.match(
    WINDOWS_PRIVATE_ACL_SCRIPT,
    /GetAccessControl\([\s\S]*AccessControlSections\]::Owner/u,
  );
  assert.match(WINDOWS_PRIVATE_ACL_SCRIPT, /\$targetInfo\.SetAccessControl\(\$acl\)/u);
  assert.match(
    WINDOWS_PRIVATE_ACL_SCRIPT,
    /\$ownerAcl\.SetOwner\(\$sid\)[\s\S]*\$targetInfo\.SetAccessControl\(\$ownerAcl\)/u,
  );
  assert.doesNotMatch(WINDOWS_PRIVATE_ACL_SCRIPT, /(?:^|\n)\s*Set-Acl\b/u);
  assert.doesNotMatch(WINDOWS_PRIVATE_ACL_SCRIPT, /\$acl\.SetOwner\(/u);
  assert.doesNotMatch(
    WINDOWS_PRIVATE_ACL_SCRIPT,
    /AccessControlSections\]::Audit/u,
  );
  assert.match(WINDOWS_PRIVATE_ACL_SCRIPT, /unexpected\.Count -ne 0/u);
});

test("Windows ACL command transports its path without PowerShell argument parsing", () => {
  const targetPath = String.raw`C:\Users\Влад\App Data\Trelio\path with 'quotes' & symbols`;
  const invocation = buildWindowsPrivateAclPowerShellInvocation(
    targetPath,
    "directory",
  );

  assert.equal(invocation.args.at(-2), "-Command");
  assert.equal(invocation.args.at(-1), WINDOWS_PRIVATE_ACL_SCRIPT);
  assert.equal(invocation.args.includes(targetPath), false);
  assert.equal(
    Buffer.from(
      invocation.environment.TRELIO_WINDOWS_PRIVATE_ACL_PATH_BASE64,
      "base64",
    ).toString("utf8"),
    targetPath,
  );
  assert.equal(
    invocation.environment.TRELIO_WINDOWS_PRIVATE_ACL_KIND,
    "directory",
  );
  assert.match(
    WINDOWS_PRIVATE_ACL_SCRIPT,
    /GetEnvironmentVariable\(\s*"TRELIO_WINDOWS_PRIVATE_ACL_PATH_BASE64"/u,
  );
  assert.doesNotMatch(WINDOWS_PRIVATE_ACL_SCRIPT, /Import-Module/u);
  assert.doesNotMatch(WINDOWS_PRIVATE_ACL_SCRIPT, /^param\(/mu);
  assert.throws(
    () => buildWindowsPrivateAclPowerShellInvocation("", "directory"),
    /non-empty string/u,
  );
  assert.throws(
    () => buildWindowsPrivateAclPowerShellInvocation(targetPath, "junction"),
    /Unsupported Windows private path kind/u,
  );
});

test("Windows bridge applies and verifies a current-user-only ACL", {
  skip: process.platform !== "win32",
}, async () => {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "trelio-bridge-windows-acl-"));
  const privateDirectory = path.join(
    temporaryDirectory,
    "private path with spaces ' and Unicode Ж",
  );
  const credentialFile = path.join(privateDirectory, "credentials.json");

  try {
    await mkdir(privateDirectory);
    await writeFile(credentialFile, "{}\n", "utf8");
    await hardenWindowsPrivatePath(privateDirectory, "directory");
    await hardenWindowsPrivatePath(credentialFile, "file");
    // Existing credentials are hardened on every read/write. A second pass
    // catches descriptor state that only appears after the initial DACL write.
    await hardenWindowsPrivatePath(privateDirectory, "directory");
    await hardenWindowsPrivatePath(credentialFile, "file");
    assert.equal((await stat(credentialFile)).isFile(), true);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test("bridge fails closed before reading credentials from unsafe POSIX paths", {
  skip: process.platform === "win32",
}, async () => {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "trelio-bridge-unsafe-credentials-"));
  const homeDirectory = path.join(temporaryDirectory, "home");
  const credentialDirectory = path.join(homeDirectory, ".config", "trelio", "workspace-bridge");
  const credentialFile = path.join(credentialDirectory, "credentials.json");
  const origin = "https://unsafe-credentials.test";

  try {
    await mkdir(credentialDirectory, { recursive: true, mode: 0o700 });
    await chmod(credentialDirectory, 0o755);
    await writeFile(
      credentialFile,
      `${JSON.stringify({ [origin]: { bridgeSessionToken: "twb_must-not-be-read" } })}\n`,
      { mode: 0o600 },
    );

    await assert.rejects(
      execFileAsync(process.execPath, [bridgePath, "login", "--origin", origin], {
        encoding: "utf8",
        env: { ...process.env, HOME: homeDirectory },
      }),
      (error) => {
        assert.match(String(error.stderr || ""), /требуются 0700/u);
        assert.doesNotMatch(String(error.stdout || ""), /уже подключён/u);
        return true;
      },
    );

    await chmod(credentialDirectory, 0o700);
    await rm(credentialFile);
    await writeFile(
      path.join(temporaryDirectory, "outside-credentials.json"),
      `${JSON.stringify({ [origin]: { bridgeSessionToken: "twb_symlink-target" } })}\n`,
      { mode: 0o600 },
    );
    await symlink(
      path.join(temporaryDirectory, "outside-credentials.json"),
      credentialFile,
    );

    await assert.rejects(
      execFileAsync(process.execPath, [bridgePath, "login", "--origin", origin], {
        encoding: "utf8",
        env: { ...process.env, HOME: homeDirectory },
      }),
      (error) => {
        assert.match(String(error.stderr || ""), /symlink/u);
        assert.doesNotMatch(String(error.stdout || ""), /уже подключён/u);
        return true;
      },
    );
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test("macOS bridge softly migrates an existing device-session out of Keychain", {
  skip: process.platform !== "darwin",
}, async () => {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "trelio-bridge-keychain-migration-"));
  const homeDirectory = path.join(temporaryDirectory, "home");
  const credentialDirectory = path.join(homeDirectory, ".config", "trelio", "workspace-bridge");
  const fakeBinaryDirectory = path.join(temporaryDirectory, "bin");
  const securityLog = path.join(temporaryDirectory, "security.log");
  const origin = "https://legacy-device-session.test";
  const legacyToken = "twb_legacy-keychain-device-session";

  try {
    await mkdir(credentialDirectory, { recursive: true, mode: 0o700 });
    await chmod(credentialDirectory, 0o700);
    await mkdir(fakeBinaryDirectory, { recursive: true });
    const fakeSecurity = path.join(fakeBinaryDirectory, "security");
    await writeFile(
      fakeSecurity,
      "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$TRELIO_SECURITY_LOG\"\n"
        + "if [ \"$1\" = \"find-generic-password\" ]; then printf '%s\\n' \"$TRELIO_LEGACY_TOKEN\"; fi\n",
      "utf8",
    );
    await chmod(fakeSecurity, 0o755);

    const result = await execFileAsync(
      process.execPath,
      [bridgePath, "login", "--origin", origin],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          HOME: homeDirectory,
          PATH: `${fakeBinaryDirectory}${path.delimiter}${process.env.PATH || ""}`,
          TRELIO_SECURITY_LOG: securityLog,
          TRELIO_LEGACY_TOKEN: legacyToken,
        },
      },
    );

    assert.match(result.stdout, /уже подключён через device-session/u);
    const credentials = JSON.parse(await readFile(
      path.join(credentialDirectory, "credentials.json"),
      "utf8",
    ));
    assert.equal(credentials[origin].bridgeSessionToken, legacyToken);
    const securityCalls = await readFile(securityLog, "utf8");
    assert.match(securityCalls, /find-generic-password.*ru\.trelio\.workspace-bridge\.session/u);
    assert.match(securityCalls, /delete-generic-password.*ru\.trelio\.workspace-bridge\.session/u);
    assert.doesNotMatch(securityCalls, /add-generic-password/u);
    assert.equal(
      (await readdir(credentialDirectory)).filter(
        (name) => name.startsWith(".keychain-device-session-migrated-"),
      ).length,
      1,
    );
    assert.equal((await stat(credentialDirectory)).mode & 0o777, 0o700);
    assert.equal(
      (await stat(path.join(credentialDirectory, "credentials.json"))).mode & 0o777,
      0o600,
    );
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test("workspace worker discovers the live skill catalog before substantive work", async () => {
  const workerSkill = await readSkillBundle("trelio-workspace-worker");
  const catalogSkill = await readFile(
    path.join(pluginDirectory, "skills", "trelio-skill-catalog", "SKILL.md"),
    "utf8",
  );

  assert.match(workerSkill, /call `list_agent_skills` once\s+for the exact context/);
  assert.match(workerSkill, /do not\s+load every instruction/u);
  assert.match(workerSkill, /Immediately before using a relevant skill, call\s+`get_agent_skill`/);
  assert.match(workerSkill, /Use only exact\s+`runtimeExecution\.command`/);
  assert.match(workerSkill, /declared `remoteMcpExecution`\s+identity\/release/);
  assert.match(workerSkill, /Never bypass a matching usable skill through browser, Computer Use, direct\s+HTTP, another MCP, or a script/);
  assert.match(workerSkill, /Fallback is allowed only when no relevant\s+skill exists/);
  assert.match(workerSkill, /explicit runtime `no_access` or\s+`needs_reconnect`/);
  assert.match(workerSkill, /not a reason to refuse requested work/);
  assert.match(workerSkill, /same protected system through another route/);
  assert.match(workerSkill, /Native Trelio\s+MCP\/workspace operations remain the primary workflow/);
  assert.match(workerSkill, /do not require a\s+separate catalog skill/);
  assert.match(workerSkill, /state that reason/);
  assert.match(catalogSkill, /primary workspace\s+workflow, not a fallback from this catalog/);
  assert.match(workerSkill, /On\s+`AGENT_SKILL_RELEASE_CHANGED`, read the skill again once/);
  assert.match(workerSkill, /durable rule identified by\s+the agent/);
  assert.match(workerSkill, /Call\s+`get_agent_instructions` to read current scoped and inherited rules/);
  assert.match(workerSkill, /exact diff with `plan_agent_instructions_update`/);
  assert.match(workerSkill, /Call `publish_my_agent_profile` or\s+`publish_agent_instructions` only after explicit confirmation/);
  assert.match(workerSkill, /never place instructions in\s+`WORKSPACE_CONTEXT\.md`/);
  assert.match(workerSkill, /applies only to future Runs/);
  assert.match(workerSkill, /Before drafting a durable rule, identify every scenario whose behavior it\s+would govern/u);
  assert.match(workerSkill, /read each matching\s+reference completely/u);
  assert.match(workerSkill, /must preserve the `task-run\.md` limit/u);
  assert.match(workerSkill, /perform the catalog gate in step 2 before the first `get_task`/u);
  assert.match(workerSkill, /minimum\s+native read-only Trelio discovery needed to resolve it/u);
  assert.match(workerSkill, /TRELIO_BRIDGE_PAIRING_REQUIRED/);
  assert.match(workerSkill, /After exchange, briefly report that the device\s+is connected and continue/);
  assert.match(workerSkill, /never gains\s+`mcp:agent-instructions:manage`/);
  assert.match(workerSkill, /Do not start another\s+OAuth flow/);
  assert.match(catalogSkill, /Call `list_agent_skills` once for the effective work context/);
  assert.match(catalogSkill, /Do not call `request_plugin_install`/u);
  assert.match(catalogSkill, /personal skill or connector remains allowed/u);
  assert.match(catalogSkill, /project-scoped response already contains the additive union/);
  assert.match(catalogSkill, /When `runtimeExecution` is present, invoke its exact `command`/);
  assert.match(catalogSkill, /bridge may cache verified package bytes by digest/);
});

test("bridge adds its release version and bearer credential to every API request", () => {
  const headers = buildBridgeRequestHeaders("oauth-token", { accept: "application/json" });
  assert.equal(headers.get("x-trelio-agent-workspaces-version"), BRIDGE_VERSION);
  assert.equal(headers.get("authorization"), "Bearer oauth-token");
  assert.equal(headers.get("accept"), "application/json");
});

test("skill package host rejects non-portable paths and case collisions", () => {
  assert.throws(
    () => normalizeAgentSkillPackagePath("runtime/CON"),
    /не нормализован/u,
  );
  assert.throws(
    () => normalizeAgentSkillPackagePath("runtime/file:stream"),
    /не нормализован/u,
  );

  const runtimeBytes = Buffer.from("console.log('ok');\n", "utf8");
  const packageBytes = Buffer.from(JSON.stringify({
    format: "trelio-agent-skill-package/v1",
    skill: {
      id: "test-runtime",
      runtimeVersion: "1.0.0",
    },
    entrypoint: {
      path: "runtime/Main.mjs",
      interpreter: "node",
    },
    capabilities: [],
    files: ["runtime/Main.mjs", "runtime/main.mjs"].map((filePath) => ({
      path: filePath,
      mode: 0o644,
      sha256: createHash("sha256").update(runtimeBytes).digest("hex"),
      contentBase64: runtimeBytes.toString("base64"),
    })),
  }), "utf8");

  assert.throws(
    () => parseAndValidateAgentSkillPackage(packageBytes, "test-runtime"),
    /регистронно конфликтует/u,
  );
});

test("skill pack rejects machine-specific Python bytecode cache", async () => {
  const temporaryDirectory = await mkdtemp(
    path.join(os.tmpdir(), "trelio-skill-pack-cache-test-"),
  );
  try {
    await mkdir(path.join(temporaryDirectory, "__pycache__"));
    await writeFile(path.join(temporaryDirectory, "main.py"), "print('ok')\n");
    await writeFile(
      path.join(temporaryDirectory, "__pycache__", "main.cpython-314.pyc"),
      Buffer.from([0, 1, 2, 3]),
    );
    await assert.rejects(
      buildAgentSkillPackage({
        skillId: "test-runtime",
        runtimeVersion: "1.0.0",
        sourceDirectory: temporaryDirectory,
        entrypointPath: "main.py",
        interpreter: "python",
      }),
      /generated cache/u,
    );
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test("connection-free skill runtime receives member identity without synthetic connection authority", () => {
  const companyId = "99999999-9999-4999-8999-999999999999";
  const memberId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const releaseId = "77777777-7777-4777-8777-777777777777";
  const artifactId = "88888888-8888-4888-8888-888888888888";
  const skillId = "consultant-plus";
  const payload = {
    releaseId,
    localIdentity: {
      companyId,
      projectId: null,
      memberId,
      skillId,
      connectionId: null,
    },
    companyConnection: null,
    artifact: {
      id: artifactId,
      skillId,
      runtimeVersion: "1.0.0",
      packageFormat: "trelio-agent-skill-package/v1",
      packageSha256: "a".repeat(64),
      packageSizeBytes: 128,
      packageSignature: "signed-package",
      signingKeyId: "test",
      signingPublicKeySpki: "public-key",
      minimumHostVersion: BRIDGE_VERSION,
      manifest: {},
    },
    packageUrl: `/api/agent-skills/runtime/package?artifactId=${artifactId}`,
  };

  const resolution = normalizeResolvedSkillRuntimeArtifact(payload);
  const environment = buildAgentSkillRuntimeEnvironment({
    artifact: resolution.artifact,
    runtimeDirectory: "/verified/runtime",
    executionContext: {
      companyId,
      projectId: null,
      releaseId,
      localIdentity: resolution.localIdentity,
      companyConnection: resolution.companyConnection,
    },
    inheritedEnvironment: {
      SAFE_PARENT_VALUE: "kept",
      TRELIO_SKILL_PROJECT_ID: "stale-project",
      TRELIO_SKILL_CONNECTION_ID: "stale-connection",
      TRELIO_SKILL_CONNECTION_CONFIG_JSON: "stale-config",
    },
  });

  assert.equal(environment.SAFE_PARENT_VALUE, "kept");
  assert.equal(environment.TRELIO_SKILL_COMPANY_ID, companyId);
  assert.equal(environment.TRELIO_SKILL_MEMBER_ID, memberId);
  assert.equal(environment.TRELIO_SKILL_CONNECTION_ID, undefined);
  assert.equal(environment.TRELIO_SKILL_CONNECTION_CONFIG_JSON, undefined);
  assert.equal(environment.TRELIO_SKILL_PROJECT_ID, undefined);

  assert.throws(
    () => normalizeResolvedSkillRuntimeArtifact({
      ...payload,
      localIdentity: { ...payload.localIdentity, connectionId: artifactId },
    }),
    /некорректную runtime resolution/u,
  );
});

test("skill host resolves on every run, verifies signed package, caches it and repairs tampering", {
  timeout: 15_000,
}, async () => {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "trelio-skill-runtime-test-"));
  const homeDirectory = path.join(temporaryDirectory, "home");
  const sourceDirectory = path.join(temporaryDirectory, "source");
  const skillId = "test-runtime";
  const releaseId = "77777777-7777-4777-8777-777777777777";
  const artifactId = "88888888-8888-4888-8888-888888888888";
  const companyId = "99999999-9999-4999-8999-999999999999";
  const memberId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const connectionId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  let resolveCount = 0;
  let packageDownloadCount = 0;
  let serverError = null;

  await mkdir(sourceDirectory, { recursive: true });
  await writeFile(
    path.join(sourceDirectory, "main.mjs"),
    "process.stdout.write(`runtime:${process.argv.slice(2).join(',')}:${process.env.TRELIO_SKILL_RELEASE_ID}:${process.env.TRELIO_SKILL_MEMBER_ID}:${process.env.TRELIO_SKILL_CONNECTION_ID}:${process.env.TRELIO_SKILL_CONNECTION_CONFIG_JSON}:project=${process.env.TRELIO_SKILL_PROJECT_ID || 'none'}\\n`);\n",
    { mode: 0o755 },
  );
  const packageBytes = await buildAgentSkillPackage({
    skillId,
    runtimeVersion: "2.0.0",
    sourceDirectory,
    entrypointPath: "main.mjs",
    interpreter: "node",
    capabilities: ["network"],
  });
  const packageSha256 = createHash("sha256").update(packageBytes).digest("hex");
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const packageSignature = sign(null, packageBytes, privateKey).toString("base64");
  const signingPublicKeySpki = publicKey.export({
    format: "der",
    type: "spki",
  }).toString("base64");
  const packageUrl = `/api/agent-skills/runtime/package?artifactId=${artifactId}`;

  const server = createServer(async (request, response) => {
    try {
      assert.equal(request.headers["x-trelio-agent-workspaces-version"], BRIDGE_VERSION);
      assert.equal(request.headers.authorization, "Bearer integration-token");

      if (request.url === "/api/agent-workspaces/bridge-compatibility") {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({
          supported: true,
          minimumVersion: BRIDGE_VERSION,
        }));
        return;
      }

      if (
        request.method === "POST"
        && request.url === "/api/agent-skills/runtime/resolve"
      ) {
        resolveCount += 1;
        const body = JSON.parse((await readRequestBody(request)).toString("utf8"));
        assert.deepEqual(body, {
          companyId,
          skillId,
          expectedReleaseId: releaseId,
        });
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({
          releaseId,
          localIdentity: {
            companyId,
            projectId: null,
            memberId,
            skillId,
            connectionId,
          },
          companyConnection: {
            id: connectionId,
            status: "configured",
            configured: true,
            config: {
              schemaVersion: 1,
              baseUrl: "https://example.test/",
            },
            secretBindings: [
              {
                key: "x_odata",
                status: "active",
                hasValue: true,
              },
            ],
          },
          artifact: {
            id: artifactId,
            skillId,
            runtimeVersion: "2.0.0",
            packageFormat: "trelio-agent-skill-package/v1",
            packageSha256,
            packageSizeBytes: packageBytes.byteLength,
            packageSignature,
            signingKeyId: "test",
            signingPublicKeySpki,
            minimumHostVersion: BRIDGE_VERSION,
            manifest: {},
          },
          packageUrl,
        }));
        return;
      }

      if (request.method === "GET" && request.url === packageUrl) {
        packageDownloadCount += 1;
        response.setHeader(
          "content-type",
          "application/vnd.trelio.agent-skill-package+json",
        );
        response.end(packageBytes);
        return;
      }

      response.statusCode = 404;
      response.end();
    } catch (error) {
      serverError = error;
      response.statusCode = 500;
      response.end(error instanceof Error ? error.message : String(error));
    }
  });

  try {
    await mkdir(homeDirectory, { recursive: true });
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const origin = `http://127.0.0.1:${address.port}`;
    await writeTestCredential(homeDirectory, origin);
    const runSkill = () => execFileAsync(
      process.execPath,
      [
        bridgePath,
        "skill",
        "run",
        "--origin",
        origin,
        "--company",
        companyId,
        "--skill",
        skillId,
        "--release",
        releaseId,
        "--",
        "--message",
        "hello",
      ],
      {
        cwd: temporaryDirectory,
        encoding: "utf8",
        timeout: 10_000,
        env: {
          ...process.env,
          HOME: homeDirectory,
          XDG_CACHE_HOME: path.join(homeDirectory, ".cache"),
          // A caller cannot smuggle stale host-owned context into a run that
          // was live-resolved without a project.
          TRELIO_SKILL_PROJECT_ID: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        },
      },
    );

    const firstRun = await runSkill();
    const secondRun = await runSkill();
    const expectedRuntimeOutput = `runtime:--message,hello:${releaseId}:${memberId}:${connectionId}:{"schemaVersion":1,"baseUrl":"https://example.test/"}:project=none`;
    assert.match(firstRun.stdout, new RegExp(expectedRuntimeOutput.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&")));
    assert.match(secondRun.stdout, new RegExp(expectedRuntimeOutput.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&")));
    assert.equal(resolveCount, 2, "every invocation must resolve the current release");
    assert.equal(packageDownloadCount, 1, "second invocation must use verified cache");

    const cachedEntrypoint = path.join(
      homeDirectory,
      ".cache",
      "trelio",
      "workspace-bridge",
      "skill-runtimes",
      skillId,
      "2.0.0",
      packageSha256,
      "main.mjs",
    );
    await writeFile(cachedEntrypoint, "throw new Error('tampered');\n");

    const repairedRun = await runSkill();
    assert.match(repairedRun.stdout, new RegExp(expectedRuntimeOutput.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&")));
    assert.equal(resolveCount, 3);
    assert.equal(packageDownloadCount, 2, "tampered cache must be downloaded again");
    assert.ifError(serverError);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test("bridge pairs once through MCP approval and reuses the narrow local device session", {
  timeout: 15_000,
}, async () => {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "trelio-bridge-pairing-test-"));
  const homeDirectory = path.join(temporaryDirectory, "home");
  const fakeBinaryDirectory = path.join(temporaryDirectory, "bin");
  const securityLog = path.join(temporaryDirectory, "security.log");
  await mkdir(fakeBinaryDirectory, { recursive: true });
  const fakeSecurity = path.join(fakeBinaryDirectory, "security");
  await writeFile(
    fakeSecurity,
    "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$TRELIO_SECURITY_LOG\"\nexit 64\n",
    "utf8",
  );
  await chmod(fakeSecurity, 0o755);
  const pairingId = "44444444-4444-4444-8444-444444444444";
  const userCode = "ABCD-2345";
  const deviceName = "Test workstation";
  let codeChallenge = "";
  let createRequests = 0;
  let exchangeRequests = 0;
  let serverError = null;

  const server = createServer(async (request, response) => {
    try {
      assert.equal(request.headers["x-trelio-agent-workspaces-version"], BRIDGE_VERSION);
      const body = JSON.parse((await readRequestBody(request)).toString("utf8") || "{}");

      if (
        request.method === "POST"
        && request.url === "/api/agent-workspaces/bridge-pairings"
      ) {
        createRequests += 1;
        codeChallenge = body.codeChallenge;
        assert.match(codeChallenge, /^[A-Za-z0-9_-]{43}$/u);
        assert.equal(typeof body.deviceName, "string");
        assert.equal(typeof body.platform, "string");
        response.statusCode = 201;
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({
          pairingId,
          userCode,
          deviceName,
          platform: body.platform,
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        }));
        return;
      }

      if (
        request.method === "POST"
        && request.url === `/api/agent-workspaces/bridge-pairings/${pairingId}/exchange`
      ) {
        exchangeRequests += 1;
        assert.equal(
          createHash("sha256").update(body.codeVerifier).digest("base64url"),
          codeChallenge,
          "exchange must prove possession of the verifier kept only on this device",
        );
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({
          accessToken: "twb_integration-device-session",
          tokenType: "Bearer",
          sessionId: "55555555-5555-4555-8555-555555555555",
          capabilities: ["workspace:read", "workspace:write"],
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          deviceName,
        }));
        return;
      }

      response.statusCode = 404;
      response.end("Not found");
    } catch (error) {
      serverError = error;
      response.statusCode = 500;
      response.end(String(error));
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  const childEnvironment = {
    ...process.env,
    HOME: homeDirectory,
    PATH: `${fakeBinaryDirectory}${path.delimiter}${process.env.PATH || ""}`,
    TRELIO_SECURITY_LOG: securityLog,
  };

  try {
    let firstFailure;

    try {
      await execFileAsync(process.execPath, [
        bridgePath,
        "login",
        "--origin",
        origin,
      ], {
        encoding: "utf8",
        env: childEnvironment,
      });
      assert.fail("First login must stop for the MCP pairing action.");
    } catch (error) {
      firstFailure = error;
    }

    const firstOutput = `${firstFailure.stdout || ""}\n${firstFailure.stderr || ""}`;
    assert.match(firstOutput, /TRELIO_BRIDGE_PAIRING_REQUIRED/);
    assert.match(firstOutput, new RegExp(pairingId));
    assert.doesNotMatch(firstOutput, new RegExp(userCode));
    assert.match(firstOutput, new RegExp(deviceName));
    assert.match(firstOutput, /approve_agent_workspace_bridge_pairing/);
    assert.match(firstOutput, /не просите отдельную фразу подтверждения/);

    const pairingFile = path.join(
      homeDirectory,
      ".config",
      "trelio",
      "workspace-bridge",
      "pairings.json",
    );
    const pendingPairings = JSON.parse(await readFile(pairingFile, "utf8"));
    const localVerifier = pendingPairings[origin].codeVerifier;
    assert.equal(typeof localVerifier, "string");
    assert.equal(pendingPairings[origin].userCode, undefined);
    assert.doesNotMatch(firstOutput, new RegExp(localVerifier));

    const completed = await execFileAsync(process.execPath, [
      bridgePath,
      "login",
      "--origin",
      origin,
    ], {
      encoding: "utf8",
      env: childEnvironment,
    });
    assert.match(completed.stdout, /подключено к Trelio/);
    assert.equal(await pathExists(pairingFile), false);

    const credentialFile = path.join(
      homeDirectory,
      ".config",
      "trelio",
      "workspace-bridge",
      "credentials.json",
    );
    const credentials = JSON.parse(await readFile(credentialFile, "utf8"));
    assert.equal(
      credentials[origin].bridgeSessionToken,
      "twb_integration-device-session",
    );
    assert.equal(credentials[origin].accessToken, undefined);
    const securityCalls = await pathExists(securityLog)
      ? await readFile(securityLog, "utf8")
      : "";
    assert.doesNotMatch(
      securityCalls,
      /add-generic-password|ru\.trelio\.workspace-bridge\.session/u,
      "new bridge pairing must not call macOS Keychain for device-session storage",
    );

    const reused = await execFileAsync(process.execPath, [
      bridgePath,
      "login",
      "--origin",
      origin,
    ], {
      encoding: "utf8",
      env: childEnvironment,
    });
    assert.match(reused.stdout, /уже подключён через device-session/);
    assert.equal(createRequests, 1);
    assert.equal(exchangeRequests, 1);
    assert.ifError(serverError);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test("bridge self-revokes an exchanged server session when private-file persistence fails", {
  timeout: 15_000,
}, async () => {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "trelio-bridge-orphan-test-"));
  const homeDirectory = path.join(temporaryDirectory, "home");
  const pairingId = "66666666-6666-4666-8666-666666666666";
  const deviceName = "Persistence failure workstation";
  const accessToken = "twb_must-never-appear-in-output";
  const credentialFile = path.join(
    homeDirectory,
    ".config",
    "trelio",
    "workspace-bridge",
    "credentials.json",
  );
  let codeChallenge = "";
  let selfRevokeRequests = 0;
  let serverError = null;

  const server = createServer(async (request, response) => {
    try {
      const body = JSON.parse((await readRequestBody(request)).toString("utf8") || "{}");
      if (request.method === "POST" && request.url === "/api/agent-workspaces/bridge-pairings") {
        codeChallenge = body.codeChallenge;
        response.statusCode = 201;
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({
          pairingId,
          deviceName,
          platform: body.platform,
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        }));
        return;
      }
      if (
        request.method === "POST"
        && request.url === `/api/agent-workspaces/bridge-pairings/${pairingId}/exchange`
      ) {
        assert.equal(
          createHash("sha256").update(body.codeVerifier).digest("base64url"),
          codeChallenge,
        );
        // Wrong path kind appears only after exchange, so the regression proves
        // compensation happens for a server session that was actually issued.
        await mkdir(credentialFile);
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({
          accessToken,
          tokenType: "Bearer",
          sessionId: "77777777-7777-4777-8777-777777777777",
          capabilities: ["workspace:read", "workspace:write"],
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          deviceName,
        }));
        return;
      }
      if (
        request.method === "POST"
        && request.url === "/api/agent-workspaces/bridge-session/self-revoke"
      ) {
        selfRevokeRequests += 1;
        assert.equal(request.headers.authorization, `Bearer ${accessToken}`);
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({
          session: {
            id: "77777777-7777-4777-8777-777777777777",
            deviceName,
            revokedAt: new Date().toISOString(),
          },
        }));
        return;
      }
      response.statusCode = 404;
      response.end("Not found");
    } catch (error) {
      serverError = error;
      response.statusCode = 500;
      response.end(String(error));
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  const childEnvironment = {
    ...process.env,
    HOME: homeDirectory,
    TRELIO_WORKSPACE_DISABLE_KEYCHAIN: "1",
  };

  try {
    await assert.rejects(
      execFileAsync(process.execPath, [bridgePath, "login", "--origin", origin], {
        encoding: "utf8",
        env: childEnvironment,
      }),
      /TRELIO_BRIDGE_PAIRING_REQUIRED/u,
    );

    let persistenceFailure;
    try {
      await execFileAsync(process.execPath, [bridgePath, "login", "--origin", origin], {
        encoding: "utf8",
        env: childEnvironment,
      });
      assert.fail("Unsafe credential path must fail after exchange.");
    } catch (error) {
      persistenceFailure = error;
    }

    const output = `${persistenceFailure.stdout || ""}\n${persistenceFailure.stderr || ""}`;
    assert.match(output, /Серверная сессия автоматически отозвана/u);
    assert.doesNotMatch(output, new RegExp(accessToken));
    assert.equal(selfRevokeRequests, 1);
    assert.equal(
      await pathExists(path.join(homeDirectory, ".config", "trelio", "workspace-bridge", "pairings.json")),
      false,
    );
    assert.ifError(serverError);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test("bridge submit external object writes the pointer through stdin without hanging", {
  timeout: 15_000,
}, async () => {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "trelio-bridge-submit-test-"));
  const homeDirectory = path.join(temporaryDirectory, "home");
  const runDirectory = path.join(temporaryDirectory, "run");
  const workspaceDirectory = path.join(runDirectory, "workspace");
  const objectDirectory = path.join(workspaceDirectory, "sources");
  const binaryBytes = Buffer.from([0, 1, 2]);
  const binaryDigest = createHash("sha256").update(binaryBytes).digest("hex");
  const expectedPointer = [
    "version https://trelio.ru/spec/workspace-object/v1",
    `oid sha256:${binaryDigest}`,
    `size ${binaryBytes.byteLength}`,
    "content-type application/octet-stream",
    "",
  ].join("\n");
  const seenRequests = [];
  let registerAttempts = 0;
  let uploadAttempts = 0;
  let serverError = null;

  const server = createServer(async (request, response) => {
    try {
      const body = await readRequestBody(request);
      seenRequests.push({ method: request.method, url: request.url, body });
      assert.equal(request.headers["x-trelio-agent-workspaces-version"], BRIDGE_VERSION);
      assert.equal(request.headers.authorization, "Bearer integration-token");

      if (request.url?.endsWith("/heartbeat")) {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ leaseExpiresAt: new Date(Date.now() + 60_000).toISOString() }));
        return;
      }

      if (request.url?.endsWith("/objects/register")) {
        registerAttempts += 1;

        if (registerAttempts === 1) {
          response.statusCode = 429;
          response.setHeader("retry-after", "0");
          response.setHeader("content-type", "application/json");
          response.end(JSON.stringify({ message: "Retry register" }));
          return;
        }

        const registration = JSON.parse(body.toString("utf8"));
        assert.equal(registration.filePath, "sources/archive.bin");
        assert.equal(registration.sha256, binaryDigest);
        assert.equal(registration.sizeBytes, binaryBytes.byteLength);
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ uploadRequired: true }));
        return;
      }

      if (request.method === "PUT" && request.url?.includes(`/objects/${binaryDigest}/content`)) {
        uploadAttempts += 1;

        if (uploadAttempts === 1) {
          response.statusCode = 429;
          response.setHeader("retry-after", "0");
          response.setHeader("content-type", "application/json");
          response.end(JSON.stringify({ message: "Retry upload" }));
          return;
        }

        assert.deepEqual(body, binaryBytes);
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ uploadRequired: false, pointer: expectedPointer }));
        return;
      }

      if (request.url?.endsWith("/candidate")) {
        assert.ok(body.byteLength > 0, "candidate bundle must reach the server");
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({
          run: { status: "accepted" },
          projection: { status: "projected" },
        }));
        return;
      }

      response.statusCode = 404;
      response.end();
    } catch (error) {
      serverError = error;
      response.statusCode = 500;
      response.end(error instanceof Error ? error.message : String(error));
    }
  });

  try {
    await mkdir(objectDirectory, { recursive: true });
    await mkdir(homeDirectory, { recursive: true });
    await runGit(workspaceDirectory, ["init", "--initial-branch=trelio-candidate"]);
    await runGit(workspaceDirectory, ["config", "user.name", "Trelio Bridge Test"]);
    await runGit(workspaceDirectory, ["config", "user.email", "bridge-test@trelio.local"]);
    await writeFile(path.join(workspaceDirectory, "README.md"), "# Base\n", "utf8");
    await runGit(workspaceDirectory, ["add", "README.md"]);
    await runGit(workspaceDirectory, ["commit", "-m", "Base"]);
    const baseHead = (await runGit(workspaceDirectory, ["rev-parse", "HEAD"])).stdout.trim();
    await writeFile(path.join(objectDirectory, "archive.bin"), binaryBytes);

    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const serverAddress = server.address();
    assert.ok(serverAddress && typeof serverAddress === "object");
    const origin = `http://127.0.0.1:${serverAddress.port}`;
    const credentialDirectory = path.join(
      homeDirectory,
      ".config",
      "trelio",
      "workspace-bridge",
    );
    await mkdir(credentialDirectory, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") {
      await chmod(credentialDirectory, 0o700);
    }
    await writeFile(
      path.join(credentialDirectory, "credentials.json"),
      `${JSON.stringify({ [origin]: { accessToken: "integration-token" } }, null, 2)}\n`,
      { mode: 0o600 },
    );
    await writeFile(
      path.join(runDirectory, ".trelio-run.json"),
      `${JSON.stringify({
        schemaVersion: 3,
        origin,
        pluginVersion: BRIDGE_VERSION,
        workspaceId: "44444444-4444-4444-8444-444444444444",
        runId,
        leaseId: "55555555-5555-4555-8555-555555555555",
        fencingToken: 7,
        baseHead,
        workspaceDirectory,
        contextHeads: {},
        contexts: [],
        objects: [],
      }, null, 2)}\n`,
      "utf8",
    );

    const submitted = await execFileAsync(
      process.execPath,
      [bridgePath, "submit", "--message", "Проверить external object"],
      {
        cwd: workspaceDirectory,
        encoding: "utf8",
        timeout: 8_000,
        env: {
          ...process.env,
          HOME: homeDirectory,
        },
      },
    );

    assert.match(submitted.stdout, /Статус: принят автоматически/);
    assert.ifError(serverError);
    assert.equal(
      seenRequests.filter((request) => request.url?.endsWith("/heartbeat")).length,
      2,
    );
    assert.equal(
      registerAttempts,
      2,
      "register must retry once after Retry-After",
    );
    assert.equal(
      uploadAttempts,
      2,
      "upload must reopen its stream and retry once after Retry-After",
    );
    assert.equal(
      seenRequests.some((request) => request.url?.endsWith("/candidate")),
      true,
    );
    assert.equal(
      (await runGit(workspaceDirectory, ["show", "HEAD:sources/archive.bin"])).stdout,
      expectedPointer,
    );
    assert.deepEqual(await readFile(path.join(objectDirectory, "archive.bin")), binaryBytes);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test("bridge registers inherited objects for a clean precommitted candidate", {
  timeout: 15_000,
}, async () => {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "trelio-precommitted-submit-"));
  const homeDirectory = path.join(temporaryDirectory, "home");
  const runDirectory = path.join(temporaryDirectory, "run");
  const workspaceDirectory = path.join(runDirectory, "workspace");
  const objectDirectory = path.join(workspaceDirectory, "sources");
  // NUL makes the fixture unambiguously binary for the bridge inspection.
  const binaryBytes = Buffer.from([0, 8, 9, 10]);
  const binaryDigest = createHash("sha256").update(binaryBytes).digest("hex");
  const expectedPointer = [
    "version https://trelio.ru/spec/workspace-object/v1",
    `oid sha256:${binaryDigest}`,
    `size ${binaryBytes.byteLength}`,
    "content-type application/octet-stream",
    "",
  ].join("\n");
  let registerAttempts = 0;
  let candidateAttempts = 0;
  let serverError = null;

  const server = createServer(async (request, response) => {
    try {
      const body = await readRequestBody(request);
      assert.equal(request.headers["x-trelio-agent-workspaces-version"], BRIDGE_VERSION);
      assert.equal(request.headers.authorization, "Bearer integration-token");

      if (request.url?.endsWith("/heartbeat")) {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ leaseExpiresAt: new Date(Date.now() + 60_000).toISOString() }));
        return;
      }

      if (request.url?.endsWith("/objects/register")) {
        registerAttempts += 1;
        const registration = JSON.parse(body.toString("utf8"));
        assert.deepEqual(registration, {
          leaseId: "55555555-5555-4555-8555-555555555555",
          fencingToken: 7,
          filePath: "sources/inherited.bin",
          sha256: binaryDigest,
          sizeBytes: binaryBytes.byteLength,
          contentType: "application/octet-stream",
        });
        // Объект уже существует в company storage: новый Run получает только
        // exact path binding, а содержимое повторно не загружается.
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({
          uploadRequired: false,
          pointer: expectedPointer,
        }));
        return;
      }

      if (request.url?.endsWith("/candidate")) {
        candidateAttempts += 1;
        assert.equal(
          registerAttempts,
          1,
          "the inherited pointer must be registered before candidate submission",
        );
        assert.ok(body.byteLength > 0, "precommitted candidate bundle must reach the server");
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({
          run: { status: "accepted" },
          projection: { status: "projected" },
        }));
        return;
      }

      response.statusCode = 404;
      response.end();
    } catch (error) {
      serverError = error;
      response.statusCode = 500;
      response.end(error instanceof Error ? error.message : String(error));
    }
  });

  try {
    await mkdir(objectDirectory, { recursive: true });
    await mkdir(homeDirectory, { recursive: true });
    await runGit(workspaceDirectory, ["init", "--initial-branch=trelio-candidate"]);
    await runGit(workspaceDirectory, ["config", "user.name", "Trelio Bridge Test"]);
    await runGit(workspaceDirectory, ["config", "user.email", "bridge-test@trelio.local"]);
    await writeFile(path.join(workspaceDirectory, "README.md"), "# Base\n", "utf8");
    await writeFile(path.join(objectDirectory, "inherited.bin"), expectedPointer, "utf8");
    await runGit(workspaceDirectory, ["add", "README.md", "sources/inherited.bin"]);
    await runGit(workspaceDirectory, ["commit", "-m", "Base"]);
    const baseHead = (await runGit(workspaceDirectory, ["rev-parse", "HEAD"])).stdout.trim();

    // `open` materializes bytes while Git keeps the accepted pointer. The
    // user then commits an unrelated text change before calling submit.
    await writeFile(path.join(objectDirectory, "inherited.bin"), binaryBytes);
    await runGit(workspaceDirectory, ["update-index", "--skip-worktree", "sources/inherited.bin"]);
    await writeFile(path.join(workspaceDirectory, "README.md"), "# Candidate\n", "utf8");
    await runGit(workspaceDirectory, ["add", "README.md"]);
    await runGit(workspaceDirectory, ["commit", "-m", "Precommitted candidate"]);
    assert.equal(
      (await runGit(workspaceDirectory, ["status", "--short"])).stdout,
      "",
      "regression requires a clean working tree",
    );

    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const serverAddress = server.address();
    assert.ok(serverAddress && typeof serverAddress === "object");
    const origin = `http://127.0.0.1:${serverAddress.port}`;
    const credentialDirectory = path.join(
      homeDirectory,
      ".config",
      "trelio",
      "workspace-bridge",
    );
    await mkdir(credentialDirectory, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") {
      await chmod(credentialDirectory, 0o700);
    }
    await writeFile(
      path.join(credentialDirectory, "credentials.json"),
      `${JSON.stringify({ [origin]: { accessToken: "integration-token" } }, null, 2)}\n`,
      { mode: 0o600 },
    );
    await writeFile(
      path.join(runDirectory, ".trelio-run.json"),
      `${JSON.stringify({
        schemaVersion: 3,
        origin,
        pluginVersion: BRIDGE_VERSION,
        workspaceId: "44444444-4444-4444-8444-444444444444",
        runId,
        leaseId: "55555555-5555-4555-8555-555555555555",
        fencingToken: 7,
        baseHead,
        workspaceDirectory,
        contextHeads: {},
        contexts: [],
        objects: [{
          filePath: "sources/inherited.bin",
          sha256: binaryDigest,
          sizeBytes: binaryBytes.byteLength,
          contentType: "application/octet-stream",
        }],
      }, null, 2)}\n`,
      "utf8",
    );

    const submitted = await execFileAsync(
      process.execPath,
      [bridgePath, "submit"],
      {
        cwd: workspaceDirectory,
        encoding: "utf8",
        timeout: 8_000,
        env: {
          ...process.env,
          HOME: homeDirectory,
        },
      },
    );

    assert.match(submitted.stdout, /Статус: принят автоматически/);
    assert.equal(registerAttempts, 1);
    assert.equal(candidateAttempts, 1);
    assert.deepEqual(await readFile(path.join(objectDirectory, "inherited.bin")), binaryBytes);
    assert.equal(
      (await runGit(workspaceDirectory, ["show", "HEAD:sources/inherited.bin"])).stdout,
      expectedPointer,
    );
    assert.ifError(serverError);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test("bridge resumes external object registration from durable per-file progress", {
  timeout: 15_000,
}, async () => {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "trelio-bridge-submit-resume-"));
  const homeDirectory = path.join(temporaryDirectory, "home");
  const runDirectory = path.join(temporaryDirectory, "run");
  const workspaceDirectory = path.join(runDirectory, "workspace");
  const objectDirectory = path.join(workspaceDirectory, "sources");
  const objects = new Map([
    ["sources/a.bin", Buffer.from([0, 1, 2])],
    ["sources/b.bin", Buffer.from([3, 0, 5])],
  ]);
  const specifications = new Map(
    [...objects.entries()].map(([filePath, bytes]) => {
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      return [filePath, {
        bytes,
        sha256,
        pointer: [
          "version https://trelio.ru/spec/workspace-object/v1",
          `oid sha256:${sha256}`,
          `size ${bytes.byteLength}`,
          "content-type application/octet-stream",
          "",
        ].join("\n"),
      }];
    }),
  );
  const requests = [];
  let phase = "interrupt";
  let serverError = null;

  const server = createServer(async (request, response) => {
    try {
      const body = await readRequestBody(request);
      assert.equal(request.headers["x-trelio-agent-workspaces-version"], BRIDGE_VERSION);
      assert.equal(request.headers.authorization, "Bearer integration-token");

      if (request.url?.endsWith("/heartbeat")) {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ leaseExpiresAt: new Date(Date.now() + 60_000).toISOString() }));
        return;
      }

      if (request.url?.endsWith("/objects/register")) {
        const registration = JSON.parse(body.toString("utf8"));
        requests.push({ phase, kind: "register", filePath: registration.filePath });

        if (phase === "interrupt" && registration.filePath === "sources/b.bin") {
          response.statusCode = 503;
          response.setHeader("content-type", "application/json");
          response.end(JSON.stringify({ message: "Synthetic interruption" }));
          return;
        }

        if (phase === "resume" && registration.filePath === "sources/a.bin") {
          throw new Error("Completed object a.bin must not be registered again");
        }

        const specification = specifications.get(registration.filePath);
        assert.ok(specification);
        assert.equal(registration.sha256, specification.sha256);
        assert.equal(registration.sizeBytes, specification.bytes.byteLength);
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ uploadRequired: true }));
        return;
      }

      if (request.method === "PUT" && request.url?.includes("/objects/")) {
        const filePath = decodeURIComponent(String(request.headers["x-trelio-file-path"] || ""));
        requests.push({ phase, kind: "upload", filePath });

        if (phase === "resume" && filePath === "sources/a.bin") {
          throw new Error("Completed object a.bin must not be uploaded again");
        }

        const specification = specifications.get(filePath);
        assert.ok(specification);
        assert.deepEqual(body, specification.bytes);
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({
          uploadRequired: false,
          pointer: specification.pointer,
        }));
        return;
      }

      if (request.url?.endsWith("/candidate")) {
        assert.equal(phase, "resume");
        assert.ok(body.byteLength > 0, "resumed candidate bundle must reach the server");
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({
          run: { status: "accepted" },
          projection: { status: "projected" },
        }));
        return;
      }

      response.statusCode = 404;
      response.end();
    } catch (error) {
      serverError = error;
      response.statusCode = 500;
      response.end(error instanceof Error ? error.message : String(error));
    }
  });

  try {
    await mkdir(objectDirectory, { recursive: true });
    await mkdir(homeDirectory, { recursive: true });
    await runGit(workspaceDirectory, ["init", "--initial-branch=trelio-candidate"]);
    await runGit(workspaceDirectory, ["config", "user.name", "Trelio Bridge Test"]);
    await runGit(workspaceDirectory, ["config", "user.email", "bridge-test@trelio.local"]);
    await writeFile(path.join(workspaceDirectory, "README.md"), "# Base\n", "utf8");
    await runGit(workspaceDirectory, ["add", "README.md"]);
    await runGit(workspaceDirectory, ["commit", "-m", "Base"]);
    const baseHead = (await runGit(workspaceDirectory, ["rev-parse", "HEAD"])).stdout.trim();

    for (const [filePath, specification] of specifications) {
      await writeFile(path.join(workspaceDirectory, filePath), specification.bytes);
    }

    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const serverAddress = server.address();
    assert.ok(serverAddress && typeof serverAddress === "object");
    const origin = `http://127.0.0.1:${serverAddress.port}`;
    await writeTestCredential(homeDirectory, origin);
    const metadataPath = path.join(runDirectory, ".trelio-run.json");
    await writeFile(
      metadataPath,
      `${JSON.stringify({
        schemaVersion: 3,
        origin,
        pluginVersion: BRIDGE_VERSION,
        workspaceId: "44444444-4444-4444-8444-444444444444",
        runId,
        leaseId: "55555555-5555-4555-8555-555555555555",
        fencingToken: 7,
        baseHead,
        workspaceDirectory,
        contextHeads: {},
        contexts: [],
        objects: [],
      }, null, 2)}\n`,
      "utf8",
    );

    await assert.rejects(
      execFileAsync(
        process.execPath,
        [bridgePath, "submit", "--message", "Проверить interrupted object upload"],
        {
          cwd: workspaceDirectory,
          encoding: "utf8",
          timeout: 8_000,
          env: { ...process.env, HOME: homeDirectory },
        },
      ),
      (error) => /Trelio API 503: Synthetic interruption/.test(String(error.stderr)),
    );

    const interruptedMetadata = JSON.parse(await readFile(metadataPath, "utf8"));
    assert.deepEqual(
      interruptedMetadata.objectRegistrationProgress?.map((object) => object.filePath),
      ["sources/a.bin"],
    );
    assert.equal(
      requests.filter((request) => request.phase === "interrupt" && request.kind === "upload").length,
      1,
    );

    phase = "resume";
    const resumed = await execFileAsync(
      process.execPath,
      [bridgePath, "submit", "--message", "Продолжить object upload"],
      {
        cwd: workspaceDirectory,
        encoding: "utf8",
        timeout: 8_000,
        env: { ...process.env, HOME: homeDirectory },
      },
    );

    assert.match(resumed.stdout, /Статус: принят автоматически/);
    assert.deepEqual(
      requests
        .filter((request) => request.phase === "resume" && request.kind === "register")
        .map((request) => request.filePath),
      ["sources/b.bin"],
    );
    assert.deepEqual(
      requests
        .filter((request) => request.phase === "resume" && request.kind === "upload")
        .map((request) => request.filePath),
      ["sources/b.bin"],
    );
    assert.equal(
      (await runGit(workspaceDirectory, ["show", "HEAD:sources/a.bin"])).stdout,
      specifications.get("sources/a.bin").pointer,
    );
    assert.equal(
      (await runGit(workspaceDirectory, ["show", "HEAD:sources/b.bin"])).stdout,
      specifications.get("sources/b.bin").pointer,
    );
    const acceptedMetadata = JSON.parse(await readFile(metadataPath, "utf8"));
    assert.equal("objectRegistrationProgress" in acceptedMetadata, false);
    assert.deepEqual(
      acceptedMetadata.objects.map((object) => object.filePath),
      ["sources/a.bin", "sources/b.bin"],
    );
    assert.ifError(serverError);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test("bridge help advertises the related context sync command", async () => {
  const result = await execFileAsync(process.execPath, [bridgePath, "help"], { encoding: "utf8" });
  assert.match(result.stdout, new RegExp(`Bridge ${BRIDGE_VERSION.replaceAll(".", "\\.")}`));
  assert.match(result.stdout, /trelio-workspace context sync/);
  assert.match(result.stdout, /trelio-workspace context attach --workspace UUID/);
  assert.match(result.stdout, /trelio-workspace context fetch --path/);
  assert.match(result.stdout, /trelio-workspace clean --dry-run/);
});

test("bridge recognizes exact object pointers and classifies binary bytes", async () => {
  const digest = "a".repeat(64);
  const pointer = [
    "version https://trelio.ru/spec/workspace-object/v1",
    `oid sha256:${digest}`,
    "size 3",
    "content-type application/octet-stream",
    "",
  ].join("\n");
  assert.deepEqual(parseWorkspaceObjectPointer(pointer), {
    sha256: digest,
    sizeBytes: 3,
    contentType: "application/octet-stream",
  });
  assert.deepEqual(
    parseWorkspaceObjectPointer(Buffer.from(pointer.replaceAll("\n", "\r\n"), "utf8")),
    {
      sha256: digest,
      sizeBytes: 3,
      contentType: "application/octet-stream",
    },
  );
  assert.equal(parseWorkspaceObjectPointer(pointer.replace("\n", "\r\n")), null);
  assert.equal(parseWorkspaceObjectPointer(pointer.replace("\n", "\r")), null);
  assert.equal(parseWorkspaceObjectPointer(`${pointer}\n`), null);

  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "trelio-bridge-object-test-"));
  const textPath = path.join(temporaryDirectory, "small.md");
  const binaryPath = path.join(temporaryDirectory, "small.bin");

  try {
    await writeFile(textPath, "# Небольшой текст\n", "utf8");
    await writeFile(binaryPath, Buffer.from([0, 1, 2]));
    assert.deepEqual(await inspectWorkspaceFile(textPath), {
      external: false,
      sizeBytes: Buffer.byteLength("# Небольшой текст\n"),
    });
    const binary = await inspectWorkspaceFile(binaryPath);
    assert.equal(binary.external, true);
    assert.equal(binary.sizeBytes, 3);
    assert.match(binary.sha256, /^[0-9a-f]{64}$/);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test("workspace context resolver accepts one canonical or release-window legacy path", async () => {
  const workspaceDirectory = await mkdtemp(path.join(os.tmpdir(), "trelio-context-path-"));

  try {
    await assert.rejects(
      resolveWorkspaceContextFileName(workspaceDirectory),
      /не содержит обязательный WORKSPACE_CONTEXT\.md/u,
    );
    await writeFile(
      path.join(workspaceDirectory, WORKSPACE_CONTEXT_FILE_NAME),
      "# WORKSPACE_CONTEXT\n",
      "utf8",
    );
    assert.equal(
      await resolveWorkspaceContextFileName(workspaceDirectory),
      WORKSPACE_CONTEXT_FILE_NAME,
    );
    await rm(path.join(workspaceDirectory, WORKSPACE_CONTEXT_FILE_NAME));
    await writeFile(
      path.join(workspaceDirectory, LEGACY_WORKSPACE_CONTEXT_FILE_NAME),
      "# PROJECT_CONTEXT\n",
      "utf8",
    );
    assert.equal(
      await resolveWorkspaceContextFileName(workspaceDirectory),
      LEGACY_WORKSPACE_CONTEXT_FILE_NAME,
    );
    await writeFile(
      path.join(workspaceDirectory, WORKSPACE_CONTEXT_FILE_NAME),
      "# WORKSPACE_CONTEXT\n",
      "utf8",
    );
    await assert.rejects(
      resolveWorkspaceContextFileName(workspaceDirectory),
      /одновременно содержит WORKSPACE_CONTEXT\.md и PROJECT_CONTEXT\.md/u,
    );
  } finally {
    await rm(workspaceDirectory, { recursive: true, force: true });
  }
});

test("runtime bootstrap supports a legacy context only during the release migration window", async () => {
  const workspaceDirectory = await mkdtemp(path.join(os.tmpdir(), "trelio-runtime-agents-"));

  try {
    await runGit(workspaceDirectory, ["init", "--initial-branch=main"]);
    await runGit(workspaceDirectory, ["config", "user.name", "Trelio Test"]);
    await runGit(workspaceDirectory, ["config", "user.email", "trelio@example.test"]);
    await writeFile(
      path.join(workspaceDirectory, "AGENTS.md"),
      "# Устаревший серверный шаблон\n",
      "utf8",
    );
    await writeFile(path.join(workspaceDirectory, "CLAUDE.md"), "@AGENTS.md\n", "utf8");
    await writeFile(path.join(workspaceDirectory, "PROJECT_CONTEXT.md"), "# Контекст\n", "utf8");
    await writeFile(
      path.join(workspaceDirectory, "WORKLOG.md"),
      "# Собственный формат журнала\n",
      "utf8",
    );
    await runGit(workspaceDirectory, ["add", "--all"]);
    await runGit(workspaceDirectory, ["commit", "-m", "Legacy workspace"]);

    await materializeRuntimeControlFiles(workspaceDirectory);

    assert.equal(
      await readFile(path.join(workspaceDirectory, "AGENTS.md"), "utf8"),
      buildAgentWorkspaceRuntimeAgentsMarkdown(LEGACY_WORKSPACE_CONTEXT_FILE_NAME),
    );
    assert.equal(
      await readFile(path.join(workspaceDirectory, "CLAUDE.md"), "utf8"),
      AGENT_WORKSPACE_RUNTIME_CLAUDE_MARKDOWN,
    );
    assert.equal(
      await readFile(path.join(workspaceDirectory, "WORKLOG.md"), "utf8"),
      "# Собственный формат журнала\n",
      "saved workspace WORKLOG must never be replaced with a newer default",
    );
    assert.equal((await runGit(workspaceDirectory, ["status", "--porcelain"])).stdout, "");

    await writeFile(path.join(workspaceDirectory, "result.md"), "# Результат\n", "utf8");
    await runGit(workspaceDirectory, ["add", "--all"]);
    assert.equal(
      (await runGit(workspaceDirectory, ["diff", "--cached", "--name-only"])).stdout,
      "result.md\n",
      "legacy tracked bootstrap must retain its base blobs until server migration removes them",
    );
  } finally {
    if (process.platform !== "win32") {
      await execFileAsync("chmod", ["-R", "u+w", workspaceDirectory]).catch(() => undefined);
    }
    await rm(workspaceDirectory, { recursive: true, force: true });
  }
});

test("bridge creates a default WORKLOG only when missing and preserves later edits", async () => {
  const workspaceDirectory = await mkdtemp(path.join(os.tmpdir(), "trelio-runtime-worklog-"));

  try {
    await runGit(workspaceDirectory, ["init", "--initial-branch=main"]);
    await runGit(workspaceDirectory, ["config", "user.name", "Trelio Test"]);
    await runGit(workspaceDirectory, ["config", "user.email", "trelio@example.test"]);
    await writeFile(path.join(workspaceDirectory, "WORKSPACE_CONTEXT.md"), "# Контекст\n", "utf8");
    await runGit(workspaceDirectory, ["add", "--all"]);
    await runGit(workspaceDirectory, ["commit", "-m", "Workspace without a worklog"]);

    const created = await ensureWorkspaceWorklog(workspaceDirectory);
    assert.deepEqual(created, { created: true, isDefault: true });
    assert.equal(
      await readFile(path.join(workspaceDirectory, "WORKLOG.md"), "utf8"),
      AGENT_WORKSPACE_DEFAULT_WORKLOG_MARKDOWN,
    );
    assert.equal(
      await getGitStatus(workspaceDirectory),
      "",
      "an untouched reproducible fallback must not make an abandoned Run permanently dirty",
    );

    await writeFile(
      path.join(workspaceDirectory, "WORKLOG.md"),
      "# Формат журнала компании\n",
      "utf8",
    );
    assert.equal(await getGitStatus(workspaceDirectory), "?? WORKLOG.md");
    assert.deepEqual(
      await ensureWorkspaceWorklog(workspaceDirectory),
      { created: false, isDefault: false },
    );
    assert.equal(
      await readFile(path.join(workspaceDirectory, "WORKLOG.md"), "utf8"),
      "# Формат журнала компании\n",
    );
  } finally {
    await rm(workspaceDirectory, { recursive: true, force: true });
  }
});

test("bridge keeps AGENTS.md, CLAUDE.md and .trelio as protected inline control files", () => {
  assert.equal(isProtectedWorkspaceControlPath("AGENTS.md"), true);
  assert.equal(isProtectedWorkspaceControlPath("CLAUDE.md"), true);
  assert.equal(isProtectedWorkspaceControlPath(".trelio/workspace.json"), true);
  assert.equal(isProtectedWorkspaceControlPath("WORKSPACE_CONTEXT.md"), false);
  assert.equal(isProtectedWorkspaceControlPath("PROJECT_CONTEXT.md"), false);
  assert.equal(isProtectedWorkspaceControlPath("work/CLAUDE.md"), false);
});
