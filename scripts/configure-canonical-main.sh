#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/git-main-guard.sh"

CANONICAL_INPUT="${1:-${AGENT_WORKSPACES_CANONICAL_MAIN_WORKTREE:-$(
  cd "${SCRIPT_DIR}/.."
  pwd
)}}"
CANONICAL_ROOT="$(agent_workspaces_resolve_directory "${CANONICAL_INPUT}")"
MAIN_LOCK=""

cleanup() {
  agent_workspaces_release_main_lock "${MAIN_LOCK}"
}
trap cleanup EXIT

if ! git -C "${CANONICAL_ROOT}" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  agent_workspaces_git_guard_log \
    "ERROR: canonical path is not a Git worktree: ${CANONICAL_ROOT}"
  exit 1
fi

agent_workspaces_assert_main_branch \
  "${CANONICAL_ROOT}" \
  "Canonical main worktree"
agent_workspaces_assert_clean_worktree \
  "${CANONICAL_ROOT}" \
  "Canonical main worktree"

MAIN_LOCK="$(
  agent_workspaces_acquire_main_lock \
    "${CANONICAL_ROOT}" \
    "configure canonical main"
)"

agent_workspaces_run_read_with_retry \
  "Fetch origin before canonical main configuration" \
  git -C "${CANONICAL_ROOT}" fetch --prune origin

if ! git -C "${CANONICAL_ROOT}" rev-parse --verify \
  refs/remotes/origin/main >/dev/null 2>&1; then
  agent_workspaces_git_guard_log \
    "ERROR: origin/main is unavailable in ${CANONICAL_ROOT}."
  exit 1
fi

if ! git -C "${CANONICAL_ROOT}" merge-base --is-ancestor \
  HEAD refs/remotes/origin/main; then
  agent_workspaces_git_guard_log \
    "ERROR: canonical main contains commits outside origin/main; refusing automatic synchronization."
  exit 1
fi

git -C "${CANONICAL_ROOT}" merge --ff-only refs/remotes/origin/main
agent_workspaces_assert_clean_worktree \
  "${CANONICAL_ROOT}" \
  "Canonical main worktree"

for hook_path in \
  "${CANONICAL_ROOT}/.githooks/pre-commit" \
  "${CANONICAL_ROOT}/.githooks/pre-push"; do
  if [[ ! -x "${hook_path}" ]]; then
    agent_workspaces_git_guard_log \
      "ERROR: required tracked hook is missing or not executable: ${hook_path}"
    exit 1
  fi
done

# Local repository config is shared by linked worktrees but not by another
# clone. Поэтому ни отдельный clone, ни случайная папка не становятся
# canonical без явного запуска этой команды.
git -C "${CANONICAL_ROOT}" config --local \
  trelioAgentWorkspaces.canonicalMainWorktree "${CANONICAL_ROOT}"
git -C "${CANONICAL_ROOT}" config --local \
  core.hooksPath "${CANONICAL_ROOT}/.githooks"

CANONICAL_HEAD="$(git -C "${CANONICAL_ROOT}" rev-parse HEAD)"
agent_workspaces_verify_canonical_main \
  "${CANONICAL_ROOT}" \
  "${CANONICAL_HEAD}" \
  origin

agent_workspaces_git_guard_log \
  "Canonical main configured at ${CANONICAL_ROOT} (${CANONICAL_HEAD}); guarded hooks are active."
