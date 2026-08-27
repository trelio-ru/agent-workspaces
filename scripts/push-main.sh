#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/git-main-guard.sh"

REPOSITORY_ROOT="${AGENT_WORKSPACES_REPOSITORY_ROOT:-$(
  git -C "${SCRIPT_DIR}/.." rev-parse --show-toplevel 2>/dev/null || true
)}"
SOURCE_REF="HEAD"
RELEASE_TAG=""
MAIN_LOCK=""

cleanup() {
  agent_workspaces_release_main_lock "${MAIN_LOCK}"
}
trap cleanup EXIT

usage() {
  cat >&2 <<'EOF'
Usage: bash scripts/push-main.sh [--source <ref>] [--tag vX.Y.Z]

Pushes one clean fast-forward source to origin/main, performs exact remote
read-back and then fast-forwards the configured canonical main worktree. With
--tag, main and the existing local stable plugin tag are pushed atomically.
EOF
}

while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --source)
      if [[ "$#" -lt 2 ]]; then
        usage
        exit 2
      fi
      SOURCE_REF="$2"
      shift 2
      ;;
    --tag)
      if [[ "$#" -lt 2 ]]; then
        usage
        exit 2
      fi
      RELEASE_TAG="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      agent_workspaces_git_guard_log "ERROR: unknown argument: $1"
      usage
      exit 2
      ;;
  esac
done

if [[ -z "${REPOSITORY_ROOT}" ]]; then
  agent_workspaces_git_guard_log \
    "ERROR: run this command from a configured Agent Workspaces Git worktree."
  exit 1
fi

if [[ -n "${RELEASE_TAG}" ]] \
  && [[ ! "${RELEASE_TAG}" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  agent_workspaces_git_guard_log \
    "ERROR: release tag must match exact vX.Y.Z form: ${RELEASE_TAG}"
  exit 2
fi

agent_workspaces_validate_retry_settings
CANONICAL_ROOT="$(
  agent_workspaces_canonical_main_worktree "${REPOSITORY_ROOT}"
)"
MAIN_LOCK="$(
  agent_workspaces_acquire_main_lock \
    "${REPOSITORY_ROOT}" \
    "push main${RELEASE_TAG:+ and ${RELEASE_TAG}}"
)"

agent_workspaces_assert_clean_worktree \
  "${REPOSITORY_ROOT}" \
  "Source worktree"
agent_workspaces_assert_clean_worktree \
  "${CANONICAL_ROOT}" \
  "Canonical main worktree"

agent_workspaces_run_read_with_retry \
  "Fetch origin before guarded main push" \
  git -C "${REPOSITORY_ROOT}" fetch --prune origin

SOURCE_SHA="$(
  git -C "${REPOSITORY_ROOT}" rev-parse --verify "${SOURCE_REF}^{commit}"
)"
ORIGINAL_ORIGIN_SHA="$(
  git -C "${REPOSITORY_ROOT}" rev-parse --verify refs/remotes/origin/main
)"

if ! git -C "${REPOSITORY_ROOT}" merge-base --is-ancestor \
  "${ORIGINAL_ORIGIN_SHA}" "${SOURCE_SHA}"; then
  agent_workspaces_git_guard_log \
    "ERROR: ${SOURCE_REF} (${SOURCE_SHA}) is not a fast-forward of origin/main (${ORIGINAL_ORIGIN_SHA})."
  agent_workspaces_git_guard_log \
    "Rebase or rebuild the task candidate from fresh origin/main before pushing."
  exit 1
fi

CANONICAL_HEAD="$(git -C "${CANONICAL_ROOT}" rev-parse HEAD)"

if ! git -C "${CANONICAL_ROOT}" merge-base --is-ancestor \
  "${CANONICAL_HEAD}" "${SOURCE_SHA}"; then
  agent_workspaces_git_guard_log \
    "ERROR: canonical main (${CANONICAL_HEAD}) is outside the source fast-forward path."
  exit 1
