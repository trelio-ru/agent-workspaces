export const CONTEXT_SEARCH_RANKING_POLICY_VERSION = "context-search-v1";

const PRIMARY_FIELD_SOURCES = new Set([
  "task-title",
  "project",
  "workspace-title",
  "knowledge-page-title",
  "contact-name",
  "contact-alias",
  "registry-title",
]);

const STRUCTURED_FIELD_SOURCES = new Set([
  "task-number",
  "task-checklist",
  "task-control",
  "task-custom-field",
  "contact-tag",
  "contact-detail",
  "contact-channel",
  "contact-identifier",
  "registry-row-key",
  "registry-search-term",
  "registry-row-value",
  "registry-column",
]);

const PROSE_FIELD_SOURCES = new Set([
  "task-description",
  "workspace-description",
  "knowledge-page-body",
  "contact-description",
  "registry-description",
  "registry-row-note",
]);

const DERIVED_FIELD_SOURCES = new Set([
  "task-attachment",
  "task-comment",
  "workspace-file",
  "workspace-artifact",
]);

const DIRECT_VALUE_SOURCES = new Set([
  "task-number",
  "contact-channel",
  "contact-identifier",
  "registry-row-key",
]);

const REGISTRY_ROW_SOURCES = new Set([
  "registry-row-key",
  "registry-row-value",
  "registry-row-note",
]);

export const normalizeContextSearchText = (value) => String(value ?? "")
  .normalize("NFKC")
  .toLocaleLowerCase("ru")
  .replace(/[^\p{L}\p{N}]+/gu, " ")
  .trim()
  .replace(/\s+/gu, " ");

const compareStableText = (left, right) => (
  left < right ? -1 : left > right ? 1 : 0
);

const buildComparableValues = (value) => {
  const values = [
    normalizeContextSearchText(value),
    ...String(value).split(/[·:()]/u).map(normalizeContextSearchText),
  ].filter(Boolean);

  return [...new Set(values)];
};

const buildDirectPreviewValues = (value) => {
  const whole = normalizeContextSearchText(value);
  const segments = String(value)
    .split(/[·:]/u)
    .map(normalizeContextSearchText)
    .filter(Boolean);

  // Contact channels and identifiers commonly use `label · value`. Only the
  // value is a direct reference: a generic label such as "Telegram" must not
  // receive the same hard priority as an exact @username, phone or email.
  return segments.length > 1 ? [segments.at(-1)] : whole ? [whole] : [];
};

const buildReferenceComparisonValues = (value) => {
  const rawValue = String(value ?? "").trim();
  const values = [normalizeContextSearchText(rawValue)];

  if (/^(?:https?:\/\/|\/)/iu.test(rawValue)) {
    try {
      values.push(normalizeContextSearchText(new URL(rawValue, "https://reference.invalid").pathname));
    } catch {
      // Invalid URL-like text remains comparable as ordinary normalized text.
    }
  }

  return [...new Set(values.filter(Boolean))];
};

const tokenize = (value) => value.split(" ").filter((token) => token.length > 1);

const calculateLexicalQuality = (match) => {
  const normalizedQuery = normalizeContextSearchText(match.query);
  if (!normalizedQuery) return 0;

  // Preview text is the provider-neutral projection of the field that really
  // matched. Display titles may contain route labels, company names or an
  // archive marker and therefore must never improve or lower lexical evidence.
  const comparableValues = buildComparableValues(match.previewText);
  if (comparableValues.includes(normalizedQuery)) return 300;
  if (comparableValues.some((value) => value.includes(normalizedQuery))) return 200;

  const queryTokens = tokenize(normalizedQuery);
  if (queryTokens.length === 0) return 0;
  const bestCoverage = comparableValues.reduce((best, value) => {
    const matchedTokens = queryTokens.filter((token) => value.includes(token)).length;
    return Math.max(best, matchedTokens / queryTokens.length);
  }, 0);

  return Math.round(bestCoverage * 100);
};

