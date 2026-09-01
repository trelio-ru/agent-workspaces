import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, generateKeyPairSync, sign, webcrypto } from "node:crypto";
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
import { createServer, request as requestHttp } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  AGENT_SKILL_LARGE_PACKAGE_HOST_MINIMUM_VERSION,
  AGENT_SKILL_LEGACY_MAX_PACKAGE_BYTES,
  AGENT_SKILL_MAX_DECODED_FILE_BYTES,
  AGENT_SKILL_MAX_ENCRYPTED_PACKAGE_BYTES,
  AGENT_SKILL_MAX_FILE_COUNT,
  AGENT_SKILL_MAX_PACKAGE_BYTES,
  AGENT_SKILL_RUNTIME_HOST_MINIMUM_VERSION,
  AGENT_WORKSPACE_DEFAULT_WORKLOG_MARKDOWN,
  AGENT_WORKSPACE_RUNTIME_AGENTS_MARKDOWN,
  AGENT_WORKSPACE_RUNTIME_CLAUDE_MARKDOWN,
  BRIDGE_VERSION,
  LEGACY_WORKSPACE_CONTEXT_FILE_NAME,
  WORKSPACE_CONTEXT_FILE_NAME,
  BridgePluginUpgradeRequiredError,
  BrowserOpenError,
  AgentSkillDeviceConsentDeclinedError,
  TrelioApiError,
  WINDOWS_PRIVATE_ACL_SCRIPT,
  assertMaterializedWorkspaceFileTypes,
  applyAgentRulesHandshake,
  buildAgentWorkspaceRuntimeAgentsMarkdown,
  buildAgentSkillPackage,
  buildAgentSkillRuntimePath,
  buildAgentSkillRuntimeEnvironment,
  buildIsolatedPythonRuntimeArguments,
  resolveTrustedPythonInvocation,
  sanitizeAgentSkillInheritedEnvironment,
  buildWindowsPrivateAclPowerShellInvocation,
  canOmitAgentWorkspaceHandoffFiles,
  buildRunContextSpecifications,
  buildBridgeRequestHeaders,
  collectAgentSkillDeviceConsentThroughLoopback,
  collectCompanyEncryptionKeyThroughLoopback,
  hardenWindowsPrivatePath,
  getGitStatus,
  hydrateAgentCompanyEncryptedJson,
  inspectWorkspaceFile,
  isCodexPluginAutoUpdateEnvironment,
  isProtectedWorkspaceControlPath,
  isStableVersionAtLeast,
  isTransientCodexMarketplaceUpdateError,
  materializeRuntimeControlFiles,
  resolveWorkspaceContextFileName,
  ensureWorkspaceWorklog,
  normalizeAgentSkillPackagePath,
  normalizeAgentSkillDeviceConsentChallenge,
  normalizeResolvedSkillRuntimeArtifact,
  openBrowser,
  parseAndValidateAgentSkillPackage,
  parseAgentSecretSetInput,
  parseWorkspaceObjectPointer,
  recoverBridgePluginUpgrade,
  restoreRetainedCodexPluginInstallations,
  retainLoadedCodexPluginInstallation,
  readBoundedResponseBuffer,
  request,
  renderAgentSkillDeviceConsentPage,
  renderCompanyEncryptionKeyPage,
  runCompanyEncryptionSelfTest,
  resolveAgentSkillRuntimeWithDeviceConsent,
  resolveWorkspaceBridgeConfigDirectory,
  updateCodexPluginMarketplace,
  validateHandoffTaskOutcome,
  withEncryptedWorkspaceBrowserProjection,
} from "../scripts/trelio-workspace.mjs";
import {
  COMPANY_ENCRYPTION_SUITE,
  createAgentEncryptionDevice,
  decryptFileFromCompanyContainer,
  encryptCompanyPayload,
} from "../scripts/trelio-company-encryption.mjs";
import {
  buildSecretBrowserArguments,
  controlSecretBrowserViaDevTools,
  createSecretBrowserControllerExpression,
  normalizeSecretBrowserFieldSelector,
  normalizeSecretBrowserTarget,
  resolveTrustedSecretBrowserExecutable,
  runSecretBrowserFill,
} from "../scripts/trelio-secret-browser.mjs";

const execFileAsync = promisify(execFile);
const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const pluginDirectory = path.resolve(testDirectory, "..");
const bridgePath = path.resolve(testDirectory, "../scripts/trelio-workspace.mjs");
const runId = "11111111-1111-4111-8111-111111111111";
const companyWorkspaceId = "22222222-2222-4222-8222-222222222222";
const relatedWorkspaceId = "33333333-3333-4333-8333-333333333333";
const testCompany = {
  id: "99999999-9999-4999-8999-999999999999",
  slug: "bridge-test-company",
  name: "Bridge test company",
};
const companyHead = "a".repeat(40);
const relatedHead = "b".repeat(40);

/**
 * Execute the real bridge entrypoint while supplying protected stdin bytes.
 * `execFile` does not have an `input` option, so tests must close the pipe
 * explicitly just like a real producer would.
 */
const execBridgeWithInput = (argumentsList, input, options) => new Promise((resolve, reject) => {
  const child = execFile(
    process.execPath,
    [bridgePath, ...argumentsList],
    options,
    (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    },
  );

  child.stdin.end(input);
});

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

