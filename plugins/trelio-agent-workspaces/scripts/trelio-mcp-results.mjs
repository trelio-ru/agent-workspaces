import { isDeepStrictEqual } from "node:util";

/**
 * Keep one model-visible copy of a structured result. The App still receives
 * the original structuredContent and hidden capability metadata unchanged.
 * Never compact errors, mixed media, independent prose or partial projections:
 * their text may contain information absent from the structured payload.
 */
export const compactLocalMcpResult = (result) => {
  if (!result || result.isError || !result.structuredContent
    || !Array.isArray(result.content) || result.content.length !== 1
    || result.content[0]?.type !== "text") return result;
  let textPayload;
  try {
    textPayload = JSON.parse(result.content[0].text);
  } catch {
    return result;
  }
  if (!isDeepStrictEqual(textPayload, result.structuredContent)) return result;
  return {
    ...result,
    content: [{
      type: "text",
      text: JSON.stringify({
        schemaVersion: 1,
        kind: "trelio-local-structured-content-summary",
        instruction: "Read the complete result from structuredContent. This text intentionally omits its duplicate; App metadata and human decisions are unchanged.",
      }),
    }],
  };
};
