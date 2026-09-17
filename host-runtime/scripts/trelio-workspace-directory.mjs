import path from "node:path";

export const WORKSPACE_DIRECTORY_REQUIRED = "TRELIO_WORKSPACE_DIRECTORY_REQUIRED";
export const WORKSPACE_LOCAL_RECOVERY_REQUIRED = "TRELIO_WORKSPACE_LOCAL_RECOVERY_REQUIRED";
export const WORKSPACE_RUN_RECLAIM_REQUIRED = "TRELIO_WORKSPACE_RUN_RECLAIM_REQUIRED";
const MAX_CANDIDATES = 10;
const MAX_RECOVERY_CHANGES = 200;
const MAX_DIRECTORY_LENGTH = 4096;
const MAX_CHANGE_LENGTH = 4096;
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

const LOCAL_RECOVERY_MESSAGE = "Локальная папка содержит несохранённые изменения завершённого Agent Run. "
  + "Bridge не перезапишет и не переместит их автоматически. Откройте целевой Run "
  + "в suggestedDirectory, сравните перечисленную дельту, перенесите только выбранные "
  + "материалы и сразу сохраните их через checkpoint, pause или finish.";

// Terminal Run не может принять новый checkpoint, а молчаливая очистка теряет
// данные. Этот bounded envelope даёт host точный безопасный маршрут в новый
// root, не передавая credentials и закрытые поля локального metadata.
export class WorkspaceLocalRecoveryRequiredError extends Error {
  constructor({
    workspaceId,
    sourceRunId,
    targetRunId,
    sourceRunStatus,
    sourceDirectory,
    sourceWorkspaceDirectory,
    suggestedDirectory,
    lastSavedDraftHead,
    changes,
  }) {
    super(LOCAL_RECOVERY_MESSAGE);
    this.code = WORKSPACE_LOCAL_RECOVERY_REQUIRED;
    const visibleChanges = changes
      .filter((change) => typeof change === "string" && change.length <= MAX_CHANGE_LENGTH)
      .slice(0, MAX_RECOVERY_CHANGES);
    this.details = {
      workspaceId,
      sourceRunId,
      targetRunId: targetRunId || null,
      sourceRunStatus,
      sourceDirectory,
      sourceWorkspaceDirectory,
      suggestedDirectory,
      lastSavedDraftHead: lastSavedDraftHead || null,
      changes: visibleChanges,
      omittedChangeCount: changes.length - visibleChanges.length,
      requiredAction: "open_recovery_directory_and_transfer_selected_changes",
      directoryParameter: "parameters.directory",
      sourceFilesMustRemainUntouched: true,
      nextSaveActions: ["checkpoint", "pause", "finish"],
    };
  }

  toJSON() {
    return { code: this.code, message: this.message, details: this.details };
  }
}

const RUN_RECLAIM_MESSAGE = "Локальная папка содержит истёкший Agent Run, который ещё нельзя "
  + "считать пустым и безопасно заменить. Подготовьте и откройте этот exact Run через "
  + "prepare_agent_workspace_run(runId), разберите его состояние и только затем продолжайте новый Run.";

