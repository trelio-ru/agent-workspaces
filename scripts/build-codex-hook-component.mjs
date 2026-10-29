import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const HOOK_PLUGIN = "trelio-agent-workspaces-hooks";
export const SHELL_FILES = Object.freeze([
  "launch-trelio-node", "launch-trelio-node.cmd", "resolve-node.ps1",
  "trelio-host-runtime-download.mjs", "trelio-host-runtime-loader.mjs",
  "trelio-host-runtime-shell.mjs", "trelio-mcp-startup-budget.mjs",
]);
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const json = value => Buffer.from(JSON.stringify(value, null, 2) + "\n");
const fail = () => { throw new Error("Invalid immutable Codex hook component"); };

async function sourceJson(root, relative) {
  let target = root;
  for (const [index, part] of relative.split("/").entries()) {
    target = path.join(target, part);
    const metadata = await fs.lstat(target);
    if (metadata.isSymbolicLink() || (index < relative.split("/").length - 1
      ? !metadata.isDirectory() : !metadata.isFile() || metadata.size > 64 * 1024)) fail();
  }
  const bytes = await fs.readFile(target);
  if (bytes.length > 64 * 1024) fail();
  return JSON.parse(bytes);
}

function git(root, args, input) {
  const result = spawnSync("git", ["-C", root, ...args], {
    input, maxBuffer: 2 * 1024 * 1024, windowsHide: true, timeout: 30_000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_PAGER: "cat" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  // Repository credentials/configuration may appear in stderr. Keep failures
  // structural and reject diagnostics even alongside a successful exit code.
  if (result.error || result.status !== 0 || result.stderr.length) fail();
  return result.stdout;
}

/** The component never reads changing shell files from the worktree. Both its
 * hook definition and all executable dependencies come from exact Git blobs.
 * A main version/README/skill update therefore cannot change native trust.
 * This is packaging of the one canonical shell, not another implementation. */
export async function codexHookComponent({ root = ROOT } = {}) {
  const lock = await sourceJson(root, "codex-hook-shell.lock.json");
  if (lock.schemaVersion !== 1 || lock.repository !== "https://github.com/trelio-ru/agent-workspaces.git"
    || Object.keys(lock).sort().join(",") !== "componentVersion,directory,repository,revision,schemaVersion"
    || !/^[a-f0-9]{40}$/u.test(lock.revision ?? "")
    || lock.directory !== "plugins/trelio-agent-workspaces/scripts"
    || !/^\d+\.\d+\.\d+$/u.test(lock.componentVersion ?? "")) fail();
  const manifest = await sourceJson(root, "components/codex-hooks/plugin.json");
  if (manifest.name !== HOOK_PLUGIN || !/^\d+\.\d+\.\d+$/u.test(manifest.version ?? "")
    || manifest.hooks !== "./hooks/hooks.json"
    || Object.keys(manifest).some(key => !["name", "version", "description", "author", "repository", "hooks"].includes(key))) fail();
  const files = new Map([
    [".gitattributes", { bytes: Buffer.from("* -text\n"), mode: 0o644 }],
    [".codex-plugin/plugin.json", { bytes: json(manifest), mode: 0o644 }],
  ]);
  const sourceFiles = [
    ...SHELL_FILES.map(name => [`scripts/${name}`, `${lock.directory}/${name}`]),
    ["hooks/hooks.json", "plugins/trelio-agent-workspaces/hooks/hooks.json"],
  ];
  for (const [target, source] of sourceFiles) {
    const entry = git(root, ["ls-tree", lock.revision, "--", source]).toString();
    const match = /^(100644|100755) blob ([a-f0-9]{40})\t([^\r\n]+)\n$/u.exec(entry);
    if (!match || match[3] !== source) fail();
    const bytes = git(root, ["cat-file", "blob", match[2]]);
    if (bytes.length > 1024 * 1024) fail();
    files.set(target, { bytes, mode: match[1] === "100755" ? 0o755 : 0o644 });
  }
  if (!files.get("scripts/trelio-host-runtime-shell.mjs").bytes.toString()
    .includes(`export const PLUGIN_VERSION = "${lock.componentVersion}";`)) fail();
  const inventory = { schemaVersion: 1, plugin: HOOK_PLUGIN, version: manifest.version, sharedShell: lock,
    files: [...files].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([name, entry]) => ({ path: name, mode: entry.mode, size: entry.bytes.length, sha256: sha256(entry.bytes) })) };
  const integrity = json(inventory);
  files.set("package-integrity.json", { bytes: integrity, mode: 0o644 });
  return { files, inventory, requirement: {
    pluginId: `${HOOK_PLUGIN}@trelio-plugins`, version: manifest.version, integritySha256: sha256(integrity),
  } };
}

export async function buildCodexHookComponent({ root = ROOT, outputDirectory }) {
  if (!path.isAbsolute(outputDirectory ?? "")) fail();
  const component = await codexHookComponent({ root });
  await fs.mkdir(outputDirectory);
  try {
    for (const [name, entry] of component.files) {
      const target = path.join(outputDirectory, name);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, entry.bytes, { flag: "wx", mode: entry.mode });
      await fs.chmod(target, entry.mode);
    }
  } catch (error) {
    await fs.rm(outputDirectory, { recursive: true, force: true });
    throw error;
  }
  return component;
}

/** Native git-subdir installs only plugin/, leaving mutable checkout metadata
 * outside Codex's hook fingerprint. The orphan commit is content-deterministic:
 * a later main release must reuse this exact ref, never mint new provenance or
 * rewrite the original tag merely because the main source/version changed. */