test("encrypted project routing slugs become process-only aliases", async () => {
  const companyId = "11111111-1111-4111-8111-111111111111";
  const scopeId = "22222222-2222-4222-8222-222222222222";
  const entityId = "33333333-3333-4333-8333-333333333333";
  const deviceId = "44444444-4444-4444-8444-444444444444";
  const unrelatedEntityId = "55555555-5555-4555-8555-555555555555";
  const scope = await webcrypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits"],
  );
  const scopePublicEncryptionJwk = await webcrypto.subtle.exportKey("jwk", scope.publicKey);
  const scopePrivateJwk = await webcrypto.subtle.exportKey("jwk", scope.privateKey);
  const encryptedPayload = {
    ...(await encryptCompanyPayload({
      payload: { values: { slug: "readable-project" } },
      scopePublicEncryptionJwk,
      aad: {
        companyId,
        scopeId,
        scopeEpoch: 1,
        entityType: "api.browser_mutation",
        entityId,
        entityRevision: 1,
        purpose: "content",
      },
    })),
    scopeId,
    scopeEpoch: 1,
    entityId,
    entityRevision: 1,
  };
  let resolverRequest = null;
  let serverError = null;
  const server = createServer(async (incoming, outgoing) => {
    try {
      resolverRequest = JSON.parse((await readRequestBody(incoming)).toString("utf8"));
      outgoing.writeHead(200, { "content-type": "application/json" });
      outgoing.end(JSON.stringify({ payloads: [encryptedPayload] }));
    } catch (error) {
      serverError = error;
      outgoing.writeHead(500, { "content-type": "application/json" });
      outgoing.end(JSON.stringify({ message: "test server failed" }));
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    const address = server.address();
    const hydrated = await hydrateAgentCompanyEncryptedJson({
      value: {
        projects: [{
          id: "66666666-6666-4666-8666-666666666666",
          slug: `e-${entityId}`,
          slugAliases: [],
        }],
        // Without slugAliases this is ordinary data, not a routing object.
        unrelated: { slug: `e-${unrelatedEntityId}` },
      },
      origin: `http://127.0.0.1:${address.port}`,
      token: "test-token",
      companyEncryption: {
        runtime: {
          company: { id: companyId, slug: "encrypted-company" },
          device: { id: deviceId },
        },
        scopePrivateEncryptionKey: {
          privateKey: scope.privateKey,
          privateJwk: scopePrivateJwk,
        },
      },
    });

    assert.ifError(serverError);
    assert.deepEqual(resolverRequest.entityIds, [entityId]);
    assert.equal(hydrated.projects[0].slug, `e-${entityId}`);
    assert.deepEqual(hydrated.projects[0].slugAliases, ["readable-project"]);
    assert.equal(hydrated.unrelated.slug, `e-${unrelatedEntityId}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

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
    const thirdUpdate = await updateFrom("1.6.21", "1.6.22");
    assert.equal(thirdUpdate.version, "1.6.22");
    assert.equal(
      await readFile(path.join(
        version121Path,
        "skills",
        "trelio-skill-catalog",
        "SKILL.md",
      ), "utf8"),
      "exact skill 1.6.21\n",
    );

    const version122Path = path.join(pluginCacheDirectory, "1.6.22");
    const fourthUpdate = await updateFrom("1.6.22", "1.6.23");
    assert.equal(fourthUpdate.version, "1.6.23");
    assert.equal(
      await readFile(path.join(
        version122Path,
        "skills",
        "trelio-skill-catalog",
        "SKILL.md",
      ), "utf8"),
      "exact skill 1.6.22\n",
    );

    const version123Path = path.join(pluginCacheDirectory, "1.6.23");
    await retainLoadedCodexPluginInstallation({
      loadedPluginDirectory: version123Path,
      loadedPluginVersion: "1.6.23",
      retentionDirectory,
    });
    await Promise.all([
      rm(version119Path, { recursive: true, force: true }),
      rm(version120Path, { recursive: true, force: true }),
    ]);
    assert.equal(
      await restoreRetainedCodexPluginInstallations({ retentionDirectory }),
      5,
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

const buildCompanyRuntimeConsentChallenge = () => ({
  schemaVersion: 1,
  trustLevel: "company_unverified",
  company: {
    id: "11111111-1111-4111-8111-111111111111",
    name: "Example & Company",
  },
  skill: {
    id: "company-11111111-1111-4111-8111-111111111111-synthetic-runtime",
    title: "Synthetic <Runtime>",
    version: "1.1.0",
    releaseId: "22222222-2222-4222-8222-222222222222",
  },
  publication: {
    id: "33333333-3333-4333-8333-333333333333",
    sequence: 2,
    summary: "Обновлён synthetic runtime protocol",
    changeReason: "Нужно проверить новую версию generic host protocol",
    publishedAt: "2026-08-28T10:00:00.000Z",
    publisher: {
      displayName: "Company Admin",
      username: "company-admin",
    },
  },
  artifact: {
    id: "44444444-4444-4444-8444-444444444444",
    runtimeVersion: "1.1.0",
    packageSha256: "a".repeat(64),
    packageSizeBytes: 65_536,
    instructionsSha256: "b".repeat(64),
    capabilities: ["browser", "local-session"],
  },
  changes: {
    kind: "update",
    previousVersion: "1.0.0",
    packageChanged: true,
    instructionsChanged: true,
    capabilitiesAdded: ["browser"],
    capabilitiesRemoved: [],
  },
});

/**
 * Open a loopback decision request and send only its headers at first.
 *
 * Keeping the body pending lets the regression place two requests inside the
 * server's asynchronous body-read window. That makes the one-shot race
 * deterministic instead of relying on two ordinary `fetch` calls happening to
 * overlap on a particular machine.
 */
const startPendingCompanyRuntimeConsentDecision = (
  consentUrl,
  {
    nonce = consentUrl.searchParams.get("nonce"),
    decision = "accept",
    origin = consentUrl.origin,
    host = consentUrl.host,
  } = {},
) => {
  const body = new URLSearchParams({ nonce, decision }).toString();
  let finish;
  const response = new Promise((resolve, reject) => {
    const outgoing = requestHttp(new URL("/decision", consentUrl), {
      method: "POST",
      headers: {
        "content-length": Buffer.byteLength(body),
        "content-type": "application/x-www-form-urlencoded",
        host,
        origin,
      },
    }, async (incoming) => {
      const chunks = [];
      for await (const chunk of incoming) {
        chunks.push(chunk);
      }
      resolve({
        statusCode: incoming.statusCode,
        body: Buffer.concat(chunks).toString("utf8"),
      });
    });
    outgoing.once("error", reject);
    outgoing.flushHeaders();
    finish = () => outgoing.end(body);
  });

  return { finish, response };
};

test("company runtime consent page exposes provenance and escapes admin text", () => {
  const challenge = normalizeAgentSkillDeviceConsentChallenge(
    buildCompanyRuntimeConsentChallenge(),
  );
  const html = renderAgentSkillDeviceConsentPage({
    challenge,
    nonce: "private-nonce",
  });

  assert.match(html, /Навык не проверен Trelio/u);
  assert.match(html, /Нужно проверить новую версию generic host protocol/u);
  assert.match(html, /Company Admin \(@company-admin\)/u);
  assert.match(html, /Synthetic &lt;Runtime&gt;/u);
  assert.doesNotMatch(html, /Synthetic <Runtime>/u);
  assert.match(html, /Установить и запустить/u);
});

test("company encryption key page is local-only copy and escapes company names", () => {
  const html = renderCompanyEncryptionKeyPage({
    companyName: 'Private <Company> & "team"',
    nonce: "one-time-nonce",
  });

  assert.match(html, /Ключ шифрования/u);
  assert.match(html, /Private &lt;Company&gt; &amp; &quot;team&quot;/u);
  assert.doesNotMatch(html, /Private <Company>/u);
  assert.match(html, /не попадёт в Trelio, командную строку, Workspace или логи/u);
  assert.match(html, /name="secret"/u);
  assert.match(html, /name="confirmation"/u);
});

test("company encryption key is returned only after an exact loopback form submission", async () => {
  const key = "correct horse battery staple";
  const received = await collectCompanyEncryptionKeyThroughLoopback({
    companyName: "Encrypted company",
  }, {
    openBrowserFn: async (url) => {
      const keyUrl = new URL(url);
      const pageResponse = await fetch(keyUrl);
      assert.equal(pageResponse.status, 200);
      assert.doesNotMatch(await pageResponse.text(), new RegExp(key, "u"));

      const unlockResponse = await fetch(new URL("/unlock", keyUrl), {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          origin: keyUrl.origin,
        },
        body: new URLSearchParams({
          nonce: keyUrl.searchParams.get("nonce"),
          decision: "save",
          secret: key,
          confirmation: key,
        }),
      });
      assert.equal(unlockResponse.status, 200);
      assert.doesNotMatch(await unlockResponse.text(), new RegExp(key, "u"));
    },
    timeoutMs: 5_000,
  });

  assert.equal(received, key);
});

test("company encryption onboarding self-test round-trips the production TRELIOE1 codec", async () => {
  const scopeKeyPair = await webcrypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits"],
  );
  const [scopePublicEncryptionJwk, scopePrivateEncryptionJwk, device] = await Promise.all([
    webcrypto.subtle.exportKey("jwk", scopeKeyPair.publicKey),
    webcrypto.subtle.exportKey("jwk", scopeKeyPair.privateKey),
    createAgentEncryptionDevice(),
  ]);
  const result = await runCompanyEncryptionSelfTest({
    runtime: {
      suite: COMPANY_ENCRYPTION_SUITE,
      state: "encrypted",
      accessState: "ready",
      company: {
        id: "11111111-1111-4111-8111-111111111111",
        slug: "encrypted-company",
        name: "Encrypted company",
      },
      scope: {
        id: "22222222-2222-4222-8222-222222222222",
        epoch: 1,
        publicEncryptionJwk: scopePublicEncryptionJwk,
      },
      device: { id: "33333333-3333-4333-8333-333333333333" },
    },
    device,
    scopePrivateEncryptionKey: {
      privateKey: scopeKeyPair.privateKey,
      privateJwk: scopePrivateEncryptionJwk,
    },
  });

  assert.deepEqual(result, {
    status: "passed",
    format: "TRELIOE1",
    suite: COMPANY_ENCRYPTION_SUITE,
  });
});

test("encryption setup reports plain companies without creating a Run", async () => {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "trelio-encryption-setup-"));
  const homeDirectory = path.join(temporaryDirectory, "home");
  const requests = [];
  let serverError = null;
  const server = createServer((request, response) => {
    try {
      requests.push({ method: request.method, url: request.url });
      assert.equal(request.headers.authorization, "Bearer integration-token");
      assert.equal(request.headers["x-trelio-agent-workspaces-version"], BRIDGE_VERSION);

      response.setHeader("content-type", "application/json");
      if (request.url === "/api/agent-workspaces/bridge-compatibility") {
        response.end(JSON.stringify({
          supported: true,
          minimumVersion: BRIDGE_VERSION,
          agentRules: null,
        }));
        return;
      }
      if (request.url?.startsWith("/api/agent-workspaces/encryption/runtime?")) {
        response.end(JSON.stringify({
          suite: COMPANY_ENCRYPTION_SUITE,
          state: "plain",
          company: testCompany,
        }));
        return;
      }
      throw new Error(`Unexpected encryption setup request: ${request.method} ${request.url}`);
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

    const result = await execFileAsync(
      process.execPath,
      [
        bridgePath,
        "encryption",
        "setup",
        "--company",
        testCompany.slug,
        "--json",
        "--origin",
        origin,
      ],
      {
        cwd: temporaryDirectory,
        encoding: "utf8",
        timeout: 10_000,
        env: { ...process.env, HOME: homeDirectory },
      },
    );
    assert.deepEqual(JSON.parse(result.stdout), {
      schemaVersion: 1,
      status: "not_required",
      company: { slug: testCompany.slug },
      encryptionState: "plain",
      selfTest: null,
    });
    assert.equal(requests.some(({ method }) => method !== "GET"), false);
    assert.equal(requests.some(({ url }) => String(url).includes("/runs")), false);
    assert.ifError(serverError);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test("company runtime consent requires a real loopback form decision before server grant", async () => {
  const challenge = buildCompanyRuntimeConsentChallenge();
  const consentRequests = [];
  const accepted = await collectAgentSkillDeviceConsentThroughLoopback({
    origin: "https://trelio.example",
    token: "paired-device-token",
    challenge,
    companyId: challenge.company.id,
    skillId: challenge.skill.id,
    releaseId: challenge.skill.releaseId,
  }, {
    requestFn: async (origin, token, pathname, options) => {
      consentRequests.push({ origin, token, pathname, options });
      return new Response(JSON.stringify({ consent: { id: "accepted" } }), {
        status: 201,
        headers: { "content-type": "application/json" },
      });
    },
    openBrowserFn: async (url) => {
      const consentUrl = new URL(url);
      const pageResponse = await fetch(consentUrl);
      assert.equal(pageResponse.status, 200);
      assert.match(await pageResponse.text(), /Навык не проверен Trelio/u);

      const decisionResponse = await fetch(new URL("/decision", consentUrl), {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          origin: consentUrl.origin,
        },
        body: new URLSearchParams({
          nonce: consentUrl.searchParams.get("nonce"),
          decision: "accept",
        }),
      });
      assert.equal(decisionResponse.status, 200);
      assert.match(await decisionResponse.text(), /Эта версия разрешена/u);
    },
    timeoutMs: 5_000,
  });

  assert.equal(accepted, true);
  assert.equal(consentRequests.length, 1);
  assert.equal(consentRequests[0].pathname, "/api/agent-skills/runtime/device-consents");
  assert.equal(consentRequests[0].token, "paired-device-token");
  assert.deepEqual(JSON.parse(consentRequests[0].options.body), {
    companyId: challenge.company.id,
    skillId: challenge.skill.id,
    expectedReleaseId: challenge.skill.releaseId,
    publicationId: challenge.publication.id,
    runtimeArtifactId: challenge.artifact.id,
    packageSha256: challenge.artifact.packageSha256,
    instructionsSha256: challenge.artifact.instructionsSha256,
  });
});

test("declining company runtime consent never calls the server grant endpoint", async () => {
  const challenge = buildCompanyRuntimeConsentChallenge();
  let consentRequestCount = 0;

  await assert.rejects(
    collectAgentSkillDeviceConsentThroughLoopback({
      origin: "https://trelio.example",
      token: "paired-device-token",
      challenge,
      companyId: challenge.company.id,
      skillId: challenge.skill.id,
      releaseId: challenge.skill.releaseId,
    }, {
      requestFn: async () => {
        consentRequestCount += 1;
      },
      openBrowserFn: async (url) => {
        const consentUrl = new URL(url);
        await fetch(consentUrl);
        await fetch(new URL("/decision", consentUrl), {
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            origin: consentUrl.origin,
          },
          body: new URLSearchParams({
            nonce: consentUrl.searchParams.get("nonce"),
            decision: "decline",
          }),
        });
      },
      timeoutMs: 5_000,
    }),
    (error) => error instanceof AgentSkillDeviceConsentDeclinedError,
  );
  assert.equal(consentRequestCount, 0);
});

test("company runtime consent rejects wrong origin, host and nonce without consuming the form", async () => {
  const challenge = buildCompanyRuntimeConsentChallenge();
  let consentRequestCount = 0;

  const accepted = await collectAgentSkillDeviceConsentThroughLoopback({
    origin: "https://trelio.example",
    token: "paired-device-token",
    challenge,
    companyId: challenge.company.id,
    skillId: challenge.skill.id,
    releaseId: challenge.skill.releaseId,
  }, {
    requestFn: async () => {
      consentRequestCount += 1;
      return new Response(JSON.stringify({ consent: { id: "accepted" } }), {
        status: 201,
        headers: { "content-type": "application/json" },
      });
    },
    openBrowserFn: async (url) => {
      const consentUrl = new URL(url);
      const pageResponse = await fetch(consentUrl);
      assert.equal(pageResponse.status, 200);

      const wrongOrigin = startPendingCompanyRuntimeConsentDecision(consentUrl, {
        origin: "http://attacker.invalid",
      });
      wrongOrigin.finish();
      assert.equal((await wrongOrigin.response).statusCode, 403);

      const wrongHost = startPendingCompanyRuntimeConsentDecision(consentUrl, {
        host: `localhost:${consentUrl.port}`,
      });
      wrongHost.finish();
      assert.equal((await wrongHost.response).statusCode, 403);

      const wrongNonce = startPendingCompanyRuntimeConsentDecision(consentUrl, {
        nonce: "not-the-one-time-nonce",
      });
      wrongNonce.finish();
      assert.equal((await wrongNonce.response).statusCode, 403);

      assert.equal(consentRequestCount, 0);
      const validDecision = startPendingCompanyRuntimeConsentDecision(consentUrl);
      validDecision.finish();
      assert.equal((await validDecision.response).statusCode, 200);
    },
    timeoutMs: 5_000,
  });

  assert.equal(accepted, true);
  assert.equal(consentRequestCount, 1);
});

test("company runtime consent times out without creating a server grant", async () => {
  const challenge = buildCompanyRuntimeConsentChallenge();
  let consentRequestCount = 0;

  await assert.rejects(
    collectAgentSkillDeviceConsentThroughLoopback({
      origin: "https://trelio.example",
      token: "paired-device-token",
      challenge,
      companyId: challenge.company.id,
      skillId: challenge.skill.id,
      releaseId: challenge.skill.releaseId,
    }, {
      requestFn: async () => {
        consentRequestCount += 1;
      },
      openBrowserFn: async (url) => {
        const pageResponse = await fetch(url);
        assert.equal(pageResponse.status, 200);
      },
      timeoutMs: 100,
    }),
    /AGENT_SKILL_DEVICE_CONSENT_TIMEOUT/u,
  );
  assert.equal(consentRequestCount, 0);
});

test("concurrent accept decisions create exactly one device grant", async () => {
  const challenge = buildCompanyRuntimeConsentChallenge();
  let consentRequestCount = 0;

  const accepted = await collectAgentSkillDeviceConsentThroughLoopback({
    origin: "https://trelio.example",
    token: "paired-device-token",
    challenge,
    companyId: challenge.company.id,
    skillId: challenge.skill.id,
    releaseId: challenge.skill.releaseId,
  }, {
    requestFn: async () => {
      consentRequestCount += 1;
      return new Response(JSON.stringify({ consent: { id: "accepted" } }), {
        status: 201,
        headers: { "content-type": "application/json" },
      });
    },
    openBrowserFn: async (url) => {
      const consentUrl = new URL(url);
      const first = startPendingCompanyRuntimeConsentDecision(consentUrl);
      const second = startPendingCompanyRuntimeConsentDecision(consentUrl);

      // Both handlers have received valid headers and are waiting for their
      // bounded bodies before either request is allowed to claim the decision.
      await new Promise((resolve) => setTimeout(resolve, 25));
      first.finish();
      second.finish();

      const responses = await Promise.all([first.response, second.response]);
      assert.deepEqual(
        responses.map(({ statusCode }) => statusCode).sort(),
        [200, 403],
      );
    },
    timeoutMs: 5_000,
  });

  assert.equal(accepted, true);
  assert.equal(consentRequestCount, 1);
});

test("a concurrent decline wins without a hidden accept grant", async () => {
  const challenge = buildCompanyRuntimeConsentChallenge();
  let consentRequestCount = 0;

  await assert.rejects(
    collectAgentSkillDeviceConsentThroughLoopback({
      origin: "https://trelio.example",
      token: "paired-device-token",
      challenge,
      companyId: challenge.company.id,
      skillId: challenge.skill.id,
      releaseId: challenge.skill.releaseId,
    }, {
      requestFn: async () => {
        consentRequestCount += 1;
      },
      openBrowserFn: async (url) => {
        const consentUrl = new URL(url);
        const decline = startPendingCompanyRuntimeConsentDecision(consentUrl, {
          decision: "decline",
        });
        const accept = startPendingCompanyRuntimeConsentDecision(consentUrl, {
          decision: "accept",
        });

        await new Promise((resolve) => setTimeout(resolve, 25));
        decline.finish();
        await new Promise((resolve) => setImmediate(resolve));
        accept.finish();

        const [declineResponse, acceptResponse] = await Promise.all([
          decline.response,
          accept.response,
        ]);
        assert.equal(declineResponse.statusCode, 200);
        assert.equal(acceptResponse.statusCode, 403);
      },
      timeoutMs: 5_000,
    }),
    (error) => error instanceof AgentSkillDeviceConsentDeclinedError,
  );
  assert.equal(consentRequestCount, 0);
});

test("device consent returns only after a second live resolve and before package access", async () => {
  const challenge = buildCompanyRuntimeConsentChallenge();
  const events = [];
  const finalResponse = new Response(JSON.stringify({ releaseId: challenge.skill.releaseId }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
  let resolveCount = 0;

  const response = await resolveAgentSkillRuntimeWithDeviceConsent({
    origin: "https://trelio.example",
    token: "paired-device-token",
    companyId: challenge.company.id,
    projectId: null,
    skillId: challenge.skill.id,
    releaseId: challenge.skill.releaseId,
  }, {
    requestFn: async (_origin, _token, pathname) => {
      assert.equal(pathname, "/api/agent-skills/runtime/resolve");
      resolveCount += 1;
      events.push(resolveCount === 1 ? "resolve-before-consent" : "resolve-after-consent");
      if (resolveCount === 1) {
        throw new TrelioApiError(
          409,
          "Device consent is required",
          null,
          "AGENT_SKILL_DEVICE_CONSENT_REQUIRED",
          { challenge },
        );
      }
      return finalResponse;
    },
    collectConsentFn: async (input) => {
      events.push("consent");
      assert.equal(input.challenge, challenge);
      assert.equal(input.releaseId, challenge.skill.releaseId);
    },
  });

  assert.equal(response, finalResponse);
  // Package/cache work lives in the caller and cannot begin until the consent
  // helper returns the response from the second exact live resolve.
  events.push("package-access");
  assert.deepEqual(events, [
    "resolve-before-consent",
    "consent",
    "resolve-after-consent",
    "package-access",
  ]);
});

test("encrypted runtime is locally inspected before consent and then resolved again", async () => {
  const challenge = buildCompanyRuntimeConsentChallenge();
  const preview = {
    artifact: { contentProtection: "company_e2ee_v1" },
    trust: { requiresDeviceConsent: true, consentId: null },
    consentChallenge: challenge,
  };
  const finalResponse = new Response(JSON.stringify({
    artifact: { contentProtection: "company_e2ee_v1" },
    trust: { requiresDeviceConsent: true, consentId: crypto.randomUUID() },
  }), { status: 200, headers: { "content-type": "application/json" } });
  const events = [];
  let resolveCount = 0;

  const response = await resolveAgentSkillRuntimeWithDeviceConsent({
    origin: "https://trelio.example",
    token: "paired-device-token",
    companyId: challenge.company.id,
    projectId: null,
    skillId: challenge.skill.id,
    releaseId: challenge.skill.releaseId,
  }, {
    requestFn: async () => {
      resolveCount += 1;
      events.push(resolveCount === 1 ? "encrypted-preview" : "resolve-after-consent");
      return resolveCount === 1
        ? new Response(JSON.stringify(preview), {
            status: 200,
            headers: { "content-type": "application/json" },
          })
        : finalResponse;
    },
    prepareEncryptedConsentFn: async (input) => {
      events.push("decrypt-inspect-consent");
      assert.deepEqual(input.rawResolution.consentChallenge, challenge);
      assert.equal(input.releaseId, challenge.skill.releaseId);
    },
  });

  assert.equal(response, finalResponse);
  assert.deepEqual(events, [
    "encrypted-preview",
    "decrypt-inspect-consent",
    "resolve-after-consent",
  ]);
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

      if (request.url?.startsWith("/api/agent-workspaces/encryption/runtime?")) {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({
          suite: "trelio-e2ee-v1",
          state: "plain",
          company: testCompany,
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
          company: testCompany,
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
      /Native Trelio MCP и bundled bridge являются единственным штатным control\/data plane/u,
    );
    assert.match(
      AGENT_WORKSPACE_RUNTIME_AGENTS_MARKDOWN,
      /загружай только соответствующий reference.*не читай все references заранее/u,
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
      /Комментарий, статус, checklist и control задачи являются отдельными user-decision flows/u,
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

test("future Runs reuse one persistent Workspace folder and sync accepted head before start", {
  timeout: 20_000,
}, async () => {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "trelio-bridge-persistent-"));
  const homeDirectory = path.join(temporaryDirectory, "home");
  const workspaceId = "44444444-4444-4444-8444-444444444444";
  const secondRunId = "55555555-5555-4555-8555-555555555555";
  const thirdRunId = "66666666-6666-4666-8666-666666666666";
  const firstExport = await createExportBundle(path.join(temporaryDirectory, "first"), {
    "WORKSPACE_CONTEXT.md": "# Persistent workspace\n",
    "shared.md": "first accepted version\n",
  });
  const secondExport = await createExportBundle(path.join(temporaryDirectory, "second"), {
    "WORKSPACE_CONTEXT.md": "# Persistent workspace\n",
    "shared.md": "second accepted version\n",
    "reused.md": "same local folder\n",
  });
  const events = [];
  let acceptedHead = firstExport.head;
  let firstRunStatus = "running";
  let secondRunStatus = null;
  let startCount = 0;
  let serverError = null;
  let markFirstStartSeen;
  let releaseFirstStart;
  const firstStartSeen = new Promise((resolve) => {
    markFirstStartSeen = resolve;
  });
  const firstStartGate = new Promise((resolve) => {
    releaseFirstStart = resolve;
  });

  const serializeRun = (id, head, status) => ({
    id,
    status,
    leaseId: id === runId
      ? "77777777-7777-4777-8777-777777777777"
      : "88888888-8888-4888-8888-888888888888",
    fencingToken: 1,
    baseHead: head,
    draftHead: null,
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
      assert.equal(request.headers["x-trelio-agent-workspaces-version"], BRIDGE_VERSION);
      assert.equal(request.headers.authorization, "Bearer integration-token");

      if (request.url === "/api/agent-workspaces/bridge-compatibility") {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ supported: true, minimumVersion: BRIDGE_VERSION }));
        return;
      }

      if (request.url?.startsWith("/api/agent-workspaces/encryption/runtime?")) {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({
          suite: "trelio-e2ee-v1",
          state: "plain",
          company: testCompany,
        }));
        return;
      }

      if (
        request.method === "GET"
        && request.url === `/api/agent-workspaces/workspaces/${workspaceId}`
      ) {
        events.push("overview");
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({
          workspace: { id: workspaceId, acceptedHead },
          company: testCompany,
          runs: [
            serializeRun(runId, firstExport.head, firstRunStatus),
            ...(secondRunStatus
              ? [serializeRun(secondRunId, secondExport.head, secondRunStatus)]
              : []),
          ],
          checkpoints: [],
        }));
        return;
      }

      if (
        request.method === "POST"
        && request.url === `/api/agent-workspaces/workspaces/${workspaceId}/runs`
      ) {
        startCount += 1;
        events.push(`start-${startCount}`);
        if (startCount === 1) {
          markFirstStartSeen();
          await firstStartGate;
        }
        const currentRun = startCount === 1
          ? serializeRun(runId, firstExport.head, firstRunStatus)
          : startCount === 2
            ? serializeRun(secondRunId, secondExport.head, "running")
            : serializeRun(thirdRunId, secondExport.head, "running");
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({
          run: currentRun,
          workspace: { id: workspaceId, acceptedHead },
          company: testCompany,
        }));
        return;
      }

      if (request.url === `/api/agent-workspaces/runs/${runId}/bundle`) {
        response.setHeader("content-type", "application/vnd.git.bundle");
        response.end(firstExport.bundle);
        return;
      }

      if (request.url === `/api/agent-workspaces/runs/${secondRunId}/bundle`) {
        response.setHeader("content-type", "application/vnd.git.bundle");
        response.end(secondExport.bundle);
        return;
      }

      if (
        request.url
        === `/api/agent-workspaces/workspaces/${workspaceId}/bundle?head=${secondExport.head}`
      ) {
        events.push("accepted-bundle");
        response.setHeader("content-type", "application/vnd.git.bundle");
        response.setHeader("x-trelio-accepted-head", secondExport.head);
        response.end(secondExport.bundle);
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
    const command = [
      bridgePath,
      "open",
      "--origin",
      origin,
      "--workspace",
      workspaceId,
    ];
    const executionOptions = {
      cwd: temporaryDirectory,
      encoding: "utf8",
      timeout: 10_000,
      env: { ...process.env, HOME: homeDirectory },
    };
    const expectedWorkspaceDirectory = path.join(
      homeDirectory,
      "Trelio Workspaces",
      workspaceId,
      "workspace",
    );

    const firstOpenPromise = execFileAsync(process.execPath, command, executionOptions);
    await firstStartSeen;
    try {
      await assert.rejects(
        execFileAsync(process.execPath, command, executionOptions),
        /уже открывается другим локальным процессом/u,
      );
      assert.equal(startCount, 1, "concurrent open must stop at the local lock");
    } finally {
      releaseFirstStart();
    }
    const firstOpen = await firstOpenPromise;
    assert.equal(firstOpen.stdout.trim(), expectedWorkspaceDirectory);
    assert.equal(
      await readFile(path.join(expectedWorkspaceDirectory, "shared.md"), "utf8"),
      "first accepted version\n",
    );
    assert.equal(
      await pathExists(path.join(homeDirectory, "Trelio Workspaces", workspaceId, runId)),
      false,
      "new layout must not create a per-Run directory",
    );
    await assert.rejects(
      execFileAsync(process.execPath, command, executionOptions),
      /незавершённый Agent Run/u,
    );
    assert.equal(startCount, 1, "one local Workspace root permits only one active Run");

    firstRunStatus = "accepted";
    acceptedHead = secondExport.head;
    secondRunStatus = "running";
    const eventOffset = events.length;
    const secondOpen = await execFileAsync(process.execPath, command, executionOptions);
    assert.equal(secondOpen.stdout.trim(), expectedWorkspaceDirectory);
    assert.equal(
      await readFile(path.join(expectedWorkspaceDirectory, "shared.md"), "utf8"),
      "second accepted version\n",
    );
    assert.equal(
      await readFile(path.join(expectedWorkspaceDirectory, "reused.md"), "utf8"),
      "same local folder\n",
    );
    const secondEvents = events.slice(eventOffset);
    assert.ok(
      secondEvents.indexOf("accepted-bundle") < secondEvents.indexOf("start-2"),
      "accepted head must be downloaded before the next server Run is created",
    );
    const metadata = JSON.parse(await readFile(
      path.join(homeDirectory, "Trelio Workspaces", workspaceId, ".trelio-run.json"),
      "utf8",
    ));
    assert.equal(metadata.runId, secondRunId);
    assert.equal(metadata.baseHead, secondExport.head);
    assert.ok(Number.isFinite(Date.parse(metadata.lastUsedAt)));

    secondRunStatus = "accepted";
    await writeFile(path.join(expectedWorkspaceDirectory, "local-only.md"), "do not overwrite\n");
    await assert.rejects(
      execFileAsync(process.execPath, command, executionOptions),
      /несохранённые изменения предыдущего Run/u,
    );
    assert.equal(startCount, 2, "dirty reuse must fail before creating another server Run");
    assert.equal(
      await readFile(path.join(expectedWorkspaceDirectory, "local-only.md"), "utf8"),
      "do not overwrite\n",
    );
    await rm(path.join(expectedWorkspaceDirectory, "local-only.md"));
    await writeFile(
      path.join(expectedWorkspaceDirectory, "committed-only.md"),
      "clean working tree but unpublished commit\n",
    );
    await runGit(expectedWorkspaceDirectory, ["add", "committed-only.md"]);
    await runGit(expectedWorkspaceDirectory, ["commit", "-m", "Local unpublished commit"]);
    await assert.rejects(
      execFileAsync(process.execPath, command, executionOptions),
      /clean committed changes/u,
    );
    assert.equal(startCount, 2, "diverged clean history must also fail before server start");
    assert.equal(
      await readFile(path.join(expectedWorkspaceDirectory, "committed-only.md"), "utf8"),
      "clean working tree but unpublished commit\n",
    );
    assert.ifError(serverError);
  } finally {
    await new Promise((resolve) => server.close(resolve));
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
  const draftCheckpointId = "88888888-8888-4888-8888-888888888888";
  const baseExport = await createExportBundle(path.join(temporaryDirectory, "base"), {
    "WORKSPACE_CONTEXT.md": "# Task context\n",
  });
  let draftHead = null;
  let firstDraftHead = null;
  let draftBundle = null;
  let draftCheckpointPayload = null;
  let blockerCheckpointPayload = null;
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


      if (request.url?.startsWith("/api/agent-workspaces/encryption/runtime?")) {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({
          suite: "trelio-e2ee-v1",
          state: "plain",
          company: testCompany,
        }));
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
          company: testCompany,
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
        firstDraftHead ||= draftHead;
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
        const checkpointPayload = JSON.parse(body.toString("utf8"));
        assert.equal(checkpointPayload.draftHead, draftHead);
        const isBlocker = checkpointPayload.checkpointType === "blocker";

        if (isBlocker) {
          blockerCheckpointPayload = checkpointPayload;
          assert.deepEqual(checkpointPayload.openQuestions, ["Какой вариант согласовать?"]);
          assert.equal(
            checkpointPayload.nextAction.instruction,
            "Выберите вариант, затем продолжите этот Run.",
          );
          currentStatus = "waiting_for_human";
        } else {
          assert.equal(checkpointPayload.checkpointType, "draft");
          assert.deepEqual(checkpointPayload.openQuestions, undefined);
          // Git reports an untracked directory as one changed path until the
          // draft snapshot commits it; the uploaded tree below proves the
          // exact file bytes are nevertheless preserved.
          assert.deepEqual(checkpointPayload.filesChanged, ["artifacts/"]);
          draftCheckpointPayload = checkpointPayload;
          assert.equal(currentStatus, "running");
        }
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({
          id: isBlocker ? checkpointId : draftCheckpointId,
          runId,
          checkpointType: checkpointPayload.checkpointType,
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
          company: testCompany,
          runs: [serializeRun()],
          checkpoints: blockerCheckpointPayload
            ? [{
                id: checkpointId,
                runId,
                checkpointType: "blocker",
                candidateHead: draftHead,
                summary: blockerCheckpointPayload.summary,
                evidenceJson: [],
                filesChangedJson: blockerCheckpointPayload.filesChanged || [],
                openQuestionsJson: blockerCheckpointPayload.openQuestions,
                nextActionJson: blockerCheckpointPayload.nextAction,
                createdAt: new Date().toISOString(),
              }, ...(draftCheckpointPayload ? [{
                id: draftCheckpointId,
                runId,
                checkpointType: "draft",
                candidateHead: firstDraftHead,
                summary: draftCheckpointPayload.summary,
                evidenceJson: [],
                filesChangedJson: draftCheckpointPayload.filesChanged || [],
                openQuestionsJson: [],
                nextActionJson: null,
                createdAt: new Date(Date.now() - 1_000).toISOString(),
              }] : [])]
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

    const portableCheckpoint = await execFileAsync(
      process.execPath,
      [
        bridgePath,
        "checkpoint",
        "--type",
        "draft",
        "--summary",
        "Подготовлен первый переносимый вариант для продолжения другим агентом.",
      ],
      {
        cwd: firstWorkspaceDirectory,
        encoding: "utf8",
        timeout: 10_000,
        env: { ...process.env, HOME: firstHomeDirectory },
      },
    );
    assert.match(portableCheckpoint.stdout, /Draft snapshot сохранён/u);
    assert.match(portableCheckpoint.stdout, /Checkpoint сохранён/u);
    assert.equal(currentStatus, "running");
    assert.ok(firstDraftHead);
    await assert.rejects(
      execFileAsync(
        process.execPath,
        [
          bridgePath,
          "checkpoint",
          "--type",
          "draft",
          "--summary",
          "Повторный checkpoint без новой дельты не должен создаваться.",
        ],
        {
          cwd: firstWorkspaceDirectory,
          encoding: "utf8",
          timeout: 10_000,
          env: { ...process.env, HOME: firstHomeDirectory },
        },
      ),
      /нет новых изменений/u,
    );
    await writeFile(
      path.join(firstWorkspaceDirectory, "artifacts", "decision.md"),
      "# Варианты решения\n\nDraft с первого компьютера.\n\nДобавлен вопрос для согласования.\n",
      "utf8",
    );

    const checkpointed = await execFileAsync(
      process.execPath,
      [
        bridgePath,
        "pause",
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
    assert.match(checkpointed.stdout, /Проверены изменённые пути/u);
    assert.equal(currentStatus, "waiting_for_human");
    assert.ok(draftHead);
    assert.notEqual(draftHead, firstDraftHead);

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
      "# Варианты решения\n\nDraft с первого компьютера.\n\nДобавлен вопрос для согласования.\n",
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

test("bridge finish accepts a clean non-empty candidate saved by draft checkpoint", {
  timeout: 15_000,
}, async () => {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "trelio-finish-saved-draft-"));
  const homeDirectory = path.join(temporaryDirectory, "home");
  const runDirectory = path.join(temporaryDirectory, "run");
  const workspaceDirectory = path.join(runDirectory, "workspace");
  let handoffPayload = null;
  let candidateAttempts = 0;
  let heartbeatAttempts = 0;
  let serverError = null;

  const server = createServer(async (request, response) => {
    try {
      const body = await readRequestBody(request);
      assert.equal(request.headers["x-trelio-agent-workspaces-version"], BRIDGE_VERSION);
      assert.equal(request.headers.authorization, "Bearer integration-token");

      if (request.url?.endsWith("/heartbeat")) {
        heartbeatAttempts += 1;
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ leaseExpiresAt: new Date(Date.now() + 60_000).toISOString() }));
        return;
      }

      if (request.url?.endsWith("/checkpoints")) {
        handoffPayload = JSON.parse(body.toString("utf8"));
        assert.equal(handoffPayload.checkpointType, "handoff");
        assert.deepEqual(handoffPayload.filesChanged, ["artifacts/result.md"]);
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({
          id: "99999999-9999-4999-8999-999999999999",
          checkpointType: "handoff",
          createdAt: new Date().toISOString(),
        }));
        return;
      }

      if (request.url?.endsWith("/candidate")) {
        candidateAttempts += 1;
        assert.ok(body.byteLength > 0, "saved draft candidate bundle must reach the server");
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
    await Promise.all([
      mkdir(homeDirectory, { recursive: true }),
      mkdir(workspaceDirectory, { recursive: true }),
    ]);
    await runGit(workspaceDirectory, ["init", "--initial-branch=trelio-candidate"]);
    await runGit(workspaceDirectory, ["config", "user.name", "Trelio Bridge Test"]);
    await runGit(workspaceDirectory, ["config", "user.email", "bridge-test@trelio.local"]);
    await writeFile(path.join(workspaceDirectory, "README.md"), "# Base\n", "utf8");
    await runGit(workspaceDirectory, ["add", "README.md"]);
    await runGit(workspaceDirectory, ["commit", "-m", "Base"]);
    const baseHead = (await runGit(workspaceDirectory, ["rev-parse", "HEAD"])).stdout.trim();

    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const serverAddress = server.address();
    assert.ok(serverAddress && typeof serverAddress === "object");
    const origin = `http://127.0.0.1:${serverAddress.port}`;
    await writeTestCredential(homeDirectory, origin);
    const metadataPath = path.join(runDirectory, ".trelio-run.json");
    const baseMetadata = {
      schemaVersion: 3,
      origin,
      pluginVersion: BRIDGE_VERSION,
      scopeType: "project",
      workspaceId: "44444444-4444-4444-8444-444444444444",
      runId,
      leaseId: "55555555-5555-4555-8555-555555555555",
      fencingToken: 7,
      baseHead,
      workspaceDirectory,
      contextHeads: {},
      contexts: [],
      objects: [],
    };
    await writeFile(metadataPath, `${JSON.stringify(baseMetadata, null, 2)}\n`, "utf8");

    // Пустой Run остаётся запрещён: сохранённый draft является допустимым
    // основанием для finish только когда candidate head отличается от pinned
    // base, а не просто из-за наличия metadata/checkpoint.
    await assert.rejects(
      execFileAsync(
        process.execPath,
        [
          bridgePath,
          "finish",
          "--summary",
          "Пустой Run не должен быть принят как результат.",
          "--evidence",
          "Проверено отсутствие изменений.",
          "--next-action",
          "Продолжите работу до появления результата.",
        ],
        {
          cwd: workspaceDirectory,
          encoding: "utf8",
          timeout: 8_000,
          env: { ...process.env, HOME: homeDirectory },
        },
      ),
      /В workspace нет изменений для finish/u,
    );
    assert.equal(heartbeatAttempts, 0);

    await mkdir(path.join(workspaceDirectory, "artifacts"), { recursive: true });
    await writeFile(
      path.join(workspaceDirectory, "artifacts", "result.md"),
      "# Итог\n\nМатериал сохранён переносимым draft checkpoint.\n",
      "utf8",
    );
    await runGit(workspaceDirectory, ["add", "artifacts/result.md"]);
    await runGit(workspaceDirectory, ["commit", "-m", "Сохранить draft checkpoint"]);
    const draftHead = (await runGit(workspaceDirectory, ["rev-parse", "HEAD"])).stdout.trim();
    assert.notEqual(draftHead, baseHead);
    assert.equal(
      (await runGit(workspaceDirectory, ["status", "--short"])).stdout,
      "",
      "regression requires the clean tree produced by draft checkpoint",
    );
    await writeFile(
      metadataPath,
      `${JSON.stringify({
        ...baseMetadata,
        draftHead,
        candidateHead: draftHead,
        materializedHead: draftHead,
      }, null, 2)}\n`,
      "utf8",
    );

    const finished = await execFileAsync(
      process.execPath,
      [
        bridgePath,
        "finish",
        "--summary",
        "Завершён уже сохранённый переносимый draft без искусственной правки.",
        "--evidence",
        "Проверен полный candidate delta относительно pinned base.",
        "--next-action",
        "Используйте принятый итоговый материал.",
      ],
      {
        cwd: workspaceDirectory,
        encoding: "utf8",
        timeout: 8_000,
        env: { ...process.env, HOME: homeDirectory },
      },
    );

    assert.match(finished.stdout, /Проверены изменённые пути \(1\):/u);
    assert.match(finished.stdout, /- artifacts\/result\.md/u);
    assert.match(finished.stdout, /Статус: принят автоматически/u);
    assert.deepEqual(handoffPayload?.filesChanged, ["artifacts/result.md"]);
    assert.equal(candidateAttempts, 1);
    assert.equal(heartbeatAttempts, 2);
    assert.ifError(serverError);
  } finally {
    await new Promise((resolve) => server.close(resolve));
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
  const acceptedRunId = runId;
  const dirtyRunId = "66666666-6666-4666-8666-666666666666";
  const activeRunId = "77777777-7777-4777-8777-777777777777";
  const unknownRunId = "88888888-8888-4888-8888-888888888888";
  const recentRunId = "99999999-9999-4999-8999-999999999999";
  const unmanagedRunId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const committedRunId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const ignoredRunId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  const busyTerminalRunId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
  const busyActiveRunId = "ffffffff-ffff-4fff-8fff-ffffffffffff";
  const runStates = new Map([
    [acceptedRunId, "accepted"],
    [dirtyRunId, "accepted"],
    [activeRunId, "active"],
    [recentRunId, "accepted"],
    [unmanagedRunId, "accepted"],
    [committedRunId, "accepted"],
    [ignoredRunId, "accepted"],
    [busyTerminalRunId, "accepted"],
  ]);
  const workspaceIdByRunId = new Map(
    [...runStates.keys(), unknownRunId].map((currentRunId, index) => [
      currentRunId,
      `dddddddd-dddd-4ddd-8ddd-${String(index + 1).padStart(12, "0")}`,
    ]),
  );
  const roots = new Map();
  let serverError = null;

  const createLocalRunRoot = async (
    origin,
    name,
    currentRunId,
    {
      dirty = false,
      committed = false,
      ignored = false,
      lastUsedAt = null,
      unmanaged = false,
    } = {},
  ) => {
    const rootDirectory = path.join(temporaryDirectory, name);
    const workspaceDirectory = path.join(rootDirectory, "workspace");
    await mkdir(workspaceDirectory, { recursive: true });
    await runGit(workspaceDirectory, ["init", "--initial-branch=trelio-candidate"]);
    await runGit(workspaceDirectory, ["config", "user.name", "Trelio Bridge Test"]);
    await runGit(workspaceDirectory, ["config", "user.email", "bridge-test@trelio.local"]);
    await writeFile(path.join(workspaceDirectory, "README.md"), "# Clean test\n", "utf8");
    if (ignored) {
      await writeFile(path.join(workspaceDirectory, ".gitignore"), "*.private\n", "utf8");
    }
    await runGit(workspaceDirectory, ["add", "README.md", ...(ignored ? [".gitignore"] : [])]);
    await runGit(workspaceDirectory, ["commit", "-m", "Clean base"]);
    const materializedHead = (await runGit(workspaceDirectory, ["rev-parse", "HEAD"]))
      .stdout.trim();

    if (dirty) {
      await writeFile(path.join(workspaceDirectory, "local-draft.md"), "Do not delete\n", "utf8");
    }
    if (committed) {
      await writeFile(path.join(workspaceDirectory, "local-commit.md"), "Do not delete\n", "utf8");
      await runGit(workspaceDirectory, ["add", "local-commit.md"]);
      await runGit(workspaceDirectory, ["commit", "-m", "Unpublished local commit"]);
    }
    if (ignored) {
      await writeFile(path.join(workspaceDirectory, "local.private"), "Ignored user data\n", "utf8");
    }
    if (unmanaged) {
      await writeFile(path.join(rootDirectory, "keep-me.txt"), "Unknown user data\n", "utf8");
    }

    await writeFile(
      path.join(rootDirectory, ".trelio-run.json"),
      `${JSON.stringify({
        schemaVersion: 3,
        origin,
        pluginVersion: BRIDGE_VERSION,
        workspaceId: workspaceIdByRunId.get(currentRunId),
        runId: currentRunId,
        workspaceDirectory,
        materializedHead,
        objects: [],
        contextObjects: [],
        lastUsedAt: lastUsedAt
          || new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString(),
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

      const workspaceMatch = request.url?.match(
        /^\/api\/agent-workspaces\/workspaces\/([0-9a-f-]+)$/iu,
      );
      if (workspaceMatch) {
        const oldTimestamp = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
        const currentRunEntry = [...workspaceIdByRunId.entries()]
          .find(([, currentWorkspaceId]) => currentWorkspaceId === workspaceMatch[1]);
        const currentRunId = currentRunEntry?.[0] || null;
        const currentStatus = currentRunId ? runStates.get(currentRunId) : null;
        response.setHeader("content-type", "application/json");
        const currentRuns = currentStatus
          ? [{
                id: currentRunId,
                status: currentStatus,
                ...(currentStatus === "accepted"
                  ? { acceptedAt: oldTimestamp }
                  : { updatedAt: oldTimestamp }),
              }]
          : [];
        if (currentRunId === busyTerminalRunId) {
          currentRuns.push({ id: busyActiveRunId, status: "running", updatedAt: oldTimestamp });
        }
        response.end(JSON.stringify({ runs: currentRuns }));
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
    const dirtyRoot = await createLocalRunRoot(origin, "accepted-dirty", dirtyRunId, { dirty: true });
    const activeRoot = await createLocalRunRoot(origin, "active", activeRunId);
    const unknownRoot = await createLocalRunRoot(origin, "unknown", unknownRunId);
    const recentRoot = await createLocalRunRoot(origin, "recent", recentRunId, {
      lastUsedAt: new Date().toISOString(),
    });
    const unmanagedRoot = await createLocalRunRoot(origin, "unmanaged", unmanagedRunId, {
      unmanaged: true,
    });
    const committedRoot = await createLocalRunRoot(origin, "committed", committedRunId, {
      committed: true,
    });
    const ignoredRoot = await createLocalRunRoot(origin, "ignored", ignoredRunId, {
      ignored: true,
    });
    const busyRoot = await createLocalRunRoot(origin, "workspace-with-active-run", busyTerminalRunId);
    await mkdir(configDirectory, { recursive: true });
    await writeFile(
      path.join(configDirectory, "settings.json"),
      `${JSON.stringify({
        workspaceRetentionDays: 1,
        objectCacheMaxAgeDays: 30,
        objectCacheMaxBytes: 10 * 1024 * 1024 * 1024,
      }, null, 2)}\n`,
      { mode: 0o600 },
    );
    await writeFile(
      path.join(configDirectory, "runs.json"),
      `${JSON.stringify({
        schemaVersion: 1,
        roots: [
          acceptedRoot,
          dirtyRoot,
          activeRoot,
          unknownRoot,
          recentRoot,
          unmanagedRoot,
          committedRoot,
          ignoredRoot,
          busyRoot,
        ],
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
    assert.match(preview.stdout, /Inactive Workspace roots: 1/);
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
    assert.equal(await pathExists(recentRoot), true, "recent local use restarts retention");
    assert.equal(await pathExists(unmanagedRoot), true, "unknown root data is never deleted");
    assert.equal(await pathExists(committedRoot), true, "unpublished clean commits are never deleted");
    assert.equal(await pathExists(ignoredRoot), true, "ignored user files are never deleted");
    assert.equal(await pathExists(busyRoot), true, "any open Run keeps the Workspace root active");
    assert.ifError(serverError);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test("encrypted browser projection exposes only opaque ranges before local decryption", async () => {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "trelio-browser-projection-test-"));
  const workspaceDirectory = path.join(temporaryDirectory, "workspace");
  const decryptedManifestPath = path.join(temporaryDirectory, "manifest.json");
  const decryptedFilePath = path.join(temporaryDirectory, "result.md");
  const companyId = "11111111-1111-4111-8111-111111111111";
  const workspaceId = "22222222-2222-4222-8222-222222222222";
  const scopeId = "33333333-3333-4333-8333-333333333333";
  const deviceId = "44444444-4444-4444-8444-444444444444";
  const scope = await webcrypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits"],
  );
  const scopePublicEncryptionJwk = await webcrypto.subtle.exportKey("jwk", scope.publicKey);
  const scopePrivateJwk = await webcrypto.subtle.exportKey("jwk", scope.privateKey);
  const device = await createAgentEncryptionDevice();

  try {
    await mkdir(path.join(workspaceDirectory, "artifacts"), { recursive: true });
    await writeFile(path.join(workspaceDirectory, "AGENTS.md"), "protected\n");
    await writeFile(path.join(workspaceDirectory, "README.md"), "control\n");
    await writeFile(path.join(workspaceDirectory, "artifacts", "result.md"), "# Готово\n");
    await execFileAsync("git", ["init", "-b", "main"], { cwd: workspaceDirectory });
    await execFileAsync("git", ["config", "user.name", "Trelio Test"], { cwd: workspaceDirectory });
    await execFileAsync("git", ["config", "user.email", "test@trelio.local"], { cwd: workspaceDirectory });
    await execFileAsync("git", ["add", "--all"], { cwd: workspaceDirectory });
    await execFileAsync("git", ["commit", "-m", "Тест"], { cwd: workspaceDirectory });
    const { stdout: workspaceHeadOutput } = await execFileAsync(
      "git",
      ["rev-parse", "HEAD"],
      { cwd: workspaceDirectory, encoding: "utf8" },
    );
    const workspaceHead = workspaceHeadOutput.trim();

    await withEncryptedWorkspaceBrowserProjection({
      metadata: { workspaceId, workspaceDirectory, objects: [] },
      workspaceHead,
      companyEncryption: {
        runtime: {
          company: { id: companyId },
          scope: { id: scopeId, epoch: 1, publicEncryptionJwk: scopePublicEncryptionJwk },
          device: { id: deviceId },
        },
        device,
      },
      temporaryPrefix: "trelio-browser-projection-test",
    }, async (projection) => {
      const bytes = await readFile(projection.projectionPath);
      assert.equal(bytes.subarray(0, 8).toString("ascii"), "TRELIOP1");
      const indexLength = bytes.readUInt32BE(8);
      const index = JSON.parse(bytes.subarray(12, 12 + indexLength).toString("utf8"));
      const clearIndex = JSON.stringify(index);
      const payloadOffset = 12 + indexLength;

      assert.equal(clearIndex.includes("artifacts"), false);
      assert.equal(clearIndex.includes("result.md"), false);
      assert.equal(index.files.length, 2);
      const manifestRange = index.files.find((file) => file.kind === "manifest");
      await writeFile(
        path.join(temporaryDirectory, "manifest.trelioe1"),
        bytes.subarray(
          payloadOffset + manifestRange.offset,
          payloadOffset + manifestRange.offset + manifestRange.sizeBytes,
        ),
      );
      await decryptFileFromCompanyContainer({
        sourcePath: path.join(temporaryDirectory, "manifest.trelioe1"),
        destinationPath: decryptedManifestPath,
        scopePrivateKey: scope.privateKey,
        scopePrivateJwk,
      });
      const manifest = JSON.parse(await readFile(decryptedManifestPath, "utf8"));
      assert.deepEqual(manifest.files.map((file) => file.path), ["artifacts/result.md"]);
      const contentRange = index.files.find((file) => file.kind === "content");
      await writeFile(
        path.join(temporaryDirectory, "result.trelioe1"),
        bytes.subarray(
          payloadOffset + contentRange.offset,
          payloadOffset + contentRange.offset + contentRange.sizeBytes,
        ),
      );
      await decryptFileFromCompanyContainer({
        sourcePath: path.join(temporaryDirectory, "result.trelioe1"),
        destinationPath: decryptedFilePath,
        scopePrivateKey: scope.privateKey,
        scopePrivateJwk,
      });
      assert.equal(await readFile(decryptedFilePath, "utf8"), "# Готово\n");
    });
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test("encrypted projection upload uses the backend's canonical id header", async () => {
  const bridgeSource = await readFile(bridgePath, "utf8");

  assert.match(
    bridgeSource,
    /\/encrypted-browser-projection`[\s\S]{0,1800}"x-trelio-browser-projection-id": projection\.projectionId/u,
  );
  assert.doesNotMatch(bridgeSource, /"x-trelio-projection-id"/u);
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

  assert.equal(BRIDGE_VERSION, "1.17.0");
  assert.equal(codexManifest.version, BRIDGE_VERSION);
  assert.equal(claudeManifest.version, BRIDGE_VERSION);
  assert.equal(claudeMarketplaceEntry?.version, BRIDGE_VERSION);
  // Marketplace copy must describe only the stable host contract. Provider
  // capability lists and delivery details come from the live catalog instead.
  for (const description of [
    codexManifest.description,
    claudeManifest.description,
    claudeMarketplaceEntry?.description,
  ]) {
    assert.match(description, /live skill catalogs/u);
    assert.match(description, /backend-managed signed runtimes/u);
    assert.doesNotMatch(description, /local communication runtimes/u);
  }
  assert.match(
    codexManifest.interface.longDescription,
    /backend-managed навыками.*декларативный Remote MCP.*signed runtimes/u,
  );
  assert.equal(codexManifest.mcpServers, "./.mcp.json");
  assert.deepEqual(
    {
      brandColor: codexManifest.interface.brandColor,
      composerIcon: codexManifest.interface.composerIcon,
      logo: codexManifest.interface.logo,
      logoDark: codexManifest.interface.logoDark,
    },
    {
      brandColor: "#1F8FFF",
      composerIcon: "./assets/trelio-composer-icon.svg",
      logo: "./assets/trelio-logo.svg",
      logoDark: "./assets/trelio-logo-dark.svg",
    },
  );
  for (const assetPath of [
    codexManifest.interface.composerIcon,
    codexManifest.interface.logo,
    codexManifest.interface.logoDark,
  ]) {
    assert.equal((await stat(path.join(pluginDirectory, assetPath))).isFile(), true);
  }
  assert.deepEqual(mcpManifest.mcpServers.trelio, {
    url: "https://trelio.ru/mcp",
    oauth: {
      clientId: "trelio_agent_workspaces_v1",
    },
  });
  assert.deepEqual(mcpManifest.mcpServers["trelio-remote-skills"], {
    command: "./scripts/launch-trelio-node",
    args: ["./scripts/trelio-remote-mcp.mjs"],
    cwd: ".",
    env_vars: [
      "CODEX_MCP_NODE_PATH",
      "CODEX_BROWSER_USE_NODE_PATH",
      "CODEX_ELECTRON_RESOURCES_PATH",
      "CODEX_CLI_PATH",
      "XDG_CACHE_HOME",
      "HOME",
      "USERPROFILE",
      "LOCALAPPDATA",
      "PATH",
    ],
    tool_timeout_sec: 660,
  });

  const posixLauncher = await stat(path.join(
    pluginDirectory,
    "scripts",
    "launch-trelio-node",
  ));
  const windowsLauncher = await stat(path.join(
    pluginDirectory,
    "scripts",
    "launch-trelio-node.cmd",
  ));
  assert.equal(posixLauncher.isFile(), true);
  assert.notEqual(posixLauncher.mode & 0o111, 0, "POSIX launcher must remain executable");
  assert.equal(windowsLauncher.isFile(), true);
});

test("release CI pins Node 22 and avoids the parent test-runner IPC", async () => {
  const workflowSource = await readFile(
    path.resolve(pluginDirectory, "..", "..", ".github", "workflows", "plugin-tests.yml"),
    "utf8",
  );

  // A floating `22` selected 22.23.1 from the macOS runner cache while the
  // other platforms used 22.23.2. Exact patch parity removes that mismatch.
  // Direct execution keeps each file's node:test harness in its own process
  // and avoids the parent runner's intermittent serialized IPC corruption.
  assert.equal([...workflowSource.matchAll(/node-version: 22\.23\.2/gu)].length, 2);
  assert.doesNotMatch(workflowSource, /node-version: 22(?:\s|$)/u);
  const genericJobSource = workflowSource.slice(
    workflowSource.indexOf("node-tests:"),
    workflowSource.indexOf("windows-acl:"),
  );
  assert.equal([
    ...genericJobSource.matchAll(/node plugins\/trelio-agent-workspaces\/tests\/[^\s]+\.test\.mjs/gu),
  ].length, 8);
  assert.doesNotMatch(genericJobSource, /node --test/u);
});

test("POSIX Node launcher uses the bundled Codex runtime without a PATH alias", {
  skip: process.platform === "win32",
}, async () => {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "trelio-node-launcher-"));
  const cacheDirectory = path.join(temporaryDirectory, "cache");
  const emptyBinDirectory = path.join(temporaryDirectory, "empty-bin");
  const oldNodePath = path.join(temporaryDirectory, "old-node");
  const bundledNodePath = path.join(
    cacheDirectory,
    "codex-runtimes",
    "codex-primary-runtime",
    "dependencies",
    "node",
    "bin",
    "node",
  );
  const invocationPath = path.join(temporaryDirectory, "invocation.txt");
  const launcherPath = path.join(pluginDirectory, "scripts", "launch-trelio-node");

  try {
    await mkdir(path.dirname(bundledNodePath), { recursive: true });
    await mkdir(emptyBinDirectory, { recursive: true });
    await writeFile(oldNodePath, [
      "#!/bin/sh",
      "if [ \"${1:-}\" = \"--version\" ]; then printf '%s\\n' 'v20.19.0'; exit 0; fi",
      `printf '%s\\n' 'old runtime must not launch' > ${JSON.stringify(invocationPath)}`,
      "exit 97",
      "",
    ].join("\n"), { mode: 0o755 });
    await writeFile(bundledNodePath, [
      "#!/bin/sh",
      "if [ \"${1:-}\" = \"--version\" ]; then printf '%s\\n' 'v24.19.0'; exit 0; fi",
      `printf '%s\\n' \"$@\" > ${JSON.stringify(invocationPath)}`,
      "",
    ].join("\n"), { mode: 0o755 });

    await execFileAsync(
      launcherPath,
      ["./scripts/trelio-remote-mcp.mjs", "--launcher-probe"],
      {
        cwd: pluginDirectory,
        encoding: "utf8",
        env: {
          CODEX_MCP_NODE_PATH: oldNodePath,
          XDG_CACHE_HOME: cacheDirectory,
          HOME: temporaryDirectory,
          PATH: emptyBinDirectory,
        },
      },
    );

    assert.equal(
      await readFile(invocationPath, "utf8"),
      "./scripts/trelio-remote-mcp.mjs\n--launcher-probe\n",
    );
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test("compact protected runtime keeps the immutable Run safety kernel", () => {
  // Runtime AGENTS.md is always loaded. Pin only immutable safety and lifecycle
  // boundaries here; scenario procedures are validated in their references.
  for (const identifier of [
    "plan_my_agent_profile_update",
    "plan_agent_instructions_update",
    "runtimeSessionProof",
    "TRELIO_RUNTIME_HOOK_REQUIRED",
    "WORKSPACE_CONTEXT.md",
    "WORKLOG.md",
    "trelio-workspace checkpoint",
    "trelio-workspace pause",
    "trelio-workspace finish",
  ]) {
    assert.match(AGENT_WORKSPACE_RUNTIME_AGENTS_MARKDOWN, new RegExp(identifier, "u"));
  }

  for (const invariant of [
    /Не записывай в Git секреты, cookies, токены, локальные сессии, зависимости или кэши/u,
    /Не изменяй `AGENTS\.md`, `CLAUDE\.md`, `\.trelio\/\*\*` и read-only `\.\.\/context\/\*\*`/u,
    /Новый Run может записывать только в task или dossier Workspace/u,
    /legacy company\/project Run.*только этот exact pinned Run/u,
    /exact diff.*только после явного подтверждения/u,
    /Approved hook сам подставляет одноразовый runtimeSessionProof/u,
    /TRELIO_RUNTIME_HOOK_REQUIRED.*настройки плагина Trelio Agent Workspaces.*включите Hooks.*повторите запрос/u,
    /активного PreToolUse hook означает, что Hooks уже работают/u,
    /Не обходи gate другим MCP, HTTP, browser или shell/iu,
    /Native Trelio MCP и bundled bridge являются единственным штатным control\/data plane/u,
    /загружай только соответствующий reference.*не читай все references заранее/u,
    /`\.\.\/context\/agent-instructions\.md`.*`\.\.\/context\/user-profile\.md`.*`\.\.\/context\/run-checkpoint\.json`.*`WORKSPACE_CONTEXT\.md`/u,
    /pinned authority snapshot.*не заменяй его более новой live revision/u,
    /короткое активное резюме.*до 15 000 символов/u,
    /`WORKLOG\.md` открывай перед первой записью, а не автоматически в начале Run/u,
    /Agent Secret: <текущее safe название> \(secretId: <UUID>\)/u,
    /Секретные значения никогда не передавай модели, MCP, prompt, env, argv/u,
    /`trelio-workspace` — логический launcher текущего плагина/u,
    /`sources\/`.*`work\/`.*`artifacts\/`/u,
    /checkpoint --type draft.*границы реплики\/сессии, compaction или передачи работы/u,
    /Перед блокирующим вопросом.*`trelio-workspace pause`/u,
    /отдельными user-decision flows.*без действия пользователя/u,
    /Accepted Run, вывод агента и inferred progress сами не разрешают immediate mutation/u,
    /Заверши Run одной командой `trelio-workspace finish`/u,
    /`--task-outcome`.*не меняет задачу/u,
    /устаревший base head.*начни новый Run/u,
  ]) {
    assert.match(AGENT_WORKSPACE_RUNTIME_AGENTS_MARKDOWN, invariant);
  }

  for (const conditionalProcedure of [
    "search_agent_skills",
    "integrationRouting",
    "MCP_SEARCH_TIMEOUT",
    "prepare_agent_secret_browser_fill",
    "propose_task_comment",
    "workStartProposal",
  ]) {
    assert.doesNotMatch(
      AGENT_WORKSPACE_RUNTIME_AGENTS_MARKDOWN,
      new RegExp(conditionalProcedure, "u"),
    );
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
    "accepted-workspace-read.md",
    "dossier-transfer.md",
    "task-controls.md",
    "task-comment-proposals.md",
    "task-status-proposals.md",
    "task-checklist-proposals.md",
    "task-proposal-bundles.md",
    "agent-run.md",
    "task-run.md",
    "ocr-and-vision.md",
    "external-services.md",
    "agent-secrets.md",
  ];

  assert.match(mainSkill, /Read every matching\s+reference below completely before its first related tool call/u);
  assert.match(mainSkill, /If the scenario\s+changes during the task, pause and read the newly relevant reference/u);
  assert.match(mainSkill, /Classify every user addition independently/u);
  assert.match(mainSkill, /active\s+maintainer, external-service, or Run route does not absorb a later request/u);
  const agentRunReference = await readFile(
    path.join(workerDirectory, "references", "agent-run.md"),
    "utf8",
  );
  assert.match(agentRunReference, /latest portable draft on\s+the current accepted head/u);
  assert.match(agentRunReference, /checkpoint --type draft/u);
  assert.match(agentRunReference, /startNewRun=true/u);
  assert.match(agentRunReference, /rejects company\/project\s+Workspace scope/u);
  assert.match(agentRunReference, /inherit\s+company\/project Workspace context/u);
  assert.match(agentRunReference, /Complete `scope-and-context\.md` first/u);
  assert.match(agentRunReference, /Do not guess IDs, repeat its discovery sequence/u);
  const scopeReference = await readFile(
    path.join(workerDirectory, "references", "scope-and-context.md"),
    "utf8",
  );
  assert.match(scopeReference, /Do not call `list_dossiers` merely to\s+discover context/u);
  assert.match(scopeReference, /Call the canonical unified `search` once/u);
  assert.match(scopeReference, /same call searches\s+projects, active and archived tasks/u);
  assert.match(scopeReference, /not consecutive mandatory procedures/u);
  assert.match(scopeReference, /without a\s+project filter/u);
  assert.match(scopeReference, /Company\/project rules are not\s+search documents/u);
  assert.match(scopeReference, /call `get_tasks` once.*do not make repeated `get_task` calls/su);
  assert.match(scopeReference, /Current `get_task` and `get_tasks` return `schemaVersion: 3`/u);
  assert.match(scopeReference, /Text `content` is only a summary/u);
  assert.match(scopeReference, /one structured `task`, never a derived `document\.text` copy/u);
  assert.match(scopeReference, /Resolve every key in\s+the item's `instructionScope\.orderedLayerKeys`/u);
  assert.match(scopeReference, /Never concatenate the whole catalog for every task/u);
  assert.match(scopeReference, /inspect `task\.deferredSections`/u);
  assert.match(scopeReference, /Call `get_task_sections`\s+once/u);
  assert.match(scopeReference, /do not repeat `get_task` or\s+request all sections as a default/u);
  assert.match(scopeReference, /`itemCount: 0` means known-empty; `null`\s+means not counted/u);
  assert.match(scopeReference, /comments with bounded `commentsPage`/u);
  assert.match(scopeReference, /without repeating effective instructions,\s+core fields, connections, or linked dossiers/u);
  assert.match(scopeReference, /Schema v1\/v2 are not supported/u);
  assert.match(scopeReference, /plugin\/backend version mismatch/u);
  assert.match(scopeReference, /Inside a prepared Run, its pinned\s+`agent-instructions\.md` and `user-profile\.md` remain authoritative/u);
  assert.match(scopeReference, /Do not call\s+`get_agent_instructions` again after loaded instructions/u);
  assert.match(scopeReference, /The link is durable, not a one-Run dependency/u);
  assert.match(scopeReference, /at least two stable independent identifiers/u);
  assert.match(scopeReference, /call `link_task_dossier` without confirmation/u);
  assert.match(scopeReference, /`task_full` readers cross-project read-only access to the whole accepted dossier/u);
  assert.match(scopeReference, /Add no task\s+comment or notification unless separately asked/u);
  assert.match(scopeReference, /unclear whole-\s+dossier disclosure require a question/u);
  assert.match(scopeReference, /A weak hit does not/u);
  assert.match(scopeReference, /exact-read the relation before retry/u);
  const acceptedReadReference = await readFile(
    path.join(workerDirectory, "references", "accepted-workspace-read.md"),
    "utf8",
  );
  assert.match(mainSkill, /references\/accepted-workspace-read\.md/u);
  assert.match(acceptedReadReference, /Call `prepare_agent_workspace_read` once/u);
  assert.match(acceptedReadReference, /exact\s+`trelio-workspace inspect --workspace \.\.\.`/u);
  assert.match(acceptedReadReference, /creates no Run, lease, checkpoint, task-status proposal/u);
  assert.match(acceptedReadReference, /read `\.\.\/context\/agent-instructions\.md`, then/u);
  assert.match(acceptedReadReference, /Never reinterpret read intent\s+as permission to create a Run/u);
  const taskControlsReference = await readFile(
    path.join(workerDirectory, "references", "task-controls.md"),
    "utf8",
  );
  assert.match(taskControlsReference, /`get_task_sections\.sections\.controls`/u);
  assert.match(taskControlsReference, /authenticated user's personal\s+controls/u);
  for (const referenceName of references) {
    assert.match(mainSkill, new RegExp(`references/${referenceName.replaceAll(".", "\\.")}`, "u"));
    const reference = await readFile(path.join(workerDirectory, "references", referenceName), "utf8");
    assert.match(reference, /Read this file completely/u);
  }
});

test("bundled instructions narrow structured MCP search timeouts without a blind retry", async () => {
  const scopeReference = await readFile(
    path.join(
      pluginDirectory,
      "skills",
      "trelio-workspace-worker",
      "references",
      "scope-and-context.md",
    ),
    "utf8",
  );
  const diagnosticsSkill = await readFile(
    path.join(pluginDirectory, "skills", "trelio-diagnostics", "SKILL.md"),
    "utf8",
  );

  for (const instructions of [scopeReference, diagnosticsSkill]) {
    assert.match(instructions, /`MCP_SEARCH_TIMEOUT`/u);
    assert.match(instructions, /not a transport|not a 504/iu);
    assert.match(instructions, /exact\s+`companySlugs`/u);
    assert.match(instructions, /at most once|Retry at most once/iu);
    assert.match(instructions, /no more than two|at most the two/iu);
    assert.match(instructions, /`projectSlugs`/u);
  }

  assert.match(scopeReference, /Do not concatenate/u);
  assert.match(scopeReference, /HTTP 504 without structured `MCP_SEARCH_TIMEOUT`/u);
  assert.match(diagnosticsSkill, /Do not run login, reinstall the plugin/u);
  assert.match(diagnosticsSkill, /A bare HTTP 504 remains in this transport/u);
});

test("plugin exposes folder-first onboarding before ordinary task work", async () => {
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
  const onboardingAgentMetadata = await readFile(
    path.join(
      pluginDirectory,
      "skills",
      "trelio-project-onboarding",
      "agents",
      "openai.yaml",
    ),
    "utf8",
  );
  const onboardingSkillNormalized = onboardingSkill.replace(/\s+/gu, " ");

  assert.deepEqual(codexManifest.interface.defaultPrompt, [
    "Настрой Trelio Agent Workspaces для текущей рабочей папки.",
    "Проверь установку Trelio Agent Workspaces и объясни, что мешает работе.",
    "Возьми доступную задачу Trelio, выполни её, содержательно сообщи результат и сохрани материалы в рабочем пространстве.",
  ]);
  const folderGateIndex = onboardingSkill.indexOf("## Confirm the working folder first");
  const prerequisiteIndex = onboardingSkill.indexOf("## Check prerequisites");

  assert.ok(folderGateIndex >= 0);
  assert.ok(prerequisiteIndex > folderGateIndex);
  assert.match(onboardingSkill, /local project with an accessible primary folder/u);
  assert.match(onboardingSkill, /projectless\s+task is not evidence of a selected folder/u);
  assert.match(onboardingSkill, /intentionally an ordinary non-Git context\s+folder/u);
  assert.match(
    onboardingSkill,
    /not inside\s+a Git worktree and is not itself a bare repository or Git directory/u,
  );
  assert.match(onboardingSkill, /selected folder is the exact repository top level/u);
  assert.match(onboardingSkill, /no ancestor owns another Git worktree/u);
  assert.match(onboardingSkill, /`HEAD` is unborn/u);
  assert.match(
    onboardingSkill,
    /no commits, remotes, local or\s+packed refs, tracked or staged paths/u,
  );
  assert.match(
    onboardingSkill,
    /contains only regular root\s+`AGENTS\.md` and\/or `AGENTS\.override\.md`/u,
  );
  assert.match(onboardingSkill, /atomically rename the exact `\.git` directory/u);
  assert.match(onboardingSkill, /`\.git\.trelio-detached-<UTC-timestamp>`/u);
  assert.match(onboardingSkill, /Never use `rm` or discard the\s+metadata/u);
  assert.match(onboardingSkill, /does not need a separate confirmation/u);
  assert.match(
    onboardingSkill,
    /do not alter Git and stop before Trelio calls or an\s+`AGENTS\.md` write/u,
  );
  assert.match(onboardingSkill, /отдельную обычную папку проекта без Git/u);
  assert.match(
    onboardingSkill,
    /company\/project rules, an exact task or\s+dossier, or their Agent Workspace/u,
  );
  assert.match(onboardingSkill, /stop before every setup side\s+effect/u);
  assert.match(onboardingSkill, /Рабочая папка не найдена\. Настройка не начата\./u);
  assert.match(onboardingSkill, /`CLAUDE_PROJECT_DIR`/u);
  assert.match(onboardingSkill, /`claude mcp list`/u);
  assert.match(onboardingSkill, /`claude mcp login trelio`/u);
  assert.match(onboardingSkill, /`\/reload-plugins`/u);
  assert.match(onboardingAgentMetadata, /Настройка Trelio в папке/u);
  assert.match(onboardingAgentMetadata, /\$trelio-project-onboarding/u);
  assert.match(onboardingSkill, /<!-- trelio-agent-workspaces:start -->/u);
  assert.match(
    onboardingSkillNormalized,
    /Перед первым содержательным ответом по работе в этой папке/u,
  );
  assert.match(onboardingSkillNormalized, /получи из Trelio актуальные правила/u);
  assert.match(
    onboardingSkillNormalized,
    /правила компании и, если определён конкретный проект, правила этого проекта/u,
  );
  assert.match(
    onboardingSkillNormalized,
    /контекст в доступных задачах, досье и их Agent Workspace/u,
  );
  assert.match(
    onboardingSkillNormalized,
    /По умолчанию считай любой содержательный запрос в этой папке связанным/u,
  );
  assert.match(onboardingSkillNormalized, /Пропускай обращение к Trelio только/u);
  assert.match(onboardingSkillNormalized, /его контекст не проверен/u);
  assert.match(onboardingSkillNormalized, /не связывает с Trelio Git-репозиторий/u);
  assert.match(
    onboardingSkill,
    /Do not describe\s+the instruction file as uncommitted or suggest committing it/u,
  );
  assert.doesNotMatch(onboardingSkillNormalized, /Для запросов, относящихся к Trelio/u);
  assert.match(
    onboardingSkillNormalized,
    /Before configuring each selected skill, call `get_agent_skill` once/u,
  );
  assert.match(
    onboardingSkillNormalized,
    /complete uninterrupted configure\/doctor sequence/u,
  );
  assert.match(
    onboardingSkillNormalized,
    /do not repeat it before each subcommand/u,
  );
  assert.match(onboardingSkill, /AGENTS\.override\.md/u);
  assert.match(onboardingSkill, /get_agent_instructions/u);
  assert.match(onboardingSkill, /metadata-only `encryptionState`/u);
  assert.match(onboardingSkill, /For `encrypted`, do not call `get_agent_instructions`/u);
  assert.match(onboardingSkill, /For `encrypting`, `decrypting`, `failed`, or an unknown non-`plain` state/u);
  assert.match(onboardingSkill, /For every non-`plain` company, skip this entire section/u);
  assert.match(onboardingSkill, /do not call\s+`list_agent_skills`/u);
  assert.match(onboardingSkill, /successful bridge login proves only the ordinary\s+local\s+device session/u);
  assert.match(onboardingSkill, /trelio-workspace encryption setup --company <exact-slug> --json/u);
  assert.match(onboardingSkill, /mandatory encrypted-device onboarding step/u);
  assert.match(onboardingSkill, /round-trips a random local canary through the\s+production `TRELIOE1` codec/u);
  assert.match(onboardingSkill, /creates no Workspace, Agent Run, lease/u);
  assert.match(onboardingSkill, /require `encryptionState=encrypted` and\s+`selfTest\.status=passed`/u);
  assert.match(onboardingSkill, /repeat the same setup command rather than starting a Run/u);
  assert.match(onboardingSkill, /company owner must grant that exact Agent Workspaces device/u);
  assert.match(onboardingSkill, /trelio-workspace login/u);
  assert.match(onboardingSkill, /codex mcp list --json/u);
  assert.match(onboardingSkill, /codex plugin list --json/u);
  assert.match(onboardingSkill, /codex plugin add trelio-agent-workspaces@trelio-plugins/u);
  assert.match(onboardingSkill, /a listed marketplace is not proof that its\s+plugin is installed/u);
  assert.match(onboardingSkill, /`INSTALLED_BY_DEFAULT` only as a host optimization/u);
  assert.match(
    onboardingSkill,
    /Resolve the exact company before `get_agent_instructions` or any local file\s+write/u,
  );
  assert.match(onboardingSkill, /explicit company slug[\s\S]{0,180}exact selector, not as a hint/u);
  assert.match(
    onboardingSkill,
    /If that slug is absent, stop[\s\S]{0,180}never substitute another\s+company/u,
  );
  assert.match(onboardingSkill, /one unique\s+exact display-name match/u);
  assert.match(
    onboardingSkill,
    /working-folder name or path, repository name, nearby files[\s\S]{0,180}never company evidence/u,
  );
  assert.match(onboardingSkill, /If several are accessible, ask the user before any\s+scoped read or write/u);
  assert.match(onboardingSkill, /A user correction invalidates the previous candidate/u);
  assert.match(onboardingSkill, /resolve-node\.ps1/u);
  assert.match(onboardingSkill, /durable\s+machine\/user PATH\s+values/u);
  assert.match(onboardingSkill, /launch-trelio-node/u);
  assert.match(onboardingSkill, /failed Codex PATH-alias creation is not proof/u);
  assert.match(onboardingSkill, /in Codex use\s+`codex mcp login trelio`/u);
  assert.match(onboardingSkill, /Never open the Trelio site as a\s+preparatory login/u);
  assert.match(onboardingSkill, /ask the user\s+to report that login finished/u);
  assert.match(onboardingSkill, /retry one low-risk\s+Trelio read in this same task/u);
  assert.match(onboardingSkill, /Ask for a new task or Claude session in the same\s+working folder only when that live retry proves/u);
  assert.match(onboardingSkill, /processPathReady=false/u);
  assert.match(onboardingSkill, /use its absolute\s+`nodePath`/u);
  assert.match(onboardingSkill, /do not repeat the same advice/u);
  assert.match(onboardingSkill, /trelio-workspace\.mjs`\s+with `doctor --json/u);
  assert.match(onboardingSkill, /standalone Git\s+2\.28/u);
  assert.match(onboardingSkill, /temporary\s+`init → add → commit`/u);
  assert.match(onboardingSkill, /private Git that Codex may use to\s+download a\s+marketplace/u);
  assert.match(onboardingSkill, /Do not stop at an\s+offer/u);
  assert.match(onboardingSkill, /do not ask for a separate confirmation in chat/u);
  assert.match(onboardingSkill, /brew install git/u);
  assert.match(onboardingSkill, /xcode-select --install/u);
  assert.match(onboardingSkill, /winget install --id Git\.Git -e/u);
  assert.match(onboardingSkill, /rerun doctor in the same task/u);
  assert.match(onboardingSkill, /do not require an\s+app restart/u);
  assert.match(onboardingSkill, /winget install --id OpenJS\.NodeJS\.LTS -e/u);
  assert.match(onboardingSkill, /brew install node/u);
  assert.match(onboardingSkill, /Ask one\s+concise explicit confirmation/u);
  assert.match(onboardingSkill, /Do not install\s+`trelio-workspace`\s+globally/u);
  assert.match(onboardingSkill, /требуется настройка администратором компании/u);
  assert.match(onboardingSkill, /enabledThroughProjectMembership=true/u);
  assert.match(onboardingSkill, /sources` containing\s+`project_membership`/u);
  assert.match(onboardingSkill, /treat it as available in the current company scope\s+and offer it now/u);
  assert.match(onboardingSkill, /Do not misclassify it as strict project-only merely\s+because `enabledAtCompany=false`/u);
  assert.match(onboardingSkill, /only strict project-only skills missing from the\s+company-wide response will be offered just in time/u);
  assert.doesNotMatch(
    onboardingSkill,
    /project-only skills will be offered just in time when a concrete Trelio/u,
  );
  assert.match(onboardingSkill, /Do not open a company workspace/u);
  assert.match(onboardingSkill, /full restart only\s+if that fresh process still sees the old version/u);
  assert.doesNotMatch(onboardingSkill, /fully restart Codex, and start a new task/u);
  assert.doesNotMatch(onboardingSkill, /\[TODO:/u);
  assert.match(workerAgentMetadata, /для работы с Trelio и безопасного сохранения результата/u);
  assert.doesNotMatch(workerAgentMetadata, /массовым обычным поиском/u);
});

test("plugin exposes focused value-free diagnostics for setup and hook failures", async () => {
  const diagnosticsDirectory = path.join(
    pluginDirectory,
    "skills",
    "trelio-diagnostics",
  );
  const diagnosticsSkill = await readFile(
    path.join(diagnosticsDirectory, "SKILL.md"),
    "utf8",
  );
  const diagnosticsAgentMetadata = await readFile(
    path.join(diagnosticsDirectory, "agents", "openai.yaml"),
    "utf8",
  );
  const workerSkill = await readFile(
    path.join(pluginDirectory, "skills", "trelio-workspace-worker", "SKILL.md"),
    "utf8",
  );

  assert.match(diagnosticsSkill, /^---\nname: trelio-diagnostics\n/u);
  assert.match(diagnosticsSkill, /loaded plugin version, hooks,\s+MCP\/OAuth/u);
  assert.match(diagnosticsSkill, /Keep\s+the first pass read-only/u);
  assert.match(diagnosticsSkill, /plugin\.loadedVersion/u);
  assert.match(diagnosticsSkill, /approvalStatus=client_managed_unknown/u);
  assert.match(diagnosticsSkill, /codex plugin list --json/u);
  assert.match(diagnosticsSkill, /codex mcp list --json/u);
  assert.match(diagnosticsSkill, /launch-trelio-node/u);
  assert.match(diagnosticsSkill, /failed Codex PATH-alias\s+creation is not a missing-Node diagnosis/u);
  assert.match(diagnosticsSkill, /Do not infer Claude Code only\s+from `CLAUDE_PLUGIN_ROOT`/u);
  assert.match(diagnosticsSkill, /Do not create or mutate an\s+object just to test a hook/u);
  assert.match(diagnosticsSkill, /installed version already satisfies the requirement/u);
  assert.match(diagnosticsSkill, /do not update again/u);
  assert.match(diagnosticsSkill, /definition hash may require one\s+client review/u);
  assert.match(diagnosticsSkill, /behavior-only fixes[\s\S]{0,100}do not require another/u);
  assert.match(diagnosticsSkill, /never exposes session IDs or keys/u);
  assert.match(diagnosticsAgentMetadata, /Диагностика Trelio/u);
  assert.match(diagnosticsAgentMetadata, /\$trelio-diagnostics/u);
  assert.match(workerSkill, /dedicated trelio-diagnostics skill/u);
});

test("bundled skills reserve hook activation for Trelio's missing-proof signal", async () => {
  const recoveryPhrase = /Откройте\s+настройки\s+плагина\s+Trelio\s+Agent\s+Workspaces,\s+включите\s+Hooks\s+и\s+повторите\s+запрос\./u;
  const recoveryFiles = [
    path.join(pluginDirectory, "skills", "trelio-diagnostics", "SKILL.md"),
    path.join(pluginDirectory, "skills", "trelio-project-onboarding", "SKILL.md"),
    path.join(pluginDirectory, "skills", "trelio-workspace-worker", "SKILL.md"),
    path.join(pluginDirectory, "skills", "trelio-skill-catalog", "SKILL.md"),
    path.join(pluginDirectory, "skills", "trelio-project-access", "SKILL.md"),
    path.join(
      pluginDirectory,
      "skills",
      "trelio-workspace-worker",
      "references",
      "setup-and-recovery.md",
    ),
  ];

  for (const filePath of recoveryFiles) {
    const instructions = await readFile(filePath, "utf8");
    assert.match(instructions, recoveryPhrase);
    assert.match(instructions, /Trelio itself\s+returns\s+`TRELIO_RUNTIME_HOOK_REQUIRED`/u);
    assert.match(
      instructions,
      /A `PreToolUse` failure[\s\S]{0,160}proves[\s\S]{0,80}(?:hook is active|hook ran)/u,
    );
    assert.match(instructions, /AGENT_WORKSPACE_PLUGIN_UPGRADE_REQUIRED/u);
    assert.match(instructions, /Do not\s+initially\s+suggest/u);
    assert.match(instructions, /Escalate only/u);
  }

  assert.doesNotMatch(
    AGENT_WORKSPACE_RUNTIME_AGENTS_MARKDOWN,
    /TRELIO_RUNTIME_HOOK_REQUIRED.*при необходимости выполнить `trelio-workspace login`/u,
  );
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

test("workspace skill follows the company Agent Secret storage policy before creation", async () => {
  const workspaceSkill = await readSkillBundle("trelio-workspace-worker");

  assert.match(workspaceSkill, /call\s+`list_agent_secrets` for the exact target scope/u);
  assert.match(workspaceSkill, /read its\s+company-level\s+`storagePolicy`/u);
  assert.match(workspaceSkill, /`prefer_trelio`/u);
  assert.match(workspaceSkill, /`contextual`/u);
  assert.match(workspaceSkill, /`local_only`/u);
  assert.match(workspaceSkill, /Ask the user before creating the\s+immutable record when the context is ambiguous/u);
  assert.match(workspaceSkill, /cannot\s+override company `local_only`/u);
  assert.match(workspaceSkill, /A policy change never migrates an existing\s+record/u);
  assert.match(workspaceSkill, /`allowAgentSaveChatSecrets`/u);
  assert.match(workspaceSkill, /`save_known_agent_secret`/u);
  assert.match(workspaceSkill, /merely sharing it, asking\s+to sign in, or asking to use it is not storage consent/u);
  assert.match(workspaceSkill, /`userExplicitlyRequestedPersistentStorage=true`/u);
  assert.match(workspaceSkill, /original plaintext remains in the chat and may remain\s+in the AI client's tool history/u);
  assert.match(workspaceSkill, /Do not use this path\s+for `local_device`/u);
  assert.match(workspaceSkill, /Do not use this path[\s\S]{0,180}or ask the user to provide a new value/u);
});

test("workspace setup keeps initial OAuth in one browser flow and retries the current task", async () => {
  const workspaceSkill = await readSkillBundle("trelio-workspace-worker");

  assert.match(workspaceSkill, /inspect `codex plugin list --json`/u);
  assert.match(workspaceSkill, /registered marketplace is not proof that the plugin is installed/u);
  assert.match(workspaceSkill, /codex plugin add trelio-agent-workspaces@trelio-plugins/u);
  assert.match(workspaceSkill, /run\s+`codex mcp login trelio` immediately/u);
  assert.match(workspaceSkill, /single\s+browser flow includes Trelio login/u);
  assert.match(workspaceSkill, /report «я вошёл» in chat/u);
  assert.match(workspaceSkill, /retry the\s+original low-risk Trelio read once in the current task/u);
  assert.match(workspaceSkill, /Start a new task only when this live retry proves/u);
  assert.match(workspaceSkill, /Failure of only `trelio-remote-skills` is not failed Trelio OAuth/u);
});

test("workspace recovery installs missing Git through the native macOS or Windows flow", async () => {
  const workspaceSkill = await readSkillBundle("trelio-workspace-worker");

  assert.match(workspaceSkill, /`TRELIO_GIT_REQUIRED`/u);
  assert.match(workspaceSkill, /standalone Git 2\.28\+/u);
  assert.match(workspaceSkill, /temporary\s+`init → add → commit`/u);
  assert.match(workspaceSkill, /Arbitrary process-PATH executables are not candidates/u);
  assert.match(workspaceSkill, /never reuse an undocumented Git private to Codex/u);
  assert.match(workspaceSkill, /immediately\s+run its exact installation plan without another confirmation question/u);
  assert.match(workspaceSkill, /brew install git/u);
  assert.match(workspaceSkill, /xcode-select --install/u);
  assert.match(workspaceSkill, /winget install --id Git\.Git -e/u);
  assert.match(workspaceSkill, /normal command approval, administrator prompt/u);
  assert.match(workspaceSkill, /rerun doctor in the same task/u);
  assert.match(workspaceSkill, /no app restart is required/u);
});

test("workspace OAuth recovery distinguishes configured OAuth from a missing process bearer", async () => {
  const workspaceSkill = await readSkillBundle("trelio-workspace-worker");

  assert.match(workspaceSkill, /`auth_status: "o_auth"` only as the configured authentication scheme/u);
  assert.match(workspaceSkill, /HTTP 401\s+or required\/missing-bearer/u);
  assert.match(workspaceSkill, /do not run `codex mcp login trelio`\s+again/u);
  assert.match(workspaceSkill, /cannot repair bearer\s+propagation in an already-open process/u);
  assert.match(workspaceSkill, /Use a fresh task\/process and keep\s+the completed authorization/u);
});

test("Windows Node resolver uses durable PATH when the Codex process PATH is stale", {
  skip: process.platform !== "win32",
}, async () => {
  const resolverPath = path.join(pluginDirectory, "scripts", "resolve-node.ps1");
  const missingProcessPath = path.join(os.tmpdir(), "trelio-node-not-in-process-path");
  const { stdout } = await execFileAsync(
    "powershell.exe",
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      resolverPath,
      "-ProcessPath",
      missingProcessPath,
      "-UserPath",
      "",
      "-MachinePath",
      path.dirname(process.execPath),
      "-SkipDefaultInstallRoots",
    ],
    { encoding: "utf8" },
  );
  const result = JSON.parse(stdout.trim());

  assert.equal(result.status, "ready");
  assert.equal(result.processPathReady, false);
  assert.equal(result.restartMayBeRequiredForLocalMcp, true);
  assert.equal(result.source, "machine-path");
  assert.equal(path.resolve(result.nodePath).toLowerCase(), process.execPath.toLowerCase());
  assert.match(result.version, /^v(?:2[2-9]|[3-9][0-9])\./u);

  const { stdout: pathOnlyStdout } = await execFileAsync(
    "powershell.exe",
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      resolverPath,
      "-ProcessPath",
      missingProcessPath,
      "-UserPath",
      "",
      "-MachinePath",
      path.dirname(process.execPath),
      "-SkipDefaultInstallRoots",
      "-PathOnly",
    ],
    { encoding: "utf8" },
  );
  assert.equal(
    path.resolve(pathOnlyStdout.trim()).toLowerCase(),
    process.execPath.toLowerCase(),
  );
});

test("Windows Remote MCP launcher uses the Codex Node runtime without PATH", {
  skip: process.platform !== "win32",
  timeout: 15_000,
}, async () => {
  // Match the manifest's working-directory contract: both launcher and target
  // are repository-relative paths without shell-sensitive quoting.
  const command = [
    "scripts\\launch-trelio-node.cmd",
    "tests\\fixtures\\node-launcher-probe.mjs",
    "remote-argument",
  ].join(" ");
  const { stdout } = await execFileAsync(
    process.env.ComSpec || "cmd.exe",
    ["/d", "/s", "/c", command],
    {
      cwd: pluginDirectory,
      encoding: "utf8",
      env: {
        ...process.env,
        // A merely executable host hint must not pass Node validation.
        CODEX_MCP_NODE_PATH: path.join(
          process.env.SystemRoot || "C:\\Windows",
          "System32",
          "where.exe",
        ),
        CODEX_BROWSER_USE_NODE_PATH: process.execPath,
        PATH: os.tmpdir(),
      },
    },
  );
  assert.deepEqual(JSON.parse(stdout), ["remote-argument"]);
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

test("private skill management keeps owner-only confirmation, E2EE and assignment boundaries", async () => {
  const managementSkill = await readFile(
    path.join(
      pluginDirectory,
      "skills",
      "trelio-private-skill-management",
      "SKILL.md",
    ),
    "utf8",
  );

  assert.match(managementSkill, /company owner or an administrator/u);
  assert.match(managementSkill, /`agent-skill:manage`/u);
  assert.match(managementSkill, /executionKind=markdown/u);
  assert.match(managementSkill, /executionKind=remote_mcp/u);
  assert.match(managementSkill, /executionKind=skillpkg/u);
  assert.match(managementSkill, /plan_company_private_agent_skill_create/u);
  assert.match(managementSkill, /create_company_private_agent_skill/u);
  assert.match(managementSkill, /plan_company_private_agent_skill_release/u);
  assert.match(managementSkill, /publish_company_private_agent_skill_release/u);
  assert.match(managementSkill, /Do not call an\s+apply tool in the same assistant turn as its plan/u);
  assert.match(managementSkill, /exact `planHash`/u);
  assert.match(managementSkill, /exact `settingsUrl` returned by apply/u);
  assert.match(managementSkill, /does not assign or enable it/u);
  assert.match(managementSkill, /bridge encrypts prose, discovery terms, Remote MCP configuration/u);
  assert.match(managementSkill, /company_unverified/u);
  assert.doesNotMatch(managementSkill, /\[TODO:/u);
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

test("only a server-created restore handoff may keep an exact empty file delta", () => {
  assert.equal(canOmitAgentWorkspaceHandoffFiles({
    checkpointType: "handoff",
    clientKind: "workspace_restore",
    clientMetadataSource: "local_encrypted_restore",
  }), true);
  assert.equal(canOmitAgentWorkspaceHandoffFiles({
    checkpointType: "handoff",
    clientKind: "workspace_restore",
    clientMetadataSource: "mcp",
  }), false);
  assert.equal(canOmitAgentWorkspaceHandoffFiles({
    checkpointType: "handoff",
    clientKind: "workspace-bridge",
    clientMetadataSource: "local_encrypted_restore",
  }), false);
  assert.equal(canOmitAgentWorkspaceHandoffFiles({
    checkpointType: "draft",
    clientKind: "workspace_restore",
    clientMetadataSource: "local_encrypted_restore",
  }), false);
});

test("workspace skill routes direct proposals independently of maintainer work and compaction", async () => {
  const workerDirectory = path.join(pluginDirectory, "skills", "trelio-workspace-worker");
  const mainSkill = await readFile(path.join(workerDirectory, "SKILL.md"), "utf8");
  const proposalReference = await readFile(
    path.join(workerDirectory, "references", "task-comment-proposals.md"),
    "utf8",
  );
  const taskRunReference = await readFile(
    path.join(workerDirectory, "references", "task-run.md"),
    "utf8",
  );

  assert.match(mainSkill, /editable task-comment proposal or reply with or without an Agent\s+Run/u);
  assert.match(mainSkill, /Editable task-comment proposal or reply/u);
  assert.match(mainSkill, /even during\s+maintainer work or after context compaction/u);
  assert.match(proposalReference, /its own native Trelio operation with or\s+without an Agent Workspace Run/u);
  assert.match(proposalReference, /follow-up during maintainer work, after context compaction/u);
  assert.match(proposalReference, /Preserve it as a pending deliverable and\s+complete it before the final response/u);
  assert.match(proposalReference, /direct exact-task proposal\s+uses `companySlug`, `projectSlug`, and `taskNumber`/u);
  assert.match(proposalReference, /Do not start an\s+Agent Workspace Run solely to prepare a proposal/u);
  assert.match(proposalReference, /A request to “only propose” reinforces the draft\s+route/u);
  assert.match(proposalReference, /A quotation, prose block, or promise to suggest text in the final response does\s+not satisfy the request/u);
  assert.doesNotMatch(taskRunReference, /get_task_comment_proposal_context|publish_task_comment_proposal/u);
});

test("workspace skill prepares a human proposal for direct tasks and accepted task Runs", async () => {
  const skillMarkdown = await readSkillBundle("trelio-workspace-worker");
  const bridgeSource = await readFile(bridgePath, "utf8");

  assert.match(skillMarkdown, /Do not publish automatically/u);
  assert.match(skillMarkdown, /After every substantive accepted task Run/u);
  // The semantic contract matters here, not whether the sentence begins with
  // an uppercase verb after a Markdown heading or continues after a clause.
  assert.match(skillMarkdown, /call\s+`propose_task_comment` once/iu);
  assert.match(skillMarkdown, /system handoff is technical audit and agent-readable context/u);
  assert.match(skillMarkdown, /ordinary comment for\s+people/u);
  assert.match(skillMarkdown, /get_task_comment_proposal_context/u);
  assert.match(skillMarkdown, /render_task_comment_proposal/u);
  assert.match(skillMarkdown, /dismiss_task_comment_proposal/u);
  assert.match(skillMarkdown, /publish_task_comment_proposal/u);
  assert.match(skillMarkdown, /server reads the fresh public-comment snapshot/u);
  assert.match(skillMarkdown, /standalone publication-ready cumulative update/u);
  assert.match(skillMarkdown, /UNPUBLISHED_DRAFT_REQUIRES_CONTEXT/u);
  assert.match(skillMarkdown, /Do not retry the compact tool/u);
  assert.match(skillMarkdown, /do not concatenate, patch, retract, or narrate the\s+old draft/u);
  // Keep the invariant stable when the reference gives the normal path a more
  // specific name such as "sole-card normal path".
  assert.match(skillMarkdown, /do not make separate context\/hash calls on (?:the|this sole-card)\s+normal path/u);
  assert.match(skillMarkdown, /Never use `create_comment` as a workaround/u);
  assert.match(skillMarkdown, /not acceptance\s+of the durable workspace result/u);
  assert.match(skillMarkdown, /After acceptance/u);
  assert.match(skillMarkdown, /only useful final\/intermediate `filePaths`/u);
  assert.match(skillMarkdown, /Do not\s+attach all workspace files/u);
  assert.match(skillMarkdown, /ordinary task attachments\s+are created only when\s+the operator publishes/iu);
  assert.match(skillMarkdown, /work_completed/u);
  assert.match(skillMarkdown, /review_passed/u);
  assert.match(skillMarkdown, /direct_completion/u);
  assert.match(skillMarkdown, /no_status_change/u);
  assert.match(bridgeSource, /--task-outcome/u);
  assert.doesNotMatch(skillMarkdown, /--task-comment/u);
  assert.doesNotMatch(bridgeSource, /task-comment/u);
});

test("workspace skill offers work start once and keeps completion status separate", async () => {
  const workerDirectory = path.join(pluginDirectory, "skills", "trelio-workspace-worker");
  const mainSkill = await readFile(path.join(workerDirectory, "SKILL.md"), "utf8");
  const statusProposalReference = await readFile(
    path.join(workerDirectory, "references", "task-status-proposals.md"),
    "utf8",
  );
  const taskRunReference = await readFile(
    path.join(workerDirectory, "references", "task-run.md"),
    "utf8",
  );
  const agentRunReference = await readFile(
    path.join(workerDirectory, "references", "agent-run.md"),
    "utf8",
  );

  assert.match(mainSkill, /asks to change a task status or prepare a separate editable status\s+proposal/u);
  assert.match(mainSkill, /one-shot start-of-work decision for a task Run/u);
  assert.match(mainSkill, /Always read it before opening a task Run/u);
  assert.match(mainSkill, /independently from the required human comment/u);
  assert.match(statusProposalReference, /`work_started` is the one-shot, non-blocking suggestion/u);
  assert.match(statusProposalReference, /semantic\s+`queue` to `active` transition returned by the server/u);
  assert.match(statusProposalReference, /Call `get_task_status_proposal_context` exactly once with that running task\s+Run's `runId`/u);
  assert.match(statusProposalReference, /When its `state` is `eligible`, call\s+`render_task_status_proposal` with `intent=work_started`/u);
  assert.match(statusProposalReference, /Continue the Run immediately after rendering/u);
  assert.match(statusProposalReference, /Do not repeat the context read or start proposal after a tool action/u);
  assert.match(statusProposalReference, /`dismissed_for_current_status`/u);
  assert.match(statusProposalReference, /`already_proposed_for_current_status`/u);
  assert.match(statusProposalReference, /durable server marker/u);
  assert.match(statusProposalReference, /backend suppression lasts until the task\s+actually leaves that queue status and later enters a new status epoch/u);
  assert.match(statusProposalReference, /Completing the immediate agent instruction may cover only\s+part of the task/u);
  assert.match(statusProposalReference, /After partial work, still prepare the required comment proposal, but do not\s+create a `whole_task_ready` proposal/u);
  assert.match(statusProposalReference, /unset optional due date, assignee, control,\s+or similar field is not an open task question by itself/u);
  assert.match(statusProposalReference, /blocks readiness only when the task requirements or the\s+target transition policy actually require that value/u);
  assert.match(statusProposalReference, /recorded `no_status_change`, or prose question about an optional field is not a\s+substitute/u);
  assert.match(statusProposalReference, /get_task_status_proposal_context/u);
  assert.match(statusProposalReference, /render_task_status_proposal/u);
  assert.match(statusProposalReference, /apply_task_status_proposal/u);
  assert.match(statusProposalReference, /dismiss_task_status_proposal/u);
  assert.match(statusProposalReference, /userExplicitlyRequestedImmediateStatusChange=true/u);
  assert.match(statusProposalReference, /conditional instruction such as “when\s+done move to review” does not satisfy this assertion/u);
  assert.match(statusProposalReference, /presses the corresponding MCP App action or\s+explicitly approves\/rejects that exact proposal/u);
  // A suppressed or ineligible proposal is internal control-plane bookkeeping,
  // so it must not create a user-facing progress or completion message by itself.
  assert.match(statusProposalReference, /When no status proposal was rendered, no status-related error affects the work,\s+and no task-status action is required from the user, do not mention that absence\s+in progress or final text; continue silently/u);
  assert.match(statusProposalReference, /mention task status only\s+when it is relevant to the user's request or next action/u);
  assert.match(statusProposalReference, /a status-related error\s+or blocker affects the work/u);
  assert.doesNotMatch(statusProposalReference, /state honestly whether no status proposal was\s+needed/u);
  assert.match(agentRunReference, /Immediately after the exact bridge `open` succeeds for a task-scoped Run/u);
  assert.match(agentRunReference, /Never repeat this start check\s+after a tool action, checkpoint, pause, resumed turn/u);
  assert.match(taskRunReference, /Outcome records a\s+recommendation; accepted Run does not change task status/u);
  assert.match(taskRunReference, /Use `--question` and `no_status_change` only when the answer is required to\s+complete, verify, or decide the task/u);
  assert.match(taskRunReference, /unresolved completion-blocking questions/u);
  assert.match(taskRunReference, /Do not manufacture a blocking question\s+from an unset optional due date, assignee, control, or other metadata field/u);
  assert.match(taskRunReference, /Reassess the whole task from the final evidence even\s+when the recorded outcome is `no_status_change`/u);
  assert.match(taskRunReference, /Partial work produces no status proposal/u);
  assert.doesNotMatch(taskRunReference, /Trelio moves the task|applies the outcome through the normal task-status service/u);
});

test("workspace skill proposes checklist progress without applying inferred state", async () => {
  const workerDirectory = path.join(pluginDirectory, "skills", "trelio-workspace-worker");
  const mainSkill = await readFile(path.join(workerDirectory, "SKILL.md"), "utf8");
  const checklistReference = await readFile(
    path.join(workerDirectory, "references", "task-checklist-proposals.md"),
    "utf8",
  );
  const taskRunReference = await readFile(
    path.join(workerDirectory, "references", "task-run.md"),
    "utf8",
  );
  const bundleReference = await readFile(
    path.join(workerDirectory, "references", "task-proposal-bundles.md"),
    "utf8",
  );

  assert.match(mainSkill, /checklist completion-state review or a separate checklist proposal/u);
  assert.match(mainSkill, /Checklist state request, inferred item progress, or accepted task Run/u);
  assert.match(mainSkill, /post-acceptance item-by-item decision even when the whole task is\s+not ready/u);
  assert.match(checklistReference, /After every substantive accepted task Run, call\s+`get_task_checklist_proposal_context`/u);
  assert.match(checklistReference, /Partial work may propose the exact items it satisfied/u);
  assert.match(checklistReference, /status-driven items linked to subtasks/u);
  assert.match(checklistReference, /render no checklist card and do\s+not mention a ritual “checklist unchanged” result/u);
  assert.match(checklistReference, /`render_task_checklist_proposal`/u);
  assert.match(checklistReference, /`checklistProposal` block/u);
  assert.match(checklistReference, /`apply_task_checklist_proposal`/u);
  assert.match(checklistReference, /`dismiss_task_checklist_proposal`/u);
  assert.match(checklistReference, /userExplicitlyRequestedImmediateChecklistStateChange=true/u);
  assert.match(checklistReference, /A stale item blocks\s+the whole selected batch/u);
  assert.match(checklistReference, /must not be copied to task\s+comments, system events, or notifications/u);
  assert.match(taskRunReference, /Partial work may propose exact satisfied items/u);
  assert.match(bundleReference, /get_task_checklist_proposal_context/u);
  assert.match(bundleReference, /checklist\/item snapshots/u);
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
  assert.match(skillMarkdown, /expectedAccessRevision/u);
  assert.match(skillMarkdown, /one free-form Markdown document/u);
  assert.match(skillMarkdown, /one or many tasks, dossiers, projects, or the company/u);
  assert.match(skillMarkdown, /Present the complete target-grouped meeting plan/u);
  assert.match(skillMarkdown, /successful create is not a terminal result/u);
  assert.match(skillMarkdown, /do not end the current\s+turn, ask whether to continue/u);
  assert.match(skillMarkdown, /`workflowStage`, `requiredNextAction`, and `mayFinish`/u);
  assert.match(skillMarkdown, /name merely mentioned in the transcript is not confirmation/u);
  assert.match(skillMarkdown, /state the current\s+exact access in plain language/u);
  assert.match(skillMarkdown, /include one short invitation for the user\s+to name anyone else/u);
  assert.match(skillMarkdown, /optional\s+question block result\s+preparation/u);
  assert.match(skillMarkdown, /`items=\[\]` and a concise `noContextUpdatesSummary`/u);
  assert.match(skillMarkdown, /returned\s+`completed_no_context_updates` stage/u);
  assert.match(skillMarkdown, /completes only the meeting-distribution\s+branch/u);
  assert.match(skillMarkdown, /complete post-meeting action set before the first proposal\s+write/u);
  assert.match(skillMarkdown, /native proposal references and tools/u);
  assert.match(skillMarkdown, /single proposal-bundle route/u);
  assert.match(skillMarkdown, /keeping their\s+approval boundaries explicit/u);
  assert.match(skillMarkdown, /never approve a sibling proposal or\s+mutation/u);
  assert.match(skillMarkdown, /never grants task\s+participants meeting access/u);
  assert.match(skillMarkdown, /never silently rewrite already\s+distributed workspaces/u);
});

test("workspace skill defaults task-level controls to shared without widening existing personal controls", async () => {
  const skillMarkdown = await readSkillBundle("trelio-workspace-worker");

  for (const toolName of ["create_task_control", "update_task_control", "clear_task_control"]) {
    assert.match(skillMarkdown, new RegExp(toolName, "u"));
  }

  assert.match(skillMarkdown, /Reaching `controlDate` never sends a notification/u);
  assert.match(skillMarkdown, /For a new control, choose `shared` by default/u);
  assert.match(skillMarkdown, /Choose `personal` only for an explicitly\s+private working check/u);
  assert.match(skillMarkdown, /another\s+person's action does not make the control personal/u);
  assert.match(skillMarkdown, /keep its current visibility unless the\s+user explicitly asks/u);
  assert.match(skillMarkdown, /creation default never widens an\s+existing personal control/u);
  assert.match(skillMarkdown, /do not silently create a personal substitute/u);
  assert.doesNotMatch(skillMarkdown, /Never\s+widen personal to shared/u);
  assert.match(skillMarkdown, /Clearing a shared control also notifies/u);
  assert.match(skillMarkdown, /Do not clear a control because the Run completed or task status changed/u);
  assert.match(
    AGENT_WORKSPACE_RUNTIME_AGENTS_MARKDOWN,
    /Комментарий, статус, checklist и control задачи являются отдельными user-decision flows/u,
  );
});

test("skills resolve the logical bridge launcher before runtime execution", async () => {
  const catalogSkill = await readFile(
    path.join(pluginDirectory, "skills", "trelio-skill-catalog", "SKILL.md"),
    "utf8",
  );
  const workspaceSkill = await readSkillBundle("trelio-workspace-worker");

  for (const instructions of [catalogSkill, workspaceSkill]) {
    assert.match(instructions, /logical launcher|логическ(?:ий|им) launcher/u);
    assert.match(instructions, /Node\.js 22\+/u);
    assert.match(instructions, /scan plugin caches|сканируй cache/u);
  }
  assert.match(AGENT_WORKSPACE_RUNTIME_AGENTS_MARKDOWN, /логический launcher текущего плагина/u);
  assert.match(AGENT_WORKSPACE_RUNTIME_AGENTS_MARKDOWN, /Node\.js 22\+/u);
  assert.match(AGENT_WORKSPACE_RUNTIME_AGENTS_MARKDOWN, /не сканируй cache/u);
  assert.match(catalogSkill, /fail merely to discover it/u);
  assert.match(workspaceSkill, /merely to discover failure/u);
  assert.match(AGENT_WORKSPACE_RUNTIME_AGENTS_MARKDOWN, /не запускай пробный failure/u);
  assert.match(catalogSkill, /not a fallback/u);
  assert.match(catalogSkill, /Do not announce/u);
  assert.match(workspaceSkill, /announce a normally missing PATH entry/u);
});

test("workspace instructions keep a canonical safe Agent Secret reference and use browser-fill", async () => {
  const workspaceSkill = await readSkillBundle("trelio-workspace-worker");

  for (const instructions of [workspaceSkill]) {
    assert.match(instructions, /secretId/u);
    assert.match(instructions, /current safe name|текущее safe название/u);
    assert.match(instructions, /prepare_agent_secret_browser_fill/u);
    assert.match(instructions, /fills automatically|подставляет значение автоматически/u);
    assert.doesNotMatch(instructions, /Alt\/Option\+Shift\+S|Alt\+Shift\+S/u);
    assert.match(instructions, /literal-text Browser\/Chrome tool|literal-text Browser\/Chrome\/Computer Use\s+action/u);
    assert.match(instructions, /clipboard/u);
  }
  assert.match(workspaceSkill, /merely\s+discovered but unused\s+secrets/u);
  assert.match(workspaceSkill, /--format fields-json/u);
  assert.match(workspaceSkill, /Never\s+split one logical multi-field credential/u);
  assert.match(workspaceSkill, /in-app Browser/u);
  assert.match(workspaceSkill, /do not assume that it inherits the system Chrome password\s+manager/u);
  assert.match(workspaceSkill, /already authenticated, continue with that session and do\s+not request or consume the Agent Secret/u);
  assert.match(workspaceSkill, /explicitly asks to see/u);
  assert.match(workspaceSkill, /protected Trelio reveal/u);
  assert.match(workspaceSkill, /publicUrl/u);
  assert.match(workspaceSkill, /selects one or several fields/u);
  assert.match(workspaceSkill, /direct user gesture/u);
  assert.match(AGENT_WORKSPACE_RUNTIME_AGENTS_MARKDOWN, /safe ссылка по secretId/u);
  assert.match(
    AGENT_WORKSPACE_RUNTIME_AGENTS_MARKDOWN,
    /Секретные значения никогда не передавай модели, MCP, prompt, env, argv/u,
  );
});

test("Trelio Secret Browser accepts an executable writable by its trusted OS group", async () => {
  const chromeExecutable = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  const filesystem = {
    realpath: async (candidate) => {
      if (candidate === chromeExecutable) return candidate;
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    },
    lstat: async () => ({
      mode: 0o100775,
      isFile: () => true,
      isSymbolicLink: () => false,
    }),
  };

  assert.equal(await resolveTrustedSecretBrowserExecutable({
    platform: "darwin",
    environment: {},
    filesystem,
  }), chromeExecutable);
});

test("Trelio Secret Browser still rejects a world-writable executable", async () => {
  const filesystem = {
    realpath: async (candidate) => candidate,
    lstat: async () => ({
      mode: 0o100777,
      isFile: () => true,
      isSymbolicLink: () => false,
    }),
  };

  await assert.rejects(
    resolveTrustedSecretBrowserExecutable({
      platform: "darwin",
      environment: {},
      filesystem,
    }),
    (error) => error?.reasonCode === "browser_unavailable",
  );
});

test("Trelio Secret Browser transports a value once through its isolated controller", {
  timeout: 10_000,
}, async () => {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "trelio-secret-browser-"));
  const profileDirectory = path.join(temporaryDirectory, "profile");
  const targetUrl = "https://login.example.test/account";
  const targetOrigin = "https://login.example.test";
  const targetUrlSha256 = createHash("sha256").update(targetUrl).digest("hex");
  const fieldSelector = "form#login input[type=password]";
  const secretValue = "must-never-appear-in-browser-arguments";
  const sessionMarkerPath = path.join(profileDirectory, "Default", "Cookies.session-test");
  await mkdir(path.dirname(sessionMarkerPath), { recursive: true, mode: 0o700 });
  await writeFile(sessionMarkerPath, "existing-provider-session", { mode: 0o600 });
  let observedArguments = [];
  const devToolsRequests = [];
  let clientClosed = false;

  const client = {
    request: async (method, params = {}, sessionId = undefined) => {
      devToolsRequests.push({ method, params, sessionId });
      if (method === "Target.createTarget") return { targetId: "target-1" };
      if (method === "Target.activateTarget") return {};
      if (method === "Target.getTargetInfo") return { targetInfo: { url: targetUrl } };
      if (method === "Target.attachToTarget") return { sessionId: "session-1" };
      if (method === "Page.enable" || method === "Runtime.enable") return {};
      if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "frame-1" } } };
      if (method === "Page.createIsolatedWorld") return { executionContextId: 41 };
      if (method === "Runtime.evaluate" && params.expression.includes("__trelioSecretBrowserController?.()")) {
        return { result: { value: { status: "ready" } } };
      }
      if (method === "Runtime.evaluate" && params.expression.startsWith("globalThis.__trelioSecretBrowserApply(")) {
        return { result: { value: { outcome: "succeeded" } } };
      }
      if (method === "Runtime.evaluate") return { result: {} };
      throw new Error(`Unexpected DevTools request: ${method}`);
    },
    close: () => {
      clientClosed = true;
    },
  };

  try {
    const result = await runSecretBrowserFill({
      secretValue,
      targetUrl,
      targetOrigin,
      targetUrlSha256,
      fieldSelector,
      profileDirectory,
      ensurePrivateDirectory: async (directory) => {
        await mkdir(directory, { recursive: true, mode: 0o700 });
        if (process.platform !== "win32") await chmod(directory, 0o700);
      },
      acquireBrowser: async ({ args }) => {
        observedArguments = args;
        return client;
      },
      controlBrowser: controlSecretBrowserViaDevTools,
      fillTimeoutMs: 2_000,
    });

    assert.deepEqual(result, { outcome: "succeeded" });
    assert.equal(clientClosed, true);
    assert.equal(observedArguments.some((argument) => argument.includes(secretValue)), false);
    assert.deepEqual(observedArguments.slice(-2), ["--new-window", "about:blank"]);
    assert.equal(observedArguments.some((argument) => argument.includes("load-extension")), false);

    const secretBearingRequests = devToolsRequests.filter((request) => (
      JSON.stringify(request).includes(secretValue)
    ));
    assert.equal(secretBearingRequests.length, 1);
    assert.equal(secretBearingRequests[0].method, "Runtime.evaluate");
    assert.match(secretBearingRequests[0].params.expression, /__trelioSecretBrowserApply/u);

    const preferences = JSON.parse(await readFile(path.join(profileDirectory, "Default", "Preferences"), "utf8"));
    assert.equal(preferences.credentials_enable_service, false);
    assert.equal(preferences.profile.password_manager_enabled, false);
    assert.equal(await readFile(sessionMarkerPath, "utf8"), "existing-provider-session");
    const controllerExpression = createSecretBrowserControllerExpression(targetOrigin, fieldSelector);
    assert.doesNotMatch(controllerExpression, new RegExp(secretValue, "u"));
    assert.match(controllerExpression, /form#login input\[type=password\]/u);
    assert.equal(normalizeSecretBrowserTarget(targetUrl, targetOrigin, targetUrlSha256), targetUrl);
    assert.equal(normalizeSecretBrowserFieldSelector(`  ${fieldSelector}  `), fieldSelector);
    assert.throws(
      () => normalizeSecretBrowserTarget("https://other.example.test/", targetOrigin, targetUrlSha256),
      /origin/u,
    );
    assert.throws(
      () => normalizeSecretBrowserTarget(`${targetUrl}?changed=1`, targetOrigin, targetUrlSha256),
      /exact URL/u,
    );
    assert.deepEqual(
      buildSecretBrowserArguments({
        profileDirectory: "/private/profile",
      }).slice(-2),
      ["--new-window", "about:blank"],
    );
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test("Trelio Secret Browser fails closed before sending a value for an ambiguous field", async () => {
  const targetUrl = "https://login.example.test/account";
  const targetOrigin = "https://login.example.test";
  const targetUrlSha256 = createHash("sha256").update(targetUrl).digest("hex");
  const secretValue = "must-not-be-sent-to-an-ambiguous-page";
  const requests = [];
  const client = {
    request: async (method, params = {}, sessionId = undefined) => {
      requests.push({ method, params, sessionId });
      if (method === "Target.createTarget") return { targetId: "target-1" };
      if (method === "Target.activateTarget") return {};
      if (method === "Target.getTargetInfo") return { targetInfo: { url: targetUrl } };
      if (method === "Target.attachToTarget") return { sessionId: "session-1" };
      if (method === "Page.enable" || method === "Runtime.enable") return {};
      if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "frame-1" } } };
      if (method === "Page.createIsolatedWorld") return { executionContextId: 42 };
      if (method === "Runtime.evaluate" && params.expression.includes("__trelioSecretBrowserController?.()")) {
        return { result: { value: { status: "failed", reasonCode: "field_ambiguous" } } };
      }
      if (method === "Runtime.evaluate") return { result: {} };
      throw new Error(`Unexpected DevTools request: ${method}`);
    },
  };

  const result = await controlSecretBrowserViaDevTools({
    client,
    secretValue,
    targetUrl,
    targetOrigin,
    targetUrlSha256,
    fieldSelector: "input[type=password]",
    fillTimeoutMs: 1_000,
  });

  assert.deepEqual(result, { outcome: "failed", reasonCode: "field_ambiguous" });
  assert.equal(requests.some((request) => JSON.stringify(request).includes(secretValue)), false);
});

test("Trelio Secret Browser fills login and password in one browser window and keeps it for later steps", async () => {
  const firstUrl = "https://login.example.test/account";
  const secondUrl = "https://login.example.test/otp";
  const steps = [
    {
      targetOrigin: "https://login.example.test",
      targetUrlSha256: createHash("sha256").update(firstUrl).digest("hex"),
      fields: [
        { fieldKey: "username", selector: "#username" },
        { fieldKey: "password", selector: "#password" },
      ],
    },
    {
      targetOrigin: "https://login.example.test",
      targetUrlSha256: createHash("sha256").update(secondUrl).digest("hex"),
      fields: [{ fieldKey: "totp", selector: "#otp" }],
    },
  ];
  const values = { username: "agent-login", password: "agent-password", totp: "123456" };
  const requests = [];
  let appliedSteps = 0;
  const client = {
    request: async (method, params = {}, sessionId = undefined) => {
      requests.push({ method, params, sessionId });
      if (method === "Target.createTarget") return { targetId: "one-window-target" };
      if (method === "Target.activateTarget") return {};
      if (method === "Target.getTargetInfo") {
        return { targetInfo: { url: appliedSteps === 0 ? firstUrl : secondUrl } };
      }
      if (method === "Target.attachToTarget") return { sessionId: "one-window-session" };
      if (method === "Page.enable" || method === "Runtime.enable") return {};
      if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "one-window-frame" } } };
      if (method === "Page.createIsolatedWorld") return { executionContextId: 50 + appliedSteps };
      if (method === "Runtime.evaluate" && params.expression.includes("__trelioSecretBrowserController?.()")) {
        return { result: { value: { status: "ready" } } };
      }
      if (method === "Runtime.evaluate" && params.expression.includes("__trelioSecretBrowserApply")) {
        appliedSteps += 1;
        return { result: { value: { outcome: "succeeded" } } };
      }
      if (method === "Runtime.evaluate") return { result: {} };
      throw new Error(`Unexpected DevTools request: ${method}`);
    },
  };

  const result = await controlSecretBrowserViaDevTools({
    client,
    secretValues: values,
    targetUrl: firstUrl,
    browserSteps: steps,
    fillTimeoutMs: 1_000,
  });

  assert.deepEqual(result, { outcome: "succeeded" });
  assert.equal(requests.filter((request) => request.method === "Target.createTarget").length, 1);
  assert.equal(requests.filter((request) => request.method === "Target.attachToTarget").length, 1);
  const applyExpressions = requests
    .filter((request) => request.method === "Runtime.evaluate" && request.params.expression.startsWith("globalThis.__trelioSecretBrowserApply("))
    .map((request) => request.params.expression);
  assert.equal(applyExpressions.length, 2);
  assert.match(applyExpressions[0], /agent-login/u);
  assert.match(applyExpressions[0], /agent-password/u);
  assert.doesNotMatch(applyExpressions[0], /123456/u);
  assert.match(applyExpressions[1], /123456/u);
});

test("secret set requires an explicit fields-json format and keeps scalar JSON compatible", () => {
  const scalarJson = '{"username":"synthetic-scalar-value"}';
  assert.deepEqual(parseAgentSecretSetInput(scalarJson, undefined), {
    value: scalarJson,
  });

  const structured = parseAgentSecretSetInput(JSON.stringify({
    Username: "synthetic-login-value",
    password: "synthetic-password-value",
    totp: null,
  }), "fields-json");
  assert.deepEqual({ ...structured.values }, {
    username: "synthetic-login-value",
    password: "synthetic-password-value",
    totp: null,
  });
  assert.equal(Object.getPrototypeOf(structured.values), null);

  assert.throws(
    () => parseAgentSecretSetInput("{}", "fields-json"),
    /от 1 до 50/u,
  );
  assert.throws(
    () => parseAgentSecretSetInput('["synthetic-password-value"]', "fields-json"),
    /JSON-объектом именованных полей/u,
  );
  assert.throws(
    () => parseAgentSecretSetInput('{"username":42}', "fields-json"),
    /строкой или null/u,
  );
  assert.throws(
    () => parseAgentSecretSetInput(
      '{"Username":"synthetic-first-value","username":"synthetic-second-value"}',
      "fields-json",
    ),
    /повторяющийся ключ/u,
  );

  const invalidPlaintext = "synthetic-value-that-must-not-reach-errors";
  assert.throws(
    () => parseAgentSecretSetInput(`{"password":"${invalidPlaintext}"`, "fields-json"),
    (error) => {
      assert.match(error.message, /корректным JSON-объектом/u);
      assert.equal(error.message.includes(invalidPlaintext), false);
      return true;
    },
  );
});

test("secret set sends one atomic named-field bundle from protected stdin", {
  timeout: 10_000,
}, async () => {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "trelio-secret-set-fields-"));
  const homeDirectory = path.join(temporaryDirectory, "home");
  const rootDirectory = path.join(temporaryDirectory, "run");
  const workspaceDirectory = path.join(rootDirectory, "workspace");
  const secretId = "77777777-7777-4777-8777-777777777777";
  const values = {
    username: "synthetic-login-value",
    password: "synthetic-password-value",
  };
  let compatibilityCount = 0;
  const writes = [];
  let serverError = null;

  const server = createServer(async (request, response) => {
    try {
      assert.equal(request.headers.authorization, "Bearer integration-token");
      assert.equal(request.headers["x-trelio-agent-workspaces-version"], BRIDGE_VERSION);

      if (
        request.method === "GET"
        && request.url === "/api/agent-workspaces/bridge-compatibility"
      ) {
        compatibilityCount += 1;
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ supported: true, minimumVersion: BRIDGE_VERSION }));
        return;
      }

      if (
        request.method === "GET"
        && request.url === `/api/agent-secrets/secrets/${secretId}/bridge-write-context?runId=${runId}`
      ) {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({
          storageMode: "trelio",
          secretId,
          companyId: "88888888-8888-4888-8888-888888888888",
          companyMemberId: "99999999-9999-4999-8999-999999999999",
          currentVersion: 0,
          fields: [
            { key: "username", label: "Логин", type: "username", required: true },
            { key: "password", label: "Пароль", type: "password", required: true },
          ],
        }));
        return;
      }

      if (
        request.method === "PUT"
        && request.url === `/api/agent-secrets/secrets/${secretId}/value-from-bridge`
      ) {
        writes.push(JSON.parse((await readRequestBody(request)).toString("utf8")));
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ status: "active" }));
        return;
      }

      throw new Error(`Unexpected Agent Secret request: ${request.method} ${request.url}`);
    } catch (error) {
      serverError = error;
      response.statusCode = 500;
      response.end("Synthetic Agent Secret test failure");
    }
  });

  try {
    await Promise.all([
      mkdir(homeDirectory, { recursive: true }),
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

    const result = await execBridgeWithInput(
      [
        "secret",
        "set",
        "--secret",
        secretId,
        "--format",
        "fields-json",
      ],
      JSON.stringify(values),
      {
        cwd: workspaceDirectory,
        encoding: "utf8",
        timeout: 8_000,
        env: {
          ...process.env,
          HOME: homeDirectory,
          TRELIO_WORKSPACE_DISABLE_AUTO_UPDATE: "1",
          TRELIO_WORKSPACE_DISABLE_KEYCHAIN: "1",
        },
      },
    );

    assert.match(result.stdout, /Значение секрета зашифровано/u);
    assert.equal(result.stdout.includes(values.username), false);
    assert.equal(result.stdout.includes(values.password), false);
    assert.equal(result.stderr, "");
    assert.equal(compatibilityCount, 1);
    assert.deepEqual(writes, [{ runId, values }]);
    assert.ifError(serverError);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test("local-device secret set persists values only in private config and sends attestation metadata", {
  timeout: 10_000,
}, async () => {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "trelio-secret-set-local-"));
  const homeDirectory = path.join(temporaryDirectory, "home");
  const rootDirectory = path.join(temporaryDirectory, "run");
  const workspaceDirectory = path.join(rootDirectory, "workspace");
  const secretId = "77777777-7777-4777-8777-777777777771";
  const grantId = "66666666-6666-4666-8666-666666666661";
  const companyId = "88888888-8888-4888-8888-888888888888";
  const companyMemberId = "99999999-9999-4999-8999-999999999999";
  const values = {
    username: "synthetic-local-login",
    password: "synthetic-local-password",
  };
  const mutations = [];
  let confirmedAttestationId = null;
  let consumeCount = 0;
  let serverError = null;

  const server = createServer(async (request, response) => {
    try {
      assert.equal(request.headers.authorization, "Bearer integration-token");
      assert.equal(request.headers["x-trelio-agent-workspaces-version"], BRIDGE_VERSION);
      if (request.method === "GET" && request.url === "/api/agent-workspaces/bridge-compatibility") {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ supported: true, minimumVersion: BRIDGE_VERSION }));
        return;
      }
      if (
        request.method === "GET"
        && request.url === `/api/agent-secrets/secrets/${secretId}/bridge-write-context?runId=${runId}`
      ) {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({
          storageMode: "local_device",
          secretId,
          companyId,
          companyMemberId,
          currentVersion: 0,
          fields: [
            { key: "username", label: "Логин", type: "username", required: true },
            { key: "password", label: "Пароль", type: "password", required: true },
          ],
        }));
        return;
      }
      if (
        request.method === "POST"
        && request.url === `/api/agent-secrets/secrets/${secretId}/local-writes/prepare`
      ) {
        const body = JSON.parse((await readRequestBody(request)).toString("utf8"));
        mutations.push({ type: "prepare", body });
        confirmedAttestationId = body.attestationId;
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({
          attestationId: body.attestationId,
          secretId,
          companyId,
          companyMemberId,
          secretVersion: 1,
        }));
        return;
      }
      if (request.method === "POST" && request.url?.startsWith("/api/agent-secrets/local-writes/")) {
        const body = JSON.parse((await readRequestBody(request)).toString("utf8"));
        mutations.push({ type: "confirm", body });
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ status: "active" }));
        return;
      }
      if (
        request.method === "POST"
        && request.url === `/api/agent-secrets/checkout-grants/${grantId}/consume`
      ) {
        assert.deepEqual(
          JSON.parse((await readRequestBody(request)).toString("utf8")),
          { runId },
        );
        consumeCount += 1;
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({
          storageMode: "local_device",
          grantId,
          secretId,
          runId,
          companyId,
          companyMemberId,
          localAttestationId: confirmedAttestationId,
          secretVersion: 1,
          fieldKeys: ["username", "password"],
          fields: [
            { key: "username", label: "Логин", type: "username", required: true },
            { key: "password", label: "Пароль", type: "password", required: true },
          ],
          executable: process.execPath,
          deliveryMode: "env",
          environmentVariables: {
            username: "LOCAL_USERNAME",
            password: "LOCAL_PASSWORD",
          },
        }));
        return;
      }
      throw new Error(`Unexpected local Agent Secret request: ${request.method} ${request.url}`);
    } catch (error) {
      serverError = error;
      response.statusCode = 500;
      response.end("Synthetic local Agent Secret test failure");
    }
  });

  try {
    await Promise.all([
      mkdir(homeDirectory, { recursive: true }),
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
    const result = await execBridgeWithInput([
      "secret",
      "set",
      "--secret",
      secretId,
      "--format",
      "fields-json",
    ], JSON.stringify(values), {
      cwd: workspaceDirectory,
      encoding: "utf8",
      timeout: 8_000,
      env: {
        ...process.env,
        HOME: homeDirectory,
        TRELIO_WORKSPACE_DISABLE_AUTO_UPDATE: "1",
        TRELIO_WORKSPACE_DISABLE_KEYCHAIN: "1",
      },
    });
    assert.match(result.stdout, /сохранено только на этом компьютере/u);
    assert.equal(JSON.stringify(mutations).includes(values.username), false);
    assert.equal(JSON.stringify(mutations).includes(values.password), false);
    assert.deepEqual(mutations.map((item) => item.type), ["prepare", "confirm"]);
    assert.deepEqual(mutations[0].body.fieldKeys, ["username", "password"]);
    const originKey = createHash("sha256").update(origin).digest("hex");
    const localFile = path.join(
      homeDirectory,
      ".config",
      "trelio",
      "workspace-bridge",
      "agent-secrets",
      originKey,
      companyMemberId,
      secretId,
      "secret.json",
    );
    const localStat = await stat(localFile);
    if (process.platform !== "win32") assert.equal(localStat.mode & 0o777, 0o600);
    const localRecord = JSON.parse(await readFile(localFile, "utf8"));
    assert.deepEqual(localRecord.values, values);
    assert.equal(localRecord.secretVersion, 1);
    assert.match(localRecord.attestationId, /^[0-9a-f-]{36}$/u);

    // Consume-ответ намеренно не содержит values/value. Bridge должен взять
    // exact подтверждённый контейнер из private storage и передать его только
    // закреплённому executable через заявленные имена переменных окружения.
    const checkout = await execFileAsync(process.execPath, [
      bridgePath,
      "secret",
      "exec",
      "--grant",
      grantId,
      "--",
      process.execPath,
      "-e",
      "if (!process.env.LOCAL_USERNAME || !process.env.LOCAL_PASSWORD) process.exit(2); process.stdout.write('local-ok')",
    ], {
      cwd: workspaceDirectory,
      encoding: "utf8",
      timeout: 8_000,
      env: {
        ...process.env,
        HOME: homeDirectory,
        TRELIO_WORKSPACE_DISABLE_AUTO_UPDATE: "1",
        TRELIO_WORKSPACE_DISABLE_KEYCHAIN: "1",
      },
    });
    assert.equal(checkout.stdout, "local-ok");
    assert.equal(checkout.stderr, "");
    assert.equal(consumeCount, 1);
    assert.ifError(serverError);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
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

test("workspace worker gates external services but not native Trelio work", async () => {
  const workerSkill = await readSkillBundle("trelio-workspace-worker");
  const catalogSkill = await readFile(
    path.join(pluginDirectory, "skills", "trelio-skill-catalog", "SKILL.md"),
    "utf8",
  );
  const workerSkillNormalized = workerSkill.replace(/\s+/gu, " ");
  const catalogSkillNormalized = catalogSkill.replace(/\s+/gu, " ");

  assert.match(workerSkill, /Read this file completely before using a connected service/u);
  assert.match(workerSkill, /`search_agent_skills` with the\s+task and compact concept hints/u);
  assert.match(workerSkill, /Reserve\s+`list_agent_skills` for explicit\s+catalog inventory/u);
  for (const instruction of [
    workerSkillNormalized,
    catalogSkillNormalized,
  ]) {
    assert.match(
      instruction,
      /(?:call|вызови) `get_agent_skill` (?:once|один раз)/u,
    );
    assert.match(
      instruction,
      /(?:do not repeat|не повторяй)[^.]+(?:before each|перед каждым) subcommand/iu,
    );
    assert.match(instruction, /AGENT_SKILL_RELEASE_CHANGED/u);
  }
  assert.match(
    AGENT_WORKSPACE_RUNTIME_AGENTS_MARKDOWN,
    /внешний skill\/runtime, Agent Secrets и каждый proposal flow имеют отдельные references/u,
  );
  assert.match(
    catalogSkillNormalized,
    /successful response already satisfies the fresh-read requirement/u,
  );
  assert.match(
    catalogSkillNormalized,
    /Do not repeat `get_agent_skill` immediately/u,
  );
  assert.match(workerSkill, /exact `runtimeExecution` or\s+`remoteMcpExecution`/u);
  assert.match(workerSkill, /do not bypass a usable route/u);
  assert.match(workerSkill, /reports\s+`setup_required`, `no_access`, or `needs_reconnect`/u);
  assert.match(
    workerSkill,
    /say that it is currently\s+unavailable, name the required action/u,
  );
  assert.match(workerSkill, /another source is allowed only after the user sees\s+the blocker and explicitly chooses it/u);
  assert.match(workerSkill, /When relevant catalog items return `integrationRouting`/u);
  assert.match(workerSkill, /never infer a route from skill IDs, titles, catalog order, prior use/u);
  assert.match(workerSkill, /exact returned `role`,\s+`primarySkillId`, `selectionRule`, and `priority` semantics/u);
  assert.match(workerSkill, /exact `fallbackSkillId`/u);
  assert.match(workerSkill, /its\s+own `fallbackWhen`/u);
  assert.match(workerSkill, /`ambiguousMutationFallback: forbidden` do not permit fallback or automatic\s+retry/u);
  assert.match(workerSkill, /Native Trelio reads,\s+discovery, and Agent Workspace control-plane work do not use this gate/u);
  assert.match(workerSkill, /use the external Agent Skill catalog\s+for native Trelio control-plane work/u);
  assert.match(catalogSkill, /primary workspace\s+workflow, not a fallback from this catalog/);
  assert.match(workerSkill, /On `AGENT_SKILL_RELEASE_CHANGED`, read the selected skill once again/u);
  assert.match(workerSkill, /durable rule identified by\s+the agent/);
  assert.match(workerSkill, /Call\s+`get_agent_instructions` to read current scoped and inherited rules/);
  assert.match(workerSkill, /exact diff with `plan_agent_instructions_update`/);
  assert.match(workerSkill, /Call `publish_my_agent_profile` or\s+`publish_agent_instructions` only after explicit confirmation/);
  assert.match(workerSkill, /never place instructions in\s+`WORKSPACE_CONTEXT\.md`/);
  assert.match(workerSkill, /applies only to future Runs/);
  assert.match(workerSkill, /Before drafting a durable rule, identify every scenario whose behavior it\s+would govern/u);
  assert.match(workerSkill, /read each matching\s+reference completely/u);
  assert.match(workerSkill, /must preserve the `task-run\.md` limit/u);
  assert.match(workerSkill, /Call `prepare_agent_workspace_run` once/u);
  assert.match(workerSkill, /TRELIO_BRIDGE_PAIRING_REQUIRED/);
  assert.match(workerSkill, /After exchange, briefly report that the device\s+is connected and continue/);
  assert.match(workerSkill, /never gains\s+`mcp:agent-instructions:manage`/);
  assert.match(workerSkill, /Do not start another\s+OAuth flow/);
  assert.match(catalogSkill, /For an ordinary task, call `search_agent_skills` once/u);
  assert.match(catalogSkill, /Use `list_agent_skills` only when the user explicitly asks for the whole catalog/u);
  assert.match(catalogSkill, /Do not call `request_plugin_install`/u);
  assert.match(catalogSkill, /personal skill or connector remains allowed/u);
  assert.match(catalogSkill, /do not silently turn absence of readiness into permission to choose another\s+source/u);
  assert.match(catalogSkill, /project-scoped response already contains the additive union/);
  assert.match(catalogSkill, /When `runtimeExecution` is present, invoke its exact `command`/);
  assert.match(catalogSkill, /bridge may cache verified package bytes by digest/);
  assert.match(catalogSkill, /When relevant catalog items return `integrationRouting`/u);
  assert.match(catalogSkill, /never infer precedence from skill IDs, titles, array order/u);
  assert.match(catalogSkill, /exact\s+returned `role`, `primarySkillId`, `selectionRule`, and `priority` semantics/u);
  assert.match(catalogSkill, /exact `fallbackSkillId`/u);
  assert.match(catalogSkill, /its own `fallbackWhen`/u);
  assert.match(catalogSkill, /`ambiguousMutationFallback: forbidden` never authorize fallback or automatic\s+retry/u);
  assert.match(catalogSkill, /current skill instruction requires a content-free `doctor` or auth probe/u);
  assert.match(catalogSkill, /runtime-owned local credential cache/u);
  assert.match(catalogSkill, /Do not infer the exception from a skill ID/u);
});

test("bridge adds its release version and bearer credential to every API request", () => {
  const headers = buildBridgeRequestHeaders("oauth-token", { accept: "application/json" });
  assert.equal(headers.get("x-trelio-agent-workspaces-version"), BRIDGE_VERSION);
  assert.equal(headers.get("x-trelio-agent-skill-device-consent"), "v1");
  assert.equal(headers.get("x-trelio-company-skill-e2ee"), "v1");
  assert.equal(headers.get("authorization"), "Bearer oauth-token");
  assert.equal(headers.get("accept"), "application/json");
});

test("skill package host exposes the synchronized 64 MiB package contract", async () => {
  assert.equal(AGENT_SKILL_RUNTIME_HOST_MINIMUM_VERSION, "1.4.0");
  assert.equal(AGENT_SKILL_LARGE_PACKAGE_HOST_MINIMUM_VERSION, "1.14.4");
  assert.equal(AGENT_SKILL_LEGACY_MAX_PACKAGE_BYTES, 8 * 1024 * 1024);
  assert.equal(AGENT_SKILL_MAX_PACKAGE_BYTES, 64 * 1024 * 1024);
  assert.equal(AGENT_SKILL_MAX_ENCRYPTED_PACKAGE_BYTES, 65 * 1024 * 1024);
  assert.equal(AGENT_SKILL_MAX_DECODED_FILE_BYTES, 48 * 1024 * 1024);
  assert.equal(AGENT_SKILL_MAX_FILE_COUNT, 100);

  await assert.rejects(
    readBoundedResponseBuffer(
      new Response(Buffer.from("oversized", "utf8")),
      4,
      "Test runtime package",
    ),
    /превышает допустимый размер 4 байт/u,
  );
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

const buildConnectionFreeRuntimeResolutionPayload = () => {
  const companyId = "99999999-9999-4999-8999-999999999999";
  const memberId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const releaseId = "77777777-7777-4777-8777-777777777777";
  const artifactId = "88888888-8888-4888-8888-888888888888";
  const skillId = "connection-free-runtime";
  return {
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
    trust: {
      level: "platform_verified",
      artifactLevel: "platform_verified",
      requiresDeviceConsent: false,
      consentId: null,
    },
    packageUrl: `/api/agent-skills/runtime/package?artifactId=${artifactId}`,
  };
};

test("connection-free skill runtime receives member identity without synthetic connection authority", () => {
  const payload = buildConnectionFreeRuntimeResolutionPayload();
  const { companyId, memberId, skillId } = payload.localIdentity;
  const { releaseId } = payload;
  const artifactId = payload.artifact.id;

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
      HOME: "/trusted/home",
      HTTPS_PROXY: "http://127.0.0.1:3128",
      LC_CTYPE: "en_US.UTF-8",
      LD_PRELOAD: "/workspace/hostile-loader.so",
      DYLD_INSERT_LIBRARIES: "/workspace/hostile-loader.dylib",
      NODE_OPTIONS: "--require=/workspace/hostile-node.cjs",
      NODE_PATH: "/workspace/node_modules",
      PYTHONPATH: "/workspace/python",
      SSLKEYLOGFILE: "/workspace/tls-keys.log",
      AWS_SECRET_ACCESS_KEY: "must-not-reach-skill",
      TRELIO_SKILL_PROJECT_ID: "stale-project",
      TRELIO_SKILL_CONNECTION_ID: "stale-connection",
      TRELIO_SKILL_CONNECTION_CONFIG_JSON: "stale-config",
    },
  });

  assert.equal(environment.SAFE_PARENT_VALUE, undefined);
  assert.equal(environment.HOME, "/trusted/home");
  assert.equal(environment.HTTPS_PROXY, "http://127.0.0.1:3128");
  assert.equal(environment.LC_CTYPE, "en_US.UTF-8");
  for (const rejectedKey of [
    "LD_PRELOAD",
    "DYLD_INSERT_LIBRARIES",
    "NODE_OPTIONS",
    "NODE_PATH",
    "PYTHONPATH",
    "SSLKEYLOGFILE",
    "AWS_SECRET_ACCESS_KEY",
  ]) {
    assert.equal(environment[rejectedKey], undefined);
  }
  assert.equal(environment.TRELIO_SKILL_COMPANY_ID, companyId);
  assert.equal(environment.TRELIO_SKILL_MEMBER_ID, memberId);
  assert.equal(environment.TRELIO_SKILL_CONNECTION_ID, undefined);
  assert.equal(environment.TRELIO_SKILL_CONNECTION_CONFIG_JSON, undefined);
  assert.equal(environment.TRELIO_SKILL_PROJECT_ID, undefined);

  for (const forbiddenGrantName of [
    "TRELIO_SKILL_COMPANY_ID",
    "NODE_OPTIONS",
    "HOME",
    "BASH_ENV",
  ]) {
    assert.throws(
      () => buildAgentSkillRuntimeEnvironment({
        artifact: resolution.artifact,
        runtimeDirectory: "/verified/runtime",
        executionContext: {
          companyId,
          projectId: null,
          releaseId,
          localIdentity: resolution.localIdentity,
          companyConnection: resolution.companyConnection,
        },
        grantedEnvironment: {
          [forbiddenGrantName]: "forged-host-context",
        },
      }),
      /небезопасное runtime env binding/u,
    );
  }
  assert.throws(
    () => buildAgentSkillRuntimeEnvironment({
      artifact: resolution.artifact,
      runtimeDirectory: "/verified/runtime",
      executionContext: {
        companyId,
        projectId: null,
        releaseId,
        localIdentity: resolution.localIdentity,
        companyConnection: resolution.companyConnection,
      },
      grantedEnvironment: {
        TRELIO_FIRST_SECRET: "one",
        TRELIO_SECOND_SECRET: "two",
      },
    }),
    /только одно exact значение/u,
  );

  assert.throws(
    () => normalizeResolvedSkillRuntimeArtifact({
      ...payload,
      localIdentity: { ...payload.localIdentity, connectionId: artifactId },
    }),
    /некорректную runtime resolution/u,
  );
});

test("skill runtime resolution fails closed on missing or contradictory trust", () => {
  const payload = buildConnectionFreeRuntimeResolutionPayload();

  assert.throws(
    () => normalizeResolvedSkillRuntimeArtifact({
      ...payload,
      trust: undefined,
    }),
    /некорректную runtime resolution/u,
  );
  assert.throws(
    () => normalizeResolvedSkillRuntimeArtifact({
      ...payload,
      trust: {
        level: "platform_verified",
        artifactLevel: "company_unverified",
        requiresDeviceConsent: false,
        consentId: null,
      },
    }),
    /некорректную runtime resolution/u,
  );

  // A company publication may intentionally reuse platform-verified bytes,
  // but the new publication still needs its own exact device consent.
  const consentId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  const companyPublication = normalizeResolvedSkillRuntimeArtifact({
    ...payload,
    trust: {
      level: "company_unverified",
      artifactLevel: "platform_verified",
      requiresDeviceConsent: true,
      consentId,
    },
  });
  assert.equal(companyPublication.trust.consentId, consentId);
});

test("encrypted runtime resolution requires exact company and manifest bindings", () => {
  const payload = buildConnectionFreeRuntimeResolutionPayload();
  const encryptedManifestEntityId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  const consentId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
  const encryptedPayload = {
    ...payload,
    company: {
      id: payload.localIdentity.companyId,
      slug: "encrypted-company",
      name: "Encrypted Company",
    },
    encryptedManifestEntityId,
    artifact: {
      ...payload.artifact,
      packageFormat: "trelio-company-encrypted-skill-package/v1",
      contentProtection: "company_e2ee_v1",
      manifest: {
        format: "trelio-agent-skill-package/v1",
        skill: { id: payload.artifact.skillId, runtimeVersion: "1.0.0" },
        entrypoint: { path: "runtime.mjs", interpreter: "node" },
        capabilities: [],
        files: [],
      },
    },
    trust: {
      level: "company_unverified",
      artifactLevel: "company_unverified",
      requiresDeviceConsent: true,
      consentId,
    },
  };

  const resolution = normalizeResolvedSkillRuntimeArtifact(encryptedPayload);
  assert.equal(resolution.artifact.contentProtection, "company_e2ee_v1");
  assert.equal(resolution.artifact.encryptedManifestEntityId, encryptedManifestEntityId);
  assert.equal(resolution.company.slug, "encrypted-company");

  const pendingPayload = {
    ...encryptedPayload,
    consentChallenge: buildCompanyRuntimeConsentChallenge(),
    trust: { ...encryptedPayload.trust, consentId: null },
  };
  assert.throws(
    () => normalizeResolvedSkillRuntimeArtifact(pendingPayload),
    /некорректную runtime resolution/u,
  );
  assert.equal(
    normalizeResolvedSkillRuntimeArtifact(
      pendingPayload,
      { allowPendingEncryptedConsent: true },
    ).trust.consentId,
    null,
  );

  assert.throws(
    () => normalizeResolvedSkillRuntimeArtifact({
      ...encryptedPayload,
      company: { ...encryptedPayload.company, id: consentId },
    }),
    /некорректную runtime resolution/u,
  );
  assert.throws(
    () => normalizeResolvedSkillRuntimeArtifact({
      ...encryptedPayload,
      encryptedManifestEntityId: null,
    }),
    /некорректную runtime resolution/u,
  );
});

test("skill host environment allowlist strips pre-runtime injection and ambient secrets", () => {
  const environment = sanitizeAgentSkillInheritedEnvironment({
    PATH: "/usr/bin:/bin",
    TRELIO_CONFIG_HOME: "/private/config",
    XDG_CACHE_HOME: "/private/cache",
    DISPLAY: ":1",
    WAYLAND_DISPLAY: "wayland-1",
    XAUTHORITY: "/run/user/1000/xauth",
    DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
    XDG_RUNTIME_DIR: "/run/user/1000",
    http_proxy: "http://127.0.0.1:8080",
    LD_AUDIT: "/workspace/audit.so",
    DYLD_LIBRARY_PATH: "/workspace/libraries",
    GCONV_PATH: "/workspace/gconv",
    OPENSSL_CONF: "/workspace/openssl.cnf",
    NODE_EXTRA_CA_CERTS: "/workspace/ca.pem",
    BASH_ENV: "/workspace/bash-env",
    GITHUB_TOKEN: "must-not-reach-skill",
    TRELIO_SKILL_COMPANY_ID: "stale-company",
  });

  assert.equal(environment.TRELIO_CONFIG_HOME, "/private/config");
  assert.equal(environment.XDG_CACHE_HOME, "/private/cache");
  assert.equal(environment.DISPLAY, ":1");
  assert.equal(environment.WAYLAND_DISPLAY, "wayland-1");
  assert.equal(environment.XAUTHORITY, "/run/user/1000/xauth");
  assert.equal(environment.DBUS_SESSION_BUS_ADDRESS, "unix:path=/run/user/1000/bus");
  assert.equal(environment.XDG_RUNTIME_DIR, "/run/user/1000");
  assert.equal(environment.http_proxy, "http://127.0.0.1:8080");
  assert.equal(environment.PATH, buildAgentSkillRuntimePath({}));
  assert.doesNotMatch(environment.PATH, /workspace/u);
  assert.equal(environment.PYTHONNOUSERSITE, "1");
  assert.equal(environment.PYTHONSAFEPATH, "1");
  assert.equal(environment.PYTHONDONTWRITEBYTECODE, "1");
});

test("skill host ignores a PATH python hijack and runs Python entrypoints in isolated mode", async () => {
  const temporaryDirectory = await mkdtemp(
    path.join(os.tmpdir(), "trelio-python-runtime-isolation-test-"),
  );
  const hostileBin = path.join(temporaryDirectory, "hostile-bin");
  const runtimeDirectory = path.join(temporaryDirectory, "runtime");
  const homeDirectory = path.join(temporaryDirectory, "home");
  const hostileMarker = path.join(temporaryDirectory, "path-hijack-ran");
  const userSiteMarker = path.join(temporaryDirectory, "user-site-ran");
  const resultFile = path.join(temporaryDirectory, "result.txt");
  try {
    await Promise.all([
      mkdir(hostileBin, { recursive: true }),
      mkdir(runtimeDirectory, { recursive: true }),
      mkdir(homeDirectory, { recursive: true }),
    ]);
    const hostilePython = path.join(hostileBin, process.platform === "win32" ? "python3.cmd" : "python3");
    await writeFile(
      hostilePython,
      process.platform === "win32"
        ? `@echo off\r\necho bad>"${hostileMarker}"\r\n`
        : `#!/bin/sh\nprintf bad > '${hostileMarker}'\n`,
    );
    if (process.platform !== "win32") await chmod(hostilePython, 0o755);

    const python = await resolveTrustedPythonInvocation({
      runtimeDirectory,
      environment: {
        ...process.env,
        HOME: homeDirectory,
        PATH: `${hostileBin}${path.delimiter}${process.env.PATH || ""}`,
      },
    });
    assert.equal(path.isAbsolute(python.executable), true);
    assert.notEqual(python.executable, hostilePython);
    assert.equal(await stat(hostileMarker).catch(() => null), null);

    const sanitizedEnvironment = sanitizeAgentSkillInheritedEnvironment({
      ...process.env,
      HOME: homeDirectory,
      PATH: `${hostileBin}${path.delimiter}${process.env.PATH || ""}`,
    });
    const { stdout: userSitePathOutput } = await execFileAsync(
      python.executable,
      [...python.argsPrefix, "-I", "-B", "-c", "import site;print(site.getusersitepackages())"],
      { env: sanitizedEnvironment, encoding: "utf8" },
    );
    const userSiteDirectory = String(userSitePathOutput || "").trim();
    await mkdir(userSiteDirectory, { recursive: true });
    await writeFile(
      path.join(userSiteDirectory, "trelio-hostile-user-site.pth"),
      `import pathlib;pathlib.Path(${JSON.stringify(userSiteMarker)}).write_text('bad')\n`,
    );
    await writeFile(path.join(runtimeDirectory, "helper.py"), "VALUE = 'signed-sibling-import'\n");
    const entrypointPath = path.join(runtimeDirectory, "main.py");
    await writeFile(
      entrypointPath,
      "import pathlib,sys\nfrom helper import VALUE\npathlib.Path(sys.argv[1]).write_text(VALUE)\n",
    );

    await execFileAsync(
      python.executable,
      buildIsolatedPythonRuntimeArguments({
        argsPrefix: python.argsPrefix,
        runtimeDirectory,
        entrypointPath,
        runtimeArguments: [resultFile],
      }),
      {
        cwd: runtimeDirectory,
        env: sanitizedEnvironment,
        encoding: "utf8",
      },
    );
    assert.equal(await readFile(resultFile, "utf8"), "signed-sibling-import");
    assert.equal(await stat(userSiteMarker).catch(() => null), null);
    assert.equal(await stat(hostileMarker).catch(() => null), null);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
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
  const runtimeArgv = [
    "--runtime-client",
    "codex",
    "--runtime-model",
    "gpt-5.6-sol",
    "--runtime-effort",
    "high",
    "--runtime-observed-at",
    "2026-08-19T12:34:56.000Z",
  ];
  const deliveredFilePathLog = path.join(temporaryDirectory, "delivered-file-path.txt");
  const runId = "66666666-6666-4666-8666-666666666666";
  const grantIds = {
    env: "11111111-1111-4111-8111-111111111111",
    file: "22222222-2222-4222-8222-222222222222",
    stdin: "33333333-3333-4333-8333-333333333333",
  };
  const secretValues = {
    env: "one-use-env-secret",
    file: "one-use-file-secret",
    stdin: "one-use-stdin-secret",
  };
  let resolveCount = 0;
  let packageDownloadCount = 0;
  const consumedGrants = [];
  let serverError = null;

  await mkdir(sourceDirectory, { recursive: true });
  await writeFile(
    path.join(sourceDirectory, "main.mjs"),
    [
      'import { readFile, writeFile } from "node:fs/promises";',
      'let stdinValue = "";',
      'if (process.argv.includes("--read-stdin")) { for await (const chunk of process.stdin) stdinValue += chunk; }',
      `const envGrant = process.env.DEPLOY_TOKEN === ${JSON.stringify(secretValues.env)};`,
      `const fileGrant = process.env.TRELIO_SECRET_FILE ? (await readFile(process.env.TRELIO_SECRET_FILE, "utf8")) === ${JSON.stringify(secretValues.file)} : false;`,
      `if (process.env.TRELIO_SECRET_FILE) await writeFile(${JSON.stringify(deliveredFilePathLog)}, process.env.TRELIO_SECRET_FILE, "utf8");`,
      `const stdinGrant = stdinValue === ${JSON.stringify(secretValues.stdin)};`,
      "process.stdout.write(`runtime:${process.argv.slice(2).join(',')}:${process.env.TRELIO_SKILL_RELEASE_ID}:${process.env.TRELIO_SKILL_MEMBER_ID}:${process.env.TRELIO_SKILL_CONNECTION_ID}:${process.env.TRELIO_SKILL_CONNECTION_CONFIG_JSON}:project=${process.env.TRELIO_SKILL_PROJECT_ID || 'none'}:grants=${envGrant},${fileGrant},${stdinGrant}\\n`);",
      "",
    ].join("\n"),
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
        && request.url === "/api/agent-workspaces/runtime-policy/admissions"
      ) {
        const body = JSON.parse((await readRequestBody(request)).toString("utf8"));
        assert.equal(body.companyId, companyId);
        assert.deepEqual(body.runtimeAttestation, {
          schemaVersion: 1,
          clientFamily: "codex",
          modelId: "gpt-5.6-sol",
          effortLevel: "high",
          evidenceLevel: "self_reported",
          source: "agent_request",
          observedAt: "2026-08-19T12:34:56.000Z",
        });
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({
          schemaVersion: 1,
          company: { id: companyId, slug: "integration-company" },
          runtimePolicySnapshot: {
            schemaVersion: 1,
            revision: null,
            policy: { schemaVersion: 1, mode: "disabled" },
          },
          evaluation: {
            satisfied: true,
            enforced: false,
            reasonCode: "POLICY_DISABLED",
          },
        }));
        return;
      }

      const grantEntry = Object.entries(grantIds).find(([, grantId]) => (
        request.method === "POST"
        && request.url === `/api/agent-secrets/checkout-grants/${grantId}/consume`
      ));
      if (grantEntry) {
        const [deliveryMode, grantId] = grantEntry;
        assert.deepEqual(
          JSON.parse((await readRequestBody(request)).toString("utf8")),
          { runId },
        );
        consumedGrants.push(grantId);
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({
          runId,
          executable: "trelio-workspace",
          deliveryMode,
          environmentVariable: deliveryMode === "env" ? "DEPLOY_TOKEN" : null,
          value: secretValues[deliveryMode],
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
          trust: {
            level: "platform_verified",
            artifactLevel: "platform_verified",
            requiresDeviceConsent: false,
            consentId: null,
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
    const runRoot = path.join(temporaryDirectory, "run");
    const runWorkspace = path.join(runRoot, "workspace");
    await Promise.all([
      mkdir(homeDirectory, { recursive: true }),
      mkdir(runWorkspace, { recursive: true }),
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
      path.join(runRoot, ".trelio-run.json"),
      `${JSON.stringify({ schemaVersion: 3, origin, runId }, null, 2)}\n`,
      "utf8",
    );
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
        ...runtimeArgv,
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
          // Even an exact-looking ambient secret is not a consumed grant and
          // must remain absent from an ordinary skill invocation.
          DEPLOY_TOKEN: secretValues.env,
        },
      },
    );
    const runWithGrant = (deliveryMode) => execFileAsync(
      process.execPath,
      [
        bridgePath,
        "secret",
        "exec",
        "--origin",
        origin,
        "--grant",
        grantIds[deliveryMode],
        "--",
        "trelio-workspace",
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
        ...runtimeArgv,
        "--",
        "--message",
        deliveryMode,
        ...(deliveryMode === "stdin" ? ["--read-stdin"] : []),
      ],
      {
        cwd: runWorkspace,
        encoding: "utf8",
        timeout: 10_000,
        env: {
          ...process.env,
          HOME: homeDirectory,
          XDG_CACHE_HOME: path.join(homeDirectory, ".cache"),
          TRELIO_WORKSPACE_DISABLE_KEYCHAIN: "1",
        },
      },
    );

    const firstRun = await runSkill();
    const secondRun = await runSkill();
    const expectedRuntimeOutput = `runtime:--message,hello:${releaseId}:${memberId}:${connectionId}:{"schemaVersion":1,"baseUrl":"https://example.test/"}:project=none:grants=false,false,false`;
    assert.match(firstRun.stdout, new RegExp(expectedRuntimeOutput.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&")));
    assert.match(secondRun.stdout, new RegExp(expectedRuntimeOutput.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&")));
    assert.equal(resolveCount, 2, "every invocation must resolve the current release");
    assert.equal(packageDownloadCount, 1, "second invocation must use verified cache");

    for (const deliveryMode of ["env", "file", "stdin"]) {
      const grantedRun = await runWithGrant(deliveryMode);
      const expectedGrantTuple = {
        env: "true,false,false",
        file: "false,true,false",
        stdin: "false,false,true",
      }[deliveryMode];
      assert.match(grantedRun.stdout, new RegExp(
        `runtime:--message,${deliveryMode}[^\\n]*:grants=${expectedGrantTuple}`,
      ));
      for (const secretValue of Object.values(secretValues)) {
        assert.doesNotMatch(grantedRun.stdout, new RegExp(secretValue, "u"));
        assert.doesNotMatch(grantedRun.stderr, new RegExp(secretValue, "u"));
      }
    }
    assert.deepEqual(consumedGrants, [grantIds.env, grantIds.file, grantIds.stdin]);
    const deliveredFilePath = await readFile(deliveredFilePathLog, "utf8");
    assert.equal(await stat(deliveredFilePath).catch(() => null), null);
    assert.equal(await stat(path.dirname(deliveredFilePath)).catch(() => null), null);

    const postGrantRun = await runSkill();
    assert.match(postGrantRun.stdout, new RegExp(expectedRuntimeOutput.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&")));

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
    assert.equal(resolveCount, 7);
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

test("bridge finish checkpoints and submits an external object without hanging", {
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
  let handoffPayload = null;
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

      if (request.url?.endsWith("/checkpoints")) {
        handoffPayload = JSON.parse(body.toString("utf8"));
        assert.equal(handoffPayload.checkpointType, "handoff");
        assert.match(handoffPayload.summary, /external object/u);
        assert.deepEqual(handoffPayload.evidence, ["Проверена передача binary pointer."]);
        assert.deepEqual(handoffPayload.filesChanged, ["sources/archive.bin"]);
        assert.equal(
          handoffPayload.nextAction.instruction,
          "Проверьте принятый материал.",
        );
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({
          id: "99999999-9999-4999-8999-999999999999",
          checkpointType: "handoff",
          createdAt: new Date().toISOString(),
        }));
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
        scopeType: "project",
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
      [
        bridgePath,
        "finish",
        "--summary",
        "Подготовлен и проверен external object для приёмки.",
        "--evidence",
        "Проверена передача binary pointer.",
        "--file",
        "sources/archive.bin",
        "--next-action",
        "Проверьте принятый материал.",
      ],
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
    assert.match(submitted.stdout, /Проверены изменённые пути/u);
    assert.match(submitted.stdout, /Checkpoint сохранён/u);
    assert.ok(handoffPayload);
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

test("bridge inspects an accepted Workspace read-only without creating an Agent Run", async () => {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "trelio-workspace-inspect-"));
  const homeDirectory = path.join(temporaryDirectory, "home");
  const workspaceId = "44444444-4444-4444-8444-444444444444";
  const rulesRevisionId = "55555555-5555-4555-8555-555555555555";
  const profileRevisionId = "66666666-6666-4666-8666-666666666666";
  const rulesMarkdown = "# Рабочие правила\n\nСначала прочитай принятые материалы.\n";
  const rulesSha256 = createHash("sha256").update(rulesMarkdown, "utf8").digest("hex");
  const accepted = await createExportBundle(path.join(temporaryDirectory, "accepted"), {
    "WORKSPACE_CONTEXT.md": "# Задача №56\n\nПроверенный контекст Workspace.\n",
    "artifacts/result.md": "# Результат\n\nПринятый материал.\n",
  });
  const requests = [];
  let serverError = null;
  const server = createServer(async (request, response) => {
    try {
      requests.push({ method: request.method, url: request.url });
      assert.equal(request.headers.authorization, "Bearer integration-token");
      assert.equal(request.headers["x-trelio-agent-workspaces-version"], BRIDGE_VERSION);

      if (request.url === "/api/agent-workspaces/bridge-compatibility") {
        response.setHeader("content-type", "application/json");
        const rulesAreCurrent = (
          request.headers["x-trelio-agent-rules-sha256"] === rulesSha256
        );
        response.end(JSON.stringify({
          supported: true,
          minimumVersion: BRIDGE_VERSION,
          agentRules: {
            status: rulesAreCurrent ? "current" : "update_required",
            revisionId: rulesRevisionId,
            version: 1,
            sha256: rulesSha256,
            ...(rulesAreCurrent ? {} : { rulesMarkdown }),
          },
        }));
        return;
      }

      if (request.url === `/api/agent-workspaces/workspaces/${workspaceId}/read-snapshot`) {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({
          schemaVersion: 1,
          workspace: {
            id: workspaceId,
            scopeType: "task",
            scopeKey: "task:77777777-7777-4777-8777-777777777777",
            acceptedHead: accepted.head,
          },
          company: testCompany,
          encryption: { state: "plain" },
          agentInstructionsSnapshot: {
            schemaVersion: 2,
            platform: {
              revisionId: rulesRevisionId,
              version: 1,
              sha256: rulesSha256,
              rulesMarkdown,
            },
            company: null,
            project: null,
            compiledMarkdown: rulesMarkdown,
          },
          userProfileSnapshot: {
            schemaVersion: 1,
            profile: { revisionId: profileRevisionId, version: 2 },
            compiledMarkdown: "# Как агенту работать со мной\n\nПиши коротко.\n",
          },
        }));
        return;
      }

      if (request.url?.startsWith("/api/agent-workspaces/encryption/runtime?")) {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({
          suite: COMPANY_ENCRYPTION_SUITE,
          state: "plain",
          company: testCompany,
        }));
        return;
      }

      if (
        request.url
        === `/api/agent-workspaces/workspaces/${workspaceId}/bundle?head=${accepted.head}`
      ) {
        response.setHeader("content-type", "application/octet-stream");
        response.setHeader("x-trelio-accepted-head", accepted.head);
        response.end(accepted.bundle);
        return;
      }

      throw new Error(`Unexpected inspection request: ${request.method} ${request.url}`);
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

    const inspected = await execFileAsync(
      process.execPath,
      [bridgePath, "inspect", "--origin", origin, "--workspace", workspaceId],
      {
        cwd: temporaryDirectory,
        encoding: "utf8",
        timeout: 15_000,
        env: { ...process.env, HOME: homeDirectory },
      },
    );
    const inspectionRoot = path.join(
      homeDirectory,
      ".config",
      "trelio",
      "workspace-bridge",
      "workspace-inspections",
      workspaceId,
    );
    const workspaceDirectory = path.join(inspectionRoot, "workspace");
    const contextDirectory = path.join(inspectionRoot, "context");

    assert.equal(inspected.stdout.trim(), workspaceDirectory);
    assert.equal(
      await readFile(path.join(workspaceDirectory, "artifacts", "result.md"), "utf8"),
      "# Результат\n\nПринятый материал.\n",
    );
    assert.equal(
      await readFile(path.join(contextDirectory, "agent-instructions.md"), "utf8"),
      rulesMarkdown,
    );
    assert.match(
      await readFile(path.join(contextDirectory, "user-profile.md"), "utf8"),
      /Пиши коротко/u,
    );
    const index = JSON.parse(await readFile(path.join(contextDirectory, "index.json"), "utf8"));
    assert.equal(index.mode, "read_only_accepted_workspace");
    assert.equal(index.workspace.acceptedHead, accepted.head);
    assert.equal(index.agentInstructions.path, path.join(contextDirectory, "agent-instructions.md"));
    assert.equal(await pathExists(path.join(inspectionRoot, ".trelio-run.json")), false);
    assert.equal(await pathExists(path.join(workspaceDirectory, ".trelio-run.json")), false);
    if (process.platform !== "win32") {
      assert.equal((await stat(workspaceDirectory)).mode & 0o222, 0);
      assert.equal((await stat(contextDirectory)).mode & 0o222, 0);
      assert.equal((await stat(path.join(workspaceDirectory, "artifacts", "result.md"))).mode & 0o222, 0);
    }
    assert.equal(requests.some(({ method }) => method !== "GET"), false);
    assert.equal(requests.some(({ url }) => String(url).includes("/runs")), false);
    assert.ifError(serverError);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    const inspectionRoot = path.join(
      homeDirectory,
      ".config",
      "trelio",
      "workspace-bridge",
      "workspace-inspections",
      workspaceId,
    );
    if (process.platform !== "win32") {
      await execFileAsync("chmod", ["-R", "u+w", inspectionRoot]).catch(() => undefined);
    }
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test("bridge help advertises encryption setup, read-only inspection and context sync", async () => {
  const result = await execFileAsync(process.execPath, [bridgePath, "help"], { encoding: "utf8" });
  assert.match(result.stdout, new RegExp(`Bridge ${BRIDGE_VERSION.replaceAll(".", "\\.")}`));
  assert.match(result.stdout, /trelio-workspace doctor \[--json\] \[--origin URL\]/);
  assert.match(result.stdout, /trelio-workspace encryption setup --company SLUG \[--json\]/);
  assert.match(result.stdout, /trelio-workspace inspect --workspace UUID/);
  assert.match(result.stdout, /trelio-workspace context sync/);
  assert.match(result.stdout, /trelio-workspace context attach --workspace UUID/);
  assert.match(result.stdout, /trelio-workspace context fetch --path/);
  assert.match(result.stdout, /trelio-workspace clean --dry-run/);
  assert.match(result.stdout, /--format fields-json/);
});

test("read-only Workspace inspection rejects a tracked symlink", async () => {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "trelio-inspection-symlink-"));
  const repositoryDirectory = path.join(temporaryDirectory, "repository");

  try {
    await mkdir(repositoryDirectory, { recursive: true });
    await runGit(repositoryDirectory, ["init", "--initial-branch=main"]);
    await writeFile(path.join(temporaryDirectory, "outside.txt"), "outside\n", "utf8");
    await symlink("../outside.txt", path.join(repositoryDirectory, "legacy-link.txt"));
    await runGit(repositoryDirectory, ["add", "legacy-link.txt"]);

    await assert.rejects(
      assertMaterializedWorkspaceFileTypes(repositoryDirectory),
      /неподдерживаемый тип файла: legacy-link\.txt/u,
    );
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
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
