#!/usr/bin/env node

import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const MAIN_BRANCH_REF = "refs/heads/main";
const REMOTE_MAIN_REF = "refs/remotes/origin/main";
const CODEX_BRANCH_PREFIX = "refs/heads/codex/";
const READ_RETRY_ATTEMPTS = 3;
const READ_RETRY_DELAY_MS = 250;
const CANONICAL_CONFIG_KEYS = [
  "trelio.canonicalMainWorktree",
  "trelioAgentWorkspaces.canonicalMainWorktree",
];
const IN_PROGRESS_MARKERS = [
  "rebase-merge",
  "rebase-apply",
  "MERGE_HEAD",
  "CHERRY_PICK_HEAD",
  "REVERT_HEAD",
  "BISECT_LOG",
];

function fail(message) {
  process.stderr.write(`Ошибка: ${message}\n`);
  process.exit(1);
}

/**
 * Запускает процесс без shell-интерполяции. Для destructive helper-а это
 * обязательная граница: путь worktree всегда остаётся одним exact argv и не
 * может превратиться в glob, подстановку команды или дополнительный ref.
 */
function runProcess(command, args, { cwd = process.cwd() } = {}) {
  return spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function processFailureDetail(result) {
  if (result.error) {
    return result.error.message;
  }
  return result.stderr.trim() || result.stdout.trim() || `код ${result.status}`;
}

function runGit(args, { cwd = process.cwd(), allowFailure = false } = {}) {
  const result = runProcess("git", args, { cwd });
  if ((result.error || result.status !== 0) && !allowFailure) {
    fail(`Git не выполнил ${args[0]}: ${processFailureDetail(result)}`);
  }
  return result;
}

function gitText(args, options) {
  return runGit(args, options).stdout.trim();
}

function wait(milliseconds) {
  // Atomics.wait даёт короткую синхронную паузу без shell `sleep` и сохраняет
  // весь retry внутри одного процесса с неизменными argv.
  const signal = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(signal, 0, 0, milliseconds);
}

/**
 * Fetch и GitHub lookup являются read-only сетевыми операциями. Три bounded
 * попытки отличают временный transport failure от доказанного Git-состояния;
 * destructive шаги после них никогда автоматически не повторяются.
 */
function runReadWithRetry(command, args, { cwd, label }) {
  let lastResult;
  for (let attempt = 1; attempt <= READ_RETRY_ATTEMPTS; attempt += 1) {
    lastResult = runProcess(command, args, { cwd });
    if (!lastResult.error && lastResult.status === 0) {
      return lastResult;
    }
    if (attempt < READ_RETRY_ATTEMPTS) {
      wait(READ_RETRY_DELAY_MS * attempt);
    }
  }
  fail(`${label} не выполнен после ${READ_RETRY_ATTEMPTS} попыток: ${processFailureDetail(lastResult)}`);
}

function exactExistingPath(rawPath, label) {
  const absolutePath = path.resolve(rawPath);
  if (!existsSync(absolutePath)) {
    fail(`${label} не существует: ${absolutePath}`);
  }
  try {
    // realpath нормализует /var и /private/var на macOS, чтобы сравнение шло
    // с exact путями, зарегистрированными самим Git.
    return realpathSync(absolutePath);
  } catch (error) {
    fail(`не удалось разрешить ${label}: ${error.message}`);
  }
}

function parseWorktrees(rawList) {
  return rawList
    .split("\0\0")
    .filter(Boolean)
    .map((rawEntry) => {
      const entry = {};
      for (const field of rawEntry.split("\0")) {
        const separatorIndex = field.indexOf(" ");
        if (separatorIndex === -1) {
          entry[field] = true;
        } else {
          entry[field.slice(0, separatorIndex)] = field.slice(separatorIndex + 1);
        }
      }
      return entry;
    });
}

function resolveRegisteredPath(entry) {
  if (!entry.worktree || !existsSync(entry.worktree)) {
    return null;
  }
  try {
    return realpathSync(entry.worktree);
  } catch {
    return null;
  }
}

function hasInProgressOperation(worktreePath, repositoryRoot) {
  return IN_PROGRESS_MARKERS.some((marker) => {
    const markerResult = runGit(
      ["-C", worktreePath, "rev-parse", "--git-path", marker],
      { cwd: repositoryRoot, allowFailure: true },
    );
    if (markerResult.status !== 0) {
      return true;
    }
    const markerPath = markerResult.stdout.trim();
    const absoluteMarkerPath = path.isAbsolute(markerPath)
      ? markerPath
      : path.resolve(worktreePath, markerPath);
    return existsSync(absoluteMarkerPath);
  });
}

function hasTaskBranchActivity(branchRef, repositoryRoot) {
  const reflog = runGit(
    ["reflog", "show", "--format=%gs", branchRef],
    { cwd: repositoryRoot, allowFailure: true },
  );
  if (reflog.status !== 0) return false;

  // Чистая только что созданная ветка может буквально указывать на
  // origin/main, но это ещё активный пустой task, а не забытый cleanup.
  // Локальный branch reflog позволяет отличить её от ветки, в которой уже был
  // commit/reset/rebase. При отсутствующем доказательстве audit сохраняет
  // worktree; exact helper по явно переданному пути остаётся доступен.
  return reflog.stdout
    .split("\n")
    .filter(Boolean)
    .some((subject) => !subject.startsWith("branch: Created from "));
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}

function printUsage() {
  process.stdout.write(
    "Использование:\n"
      + "  node scripts/git-finish-worktree.mjs [--dry-run] [--no-fetch] [--merged-pr NUMBER_OR_URL] /absolute/path/to/worktree\n"
      + "  node scripts/git-finish-worktree.mjs --check [--no-fetch]\n",
  );
}

const rawArgs = process.argv.slice(2);
if (rawArgs.includes("--help") || rawArgs.includes("-h")) {
  printUsage();
  process.exit(0);
}

let checkOnly = false;
let dryRun = false;
let skipFetch = false;
let mergedPr = null;
let targetArgument = null;

for (let index = 0; index < rawArgs.length; index += 1) {
  const argument = rawArgs[index];
  if (argument === "--check") {
    if (checkOnly) fail("--check передан больше одного раза");
    checkOnly = true;
    continue;
  }
  if (argument === "--dry-run") {
    if (dryRun) fail("--dry-run передан больше одного раза");
    dryRun = true;
    continue;
  }
  if (argument === "--no-fetch") {
    if (skipFetch) fail("--no-fetch передан больше одного раза");
    skipFetch = true;
    continue;
  }
  if (argument === "--merged-pr") {
    if (mergedPr !== null) fail("--merged-pr передан больше одного раза");
    const value = rawArgs[index + 1];
    if (!value || value.startsWith("-")) {
      fail("после --merged-pr нужен exact номер или URL pull request");
    }
    mergedPr = value;
    index += 1;
    continue;
  }
  if (argument.startsWith("-")) {
    printUsage();
    fail(`неизвестный аргумент: ${argument}`);
  }
  if (targetArgument !== null) {
    printUsage();
    fail("поддерживается только один exact путь к worktree");
  }
  targetArgument = argument;
}

if (checkOnly && (targetArgument !== null || dryRun || mergedPr !== null)) {
  fail("--check нельзя объединять с target, --dry-run или --merged-pr");
}
if (!checkOnly && targetArgument === null) {
  printUsage();
  fail("нужен один exact путь к worktree либо --check");
}
if (targetArgument !== null && !path.isAbsolute(targetArgument)) {
  fail("путь к целевому worktree должен быть абсолютным");
}

// Helper запускается только из зарегистрированного канонического main. Так он
// никогда не удаляет checkout, в котором сам агент продолжает task-работу.
const currentRoot = exactExistingPath(
  gitText(["rev-parse", "--show-toplevel"]),
  "текущий Git checkout",
);
const currentBranchRef = gitText(["symbolic-ref", "-q", "HEAD"], {
  allowFailure: true,
});
if (currentBranchRef !== MAIN_BRANCH_REF) {
  fail("команду нужно запускать из канонического checkout с веткой main");
}
if (gitText(["status", "--porcelain=v1", "--untracked-files=all"])) {
  fail("канонический checkout main содержит незакоммиченные изменения");
}

const configuredCanonicalPaths = CANONICAL_CONFIG_KEYS
  .map((key) => gitText(["config", "--local", "--get", key], { allowFailure: true }))
  .filter(Boolean)
  .map((configuredPath) => exactExistingPath(configuredPath, "канонический checkout"));
if (configuredCanonicalPaths.length === 0) {
  fail("канонический main не настроен; сначала выполните штатный git:configure-main");
}
if (configuredCanonicalPaths.some((configuredPath) => configuredPath !== currentRoot)) {
  fail("команду нужно запускать из exact зарегистрированного канонического main");
}

if (!skipFetch) {
  runReadWithRetry("git", ["fetch", "--prune", "origin"], {
    cwd: currentRoot,
    label: "fetch свежего origin перед cleanup",
  });
}
gitText(["rev-parse", "--verify", `${REMOTE_MAIN_REF}^{commit}`]);

const worktrees = parseWorktrees(
  runGit(["worktree", "list", "--porcelain", "-z"], { cwd: currentRoot }).stdout,
);
const currentEntry = worktrees.find(
  (entry) => resolveRegisteredPath(entry) === currentRoot,
);
if (!currentEntry || currentEntry.branch !== MAIN_BRANCH_REF) {
  fail("текущий checkout не зарегистрирован как канонический main worktree");
}

if (checkOnly) {
  const cleanupCandidates = [];
  for (const entry of worktrees) {
    if (!entry.branch?.startsWith(CODEX_BRANCH_PREFIX)) continue;

    const branchTipResult = runGit(
      ["rev-parse", "--verify", `${entry.branch}^{commit}`],
      { cwd: currentRoot, allowFailure: true },
    );
    if (branchTipResult.status !== 0) continue;
    const branchTip = branchTipResult.stdout.trim();
    const ancestry = runGit(
      ["merge-base", "--is-ancestor", branchTip, REMOTE_MAIN_REF],
      { cwd: currentRoot, allowFailure: true },
    );
    if (ancestry.status !== 0) continue;
    if (!hasTaskBranchActivity(entry.branch, currentRoot)) continue;

    const registeredPath = resolveRegisteredPath(entry);
    if (!registeredPath) {
      cleanupCandidates.push({ branch: entry.branch, path: null });
      continue;
    }
    const targetStatus = runGit(
      ["-C", registeredPath, "status", "--porcelain=v1", "--untracked-files=all"],
      { cwd: currentRoot, allowFailure: true },
    );
    if (targetStatus.status !== 0 || targetStatus.stdout.trim()) continue;
    if (hasInProgressOperation(registeredPath, currentRoot)) continue;

    const worktreeHead = gitText(["-C", registeredPath, "rev-parse", "HEAD"], {
      cwd: currentRoot,
    });
    if (worktreeHead !== branchTip) continue;
    cleanupCandidates.push({ branch: entry.branch, path: registeredPath });
  }

  if (cleanupCandidates.length > 0) {
    process.stderr.write(
      "Ошибка: найдены завершённые codex/* worktree, которые должны быть удалены до продолжения:\n",
    );
    for (const candidate of cleanupCandidates) {
      const branchName = candidate.branch.slice("refs/heads/".length);
      if (candidate.path) {
        process.stderr.write(
          `  ${candidate.path}\n    npm run git:finish-worktree -- ${shellQuote(candidate.path)}\n`,
        );
      } else {
        process.stderr.write(
          `  отсутствующий worktree ветки ${branchName}; выполните git worktree prune и удалите ветку только после повторной ancestry-проверки\n`,
        );
      }
    }
    process.exit(1);
  }

  process.stdout.write("Проверка пройдена: завершённых codex/* worktree не осталось\n");
  process.exit(0);
}

const targetPath = exactExistingPath(targetArgument, "целевой worktree");
if (targetPath === currentRoot) {
  fail("канонический checkout main удалять нельзя");
}

const targetEntry = worktrees.find(
  (entry) => resolveRegisteredPath(entry) === targetPath,
);
if (!targetEntry) {
  fail(`путь не является зарегистрированным worktree этого репозитория: ${targetPath}`);
}
if (!targetEntry.branch) fail("detached worktree автоматически не удаляется");
if (!targetEntry.branch.startsWith(CODEX_BRANCH_PREFIX)) {
  fail("автоматически удаляются только task-ветки codex/*");
}

const targetStatus = gitText(
  ["-C", targetPath, "status", "--porcelain=v1", "--untracked-files=all"],
  { cwd: currentRoot },
);
if (targetStatus) {
  fail("целевой worktree содержит незакоммиченные или untracked изменения");
}
if (hasInProgressOperation(targetPath, currentRoot)) {
  fail("в целевом worktree не завершена Git-операция");
}

const branchName = targetEntry.branch.slice("refs/heads/".length);
const branchTip = gitText(["rev-parse", "--verify", `${targetEntry.branch}^{commit}`], {
  cwd: currentRoot,
});
const worktreeHead = gitText(["-C", targetPath, "rev-parse", "HEAD"], {
  cwd: currentRoot,
});
if (branchTip !== worktreeHead) {
  fail("HEAD worktree не совпадает с exact tip локальной task-ветки");
}

const ancestry = runGit(
  ["merge-base", "--is-ancestor", branchTip, REMOTE_MAIN_REF],
  { cwd: currentRoot, allowFailure: true },
);
if (ancestry.status === 1) {
  if (mergedPr === null) {
    fail(
      `ветка ${branchName} ещё не является предком свежего origin/main; для squash/rebase merge нужен --merged-pr`,
    );
  }

  let pullRequest;
  try {
    pullRequest = JSON.parse(
      runReadWithRetry(
        "gh",
        [
          "pr",
          "view",
          mergedPr,
          "--json",
          "state,mergedAt,baseRefName,baseRefOid,headRefOid,mergeCommit,url",
        ],
        { cwd: currentRoot, label: `чтение merged PR ${mergedPr}` },
      ).stdout,
    );
  } catch (error) {
    fail(`GitHub CLI вернул некорректный JSON для PR ${mergedPr}: ${error.message}`);
  }

  if (pullRequest.state !== "MERGED" || !pullRequest.mergedAt) {
    fail(`pull request ${mergedPr} не подтверждён как merged`);
  }
  if (pullRequest.baseRefName !== "main") {
    fail(`pull request ${mergedPr} был направлен не в main`);
  }
  if (pullRequest.headRefOid !== branchTip) {
    fail(`head pull request ${mergedPr} не совпадает с exact tip локальной ветки`);
  }

  const mergeCommit = pullRequest.mergeCommit?.oid;
  if (!mergeCommit) fail(`для pull request ${mergedPr} отсутствует merge commit`);
  const mergedCommitAncestry = runGit(
    ["merge-base", "--is-ancestor", mergeCommit, REMOTE_MAIN_REF],
    { cwd: currentRoot, allowFailure: true },
  );
  if (mergedCommitAncestry.status !== 0) {
    fail(`merge commit pull request ${mergedPr} отсутствует в свежем origin/main`);
  }

  // Multi-commit squash не даёт '-' для каждого исходного commit в `git
  // cherry`, хотя итоговый tree совпадает буквально. Сначала принимаем это
  // более сильное доказательство; fallback patch-id нужен для rebase merge,
  // где commit SHA переписаны, но каждый exact patch присутствует в main.
  const branchTree = gitText(["rev-parse", `${branchTip}^{tree}`], { cwd: currentRoot });
  const mergeTree = gitText(["rev-parse", `${mergeCommit}^{tree}`], { cwd: currentRoot });
  if (branchTree !== mergeTree) {
    const uniqueCommitCount = Number.parseInt(
      gitText(["rev-list", "--count", `${REMOTE_MAIN_REF}..${branchTip}`], {
        cwd: currentRoot,
      }),
      10,
    );
    const cherryLines = gitText(["cherry", REMOTE_MAIN_REF, branchTip], {
      cwd: currentRoot,
    })
      .split("\n")
      .filter(Boolean);
    if (
      !Number.isSafeInteger(uniqueCommitCount)
      || uniqueCommitCount < 1
      || cherryLines.length !== uniqueCommitCount
      || cherryLines.some((line) => !line.startsWith("- "))
    ) {
      fail(
        `результат PR ${mergedPr} не совпадает с tree ветки ${branchName}, и не все commits patch-equivalent свежему origin/main`,
      );
    }
  }
} else if (ancestry.status !== 0) {
  fail(`не удалось проверить merge ветки ${branchName}: ${processFailureDetail(ancestry)}`);
}

if (dryRun) {
  process.stdout.write(
    `Проверка пройдена: можно удалить ${targetPath} и локальную ветку ${branchName}\n`,
  );
  process.exit(0);
}

// git worktree remove без --force повторно проверяет чистоту непосредственно
// перед удалением и откажется при конкурентно появившихся изменениях.
runGit(["worktree", "remove", targetPath], { cwd: currentRoot });

// update-ref удаляет только ref с уже проверенным exact SHA. Если другой
// процесс успел передвинуть ветку, compare-and-swap сохранит её.
const deleteBranch = runGit(
  ["update-ref", "-d", targetEntry.branch, branchTip],
  { cwd: currentRoot, allowFailure: true },
);
if (deleteBranch.status !== 0) {
  fail(
    `worktree удалён, но локальная ветка ${branchName} сохранена из-за конкурентного изменения: ${processFailureDetail(deleteBranch)}`,
  );
}

runGit(["worktree", "prune"], { cwd: currentRoot });
process.stdout.write(
  `Удалён worktree: ${targetPath}\nУдалена локальная ветка: ${branchName}\n`,
);
