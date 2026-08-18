#!/usr/bin/env node

/**
 * Лёгкий SessionStart hook плагина.
 *
 * Здесь намеренно нет проверки модели или reasoning effort. Runtime policy
 * применяется Trelio backend-ом к self-attestation exact MCP-запроса; локальный
 * hook не является доверенной границей и не должен блокировать инструменты.
 */
import { pathToFileURL } from "node:url";

const INITIAL_CHAT_TITLE_REMINDER = [
  "Это первый ход нового основного чата.",
  "После сбора исходного контекста один раз проверь, нужно ли задать текущему чату короткое информативное название через прямой безопасный инструмент именно текущего чата.",
  "Если название уже понятное или задано пользователем либо прямого инструмента нет, молча продолжай.",
  "В следующих ходах автоматически к названию не возвращайся.",
].join(" ");

const readStdinJson = async () => {
  const chunks = [];

  for await (const chunk of process.stdin) {
    chunks.push(Buffer.from(chunk));
  }

  return chunks.length > 0
    ? JSON.parse(Buffer.concat(chunks).toString("utf8"))
    : {};
};

/**
 * Возвращает одноразовое напоминание только при старте нового основного чата
 * Codex. Claude Code получает этот же plugin hook, но не умеет переименовывать
 * Codex-задачу и поэтому не получает лишний контекст.
 */
export const resolveInitialChatTitleReminder = ({
  hookInput = {},
  environment = process.env,
} = {}) => {
  const isCodexSession = Boolean(environment.CODEX_THREAD_ID);
  const isClaudeCodeSession = Boolean(
    environment.CLAUDE_CODE_ENTRYPOINT
    || environment.CLAUDE_EFFORT
    || hookInput?.effort,
  );

  if (
    hookInput.hook_event_name !== "SessionStart"
    || hookInput.source !== "startup"
    || !isCodexSession
    || isClaudeCodeSession
  ) {
    return null;
  }

  return INITIAL_CHAT_TITLE_REMINDER;
};

const runHook = async () => {
  const hookInput = await readStdinJson();
  const reminder = resolveInitialChatTitleReminder({ hookInput });

  if (reminder) {
    process.stdout.write(`${reminder}\n`);
  }
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runHook().catch((error) => {
    process.stderr.write(`Trelio SessionStart hook failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  });
}