fi

if git -C "${CANONICAL_ROOT}" merge-base --is-ancestor \
  "${CANONICAL_HEAD}" "${ORIGINAL_ORIGIN_SHA}"; then
  # Repair a clean but merely stale canonical checkout before remote mutation.
  # This keeps the guard useful even after an external fast-forward of main.
  git -C "${CANONICAL_ROOT}" merge --ff-only "${ORIGINAL_ORIGIN_SHA}"
elif ! git -C "${CANONICAL_ROOT}" merge-base --is-ancestor \
  "${ORIGINAL_ORIGIN_SHA}" "${CANONICAL_HEAD}"; then
  agent_workspaces_git_guard_log \
    "ERROR: canonical main diverged from origin/main."
  exit 1
fi

if [[ -n "${RELEASE_TAG}" ]]; then
  LOCAL_TAG_COMMIT="$(
    git -C "${REPOSITORY_ROOT}" rev-parse --verify \
      "refs/tags/${RELEASE_TAG}^{commit}"
  )"

  if [[ "${LOCAL_TAG_COMMIT}" != "${SOURCE_SHA}" ]]; then
    agent_workspaces_git_guard_log \
      "ERROR: ${RELEASE_TAG} points to ${LOCAL_TAG_COMMIT}, expected source ${SOURCE_SHA}."
    exit 1
  fi

  EXISTING_REMOTE_TAG_COMMIT="$(
    agent_workspaces_run_read_with_retry \
      "Read existing remote tag ${RELEASE_TAG}" \
      agent_workspaces_read_remote_tag_commit \
      "${REPOSITORY_ROOT}" \
      "${RELEASE_TAG}" \
      origin
  )"

  if [[ -n "${EXISTING_REMOTE_TAG_COMMIT}" ]] \
    && [[ "${EXISTING_REMOTE_TAG_COMMIT}" != "${SOURCE_SHA}" ]]; then
    agent_workspaces_git_guard_log \
      "ERROR: remote tag ${RELEASE_TAG} already points to ${EXISTING_REMOTE_TAG_COMMIT}."
    exit 1
  fi
fi

PUSH_ARGUMENTS=(
  git
  -C "${REPOSITORY_ROOT}"
  push
)

if [[ -n "${RELEASE_TAG}" ]]; then
  PUSH_ARGUMENTS+=(--atomic)
fi

PUSH_ARGUMENTS+=(
  origin
  "${SOURCE_SHA}:refs/heads/main"
)

if [[ -n "${RELEASE_TAG}" ]]; then
  PUSH_ARGUMENTS+=("refs/tags/${RELEASE_TAG}:refs/tags/${RELEASE_TAG}")
fi

push_completed=0
attempt=1

