import { isDeepStrictEqual } from "node:util";
import { projectMcpAgentPayload } from "./trelio-agent-response-projection.mjs";

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

/**
 * Применять только к известному Trelio nativeTool ПОСЛЕ local hydration.
 * Provider JSON и MCP App state не относятся к этому контракту. Исходная
 * копия удаляется до проекции, чтобы полный JSON не остался в content.
 */
export const compactLocalNativeMcpResult = (toolName, result, args = {}) => {
  const compact = compactLocalMcpResult(result);
  if (!compact || compact.isError) return compact;
  if (compact.structuredContent && typeof compact.structuredContent === "object") {
    let content = compact.content;
    const payload = compact.structuredContent;
    if (["get_agent_workspace_file", "read_workspace_revision_file"].includes(toolName)
      && typeof payload.text === "string" && content?.length === 1
      && content[0].type === "text" && content[0].text === payload.text
      && Object.keys(content[0]).every((key) => ["type", "text"].includes(key))) {
      content = [{ type: "text", text: "Текст файла и coverage находятся в structuredContent." }];
    }
    return { ...compact, content, structuredContent: projectMcpAgentPayload(toolName, payload, args) };
  }
  // Read/search helpers исторически возвращают единственный JSON text block.
  // Сохраняем этот ABI, не создавая второй structuredContent и не разбирая
  // самостоятельный текст, media, error либо text block с annotations.
  if (compact.content?.length !== 1 || compact.content[0]?.type !== "text"
    || Object.keys(compact.content[0]).some((key) => !["type", "text"].includes(key))) return compact;
  let payload;
  try { payload = JSON.parse(compact.content[0].text); } catch { return compact; }
  const projected = projectMcpAgentPayload(toolName, payload, args);
  return projected === payload ? compact : {
    ...compact, content: [{ type: "text", text: JSON.stringify(projected) }],
  };
};

/** Каталог сохраняет выбор и policy; JSON schema читается для exact tool. */
export const compactRemoteDoctorPayload = (payload, args = {}) => {
  if (!payload?.ok || !Array.isArray(payload.tools)) return payload;
  const selected = typeof args.schemaToolName === "string" ? args.schemaToolName : null;
  return {
    ...payload,
    tools: payload.tools.map((tool) => {
      if (tool.name === selected) return tool;
      const { inputSchema: _input, ...summary } = tool;
      return summary;
    }),
    schemaSelection: {
      requested: selected,
      found: selected === null ? null : payload.tools.some((tool) => tool.name === selected),
      tool: "doctor_remote_agent_skill",
      arguments: { companySlug: args.companySlug, ...(args.projectSlug ? { projectSlug: args.projectSlug } : {}), skillId: args.skillId },
      instruction: "Перед вызовом метода провайдера повторите этот read-only doctor с его точным schemaToolName, чтобы получить полную input schema. Отсутствие схемы не означает пустые arguments.",
    },
  };
};
