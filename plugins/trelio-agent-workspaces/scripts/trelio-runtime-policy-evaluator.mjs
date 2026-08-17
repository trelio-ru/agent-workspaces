/**
 * Чистая локальная проверка immutable runtime-policy snapshot.
 *
 * Backend остаётся источником снимка и первой оценки. Этот evaluator нужен,
 * чтобы официальные hook/bridge повторно проверяли фактическую модель после
 * переключения runtime, не выполняя сеть перед каждым инструментом.
 */
import {
  AGENT_RUNTIME_EFFORT_LEVELS,
  AGENT_RUNTIME_MODEL_SUPPORTED_EFFORTS,
} from "./trelio-runtime-attestation.mjs";

const resolvePolicyRule = (providerPolicy, rawModelId) => {
  const normalizedModelId = String(rawModelId || "").trim().toLowerCase();
  const models = Array.isArray(providerPolicy?.models) ? providerPolicy.models : [];

  return models.find((rule) => {
    const canonical = String(rule?.modelId || "").trim().toLowerCase();
    if (!canonical) return false;

    return normalizedModelId === canonical
      || (
        canonical.startsWith("claude-")
        && (
          normalizedModelId.startsWith(`${canonical}-`)
          || normalizedModelId.includes(`.${canonical}`)
          || normalizedModelId.includes(`/${canonical}`)
        )
      );
  }) ?? null;
};

export const evaluatePinnedRuntimePolicy = (snapshot, attestation) => {
  const policy = snapshot?.policy;

  if (!policy || policy.mode === "disabled") {
    return {
      satisfied: true,
      enforced: false,
      reasonCode: "POLICY_DISABLED",
      minimumEffort: null,
    };
  }

  const enforced = policy.mode === "enforce";

  if (attestation?.clientFamily === "other") {
    const satisfied = policy.otherClientsAction === "allow";
    return {
      satisfied,
      enforced,
      reasonCode: satisfied ? "OTHER_CLIENT_ALLOWED" : "OTHER_CLIENT_DENIED",
      minimumEffort: null,
    };
  }

  if (
    !attestation
    || attestation.evidenceLevel !== "local_observed"
    || !attestation.modelId
  ) {
    return {
      satisfied: false,
      enforced,
      reasonCode: "EVIDENCE_REQUIRED",
      minimumEffort: null,
    };
  }

  const providerPolicy = attestation.clientFamily === "codex"
    ? policy?.providers?.codex
    : policy?.providers?.claudeCode;
  const rule = resolvePolicyRule(providerPolicy, attestation.modelId);

  if (!rule) {
    const satisfied = providerPolicy?.unlistedModelsAction === "allow";
    return {
      satisfied,
      enforced,
      reasonCode: satisfied ? "UNLISTED_MODEL_ALLOWED" : "UNLISTED_MODEL_DENIED",
      minimumEffort: null,
    };
  }

  if (rule.decision === "deny") {
    return {
      satisfied: false,
      enforced,
      reasonCode: "MODEL_DENIED",
      minimumEffort: null,
    };
  }

  if (rule.minimumEffort === null) {
    return {
      satisfied: true,
      enforced,
      reasonCode: "MODEL_ALLOWED",
      minimumEffort: null,
    };
  }

  if (!AGENT_RUNTIME_EFFORT_LEVELS.includes(attestation.effortLevel)) {
    return {
      satisfied: false,
      enforced,
      reasonCode: "EFFORT_REQUIRED",
      minimumEffort: rule.minimumEffort,
    };
  }

  const supportedEfforts = AGENT_RUNTIME_MODEL_SUPPORTED_EFFORTS.get(rule.modelId)
    ?? AGENT_RUNTIME_EFFORT_LEVELS;
  const actualIndex = supportedEfforts.indexOf(attestation.effortLevel);
  const minimumIndex = supportedEfforts.indexOf(rule.minimumEffort);
  const satisfied = actualIndex >= minimumIndex && minimumIndex >= 0;
  return {
    satisfied,
    enforced,
    reasonCode: satisfied ? "MODEL_ALLOWED" : "EFFORT_TOO_LOW",
    minimumEffort: rule.minimumEffort,
  };
};
