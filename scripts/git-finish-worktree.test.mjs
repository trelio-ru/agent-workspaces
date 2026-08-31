import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPT_PATH = fileURLToPath(
  new URL("./git-finish-worktree.mjs", import.meta.url),
);

function run(command, args, { cwd, allowFailure = false, env = process.env } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && !allowFailure) {
    throw new Error(
      `${command} ${args.join(" ")} failed (${result.status}): ${result.stderr || result.stdout}`,
    );
  }
  return result;
}

function git(cwd, ...args) {
  return run("git", args, { cwd }).stdout.trim();
}

/**
 * Каждый тест работает в отдельном bare origin и двух временных checkout.
 * Поэтому destructive happy path проверяет реальное `git worktree remove`,
 * не касаясь репозитория разработчика.
 */
function createFixture(t, { mergeTask = "none", taskCommits = 1 } = {}) {
  const fixtureRoot = mkdtempSync(path.join(os.tmpdir(), "git-finish-worktree-"));
  const originPath = path.join(fixtureRoot, "origin.git");
  const mainPath = path.join(fixtureRoot, "main");
  const taskPath = path.join(fixtureRoot, "task");

  t.after(() => rmSync(fixtureRoot, { recursive: true, force: true }));

  run("git", ["init", "--bare", "--initial-branch=main", originPath]);
  run("git", ["clone", originPath, mainPath]);
  git(mainPath, "config", "user.name", "Trelio Test");
  git(mainPath, "config", "user.email", "test@trelio.invalid");
  writeFileSync(path.join(mainPath, "README.md"), "fixture\n");
  git(mainPath, "add", "README.md");
  git(mainPath, "commit", "-m", "Начальный коммит");
  git(mainPath, "push", "-u", "origin", "main");
  git(
    mainPath,
    "config",
    "--local",
    "trelioAgentWorkspaces.canonicalMainWorktree",
    realpathSync(mainPath),
  );

  const baseCommit = git(mainPath, "rev-parse", "HEAD");
  git(mainPath, "worktree", "add", "-b", "codex/test-cleanup", taskPath);
  for (let index = 1; index <= taskCommits; index += 1) {
    writeFileSync(path.join(taskPath, `task-${index}.txt`), `done ${index}\n`);
    git(taskPath, "add", `task-${index}.txt`);
    git(taskPath, "commit", "-m", `Завершить часть ${index}`);
  }

  if (mergeTask === "merge") {
    git(mainPath, "merge", "--no-ff", "codex/test-cleanup", "-m", "Влить задачу");
    git(mainPath, "push", "origin", "main");
  } else if (mergeTask === "squash") {
    git(mainPath, "merge", "--squash", "codex/test-cleanup");
    git(mainPath, "commit", "-m", "Влить задачу squash-коммитом");
    git(mainPath, "push", "origin", "main");
  }

  return {
    fixtureRoot,
    mainPath,
    taskPath,
    baseCommit,
    branchTip: git(taskPath, "rev-parse", "HEAD"),
    mergeCommit: git(mainPath, "rev-parse", "HEAD"),
  };
}

function runHelper(mainPath, taskPath, extraArgs = [], env = process.env) {
  return run(
    process.execPath,
    [SCRIPT_PATH, "--no-fetch", ...extraArgs, taskPath],
    { cwd: mainPath, allowFailure: true, env },
  );
}

function runAudit(mainPath) {
  return run(
    process.execPath,
    [SCRIPT_PATH, "--check", "--no-fetch"],
    { cwd: mainPath, allowFailure: true },
  );
}

function fakeGitHubEnvironment(fixtureRoot, pullRequest) {
  const binPath = path.join(fixtureRoot, "bin");
  const executablePath = path.join(binPath, "gh");
  mkdirSync(binPath);
  writeFileSync(
    executablePath,
    `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(JSON.stringify(pullRequest))});\n`,
  );
  chmodSync(executablePath, 0o755);
  return {
    ...process.env,
    PATH: `${binPath}${path.delimiter}${process.env.PATH || ""}`,
  };
}

function listedTaskBranch(mainPath) {
  return git(
    mainPath,
    "branch",
    "--format=%(refname:short)",
    "--list",
    "codex/test-cleanup",
  );
}