const calculateFieldQuality = (candidate, match) => {
  if (PRIMARY_FIELD_SOURCES.has(match.source)) return 4;
  if (STRUCTURED_FIELD_SOURCES.has(match.source)) return 3;
  if (PROSE_FIELD_SOURCES.has(match.source)) return 2;
  if (DERIVED_FIELD_SOURCES.has(match.source)) return 1;

  if (match.source === "meeting") {
    const normalizedQuery = normalizeContextSearchText(match.query);
    const normalizedTitle = normalizeContextSearchText(candidate.title);

    // Meeting search exposes one source name for both the title and body. The
    // snippet equals the title for title hits, so detect that case without
    // making the native API and the local mirror invent different source enums.
    return normalizedQuery && normalizedTitle.includes(normalizedQuery) ? 4 : 2;
  }

  return 1;
};

const isExactReferenceMatch = (candidate, match) => {
  const normalizedQueryValues = buildReferenceComparisonValues(match.query);
  if (normalizedQueryValues.length === 0) return false;

  if ((candidate.referenceValues ?? []).some((value) => (
    buildReferenceComparisonValues(value).some((referenceValue) => (
      normalizedQueryValues.includes(referenceValue)
    ))
  ))) {
    return true;
  }

  return DIRECT_VALUE_SOURCES.has(match.source)
    && buildDirectPreviewValues(match.previewText).some((previewValue) => (
      normalizedQueryValues.includes(previewValue)
    ));
};

const calculateAuthority = (candidate) => {
  if (
    candidate.type === "registry"
    && candidate.matches.some((match) => REGISTRY_ROW_SOURCES.has(match.source))
  ) {
    return 3;
  }
  if (["workspace-file", "workspace_file", "workspace-artifact"].includes(candidate.type)) {
    return 1;
  }
  if (candidate.type === "project") return 0;
  return 2;
};

export const buildContextSearchRank = (candidate) => {
  const bestMatchByQuery = new Map();

  for (const match of candidate.matches) {
    const normalizedQuery = normalizeContextSearchText(match.query);
    if (!normalizedQuery) continue;
    const previous = bestMatchByQuery.get(normalizedQuery);
    if (!previous) {
      bestMatchByQuery.set(normalizedQuery, match);
      continue;
    }

    // A provider may discover one formulation in several fields. Ranking must
    // count it once, but an exact channel/identifier/reference is stronger
    // than a coincidental title hit before ordinary field quality is compared.
    const previousReference = isExactReferenceMatch(candidate, previous);
    const nextReference = isExactReferenceMatch(candidate, match);
    const previousDirectSource = DIRECT_VALUE_SOURCES.has(previous.source);
    const nextDirectSource = DIRECT_VALUE_SOURCES.has(match.source);
    const previousField = calculateFieldQuality(candidate, previous);
    const nextField = calculateFieldQuality(candidate, match);
    const previousLexical = calculateLexicalQuality(previous);
    const nextLexical = calculateLexicalQuality(match);
    if (
      (nextReference && !previousReference)
      || (
        nextReference === previousReference
        && (
          (nextDirectSource && !previousDirectSource)
          || (
            nextDirectSource === previousDirectSource
            && (nextField > previousField || (nextField === previousField && nextLexical > previousLexical))
          )
        )
      )
    ) {
      bestMatchByQuery.set(normalizedQuery, match);
    }
  }

  const matches = [...bestMatchByQuery.values()];
  return {
    exactReferenceMatches: matches.filter((match) => isExactReferenceMatch(candidate, match)).length,
    matchedQueryCount: matches.length,
    fieldQuality: matches.reduce((sum, match) => sum + calculateFieldQuality(candidate, match), 0),
    lexicalQuality: matches.reduce((sum, match) => sum + calculateLexicalQuality(match), 0),
    authority: calculateAuthority({ ...candidate, matches }),
    stableKey: candidate.stableKey,
  };
};

export const compareContextSearchCandidates = (left, right) => {
  const leftRank = buildContextSearchRank(left);
  const rightRank = buildContextSearchRank(right);

  return rightRank.exactReferenceMatches - leftRank.exactReferenceMatches
    || rightRank.matchedQueryCount - leftRank.matchedQueryCount
    || rightRank.fieldQuality - leftRank.fieldQuality
    || rightRank.lexicalQuality - leftRank.lexicalQuality
    || rightRank.authority - leftRank.authority
    || compareStableText(leftRank.stableKey, rightRank.stableKey);
};