while (( attempt <= AGENT_WORKSPACES_GIT_RETRY_ATTEMPTS )); do
  # pre-push разрешает protected refs только этому exact entrypoint. После
  # неясной ошибки ниже обязательно читается remote state до любого повтора.
  if TRELIO_AGENT_WORKSPACES_GUARDED_MAIN_PUSH=1 "${PUSH_ARGUMENTS[@]}"; then
    push_completed=1
    break
  fi

  OBSERVED_REMOTE_MAIN="$(
    agent_workspaces_run_read_with_retry \
      "Read origin/main after failed push" \
      agent_workspaces_read_remote_main_sha \
      "${REPOSITORY_ROOT}" \
      origin
  )"

  OBSERVED_REMOTE_TAG=""
  if [[ -n "${RELEASE_TAG}" ]]; then
    OBSERVED_REMOTE_TAG="$(
      agent_workspaces_run_read_with_retry \
        "Read ${RELEASE_TAG} after failed push" \
        agent_workspaces_read_remote_tag_commit \
        "${REPOSITORY_ROOT}" \
        "${RELEASE_TAG}" \
        origin
    )"
  fi

  if [[ "${OBSERVED_REMOTE_MAIN}" == "${SOURCE_SHA}" ]] \
    && { [[ -z "${RELEASE_TAG}" ]] \
      || [[ "${OBSERVED_REMOTE_TAG}" == "${SOURCE_SHA}" ]]; }; then
    agent_workspaces_git_guard_log \
      "Remote read-back proves the interrupted push already completed."
    push_completed=1
    break
  fi

  if [[ "${OBSERVED_REMOTE_MAIN}" != "${ORIGINAL_ORIGIN_SHA}" ]]; then
    agent_workspaces_git_guard_log \
      "ERROR: origin/main changed to ${OBSERVED_REMOTE_MAIN}; refusing a retry."
    exit 1
  fi

  if [[ -n "${OBSERVED_REMOTE_TAG}" ]] \
    && [[ "${OBSERVED_REMOTE_TAG}" != "${SOURCE_SHA}" ]]; then
    agent_workspaces_git_guard_log \
      "ERROR: remote tag ${RELEASE_TAG} changed to ${OBSERVED_REMOTE_TAG}; refusing a retry."
    exit 1
  fi

  if (( attempt >= AGENT_WORKSPACES_GIT_RETRY_ATTEMPTS )); then
    agent_workspaces_git_guard_log \
      "ERROR: guarded push failed after ${attempt} verified attempts."
    exit 1
  fi

  agent_workspaces_git_guard_log \
    "WARN: guarded push failed on attempt ${attempt}/${AGENT_WORKSPACES_GIT_RETRY_ATTEMPTS}; remote is unchanged, retrying."
  sleep "$((AGENT_WORKSPACES_GIT_RETRY_DELAY_SECONDS * attempt))"
  attempt=$((attempt + 1))
done

if [[ "${push_completed}" -ne 1 ]]; then
  agent_workspaces_git_guard_log "ERROR: guarded push did not complete."
  exit 1
fi

REMOTE_MAIN_SHA="$(
  agent_workspaces_run_read_with_retry \
    "Read back origin/main after guarded push" \
    agent_workspaces_read_remote_main_sha \
    "${REPOSITORY_ROOT}" \
    origin
)"

if [[ "${REMOTE_MAIN_SHA}" != "${SOURCE_SHA}" ]]; then
  agent_workspaces_git_guard_log \
    "ERROR: origin/main read-back is ${REMOTE_MAIN_SHA}, expected ${SOURCE_SHA}."
  exit 1
fi

if [[ -n "${RELEASE_TAG}" ]]; then
  REMOTE_TAG_COMMIT="$(
    agent_workspaces_run_read_with_retry \
      "Read back remote tag ${RELEASE_TAG}" \
      agent_workspaces_read_remote_tag_commit \
      "${REPOSITORY_ROOT}" \
      "${RELEASE_TAG}" \
      origin
  )"

  if [[ "${REMOTE_TAG_COMMIT}" != "${SOURCE_SHA}" ]]; then
    agent_workspaces_git_guard_log \
      "ERROR: remote tag ${RELEASE_TAG} read-back is ${REMOTE_TAG_COMMIT}, expected ${SOURCE_SHA}."
    exit 1
  fi
fi

agent_workspaces_run_read_with_retry \
  "Fetch exact origin/main after guarded push" \
  git -C "${CANONICAL_ROOT}" fetch --prune origin

git -C "${CANONICAL_ROOT}" merge --ff-only "${SOURCE_SHA}"

# Always heal hooksPath to the tracked canonical copy. This also makes the
# first guarded integration safe when a repository is being bootstrapped from
# a task worktree that contains the guard before origin/main does.
git -C "${CANONICAL_ROOT}" config --local \
  core.hooksPath "${CANONICAL_ROOT}/.githooks"

agent_workspaces_verify_canonical_main \
  "${CANONICAL_ROOT}" \
  "${SOURCE_SHA}" \
  origin

agent_workspaces_git_guard_log \
  "Guarded main push complete: canonical main and origin/main are ${SOURCE_SHA}."
