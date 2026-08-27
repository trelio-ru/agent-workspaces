#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
TEST_ROOT="$(
  mktemp -d "${TMPDIR:-/tmp}/agent-workspaces-git-guard-test.XXXXXX"
)"

cleanup() {
  case "${TEST_ROOT}" in
    "${TMPDIR:-/tmp}"/agent-workspaces-git-guard-test.*)
      # TEST_ROOT создан exact mktemp выше и не может указывать на общий temp.
      find "${TEST_ROOT}" -depth -delete 2>/dev/null || true
      ;;
    *)
      printf 'Refusing unsafe test cleanup path: %s\n' "${TEST_ROOT}" >&2
      ;;
  esac
}
trap cleanup EXIT

REMOTE_REPOSITORY="${TEST_ROOT}/remote.git"
CANONICAL_REPOSITORY="${TEST_ROOT}/canonical"
TASK_ONE_WORKTREE="${TEST_ROOT}/task-one"
TASK_TWO_WORKTREE="${TEST_ROOT}/task-two"
TASK_THREE_WORKTREE="${TEST_ROOT}/task-three"
EXTERNAL_CLONE="${TEST_ROOT}/external-clone"

git init --bare --initial-branch=main "${REMOTE_REPOSITORY}" >/dev/null
git init --initial-branch=main "${CANONICAL_REPOSITORY}" >/dev/null
git -C "${CANONICAL_REPOSITORY}" config user.name "Agent Workspaces Guard Test"
git -C "${CANONICAL_REPOSITORY}" config user.email \
  "guard-test@agent-workspaces.local"

mkdir -p \
  "${CANONICAL_REPOSITORY}/.githooks" \
  "${CANONICAL_REPOSITORY}/scripts"
cp "${PROJECT_ROOT}/.gitignore" "${CANONICAL_REPOSITORY}/.gitignore"
cp "${PROJECT_ROOT}/package.json" "${CANONICAL_REPOSITORY}/package.json"
cp "${PROJECT_ROOT}/.githooks/pre-commit" \
  "${CANONICAL_REPOSITORY}/.githooks/pre-commit"
cp "${PROJECT_ROOT}/.githooks/pre-push" \
  "${CANONICAL_REPOSITORY}/.githooks/pre-push"
cp "${PROJECT_ROOT}/scripts/assert-clean-worktree.sh" \
  "${CANONICAL_REPOSITORY}/scripts/assert-clean-worktree.sh"
cp "${PROJECT_ROOT}/scripts/configure-canonical-main.sh" \
  "${CANONICAL_REPOSITORY}/scripts/configure-canonical-main.sh"
cp "${PROJECT_ROOT}/scripts/create-task-worktree.sh" \
  "${CANONICAL_REPOSITORY}/scripts/create-task-worktree.sh"
cp "${PROJECT_ROOT}/scripts/git-main-guard.sh" \
  "${CANONICAL_REPOSITORY}/scripts/git-main-guard.sh"
cp "${PROJECT_ROOT}/scripts/push-main.sh" \
  "${CANONICAL_REPOSITORY}/scripts/push-main.sh"
chmod +x \
  "${CANONICAL_REPOSITORY}/.githooks/pre-commit" \
  "${CANONICAL_REPOSITORY}/.githooks/pre-push"

printf 'initial\n' > "${CANONICAL_REPOSITORY}/README.md"
git -C "${CANONICAL_REPOSITORY}" add .
git -C "${CANONICAL_REPOSITORY}" commit -m "Начальное состояние" >/dev/null
git -C "${CANONICAL_REPOSITORY}" remote add origin "${REMOTE_REPOSITORY}"
git -C "${CANONICAL_REPOSITORY}" push -u origin main >/dev/null

AGENT_WORKSPACES_GIT_RETRY_DELAY_SECONDS=0 \
  bash "${CANONICAL_REPOSITORY}/scripts/configure-canonical-main.sh" \
    "${CANONICAL_REPOSITORY}" >/dev/null

configured_canonical="$(
  git -C "${CANONICAL_REPOSITORY}" config --local --get \
    trelioAgentWorkspaces.canonicalMainWorktree
)"
resolved_canonical="$(cd "${CANONICAL_REPOSITORY}" && pwd -P)"
configured_hooks="$(
  git -C "${CANONICAL_REPOSITORY}" config --local --get core.hooksPath
)"

