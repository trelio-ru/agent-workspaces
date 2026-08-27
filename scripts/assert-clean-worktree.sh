#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/git-main-guard.sh"

REPOSITORY_ROOT="${AGENT_WORKSPACES_REPOSITORY_ROOT:-$(
  git -C "${SCRIPT_DIR}/.." rev-parse --show-toplevel 2>/dev/null || true
)}"

if [[ -z "${REPOSITORY_ROOT}" ]]; then
  agent_workspaces_git_guard_log \
    "ERROR: run this command from an Agent Workspaces Git worktree."
  exit 1
fi

agent_workspaces_assert_clean_worktree "${REPOSITORY_ROOT}" "Git worktree"