export async function prepareCodexHookDistribution({ root = ROOT } = {}) {
  const component = await codexHookComponent({ root });
  const nodes = new Map();
  for (const [name, entry] of component.files) {
    let node = nodes;
    for (const part of ["plugin", ...name.split("/").slice(0, -1)]) {
      if (!node.has(part)) node.set(part, new Map());
      node = node.get(part);
    }
    node.set(name.split("/").at(-1), { object: git(root, ["hash-object", "-w", "--stdin"], entry.bytes).toString().trim(), mode: entry.mode });
  }
  // Git must preserve exact nested bytes on Windows before subdir projection.
  nodes.set(".gitattributes", { object: git(root, ["hash-object", "-w", "--stdin"], Buffer.from("* -text\n")).toString().trim(), mode: 0o644 });
  const writeTree = node => git(root, ["mktree", "-z"], Buffer.from([...node].map(([name, entry]) => entry instanceof Map
    ? `040000 tree ${writeTree(entry)}\t${name}\0`
    : `${entry.mode === 0o755 ? "100755" : "100644"} blob ${entry.object}\t${name}\0`).join(""))).toString().trim();
  const tree = writeTree(nodes);
  const result = spawnSync("git", ["-C", root, "-c", "commit.gpgsign=false", "commit-tree", tree], {
    input: Buffer.from(`Trelio Codex hooks ${component.requirement.version}\n\nIntegrity: ${component.requirement.integritySha256}\n`),
    env: { ...process.env, GIT_AUTHOR_NAME: "Trelio", GIT_AUTHOR_EMAIL: "noreply@trelio.ru",
      GIT_COMMITTER_NAME: "Trelio", GIT_COMMITTER_EMAIL: "noreply@trelio.ru",
      GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z", GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z" },
    windowsHide: true, timeout: 30_000, stdio: ["pipe", "pipe", "pipe"],
  });
  if (result.error || result.status !== 0 || result.stderr.length) fail();
  return { ref: `refs/tags/hooks-v${component.requirement.version}`, commit: result.stdout.toString().trim(), tree,
    integritySha256: component.requirement.integritySha256 };
}

// Publication is an explicit release operation, never performed by build or
// check. One native push may create an absent immutable ref; a lost reply only
// permits read-back. Existing different bytes are never force-updated.
export async function publishCodexHookDistribution({ root = ROOT, requireExisting = false } = {}) {
  const prepared = await prepareCodexHookDistribution({ root });
  const observe = () => {
    const text = git(root, ["ls-remote", "--refs", "origin", prepared.ref]).toString().trim();
    if (!text) return null;
    const parts = text.split("\t");
    if (parts.length !== 2 || !/^[a-f0-9]{40}$/u.test(parts[0]) || parts[1] !== prepared.ref) fail();
    return parts[0];
  };
  const before = observe();
  if (before && before !== prepared.commit) fail();
  // A main release may only verify an already published component. Its floating
  // marketplace source must never expose hook-free main before that immutable
  // source exists; first publication belongs to the separately approved source
  // tag, whose hosted gates run before guarded main integration.
  if (requireExisting && !before) fail();
  if (!before) spawnSync("git", ["-C", root, "push", "origin", `${prepared.commit}:${prepared.ref}`], {
    windowsHide: true, timeout: 30_000, stdio: ["ignore", "ignore", "pipe"],
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_PAGER: "cat" },
  });
  if (observe() !== prepared.commit) fail();
  return prepared;
}

/** Two explicit release boundaries keep initial rollout ordered without a
 * mutable hook ref. A component-source tag can precede main integration; a
 * stable main tag can only verify that already published immutable component.
 * PR/main pushes are never publication authority. Both tag types require the
 * operator's separate release decision, as documented in the repository. */
export async function codexHookReleaseSource({ root = ROOT, environment = process.env } = {}) {
  const tag = environment.GITHUB_REF;
  if (environment.GITHUB_ACTIONS !== "true" || environment.GITHUB_REPOSITORY !== "trelio-ru/agent-workspaces") fail();
  const source = /^refs\/tags\/codex-hooks-source-v(\d+\.\d+\.\d+)$/u.exec(tag ?? "");
  const main = /^refs\/tags\/v(\d+\.\d+\.\d+)$/u.exec(tag ?? "");
  if (!source && !main) fail();
  const version = source
    ? (await codexHookComponent({ root })).requirement.version
    : (await sourceJson(root, "plugins/trelio-agent-workspaces/.codex-plugin/plugin.json")).version;
  if ((source ?? main)[1] !== version) fail();
  if (git(root, ["rev-parse", "HEAD"]).toString().trim() !== git(root, ["rev-parse", `${tag}^{commit}`]).toString().trim()) fail();
  git(root, ["merge-base", "--is-ancestor", ...(source
    ? ["refs/remotes/origin/main", "HEAD"] : ["HEAD", "refs/remotes/origin/main"])]);
  return { requireExisting: !source };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.length === 2 && args[0] === "--output") {
      const component = await buildCodexHookComponent({ outputDirectory: args[1] });
      console.log(JSON.stringify(component.requirement));
    } else if (args.length === 1 && args[0] === "--check") {
      const component = await codexHookComponent();
      const expected = JSON.parse(await fs.readFile(path.join(ROOT, "plugins/trelio-agent-workspaces/codex-hook-component.json"), "utf8"));
      if (JSON.stringify(expected) !== JSON.stringify(component.requirement)) fail();
      console.log("Codex hook component matches its immutable requirement");
    } else if (args.length === 1 && args[0] === "--publish-release") {
      console.log(JSON.stringify(await publishCodexHookDistribution(await codexHookReleaseSource())));
    } else fail();
  } catch {
    console.error("Codex hook component build/check/publication failed");
    process.exitCode = 1;
  }
}