// Новый server Run может быть подготовлен раньше локального preflight. Если root
// хранит recoverable expired Run, bridge не угадывает судьбу его данных и не
// подменяет target. Вместо свободного текста возвращается bounded exact locator,
// который уже поддерживается общим lifecycle recovery flow MCP-host.
export class WorkspaceRunReclaimRequiredError extends Error {
  constructor({ workspaceId, sourceRunId, targetRunId }) {
    super(RUN_RECLAIM_MESSAGE);
    this.code = WORKSPACE_RUN_RECLAIM_REQUIRED;
    this.details = {
      requiredAction: "prepare_and_open_existing_run",
      workspaceId,
      runId: sourceRunId,
      targetRunId: targetRunId || null,
      operation: "open",
      reasonCode: "LOCAL_EXPIRED_RUN_REQUIRES_REVIEW",
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

export const parseWorkspaceLocalRecoveryRequiredError = (
  stderr,
  workspaceId,
  targetRunId = null,
) => {
  if (typeof stderr !== "string" || stderr.length > 256 * 1024) return null;
  const text = stderr.trim();
  if (!text.startsWith("Ошибка: {")) return null;
  let payload;
  try { payload = JSON.parse(text.slice("Ошибка: ".length)); }
  catch { return null; }
  const details = payload?.details;
  const expectedTargetRunId = targetRunId || null;
  if (
    payload?.code !== WORKSPACE_LOCAL_RECOVERY_REQUIRED
    || details?.workspaceId !== workspaceId
    || !UUID_PATTERN.test(workspaceId)
    || !UUID_PATTERN.test(String(details?.sourceRunId || ""))
    || details.targetRunId !== expectedTargetRunId
    || (details.targetRunId !== null && !UUID_PATTERN.test(details.targetRunId))
    || !["accepted", "cancelled"].includes(details.sourceRunStatus)
    || details.requiredAction !== "open_recovery_directory_and_transfer_selected_changes"
    || details.directoryParameter !== "parameters.directory"
    || details.sourceFilesMustRemainUntouched !== true
    || !Array.isArray(details.nextSaveActions)
    || details.nextSaveActions.join("\0") !== "checkpoint\0pause\0finish"
    || ![details.sourceDirectory, details.sourceWorkspaceDirectory, details.suggestedDirectory]
      .every((directory) => (
        typeof directory === "string"
        && path.isAbsolute(directory)
        && !directory.includes("\0")
        && directory.length <= MAX_DIRECTORY_LENGTH
      ))
    || path.resolve(details.sourceWorkspaceDirectory)
      !== path.join(path.resolve(details.sourceDirectory), "workspace")
    || path.resolve(details.suggestedDirectory) === path.resolve(details.sourceDirectory)
    || !Array.isArray(details.changes)
    || details.changes.length > MAX_RECOVERY_CHANGES
    || details.changes.some((change) => (
      typeof change !== "string"
      || change.length === 0
      || change.length > MAX_CHANGE_LENGTH
    ))
    || !Number.isSafeInteger(details.omittedChangeCount)
    || details.omittedChangeCount < 0
    || (details.lastSavedDraftHead !== null
      && !/^[0-9a-f]{40,64}$/u.test(details.lastSavedDraftHead))
  ) return null;
  const result = new WorkspaceLocalRecoveryRequiredError({
    workspaceId,
    sourceRunId: details.sourceRunId,
    targetRunId: details.targetRunId,
    sourceRunStatus: details.sourceRunStatus,
    sourceDirectory: details.sourceDirectory,
    sourceWorkspaceDirectory: details.sourceWorkspaceDirectory,
    suggestedDirectory: details.suggestedDirectory,
    lastSavedDraftHead: details.lastSavedDraftHead,
    changes: details.changes,
  });
  result.details.omittedChangeCount = details.omittedChangeCount;
  return result;
};

export const parseWorkspaceRunReclaimRequiredError = (
  stderr,
  workspaceId,
  targetRunId = null,
) => {
  if (typeof stderr !== "string" || stderr.length > 64 * 1024) return null;
  const text = stderr.trim();
  if (!text.startsWith("Ошибка: {")) return null;
  let payload;
  try { payload = JSON.parse(text.slice("Ошибка: ".length)); }
  catch { return null; }
  const details = payload?.details;
  const expectedTargetRunId = targetRunId || null;
  if (
    payload?.code !== WORKSPACE_RUN_RECLAIM_REQUIRED
    || details?.requiredAction !== "prepare_and_open_existing_run"
    || details.workspaceId !== workspaceId
    || !UUID_PATTERN.test(workspaceId)
    || !UUID_PATTERN.test(String(details.runId || ""))
    || details.targetRunId !== expectedTargetRunId
    || (details.targetRunId !== null && !UUID_PATTERN.test(details.targetRunId))
    || details.operation !== "open"
    || details.reasonCode !== "LOCAL_EXPIRED_RUN_REQUIRES_REVIEW"
  ) return null;
  return new WorkspaceRunReclaimRequiredError({
    workspaceId,
    sourceRunId: details.runId,
    targetRunId: details.targetRunId,
  });
};
