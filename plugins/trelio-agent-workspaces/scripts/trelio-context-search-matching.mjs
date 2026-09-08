/**
 * Portable agent-search policy. The same patterns run in PostgreSQL and in the
 * encrypted local mirror; neither provider may substitute its own dictionary,
 * substring coverage threshold or six-character prefix heuristic.
 */
export const normalizeContextSearchReference = (value) => String(value ?? "")
    .toLocaleLowerCase("ru").replaceAll("ё", "е").trim();
export const normalizeContextSearchText = (value) => normalizeContextSearchReference(value)
    .replaceAll("ё", "е").replace(/[^\p{L}\p{N}]+/gu, " ").trim().replace(/\s+/gu, " ");
// This is an explicit, conservative inflection family, not fuzzy matching or
// a claim to reproduce a PostgreSQL language dictionary. A minimum three-letter
// root prevents short names/prepositions from matching arbitrary word prefixes.
// The policy deliberately keeps foreign words and identifiers unstemmed.
const ENDINGS = ["иями", "ями", "ами", "его", "ого", "ему", "ому", "ими", "ыми", "ией", "иям", "иях", "иев", "ах", "ях", "ов", "ев", "ом", "ем", "ам", "ям", "ой", "ей", "ый", "ий", "ая", "яя", "ое", "ее", "ые", "ие", "ую", "юю", "ия", "ии", "ию", "а", "я", "ы", "и", "у", "ю", "е", "о", "ь"];
const ENDING_PATTERN = `(?:${[...new Set(ENDINGS)].join("|")})?`;
const escapePattern = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
export const contextSearchTokenRoot = (token) => {
    if (!/^[а-я]+$/u.test(token))
        return token;
    const ending = ENDINGS.find((candidate) => token.endsWith(candidate) && token.length - candidate.length >= 3);
    return ending ? token.slice(0, -ending.length) : token;
};
export const compileContextSearchQuery = (value) => {
    const original = value.trim();
    const referenceText = normalizeContextSearchReference(original);
    // Paths, filenames, handles, UUIDs and digests retain punctuation and order.
    // `0126--message_126.jpg` must never become a bag of four ordinary words.
    const digest = /^[a-f0-9]{32,64}$/u.test(referenceText);
    const reference = /[/\\]/u.test(referenceText)
        || /\.[a-z0-9]{1,12}$/u.test(referenceText)
        || (!/\s/u.test(referenceText) && (/[./@:_\\-]/u.test(referenceText) || digest));
    const normalized = reference ? referenceText : normalizeContextSearchText(original);
    const tokens = [...new Set(normalized.split(" ").filter(Boolean))];
    const roots = tokens.map(contextSearchTokenRoot);
    const referenceBoundary = digest ? "\\p{L}\\p{N}" : "\\p{L}\\p{N}./@:_\\-";
    const patterns = reference
        ? [`(^|[^${referenceBoundary}])${escapePattern(referenceText)}($|[^${referenceBoundary}])`]
        : [...new Set(tokens.map((token, index) => {
                const root = roots[index];
                const word = /^[а-я]{3,}$/u.test(root) ? `${escapePattern(root)}${ENDING_PATTERN}` : escapePattern(token);
                return `(^|[^\\p{L}\\p{N}])${word}($|[^\\p{L}\\p{N}])`;
            }))];
    return {
        original, normalized, reference,
        key: reference ? `ref:${normalized}` : `words:${[...new Set(roots)].sort().join(" ")}`,
        patterns,
        expressions: normalized ? patterns.map((pattern) => new RegExp(pattern, "u")) : [],
    };
};
export const normalizeContextSearchQueries = (queries) => ([...new Map(queries.map(compileContextSearchQuery).filter((query) => query.normalized)
        .map((query) => [query.key, query])).values()]);
export const matchContextSearchField = (value, query, { allowQueryContainsField = false } = {}) => {
    if (!query.expressions.length)
        return false;
    const text = query.reference ? normalizeContextSearchReference(value) : normalizeContextSearchText(value);
    if (query.expressions.every((expression) => expression.test(text)))
        return true;
    // Only explicitly declared registry discovery terms permit reverse matching;
    // even there, whole words and complete coverage remain mandatory.
    return allowQueryContainsField && !query.reference && Boolean(text)
        && compileContextSearchQuery(text).expressions.every((expression) => expression.test(query.normalized));
};
