import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ROOT, codexHookComponent, buildCodexHookComponent, prepareCodexHookDistribution, publishCodexHookDistribution } from "../scripts/build-codex-hook-component.mjs";

test("Codex main disables conventional hooks while Claude retains its own definition", async () => {
  const manifest = JSON.parse(await fs.readFile(path.join(ROOT, "plugins/trelio-agent-workspaces/.codex-plugin/plugin.json")));
  assert.deepEqual(manifest.hooks, { hooks: {} });
  const hooks = JSON.parse(await fs.readFile(path.join(ROOT, "plugins/trelio-agent-workspaces/hooks/hooks.json")));
  assert.deepEqual(Object.keys(hooks.hooks).sort(), ["PreToolUse", "SessionEnd", "SessionStart"]);
  const component = await codexHookComponent();
  const requirement = JSON.parse(await fs.readFile(path.join(ROOT, "plugins/trelio-agent-workspaces/codex-hook-component.json")));
  assert.deepEqual(component.requirement, requirement);
  const marketplace = JSON.parse(await fs.readFile(path.join(ROOT, ".agents/plugins/marketplace.json")));
  assert.deepEqual(marketplace.plugins.find(row => row.name === "trelio-agent-workspaces-hooks").source, {
    source: "git-subdir", url: "https://github.com/trelio-ru/agent-workspaces.git", path: "./plugin", ref: `hooks-v${requirement.version}`,
  });
});

test("main version, instructions and dirty shell cannot change immutable hook bytes or distribution identity", async t => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "human-hook-build-"));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const root = path.join(temporary, "source");
  await fs.mkdir(root);
  const git = args => {
    const value = spawnSync("git", ["-C", root, ...args], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    assert.equal(value.status, 0, "isolated Git fixture failed");
  };
  git(["init", "-q"]);
  const lock = JSON.parse(await fs.readFile(path.join(ROOT, "codex-hook-shell.lock.json")));
  git(["fetch", "-q", "--depth=1", ROOT, lock.revision]);
  await fs.copyFile(path.join(ROOT, "codex-hook-shell.lock.json"), path.join(root, "codex-hook-shell.lock.json"));
  await fs.mkdir(path.join(root, "components/codex-hooks"), { recursive: true });
  await fs.copyFile(path.join(ROOT, "components/codex-hooks/plugin.json"), path.join(root, "components/codex-hooks/plugin.json"));
  const before = await codexHookComponent({ root });
  const beforeDistribution = await prepareCodexHookDistribution({ root });
  await fs.mkdir(path.join(root, "plugins/trelio-agent-workspaces/scripts"), { recursive: true });
  await fs.writeFile(path.join(root, "plugins/trelio-agent-workspaces/scripts/trelio-host-runtime-loader.mjs"), "UNREVIEWED_DIRTY_CANARY");
  await fs.writeFile(path.join(root, "README.md"), "Changed main instructions");
  await fs.writeFile(path.join(root, "PLUGIN_VERSION"), "999.0.0");
  const after = await codexHookComponent({ root });
  assert.deepEqual(after.requirement, before.requirement);
  assert.deepEqual(after.files, before.files);
  assert.deepEqual(await prepareCodexHookDistribution({ root }), beforeDistribution,
    "later main releases must retain the very same immutable hook commit");
  const first = await buildCodexHookComponent({ root, outputDirectory: path.join(temporary, "one") });
  const second = await buildCodexHookComponent({ root, outputDirectory: path.join(temporary, "two") });
  for (const [name, value] of first.files) {
    assert.deepEqual(await fs.readFile(path.join(temporary, "one", name)), value.bytes);
    assert.deepEqual(await fs.readFile(path.join(temporary, "two", name)), second.files.get(name).bytes);
  }
  assert.equal(first.files.size, 11);
  assert.equal(first.files.has(".git"), false);
  assert.equal(first.files.has("skills/SKILL.md"), false);
  await assert.rejects(buildCodexHookComponent({ root, outputDirectory: path.join(temporary, "one") }), { code: "EEXIST" });
  const remote = path.join(temporary, "remote.git");
  assert.equal(spawnSync("git", ["init", "--bare", "-q", remote], {windowsHide:true}).status, 0);
  git(["remote", "add", "origin", remote]);
  assert.deepEqual(await publishCodexHookDistribution({root}), beforeDistribution);
  assert.deepEqual(await publishCodexHookDistribution({root}), beforeDistribution,
    "a repeated release observes and retains the existing identical immutable ref");
  const manifestPath = path.join(root, "components/codex-hooks/plugin.json");
  const manifest = JSON.parse(await fs.readFile(manifestPath));
  await fs.writeFile(manifestPath, JSON.stringify({ ...manifest, mcpServers: {} }));
  await assert.rejects(codexHookComponent({ root }), /Invalid immutable/);
  await fs.writeFile(manifestPath, JSON.stringify({ ...manifest, description: "Actual component change" }));
  assert.notEqual((await codexHookComponent({ root })).requirement.integritySha256, before.requirement.integritySha256);
  await assert.rejects(publishCodexHookDistribution({root}), /Invalid immutable/,
    "different executable component bytes must never replace an existing version tag");
  const componentDirectory = path.dirname(manifestPath), savedDirectory = path.join(temporary, "saved-source");
  await fs.rename(componentDirectory, savedDirectory);
  await fs.symlink(savedDirectory, componentDirectory, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(codexHookComponent({root}), /Invalid immutable/,
    "source directory links cannot introduce unreviewed files into the component");
});
