import path from "node:path";

export const WORKSPACE_DIRECTORY_REQUIRED = "TRELIO_WORKSPACE_DIRECTORY_REQUIRED";
const MAX_CANDIDATES = 10;
const MAX_DIRECTORY_LENGTH = 4096;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const MESSAGE = "Для этого Agent Workspace зарегистрировано несколько локальных папок. "
  + "Повторите тот же open, указав выбранный корень в parameters.directory "
  + "(CLI: --dir). workingDirectory задаёт cwd процесса, а не явный выбор корня. "
  + "Список не подтверждает чистоту Git или завершение прежнего Run: open проверит их до записи.";

// Ошибка пересекает process boundary bridge → MCP. Передаём только локаторы
// проверенного Workspace, а не metadata целиком: там могут быть runtime keys,
// snapshots и другие данные, которые не нужны для выбора папки.
export class WorkspaceDirectoryRequiredError extends Error {
  constructor(workspaceId, candidates) {
    super(MESSAGE);
    this.code = WORKSPACE_DIRECTORY_REQUIRED;
    const visible = candidates
      .filter(({ directory }) => directory.length <= MAX_DIRECTORY_LENGTH)
      .slice(0, MAX_CANDIDATES)
      .map(({ directory, runId }) => ({ directory, runId }));
    this.details = {
      workspaceId,
      requiredAction: "select_directory",
      parameter: "parameters.directory",
      candidates: visible,
      omittedCandidateCount: candidates.length - visible.length,
    };
  }

  toJSON() {
    return { code: this.code, message: this.message, details: this.details };
  }
}

// Не распознаём произвольный JSON stdout, чужой код ошибки или provider stderr
// как recovery. Только bounded exact envelope своего open и своего Workspace;
// неизвестные поля не переносим в model-visible ответ.
export const parseWorkspaceDirectoryRequiredError = (stderr, workspaceId) => {
  if (typeof stderr !== "string" || stderr.length > 64 * 1024) return null;
  const text = stderr.trim();
  if (!text.startsWith("Ошибка: {")) return null;
  let payload;
  try { payload = JSON.parse(text.slice("Ошибка: ".length)); }
  catch { return null; }
  const details = payload?.details;
  if (
    payload?.code !== WORKSPACE_DIRECTORY_REQUIRED
    || details?.workspaceId !== workspaceId
    || !UUID_PATTERN.test(workspaceId)
    || details.requiredAction !== "select_directory"
    || details.parameter !== "parameters.directory"
    || !Array.isArray(details.candidates)
    || details.candidates.length > MAX_CANDIDATES
    || !Number.isSafeInteger(details.omittedCandidateCount)
    || details.omittedCandidateCount < 0
    || details.candidates.length + details.omittedCandidateCount < 2
    || details.candidates.some((candidate) => (
      typeof candidate?.directory !== "string"
      || !path.isAbsolute(candidate.directory)
      || candidate.directory.includes("\0")
      || candidate.directory.length > MAX_DIRECTORY_LENGTH
      || typeof candidate.runId !== "string"
      || !UUID_PATTERN.test(candidate.runId)
    ))
  ) return null;
  const result = new WorkspaceDirectoryRequiredError(workspaceId, details.candidates);
  result.details.omittedCandidateCount = details.omittedCandidateCount;
  return result;
};