test("удаляет чистый worktree полностью влитой codex-ветки", (t) => {
  const { mainPath, taskPath } = createFixture(t, { mergeTask: "merge" });
  const result = runHelper(mainPath, taskPath);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(taskPath), false);
  assert.equal(listedTaskBranch(mainPath), "");
});

test("dry-run проверяет условия, но сохраняет worktree и ветку", (t) => {
  const { mainPath, taskPath } = createFixture(t, { mergeTask: "merge" });
  const result = runHelper(mainPath, taskPath, ["--dry-run"]);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(taskPath), true);
  assert.equal(listedTaskBranch(mainPath), "codex/test-cleanup");
});

test("отказывается удалять dirty либо ещё не влитый worktree", async (t) => {
  await t.test("dirty", (subtest) => {
    const { mainPath, taskPath } = createFixture(subtest, { mergeTask: "merge" });
    writeFileSync(path.join(taskPath, "draft.txt"), "not committed\n");
    const result = runHelper(mainPath, taskPath);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /незакоммиченные или untracked изменения/);
    assert.equal(existsSync(taskPath), true);
  });

  await t.test("unmerged", (subtest) => {
    const { mainPath, taskPath } = createFixture(subtest);
    const result = runHelper(mainPath, taskPath);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /ещё не является предком/);
    assert.equal(existsSync(taskPath), true);
  });
});

test("никогда не принимает канонический main как цель", (t) => {
  const { mainPath } = createFixture(t, { mergeTask: "merge" });
  const result = runHelper(mainPath, mainPath);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /main удалять нельзя/);
  assert.equal(existsSync(mainPath), true);
});

test("multi-commit squash требует exact merged PR и совпадающий tree", (t) => {
  const {
    fixtureRoot,
    mainPath,
    taskPath,
    baseCommit,
    branchTip,
    mergeCommit,
  } = createFixture(t, { mergeTask: "squash", taskCommits: 2 });

  const withoutPullRequest = runHelper(mainPath, taskPath);
  assert.notEqual(withoutPullRequest.status, 0);
  assert.match(withoutPullRequest.stderr, /нужен --merged-pr/);

  const env = fakeGitHubEnvironment(fixtureRoot, {
    state: "MERGED",
    mergedAt: "2026-08-31T00:00:00Z",
    baseRefName: "main",
    baseRefOid: baseCommit,
    headRefOid: branchTip,
    mergeCommit: { oid: mergeCommit },
    url: "https://github.example/owner/repository/pull/6",
  });
  const withPullRequest = runHelper(
    mainPath,
    taskPath,
    ["--merged-pr", "6"],
    env,
  );

  assert.equal(withPullRequest.status, 0, withPullRequest.stderr);
  assert.equal(existsSync(taskPath), false);
  assert.equal(listedTaskBranch(mainPath), "");
});

test("audit блокирует завершённый worktree и проходит после cleanup", (t) => {
  const { mainPath, taskPath } = createFixture(t, { mergeTask: "merge" });

  const beforeCleanup = runAudit(mainPath);
  assert.notEqual(beforeCleanup.status, 0);
  assert.match(beforeCleanup.stderr, /найдены завершённые codex\/\* worktree/);
  assert.match(beforeCleanup.stderr, /git:finish-worktree/);

  const cleanup = runHelper(mainPath, taskPath);
  assert.equal(cleanup.status, 0, cleanup.stderr);
  const afterCleanup = runAudit(mainPath);
  assert.equal(afterCleanup.status, 0, afterCleanup.stderr);
});

test("audit не принимает новую пустую task-ветку за забытый cleanup", (t) => {
  const { mainPath, taskPath } = createFixture(t, { taskCommits: 0 });
  const result = runAudit(mainPath);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(taskPath), true);
  assert.equal(listedTaskBranch(mainPath), "codex/test-cleanup");
});

test("audit сохраняет активную ветку, но обнаруживает prunable merged worktree", async (t) => {
  await t.test("active", (subtest) => {
    const { mainPath } = createFixture(subtest);
    const result = runAudit(mainPath);
    assert.equal(result.status, 0, result.stderr);
  });

  await t.test("prunable", (subtest) => {
    const { mainPath, taskPath } = createFixture(subtest, { mergeTask: "merge" });
    rmSync(taskPath, { recursive: true, force: true });
    const result = runAudit(mainPath);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /отсутствующий worktree ветки codex\/test-cleanup/);
  });
});
