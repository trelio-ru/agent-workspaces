#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/git-main-guard.sh"

REPOSITORY_ROOT="${AGENT_WORKSPACES_REPOSITORY_ROOT:-$(
  git -C "${SCRIPT_DIR}/.." rev-parse --show-toplevel 2>/dev/null || true
)}"
TASK_BRANCH="${1:-}"
REQUESTED_PATH="${2:-}"
MAIN_LOCK=""
CREATED_TEMP_PATH=0

usage() {
  cat >&2 <<'EOF'
Usage: bash scripts/create-task-worktree.sh codex/<slug> [path]

Creates a separate task worktree from fresh origin/main. When path is omitted,
the worktree is created in a unique temporary directory and printed on stdout.
EOF
}

cleanup() {
  agent_workspaces_release_main_lock "${MAIN_LOCK}"

  if [[ "${CREATED_TEMP_PATH}" -eq 1 ]] \
    && [[ -n "${REQUESTED_PATH}" ]] \
    && [[ -d "${REQUESTED_PATH}" ]] \
    && [[ -z "$(
      find "${REQUESTED_PATH}" -mindepth 1 -maxdepth 1 -print -quit
    )" ]]; then
    rmdir "${REQUESTED_PATH}"
  fi
}
trap cleanup EXIT

if [[ "$#" -lt 1 ]] || [[ "$#" -gt 2 ]]; then
  usage
  exit 2
fi

if [[ -z "${REPOSITORY_ROOT}" ]]; then
  agent_workspaces_git_guard_log \
    "ERROR: run this command from a configured Agent Workspaces Git worktree."
  exit 1
fi

if [[ ! "${TASK_BRANCH}" =~ ^codex/[a-z0-9][a-z0-9._-]*$ ]]; then
  agent_workspaces_git_guard_log \
    "ERROR: task branch must use exact lowercase codex/<slug> form."
  exit 2
fi

CANONICAL_ROOT="$(
  agent_workspaces_canonical_main_worktree "${REPOSITORY_ROOT}"
)"
MAIN_LOCK="$(
  agent_workspaces_acquire_main_lock \
    "${REPOSITORY_ROOT}" \
    "create ${TASK_BRANCH}"
)"

agent_workspaces_assert_clean_worktree \
  "${CANONICAL_ROOT}" \
  "Canonical main worktree"

agent_workspaces_run_read_with_retry \
  "Fetch origin before task worktree creation" \
  git -C "${CANONICAL_ROOT}" fetch --prune origin

if ! git -C "${CANONICAL_ROOT}" merge-base --is-ancestor \
  HEAD refs/remotes/origin/main; then
  agent_workspaces_git_guard_log \
    "ERROR: canonical main diverged from origin/main; refusing task worktree creation."
  exit 1
fi

git -C "${CANONICAL_ROOT}" merge --ff-only refs/remotes/origin/main
ORIGIN_MAIN_SHA="$(
  git -C "${CANONICAL_ROOT}" rev-parse refs/remotes/origin/main
)"
agent_workspaces_verify_canonical_main \
  "${CANONICAL_ROOT}" \
  "${ORIGIN_MAIN_SHA}" \
  origin

# Не начинаем следующую задачу поверх забытого cleanup. Audit блокирует только
# clean codex/* worktree, уже достижимые из свежего origin/main; активные,
# dirty и реально невлитые ветки остаются нетронутыми.
(
  cd "${CANONICAL_ROOT}"
  node scripts/git-finish-worktree.mjs --check --no-fetch
)

if git -C "${CANONICAL_ROOT}" show-ref --verify --quiet \
  "refs/heads/${TASK_BRANCH}"; then
  agent_workspaces_git_guard_log \
    "ERROR: local branch already exists: ${TASK_BRANCH}"
  exit 1
fi

if [[ -z "${REQUESTED_PATH}" ]]; then
  SAFE_BRANCH_NAME="${TASK_BRANCH#codex/}"
  REQUESTED_PATH="$(
    mktemp -d "${TMPDIR:-/tmp}/agent-workspaces-${SAFE_BRANCH_NAME}.XXXXXX"
  )"
  CREATED_TEMP_PATH=1
elif [[ -e "${REQUESTED_PATH}" ]] && [[ ! -d "${REQUESTED_PATH}" ]]; then
  agent_workspaces_git_guard_log \
    "ERROR: requested worktree path is not a directory: ${REQUESTED_PATH}"
  exit 1
elif [[ -d "${REQUESTED_PATH}" ]] \
  && [[ -n "$(
    find "${REQUESTED_PATH}" -mindepth 1 -maxdepth 1 -print -quit
  )" ]]; then
  agent_workspaces_git_guard_log \
    "ERROR: requested worktree directory is not empty: ${REQUESTED_PATH}"
  exit 1
fi

git -C "${CANONICAL_ROOT}" worktree add \
  --track \
  -b "${TASK_BRANCH}" \
  "${REQUESTED_PATH}" \
  refs/remotes/origin/main

CREATED_TEMP_PATH=0
RESOLVED_TASK_ROOT="$(agent_workspaces_resolve_directory "${REQUESTED_PATH}")"

agent_workspaces_git_guard_log \
  "Task worktree ${TASK_BRANCH} created from fresh origin/main."
printf '%s\n' "${RESOLVED_TASK_ROOT}"