if [[ "${configured_canonical}" != "${resolved_canonical}" ]] \
  || [[ "${configured_hooks}" != "${resolved_canonical}/.githooks" ]]; then
  printf 'Canonical main configuration was not persisted exactly.\n' >&2
  exit 1
fi

# System metadata and Python bytecode remain local, while an accidental source
# file under removed platform-skills would still be visible and block a push.
mkdir -p \
  "${CANONICAL_REPOSITORY}/plugins" \
  "${CANONICAL_REPOSITORY}/platform-skills/fixture/__pycache__"
: > "${CANONICAL_REPOSITORY}/.DS_Store"
: > "${CANONICAL_REPOSITORY}/plugins/.DS_Store"
: > "${CANONICAL_REPOSITORY}/platform-skills/fixture/__pycache__/fixture.pyc"
bash "${CANONICAL_REPOSITORY}/scripts/assert-clean-worktree.sh"

printf 'forbidden provider source\n' \
  > "${CANONICAL_REPOSITORY}/platform-skills/fixture/SKILL.md"
if bash "${CANONICAL_REPOSITORY}/scripts/assert-clean-worktree.sh" \
  >/dev/null 2>&1; then
  printf 'platform-skills source was unexpectedly ignored.\n' >&2
  exit 1
fi
rm "${CANONICAL_REPOSITORY}/platform-skills/fixture/SKILL.md"

if (
  cd "${CANONICAL_REPOSITORY}"
  .githooks/pre-commit
) >/dev/null 2>&1; then
  printf 'pre-commit hook allowed a direct commit on main.\n' >&2
  exit 1
fi

AGENT_WORKSPACES_GIT_RETRY_DELAY_SECONDS=0 \
  bash "${CANONICAL_REPOSITORY}/scripts/create-task-worktree.sh" \
    codex/guard-test-one \
    "${TASK_ONE_WORKTREE}" >/dev/null

printf 'task one\n' >> "${TASK_ONE_WORKTREE}/README.md"
git -C "${TASK_ONE_WORKTREE}" add README.md
git -C "${TASK_ONE_WORKTREE}" commit -m "Добавить первую правку" >/dev/null

if git -C "${TASK_ONE_WORKTREE}" push origin HEAD:main >/dev/null 2>&1; then
  printf 'pre-push hook allowed an unguarded main push.\n' >&2
  exit 1
fi

AGENT_WORKSPACES_REPOSITORY_ROOT="${TASK_ONE_WORKTREE}" \
AGENT_WORKSPACES_GIT_RETRY_DELAY_SECONDS=0 \
  bash "${TASK_ONE_WORKTREE}/scripts/push-main.sh" >/dev/null

task_one_sha="$(git -C "${TASK_ONE_WORKTREE}" rev-parse HEAD)"
canonical_sha="$(git -C "${CANONICAL_REPOSITORY}" rev-parse HEAD)"
remote_sha="$(git --git-dir="${REMOTE_REPOSITORY}" rev-parse refs/heads/main)"

if [[ "${task_one_sha}" != "${canonical_sha}" ]] \
  || [[ "${task_one_sha}" != "${remote_sha}" ]]; then
  printf 'Guarded push did not synchronize canonical and remote main.\n' >&2
  exit 1
fi

AGENT_WORKSPACES_GIT_RETRY_DELAY_SECONDS=0 \
  bash "${CANONICAL_REPOSITORY}/scripts/create-task-worktree.sh" \
    codex/guard-test-two \
    "${TASK_TWO_WORKTREE}" >/dev/null

printf 'task two\n' >> "${TASK_TWO_WORKTREE}/README.md"
git -C "${TASK_TWO_WORKTREE}" add README.md
git -C "${TASK_TWO_WORKTREE}" commit -m "Добавить вторую правку" >/dev/null

printf 'uncommitted canonical draft\n' >> "${CANONICAL_REPOSITORY}/README.md"
remote_before_blocked_push="$(
  git --git-dir="${REMOTE_REPOSITORY}" rev-parse refs/heads/main
)"

if AGENT_WORKSPACES_REPOSITORY_ROOT="${TASK_TWO_WORKTREE}" \
  AGENT_WORKSPACES_GIT_RETRY_DELAY_SECONDS=0 \
  bash "${TASK_TWO_WORKTREE}/scripts/push-main.sh" >/dev/null 2>&1; then
  printf 'Guarded push ignored a dirty canonical main worktree.\n' >&2
  exit 1
