#!/usr/bin/env bash

# Общие fail-closed helpers для единственного канонического main-worktree.
# Файл подключается из task/release-скриптов и намеренно не включает `set -e`:
# режим выполнения и обработку ожидаемых ошибок задаёт вызывающий сценарий.

AGENT_WORKSPACES_GIT_RETRY_ATTEMPTS="${AGENT_WORKSPACES_GIT_RETRY_ATTEMPTS:-3}"
AGENT_WORKSPACES_GIT_RETRY_DELAY_SECONDS="${AGENT_WORKSPACES_GIT_RETRY_DELAY_SECONDS:-1}"

agent_workspaces_git_guard_log() {
  printf '[agent-workspaces-git-guard] %s\n' "$*" >&2
}

agent_workspaces_validate_retry_settings() {
  if [[ ! "${AGENT_WORKSPACES_GIT_RETRY_ATTEMPTS}" =~ ^[1-9][0-9]*$ ]]; then
    agent_workspaces_git_guard_log \
      "ERROR: AGENT_WORKSPACES_GIT_RETRY_ATTEMPTS must be a positive integer."
    return 2
  fi

  if [[ ! "${AGENT_WORKSPACES_GIT_RETRY_DELAY_SECONDS}" =~ ^[0-9]+$ ]]; then
    agent_workspaces_git_guard_log \
      "ERROR: AGENT_WORKSPACES_GIT_RETRY_DELAY_SECONDS must be a non-negative integer."
    return 2
  fi
}

agent_workspaces_run_read_with_retry() {
  local operation_label="$1"
  shift

  local attempt=1
  local exit_code=0

  agent_workspaces_validate_retry_settings || return $?

  while (( attempt <= AGENT_WORKSPACES_GIT_RETRY_ATTEMPTS )); do
    if "$@"; then
      return 0
    else
      exit_code=$?
    fi

    if (( attempt >= AGENT_WORKSPACES_GIT_RETRY_ATTEMPTS )); then
      agent_workspaces_git_guard_log \
        "ERROR: ${operation_label} failed after ${attempt} attempts (exit ${exit_code})."
      return "${exit_code}"
    fi

    agent_workspaces_git_guard_log \
      "WARN: ${operation_label} failed on attempt ${attempt}/${AGENT_WORKSPACES_GIT_RETRY_ATTEMPTS}; retrying."
    sleep "$((AGENT_WORKSPACES_GIT_RETRY_DELAY_SECONDS * attempt))"
    attempt=$((attempt + 1))
  done
}

agent_workspaces_resolve_directory() {
  local directory_path="$1"

  if [[ ! -d "${directory_path}" ]]; then
    agent_workspaces_git_guard_log \
      "ERROR: directory does not exist: ${directory_path}"
    return 1
  fi

  (
    cd "${directory_path}"
    pwd -P
  )
}

agent_workspaces_repository_root() {
  local repository_path="$1"
  git -C "${repository_path}" rev-parse --show-toplevel 2>/dev/null
}

