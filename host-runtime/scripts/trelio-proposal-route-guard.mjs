import crypto from "node:crypto";
import path from "node:path";

// A provider decision is needed only between the headless context read and the
// following render call. Keeping the marker short-lived avoids treating old
// local state as the current company mode after a later encryption transition.
export const LOCAL_PROPOSAL_ROUTE_GUARD_TTL_MILLISECONDS = 15 * 60 * 1_000;
export const LOCAL_PROPOSAL_ROUTE_MARKER_MAX_BYTES = 512;

const LOCAL_PROPOSAL_ROUTE_MARKER_SCHEMA_VERSION = 1;
const LOCAL_PROPOSAL_ROUTE_DIRECTORY_NAME = "proposal-provider-routes";
const LOCAL_PROPOSAL_PROVIDER = "local_company_context";

const NATIVE_TASK_PROPOSAL_RENDER_TOOLS = new Set([
  "propose_task_comment",
  "render_task_comment_proposal",
  "render_task_comment_proposals",
  "render_task_status_proposal",
  "render_task_control_clear_proposal",
  "render_task_checklist_proposal",
  "render_task_proposals",
]);

const normalizeOrigin = (value) => {
  const parsed = new URL(String(value || ""));
  if (!new Set(["http:", "https:"]).has(parsed.protocol)) {
    throw new Error("Proposal route marker requires an HTTP(S) origin.");
  }
  return parsed.origin;
};

const normalizeSelectorValue = (value) => (
  typeof value === "string" && value.trim().length > 0
    ? value.trim().toLowerCase()
    : null
);

const selectorPath = ({ configDirectory, origin, kind, value }) => {
  const normalizedValue = normalizeSelectorValue(value);
  if (!normalizedValue) return null;
  const selectorSha256 = crypto.createHash("sha256")
    .update(`${normalizeOrigin(origin)}\n${kind}\n${normalizedValue}`)
    .digest("hex");
  return path.join(
    configDirectory,
    LOCAL_PROPOSAL_ROUTE_DIRECTORY_NAME,
    `${selectorSha256}.json`,
  );
};

const uniquePaths = (values) => [...new Set(values.filter(Boolean))];

const markerPathsForTarget = ({ configDirectory, origin, companySlug, target }) => uniquePaths([
  selectorPath({
    configDirectory,
    origin,
    kind: "company",
    value: companySlug,
  }),
  selectorPath({
    configDirectory,
    origin,
    kind: "run",
    value: target?.runId,
  }),
]);

/**
 * Return opaque owner-private marker paths for one confirmed provider choice.
 * Project slugs and task numbers are deliberately absent: direct task calls
 * already carry companySlug, while a Run gets its own hashed selector.
 */
export const resolveSelectedLocalProposalRouteMarkerPaths = ({
  configDirectory,
  origin,
  companySlug,
  target,
}) => markerPathsForTarget({ configDirectory, origin, companySlug, target });

/**
 * Extract every target from a native proposal renderer before the MCP server
 * runs. A mixed bundle is blocked as a whole when any card is already known to
 * require the local provider, matching the backend's provider-first boundary.
 */
export const resolveNativeProposalRouteMarkerPaths = ({
  configDirectory,
  origin,
  toolName,
  toolInput,
}) => {
  if (!NATIVE_TASK_PROPOSAL_RENDER_TOOLS.has(String(toolName || "").toLowerCase())) {
    return [];
  }

  const input = toolInput && typeof toolInput === "object" && !Array.isArray(toolInput)
    ? toolInput
    : {};
  const targets = [input];
  if (Array.isArray(input.blocks)) {
    targets.push(...input.blocks.filter((block) => (
      block && typeof block === "object" && !Array.isArray(block) && block.type !== "text"
    )));
  }

  return uniquePaths(targets.flatMap((target) => markerPathsForTarget({
    configDirectory,
    origin,
    companySlug: target.companySlug,
    target,
  })));
};

export const buildLocalProposalRouteMarker = ({ markerPath, nowMs = Date.now() }) => ({
  schemaVersion: LOCAL_PROPOSAL_ROUTE_MARKER_SCHEMA_VERSION,
  provider: LOCAL_PROPOSAL_PROVIDER,
  selectorSha256: path.basename(markerPath, ".json"),
  expiresAt: new Date(nowMs + LOCAL_PROPOSAL_ROUTE_GUARD_TTL_MILLISECONDS).toISOString(),
});

/**
 * Marker contents never authorize a write; they can only stop the wrong host
 * surface. Unknown, stale or implausibly long-lived records are ignored so a
 * future plugin format cannot permanently disable ordinary native proposals.
 */
export const isActiveLocalProposalRouteMarker = ({
  marker,
  markerPath,
  nowMs = Date.now(),
}) => {
  if (!marker || typeof marker !== "object" || Array.isArray(marker)) return false;
  const expiresAtMs = Date.parse(marker.expiresAt);
  return marker.schemaVersion === LOCAL_PROPOSAL_ROUTE_MARKER_SCHEMA_VERSION
    && marker.provider === LOCAL_PROPOSAL_PROVIDER
    && marker.selectorSha256 === path.basename(markerPath, ".json")
    && Number.isFinite(expiresAtMs)
    && expiresAtMs > nowMs
    && expiresAtMs <= nowMs + LOCAL_PROPOSAL_ROUTE_GUARD_TTL_MILLISECONDS + 60_000;
};