fi

remote_after_blocked_push="$(
  git --git-dir="${REMOTE_REPOSITORY}" rev-parse refs/heads/main
)"
if [[ "${remote_before_blocked_push}" != "${remote_after_blocked_push}" ]]; then
  printf 'Remote main changed even though canonical main was dirty.\n' >&2
  exit 1
fi

git -C "${CANONICAL_REPOSITORY}" restore README.md
AGENT_WORKSPACES_REPOSITORY_ROOT="${TASK_TWO_WORKTREE}" \
AGENT_WORKSPACES_GIT_RETRY_DELAY_SECONDS=0 \
  bash "${TASK_TWO_WORKTREE}/scripts/push-main.sh" >/dev/null

# Имитируем внешний fast-forward, который обновил remote без этого clone.
# Следующее штатное создание worktree обязано сначала догнать canonical main.
git clone "${REMOTE_REPOSITORY}" "${EXTERNAL_CLONE}" >/dev/null 2>&1
git -C "${EXTERNAL_CLONE}" config user.name "External Guard Test"
git -C "${EXTERNAL_CLONE}" config user.email "external@agent-workspaces.local"
printf 'external\n' >> "${EXTERNAL_CLONE}/README.md"
git -C "${EXTERNAL_CLONE}" add README.md
git -C "${EXTERNAL_CLONE}" commit -m "Добавить внешнюю правку" >/dev/null
git -C "${EXTERNAL_CLONE}" push origin main >/dev/null
external_sha="$(git -C "${EXTERNAL_CLONE}" rev-parse HEAD)"

AGENT_WORKSPACES_GIT_RETRY_DELAY_SECONDS=0 \
  bash "${CANONICAL_REPOSITORY}/scripts/create-task-worktree.sh" \
    codex/guard-test-three \
    "${TASK_THREE_WORKTREE}" >/dev/null

if [[ "$(git -C "${CANONICAL_REPOSITORY}" rev-parse HEAD)" != "${external_sha}" ]] \
  || [[ "$(git -C "${TASK_THREE_WORKTREE}" rev-parse HEAD)" != "${external_sha}" ]]; then
  printf 'Task creation did not fast-forward stale canonical main first.\n' >&2
  exit 1
fi

printf 'release\n' >> "${TASK_THREE_WORKTREE}/README.md"
git -C "${TASK_THREE_WORKTREE}" add README.md
git -C "${TASK_THREE_WORKTREE}" commit -m "Подготовить тестовый релиз" >/dev/null
git -C "${TASK_THREE_WORKTREE}" tag -a v9.9.9 -m "Тестовый релиз v9.9.9"

if git -C "${TASK_THREE_WORKTREE}" push origin v9.9.9 >/dev/null 2>&1; then
  printf 'pre-push hook allowed an unguarded stable tag push.\n' >&2
  exit 1
fi

AGENT_WORKSPACES_REPOSITORY_ROOT="${TASK_THREE_WORKTREE}" \
AGENT_WORKSPACES_GIT_RETRY_DELAY_SECONDS=0 \
  bash "${TASK_THREE_WORKTREE}/scripts/push-main.sh" \
    --tag v9.9.9 >/dev/null

release_sha="$(git -C "${TASK_THREE_WORKTREE}" rev-parse HEAD)"
remote_tag_sha="$(
  git --git-dir="${REMOTE_REPOSITORY}" rev-parse refs/tags/v9.9.9^{}
)"

if [[ "$(git -C "${CANONICAL_REPOSITORY}" rev-parse HEAD)" != "${release_sha}" ]] \
  || [[ "$(git --git-dir="${REMOTE_REPOSITORY}" rev-parse refs/heads/main)" != "${release_sha}" ]] \
  || [[ "${remote_tag_sha}" != "${release_sha}" ]]; then
  printf 'Atomic tag push did not synchronize all protected refs.\n' >&2
  exit 1
fi

if [[ -d "${CANONICAL_REPOSITORY}/.git/trelio-agent-workspaces-main-update.lock" ]]; then
  printf 'Git guard left the shared main lock active.\n' >&2
  exit 1
fi

printf 'agent-workspaces git main guard tests passed\n'