agent_workspaces_git_common_directory() {
  local repository_path="$1"
  local repository_root=""
  local common_directory=""

  repository_root="$(agent_workspaces_repository_root "${repository_path}")" || return 1
  common_directory="$(
    git -C "${repository_root}" rev-parse --git-common-dir 2>/dev/null
  )" || return 1

  if [[ "${common_directory}" == /* ]]; then
    agent_workspaces_resolve_directory "${common_directory}"
    return
  fi

  agent_workspaces_resolve_directory "${repository_root}/${common_directory}"
}

agent_workspaces_assert_clean_worktree() {
  local repository_path="$1"
  local worktree_label="${2:-Git worktree}"
  local status_output=""

  status_output="$(
    git -C "${repository_path}" status \
      --porcelain=v1 \
      --untracked-files=all \
      --ignore-submodules=none
  )" || return 1

  if [[ -n "${status_output}" ]]; then
    agent_workspaces_git_guard_log "ERROR: ${worktree_label} is not clean:"
    printf '%s\n' "${status_output}" >&2
    return 1
  fi
}

agent_workspaces_assert_main_branch() {
  local repository_path="$1"
  local worktree_label="${2:-Git worktree}"
  local current_branch=""

  current_branch="$(git -C "${repository_path}" branch --show-current)" || return 1

  if [[ "${current_branch}" != "main" ]]; then
    agent_workspaces_git_guard_log \
      "ERROR: ${worktree_label} must have main checked out; current branch is ${current_branch:-detached HEAD}."
    return 1
  fi
}

agent_workspaces_canonical_main_worktree() {
  local repository_path="$1"
  local configured_path=""
  local canonical_path=""
  local caller_common_directory=""
  local canonical_common_directory=""

  configured_path="$(
    git -C "${repository_path}" config --local --get \
      trelioAgentWorkspaces.canonicalMainWorktree 2>/dev/null || true
  )"

  if [[ -z "${configured_path}" ]]; then
    agent_workspaces_git_guard_log \
      "ERROR: canonical main worktree is not configured; run npm run git:configure-main from the intended main checkout."
    return 1
  fi

  canonical_path="$(agent_workspaces_resolve_directory "${configured_path}")" || return 1

  if ! git -C "${canonical_path}" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    agent_workspaces_git_guard_log \
      "ERROR: configured canonical path is not a Git worktree: ${canonical_path}"
    return 1
  fi

  caller_common_directory="$(
    agent_workspaces_git_common_directory "${repository_path}"
  )" || return 1
  canonical_common_directory="$(
    agent_workspaces_git_common_directory "${canonical_path}"
  )" || return 1

  if [[ "${caller_common_directory}" != "${canonical_common_directory}" ]]; then
    agent_workspaces_git_guard_log \
      "ERROR: configured canonical main belongs to another Git repository: ${canonical_path}"
    return 1
  fi

  agent_workspaces_assert_main_branch \
    "${canonical_path}" \
    "Canonical main worktree" || return 1

  printf '%s\n' "${canonical_path}"
}

agent_workspaces_read_remote_main_sha() {
  local repository_path="$1"
  local remote_name="${2:-origin}"

  git -C "${repository_path}" ls-remote --exit-code \
    "${remote_name}" refs/heads/main \
    | awk 'NR == 1 { print $1 }'
}

agent_workspaces_read_remote_tag_commit() {
  local repository_path="$1"
  local release_tag="$2"
  local remote_name="${3:-origin}"
  local tag_output=""
  local peeled_commit=""
  local direct_object=""

  tag_output="$(
    git -C "${repository_path}" ls-remote \
      "${remote_name}" \
      "refs/tags/${release_tag}" \
      "refs/tags/${release_tag}^{}"
  )" || return 1

  peeled_commit="$(
    printf '%s\n' "${tag_output}" \
      | awk '$2 ~ /\^\{\}$/ { print $1; exit }'
  )"
  direct_object="$(
    printf '%s\n' "${tag_output}" \
      | awk '$2 !~ /\^\{\}$/ { print $1; exit }'
  )"

  printf '%s\n' "${peeled_commit:-${direct_object}}"
}

agent_workspaces_acquire_main_lock() {
  local repository_path="$1"
  local operation_label="$2"
  local common_directory=""
  local lock_directory=""
  local current_host=""
  local existing_host=""
  local existing_pid=""
  local lock_acquired=0

  common_directory="$(
    agent_workspaces_git_common_directory "${repository_path}"
  )" || return 1
  lock_directory="${common_directory}/trelio-agent-workspaces-main-update.lock"
  current_host="$(uname -n)"

  if mkdir "${lock_directory}" 2>/dev/null; then
    lock_acquired=1
  else
    if [[ -f "${lock_directory}/owner" ]]; then
      existing_host="$(sed -n 's/^host=//p' "${lock_directory}/owner" | head -n 1)"
      existing_pid="$(sed -n 's/^pid=//p' "${lock_directory}/owner" | head -n 1)"
    fi

    # Lock принадлежит одному локальному процессу. Удаляем его только когда
    # exact PID на том же host уже не существует, затем захватываем ровно один
    # раз; живой или чужой lock всегда остаётся fail-closed.
    if [[ "${existing_host}" == "${current_host}" ]] \
      && [[ "${existing_pid}" =~ ^[1-9][0-9]*$ ]] \
      && ! kill -0 "${existing_pid}" 2>/dev/null; then
      rm -f "${lock_directory}/owner"
      if rmdir "${lock_directory}" 2>/dev/null \
        && mkdir "${lock_directory}" 2>/dev/null; then
        lock_acquired=1
      fi
    fi
  fi

  if [[ "${lock_acquired}" -ne 1 ]]; then
    agent_workspaces_git_guard_log \
      "ERROR: another guarded main operation is active: ${lock_directory}"
    if [[ -f "${lock_directory}/owner" ]]; then
      sed 's/^/[agent-workspaces-git-guard]   /' \
        "${lock_directory}/owner" >&2
    fi
    return 1
  fi

  {
    printf 'operation=%s\n' "${operation_label}"
    printf 'pid=%s\n' "$$"
    printf 'host=%s\n' "${current_host}"
    printf 'startedAt=%s\n' "$(date -u +'%Y-%m-%dT%H:%M:%SZ')"
  } > "${lock_directory}/owner"

  printf '%s\n' "${lock_directory}"
}

agent_workspaces_release_main_lock() {
  local lock_directory="$1"

  if [[ -z "${lock_directory}" ]] \
    || [[ "$(basename "${lock_directory}")" != \
      "trelio-agent-workspaces-main-update.lock" ]] \
    || [[ ! -d "${lock_directory}" ]]; then
    return 0
  fi

  # Удаляются только exact объекты созданного нами lock-а. Широкий cleanup
  # запрещён, чтобы ошибка пути не могла затронуть остальные Git metadata.
  rm -f "${lock_directory}/owner"
  rmdir "${lock_directory}"
}

agent_workspaces_verify_canonical_main() {
  local canonical_path="$1"
  local expected_sha="$2"
  local remote_name="${3:-origin}"
  local canonical_head=""
  local local_main=""
  local remote_tracking_main=""

  canonical_head="$(git -C "${canonical_path}" rev-parse HEAD)" || return 1
  local_main="$(git -C "${canonical_path}" rev-parse refs/heads/main)" || return 1
  remote_tracking_main="$(
    git -C "${canonical_path}" rev-parse \
      "refs/remotes/${remote_name}/main"
  )" || return 1

  if [[ "${canonical_head}" != "${expected_sha}" ]] \
    || [[ "${local_main}" != "${expected_sha}" ]] \
    || [[ "${remote_tracking_main}" != "${expected_sha}" ]]; then
    agent_workspaces_git_guard_log \
      "ERROR: canonical main refs do not match expected ${expected_sha}:"
    agent_workspaces_git_guard_log "  HEAD=${canonical_head}"
    agent_workspaces_git_guard_log "  refs/heads/main=${local_main}"
    agent_workspaces_git_guard_log \
      "  refs/remotes/${remote_name}/main=${remote_tracking_main}"
    return 1
  fi

  agent_workspaces_assert_clean_worktree \
    "${canonical_path}" \
    "Canonical main worktree"
}
