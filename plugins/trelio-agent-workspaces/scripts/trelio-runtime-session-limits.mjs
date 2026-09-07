/**
 * Shared timing contract for the approved hook and value-free diagnostics.
 *
 * Registration's abort clock starts after shell/Node startup, initial ACL
 * checks and any lock wait. The host must allow those costs as well: a
 * seven-second Windows cold start plus the eleven-second registration
 * deadline already exceeds the former fifteen-second definition.
 */
export const PRE_TOOL_USE_TIMEOUT_SECONDS = 30;
export const RUNTIME_REGISTRATION_TIMEOUT_MILLISECONDS = 11_000;
export const RUNTIME_STATE_LOCK_WAIT_MILLISECONDS = 5_000;

// A lock can remain live while the hook writes and verifies private state
// after registration. Reclaim it only beyond the complete host allowance,
// with extra room for process teardown; otherwise a second call could
// replace a still-running registration and orphan its signing key.
export const RUNTIME_STATE_LOCK_STALE_MILLISECONDS = 45_000;
