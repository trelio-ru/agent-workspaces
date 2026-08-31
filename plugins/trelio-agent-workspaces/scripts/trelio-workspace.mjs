#!/usr/bin/env node

/**
 * Локальный bridge для Trelio Agent Workspaces.
 *
 * Bridge намеренно не является MCP-сервером и не передаёт OAuth token агенту.
 * Он материализует закреплённые Git-ревизии, хранит bridge device-session в
 * приватном локальном файле и отправляет на сервер только candidate bundle
 * текущего Run.
 */
import { execFile, spawn } from "node:child_process";
import { isUtf8 } from "node:buffer";
import crypto from "node:crypto";
import { constants as fsConstants, createReadStream, createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import {
  GIT_DISABLED_GLOBAL_CONFIG_PATH,
  GIT_DISABLED_HOOKS_PATH,
  GitPrerequisiteError,
  verifyGitRuntime,
} from "./trelio-git.mjs";
import {
  SecretBrowserFillError,
  runSecretBrowserFill,
} from "./trelio-secret-browser.mjs";
import {
  COMPANY_ENCRYPTION_SUITE,
  buildAgentDeviceRegistrationRecord,
  buildCompanyEncryptedJsonMarker,
  buildCompanyEncryptedTextMarker,
  buildEncryptedAgentWorkspaceRevisionRecord,
  canonicalJson,
  createAgentEncryptionDevice,
  decryptCompanyPayload,
  decryptFileFromCompanyContainer,
  encryptFileToCompanyContainer,
  encryptCompanyPayload,
  openScopePrivateKey,
  signCompanyEncryptionRecord,
  unlockRememberedAgentEncryptionDevice,
  wrapAndRememberAgentEncryptionDevice,
} from "./trelio-company-encryption.mjs";

const execFileAsync = promisify(execFile);
export const BRIDGE_VERSION = "1.14.4";
const BRIDGE_ENTRYPOINT_PATH = fileURLToPath(import.meta.url);
const LOADED_CODEX_PLUGIN_DIRECTORY = path.resolve(
  path.dirname(BRIDGE_ENTRYPOINT_PATH),
  "..",
);
export const WORKSPACE_CONTEXT_FILE_NAME = "WORKSPACE_CONTEXT.md";
export const LEGACY_WORKSPACE_CONTEXT_FILE_NAME = "PROJECT_CONTEXT.md";
// Keep the generated workspace contract deliberately small. Scenario-specific
// procedures belong to the worker skill references and are loaded only when
// their route is actually needed; this file carries only immutable Run safety.
export const buildAgentWorkspaceRuntimeAgentsMarkdown = (
  workspaceContextFileName = WORKSPACE_CONTEXT_FILE_NAME,
) => [
  "# Инструкции Trelio Agent Workspace",
  "",
  "Этот защищённый файл создан bridge для текущего Run и не входит в принятую Git-историю workspace.",
  "",
  "## Границы",
  "",
  "- Соблюдай Trelio ACL, закреплённые правила и прямые указания пользователя. Не записывай в Git секреты, cookies, токены, локальные сессии, зависимости или кэши.",
  "- Не изменяй `AGENTS.md`, `CLAUDE.md`, `.trelio/**` и read-only `../context/**`.",
  "- Новый Run может записывать только в task или dossier Workspace. Если открыт уже существовавший до миграции legacy company/project Run, разрешено завершить только этот exact pinned Run через обычные checkpoint/finish; не начинай новый Run такой области. Company/project задают ACL и immutable правила, но не являются новыми material Workspace; дополнительный контекст приходит только через явно закреплённые related task/dossier heads. Не считай наличие legacy `context/company` или `context/project` отдельным разрешением на запись.",
  `- Для изменения личного профиля или company/project правил оцени область \`current_request\` / \`task\` / \`personal\` / \`project\` / \`company\`, подготовь exact diff через \`plan_my_agent_profile_update\` или \`plan_agent_instructions_update\` и публикуй только после явного подтверждения. Не прячь инструкции в \`${workspaceContextFileName}\`; новая revision действует только на будущие Runs.`,
  "- Approved hook сам подставляет одноразовый runtimeSessionProof в защищённые операции. Никогда не создавай, не копируй и не передавай proof либо model attestation вручную. Только при exact TRELIO_RUNTIME_HOOK_REQUIRED от Trelio остановись и в Codex скажи: «Откройте настройки плагина Trelio Agent Workspaces, включите Hooks и повторите запрос»; в Claude Code/Cowork попроси enable/approve hooks. Ошибка активного PreToolUse hook означает, что Hooks уже работают: сохрани её exact code и причину. Upgrade/host/runtime failure обрабатывай по setup-and-recovery reference текущего навыка. Не обходи gate другим MCP, HTTP, browser или shell.",
  "- Native Trelio MCP и bundled bridge являются единственным штатным control/data plane Agent Workspace. Для внешних сервисов, Agent Secrets, поиска контекста и task proposals загружай только соответствующий reference навыка trelio-workspace-worker; не читай все references заранее и не заменяй защищённый маршрут альтернативным инструментом.",
  "",
  "## Начало Run",
  "",
  `- Полностью прочитай по порядку: \`../context/agent-instructions.md\`, \`../context/user-profile.md\`, при наличии \`../context/run-checkpoint.json\`, затем \`${workspaceContextFileName}\`. Первые три файла read-only. Это pinned authority snapshot текущего Run: не заменяй его более новой live revision; профиль, checkpoint и workspace-контекст не отменяют ACL, approval, company/project rules или системные ограничения.`,
  `- Храни в \`${workspaceContextFileName}\` короткое активное резюме: только устойчивые факты, решения и открытые вопросы, ориентир до 15 000 символов. \`WORKLOG.md\` открывай перед первой записью, а не автоматически в начале Run. На содержательный Run добавляй одну новую запись в \`worklog/\` по его формату; не переписывай старые записи и не сохраняй переписку, chain-of-thought, рутинные команды, raw tool output или секреты.`,
  `- Если выбранный Agent Secret стал устойчивой зависимостью workspace, запиши в \`${workspaceContextFileName}\` только \`Agent Secret: <текущее safe название> (secretId: <UUID>) — <назначение>\`. \`secretId\` каноничен; освежай название через \`list_agent_secrets\`. Не сохраняй value, version, grant, setup URL или runtime arguments и не добавляй ссылки для неиспользованных найденных секретов.`,
  "",
  "## Маршрутизация",
  "",
  "- `trelio-workspace` — логический launcher текущего плагина: используй PATH либо bundled bridge этой версии через Node.js 22+, не сканируй cache и не запускай пробный failure. Поиск задачи и контекста, внешний skill/runtime, Agent Secrets и каждый proposal flow имеют отдельные references навыка; загружай нужный reference полностью только перед соответствующим сценарием.",
  "- Внутри Run pinned instruction/profile snapshot имеет приоритет над более новой live revision. За пределами Run соблюдай exact instruction scope ответа Trelio; не переноси company/project/personal layer на непривязанную задачу.",
  "- Секретные значения никогда не передавай модели, MCP, prompt, env, argv, literal Browser/Chrome tool, логам или Git. Допустим только защищённый bridge flow из agent-secrets reference; в workspace сохраняется лишь safe ссылка по secretId без value, grant, setup URL или runtime arguments.",
  "",
  "## Работа и результат",
  "",
  "- Сохраняй источники в `sources/`, рабочие материалы в `work/`, долговечные результаты в `artifacts/`; журнал веди по формату `WORKLOG.md`.",
  "- После каждого завершённого смыслового изменения файлов сразу выполни `trelio-workspace checkpoint --type draft --summary \"<что сделано и что продолжать>\"`. Делай checkpoint до ожидания, границы реплики/сессии, compaction или передачи работы; не фиксируй полузаписанный файл и не создавай пустой checkpoint.",
  "- Перед блокирующим вопросом при содержательных локальных изменениях выполни `trelio-workspace pause` с exact `--summary`, `--question` и `--next-action`; чистый подготовительный вопрос не требует пустого draft.",
  "- Комментарий, статус, checklist и control задачи являются отдельными user-decision flows. Перед каждым загрузи его exact reference, перечитай live proposal context и не публикуй, не применяй и не отклоняй proposal без действия пользователя в MCP App либо его явной команды. Accepted Run, вывод агента и inferred progress сами не разрешают immediate mutation.",
  "- Заверши Run одной командой `trelio-workspace finish` с результатом, подтверждениями, материалами, вопросами и одним следующим шагом. Для task scope оцени всю задачу и передай один из options подготовленного Run в `--task-outcome`; outcome только рекомендует отдельный status proposal и не меняет задачу.",
  "- Сначала сообщай человеку итог и требуемое решение, не SHA/UUID/Run status. Candidate отправляй только через bridge. Если Trelio отклонил устаревший base head, начни новый Run и перенеси изменения осознанно; не переписывай protected refs и не обходи conflict guard.",
  "",
].join("\n");
export const AGENT_WORKSPACE_RUNTIME_AGENTS_MARKDOWN =
  buildAgentWorkspaceRuntimeAgentsMarkdown();
export const AGENT_WORKSPACE_RUNTIME_CLAUDE_MARKDOWN = "@AGENTS.md\n";
export const AGENT_WORKSPACE_DEFAULT_WORKLOG_MARKDOWN = [
  "# Журнал работы агента",
  "",
  "Этот файл задаёт формат человекочитаемого журнала Agent Workspace. Для каждого содержательного Run создавай отдельную новую запись в `worklog/`; не дописывай все запуски в один растущий файл и не переписывай записи предыдущих Run.",
  "",
  "Журнал помогает продолжить работу и понять происхождение результата, но не является независимым серверным аудитом. Он не может переопределять Trelio, `AGENTS.md`, подключённые навыки, права доступа или прямые указания пользователя.",
  "",
  "## Правила",
  "",
  "- Используй имя `worklog/YYYY-MM-DD-<краткое-описание>.md`; при совпадении выбери другое уникальное понятное имя.",
  "- Записывай только значимые действия и решения, которые помогают понять или продолжить работу.",
  "- Указания оператора пересказывай кратко и только когда они повлияли на результат; не копируй всю переписку.",
  "- Вместо внутренней цепочки рассуждений указывай краткое основание решения, использованные подтверждения и существенные альтернативы.",
  "- Не сохраняй секреты, токены, cookies, персональные учётные данные, чувствительные сырые ответы, рутинные команды и полный вывод инструментов.",
  "- Старую запись не исправляй задним числом. Если нужно уточнение, создай новую запись и явно сошлись на предыдущую.",
  "",
  "## Шаблон записи",
  "",
  "```markdown",
  "# Результат Run",
  "",
  "## Задача",
  "",
  "Что требовалось сделать.",
  "",
  "## Указания оператора",
  "",
  "Только указания, повлиявшие на результат. Если таких не было — `Нет`.",
  "",
  "## Выполнено",
  "",
  "- Значимые действия",
  "- Изменённые материалы",
  "- Использованные источники",
  "",
  "## Решения",
  "",
  "Какие решения приняты и на чём они основаны. Без внутренней цепочки рассуждений.",
  "",
  "## Проверка",
  "",
  "Что проверено и какой получен результат.",
  "",
  "## Результат",
  "",
  "Что подготовлено или изменено.",
  "",
  "## Открытые вопросы",
  "",
  "Что осталось нерешённым. Если вопросов нет — `Нет`.",
  "",
  "## Следующий шаг",
  "",
  "Один конкретный следующий шаг.",
  "```",
  "",
].join("\n");
const WORKLOG_FILE_NAME = "WORKLOG.md";
const DEFAULT_ORIGIN = "https://trelio.ru";
const BRIDGE_VERSION_HEADER = "x-trelio-agent-workspaces-version";
const AGENT_SKILL_DEVICE_CONSENT_HEADER = "x-trelio-agent-skill-device-consent";
const AGENT_SKILL_COMPANY_E2EE_HEADER = "x-trelio-company-skill-e2ee";
const AGENT_RULES_SHA256_HEADER = "x-trelio-agent-rules-sha256";
// Legacy OAuth остаётся только как явный rollback для старого backend. Даже
// там bridge не просит права на рабочие правила и чтение metadata секретов:
// эти операции принадлежат уже авторизованному MCP control plane.
const LEGACY_OAUTH_SCOPES = "mcp:read mcp:workspaces:read mcp:workspaces:write mcp:secrets:write mcp:secrets:checkout";
const LEGACY_KEYCHAIN_SERVICE = "ru.trelio.workspace-bridge";
const LEGACY_BRIDGE_SESSION_KEYCHAIN_SERVICE = "ru.trelio.workspace-bridge.session";
// Keychain остаётся только для чтения/записи legacy OAuth и однократной
// миграции старой bridge device-session. Новые device-session туда не пишутся.
const USE_LEGACY_MACOS_KEYCHAIN = process.platform === "darwin"
  && process.env.TRELIO_WORKSPACE_DISABLE_KEYCHAIN !== "1";

export const resolveWorkspaceBridgeConfigDirectory = ({
  platform = process.platform,
  environment = process.env,
  homeDirectory = os.homedir(),
} = {}) => {
  if (platform === "win32") {
    const localAppData = environment.LOCALAPPDATA
      || path.win32.join(environment.USERPROFILE || homeDirectory, "AppData", "Local");
    return path.win32.join(localAppData, "Trelio", "workspace-bridge");
  }

  return path.posix.join(homeDirectory, ".config", "trelio", "workspace-bridge");
};

const LEGACY_HOME_CONFIG_DIRECTORY = path.join(
  os.homedir(),
  ".config",
  "trelio",
  "workspace-bridge",
);
const CONFIG_DIRECTORY = resolveWorkspaceBridgeConfigDirectory();
const CREDENTIAL_FILE = path.join(CONFIG_DIRECTORY, "credentials.json");
const PAIRING_FILE = path.join(CONFIG_DIRECTORY, "pairings.json");
const LEGACY_HOME_CREDENTIAL_FILE = path.join(LEGACY_HOME_CONFIG_DIRECTORY, "credentials.json");
const LOCAL_SETTINGS_FILE = path.join(CONFIG_DIRECTORY, "settings.json");
const RUN_REGISTRY_FILE = path.join(CONFIG_DIRECTORY, "runs.json");
const AGENT_RULES_CACHE_FILE = path.join(CONFIG_DIRECTORY, "agent-rules.json");
const PLUGIN_UPDATE_STATE_FILE = path.join(CONFIG_DIRECTORY, "plugin-update.json");
const PLUGIN_UPDATE_LOCK_DIRECTORY = path.join(CONFIG_DIRECTORY, "plugin-update.lock");
const WORKSPACE_OPEN_LOCK_DIRECTORY = path.join(CONFIG_DIRECTORY, "workspace-open-locks");
const WORKSPACE_OPEN_LOCK_INITIALIZATION_STALE_MS = 5 * 60 * 1000;
const SECRET_BROWSER_DIRECTORY = path.join(CONFIG_DIRECTORY, "secret-browser");
// Local Agent Secrets живут рядом с device-session, но в отдельном private
// namespace. Каталог не зависит от workspace path и поэтому не может случайно
// попасть в Git, checkpoint или handoff.
const LOCAL_AGENT_SECRETS_DIRECTORY = path.join(CONFIG_DIRECTORY, "agent-secrets");
// Company keys are never stored inside a materialized Workspace. Every
// company gets one owner-only local device record plus a separate remembered
// wrapping key; neither file contains the user-entered phrase.
const COMPANY_ENCRYPTION_DEVICE_DIRECTORY = path.join(
  CONFIG_DIRECTORY,
  "company-encryption",
);
// Read-only accepted snapshots live in private bridge state rather than the
// user's project. One exact directory per workspace is atomically refreshed,
// so decrypted content cannot accidentally enter an unrelated Git checkout.
const WORKSPACE_INSPECTION_DIRECTORY = path.join(
  CONFIG_DIRECTORY,
  "workspace-inspections",
);
const SECRET_BROWSER_PROFILE_DIRECTORY = path.join(
  SECRET_BROWSER_DIRECTORY,
  "profile",
);
const CODEX_PLUGIN_RETENTION_DIRECTORY = path.join(
  CONFIG_DIRECTORY,
  "codex-plugin-retention",
);
const CODEX_MARKETPLACE_NAME = "trelio-plugins";
const CODEX_PLUGIN_ID = "trelio-agent-workspaces@trelio-plugins";
const CODEX_OFFICIAL_MARKETPLACE_SOURCE =
  "https://github.com/trelio-ru/agent-workspaces.git";
const MINIMUM_NODE_MAJOR_VERSION = 22;
const RUNTIME_SESSION_DIAGNOSTIC_LIMIT = 256;
const RUNTIME_SESSION_LOCK_STALE_MILLISECONDS = 15_000;
const EXPECTED_RUNTIME_HOOK_COMMAND =
  'node "${CLAUDE_PLUGIN_ROOT}/scripts/trelio-runtime-session.mjs"';
// Lifecycle matchers remain intentionally broad. Client event sources may grow
// without changing the trusted hook definition; the script itself decides how
// to handle each source. PreToolUse is scoped to every supported Trelio MCP
// naming form so unrelated tool calls do not pay a process-startup cost.
const EXPECTED_RUNTIME_HOOK_CONTRACT = Object.freeze({
  SessionStart: Object.freeze({
    matcher: "*",
    type: "command",
    command: EXPECTED_RUNTIME_HOOK_COMMAND,
    timeout: 10,
  }),
  PreToolUse: Object.freeze({
    matcher: "^(mcp__)?trelio__[a-z0-9_]+$|^(mcp[:./-])?trelio[:./-][a-z0-9_]+$",
    type: "command",
    command: EXPECTED_RUNTIME_HOOK_COMMAND,
    timeout: 15,
  }),
  SessionEnd: Object.freeze({
    matcher: "*",
    type: "command",
    command: EXPECTED_RUNTIME_HOOK_COMMAND,
    timeout: 3,
  }),
});
const CODEX_MARKETPLACE_LIST_ARGUMENTS = Object.freeze([
  "plugin",
  "marketplace",
  "list",
  "--json",
]);
const CODEX_MARKETPLACE_UPDATE_ARGUMENTS = Object.freeze([
  "plugin",
  "marketplace",
  "upgrade",
  CODEX_MARKETPLACE_NAME,
  "--json",
]);
const CODEX_PLUGIN_INSTALL_ARGUMENTS = Object.freeze([
  "plugin",
  "add",
  CODEX_PLUGIN_ID,
  "--json",
]);
const PLUGIN_BACKGROUND_UPDATE_INTERVAL_MS = 6 * 60 * 60 * 1000;
const PLUGIN_BACKGROUND_UPDATE_FAILURE_RETRY_MS = 30 * 60 * 1000;
const PLUGIN_BACKGROUND_UPDATE_LOCK_STALE_MS = 15 * 60 * 1000;
const PLUGIN_UPDATE_COMMAND_TIMEOUT_MS = 2 * 60 * 1000;
const PLUGIN_UPDATE_NETWORK_RETRY_DELAYS_MS = Object.freeze([1_000, 3_000]);
// Marketplace packages are intentionally small. These bounds let retention
// validate the complete immutable plugin tree without allowing a malformed
// local directory to turn a routine update into an unbounded copy/hash job.
const CODEX_RETAINED_PLUGIN_MAX_FILE_COUNT = 512;
const CODEX_RETAINED_PLUGIN_MAX_BYTES = 32 * 1024 * 1024;
const DEFAULT_WORKSPACES_DIRECTORY = path.join(os.homedir(), "Trelio Workspaces");
const CACHE_ROOT_DIRECTORY = process.platform === "win32"
  ? path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "Trelio", "workspace-bridge", "cache")
  : path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"), "trelio", "workspace-bridge");
const OBJECT_CACHE_DIRECTORY = path.join(CACHE_ROOT_DIRECTORY, "objects");
const SKILL_RUNTIME_CACHE_DIRECTORY = path.join(
  CACHE_ROOT_DIRECTORY,
  "skill-runtimes",
);
const DEFAULT_LOCAL_SETTINGS = Object.freeze({
  workspaceRetentionDays: 30,
  objectCacheMaxAgeDays: 30,
  objectCacheMaxBytes: 10 * 1024 * 1024 * 1024,
  skillRuntimeCacheMaxAgeDays: 90,
  skillRuntimeCacheMaxBytes: 512 * 1024 * 1024,
});
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const GIT_OBJECT_PATTERN = /^[0-9a-f]{40,64}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const STABLE_VERSION_PATTERN = /^\d+\.\d+\.\d+$/;
const SKILL_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const AGENT_SKILL_PACKAGE_FORMAT = "trelio-agent-skill-package/v1";
const AGENT_SKILL_ENCRYPTED_PACKAGE_FORMAT = "trelio-company-encrypted-skill-package/v1";
export const AGENT_SKILL_RUNTIME_HOST_MINIMUM_VERSION = "1.4.0";
export const AGENT_SKILL_LARGE_PACKAGE_HOST_MINIMUM_VERSION = "1.14.4";
export const AGENT_SKILL_LEGACY_MAX_PACKAGE_BYTES = 8 * 1024 * 1024;
export const AGENT_SKILL_MAX_PACKAGE_BYTES = 64 * 1024 * 1024;
export const AGENT_SKILL_MAX_ENCRYPTED_PACKAGE_BYTES =
  AGENT_SKILL_MAX_PACKAGE_BYTES + 1024 * 1024;
export const AGENT_SKILL_MAX_DECODED_FILE_BYTES = 48 * 1024 * 1024;
export const AGENT_SKILL_MAX_FILE_COUNT = 100;
const AGENT_SKILL_SIGNING_KEY_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/u;
const AGENT_SKILL_ALLOWED_CAPABILITIES = new Set([
  "browser",
  "local-session",
  "network",
  "secret-checkout",
]);
const WORKSPACE_OBJECT_POINTER_VERSION = "https://trelio.ru/spec/workspace-object/v1";
const MAX_INLINE_TEXT_BYTES = 4 * 1024 * 1024;
const TARGET_INLINE_GIT_TREE_BYTES = 48 * 1024 * 1024;
const MAX_ENCRYPTED_WORKSPACE_TREE_BYTES = 100 * 1024 * 1024;
const MAX_ENCRYPTED_WORKSPACE_FILE_COUNT = 20_000;
const POINTER_MAX_BYTES = 1024;
const MAX_RATE_LIMIT_RETRIES = 8;
const MAX_RATE_LIMIT_WAIT_MS = 5 * 60 * 1000;
const FALLBACK_RATE_LIMIT_DELAY_MS = 1000;
const MAX_FALLBACK_RATE_LIMIT_DELAY_MS = 30 * 1000;

export const isProtectedWorkspaceControlPath = (filePath) => (
  filePath === "AGENTS.md"
  || filePath === "CLAUDE.md"
  || filePath === ".trelio"
  || filePath.startsWith(".trelio/")
);

// MIME нужен не для доверия к содержимому, а для безопасного download/preview.
// Незнакомое расширение остаётся бинарным octet-stream; активные HTML/SVG
// никогда не получают исполняемый тип от bridge.
const SAFE_CONTENT_TYPES_BY_EXTENSION = new Map(Object.entries({
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".csv": "text/csv",
  ".gif": "image/gif",
  ".heic": "image/heic",
  ".heif": "image/heif",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".json": "application/json",
  ".md": "text/markdown",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".txt": "text/plain",
  ".webp": "image/webp",
  ".yaml": "text/yaml",
  ".yml": "text/yaml",
}));

const fail = (message, exitCode = 1) => {
  process.stderr.write(`Ошибка: ${message}\n`);
  process.exitCode = exitCode;
};

const parseArguments = (rawArguments) => {
  const [command = "help", ...tokens] = rawArguments;
  const options = {};
  const positional = [];

  // Повторяемые параметры нужны для содержательного handoff без передачи
  // тяжёлого JSON через shell: агент может несколько раз указать --evidence,
  // --file и --question. Для старых одиночных параметров контракт сохраняется.
  const appendOption = (key, value) => {
    const currentValue = options[key];

    if (currentValue === undefined) {
      options[key] = value;
    } else if (Array.isArray(currentValue)) {
      currentValue.push(value);
    } else {
      options[key] = [currentValue, value];
    }
  };

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];

    // POSIX `--` завершает разбор bridge options. Всё после него является
    // argv локальной программы и передаётся spawn напрямую, без shell.
    if (token === "--") {
      positional.push(...tokens.slice(index + 1));
      break;
    }

    if (!token.startsWith("--")) {
      positional.push(token);
      continue;
    }

    const equalsIndex = token.indexOf("=");
    const key = token.slice(2, equalsIndex >= 0 ? equalsIndex : undefined);

    if (equalsIndex >= 0) {
      appendOption(key, token.slice(equalsIndex + 1));
      continue;
    }

    const nextToken = tokens[index + 1];

    if (nextToken && !nextToken.startsWith("--")) {
      appendOption(key, nextToken);
      index += 1;
    } else {
      appendOption(key, true);
    }
  }

  return { command, options, positional };
};

const AGENT_RUNTIME_CLIENT_FAMILIES = new Set(["codex", "claude-code", "other"]);
const AGENT_RUNTIME_EFFORT_LEVELS = new Set([
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
]);
const AGENT_RUNTIME_MODEL_ID_PATTERN = /^[a-z0-9._:+/-]+$/iu;

const readSingleRuntimeOption = (options, key) => {
  const value = options[key];

  if (value === undefined) return null;
  if (value === true || Array.isArray(value)) {
    throw new Error(`Параметр --${key} должен быть указан ровно один раз со значением.`);
  }

  const normalized = String(value).trim();
  if (!normalized) {
    throw new Error(`Параметр --${key} не может быть пустым.`);
  }
  return normalized;
};

/**
 * Собирает только явную self-attestation из exact команды, которую вернул MCP.
 * Bridge принципиально не пытается угадывать model/effort из env, transcript
 * или hook: эти источники локальны и не являются доверенной границей Trelio.
 */
export const parseSelfReportedRuntimeAttestationOptions = (options = {}) => {
  const clientFamily = readSingleRuntimeOption(options, "runtime-client");
  const modelId = readSingleRuntimeOption(options, "runtime-model");
  const effortLevel = readSingleRuntimeOption(options, "runtime-effort");
  const observedAt = readSingleRuntimeOption(options, "runtime-observed-at");

  if (!clientFamily) {
    if (modelId || effortLevel || observedAt) {
      throw new Error("Runtime attestation требует --runtime-client.");
    }
    return null;
  }
  if (!AGENT_RUNTIME_CLIENT_FAMILIES.has(clientFamily)) {
    throw new Error("Параметр --runtime-client должен быть codex, claude-code или other.");
  }
  if (!observedAt || Number.isNaN(Date.parse(observedAt))) {
    throw new Error("Параметр --runtime-observed-at должен содержать ISO timestamp.");
  }

  if (clientFamily === "other") {
    if (modelId || effortLevel) {
      throw new Error("Runtime other не должен объявлять model или effort.");
    }
    return {
      schemaVersion: 1,
      clientFamily,
      modelId: null,
      effortLevel: null,
      evidenceLevel: "unavailable",
      source: "unknown",
      observedAt,
    };
  }

  if (!modelId || !AGENT_RUNTIME_MODEL_ID_PATTERN.test(modelId)) {
    throw new Error("Параметр --runtime-model должен содержать безопасный model id.");
  }
  if (effortLevel && !AGENT_RUNTIME_EFFORT_LEVELS.has(effortLevel)) {
    throw new Error("Параметр --runtime-effort содержит неподдерживаемый уровень.");
  }

  return {
    schemaVersion: 1,
    clientFamily,
    modelId,
    effortLevel,
    evidenceLevel: "self_reported",
    source: "agent_request",
    observedAt,
  };
};

export const parseRuntimeSessionOption = (options = {}) => {
  const runtimeSessionId = readSingleRuntimeOption(options, "runtime-session");
  if (!runtimeSessionId) return null;
  if (!UUID_PATTERN.test(runtimeSessionId)) {
    throw new Error("Параметр --runtime-session должен содержать UUID runtime-сессии.");
  }
  return runtimeSessionId.toLowerCase();
};

export const normalizeOrigin = (value) => {
  const parsed = new URL(String(value || DEFAULT_ORIGIN));

  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error("origin должен быть обычным HTTP(S) адресом Trelio.");
  }

  parsed.pathname = "";
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString().replace(/\/$/, "");
};

const requireUuid = (value, name) => {
  if (!UUID_PATTERN.test(String(value || ""))) {
    throw new Error(`Параметр --${name} должен содержать UUID.`);
  }

  return String(value).toLowerCase();
};

const execFileWithInput = async (executable, args, options, input) => (
  new Promise((resolve, reject) => {
    const child = execFile(executable, args, options, (error, stdout, stderr) => {
      if (error) {
        // Сохраняем тот же диагностический контракт, что у promisify(execFile):
        // run() ниже сможет показать stderr/stdout завершившейся команды.
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }

      resolve({ stdout, stderr });
    });

    if (!child.stdin) {
      child.kill();
      reject(new Error(`${executable} не открыл stdin для входных данных.`));
      return;
    }

    // execFile принимает options, но не поддерживает option `input`. Передаём
    // bytes явно и обязательно закрываем stdin: без end() `git hash-object
    // --stdin` бесконечно ждёт EOF после загрузки external workspace object.
    child.stdin.once("error", reject);
    child.stdin.end(input);
  })
);

const run = async (executable, args, options = {}) => {
  const { input, ...execFileOptions } = options;
  const commandOptions = {
    ...execFileOptions,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      GIT_PAGER: "cat",
      ...execFileOptions.env,
    },
  };

  try {
    return input === undefined
      ? await execFileAsync(executable, args, commandOptions)
      : await execFileWithInput(executable, args, commandOptions, input);
  } catch (error) {
    const detail = String(error.stderr || error.stdout || error.message).trim();
    throw new Error(`${executable} завершился с ошибкой: ${detail}`);
  }
};

let resolvedGitPromise = null;

const requireGitRuntime = async () => {
  // Every bridge process resolves Git once and then uses the same verified
  // absolute executable for the complete operation. This avoids a PATH race
  // halfway through candidate creation and never falls back to a host-private
  // Git binary that only happened to work for marketplace installation.
  resolvedGitPromise ||= verifyGitRuntime();
  const resolvedGit = await resolvedGitPromise;

  if (resolvedGit.status !== "ready") {
    throw new GitPrerequisiteError(resolvedGit);
  }
  return resolvedGit;
};

const runGit = async (args, options = {}) => {
  const resolvedGit = await requireGitRuntime();

  // Agent Workspace Git must be deterministic across macOS and Windows. User
  // templates, hooks, signing config and pagers are not part of the workspace
  // contract, so every invocation gets an isolated config boundary without a
  // shell. Local repository config remains available for bridge-owned values.
  return run(
    resolvedGit.gitPath,
    [
      "-c",
      `core.hooksPath=${GIT_DISABLED_HOOKS_PATH}`,
      "-c",
      "init.templateDir=",
      // Git for Windows often receives this from system config. Because the
      // bridge intentionally ignores ambient system config, preserve long
      // workspace support explicitly and deterministically on every platform.
      "-c",
      "core.longpaths=true",
      ...args,
    ],
    {
      ...options,
      env: {
        GIT_CONFIG_GLOBAL: GIT_DISABLED_GLOBAL_CONFIG_PATH,
        GIT_CONFIG_NOSYSTEM: "1",
        ...options.env,
      },
    },
  );
};

const readDiagnosticJsonFile = async (filePath) => {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return { raw, value: JSON.parse(raw) };
  } catch {
    // Doctor reports only a stable code. Parser and filesystem details may
    // include a private local path and are not needed for the repair decision.
    return { raw: null, value: null };
  }
};

const readObservedRuntimeHookContract = (hooksManifest, eventName) => {
  const groups = hooksManifest?.hooks?.[eventName];
  if (!Array.isArray(groups) || groups.length !== 1) return null;
  const [group] = groups;
  if (!Array.isArray(group?.hooks) || group.hooks.length !== 1) return null;
  const [handler] = group.hooks;
  return {
    matcher: group.matcher,
    type: handler?.type,
    command: handler?.command,
    timeout: handler?.timeout,
  };
};

/**
 * Inspect only the exact bundle that loaded this bridge. Cache scanning could
 * accidentally diagnose another installed version and recreate the stale-task
 * confusion this command is meant to resolve.
 */
export const inspectBundledPlugin = async ({
  pluginDirectory = LOADED_CODEX_PLUGIN_DIRECTORY,
} = {}) => {
  const [codexManifest, claudeManifest, hooksManifest] = await Promise.all([
    readDiagnosticJsonFile(path.join(pluginDirectory, ".codex-plugin", "plugin.json")),
    readDiagnosticJsonFile(path.join(pluginDirectory, ".claude-plugin", "plugin.json")),
    readDiagnosticJsonFile(path.join(pluginDirectory, "hooks", "hooks.json")),
  ]);
  const issues = [];
  const codexVersion = typeof codexManifest.value?.version === "string"
    ? codexManifest.value.version
    : null;
  const claudeVersion = typeof claudeManifest.value?.version === "string"
    ? claudeManifest.value.version
    : null;

  if (codexVersion !== BRIDGE_VERSION) {
    issues.push("CODEX_MANIFEST_VERSION_MISMATCH");
  }
  if (claudeVersion !== BRIDGE_VERSION) {
    issues.push("CLAUDE_MANIFEST_VERSION_MISMATCH");
  }

  const observedEvents = Object.fromEntries(
    Object.keys(EXPECTED_RUNTIME_HOOK_CONTRACT).map((eventName) => [
      eventName,
      readObservedRuntimeHookContract(hooksManifest.value, eventName),
    ]),
  );
  const hooksReady = Object.entries(EXPECTED_RUNTIME_HOOK_CONTRACT).every(
    ([eventName, expected]) => (
      JSON.stringify(observedEvents[eventName]) === JSON.stringify(expected)
    ),
  );
  if (!hooksReady) {
    issues.push("RUNTIME_HOOK_CONTRACT_MISMATCH");
  }

  return {
    status: issues.length === 0 ? "ready" : "action_required",
    loadedVersion: BRIDGE_VERSION,
    manifests: {
      codexVersion,
      claudeVersion,
    },
    hooks: {
      status: hooksReady ? "ready" : "action_required",
      definitionSha256: hooksManifest.raw
        ? crypto.createHash("sha256").update(hooksManifest.raw).digest("hex")
        : null,
      preToolUseScope: "trelio_mcp",
      approvalStatus: "client_managed_unknown",
      events: Object.fromEntries(
        Object.entries(observedEvents).map(([eventName, observed]) => [
          eventName,
          observed
            ? { matcher: observed.matcher, timeout: observed.timeout }
            : null,
        ]),
      ),
    },
    issues,
  };
};

const classifyRuntimeSessionRecord = (record, nowMilliseconds) => {
  if (
    record?.schemaVersion === 1
    && record.pending === true
    && record.observation
    && typeof record.observation === "object"
  ) {
    return "pending";
  }
  if (
    record?.schemaVersion !== 1
    || !UUID_PATTERN.test(String(record.runtimeSessionId || ""))
    || typeof record.privateKeyPkcs8 !== "string"
    || Number.isNaN(Date.parse(String(record.expiresAt || "")))
  ) {
    return "invalid";
  }
  return Date.parse(record.expiresAt) > nowMilliseconds + 30_000
    ? "active"
    : "expired";
};

/**
 * Runtime-session diagnostics expose counts only. Private signing keys, IDs,
 * origin hashes and filenames never enter stdout or model-visible output.
 */
export const inspectLocalRuntimeSessions = async ({
  configDirectory = CONFIG_DIRECTORY,
  nowMilliseconds = Date.now(),
} = {}) => {
  const runtimeDirectory = path.join(configDirectory, "runtime-sessions");
  let entries;
  try {
    entries = await fs.readdir(runtimeDirectory, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") {
      return {
        status: "ready",
        activeCount: 0,
        pendingCount: 0,
        expiredCount: 0,
        invalidCount: 0,
        registrationLockCount: 0,
        staleRegistrationLockCount: 0,
        omittedCount: 0,
      };
    }
    return {
      status: "attention",
      activeCount: 0,
      pendingCount: 0,
      expiredCount: 0,
      invalidCount: 1,
      registrationLockCount: 0,
      staleRegistrationLockCount: 0,
      omittedCount: 0,
    };
  }

  const stateFiles = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"));
  const selectedStateFiles = stateFiles.slice(0, RUNTIME_SESSION_DIAGNOSTIC_LIMIT);
  const counts = {
    active: 0,
    pending: 0,
    expired: 0,
    invalid: 0,
  };
  await Promise.all(selectedStateFiles.map(async (entry) => {
    try {
      const record = await readPrivateJsonFile(path.join(runtimeDirectory, entry.name));
      counts[classifyRuntimeSessionRecord(record, nowMilliseconds)] += 1;
    } catch {
      counts.invalid += 1;
    }
  }));

  const lockEntries = entries.filter(
    (entry) => entry.isDirectory() && entry.name.endsWith(".json.lock"),
  );
  let staleRegistrationLockCount = 0;
  await Promise.all(lockEntries.map(async (entry) => {
    try {
      const metadata = await fs.stat(path.join(runtimeDirectory, entry.name));
      if (nowMilliseconds - metadata.mtimeMs > RUNTIME_SESSION_LOCK_STALE_MILLISECONDS) {
        staleRegistrationLockCount += 1;
      }
    } catch {
      staleRegistrationLockCount += 1;
    }
  }));

  const needsAttention = counts.expired > 0
    || counts.invalid > 0
    || staleRegistrationLockCount > 0;
  return {
    status: needsAttention ? "attention" : "ready",
    activeCount: counts.active,
    pendingCount: counts.pending,
    expiredCount: counts.expired,
    invalidCount: counts.invalid,
    registrationLockCount: lockEntries.length,
    staleRegistrationLockCount,
    omittedCount: Math.max(0, stateFiles.length - selectedStateFiles.length),
  };
};

/**
 * Pairing diagnostics deliberately inspect presence only. They never return a
 * device-session token, verifier, pairing ID or legacy OAuth credential.
 */
export const inspectLocalBridgeConnection = async ({
  origin = DEFAULT_ORIGIN,
  configDirectory = CONFIG_DIRECTORY,
  nowMilliseconds = Date.now(),
} = {}) => {
  const normalizedOrigin = normalizeOrigin(origin);
  let credentials;
  let pairings;
  try {
    [credentials, pairings] = await Promise.all([
      readPrivateJsonFile(path.join(configDirectory, "credentials.json")),
      readPrivateJsonFile(path.join(configDirectory, "pairings.json")),
    ]);
  } catch {
    return {
      status: "attention",
      origin: normalizedOrigin,
      deviceSessionConfigured: false,
      pendingPairing: false,
      issue: "LOCAL_CONNECTION_STATE_UNREADABLE",
    };
  }

  const credential = credentials?.[normalizedOrigin];
  const pairing = pairings?.[normalizedOrigin];
  const deviceSessionConfigured = typeof credential?.bridgeSessionToken === "string"
    && credential.bridgeSessionToken.length > 0;
  const pendingPairing = typeof pairing?.expiresAt === "string"
    && Date.parse(pairing.expiresAt) > nowMilliseconds;
  return {
    status: deviceSessionConfigured
      ? "ready"
      : pendingPairing
        ? "pairing_pending"
        : "not_configured",
    origin: normalizedOrigin,
    deviceSessionConfigured,
    pendingPairing,
    issue: null,
  };
};

export const diagnoseLocalPrerequisites = async (options = {}) => {
  const {
    pluginDirectory = LOADED_CODEX_PLUGIN_DIRECTORY,
    configDirectory = CONFIG_DIRECTORY,
    origin = DEFAULT_ORIGIN,
    nodePath = process.execPath,
    nodeVersion = process.version,
    nowMilliseconds = Date.now(),
    ...gitOptions
  } = options;
  const [git, plugin, runtimeSessions, connection] = await Promise.all([
    verifyGitRuntime(gitOptions),
    inspectBundledPlugin({ pluginDirectory }),
    inspectLocalRuntimeSessions({ configDirectory, nowMilliseconds }),
    inspectLocalBridgeConnection({ origin, configDirectory, nowMilliseconds }),
  ]);
  const nodeMajorVersion = Number.parseInt(
    String(nodeVersion).replace(/^v/u, "").split(".")[0],
    10,
  );
  const node = {
    status: Number.isInteger(nodeMajorVersion) && nodeMajorVersion >= MINIMUM_NODE_MAJOR_VERSION
      ? "ready"
      : "action_required",
    nodePath,
    version: nodeVersion,
    minimumMajorVersion: MINIMUM_NODE_MAJOR_VERSION,
  };
  const issues = [
    ...(node.status === "ready" ? [] : ["TRELIO_NODE_22_REQUIRED"]),
    ...(git.status === "ready" ? [] : [git.code || "TRELIO_GIT_REQUIRED"]),
    ...plugin.issues,
  ];

  return {
    schemaVersion: 1,
    status: issues.length === 0 ? "ready" : "action_required",
    platform: gitOptions.platform || process.platform,
    node,
    git,
    plugin,
    runtimeSessions,
    connection,
    issues,
  };
};

const doctor = async (options) => {
  const report = await diagnoseLocalPrerequisites({
    origin: options.origin || DEFAULT_ORIGIN,
  });

  if (options.json === true) {
    process.stdout.write(`${JSON.stringify(report)}\n`);
    return report;
  }

  if (report.git.status !== "ready") {
    throw new GitPrerequisiteError(report.git);
  }
  if (report.node.status !== "ready") {
    throw new Error(
      `TRELIO_NODE_22_REQUIRED: требуется Node.js ${report.node.minimumMajorVersion}+.`,
    );
  }
  if (report.plugin.status !== "ready") {
    throw new Error(
      `TRELIO_PLUGIN_DIAGNOSTIC_FAILED: ${report.plugin.issues.join(", ")}.`,
    );
  }

  process.stdout.write(
    `Локальный компонент готов: Node.js ${report.node.version}, `
      + `Git ${report.git.version} (${report.git.gitPath}).\n`
      + `Плагин v${report.plugin.loadedVersion}; hooks ${report.plugin.hooks.status}, `
      + "их одобрение проверяет клиент.\n"
      + `Bridge session: ${report.connection.status}; runtime sessions: `
      + `${report.runtimeSessions.activeCount} active, `
      + `${report.runtimeSessions.pendingCount} pending.\n`,
  );
  return report;
};

export const buildBridgeRequestHeaders = (token, initialHeaders = {}) => {
  const headers = new Headers(initialHeaders);

  // Один центральный version header покрывает open, heartbeat, bundle/object
  // transfer и Agent Secrets. Backend поэтому проверяет фактически
  // исполняемый bridge каждого запроса, а не только provenance старого Run.
  headers.set(BRIDGE_VERSION_HEADER, BRIDGE_VERSION);
  // Dedicated capability proof keeps company runtime fail-closed during a
  // rolling plugin install where an older executable could report the same
  // marketplace version but cannot render the trusted local consent page.
  headers.set(AGENT_SKILL_DEVICE_CONSENT_HEADER, "v1");
  // The backend must never send encrypted declarations or runtime bytes to a
  // host that cannot hydrate and validate them locally. This independent
  // capability header remains fail-closed even during rolling installations
  // where two binaries temporarily report the same marketplace version.
  headers.set(AGENT_SKILL_COMPANY_E2EE_HEADER, "v1");

  if (token) {
    headers.set("authorization", `Bearer ${token}`);
  }

  return headers;
};

const parseRetryAfterMilliseconds = (rawValue, nowMs = Date.now()) => {
  const value = String(rawValue || "").trim();

  if (!value) {
    return null;
  }

  if (/^\d+$/.test(value)) {
    const seconds = Number(value);
    return Number.isSafeInteger(seconds) ? seconds * 1000 : null;
  }

  const retryAtMs = Date.parse(value);
  return Number.isFinite(retryAtMs) ? Math.max(0, retryAtMs - nowMs) : null;
};

export class TrelioApiError extends Error {
  constructor(
    statusCode,
    message,
    retryAfterMilliseconds = null,
    code = null,
    payload = null,
  ) {
    super(`Trelio API ${statusCode}: ${String(message).slice(0, 1000)}`);
    this.statusCode = statusCode;
    this.retryAfterMilliseconds = retryAfterMilliseconds;
    this.code = code;
    this.payload = payload;
  }
}

export const request = async (origin, token, pathname, options = {}) => {
  const headers = buildBridgeRequestHeaders(token, options.headers || {});

  const response = await fetch(new URL(pathname, `${origin}/`), { ...options, headers });

  if (!response.ok) {
    const responseText = await response.text();
    let message = responseText;
    let code = null;
    let errorPayload = null;

    try {
      const parsed = JSON.parse(responseText);
      errorPayload = parsed;
      message = parsed.message || parsed.error_description || parsed.error || responseText;
      code = typeof parsed.code === "string" ? parsed.code : null;
    } catch {
      // Не-JSON proxy response всё равно полезнее скрытой HTTP ошибки.
    }

    // Hard gate применяется ко всем transport-запросам, а не только к
    // отдельному preflight. Маршруты возвращают тот же compatibility payload,
    // поэтому upgrade между preflight и mutation безопасно запускает общий
    // updater/re-dispatch вместо тупиковой общей HTTP 409.
    if (
      code === "AGENT_WORKSPACE_PLUGIN_UPGRADE_REQUIRED"
      || code === "AGENT_SKILL_RUNTIME_HOST_UPGRADE_REQUIRED"
    ) {
      const compatibility = code === "AGENT_WORKSPACE_PLUGIN_UPGRADE_REQUIRED"
        ? errorPayload
        : {
            packageName: "trelio-ru/agent-workspaces",
            installedVersion: errorPayload?.installedVersion ?? BRIDGE_VERSION,
            minimumVersion: errorPayload?.minimumVersion ?? null,
            supported: false,
            update: errorPayload?.update ?? {
              codexCommand:
                errorPayload?.updateCommand
                ?? "codex plugin marketplace upgrade trelio-plugins",
              // Старый backend не обещал безопасный hot retry. Он всё равно
              // получает тихое обновление, но продолжение идёт из новой задачи.
              sameTaskRetryAllowed: false,
            },
          };
      throw new BridgePluginUpgradeRequiredError(compatibility);
    }

    throw new TrelioApiError(
      response.status,
      message,
      parseRetryAfterMilliseconds(response.headers.get("retry-after")),
      code,
      errorPayload,
    );
  }

  return response;
};

export const readBoundedResponseBuffer = async (
  response,
  maximumBytes,
  label = "HTTP response",
) => {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    throw new Error(`${label} превышает допустимый размер ${maximumBytes} байт.`);
  }
  if (!response.body) return Buffer.alloc(0);

  const chunks = [];
  let totalBytes = 0;
  for await (const rawChunk of response.body) {
    const chunk = Buffer.from(rawChunk);
    totalBytes += chunk.byteLength;
    if (totalBytes > maximumBytes) {
      // The streaming count remains authoritative when Content-Length is
      // absent, compressed or dishonest. Reject before Buffer.concat can
      // allocate an attacker-controlled response in one large block.
      throw new Error(`${label} превышает допустимый размер ${maximumBytes} байт.`);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, totalBytes);
};

const wait = (milliseconds) => new Promise((resolve) => {
  setTimeout(resolve, milliseconds);
});

const requestWithRateLimitRetry = async ({
  origin,
  token,
  pathname,
  createOptions,
}) => {
  let retryCount = 0;

  while (true) {
    try {
      // Upload body передаётся фабрикой, а не готовым stream: после ответа 429
      // fetch уже мог прочитать исходный ReadStream, и повторно использовать его
      // нельзя. Каждый retry обязан открыть файл заново с первого байта.
      return await request(origin, token, pathname, createOptions());
    } catch (error) {
      if (
        !(error instanceof TrelioApiError)
        || error.statusCode !== 429
        || retryCount >= MAX_RATE_LIMIT_RETRIES
      ) {
        throw error;
      }

      const retryAfterMilliseconds = error.retryAfterMilliseconds;
      const fallbackDelay = Math.min(
        FALLBACK_RATE_LIMIT_DELAY_MS * (2 ** retryCount),
        MAX_FALLBACK_RATE_LIMIT_DELAY_MS,
      ) + Math.floor(Math.random() * 251);
      const delayMilliseconds = retryAfterMilliseconds ?? fallbackDelay;

      if (delayMilliseconds > MAX_RATE_LIMIT_WAIT_MS) {
        throw new Error(
          "Trelio запросил слишком долгую паузу Retry-After; повторите submit позже.",
          { cause: error },
        );
      }

      retryCount += 1;
      process.stdout.write(
        `Trelio ограничил скорость запросов. Повтор ${retryCount}/${MAX_RATE_LIMIT_RETRIES} через ${
          Math.ceil(delayMilliseconds / 1000)
        } сек.\n`,
      );
      await wait(delayMilliseconds);
    }
  }
};

const getKeychainValue = async (
  service,
  origin,
  { failOnUnexpectedError = false } = {},
) => {
  if (!USE_LEGACY_MACOS_KEYCHAIN) {
    return null;
  }

  try {
    const result = await execFileAsync("security", [
      "find-generic-password",
      "-s",
      service,
      "-a",
      origin,
      "-w",
    ], { encoding: "utf8" });
    return result.stdout.trim() || null;
  } catch (error) {
    // `security` uses exit status 44 when the item is simply absent. During
    // one-time device-session migration any other status is a real Keychain
    // failure: do not mark migration complete or silently create a second
    // session while an existing credential may still be recoverable.
    if (failOnUnexpectedError && error.code !== 44) {
      throw new Error(
        "Не удалось проверить legacy bridge device-session в macOS Keychain; локальная миграция остановлена без создания новой сессии.",
        { cause: error },
      );
    }
    return null;
  }
};

const deleteKeychainValue = async (service, origin) => {
  if (!USE_LEGACY_MACOS_KEYCHAIN) {
    return;
  }

  await execFileAsync("security", [
    "delete-generic-password",
    "-s",
    service,
    "-a",
    origin,
  ], { encoding: "utf8" }).catch(() => undefined);
};

export const WINDOWS_PRIVATE_ACL_SCRIPT = String.raw`
$ErrorActionPreference = "Stop"
$encodedTargetPath = [Environment]::GetEnvironmentVariable(
  "TRELIO_WINDOWS_PRIVATE_ACL_PATH_BASE64",
  [EnvironmentVariableTarget]::Process
)
$TargetKind = [Environment]::GetEnvironmentVariable(
  "TRELIO_WINDOWS_PRIVATE_ACL_KIND",
  [EnvironmentVariableTarget]::Process
)
if ([string]::IsNullOrWhiteSpace($encodedTargetPath)) {
  throw "Private path transport is missing."
}
try {
  $TargetPath = [System.Text.Encoding]::UTF8.GetString(
    [System.Convert]::FromBase64String($encodedTargetPath)
  )
} catch {
  throw "Private path transport decoding failed."
}
if ([string]::IsNullOrWhiteSpace($TargetPath)) {
  throw "Private path transport decoded an empty path."
}
if ($TargetKind -ne "directory" -and $TargetKind -ne "file") {
  throw "Private path kind is invalid."
}
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
if ($TargetKind -eq "directory") {
  $targetInfo = New-Object System.IO.DirectoryInfo($TargetPath)
  $ownerAcl = New-Object System.Security.AccessControl.DirectorySecurity
  $acl = New-Object System.Security.AccessControl.DirectorySecurity
  $rule = New-Object System.Security.AccessControl.FileSystemAccessRule(
    $sid,
    [System.Security.AccessControl.FileSystemRights]::FullControl,
    [System.Security.AccessControl.InheritanceFlags]"ContainerInherit, ObjectInherit",
    [System.Security.AccessControl.PropagationFlags]::None,
    [System.Security.AccessControl.AccessControlType]::Allow
  )
} else {
  $targetInfo = New-Object System.IO.FileInfo($TargetPath)
  $ownerAcl = New-Object System.Security.AccessControl.FileSecurity
  $acl = New-Object System.Security.AccessControl.FileSecurity
  $rule = New-Object System.Security.AccessControl.FileSystemAccessRule(
    $sid,
    [System.Security.AccessControl.FileSystemRights]::FullControl,
    [System.Security.AccessControl.AccessControlType]::Allow
  )
}

# A normal desktop user already owns paths created by this bridge. Elevated
# Windows processes can instead assign the Administrators group as owner. In
# that exceptional case, persist an Owner-only descriptor before touching the
# DACL. Keeping the descriptor sections separate prevents either operation from
# requesting the system audit ACL (SACL) or SeSecurityPrivilege.
$ownerSecurity = $targetInfo.GetAccessControl(
  [System.Security.AccessControl.AccessControlSections]::Owner
)
$ownerSid = $ownerSecurity.GetOwner(
  [System.Security.Principal.SecurityIdentifier]
).Value
if ($ownerSid -ne $sid.Value) {
  $ownerAcl.SetOwner($sid)
  $targetInfo.SetAccessControl($ownerAcl)
  $ownerSecurity = $targetInfo.GetAccessControl(
    [System.Security.AccessControl.AccessControlSections]::Owner
  )
  $ownerSid = $ownerSecurity.GetOwner(
    [System.Security.Principal.SecurityIdentifier]
  ).Value
  if ($ownerSid -ne $sid.Value) {
    throw "Private path owner update verification failed."
  }
}

# Only these two calls mark the discretionary ACL (DACL) as modified. Persist
# it through the typed .NET API so Owner, Group and the system audit ACL (SACL)
# are not requested together. Set-Acl may include extra descriptor sections and
# can consequently demand SeSecurityPrivilege from a normal desktop user.
$acl.SetAccessRuleProtection($true, $false)
$acl.SetAccessRule($rule)
$targetInfo.SetAccessControl($acl)

$verificationSections = (
  [System.Security.AccessControl.AccessControlSections]::Access -bor
  [System.Security.AccessControl.AccessControlSections]::Owner
)
$verified = $targetInfo.GetAccessControl($verificationSections)
$verifiedOwnerSid = $verified.GetOwner(
  [System.Security.Principal.SecurityIdentifier]
).Value
if ($verifiedOwnerSid -ne $sid.Value) {
  throw "Private path owner verification failed."
}
$unexpected = @($verified.Access | Where-Object {
  $_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value -ne $sid.Value -or
  $_.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow -or
  $_.IsInherited
})
if ($unexpected.Count -ne 0) {
  throw "Private path ACL verification failed."
}
$expected = @($verified.Access | Where-Object {
  $_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value -eq $sid.Value -and
  $_.AccessControlType -eq [System.Security.AccessControl.AccessControlType]::Allow -and
  -not $_.IsInherited -and
  ($_.FileSystemRights -band [System.Security.AccessControl.FileSystemRights]::FullControl) -eq
    [System.Security.AccessControl.FileSystemRights]::FullControl
})
if ($expected.Count -eq 0) {
  throw "Private path current-user ACL verification failed."
}
`;

export const buildWindowsPrivateAclPowerShellInvocation = (targetPath, targetKind) => {
  if (typeof targetPath !== "string" || targetPath.length === 0) {
    throw new Error("Windows private path must be a non-empty string.");
  }
  if (targetKind !== "directory" && targetKind !== "file") {
    throw new Error(`Unsupported Windows private path kind: ${targetKind}`);
  }

  return {
    args: [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      WINDOWS_PRIVATE_ACL_SCRIPT,
    ],
    environment: {
      // Windows PowerShell treats everything following `-Command` as command
      // text rather than positional parameters for a leading `param(...)`
      // block. Transport the path through the child-process environment so
      // spaces, Unicode and PowerShell metacharacters never participate in
      // parsing. Base64 keeps the environment value scalar and lossless.
      TRELIO_WINDOWS_PRIVATE_ACL_PATH_BASE64: Buffer.from(
        targetPath,
        "utf8",
      ).toString("base64"),
      TRELIO_WINDOWS_PRIVATE_ACL_KIND: targetKind,
    },
  };
};

export const hardenWindowsPrivatePath = async (targetPath, targetKind) => {
  const invocation = buildWindowsPrivateAclPowerShellInvocation(
    targetPath,
    targetKind,
  );
  await execFileAsync("powershell.exe", invocation.args, {
    encoding: "utf8",
    env: {
      ...process.env,
      ...invocation.environment,
    },
    windowsHide: true,
  });
};

const assertPrivatePathKind = async (targetPath, targetKind) => {
  const metadata = await fs.lstat(targetPath);
  if (metadata.isSymbolicLink()) {
    throw new Error(`Небезопасный локальный путь является symlink: ${targetPath}`);
  }
  if (targetKind === "directory" ? !metadata.isDirectory() : !metadata.isFile()) {
    throw new Error(`Небезопасный тип локального пути: ${targetPath}`);
  }

  if (process.platform === "win32") {
    await hardenWindowsPrivatePath(targetPath, targetKind);
    return;
  }

  const currentUserId = typeof process.getuid === "function" ? process.getuid() : null;
  if (currentUserId !== null && metadata.uid !== currentUserId) {
    throw new Error(`Локальный путь принадлежит другому пользователю: ${targetPath}`);
  }

  const expectedMode = targetKind === "directory" ? 0o700 : 0o600;
  if ((metadata.mode & 0o777) !== expectedMode) {
    throw new Error(
      `Небезопасные права ${targetPath}; требуются ${
        targetKind === "directory" ? "0700" : "0600"
      }.`,
    );
  }
};

export const ensurePrivateDirectory = async (directoryPath) => {
  let created = false;
  try {
    const existing = await fs.lstat(directoryPath);
    if (!existing.isDirectory() || existing.isSymbolicLink()) {
      throw new Error(`Небезопасный локальный каталог: ${directoryPath}`);
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    await fs.mkdir(directoryPath, { recursive: true, mode: 0o700 });
    created = true;
  }

  if (created && process.platform !== "win32") {
    await fs.chmod(directoryPath, 0o700);
  }
  await assertPrivatePathKind(directoryPath, "directory");
};

const assertPrivateFileIfPresent = async (filePath) => {
  try {
    await assertPrivatePathKind(filePath, "file");
    return true;
  } catch (error) {
    if (error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
};

export const readPrivateJsonFile = async (
  filePath,
  { maximumBytes = Number.POSITIVE_INFINITY } = {},
) => {
  const exists = await assertPrivateFileIfPresent(filePath);
  if (!exists) return {};

  // На POSIX O_NOFOLLOW закрывает окно между lstat и read: даже если путь
  // заменили symlink непосредственно перед open, token-файл не будет прочитан.
  // После открытия повторно проверяем тип, владельца и mode уже по самому fd.
  const flags = fsConstants.O_RDONLY
    | (process.platform === "win32" ? 0 : (fsConstants.O_NOFOLLOW || 0));
  let handle;
  try {
    handle = await fs.open(filePath, flags);
  } catch (error) {
    if (error.code === "ELOOP") {
      throw new Error(`Небезопасный локальный путь является symlink: ${filePath}`);
    }
    throw error;
  }

  try {
    const metadata = await handle.stat();
    if (!metadata.isFile()) {
      throw new Error(`Небезопасный тип локального пути: ${filePath}`);
    }
    if (metadata.size > maximumBytes) {
      throw new Error(`Локальный JSON превышает допустимый размер: ${filePath}`);
    }
    if (process.platform !== "win32") {
      const currentUserId = typeof process.getuid === "function" ? process.getuid() : null;
      if (currentUserId !== null && metadata.uid !== currentUserId) {
        throw new Error(`Локальный путь принадлежит другому пользователю: ${filePath}`);
      }
      if ((metadata.mode & 0o777) !== 0o600) {
        throw new Error(`Небезопасные права ${filePath}; требуются 0600.`);
      }
    }
    return JSON.parse(await handle.readFile("utf8"));
  } finally {
    await handle.close();
  }
};

const readFallbackCredentials = async () => {
  await ensurePrivateDirectory(CONFIG_DIRECTORY);
  try {
    return await readPrivateJsonFile(CREDENTIAL_FILE);
  } catch (error) {
    if (error.code === "ENOENT") {
      return {};
    }
    throw error;
  }
};

const resolveKeychainMigrationMarkerFile = (origin) => path.join(
  CONFIG_DIRECTORY,
  `.keychain-device-session-migrated-${
    crypto.createHash("sha256").update(origin).digest("hex").slice(0, 32)
  }`,
);

export const writePrivateJsonFile = async (filePath, value) => {
  await ensurePrivateDirectory(path.dirname(filePath));
  await assertPrivateFileIfPresent(filePath);
  const temporaryPath = `${filePath}.${process.pid}.${crypto.randomBytes(8).toString("hex")}.tmp`;

  try {
    const handle = await fs.open(temporaryPath, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (process.platform !== "win32") {
      await fs.chmod(temporaryPath, 0o600);
    }
    await assertPrivatePathKind(temporaryPath, "file");
    await fs.rename(temporaryPath, filePath);
    if (process.platform !== "win32") {
      await fs.chmod(filePath, 0o600);
    }
    await assertPrivatePathKind(filePath, "file");
  } finally {
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
  }
};

const normalizeAgentRulesSnapshot = (rawSnapshot, { requireMarkdown = true } = {}) => {
  if (!rawSnapshot || typeof rawSnapshot !== "object") {
    throw new Error("Trelio вернул некорректный снимок платформенных правил.");
  }

  const revisionId = rawSnapshot.revisionId === null
    ? null
    : String(rawSnapshot.revisionId || "");
  const version = Number(rawSnapshot.version);
  const sha256 = String(rawSnapshot.sha256 || "").trim().toLowerCase();
  const rulesMarkdown = typeof rawSnapshot.rulesMarkdown === "string"
    ? rawSnapshot.rulesMarkdown
    : null;

  if (
    (revisionId !== null && !UUID_PATTERN.test(revisionId))
    || !Number.isSafeInteger(version)
    || version < 0
    || !/^[0-9a-f]{64}$/u.test(sha256)
    || (requireMarkdown && rulesMarkdown === null)
  ) {
    throw new Error("Trelio вернул некорректную metadata платформенных правил.");
  }

  if (rulesMarkdown !== null) {
    const sizeBytes = Buffer.byteLength(rulesMarkdown, "utf8");
    const calculatedSha256 = crypto
      .createHash("sha256")
      .update(rulesMarkdown, "utf8")
      .digest("hex");

    if (
      sizeBytes < 1
      || sizeBytes > 128 * 1024
      || calculatedSha256 !== sha256
    ) {
      throw new Error(
        "Содержимое платформенных правил не прошло проверку SHA-256 и размера.",
      );
    }
  }

  return {
    revisionId,
    version,
    sha256,
    ...(rulesMarkdown !== null ? { rulesMarkdown } : {}),
  };
};

const readAgentRulesCacheState = async () => {
  try {
    const state = await readPrivateJsonFile(AGENT_RULES_CACHE_FILE);
    return state && typeof state === "object" ? state : {};
  } catch (error) {
    if (error instanceof SyntaxError) {
      // Повреждённый необязательный cache можно безопасно заменить ответом
      // authenticated backend. Ошибки owner/mode/symlink остаются fail-closed.
      return {};
    }
    throw error;
  }
};

export const readCachedAgentRules = async (origin) => {
  const state = await readAgentRulesCacheState();
  const originKey = crypto.createHash("sha256").update(origin).digest("hex");
  const cached = state?.origins?.[originKey];

  if (!cached) {
    return null;
  }

  try {
    return normalizeAgentRulesSnapshot(cached);
  } catch {
    // Content mismatch означает только cache miss: authenticated backend
    // повторно пришлёт exact bytes, а unsafe filesystem state уже проверен
    // readPrivateJsonFile выше и не маскируется этим fallback.
    return null;
  }
};

export const cacheAgentRules = async (origin, rawSnapshot) => {
  const snapshot = normalizeAgentRulesSnapshot(rawSnapshot);
  const state = await readAgentRulesCacheState();
  const originKey = crypto.createHash("sha256").update(origin).digest("hex");
  const entries = Object.entries(
    state?.origins && typeof state.origins === "object" ? state.origins : {},
  )
    .filter(([key]) => key !== originKey)
    .slice(-19);
  const origins = Object.fromEntries(entries);

  origins[originKey] = {
    ...snapshot,
    origin,
    updatedAt: new Date().toISOString(),
  };
  await writePrivateJsonFile(AGENT_RULES_CACHE_FILE, {
    schemaVersion: 1,
    origins,
  });

  return snapshot;
};

export const applyAgentRulesHandshake = async (
  origin,
  rawHandshake,
  cachedSnapshot = null,
  { cacheRules = cacheAgentRules } = {},
) => {
  if (rawHandshake === undefined || rawHandshake === null) {
    // Backward-compatible окно: plugin 1.6.0 публикуется раньше backend,
    // поэтому старый Trelio ещё не знает dynamic rules handshake.
    return null;
  }

  if (rawHandshake?.status === "current") {
    const metadata = normalizeAgentRulesSnapshot(rawHandshake, {
      requireMarkdown: false,
    });

    if (!cachedSnapshot || cachedSnapshot.sha256 !== metadata.sha256) {
      throw new Error(
        "Trelio подтвердил хэш правил, которых нет в локальном проверенном cache.",
      );
    }

    if (
      cachedSnapshot.revisionId !== metadata.revisionId
      || cachedSnapshot.version !== metadata.version
    ) {
      // Restore может опубликовать прежние bytes новой immutable revision.
      // Hash уже подтверждает содержимое, но локальную metadata обновляем до
      // exact current revision, чтобы context index не ссылался на старую.
      return cacheRules(origin, {
        ...metadata,
        rulesMarkdown: cachedSnapshot.rulesMarkdown,
      });
    }

    return cachedSnapshot;
  }

  if (rawHandshake?.status !== "update_required") {
    throw new Error("Trelio вернул неизвестное состояние платформенных правил.");
  }

  const verifiedSnapshot = normalizeAgentRulesSnapshot(rawHandshake);
  return cacheRules(origin, verifiedSnapshot);
};

const parseJsonCommandOutput = (rawOutput, commandLabel) => {
  try {
    return JSON.parse(String(rawOutput || ""));
  } catch {
    throw new Error(`${commandLabel} вернул некорректный JSON.`);
  }
};

const buildChildProcessErrorDetail = (error) => (
  String(error?.stderr || error?.stdout || error?.message || error).trim().slice(0, 4_000)
);

export const isCodexPluginAutoUpdateEnvironment = (
  environment = process.env,
) => {
  if (
    environment.TRELIO_WORKSPACE_DISABLE_AUTO_UPDATE === "1"
    || environment.TRELIO_WORKSPACE_AUTO_UPDATE_REEXEC === "1"
    || environment.CLAUDE_CODE_ENTRYPOINT
    || environment.CLAUDE_ENV_FILE
    || environment.CLAUDE_EFFORT
  ) {
    return false;
  }

  // Bridge, запущенный из Codex, получает thread id. Не обновляем plugin из
  // обычного пользовательского терминала: там изменение локального каталога
  // не является частью уже доверенного Codex plugin lifecycle.
  return Boolean(environment.CODEX_THREAD_ID);
};

const parseStableVersion = (rawVersion) => {
  const match = /^(\d{1,9})\.(\d{1,9})\.(\d{1,9})$/u.exec(
    String(rawVersion || "").trim(),
  );

  return match
    ? match.slice(1).map(Number)
    : null;
};

export const isStableVersionAtLeast = (rawVersion, rawMinimumVersion) => {
  const version = parseStableVersion(rawVersion);
  const minimum = parseStableVersion(rawMinimumVersion);

  if (!version || !minimum) {
    return false;
  }

  for (let index = 0; index < 3; index += 1) {
    if (version[index] > minimum[index]) return true;
    if (version[index] < minimum[index]) return false;
  }

  return true;
};

const assertCodexPluginVersionPath = (pluginDirectory, version) => {
  const absoluteDirectory = path.resolve(pluginDirectory);
  const pluginRoot = path.dirname(absoluteDirectory);
  const marketplaceRoot = path.dirname(pluginRoot);

  // Codex owns this versioned cache layout. Retention may recreate only an
  // exact path previously loaded for the official Trelio plugin; accepting an
  // arbitrary destination from local metadata would turn recovery into a
  // general filesystem write primitive.
  if (
    !parseStableVersion(version)
    || path.basename(absoluteDirectory) !== version
    || path.basename(pluginRoot) !== "trelio-agent-workspaces"
    || path.basename(marketplaceRoot) !== CODEX_MARKETPLACE_NAME
  ) {
    throw new Error(
      "Codex вернул неподдерживаемый versioned path Trelio plugin.",
    );
  }

  return absoluteDirectory;
};

const inspectImmutableCodexPluginTree = async (
  pluginDirectory,
  expectedVersion,
  { requireCodexVersionPath = true } = {},
) => {
  const absoluteDirectory = requireCodexVersionPath
    ? assertCodexPluginVersionPath(pluginDirectory, expectedVersion)
    : path.resolve(pluginDirectory);
  const rootMetadata = await fs.lstat(absoluteDirectory);
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
    throw new Error("Каталог Trelio plugin для retention имеет небезопасный тип.");
  }

  const treeHash = crypto.createHash("sha256");
  let fileCount = 0;
  let totalBytes = 0;

  const inspectDirectory = async (directory, relativeDirectory = "") => {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, "en"));

    for (const entry of entries) {
      const absolutePath = path.join(directory, entry.name);
      const relativePath = path.posix.join(
        relativeDirectory,
        entry.name,
      );
      const metadata = await fs.lstat(absolutePath);

      // A marketplace package is immutable regular files/directories only.
      // Refusing links and special files prevents the backup from escaping its
      // source root or changing meaning between validation and restoration.
      if (metadata.isSymbolicLink()) {
        throw new Error(`Retention запрещает symlink в plugin: ${relativePath}`);
      }
      if (metadata.isDirectory()) {
        await inspectDirectory(absolutePath, relativePath);
        continue;
      }
      if (!metadata.isFile()) {
        throw new Error(
          `Retention запрещает специальный файл в plugin: ${relativePath}`,
        );
      }

      fileCount += 1;
      totalBytes += metadata.size;
      if (
        fileCount > CODEX_RETAINED_PLUGIN_MAX_FILE_COUNT
        || totalBytes > CODEX_RETAINED_PLUGIN_MAX_BYTES
      ) {
        throw new Error("Trelio plugin превышает безопасный размер retention.");
      }

      const bytes = await fs.readFile(absolutePath);
      treeHash.update(`${Buffer.byteLength(relativePath, "utf8")}:`);
      treeHash.update(relativePath, "utf8");
      treeHash.update(`:${bytes.byteLength}:`);
      treeHash.update(bytes);
    }
  };

  await inspectDirectory(absoluteDirectory);
  const manifestPath = path.join(
    absoluteDirectory,
    ".codex-plugin",
    "plugin.json",
  );
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  if (
    manifest?.name !== "trelio-agent-workspaces"
    || manifest?.version !== expectedVersion
  ) {
    throw new Error("Retention получил несовместимый manifest Trelio plugin.");
  }
  return {
    installedPath: absoluteDirectory,
    version: expectedVersion,
    treeSha256: treeHash.digest("hex"),
    fileCount,
    totalBytes,
  };
};

const buildCodexPluginRetentionEntryId = ({
  installedPath,
  version,
  treeSha256,
}) => crypto.createHash("sha256").update(JSON.stringify({
  installedPath,
  version,
  treeSha256,
})).digest("hex");

const readRetainedCodexPluginEntries = async (retentionDirectory) => {
  await ensurePrivateDirectory(retentionDirectory);
  const directoryEntries = await fs.readdir(retentionDirectory, {
    withFileTypes: true,
  });
  const retainedEntries = [];

  for (const directoryEntry of directoryEntries) {
    if (
      !/^[0-9a-f]{64}$/u.test(directoryEntry.name)
      || !directoryEntry.isDirectory()
      || directoryEntry.isSymbolicLink()
    ) {
      throw new Error(
        `Небезопасная запись в каталоге plugin retention: ${directoryEntry.name}`,
      );
    }

    const entryDirectory = path.join(retentionDirectory, directoryEntry.name);
    await assertPrivatePathKind(entryDirectory, "directory");
    const metadata = await readPrivateJsonFile(path.join(
      entryDirectory,
      "metadata.json",
    ));
    const installedPath = typeof metadata?.installedPath === "string"
      ? assertCodexPluginVersionPath(metadata.installedPath, metadata.version)
      : null;

    if (
      metadata?.schemaVersion !== 1
      || metadata?.pluginId !== CODEX_PLUGIN_ID
      || metadata?.marketplaceName !== CODEX_MARKETPLACE_NAME
      || !installedPath
      || !/^[0-9a-f]{64}$/u.test(String(metadata?.treeSha256 || ""))
      || buildCodexPluginRetentionEntryId({
        installedPath,
        version: metadata.version,
        treeSha256: metadata.treeSha256,
      }) !== directoryEntry.name
    ) {
      throw new Error("Некорректная metadata сохранённой версии Trelio plugin.");
    }

    retainedEntries.push({
      entryDirectory,
      pluginDirectory: path.join(entryDirectory, "plugin"),
      installedPath,
      version: metadata.version,
      treeSha256: metadata.treeSha256,
    });
  }

  return retainedEntries.sort((left, right) => (
    left.installedPath.localeCompare(right.installedPath, "en")
  ));
};

const assertRetainedCodexPluginEntry = async (entry) => {
  const inspection = await inspectImmutableCodexPluginTree(
    entry.pluginDirectory,
    entry.version,
    { requireCodexVersionPath: false },
  );
  if (inspection.treeSha256 !== entry.treeSha256) {
    throw new Error(
      `Сохранённая версия Trelio plugin ${entry.version} повреждена.`,
    );
  }
  return inspection;
};

const restoreOneRetainedCodexPlugin = async (entry) => {
  await assertRetainedCodexPluginEntry(entry);

  try {
    const existing = await inspectImmutableCodexPluginTree(
      entry.installedPath,
      entry.version,
    );
    if (existing.treeSha256 !== entry.treeSha256) {
      throw new Error(
        `Codex cache уже содержит другие bytes версии ${entry.version}.`,
      );
    }
    return false;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  const targetParent = path.dirname(entry.installedPath);
  try {
    await fs.lstat(targetParent);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;

    const marketplaceDirectory = path.dirname(targetParent);
    const marketplaceMetadata = await fs.lstat(marketplaceDirectory);
    if (
      !marketplaceMetadata.isDirectory()
      || marketplaceMetadata.isSymbolicLink()
      || path.basename(marketplaceDirectory) !== CODEX_MARKETPLACE_NAME
    ) {
      throw new Error("Каталог Codex marketplace для retention небезопасен.");
    }
    await fs.mkdir(targetParent, { mode: 0o700 }).catch((mkdirError) => {
      if (mkdirError.code !== "EEXIST") throw mkdirError;
    });
  }
  const parentMetadata = await fs.lstat(targetParent);
  if (!parentMetadata.isDirectory() || parentMetadata.isSymbolicLink()) {
    throw new Error("Родительский каталог Codex plugin cache небезопасен.");
  }

  const temporaryPath = path.join(
    targetParent,
    `.${entry.version}.trelio-retain-${process.pid}-${crypto.randomBytes(8).toString("hex")}`,
  );
  try {
    await fs.cp(entry.pluginDirectory, temporaryPath, {
      recursive: true,
      dereference: false,
      errorOnExist: true,
      force: false,
      preserveTimestamps: true,
      verbatimSymlinks: true,
    });
    const copied = await inspectImmutableCodexPluginTree(
      temporaryPath,
      entry.version,
      { requireCodexVersionPath: false },
    );
    if (copied.treeSha256 !== entry.treeSha256) {
      throw new Error(
        `Копия Trelio plugin ${entry.version} изменилась при восстановлении.`,
      );
    }

    try {
      await fs.rename(temporaryPath, entry.installedPath);
    } catch (error) {
      if (error.code !== "EEXIST" && error.code !== "ENOTEMPTY") throw error;
      const concurrent = await inspectImmutableCodexPluginTree(
        entry.installedPath,
        entry.version,
      );
      if (concurrent.treeSha256 !== entry.treeSha256) throw error;
    }
  } finally {
    await fs.rm(temporaryPath, { recursive: true, force: true });
  }

  return true;
};

export const restoreRetainedCodexPluginInstallations = async ({
  retentionDirectory = CODEX_PLUGIN_RETENTION_DIRECTORY,
} = {}) => {
  const entries = await readRetainedCodexPluginEntries(retentionDirectory);
  for (const entry of entries) {
    await restoreOneRetainedCodexPlugin(entry);
  }
  return entries.length;
};

export const retainLoadedCodexPluginInstallation = async ({
  loadedPluginDirectory = LOADED_CODEX_PLUGIN_DIRECTORY,
  loadedPluginVersion = BRIDGE_VERSION,
  retentionDirectory = CODEX_PLUGIN_RETENTION_DIRECTORY,
} = {}) => {
  const source = await inspectImmutableCodexPluginTree(
    loadedPluginDirectory,
    loadedPluginVersion,
  );
  // Restore earlier exact releases only after proving that this process itself
  // was loaded from the expected Codex cache layout. The same bridge module is
  // also imported from a source checkout and by Claude, where touching Codex
  // retention would be outside the active client lifecycle.
  await restoreRetainedCodexPluginInstallations({ retentionDirectory });
  const entryId = buildCodexPluginRetentionEntryId({
    installedPath: source.installedPath,
    version: source.version,
    treeSha256: source.treeSha256,
  });
  const entryDirectory = path.join(retentionDirectory, entryId);
  const pluginDirectory = path.join(entryDirectory, "plugin");

  try {
    const existingMetadata = await fs.lstat(entryDirectory);
    if (!existingMetadata.isDirectory() || existingMetadata.isSymbolicLink()) {
      throw new Error("Небезопасный каталог сохранённой версии Trelio plugin.");
    }
    const [existingEntry] = (await readRetainedCodexPluginEntries(
      retentionDirectory,
    )).filter((entry) => entry.entryDirectory === entryDirectory);
    if (!existingEntry) {
      throw new Error("Retention entry не соответствует своему content id.");
    }
    await assertRetainedCodexPluginEntry(existingEntry);
    return existingEntry;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  const temporaryDirectory = path.join(
    path.dirname(retentionDirectory),
    `.codex-plugin-retention-${entryId}.${process.pid}.${crypto.randomBytes(8).toString("hex")}.tmp`,
  );
  try {
    await fs.mkdir(temporaryDirectory, { mode: 0o700 });
    if (process.platform !== "win32") {
      await fs.chmod(temporaryDirectory, 0o700);
    }
    await fs.cp(source.installedPath, path.join(temporaryDirectory, "plugin"), {
      recursive: true,
      dereference: false,
      errorOnExist: true,
      force: false,
      preserveTimestamps: true,
      verbatimSymlinks: true,
    });
    if (process.platform !== "win32") {
      await fs.chmod(path.join(temporaryDirectory, "plugin"), 0o700);
    }
    const copied = await inspectImmutableCodexPluginTree(
      path.join(temporaryDirectory, "plugin"),
      source.version,
      { requireCodexVersionPath: false },
    );
    if (copied.treeSha256 !== source.treeSha256) {
      throw new Error("Trelio plugin изменился при создании retention-копии.");
    }
    await writePrivateJsonFile(path.join(temporaryDirectory, "metadata.json"), {
      schemaVersion: 1,
      pluginId: CODEX_PLUGIN_ID,
      marketplaceName: CODEX_MARKETPLACE_NAME,
      installedPath: source.installedPath,
      version: source.version,
      treeSha256: source.treeSha256,
      createdAt: new Date().toISOString(),
    });

    try {
      await fs.rename(temporaryDirectory, entryDirectory);
    } catch (error) {
      if (error.code !== "EEXIST" && error.code !== "ENOTEMPTY") throw error;
    }
  } finally {
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
  }

  const entries = await readRetainedCodexPluginEntries(retentionDirectory);
  const retained = entries.find((entry) => entry.entryDirectory === entryDirectory);
  if (!retained) {
    throw new Error("Codex plugin retention не сохранил проверенную версию.");
  }
  await assertRetainedCodexPluginEntry(retained);
  return retained;
};

const runCodexPluginMutationWithRetention = async (
  operation,
  {
    preserveLoadedPlugin = true,
    loadedPluginDirectory = LOADED_CODEX_PLUGIN_DIRECTORY,
    loadedPluginVersion = BRIDGE_VERSION,
    retentionDirectory = CODEX_PLUGIN_RETENTION_DIRECTORY,
  } = {},
) => {
  if (!preserveLoadedPlugin) return operation();

  await retainLoadedCodexPluginInstallation({
    loadedPluginDirectory,
    loadedPluginVersion,
    retentionDirectory,
  });

  let operationResult;
  let operationError = null;
  try {
    operationResult = await operation();
  } catch (error) {
    operationError = error;
  }

  try {
    // Codex may prune versioned cache folders on both marketplace upgrade and
    // an otherwise harmless `plugin add`. Restoration therefore belongs in a
    // finally-equivalent path for every mutating CLI call, including failures.
    await restoreRetainedCodexPluginInstallations({ retentionDirectory });
  } catch (retentionError) {
    throw new Error(
      "Codex обновил plugin cache, но Trelio не смог восстановить пути активных задач.",
      { cause: retentionError },
    );
  }

  if (operationError) throw operationError;
  return operationResult;
};

export const isTransientCodexMarketplaceUpdateError = (error) => {
  if (
    error?.killed === true
    || error?.code === "ETIMEDOUT"
    || error?.code === "ECONNRESET"
    || error?.code === "EAI_AGAIN"
  ) {
    return true;
  }

  const detail = buildChildProcessErrorDetail(error);

  return /(?:timed?\s*out|timeout|econnreset|eai_again|enotfound|dns|connection|tls|ssl|502|503|504|git\s+ls-remote|index\.lock|another git process)/iu.test(
    detail,
  );
};

const runCodexJsonCommand = async (
  argumentsList,
  {
    execFileCommand = execFileAsync,
    environment = process.env,
  } = {},
) => {
  const result = await execFileCommand("codex", argumentsList, {
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
    env: {
      ...environment,
      GIT_TERMINAL_PROMPT: "0",
      GIT_PAGER: "cat",
    },
    timeout: PLUGIN_UPDATE_COMMAND_TIMEOUT_MS,
    shell: false,
    windowsHide: true,
  });

  return parseJsonCommandOutput(result.stdout, `codex ${argumentsList.join(" ")}`);
};

const assertOfficialCodexMarketplace = async ({
  execFileCommand = execFileAsync,
  environment = process.env,
} = {}) => {
  const result = await runCodexJsonCommand(
    CODEX_MARKETPLACE_LIST_ARGUMENTS,
    { execFileCommand, environment },
  );
  const marketplace = Array.isArray(result?.marketplaces)
    ? result.marketplaces.find((item) => item?.name === CODEX_MARKETPLACE_NAME)
    : null;

  if (
    marketplace?.marketplaceSource?.sourceType !== "git"
    || marketplace.marketplaceSource.source !== CODEX_OFFICIAL_MARKETPLACE_SOURCE
  ) {
    throw new Error(
      "Тихое обновление разрешено только для официального Git marketplace Trelio.",
    );
  }
};

export const resolveInstalledCodexPluginBridge = async ({
  minimumVersion = null,
  execFileCommand = execFileAsync,
  environment = process.env,
  filesystem = fs,
  verifyMarketplace = true,
  preserveLoadedPlugin = true,
  loadedPluginDirectory = LOADED_CODEX_PLUGIN_DIRECTORY,
  loadedPluginVersion = BRIDGE_VERSION,
  retentionDirectory = CODEX_PLUGIN_RETENTION_DIRECTORY,
} = {}) => {
  if (verifyMarketplace) {
    await assertOfficialCodexMarketplace({ execFileCommand, environment });
  }
  const installation = await runCodexPluginMutationWithRetention(
    () => runCodexJsonCommand(
      CODEX_PLUGIN_INSTALL_ARGUMENTS,
      { execFileCommand, environment },
    ),
    {
      preserveLoadedPlugin,
      loadedPluginDirectory,
      loadedPluginVersion,
      retentionDirectory,
    },
  );
  const installedPath = typeof installation?.installedPath === "string"
    ? path.resolve(installation.installedPath)
    : null;
  const version = typeof installation?.version === "string"
    ? installation.version.trim()
    : "";

  if (
    installation?.pluginId !== CODEX_PLUGIN_ID
    || installation?.marketplaceName !== CODEX_MARKETPLACE_NAME
    || !installedPath
    || !parseStableVersion(version)
    || (minimumVersion && !isStableVersionAtLeast(version, minimumVersion))
  ) {
    return null;
  }

  const pluginDirectoryMetadata = await filesystem.lstat(installedPath);
  if (
    !pluginDirectoryMetadata.isDirectory()
    || pluginDirectoryMetadata.isSymbolicLink()
  ) {
    throw new Error("Codex вернул небезопасный каталог установленного Trelio plugin.");
  }

  const manifestPath = path.join(installedPath, ".codex-plugin", "plugin.json");
  const bridgePath = path.join(installedPath, "scripts", "trelio-workspace.mjs");
  const [manifestMetadata, bridgeMetadata, manifest] = await Promise.all([
    filesystem.lstat(manifestPath),
    filesystem.lstat(bridgePath),
    filesystem.readFile(manifestPath, "utf8").then((value) => JSON.parse(value)),
  ]);

  if (
    !manifestMetadata.isFile()
    || manifestMetadata.isSymbolicLink()
    || !bridgeMetadata.isFile()
    || bridgeMetadata.isSymbolicLink()
    || manifest?.name !== "trelio-agent-workspaces"
    || manifest?.version !== version
  ) {
    throw new Error("Установленный Trelio plugin не прошёл проверку manifest/entrypoint.");
  }

  return {
    version,
    installedPath,
    bridgePath,
  };
};

export const updateCodexPluginMarketplace = async ({
  minimumVersion = null,
  execFileCommand = execFileAsync,
  environment = process.env,
  filesystem = fs,
  waitForRetry = wait,
  preserveLoadedPlugin = true,
  loadedPluginDirectory = LOADED_CODEX_PLUGIN_DIRECTORY,
  loadedPluginVersion = BRIDGE_VERSION,
  retentionDirectory = CODEX_PLUGIN_RETENTION_DIRECTORY,
} = {}) => {
  let lastError = null;

  await assertOfficialCodexMarketplace({ execFileCommand, environment });

  for (
    let attempt = 0;
    attempt <= PLUGIN_UPDATE_NETWORK_RETRY_DELAYS_MS.length;
    attempt += 1
  ) {
    try {
      const result = await runCodexPluginMutationWithRetention(
        () => runCodexJsonCommand(
          CODEX_MARKETPLACE_UPDATE_ARGUMENTS,
          { execFileCommand, environment },
        ),
        {
          preserveLoadedPlugin,
          loadedPluginDirectory,
          loadedPluginVersion,
          retentionDirectory,
        },
      );
      const errors = Array.isArray(result?.errors) ? result.errors : [];

      if (
        !Array.isArray(result?.selectedMarketplaces)
        || !result.selectedMarketplaces.includes(CODEX_MARKETPLACE_NAME)
        || errors.length > 0
      ) {
        throw new Error("Codex не подтвердил обновление Trelio marketplace.");
      }

      const installation = await resolveInstalledCodexPluginBridge({
        minimumVersion,
        execFileCommand,
        environment,
        filesystem,
        verifyMarketplace: false,
        preserveLoadedPlugin,
        loadedPluginDirectory,
        loadedPluginVersion,
        retentionDirectory,
      });
      if (!installation) {
        throw new Error(
          minimumVersion
            ? `Codex marketplace не установил требуемую стабильную версию v${minimumVersion}.`
            : "Codex marketplace не вернул проверяемую стабильную версию Trelio plugin.",
        );
      }

      return installation;
    } catch (error) {
      lastError = error;
      const retryDelay = PLUGIN_UPDATE_NETWORK_RETRY_DELAYS_MS[attempt];

      if (
        retryDelay === undefined
        || !isTransientCodexMarketplaceUpdateError(error)
      ) {
        break;
      }

      await waitForRetry(retryDelay);
    }
  }

  throw new Error(
    `Тихое обновление Trelio plugin не выполнено: ${buildChildProcessErrorDetail(lastError)}`,
  );
};

const readPluginUpdateState = async () => {
  try {
    return await readPrivateJsonFile(PLUGIN_UPDATE_STATE_FILE);
  } catch (error) {
    if (error instanceof SyntaxError) {
      // Повреждённый JSON необязательного state не должен мешать workspace.
      // Ошибки владельца/mode/symlink не маскируем: такой путь нельзя
      // перезаписывать или использовать для фонового lifecycle.
      return {};
    }
    throw error;
  }
};

const acquirePluginUpdateLock = async (nowMilliseconds = Date.now()) => {
  await ensurePrivateDirectory(CONFIG_DIRECTORY);

  try {
    await fs.mkdir(PLUGIN_UPDATE_LOCK_DIRECTORY, { mode: 0o700 });
    return true;
  } catch (error) {
    if (error.code !== "EEXIST") {
      throw error;
    }
  }

  try {
    const metadata = await fs.lstat(PLUGIN_UPDATE_LOCK_DIRECTORY);
    const stale = metadata.isDirectory()
      && !metadata.isSymbolicLink()
      && nowMilliseconds - metadata.mtimeMs > PLUGIN_BACKGROUND_UPDATE_LOCK_STALE_MS;

    if (!stale) {
      return false;
    }

    await fs.rm(PLUGIN_UPDATE_LOCK_DIRECTORY, { recursive: true, force: true });
    await fs.mkdir(PLUGIN_UPDATE_LOCK_DIRECTORY, { mode: 0o700 });
    return true;
  } catch (error) {
    if (error.code === "ENOENT") {
      return acquirePluginUpdateLock(nowMilliseconds);
    }
    throw error;
  }
};

const releasePluginUpdateLock = async () => {
  await fs.rm(PLUGIN_UPDATE_LOCK_DIRECTORY, {
    recursive: true,
    force: true,
  });
};

export const startQuietCodexPluginUpdate = async ({
  environment = process.env,
  nowMilliseconds = Date.now(),
  spawnProcess = spawn,
} = {}) => {
  if (!isCodexPluginAutoUpdateEnvironment(environment)) {
    return false;
  }

  // Snapshot the currently loaded immutable package even when the network
  // refresh interval has not elapsed. A later manual Codex update can then be
  // repaired by the next bridge invocation instead of leaving older tasks
  // with dead absolute SKILL.md paths.
  await retainLoadedCodexPluginInstallation();

  const state = await readPluginUpdateState();
  const nextAttemptAt = Date.parse(String(state?.nextAttemptAt || ""));
  if (Number.isFinite(nextAttemptAt) && nextAttemptAt > nowMilliseconds) {
    return false;
  }

  if (!await acquirePluginUpdateLock(nowMilliseconds)) {
    return false;
  }

  try {
    const child = spawnProcess(
      process.execPath,
      [BRIDGE_ENTRYPOINT_PATH, "__plugin-update"],
      {
        detached: true,
        env: {
          ...environment,
          TRELIO_WORKSPACE_BACKGROUND_UPDATE: "1",
        },
        shell: false,
        stdio: "ignore",
        windowsHide: true,
      },
    );
    child.once("error", () => {
      releasePluginUpdateLock().catch(() => undefined);
    });
    child.unref();
    return true;
  } catch (error) {
    await releasePluginUpdateLock();
    throw error;
  }
};

const runBackgroundCodexPluginUpdate = async () => {
  const attemptedAt = new Date();

  try {
    const installation = await updateCodexPluginMarketplace();
    await writePrivateJsonFile(PLUGIN_UPDATE_STATE_FILE, {
      schemaVersion: 1,
      lastAttemptAt: attemptedAt.toISOString(),
      lastSuccessAt: new Date().toISOString(),
      nextAttemptAt: new Date(
        Date.now() + PLUGIN_BACKGROUND_UPDATE_INTERVAL_MS,
      ).toISOString(),
      installedVersion: installation?.version || null,
      status: "updated",
    });
  } catch {
    // Background updater остаётся тихим: обязательная несовместимость позже
    // запустит тот же bounded updater синхронно и только тогда покажет fallback.
    await writePrivateJsonFile(PLUGIN_UPDATE_STATE_FILE, {
      schemaVersion: 1,
      lastAttemptAt: attemptedAt.toISOString(),
      nextAttemptAt: new Date(
        Date.now() + PLUGIN_BACKGROUND_UPDATE_FAILURE_RETRY_MS,
      ).toISOString(),
      status: "retry_later",
    }).catch(() => undefined);
  } finally {
    await releasePluginUpdateLock().catch(() => undefined);
  }
};

const writePrivateMarkerFile = async (filePath) => {
  await ensurePrivateDirectory(path.dirname(filePath));
  await fs.writeFile(filePath, `${new Date().toISOString()}\n`, {
    flag: "wx",
    encoding: "utf8",
    mode: 0o600,
  }).catch((error) => {
    if (error.code !== "EEXIST") throw error;
  });
  if (process.platform !== "win32") {
    await fs.chmod(filePath, 0o600);
  }
  await assertPrivatePathKind(filePath, "file");
};

const loadBridgeSessionToken = async (origin) => {
  let configDirectoryAlreadyExisted = true;
  try {
    await fs.lstat(CONFIG_DIRECTORY);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    configDirectoryAlreadyExisted = false;
  }

  const credentials = await readFallbackCredentials();
  const fileToken = credentials[origin]?.bridgeSessionToken || null;
  if (fileToken) return fileToken;

  // Старые macOS-установки уже имеют config-каталог, но не credentials.json.
  // Pending pairing означает новое подключение, для которого Keychain вообще
  // не трогаем. В остальных случаях один раз читаем legacy item, переносим его
  // в приватный файл и больше не зависим от `security`.
  const hasPendingPairing = await assertPrivateFileIfPresent(PAIRING_FILE);
  const keychainMigrationMarkerFile = resolveKeychainMigrationMarkerFile(origin);
  const migrationAlreadyChecked = await assertPrivateFileIfPresent(
    keychainMigrationMarkerFile,
  );
  if (
    USE_LEGACY_MACOS_KEYCHAIN
    && configDirectoryAlreadyExisted
    && !hasPendingPairing
    && !migrationAlreadyChecked
  ) {
    const keychainToken = await getKeychainValue(
      LEGACY_BRIDGE_SESSION_KEYCHAIN_SERVICE,
      origin,
      { failOnUnexpectedError: true },
    );
    if (keychainToken) {
      await saveBridgeSessionToken(origin, keychainToken);
      await deleteKeychainValue(LEGACY_BRIDGE_SESSION_KEYCHAIN_SERVICE, origin);
      await writePrivateMarkerFile(keychainMigrationMarkerFile);
      return keychainToken;
    }
    await writePrivateMarkerFile(keychainMigrationMarkerFile);
  }

  // До 1.4.1 Windows использовал home-based `.config`. Переносим только
  // проверенный обычный файл, затем сохраняем его в LOCALAPPDATA с exact ACL.
  if (
    process.platform === "win32"
    && LEGACY_HOME_CREDENTIAL_FILE !== CREDENTIAL_FILE
    && await assertPrivateFileIfPresent(LEGACY_HOME_CREDENTIAL_FILE)
  ) {
    const legacyCredentials = await readPrivateJsonFile(LEGACY_HOME_CREDENTIAL_FILE);
    const legacyToken = legacyCredentials[origin]?.bridgeSessionToken || null;
    if (legacyToken) {
      await saveBridgeSessionToken(origin, legacyToken);
      return legacyToken;
    }
  }

  return null;
};

const loadLegacyOAuthToken = async (origin) => {
  const keychainToken = await getKeychainValue(LEGACY_KEYCHAIN_SERVICE, origin);
  const credentials = await readFallbackCredentials();
  return keychainToken || credentials[origin]?.accessToken || null;
};

export const loadToken = async (origin) => (
  await loadBridgeSessionToken(origin)
  || await loadLegacyOAuthToken(origin)
);

const RUNTIME_POLICY_COMPANY_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

const normalizeRuntimePolicyTarget = (target) => {
  if (!target || typeof target !== "object") return null;

  if (
    typeof target.companySlug === "string"
    && target.companySlug.length <= 255
    && RUNTIME_POLICY_COMPANY_SLUG_PATTERN.test(target.companySlug)
  ) {
    return {
      key: `slug:${target.companySlug}`,
      companySlug: target.companySlug,
    };
  }

  if (UUID_PATTERN.test(String(target.companyId || ""))) {
    const companyId = String(target.companyId).toLowerCase();
    return {
      key: `id:${companyId}`,
      companyId,
    };
  }

  return null;
};

const normalizeRuntimePolicySnapshotFromAdmission = (value) => {
  if (
    !value
    || typeof value !== "object"
    || value.schemaVersion !== 1
    || !value.policy
    || typeof value.policy !== "object"
    || !["disabled", "observe", "enforce"].includes(value.policy.mode)
  ) {
    throw new Error("Trelio вернул некорректный снимок политики модели.");
  }

  // Disabled policy не использует model rules. Для observe/enforce требуем
  // полный provider-контракт: частичный ответ не должен превратиться в allow.
  if (
    value.policy.mode !== "disabled"
    && (
      !value.policy.providers
      || typeof value.policy.providers !== "object"
      || typeof value.policy.providers.codex !== "object"
      || typeof value.policy.providers.claudeCode !== "object"
      || !["allow", "deny"].includes(value.policy.otherClientsAction)
    )
  ) {
    throw new Error("Trelio вернул неполную политику модели.");
  }

  return value;
};

const normalizeRuntimePolicyAdmissionPayload = (value, requestedTarget) => {
  if (
    !value
    || typeof value !== "object"
    || value.schemaVersion !== 1
    || !value.company
    || typeof value.company !== "object"
    || !UUID_PATTERN.test(String(value.company.id || ""))
    || !RUNTIME_POLICY_COMPANY_SLUG_PATTERN.test(String(value.company.slug || ""))
  ) {
    throw new Error("Trelio вернул некорректный контекст политики модели.");
  }

  const companyId = String(value.company.id).toLowerCase();
  const companySlug = String(value.company.slug);
  if (
    requestedTarget.companyId && requestedTarget.companyId !== companyId
    || requestedTarget.companySlug && requestedTarget.companySlug !== companySlug
  ) {
    throw new Error("Trelio вернул политику другой компании.");
  }

  return {
    schemaVersion: 1,
    company: { id: companyId, slug: companySlug },
    runtimePolicySnapshot: normalizeRuntimePolicySnapshotFromAdmission(
      value.runtimePolicySnapshot,
    ),
    evaluation: value.evaluation && typeof value.evaluation === "object"
      ? value.evaluation
      : null,
  };
};

const isRetryableRuntimePolicyAdmissionError = (error) => (
  error instanceof TrelioApiError
    ? error.statusCode === 429 || error.statusCode >= 500
    : ["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EAI_AGAIN", "ENOTFOUND"]
      .includes(String(error?.code || error?.cause?.code || ""))
);

const fetchRuntimePolicyAdmission = async ({
  origin,
  token,
  target,
  runtimeSessionId,
  runtimeAttestation,
  requestCommand = request,
  waitForRetry = wait,
}) => {
  let lastError = null;

  // Admission только читает current revision и поэтому безопасно повторяется
  // при transport/5xx. Попытки не повторяют skill runtime или другую mutation.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await requestCommand(
        origin,
        token,
        "/api/agent-workspaces/runtime-policy/admissions",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            ...(target.companySlug ? { companySlug: target.companySlug } : {}),
            ...(target.companyId ? { companyId: target.companyId } : {}),
            ...(runtimeSessionId ? { runtimeSessionId } : {}),
            ...(runtimeAttestation ? { runtimeAttestation } : {}),
          }),
        },
      );
      return normalizeRuntimePolicyAdmissionPayload(await response.json(), target);
    } catch (error) {
      lastError = error;
      if (attempt >= 2 || !isRetryableRuntimePolicyAdmissionError(error)) {
        throw error;
      }
      await waitForRetry(150 * (2 ** attempt));
    }
  }

  throw lastError ?? new Error("Не удалось проверить политику модели Trelio.");
};

const normalizeRuntimeHookSessionPayload = (value) => {
  if (
    !value
    || typeof value !== "object"
    || value.schemaVersion !== 1
    || !UUID_PATTERN.test(String(value.runtimeSessionId || ""))
    || Number.isNaN(Date.parse(String(value.expiresAt || "")))
  ) {
    throw new Error("Trelio вернул некорректную runtime-сессию hook.");
  }
  return {
    schemaVersion: 1,
    runtimeSessionId: String(value.runtimeSessionId).toLowerCase(),
    expiresAt: String(value.expiresAt),
    observation: value.observation,
  };
};

/**
 * Hook использует тот же paired device-session, что и bridge. Private key
 * остаётся в локальном hook state; Trelio получает только публичный ключ и
 * наблюдение runtime, сделанное самим клиентским hook.
 */
export const registerAgentRuntimeHookSession = async ({
  origin = DEFAULT_ORIGIN,
  clientSessionId,
  observation,
  publicKeySpki,
  signal,
}) => {
  const normalizedOrigin = normalizeOrigin(origin);
  const token = await requireToken(normalizedOrigin);
  await ensureBridgeCompatibility(normalizedOrigin, token, { signal });
  const response = await request(
    normalizedOrigin,
    token,
    "/api/agent-workspaces/runtime-policy/sessions",
    {
      method: "POST",
      signal,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ clientSessionId, observation, publicKeySpki }),
    },
  );
  return normalizeRuntimeHookSessionPayload(await response.json());
};

export const endAgentRuntimeHookSession = async ({
  origin = DEFAULT_ORIGIN,
  runtimeSessionId,
  signal,
}) => {
  const normalizedOrigin = normalizeOrigin(origin);
  const token = await requireToken(normalizedOrigin);
  await ensureBridgeCompatibility(normalizedOrigin, token, { signal });
  await request(
    normalizedOrigin,
    token,
    `/api/agent-workspaces/runtime-policy/sessions/${requireUuid(runtimeSessionId, "runtime session")}/end`,
    { method: "POST", signal },
  );
};

const saveCredential = async (origin, field, accessToken, keychainService) => {
  await ensurePrivateDirectory(CONFIG_DIRECTORY);

  if (USE_LEGACY_MACOS_KEYCHAIN) {
    await run("security", [
      "add-generic-password",
      "-U",
      "-s",
      keychainService,
      "-a",
      origin,
      "-w",
      accessToken,
    ]);
    return "macOS Keychain";
  }

  // Linux/Windows fallback остаётся закрытым правами текущего пользователя.
  // Token никогда не помещается в workspace, Git config или stdout.
  const credentials = await readFallbackCredentials();
  credentials[origin] = {
    ...credentials[origin],
    [field]: accessToken,
    savedAt: new Date().toISOString(),
  };
  await writePrivateJsonFile(CREDENTIAL_FILE, credentials);
  return CREDENTIAL_FILE;
};

const saveLegacyOAuthToken = (origin, accessToken) => (
  saveCredential(origin, "accessToken", accessToken, LEGACY_KEYCHAIN_SERVICE)
);

const saveBridgeSessionToken = (origin, accessToken) => (
  (async () => {
    // Device-session всегда хранится в одном кроссплатформенном файловом
    // контракте. В отличие от legacy OAuth этот путь никогда не вызывает
    // `security add-generic-password` на macOS.
    const credentials = await readFallbackCredentials();
    credentials[origin] = {
      ...credentials[origin],
      bridgeSessionToken: accessToken,
      savedAt: new Date().toISOString(),
    };
    await writePrivateJsonFile(CREDENTIAL_FILE, credentials);
    return CREDENTIAL_FILE;
  })()
);

const readPendingPairings = async () => {
  await ensurePrivateDirectory(CONFIG_DIRECTORY);
  return readPrivateJsonFile(PAIRING_FILE);
};

const writePendingPairings = async (pairings) => {
  if (Object.keys(pairings).length === 0) {
    await fs.rm(PAIRING_FILE, { force: true });
    return;
  }

  await writePrivateJsonFile(PAIRING_FILE, pairings);
};

const getPendingPairing = async (origin) => {
  const pairing = (await readPendingPairings())[origin];

  if (
    !pairing
    || typeof pairing.pairingId !== "string"
    || typeof pairing.codeVerifier !== "string"
    || typeof pairing.deviceName !== "string"
    || typeof pairing.expiresAt !== "string"
  ) {
    return null;
  }

  return pairing;
};

const savePendingPairing = async (origin, pairing) => {
  const pairings = await readPendingPairings();
  pairings[origin] = pairing;
  await writePendingPairings(pairings);
};

const deletePendingPairing = async (origin) => {
  const pairings = await readPendingPairings();
  delete pairings[origin];
  await writePendingPairings(pairings);
};

class BridgePairingRequiredError extends Error {
  constructor(pairing) {
    super([
      "TRELIO_BRIDGE_PAIRING_REQUIRED",
      `Устройство: ${pairing.deviceName}`,
      `Служебный Pairing ID: ${pairing.pairingId}`,
      `Заявка действует до ${pairing.expiresAt}.`,
      "Сразу вызовите MCP tool approve_agent_workspace_bridge_pairing с этим pairingId и deviceName, затем повторите исходную bridge-команду. Не показывайте пользователю код и не просите отдельную фразу подтверждения в чате: если MCP-клиент требует подтверждение tool-вызова, он сам покажет одну штатную кнопку.",
    ].join("\n"));
    this.pairing = pairing;
  }
}

const buildBridgeDeviceIdentity = () => ({
  deviceName: String(os.hostname() || "Local device").trim().slice(0, 120),
  platform: `${process.platform}/${process.arch}`.slice(0, 64),
});

const beginBridgePairing = async (origin, { signal } = {}) => {
  const { verifier, challenge } = createPkce();
  const device = buildBridgeDeviceIdentity();
  const response = await request(origin, null, "/api/agent-workspaces/bridge-pairings", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      codeChallenge: challenge,
      deviceName: device.deviceName,
      platform: device.platform,
    }),
    signal,
  });
  const payload = await response.json();
  const pairing = {
    pairingId: String(payload.pairingId || ""),
    deviceName: String(payload.deviceName || device.deviceName),
    platform: String(payload.platform || device.platform),
    codeVerifier: verifier,
    expiresAt: String(payload.expiresAt || ""),
    createdAt: new Date().toISOString(),
  };

  if (
    !UUID_PATTERN.test(pairing.pairingId)
    || !Number.isFinite(Date.parse(pairing.expiresAt))
  ) {
    throw new Error("Trelio вернул некорректную pairing-заявку.");
  }

  // Verifier остаётся только в приватном локальном файле. В stderr публикуем
  // лишь exact request id и имя устройства, нужные агенту для следующего MCP
  // tool-вызова; отдельного человекочитаемого кода в UX больше нет.
  await savePendingPairing(origin, pairing);
  throw new BridgePairingRequiredError(pairing);
};

const exchangePendingBridgePairing = async (
  origin,
  {
    onStatus = (message) => process.stdout.write(message),
    signal,
  } = {},
) => {
  const pairing = await getPendingPairing(origin);

  if (!pairing) {
    return null;
  }

  if (Date.parse(pairing.expiresAt) <= Date.now()) {
    await deletePendingPairing(origin);
    return null;
  }

  try {
    const response = await request(
      origin,
      null,
      `/api/agent-workspaces/bridge-pairings/${pairing.pairingId}/exchange`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ codeVerifier: pairing.codeVerifier }),
        signal,
      },
    );
    const payload = await response.json();
    const accessToken = String(payload.accessToken || "");

    if (!accessToken.startsWith("twb_")) {
      throw new Error("Trelio вернул некорректную bridge device-session.");
    }

    let storage;
    try {
      storage = await saveBridgeSessionToken(origin, accessToken);
    } catch (storageError) {
      let cleanupError = null;
      try {
        await request(origin, accessToken, "/api/agent-workspaces/bridge-session/self-revoke", {
          method: "POST",
        });
      } catch (error) {
        cleanupError = error;
      }

      // Pairing уже exchanged и повторно использовать verifier нельзя даже
      // после локальной ошибки. Удаляем pending row только после попытки
      // компенсационного revoke, чтобы следующий запуск не создавал ещё одну
      // server session из той же локальной заявки.
      await deletePendingPairing(origin);

      if (cleanupError) {
        throw new Error(
          "Не удалось безопасно сохранить bridge device-session и автоматически отозвать её на сервере. Сессия могла остаться активной; отзовите это устройство через list/revoke Agent Workspace bridge sessions перед повтором.",
          { cause: new AggregateError([storageError, cleanupError]) },
        );
      }

      throw new Error(
        "Не удалось безопасно сохранить bridge device-session. Серверная сессия автоматически отозвана; исправьте права приватного config path и повторите подключение.",
        { cause: storageError },
      );
    }

    await deletePendingPairing(origin);
    onStatus(
      `Устройство ${pairing.deviceName} подключено к Trelio. Device-session сохранена в ${storage}.\n`,
    );
    return accessToken;
  } catch (error) {
    if (
      error instanceof TrelioApiError
      && error.code === "BRIDGE_PAIRING_PENDING"
    ) {
      throw new BridgePairingRequiredError(pairing);
    }

    if (
      error instanceof TrelioApiError
      && [
        "BRIDGE_PAIRING_EXPIRED",
        "BRIDGE_PAIRING_NOT_FOUND",
        "BRIDGE_PAIRING_ALREADY_EXCHANGED",
      ].includes(error.code)
    ) {
      // Expired/consumed requests are not reusable. Starting a fresh pairing
      // is safer than keeping a local verifier that the server will reject.
      await deletePendingPairing(origin);
      return null;
    }

    throw error;
  }
};

export class BrowserOpenError extends Error {
  constructor(message, { cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "BrowserOpenError";
    this.code = "BROWSER_OPEN_FAILED";
  }
}

export const openBrowser = async (
  url,
  {
    platform = process.platform,
    application = null,
    spawnProcess = spawn,
    openerTimeoutMs = 5_000,
    signal,
  } = {},
) => {
  const [command, args] = platform === "darwin"
    // Use the system binary by its absolute path. Besides avoiding a modified
    // PATH, `-a` gives the Remote MCP setup flow a private fallback to a known
    // local browser without ever returning its nonce-bearing URL to the agent.
    ? ["/usr/bin/open", application ? ["-a", application, url] : [url]]
    : platform === "win32"
      ? ["cmd", ["/c", "start", "", url]]
      : ["xdg-open", [url]];

  await new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnProcess(command, args, {
        stdio: "ignore",
        windowsHide: true,
      });
    } catch (error) {
      reject(new BrowserOpenError(
        "Не удалось запустить системное открытие браузера.",
        { cause: error },
      ));
      return;
    }

    let settled = false;
    let timeoutId = null;
    const settle = (callback, value) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      signal?.removeEventListener("abort", handleAbort);
      callback(value);
    };
    const handleAbort = () => {
      try {
        child.kill();
      } catch {
        // The short-lived opener may already have exited.
      }
      settle(
        reject,
        signal.reason instanceof Error
          ? signal.reason
          : new Error("Открытие браузера отменено."),
      );
    };

    if (signal?.aborted) {
      handleAbort();
      return;
    }
    signal?.addEventListener("abort", handleAbort, { once: true });

    // `spawn` only proves that `/usr/bin/open` itself started. LaunchServices
    // may still fail afterwards, so success is acknowledged only when the
    // opener process closes with code 0. The URL is intentionally absent from
    // every diagnostic because Remote MCP setup URLs contain a one-time nonce.
    child.once("error", (error) => settle(
      reject,
      new BrowserOpenError(
        "Не удалось запустить системное открытие браузера.",
        { cause: error },
      ),
    ));
    child.once("close", (code, signal) => {
      if (code === 0) {
        settle(resolve);
        return;
      }
      const result = Number.isInteger(code)
        ? `код ${code}`
        : `сигнал ${signal || "unknown"}`;
      settle(
        reject,
        new BrowserOpenError(
          `Системное открытие браузера завершилось с ошибкой (${result}).`,
        ),
      );
    });
    timeoutId = setTimeout(() => {
      // A wedged OS opener must not turn into another invisible multi-minute
      // wait. It is a short-lived child created by this function, so stopping
      // only that child is safe; the browser, if already launched, is separate.
      try {
        child.kill();
      } catch {
        // The child may have exited between the timer firing and kill().
      }
      settle(
        reject,
        new BrowserOpenError(
          "Системное открытие браузера не завершилось вовремя.",
        ),
      );
    }, openerTimeoutMs);
  });
};

const AGENT_SKILL_DEVICE_CONSENT_TIMEOUT_MS = 5 * 60 * 1000;
const AGENT_SKILL_DEVICE_CONSENT_BODY_LIMIT = 8 * 1024;
const AGENT_SKILL_DEVICE_CONSENT_CAPABILITIES = new Set([
  "browser",
  "local-session",
  "network",
  "secret-checkout",
]);

const escapeAgentSkillConsentHtml = (value) => String(value ?? "")
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;")
  .replaceAll("'", "&#39;");

const normalizeConsentText = (value, maximumLength) => {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized && normalized.length <= maximumLength ? normalized : null;
};

export const normalizeAgentSkillDeviceConsentChallenge = (value) => {
  const company = value?.company;
  const skill = value?.skill;
  const publication = value?.publication;
  const artifact = value?.artifact;
  const changes = value?.changes;
  const publisher = publication?.publisher ?? null;
  const capabilities = Array.isArray(artifact?.capabilities)
    ? [...new Set(artifact.capabilities)]
    : [];
  const addedCapabilities = Array.isArray(changes?.capabilitiesAdded)
    ? [...new Set(changes.capabilitiesAdded)]
    : [];
  const removedCapabilities = Array.isArray(changes?.capabilitiesRemoved)
    ? [...new Set(changes.capabilitiesRemoved)]
    : [];
  const capabilitiesAreSafe = [
    ...capabilities,
    ...addedCapabilities,
    ...removedCapabilities,
  ].every((capability) => (
    typeof capability === "string"
    && AGENT_SKILL_DEVICE_CONSENT_CAPABILITIES.has(capability)
  ));
  const publisherIsSafe = publisher === null || (
    normalizeConsentText(publisher?.displayName, 255)
    && normalizeConsentText(publisher?.username, 64)
  );

  if (
    value?.schemaVersion !== 1
    || value?.trustLevel !== "company_unverified"
    || !UUID_PATTERN.test(String(company?.id || ""))
    || !normalizeConsentText(company?.name, 255)
    || !SKILL_ID_PATTERN.test(String(skill?.id || ""))
    || !normalizeConsentText(skill?.title, 255)
    || !STABLE_VERSION_PATTERN.test(String(skill?.version || ""))
    || !UUID_PATTERN.test(String(skill?.releaseId || ""))
    || !UUID_PATTERN.test(String(publication?.id || ""))
    || !Number.isSafeInteger(publication?.sequence)
    || publication.sequence <= 0
    || !normalizeConsentText(publication?.summary, 2_000)
    || !normalizeConsentText(publication?.changeReason, 2_000)
    || !Number.isFinite(Date.parse(String(publication?.publishedAt || "")))
    || !publisherIsSafe
    || !UUID_PATTERN.test(String(artifact?.id || ""))
    || !STABLE_VERSION_PATTERN.test(String(artifact?.runtimeVersion || ""))
    || !SHA256_PATTERN.test(String(artifact?.packageSha256 || ""))
    || !SHA256_PATTERN.test(String(artifact?.instructionsSha256 || ""))
    || !Number.isSafeInteger(artifact?.packageSizeBytes)
    || artifact.packageSizeBytes <= 0
    || artifact.packageSizeBytes > AGENT_SKILL_MAX_PACKAGE_BYTES
    || !capabilitiesAreSafe
    || !["initial_install", "update", "republish"].includes(changes?.kind)
    || (
      changes?.previousVersion !== null
      && !STABLE_VERSION_PATTERN.test(String(changes?.previousVersion || ""))
    )
    || typeof changes?.packageChanged !== "boolean"
    || typeof changes?.instructionsChanged !== "boolean"
  ) {
    throw new Error("Trelio вернул некорректный запрос согласия на runtime компании.");
  }

  return {
    schemaVersion: 1,
    trustLevel: "company_unverified",
    company: { id: company.id, name: company.name.trim() },
    skill: {
      id: skill.id,
      title: skill.title.trim(),
      version: skill.version,
      releaseId: skill.releaseId,
    },
    publication: {
      id: publication.id,
      sequence: publication.sequence,
      summary: publication.summary.trim(),
      changeReason: publication.changeReason.trim(),
      publishedAt: new Date(publication.publishedAt).toISOString(),
      publisher: publisher === null
        ? null
        : {
            displayName: publisher.displayName.trim(),
            username: publisher.username.trim(),
          },
    },
    artifact: {
      id: artifact.id,
      runtimeVersion: artifact.runtimeVersion,
      packageSha256: artifact.packageSha256,
      packageSizeBytes: artifact.packageSizeBytes,
      instructionsSha256: artifact.instructionsSha256,
      capabilities: capabilities.sort(),
    },
    changes: {
      kind: changes.kind,
      previousVersion: changes.previousVersion,
      packageChanged: changes.packageChanged,
      instructionsChanged: changes.instructionsChanged,
      capabilitiesAdded: addedCapabilities.sort(),
      capabilitiesRemoved: removedCapabilities.sort(),
    },
  };
};

const renderAgentSkillConsentCapability = (capability) => ({
  browser: "Управление браузером",
  "local-session": "Локальная сессия",
  network: "Сетевые запросы",
  "secret-checkout": "Получение разрешённого Agent Secret",
}[capability] || capability);

export const renderAgentSkillDeviceConsentPage = ({ challenge, nonce }) => {
  const publisher = challenge.publication.publisher;
  const capabilityItems = challenge.artifact.capabilities.length > 0
    ? challenge.artifact.capabilities
        .map((capability) => `<li>${escapeAgentSkillConsentHtml(renderAgentSkillConsentCapability(capability))}</li>`)
        .join("")
    : "<li>Дополнительные capabilities не заявлены</li>";
  const changeItems = [
    `Пакет: ${challenge.changes.packageChanged ? "изменён" : "без изменений"}`,
    `Инструкция: ${challenge.changes.instructionsChanged ? "изменена" : "без изменений"}`,
    challenge.changes.capabilitiesAdded.length > 0
      ? `Добавлены права: ${challenge.changes.capabilitiesAdded.map(renderAgentSkillConsentCapability).join(", ")}`
      : null,
    challenge.changes.capabilitiesRemoved.length > 0
      ? `Убраны права: ${challenge.changes.capabilitiesRemoved.map(renderAgentSkillConsentCapability).join(", ")}`
      : null,
  ].filter(Boolean).map((item) => `<li>${escapeAgentSkillConsentHtml(item)}</li>`).join("");
  const previousVersion = challenge.changes.previousVersion
    ? ` после v${escapeAgentSkillConsentHtml(challenge.changes.previousVersion)}`
    : "";
  const packageSizeMb = (challenge.artifact.packageSizeBytes / (1024 * 1024)).toFixed(2);

  return `<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="referrer" content="no-referrer">
  <title>Установка навыка компании</title>
  <style>
    :root { color-scheme: light dark; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    body { margin: 0; background: #f4f7fb; color: #172033; }
    main { width: min(680px, calc(100% - 32px)); margin: 40px auto; background: #fff; border: 1px solid #dce3ef; border-radius: 18px; box-shadow: 0 16px 48px rgba(27, 43, 72, .14); overflow: hidden; }
    header, section, form { padding: 22px 26px; }
    header { background: #fff4e5; border-bottom: 1px solid #f0d4a7; }
    h1 { margin: 0 0 8px; font-size: 24px; }
    h2 { margin: 0 0 10px; font-size: 16px; }
    p { margin: 7px 0; line-height: 1.5; }
    section { border-bottom: 1px solid #e8edf5; }
    dl { display: grid; grid-template-columns: minmax(130px, auto) 1fr; gap: 8px 16px; margin: 0; }
    dt { color: #68758c; } dd { margin: 0; overflow-wrap: anywhere; }
    ul { margin: 8px 0 0; padding-left: 22px; line-height: 1.5; }
    code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; overflow-wrap: anywhere; }
    .warning { color: #8a3d00; font-weight: 700; }
    .actions { display: flex; gap: 12px; justify-content: flex-end; background: #f8faff; }
    button { border-radius: 10px; padding: 11px 16px; font: inherit; font-weight: 700; cursor: pointer; }
    .cancel { border: 1px solid #b8c3d4; background: #fff; color: #27354d; }
    .accept { border: 1px solid #1768d1; background: #1768d1; color: #fff; }
    @media (prefers-color-scheme: dark) {
      body { background: #111827; color: #e8eef9; } main { background: #1b2433; border-color: #344158; } header { background: #3a2d1d; border-color: #6d522e; } section { border-color: #344158; } dt { color: #aeb9cc; } .actions { background: #151d2a; } .cancel { background: #1b2433; color: #e8eef9; border-color: #64718a; } .warning { color: #ffc675; }
    }
  </style>
</head>
<body>
<main>
  <header>
    <h1>Навык не проверен Trelio</h1>
    <p class="warning">Код загрузил администратор компании. Он будет запущен с правами вашей учётной записи ОС.</p>
    <p>Подпись Trelio подтверждает, что пакет не изменился при доставке, но не означает, что Trelio проверил код.</p>
  </header>
  <section>
    <h2>${escapeAgentSkillConsentHtml(challenge.skill.title)} · v${escapeAgentSkillConsentHtml(challenge.skill.version)}${previousVersion}</h2>
    <dl>
      <dt>Компания</dt><dd>${escapeAgentSkillConsentHtml(challenge.company.name)}</dd>
      <dt>Опубликовал</dt><dd>${publisher ? `${escapeAgentSkillConsentHtml(publisher.displayName)} (@${escapeAgentSkillConsentHtml(publisher.username)})` : "Администратор компании"}</dd>
      <dt>Что изменилось</dt><dd>${escapeAgentSkillConsentHtml(challenge.publication.summary)}</dd>
      <dt>Причина</dt><dd>${escapeAgentSkillConsentHtml(challenge.publication.changeReason)}</dd>
    </dl>
  </section>
  <section>
    <h2>Изменения этой публикации</h2>
    <ul>${changeItems}</ul>
    <h2 style="margin-top:16px">Заявленные возможности</h2>
    <ul>${capabilityItems}</ul>
  </section>
  <section>
    <dl>
      <dt>Runtime</dt><dd>${escapeAgentSkillConsentHtml(challenge.artifact.runtimeVersion)}</dd>
      <dt>Размер</dt><dd>${escapeAgentSkillConsentHtml(packageSizeMb)} МБ</dd>
      <dt>SHA-256 package</dt><dd><code>${escapeAgentSkillConsentHtml(challenge.artifact.packageSha256)}</code></dd>
      <dt>SHA-256 инструкции</dt><dd><code>${escapeAgentSkillConsentHtml(challenge.artifact.instructionsSha256)}</code></dd>
    </dl>
  </section>
  <form method="post" action="/decision" class="actions">
    <input type="hidden" name="nonce" value="${escapeAgentSkillConsentHtml(nonce)}">
    <button class="cancel" type="submit" name="decision" value="decline">Отмена</button>
    <button class="accept" type="submit" name="decision" value="accept">Установить и запустить</button>
  </form>
</main>
</body>
</html>`;
};

const readAgentSkillConsentBody = async (incoming) => {
  const chunks = [];
  let sizeBytes = 0;

  for await (const chunk of incoming) {
    sizeBytes += chunk.length;
    if (sizeBytes > AGENT_SKILL_DEVICE_CONSENT_BODY_LIMIT) {
      throw new Error("Подтверждение не выполнено: локальная форма отправила слишком большой запрос.");
    }
    chunks.push(chunk);
  }

  return Buffer.concat(chunks).toString("utf8");
};

const readAgentSkillConsentHeader = (incoming, name) => {
  const value = incoming.headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] || "" : String(value || "");
};

const isAgentSkillConsentLoopbackAddress = (address) => (
  address === "127.0.0.1"
  || address === "::1"
  || address === "::ffff:127.0.0.1"
);

const writeAgentSkillConsentHtml = (outgoing, statusCode, html, onFinished) => {
  outgoing.writeHead(statusCode, {
    "cache-control": "no-store",
    "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    "content-type": "text/html; charset=utf-8",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
  });
  outgoing.end(html, onFinished);
};

export class AgentSkillDeviceConsentDeclinedError extends Error {
  constructor() {
    super("AGENT_SKILL_DEVICE_CONSENT_DECLINED: пользователь отменил установку навыка компании.");
    this.code = "AGENT_SKILL_DEVICE_CONSENT_DECLINED";
  }
}

export const collectAgentSkillDeviceConsentThroughLoopback = async ({
  origin,
  token,
  challenge: rawChallenge,
  companyId,
  projectId = null,
  skillId,
  releaseId,
}, {
  openBrowserFn = openBrowser,
  requestFn = request,
  timeoutMs = AGENT_SKILL_DEVICE_CONSENT_TIMEOUT_MS,
  onListening = () => {},
} = {}) => {
  const challenge = normalizeAgentSkillDeviceConsentChallenge(rawChallenge);

  if (
    challenge.company.id !== companyId
    || challenge.skill.id !== skillId
    || challenge.skill.releaseId !== releaseId
  ) {
    throw new Error("Запрос согласия не совпадает с exact командой get_agent_skill.");
  }

  const nonce = crypto.randomBytes(32).toString("base64url");
  let expectedOrigin = "";
  let expectedHost = "";
  let expectedPort = 0;
  let settled = false;
  let complete;
  let fail;
  const completion = new Promise((resolve, reject) => {
    complete = resolve;
    fail = reject;
  });
  completion.catch(() => {});

  const server = http.createServer(async (incoming, outgoing) => {
    try {
      const requestUrl = new URL(incoming.url || "/", expectedOrigin || "http://127.0.0.1");
      const exactSocket = (
        isAgentSkillConsentLoopbackAddress(incoming.socket.remoteAddress)
        && incoming.socket.localAddress === "127.0.0.1"
        && incoming.socket.localPort === expectedPort
        && readAgentSkillConsentHeader(incoming, "host") === expectedHost
      );

      if (
        incoming.method === "GET"
        && requestUrl.pathname === "/"
        && requestUrl.origin === expectedOrigin
        && requestUrl.searchParams.get("nonce") === nonce
        && exactSocket
      ) {
        writeAgentSkillConsentHtml(
          outgoing,
          200,
          renderAgentSkillDeviceConsentPage({ challenge, nonce }),
        );
        return;
      }

      if (incoming.method !== "POST" || requestUrl.pathname !== "/decision") {
        outgoing.writeHead(404, { "cache-control": "no-store" }).end("Not found");
        return;
      }

      const originHeader = readAgentSkillConsentHeader(incoming, "origin");
      const authorizedOrigin = originHeader === expectedOrigin || (
        (originHeader === "" || originHeader === "null")
        && readAgentSkillConsentHeader(incoming, "sec-fetch-site") === "same-origin"
        && readAgentSkillConsentHeader(incoming, "sec-fetch-mode") === "navigate"
        && readAgentSkillConsentHeader(incoming, "sec-fetch-dest") === "document"
        && readAgentSkillConsentHeader(incoming, "sec-fetch-user") === "?1"
      );
      const contentType = readAgentSkillConsentHeader(incoming, "content-type").toLowerCase();

      if (
        settled
        || requestUrl.origin !== expectedOrigin
        || requestUrl.search !== ""
        || !exactSocket
        || !authorizedOrigin
        || !contentType.startsWith("application/x-www-form-urlencoded")
      ) {
        incoming.resume();
        writeAgentSkillConsentHtml(
          outgoing,
          403,
          "<!doctype html><meta charset=utf-8><title>Запрос отклонён</title><p>Защитная проверка локальной формы не пройдена. Закройте вкладку и повторите запуск навыка.</p>",
        );
        return;
      }

      const form = new URLSearchParams(await readAgentSkillConsentBody(incoming));
      const decision = form.get("decision");
      if (form.get("nonce") !== nonce || !["accept", "decline"].includes(decision)) {
        writeAgentSkillConsentHtml(
          outgoing,
          403,
          "<!doctype html><meta charset=utf-8><title>Запрос отклонён</title><p>Одноразовое подтверждение недействительно. Закройте вкладку и повторите запуск навыка.</p>",
        );
        return;
      }

      // Both POST requests may pass the cheap pre-body checks while their
      // bodies are still arriving. Claim the one-shot decision only after the
      // bounded form has been read and validated, then recheck synchronously
      // before any response callback or remote grant can create a side effect.
      // JavaScript runs this short section without an await, so exactly one
      // valid decision can change `settled` from false to true.
      if (settled) {
        writeAgentSkillConsentHtml(
          outgoing,
          403,
          "<!doctype html><meta charset=utf-8><title>Запрос отклонён</title><p>Решение по этой одноразовой форме уже принято. Закройте вкладку и повторите запуск навыка.</p>",
        );
        return;
      }

      settled = true;
      if (decision === "decline") {
        const declinedError = new AgentSkillDeviceConsentDeclinedError();
        writeAgentSkillConsentHtml(
          outgoing,
          200,
          "<!doctype html><meta charset=utf-8><title>Установка отменена</title><p>Навык не установлен. Эту вкладку можно закрыть.</p>",
          () => fail(declinedError),
        );
        return;
      }

      try {
        await requestFn(origin, token, "/api/agent-skills/runtime/device-consents", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            companyId,
            ...(projectId ? { projectId } : {}),
            skillId,
            expectedReleaseId: releaseId,
            publicationId: challenge.publication.id,
            runtimeArtifactId: challenge.artifact.id,
            packageSha256: challenge.artifact.packageSha256,
            instructionsSha256: challenge.artifact.instructionsSha256,
          }),
        });
      } catch (error) {
        writeAgentSkillConsentHtml(
          outgoing,
          409,
          "<!doctype html><meta charset=utf-8><title>Навык не установлен</title><p>Версия могла измениться или Trelio сейчас недоступен. Закройте вкладку, перечитайте текущую публикацию и повторите запуск.</p>",
          () => fail(error),
        );
        return;
      }

      writeAgentSkillConsentHtml(
        outgoing,
        200,
        "<!doctype html><meta charset=utf-8><title>Навык установлен</title><p>Эта версия разрешена на устройстве и будет запущена. Вкладку можно закрыть.</p>",
        () => complete(true),
      );
    } catch (error) {
      if (!outgoing.headersSent && !outgoing.destroyed) {
        outgoing.writeHead(500, { "cache-control": "no-store" }).end(
          "Подтверждение не выполнено. Закройте вкладку и повторите запуск навыка.",
        );
      } else {
        outgoing.destroy();
      }
      fail(error);
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  const closeServer = () => new Promise((resolve) => {
    if (!server.listening) {
      server.closeAllConnections();
      resolve();
      return;
    }
    server.close(resolve);
    server.closeAllConnections();
  });

  try {
    const address = server.address();
    if (!address || typeof address !== "object") {
      throw new Error("Локальная форма согласия не получила loopback port.");
    }
    expectedOrigin = `http://127.0.0.1:${address.port}`;
    expectedHost = `127.0.0.1:${address.port}`;
    expectedPort = address.port;
    onListening({ port: address.port });

    process.stdout.write(
      "Открываю защищённое локальное окно: проверьте издателя, причины и изменения навыка компании.\n",
    );
    await openBrowserFn(
      `${expectedOrigin}/?${new URLSearchParams({ nonce }).toString()}`,
    );

    let timeoutId;
    const timeout = new Promise((_, reject) => {
      timeoutId = setTimeout(() => reject(new Error(
        "AGENT_SKILL_DEVICE_CONSENT_TIMEOUT: время локального подтверждения истекло.",
      )), timeoutMs);
    });
    return await Promise.race([completion, timeout])
      .finally(() => clearTimeout(timeoutId));
  } finally {
    await closeServer();
  }
};

export const renderCompanyEncryptionKeyPage = ({ companyName, nonce }) => `<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="referrer" content="no-referrer">
  <title>Ключ шифрования Trelio</title>
  <style>
    :root { color-scheme: light dark; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    body { margin: 0; background: #f4f7fb; color: #172033; }
    main { width: min(560px, calc(100% - 32px)); margin: 40px auto; padding: 26px; box-sizing: border-box; background: #fff; border: 1px solid #dce3ef; border-radius: 18px; box-shadow: 0 16px 48px rgba(27, 43, 72, .14); }
    h1 { margin: 0 0 10px; font-size: 24px; } p { line-height: 1.5; }
    label { display: grid; gap: 7px; margin-top: 18px; font-weight: 700; }
    input { box-sizing: border-box; width: 100%; padding: 12px; border: 1px solid #aebbd0; border-radius: 10px; font: inherit; }
    small { display: block; margin-top: 10px; color: #68758c; line-height: 1.45; }
    .actions { display: flex; gap: 12px; justify-content: flex-end; margin-top: 22px; }
    button { border-radius: 10px; padding: 11px 16px; font: inherit; font-weight: 700; cursor: pointer; }
    .cancel { border: 1px solid #b8c3d4; background: #fff; color: #27354d; }
    .save { border: 1px solid #1768d1; background: #1768d1; color: #fff; }
    @media (prefers-color-scheme: dark) { body { background: #111827; color: #e8eef9; } main { background: #1b2433; border-color: #344158; } input, .cancel { background: #111827; color: #e8eef9; border-color: #64718a; } small { color: #aeb9cc; } }
  </style>
</head>
<body>
<main>
  <h1>Подключить Agent Workspaces</h1>
  <p>Компания «${escapeAgentSkillConsentHtml(companyName)}» зашифрована. Введите ключ шифрования в этой локальной форме.</p>
  <p>Фраза останется на компьютере и не попадёт в Trelio, командную строку, Workspace или логи.</p>
  <form method="post" action="/unlock">
    <input type="hidden" name="nonce" value="${escapeAgentSkillConsentHtml(nonce)}">
    <label>Ключ шифрования
      <input type="password" name="secret" minlength="12" maxlength="4096" autocomplete="new-password" required autofocus>
    </label>
    <label>Повторите ключ
      <input type="password" name="confirmation" minlength="12" maxlength="4096" autocomplete="new-password" required>
    </label>
    <small>После подключения bridge сохранит только локально защищённый ключ устройства. Повторно вводить фразу на этом компьютере не понадобится.</small>
    <div class="actions">
      <button class="cancel" type="submit" name="decision" value="cancel">Отмена</button>
      <button class="save" type="submit" name="decision" value="save">Сохранить на устройстве</button>
    </div>
  </form>
</main>
</body>
</html>`;

/**
 * Collect the encryption key in an exact loopback-only form. The value is
 * returned in process memory once and is never printed or sent over the
 * network. Tests can inject their own opener and observe the ephemeral port.
 */
export const collectCompanyEncryptionKeyThroughLoopback = async ({
  companyName,
}, {
  openBrowserFn = openBrowser,
  timeoutMs = 5 * 60 * 1000,
  onListening = () => {},
} = {}) => {
  const nonce = crypto.randomBytes(32).toString("base64url");
  let expectedOrigin = "";
  let expectedHost = "";
  let expectedPort = 0;
  let settled = false;
  let complete;
  let fail;
  const completion = new Promise((resolve, reject) => {
    complete = resolve;
    fail = reject;
  });
  completion.catch(() => {});
  const server = http.createServer(async (incoming, outgoing) => {
    try {
      const requestUrl = new URL(incoming.url || "/", expectedOrigin || "http://127.0.0.1");
      const exactSocket = (
        isAgentSkillConsentLoopbackAddress(incoming.socket.remoteAddress)
        && incoming.socket.localAddress === "127.0.0.1"
        && incoming.socket.localPort === expectedPort
        && readAgentSkillConsentHeader(incoming, "host") === expectedHost
      );

      if (
        incoming.method === "GET"
        && requestUrl.pathname === "/"
        && requestUrl.origin === expectedOrigin
        && requestUrl.searchParams.get("nonce") === nonce
        && exactSocket
      ) {
        writeAgentSkillConsentHtml(
          outgoing,
          200,
          renderCompanyEncryptionKeyPage({ companyName, nonce }),
        );
        return;
      }

      if (incoming.method !== "POST" || requestUrl.pathname !== "/unlock") {
        outgoing.writeHead(404, { "cache-control": "no-store" }).end("Not found");
        return;
      }

      const originHeader = readAgentSkillConsentHeader(incoming, "origin");
      const authorizedOrigin = originHeader === expectedOrigin || (
        (originHeader === "" || originHeader === "null")
        && readAgentSkillConsentHeader(incoming, "sec-fetch-site") === "same-origin"
        && readAgentSkillConsentHeader(incoming, "sec-fetch-mode") === "navigate"
        && readAgentSkillConsentHeader(incoming, "sec-fetch-dest") === "document"
        && readAgentSkillConsentHeader(incoming, "sec-fetch-user") === "?1"
      );
      const contentType = readAgentSkillConsentHeader(incoming, "content-type").toLowerCase();

      if (
        settled
        || requestUrl.origin !== expectedOrigin
        || requestUrl.search !== ""
        || !exactSocket
        || !authorizedOrigin
        || !contentType.startsWith("application/x-www-form-urlencoded")
      ) {
        incoming.resume();
        writeAgentSkillConsentHtml(
          outgoing,
          403,
          "<!doctype html><meta charset=utf-8><title>Запрос отклонён</title><p>Защитная проверка локальной формы не пройдена.</p>",
        );
        return;
      }

      const form = new URLSearchParams(await readAgentSkillConsentBody(incoming));
      const decision = form.get("decision");
      const secret = form.get("secret") || "";
      const confirmation = form.get("confirmation") || "";

      if (form.get("nonce") !== nonce || !["save", "cancel"].includes(decision)) {
        writeAgentSkillConsentHtml(
          outgoing,
          403,
          "<!doctype html><meta charset=utf-8><title>Запрос отклонён</title><p>Одноразовая локальная форма недействительна.</p>",
        );
        return;
      }

      if (decision === "save" && (secret.length < 12 || secret !== confirmation)) {
        writeAgentSkillConsentHtml(
          outgoing,
          400,
          "<!doctype html><meta charset=utf-8><title>Ключ не сохранён</title><p>Ключ должен содержать не меньше 12 символов, а оба значения должны совпадать. Закройте вкладку и повторите подключение.</p>",
        );
        return;
      }

      if (settled) {
        writeAgentSkillConsentHtml(outgoing, 403, "<!doctype html><p>Форма уже использована.</p>");
        return;
      }
      settled = true;

      if (decision === "cancel") {
        const error = new Error("TRELIO_ENCRYPTION_DEVICE_SETUP_CANCELLED: подключение зашифрованной компании отменено.");
        error.code = "TRELIO_ENCRYPTION_DEVICE_SETUP_CANCELLED";
        writeAgentSkillConsentHtml(
          outgoing,
          200,
          "<!doctype html><meta charset=utf-8><title>Подключение отменено</title><p>Ключ не сохранён. Вкладку можно закрыть.</p>",
          () => fail(error),
        );
        return;
      }

      writeAgentSkillConsentHtml(
        outgoing,
        200,
        "<!doctype html><meta charset=utf-8><title>Устройство подготовлено</title><p>Ключ обрабатывается локально. Вкладку можно закрыть.</p>",
        () => complete(secret),
      );
    } catch (error) {
      if (!outgoing.headersSent && !outgoing.destroyed) {
        outgoing.writeHead(500, { "cache-control": "no-store" }).end("Локальная форма не обработана.");
      } else {
        outgoing.destroy();
      }
      fail(error);
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const closeServer = () => new Promise((resolve) => {
    if (!server.listening) {
      server.closeAllConnections();
      resolve();
      return;
    }
    server.close(resolve);
    server.closeAllConnections();
  });

  try {
    const address = server.address();
    if (!address || typeof address !== "object") throw new Error("Локальная форма не получила loopback port.");
    expectedOrigin = `http://127.0.0.1:${address.port}`;
    expectedHost = `127.0.0.1:${address.port}`;
    expectedPort = address.port;
    onListening({ port: address.port, nonce });
    process.stdout.write("Открываю локальную форму ключа шифрования Trelio.\n");
    await openBrowserFn(`${expectedOrigin}/?${new URLSearchParams({ nonce }).toString()}`);
    let timeoutId;
    const timeout = new Promise((_, reject) => {
      timeoutId = setTimeout(() => reject(new Error(
        "TRELIO_ENCRYPTION_DEVICE_SETUP_TIMEOUT: время локальной формы истекло.",
      )), timeoutMs);
    });
    return await Promise.race([completion, timeout]).finally(() => clearTimeout(timeoutId));
  } finally {
    await closeServer();
  }
};

const resolveCompanyEncryptionDevicePaths = ({ origin, companyId }) => {
  const originHash = crypto.createHash("sha256").update(origin).digest("hex").slice(0, 32);
  const companyDirectory = path.join(
    COMPANY_ENCRYPTION_DEVICE_DIRECTORY,
    originHash,
    requireUuid(companyId, "company"),
  );

  return {
    companyDirectory,
    deviceFile: path.join(companyDirectory, "device.json"),
    trustedUnlockFile: path.join(companyDirectory, "trusted-unlock.json"),
  };
};

const loadRememberedCompanyEncryptionDevice = async ({ origin, companyId }) => {
  const paths = resolveCompanyEncryptionDevicePaths({ origin, companyId });
  const [record, unlockRecord] = await Promise.all([
    readPrivateJsonFile(paths.deviceFile),
    readPrivateJsonFile(paths.trustedUnlockFile),
  ]);
  const hasRecord = Object.keys(record).length > 0;
  const hasUnlockRecord = Object.keys(unlockRecord).length > 0;

  if (!hasRecord && !hasUnlockRecord) {
    return { paths, device: null };
  }
  if (!hasRecord || !hasUnlockRecord) {
    throw new Error(
      "Локальный ключ Agent Workspaces записан не полностью. Удалите exact каталог устройства и подключите его заново: "
      + paths.companyDirectory,
    );
  }
  if (
    record.companyId !== companyId
    || unlockRecord.companyId !== companyId
    || unlockRecord.fingerprint !== record.fingerprint
    || typeof unlockRecord.trustedUnlockKey !== "string"
  ) {
    throw new Error("Локальный ключ Agent Workspaces не соответствует выбранной компании.");
  }

  return {
    paths,
    device: await unlockRememberedAgentEncryptionDevice({
      record,
      trustedUnlockKey: unlockRecord.trustedUnlockKey,
    }),
  };
};

const persistRememberedCompanyEncryptionDevice = async ({
  paths,
  companyId,
  record,
  trustedUnlockKey,
}) => {
  // Обе записи принадлежат owner-only private config. Фраза пользователя сюда
  // не попадает: unlock record содержит только случайно посоленный KDF-result,
  // которым bridge открывает exact wrapped device bundle на этом компьютере.
  await writePrivateJsonFile(paths.deviceFile, record);
  try {
    await writePrivateJsonFile(paths.trustedUnlockFile, {
      format: "trelio-agent-encryption-device-unlock",
      version: 1,
      companyId,
      fingerprint: record.fingerprint,
      trustedUnlockKey,
      createdAt: new Date().toISOString(),
    });
  } catch (error) {
    // Не оставляем половину пары: без unlock record device всё равно нельзя
    // открыть, а явное удаление позволяет безопасно повторить регистрацию.
    await fs.rm(paths.deviceFile, { force: true }).catch(() => undefined);
    throw error;
  }
};

const registerCompanyEncryptionDevice = async ({
  origin,
  token,
  runtime,
  device,
}) => {
  const record = buildAgentDeviceRegistrationRecord({
    companyId: runtime.company.id,
    userId: runtime.viewer.userId,
    fingerprint: device.fingerprint,
    publicEncryptionJwk: device.publicEncryptionJwk,
    publicSigningJwk: device.publicSigningJwk,
  });
  const registrationSignature = await signCompanyEncryptionRecord(
    device.privateKeys.signingPrivateKey,
    record,
  );
  const response = await request(
    origin,
    token,
    "/api/agent-workspaces/encryption/devices",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        companySlug: runtime.company.slug,
        suite: COMPANY_ENCRYPTION_SUITE,
        name: `Agent Workspaces – ${os.hostname()}`.slice(0, 255),
        platform: `${process.platform}/${process.arch}`.slice(0, 64),
        publicEncryptionJwk: device.publicEncryptionJwk,
        publicSigningJwk: device.publicSigningJwk,
        fingerprint: device.fingerprint,
        registrationSignature,
      }),
    },
  );
  return readJsonResponse(response);
};

const readCompanyEncryptionRuntime = async ({
  origin,
  token,
  companySlug,
  fingerprint = null,
}) => {
  const query = new URLSearchParams({ companySlug });
  if (fingerprint) query.set("fingerprint", fingerprint);
  const runtime = await readJsonResponse(await request(
    origin,
    token,
    `/api/agent-workspaces/encryption/runtime?${query.toString()}`,
  ));

  if (
    !runtime
    || runtime.suite !== COMPANY_ENCRYPTION_SUITE
    || runtime.company?.slug !== companySlug
    || !UUID_PATTERN.test(String(runtime.company?.id || ""))
  ) {
    throw new Error("Trelio вернул некорректный encryption runtime компании.");
  }
  return runtime;
};

const assertEncryptedCompanyRuntimeState = (runtime) => {
  if (runtime.state === "encrypted") return;

  const stateExplanations = {
    encrypting: "Компания ещё шифруется. Дождитесь завершения операции в настройках компании.",
    decrypting: "Компания сейчас расшифровывается. Настройка encrypted device недоступна до завершения операции.",
    failed: "Переход компании в режим шифрования завершился ошибкой. Сначала устраните её в настройках компании.",
  };
  const explanation = stateExplanations[runtime.state]
    || `Trelio вернул неподдерживаемое состояние шифрования: ${String(runtime.state || "unknown")}.`;

  // Transitional and unknown states are deliberately fail-closed. Creating a
  // device while the company key hierarchy is unstable could bind the local
  // identity to an envelope that is already obsolete, so the bridge never
  // guesses that every non-plain state is equivalent to `encrypted`.
  throw new Error(`Шифрование Agent Workspaces пока не готово. ${explanation}`);
};

/**
 * Open the company scope for the local bridge without ever placing a private
 * key or the user's phrase in argv, stdout, a Workspace, or an API request.
 */
export const ensureCompanyEncryptionContext = async ({
  origin,
  token,
  company,
  collectEncryptionKey = collectCompanyEncryptionKeyThroughLoopback,
}) => {
  const initialRuntime = await readCompanyEncryptionRuntime({
    origin,
    token,
    companySlug: company.slug,
  });

  if (initialRuntime.state === "plain") return null;
  assertEncryptedCompanyRuntimeState(initialRuntime);
  if (!initialRuntime.viewer?.userId) {
    throw new Error("Trelio не вернул пользователя для локального encryption device.");
  }

  let { paths, device } = await loadRememberedCompanyEncryptionDevice({
    origin,
    companyId: initialRuntime.company.id,
  });

  if (!device) {
    let encryptionSecret = await collectEncryptionKey({
      companyName: initialRuntime.company.name,
    });
    const generatedDevice = await createAgentEncryptionDevice();
    const wrapped = await wrapAndRememberAgentEncryptionDevice({
      device: generatedDevice,
      encryptionSecret,
      companyId: initialRuntime.company.id,
    });
    // JS strings cannot be reliably zeroized, but dropping the only reference
    // immediately keeps the phrase out of persistent state and later closures.
    encryptionSecret = "";
    await persistRememberedCompanyEncryptionDevice({
      paths,
      companyId: initialRuntime.company.id,
      record: wrapped.record,
      trustedUnlockKey: wrapped.trustedUnlockKey,
    });
    device = generatedDevice;
  }

  let runtime = await readCompanyEncryptionRuntime({
    origin,
    token,
    companySlug: initialRuntime.company.slug,
    fingerprint: device.fingerprint,
  });
  assertEncryptedCompanyRuntimeState(runtime);

  if (runtime.accessState === "registration_required") {
    await registerCompanyEncryptionDevice({ origin, token, runtime, device });
    runtime = await readCompanyEncryptionRuntime({
      origin,
      token,
      companySlug: initialRuntime.company.slug,
      fingerprint: device.fingerprint,
    });
    assertEncryptedCompanyRuntimeState(runtime);
  }

  if (runtime.accessState === "access_pending") {
    throw new Error(
      `Устройство ${device.fingerprint} зарегистрировано, но ещё не получило доступ. `
      + `Владелец компании должен открыть ${origin}/${runtime.company.slug}/settings/encryption/ `
      + "и нажать «Выдать доступ» у этого Agent Workspaces device, затем команду можно повторить.",
    );
  }
  if (runtime.accessState !== "ready" || !runtime.scope || !runtime.envelope) {
    throw new Error(`Зашифрованная компания недоступна локальному устройству: ${runtime.accessState}.`);
  }
  if (
    runtime.device?.fingerprint !== device.fingerprint
    || runtime.envelope.recipientType !== "agent_device"
    || runtime.envelope.recipientId !== runtime.device.id
    || runtime.envelope.scopeId !== runtime.scope.id
    || runtime.envelope.scopeEpoch !== runtime.scope.epoch
  ) {
    throw new Error("Trelio вернул envelope другого устройства или scope.");
  }

  return {
    runtime,
    device,
    scopePrivateEncryptionKey: await openScopePrivateKey({
      device,
      envelope: runtime.envelope,
    }),
    metadata: {
      enabled: true,
      companyId: runtime.company.id,
      companySlug: runtime.company.slug,
      deviceId: runtime.device.id,
      deviceFingerprint: runtime.device.fingerprint,
      scopeId: runtime.scope.id,
      scopeEpoch: runtime.scope.epoch,
      suite: runtime.suite,
    },
  };
};

/**
 * Prove that the exact company scope opened for this device can round-trip the
 * production TRELIOE1 container. The canary contains only random local bytes,
 * never creates a Workspace/Run, and is removed before the command succeeds.
 */
export const runCompanyEncryptionSelfTest = async (companyEncryption) => {
  const runtime = companyEncryption?.runtime;
  const device = companyEncryption?.device;
  const scopePrivateEncryptionKey = companyEncryption?.scopePrivateEncryptionKey;

  if (
    runtime?.state !== "encrypted"
    || runtime?.accessState !== "ready"
    || !runtime.scope?.publicEncryptionJwk
    || !runtime.device?.id
    || !device?.privateKeys?.signingPrivateKey
    || !scopePrivateEncryptionKey?.privateKey
    || !scopePrivateEncryptionKey?.privateJwk
  ) {
    throw new Error("Локальный encryption self-test получил неполный ready-контекст компании.");
  }

  const temporaryDirectory = await fs.mkdtemp(path.join(
    os.tmpdir(),
    "trelio-company-encryption-self-test-",
  ));
  const sourcePath = path.join(temporaryDirectory, "canary.bin");
  const encryptedPath = path.join(temporaryDirectory, "canary.trelioe1");
  const decryptedPath = path.join(temporaryDirectory, "canary.opened.bin");
  const canary = crypto.randomBytes(64);
  let openedCanary = null;

  try {
    await fs.writeFile(sourcePath, canary, { mode: 0o600 });
    const encrypted = await encryptFileToCompanyContainer({
      sourcePath,
      destinationPath: encryptedPath,
      scopePublicEncryptionJwk: runtime.scope.publicEncryptionJwk,
      aad: {
        companyId: requireUuid(runtime.company.id, "company"),
        scopeId: requireUuid(runtime.scope.id, "scope"),
        scopeEpoch: runtime.scope.epoch,
        entityType: "agent_workspace_encryption_self_test",
        entityId: crypto.randomUUID(),
        entityRevision: 1,
        schemaVersion: 1,
      },
      originalName: "agent-workspaces-self-test.bin",
      mimeType: "application/octet-stream",
      writerDeviceId: runtime.device.id,
      signingPrivateKey: device.privateKeys.signingPrivateKey,
    });
    const decrypted = await decryptFileFromCompanyContainer({
      sourcePath: encryptedPath,
      destinationPath: decryptedPath,
      scopePrivateKey: scopePrivateEncryptionKey.privateKey,
      scopePrivateJwk: scopePrivateEncryptionKey.privateJwk,
      expectedCiphertextSha256: encrypted.ciphertextSha256,
    });
    openedCanary = await fs.readFile(decryptedPath);

    if (
      decrypted.originalName !== "agent-workspaces-self-test.bin"
      || openedCanary.byteLength !== canary.byteLength
      || !crypto.timingSafeEqual(openedCanary, canary)
    ) {
      throw new Error("Локальный TRELIOE1 self-test вернул другие данные.");
    }

    return {
      status: "passed",
      format: "TRELIOE1",
      suite: runtime.suite,
    };
  } finally {
    // Canary bytes are not company data, but clearing the in-memory buffers and
    // deleting the exact private temp directory keeps the diagnostic contract
    // as strict as the real encrypted Workspace flow.
    canary.fill(0);
    openedCanary?.fill(0);
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
  }
};

const requireCompanySlugOption = (options) => {
  const companySlug = readSingleRuntimeOption(options, "company");

  if (
    !companySlug
    || companySlug.length > 255
    || !RUNTIME_POLICY_COMPANY_SLUG_PATTERN.test(companySlug)
  ) {
    throw new Error("Параметр --company должен содержать точный slug компании.");
  }
  return companySlug;
};

const setupCompanyEncryption = async (origin, options) => {
  const companySlug = requireCompanySlugOption(options);
  if (options.json !== undefined && options.json !== true) {
    throw new Error("Параметр --json не принимает значение.");
  }

  const token = await requireToken(origin);
  await ensureBridgeCompatibility(origin, token);
  const companyEncryption = await ensureCompanyEncryptionContext({
    origin,
    token,
    company: { slug: companySlug },
  });
  const result = companyEncryption
    ? {
        schemaVersion: 1,
        status: "ready",
        company: {
          id: companyEncryption.runtime.company.id,
          slug: companyEncryption.runtime.company.slug,
          name: companyEncryption.runtime.company.name,
        },
        encryptionState: companyEncryption.runtime.state,
        deviceFingerprint: companyEncryption.runtime.device.fingerprint,
        selfTest: await runCompanyEncryptionSelfTest(companyEncryption),
      }
    : {
        schemaVersion: 1,
        status: "not_required",
        company: { slug: companySlug },
        encryptionState: "plain",
        selfTest: null,
      };

  if (options.json === true) {
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } else if (result.status === "ready") {
    process.stdout.write(
      `Шифрование Agent Workspaces готово для ${result.company.slug}: `
      + `устройство ${result.deviceFingerprint}, локальный TRELIOE1 self-test пройден.\n`,
    );
  } else {
    process.stdout.write(
      `Компания ${result.company.slug} работает без company E2EE; отдельная настройка не требуется.\n`,
    );
  }

  return result;
};

const ENCRYPTED_TEXT_MARKER_PATTERN = /^~e1:([0-9a-f-]{36}):([a-z][a-z0-9_]{0,63})~$/u;
const EMBEDDED_ENCRYPTED_TEXT_MARKER_PATTERN = /~e1:([0-9a-f-]{36}):([a-z][a-z0-9_]{0,63})~/gu;

const parseAgentEncryptedContentReference = (value) => {
  if (typeof value === "string") {
    const match = ENCRYPTED_TEXT_MARKER_PATTERN.exec(value);
    return match ? { entityId: match[1], field: match[2] } : null;
  }
  const candidate = Array.isArray(value) && value.length === 1 ? value[0] : value;
  if (
    !candidate
    || typeof candidate !== "object"
    || Array.isArray(candidate)
    || Object.keys(candidate).length !== 1
  ) {
    return null;
  }
  const marker = candidate.$trelioE2ee;
  if (
    !marker
    || typeof marker !== "object"
    || Array.isArray(marker)
    || Object.keys(marker).sort().join(",") !== "field,id,v"
    || marker.v !== 1
    || !UUID_PATTERN.test(String(marker.id || ""))
    || !/^[a-z][a-z0-9_]{0,63}$/u.test(String(marker.field || ""))
  ) {
    return null;
  }
  return { entityId: marker.id, field: marker.field };
};

const collectAgentEncryptedReferences = (value, result = new Map()) => {
  const direct = parseAgentEncryptedContentReference(value);
  if (direct) {
    result.set(direct.entityId, direct);
    return result;
  }
  if (typeof value === "string") {
    for (const match of value.matchAll(EMBEDDED_ENCRYPTED_TEXT_MARKER_PATTERN)) {
      result.set(match[1], { entityId: match[1], field: match[2] });
    }
  } else if (Array.isArray(value)) {
    value.forEach((item) => collectAgentEncryptedReferences(item, result));
  } else if (value && typeof value === "object") {
    Object.values(value).forEach((item) => collectAgentEncryptedReferences(item, result));
  }
  return result;
};

export const hydrateAgentCompanyEncryptedJson = async ({
  value,
  origin,
  token,
  companyEncryption,
}) => {
  if (!companyEncryption) return value;
  const references = collectAgentEncryptedReferences(value);
  if (references.size === 0) return value;
  const response = await readJsonResponse(await request(
    origin,
    token,
    "/api/agent-workspaces/encryption/payloads/resolve",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        companySlug: companyEncryption.runtime.company.slug,
        recipientDeviceId: companyEncryption.runtime.device.id,
        entityIds: [...references.keys()],
      }),
    },
  ));
  const decryptedByEntity = new Map();
  for (const payload of response.payloads ?? []) {
    decryptedByEntity.set(payload.entityId, await decryptCompanyPayload({
      encryptedPayload: payload,
      scopePrivateKey: companyEncryption.scopePrivateEncryptionKey.privateKey,
      scopePrivateJwk: companyEncryption.scopePrivateEncryptionKey.privateJwk,
    }));
  }
  const resolveReference = (reference) => {
    const decrypted = decryptedByEntity.get(reference.entityId);
    const values = decrypted?.values && typeof decrypted.values === "object"
      ? decrypted.values
      : decrypted;
    if (!values || typeof values !== "object" || !(reference.field in values)) {
      throw new Error(`Зашифрованное поле ${reference.field} недоступно Agent Workspaces.`);
    }
    return structuredClone(values[reference.field]);
  };
  const hydrate = async (current) => {
    const direct = parseAgentEncryptedContentReference(current);
    if (direct) return resolveReference(direct);
    if (typeof current === "string") {
      let hydrated = current;
      for (const match of current.matchAll(EMBEDDED_ENCRYPTED_TEXT_MARKER_PATTERN)) {
        const marker = match[0];
        const resolved = resolveReference({ entityId: match[1], field: match[2] });
        hydrated = hydrated.replaceAll(marker, String(resolved ?? ""));
      }
      return hydrated;
    }
    if (Array.isArray(current)) return Promise.all(current.map(hydrate));
    if (current && typeof current === "object") {
      return Object.fromEntries(await Promise.all(Object.entries(current).map(async ([key, child]) => [
        key,
        await hydrate(child),
      ])));
    }
    return current;
  };
  return hydrate(value);
};

const createPkce = () => {
  const verifier = crypto.randomBytes(48).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
};

const legacyOAuthLogin = async (origin) => {
  const state = crypto.randomBytes(24).toString("base64url");
  const { verifier, challenge } = createPkce();
  let resolveCallback;
  let rejectCallback;
  const callbackPromise = new Promise((resolve, reject) => {
    resolveCallback = resolve;
    rejectCallback = reject;
  });
  const server = http.createServer((incoming, outgoing) => {
    const callbackUrl = new URL(incoming.url || "/", "http://127.0.0.1");

    if (callbackUrl.pathname !== "/oauth/callback") {
      outgoing.writeHead(404).end("Not found");
      return;
    }

    const code = callbackUrl.searchParams.get("code");
    const returnedState = callbackUrl.searchParams.get("state");
    const oauthError = callbackUrl.searchParams.get("error");

    if (oauthError || !code || returnedState !== state) {
      outgoing.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
      outgoing.end("Trelio не удалось подключить. Можно закрыть эту вкладку.");
      rejectCallback(new Error(oauthError || "OAuth callback не прошёл проверку state."));
      return;
    }

    outgoing.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    outgoing.end("<!doctype html><meta charset=utf-8><title>Trelio подключён</title><p>Trelio Agent Workspaces подключён. Эту вкладку можно закрыть.</p>");
    resolveCallback(code);
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  try {
    const address = server.address();
    const redirectUri = `http://127.0.0.1:${address.port}/oauth/callback`;
    const registrationResponse = await request(origin, null, "/oauth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "Trelio Workspace Bridge",
        redirect_uris: [redirectUri],
        scope: LEGACY_OAUTH_SCOPES,
        grant_types: ["authorization_code"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      }),
    });
    const registration = await registrationResponse.json();
    const resource = `${origin}/mcp`;
    const authorizationUrl = new URL("/oauth/authorize", origin);
    authorizationUrl.search = new URLSearchParams({
      response_type: "code",
      client_id: registration.client_id,
      redirect_uri: redirectUri,
      scope: LEGACY_OAUTH_SCOPES,
      state,
      code_challenge: challenge,
      code_challenge_method: "S256",
      resource,
    }).toString();

    process.stdout.write("Открываю Trelio для подтверждения доступа…\n");
    await openBrowser(authorizationUrl.toString());
    let timeoutId;
    const timeout = new Promise((_, reject) => {
      timeoutId = setTimeout(
        () => reject(new Error("Время ожидания OAuth подтверждения истекло.")),
        5 * 60 * 1000,
      );
    });
    const code = await Promise.race([callbackPromise, timeout])
      .finally(() => clearTimeout(timeoutId));
    const tokenResponse = await request(origin, null, "/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
        client_id: registration.client_id,
        code_verifier: verifier,
        resource,
      }),
    });
    const tokenPayload = await tokenResponse.json();
    const storage = await saveLegacyOAuthToken(origin, tokenPayload.access_token);
    process.stdout.write(`Legacy OAuth credential сохранён в ${storage}.\n`);
  } finally {
    server.close();
  }
};

export const requireToken = async (origin, options = {}) => {
  const token = await loadToken(origin);

  if (token) {
    return token;
  }

  const pairedToken = await exchangePendingBridgePairing(origin, options);

  if (pairedToken) {
    return pairedToken;
  }

  return beginBridgePairing(origin, options);
};

const pairBridge = async (origin) => {
  const existingSession = await loadBridgeSessionToken(origin);

  if (existingSession) {
    process.stdout.write("Trelio bridge уже подключён через device-session.\n");
    return;
  }

  const pairedToken = await exchangePendingBridgePairing(origin);

  if (pairedToken) {
    return;
  }

  const legacyToken = await loadLegacyOAuthToken(origin);

  if (legacyToken) {
    process.stdout.write(
      "Найден действующий legacy OAuth credential. Он продолжит работать; для новых устройств используется одноразовый pairing через уже авторизованный MCP.\n",
    );
    return;
  }

  await beginBridgePairing(origin);
};

const writeResponseToFile = async (response, destination) => {
  if (!response.body) {
    throw new Error("Trelio вернул пустой поток файла.");
  }

  // Bundle и workspace object могут быть значительно больше памяти процесса.
  // Web Stream переводим в Node Stream и пишем с backpressure.
  await pipeline(
    Readable.fromWeb(response.body),
    createWriteStream(destination, { flags: "wx", mode: 0o600 }),
  );
};

const writeAndDecryptCompanyWorkspaceBundle = async ({
  response,
  destination,
  companyEncryption,
}) => {
  if (!companyEncryption) {
    throw new Error("Encrypted Agent Workspace response requires an unlocked local company key.");
  }
  const encryptedPath = `${destination}.trelioe1`;
  const expectedDigest = response.headers.get("x-trelio-ciphertext-sha256");
  const responseScopeId = response.headers.get("x-trelio-scope-id");
  const responseScopeEpoch = Number(response.headers.get("x-trelio-scope-epoch"));

  if (
    response.headers.get("x-trelio-e2ee") !== "v1"
    || !/^[0-9a-f]{64}$/u.test(expectedDigest || "")
    || responseScopeId !== companyEncryption.runtime.scope.id
    || responseScopeEpoch !== companyEncryption.runtime.scope.epoch
  ) {
    throw new Error("Trelio вернул encrypted Workspace bundle другого scope или формата.");
  }

  try {
    await writeResponseToFile(response, encryptedPath);
    const decrypted = await decryptFileFromCompanyContainer({
      sourcePath: encryptedPath,
      destinationPath: destination,
      scopePrivateKey: companyEncryption.scopePrivateEncryptionKey.privateKey,
      scopePrivateJwk: companyEncryption.scopePrivateEncryptionKey.privateJwk,
      expectedCiphertextSha256: expectedDigest,
    });
    if (
      decrypted.header.aad.companyId !== companyEncryption.runtime.company.id
      || decrypted.header.aad.scopeId !== companyEncryption.runtime.scope.id
      || decrypted.header.aad.scopeEpoch !== companyEncryption.runtime.scope.epoch
      || decrypted.header.aad.entityType !== "agent_workspace_revision"
    ) {
      throw new Error("Расшифрованный Workspace bundle привязан к другой компании или сущности.");
    }
    return decrypted;
  } finally {
    await fs.rm(encryptedPath, { force: true }).catch(() => undefined);
  }
};

export const parseWorkspaceObjectPointer = (value) => {
  const rawText = Buffer.isBuffer(value) ? value.toString("utf8") : String(value);
  let text = rawText;

  if (rawText.includes("\r")) {
    // Git can check out this small text pointer with CRLF on Windows even
    // though the canonical bridge serializer writes LF. Accept one uniform
    // line-ending convention only: mixed endings and lone carriage returns
    // remain invalid so normalization cannot hide malformed pointer content.
    const contentWithoutCrLf = rawText.replaceAll("\r\n", "");

    if (contentWithoutCrLf.includes("\r") || contentWithoutCrLf.includes("\n")) {
      return null;
    }
    text = rawText.replaceAll("\r\n", "\n");
  }
  const lines = text.split("\n");

  if (
    lines.length !== 5
    || lines[0] !== `version ${WORKSPACE_OBJECT_POINTER_VERSION}`
    || lines[4] !== ""
  ) {
    return null;
  }

  const sha256 = lines[1]?.match(/^oid sha256:([0-9a-f]{64})$/)?.[1];
  const rawSize = lines[2]?.match(/^size ([1-9][0-9]*)$/)?.[1];
  const contentType = lines[3]?.match(/^content-type ([A-Za-z0-9!#$&^_.+\-/]{1,255})$/)?.[1];
  const sizeBytes = Number(rawSize);

  if (!sha256 || !contentType || !Number.isSafeInteger(sizeBytes) || sizeBytes <= 0) {
    return null;
  }

  return { sha256, sizeBytes, contentType };
};

const serializeWorkspaceObjectPointer = ({ sha256, sizeBytes, contentType }) => {
  if (
    !SHA256_PATTERN.test(sha256)
    || !Number.isSafeInteger(sizeBytes)
    || sizeBytes <= 0
    || !/^[A-Za-z0-9!#$&^_.+\-/]{1,255}$/.test(contentType)
  ) {
    throw new Error("Не удалось сформировать корректный указатель workspace object.");
  }

  return [
    `version ${WORKSPACE_OBJECT_POINTER_VERSION}`,
    `oid sha256:${sha256}`,
    `size ${sizeBytes}`,
    `content-type ${contentType}`,
    "",
  ].join("\n");
};

const inferWorkspaceObjectContentType = (filePath) => {
  return SAFE_CONTENT_TYPES_BY_EXTENSION.get(path.extname(filePath).toLowerCase())
    || "application/octet-stream";
};

const hashFile = async (filePath) => {
  const hash = crypto.createHash("sha256");
  let sizeBytes = 0;

  for await (const chunk of createReadStream(filePath)) {
    sizeBytes += chunk.byteLength;
    hash.update(chunk);
  }

  return { sha256: hash.digest("hex"), sizeBytes };
};

const normalizeBase64 = (value) => String(value || "").replace(/=+$/u, "");
const WINDOWS_RESERVED_SKILL_PATH_PATTERN =
  /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu;

const decodeCanonicalBase64 = (value, label) => {
  const normalizedValue = String(value || "");

  if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(normalizedValue)) {
    throw new Error(`${label} содержит некорректный base64.`);
  }

  const bytes = Buffer.from(normalizedValue, "base64");

  if (
    normalizeBase64(bytes.toString("base64"))
    !== normalizeBase64(normalizedValue)
  ) {
    throw new Error(`${label} содержит неканонический base64.`);
  }

  return bytes;
};

export const normalizeAgentSkillPackagePath = (rawValue) => {
  const rawPath = String(rawValue || "");

  if (
    !rawPath
    || rawPath.length > 512
    || rawPath.includes("\\")
    || rawPath.includes("\0")
    || path.posix.isAbsolute(rawPath)
    || rawPath.endsWith("/")
  ) {
    throw new Error(`Путь runtime package "${rawPath}" небезопасен.`);
  }

  const normalizedPath = path.posix.normalize(rawPath);
  const segments = normalizedPath.split("/");

  if (
    normalizedPath !== rawPath
    || normalizedPath === "."
    || normalizedPath === ".."
    || segments.some((segment) => !segment || segment === "." || segment === "..")
    || segments.some((segment) => (
      /[\u0000-\u001f\u007f:*?"<>|]/u.test(segment)
      || /[. ]$/u.test(segment)
      || WINDOWS_RESERVED_SKILL_PATH_PATTERN.test(segment)
    ))
  ) {
    throw new Error(`Путь runtime package "${rawPath}" не нормализован.`);
  }

  return normalizedPath;
};

export const parseAndValidateAgentSkillPackage = (
  packageBytes,
  expectedSkillId = null,
) => {
  if (
    !Buffer.isBuffer(packageBytes)
    || packageBytes.byteLength <= 0
    || packageBytes.byteLength > AGENT_SKILL_MAX_PACKAGE_BYTES
  ) {
    throw new Error(
      `Runtime package должен занимать от 1 до ${AGENT_SKILL_MAX_PACKAGE_BYTES} байт.`,
    );
  }
  if (!isUtf8(packageBytes)) {
    throw new Error("Runtime package должен содержать корректный UTF-8 JSON.");
  }

  let runtimePackage;
  try {
    runtimePackage = JSON.parse(packageBytes.toString("utf8"));
  } catch {
    throw new Error("Runtime package должен содержать корректный UTF-8 JSON.");
  }

  const skillId = String(runtimePackage?.skill?.id || "");
  const runtimeVersion = String(runtimePackage?.skill?.runtimeVersion || "");
  const entrypointPath = normalizeAgentSkillPackagePath(
    runtimePackage?.entrypoint?.path,
  );
  const interpreter = String(runtimePackage?.entrypoint?.interpreter || "");
  const capabilities = Array.isArray(runtimePackage?.capabilities)
    ? runtimePackage.capabilities.map(String)
    : [];
  const files = runtimePackage?.files;

  if (runtimePackage?.format !== AGENT_SKILL_PACKAGE_FORMAT) {
    throw new Error("Runtime package использует неподдерживаемый format.");
  }
  if (!SKILL_ID_PATTERN.test(skillId)) {
    throw new Error("Runtime package содержит некорректный skill id.");
  }
  if (expectedSkillId && skillId !== expectedSkillId) {
    throw new Error(
      `Runtime package принадлежит навыку ${skillId}, а ожидался ${expectedSkillId}.`,
    );
  }
  if (!STABLE_VERSION_PATTERN.test(runtimeVersion)) {
    throw new Error("Runtime package version должна использовать формат X.Y.Z.");
  }
  if (!["node", "python", "executable"].includes(interpreter)) {
    throw new Error("Runtime package содержит неподдерживаемый interpreter.");
  }
  if (
    capabilities.length !== new Set(capabilities).size
    || capabilities.some(
      (capability) => !AGENT_SKILL_ALLOWED_CAPABILITIES.has(capability),
    )
  ) {
    throw new Error("Runtime package содержит неизвестные или повторяющиеся capabilities.");
  }
  if (
    !Array.isArray(files)
    || files.length === 0
    || files.length > AGENT_SKILL_MAX_FILE_COUNT
  ) {
    throw new Error(
      `Runtime package должен содержать от 1 до ${AGENT_SKILL_MAX_FILE_COUNT} файлов.`,
    );
  }

  const seenPaths = new Set();
  const portableSeenPaths = new Set();
  const parsedFiles = [];
  let decodedFileBytes = 0;

  for (const file of files) {
    const filePath = normalizeAgentSkillPackagePath(file?.path);
    const mode = Number(file?.mode);

    const portablePath = filePath.toLocaleLowerCase("en-US");

    if (seenPaths.has(filePath) || portableSeenPaths.has(portablePath)) {
      throw new Error(`Runtime package повторяет или регистронно конфликтует с путём ${filePath}.`);
    }
    if (mode !== 0o644 && mode !== 0o755) {
      throw new Error(`Runtime package использует небезопасный mode для ${filePath}.`);
    }
    if (!SHA256_PATTERN.test(String(file?.sha256 || ""))) {
      throw new Error(`Runtime package содержит некорректный SHA-256 для ${filePath}.`);
    }

    const bytes = decodeCanonicalBase64(
      file?.contentBase64,
      `Runtime package file ${filePath}`,
    );
    decodedFileBytes += bytes.byteLength;

    if (decodedFileBytes > AGENT_SKILL_MAX_DECODED_FILE_BYTES) {
      throw new Error(
        `Runtime package files превышают ${AGENT_SKILL_MAX_DECODED_FILE_BYTES} байт.`,
      );
    }

    const actualSha256 = crypto.createHash("sha256").update(bytes).digest("hex");

    if (actualSha256 !== file.sha256) {
      throw new Error(`Runtime package file ${filePath} не прошёл SHA-256 проверку.`);
    }

    seenPaths.add(filePath);
    portableSeenPaths.add(portablePath);
    parsedFiles.push({
      path: filePath,
      mode,
      sha256: file.sha256,
      bytes,
    });
  }

  if (!seenPaths.has(entrypointPath)) {
    throw new Error(`Entrypoint ${entrypointPath} отсутствует в runtime package.`);
  }
  const entrypointFile = parsedFiles.find((file) => file.path === entrypointPath);
  if (interpreter === "executable" && entrypointFile?.mode !== 0o755) {
    throw new Error(`Executable entrypoint ${entrypointPath} должен иметь mode 0755.`);
  }

  return {
    format: AGENT_SKILL_PACKAGE_FORMAT,
    skillId,
    runtimeVersion,
    entrypoint: {
      path: entrypointPath,
      interpreter,
    },
    capabilities,
    files: parsedFiles,
    packageSha256: crypto.createHash("sha256").update(packageBytes).digest("hex"),
    packageSizeBytes: packageBytes.byteLength,
  };
};

const collectAgentSkillPackageSourceFiles = async (sourceDirectory) => {
  const collectedFiles = [];

  const visit = async (relativeDirectory = "") => {
    const absoluteDirectory = path.join(sourceDirectory, relativeDirectory);
    const entries = await fs.readdir(absoluteDirectory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, "en"));

    for (const entry of entries) {
      // Bytecode/cache files are machine-specific build residue, not runtime
      // source. Reject instead of silently skipping them: an operator sees the
      // dirty source tree and cannot accidentally sign a package that differs
      // by the workstation/Python version used for validation.
      if (
        entry.name === "__pycache__"
        || entry.name === ".DS_Store"
        || /\.(?:pyc|pyo)$/iu.test(entry.name)
      ) {
        throw new Error(
          `Runtime package source содержит generated cache ${entry.name}; очистите --source перед pack.`,
        );
      }
      const relativePath = relativeDirectory
        ? `${relativeDirectory}/${entry.name}`
        : entry.name;
      const normalizedPath = normalizeAgentSkillPackagePath(relativePath);
      const absolutePath = path.join(sourceDirectory, ...normalizedPath.split("/"));
      const fileStat = await fs.lstat(absolutePath);

      if (fileStat.isSymbolicLink()) {
        throw new Error(`Symlink ${normalizedPath} нельзя включать в runtime package.`);
      }
      if (fileStat.isDirectory()) {
        await visit(normalizedPath);
        continue;
      }
      if (!fileStat.isFile()) {
        throw new Error(`Runtime package source ${normalizedPath} не является обычным файлом.`);
      }

      collectedFiles.push({
        path: normalizedPath,
        absolutePath,
        mode: fileStat.mode & 0o111 ? 0o755 : 0o644,
      });

      if (collectedFiles.length > AGENT_SKILL_MAX_FILE_COUNT) {
        throw new Error(
          `Runtime package содержит больше ${AGENT_SKILL_MAX_FILE_COUNT} файлов.`,
        );
      }
    }
  };

  await visit();
  return collectedFiles;
};

export const buildAgentSkillPackage = async ({
  skillId,
  runtimeVersion,
  sourceDirectory,
  entrypointPath,
  interpreter,
  capabilities = [],
}) => {
  if (!SKILL_ID_PATTERN.test(String(skillId || ""))) {
    throw new Error("Параметр --skill должен содержать lowercase kebab-case id.");
  }
  if (!STABLE_VERSION_PATTERN.test(String(runtimeVersion || ""))) {
    throw new Error("Параметр --runtime-version должен использовать формат X.Y.Z.");
  }
  if (!["node", "python", "executable"].includes(interpreter)) {
    throw new Error("Параметр --interpreter должен быть node, python или executable.");
  }

  const normalizedEntrypoint = normalizeAgentSkillPackagePath(entrypointPath);
  const uniqueCapabilities = [...new Set(capabilities.map(String))].sort();

  if (
    uniqueCapabilities.some(
      (capability) => !AGENT_SKILL_ALLOWED_CAPABILITIES.has(capability),
    )
  ) {
    throw new Error("Параметр --capability содержит неподдерживаемое значение.");
  }

  const sourceStat = await fs.lstat(sourceDirectory);

  if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink()) {
    throw new Error("Параметр --source должен указывать на обычный каталог.");
  }

  const sourceFiles = await collectAgentSkillPackageSourceFiles(sourceDirectory);

  if (!sourceFiles.some((file) => file.path === normalizedEntrypoint)) {
    throw new Error(`Entrypoint ${normalizedEntrypoint} не найден внутри --source.`);
  }

  const packageFiles = [];
  let decodedFileBytes = 0;

  for (const file of sourceFiles) {
    const bytes = await fs.readFile(file.absolutePath);
    decodedFileBytes += bytes.byteLength;

    if (decodedFileBytes > AGENT_SKILL_MAX_DECODED_FILE_BYTES) {
      throw new Error(
        `Runtime package files превышают ${AGENT_SKILL_MAX_DECODED_FILE_BYTES} байт.`,
      );
    }

    packageFiles.push({
      path: file.path,
      mode: file.mode,
      sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
      contentBase64: bytes.toString("base64"),
    });
  }

  const packageBytes = Buffer.from(`${JSON.stringify({
    format: AGENT_SKILL_PACKAGE_FORMAT,
    skill: {
      id: skillId,
      runtimeVersion,
    },
    entrypoint: {
      path: normalizedEntrypoint,
      interpreter,
    },
    capabilities: uniqueCapabilities,
    files: packageFiles,
  })}\n`, "utf8");

  // Один и тот же validator используется для pack и run. Поэтому builder не
  // сможет выпустить пакет, который новый host потом сам отвергнет.
  parseAndValidateAgentSkillPackage(packageBytes, skillId);
  return packageBytes;
};

const readVerifiedSkillRuntimeCache = async (artifact) => {
  const artifactDirectory = path.join(
    SKILL_RUNTIME_CACHE_DIRECTORY,
    artifact.skillId,
    artifact.runtimeVersion,
    artifact.packageSha256,
  );
  const markerPath = path.join(artifactDirectory, ".trelio-verified.json");

  try {
    const markerStat = await fs.lstat(markerPath);

    if (!markerStat.isFile() || markerStat.isSymbolicLink()) {
      return null;
    }

    const marker = JSON.parse(await fs.readFile(markerPath, "utf8"));

    if (
      marker.packageSha256 !== artifact.packageSha256
      || marker.artifactId !== artifact.id
      || marker.runtimeVersion !== artifact.runtimeVersion
    ) {
      return null;
    }

    for (const file of artifact.parsedPackage.files) {
      const absolutePath = path.join(
        artifactDirectory,
        ...file.path.split("/"),
      );
      const fileStat = await fs.lstat(absolutePath);

      if (
        !fileStat.isFile()
        || fileStat.isSymbolicLink()
        || fileStat.size !== file.bytes.byteLength
      ) {
        return null;
      }

      const digest = await hashFile(absolutePath);

      if (digest.sha256 !== file.sha256) {
        return null;
      }
    }

    // Marker mtime является LRU-сигналом для безопасной cache cleanup. Само
    // содержимое marker не меняется, поэтому параллельные запуски одного
    // immutable package не могут повредить metadata.
    const now = new Date();
    await fs.utimes(markerPath, now, now).catch(() => undefined);
    return artifactDirectory;
  } catch (error) {
    if (error.code === "ENOENT" || error instanceof SyntaxError) {
      return null;
    }
    throw error;
  }
};

const verifyAgentSkillPackageSignature = (packageBytes, artifact) => {
  const publicKeyBytes = decodeCanonicalBase64(
    artifact.signingPublicKeySpki,
    "Signing public key",
  );
  const signatureBytes = decodeCanonicalBase64(
    artifact.packageSignature,
    "Runtime package signature",
  );

  const verified = crypto.verify(
    null,
    packageBytes,
    {
      key: publicKeyBytes,
      format: "der",
      type: "spki",
    },
    signatureBytes,
  );

  if (!verified) {
    throw new Error("Runtime package не прошёл Ed25519 signature verification.");
  }
};

const assertEncryptedAgentSkillRuntimeBinding = ({ opened, artifact, companyEncryption }) => {
  const writerId = opened.header?.writerIdentityId;

  if (
    opened.header?.aad?.companyId !== companyEncryption.runtime.company.id
    || opened.header?.aad?.scopeId !== companyEncryption.runtime.scope.id
    || opened.header?.aad?.scopeEpoch !== companyEncryption.runtime.scope.epoch
    || opened.header?.aad?.entityType !== "file.agent_skill_runtime_artifacts"
    || opened.header?.aad?.entityId !== artifact.encryptedManifestEntityId
    || opened.header?.aad?.purpose !== "file"
    // Fresh agent publications carry the authorized bridge-device UUID. A
    // legacy package encrypted by the migration worker has an explicit null
    // writer and remains company-unverified behind the same local consent.
    || (writerId !== null && !UUID_PATTERN.test(String(writerId || "")))
    || opened.mimeType !== "application/vnd.trelio.agent-skill-package+json"
  ) {
    throw new Error("Encrypted runtime package не совпадает с company/scope/manifest binding.");
  }
};

const decryptEncryptedAgentSkillRuntimePackage = async ({
  packageBytes,
  artifact,
  companyEncryption,
}) => {
  if (!companyEncryption) {
    throw new Error("Для зашифрованного runtime package отсутствует локальный company key.");
  }
  const temporaryDirectory = await fs.mkdtemp(path.join(
    os.tmpdir(),
    "trelio-runtime-decrypt-",
  ));
  const encryptedPath = path.join(temporaryDirectory, "runtime.skillpkg.e2ee");
  const plaintextPath = path.join(temporaryDirectory, "runtime.skillpkg");

  try {
    await fs.writeFile(encryptedPath, packageBytes, { flag: "wx", mode: 0o600 });
    const opened = await decryptFileFromCompanyContainer({
      sourcePath: encryptedPath,
      destinationPath: plaintextPath,
      scopePrivateKey: companyEncryption.scopePrivateEncryptionKey.privateKey,
      scopePrivateJwk: companyEncryption.scopePrivateEncryptionKey.privateJwk,
      expectedCiphertextSha256: artifact.packageSha256,
    });
    assertEncryptedAgentSkillRuntimeBinding({ opened, artifact, companyEncryption });
    return await fs.readFile(plaintextPath);
  } finally {
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
  }
};

const inspectEncryptedAgentSkillRuntimeForConsent = async ({
  origin,
  token,
  packageUrl,
  artifact,
  companyEncryption,
}) => {
  const response = await request(origin, token, packageUrl);
  const encryptedPackageBytes = await readBoundedResponseBuffer(
    response,
    AGENT_SKILL_MAX_ENCRYPTED_PACKAGE_BYTES,
    "Зашифрованный runtime package",
  );
  let plaintextPackageBytes = null;
  let parsedPackage = null;

  try {
    if (
      encryptedPackageBytes.byteLength !== artifact.packageSizeBytes
      || crypto.createHash("sha256").update(encryptedPackageBytes).digest("hex")
        !== artifact.packageSha256
    ) {
      throw new Error("Загруженный runtime package не совпадает с consent metadata.");
    }
    verifyAgentSkillPackageSignature(encryptedPackageBytes, artifact);
    plaintextPackageBytes = await decryptEncryptedAgentSkillRuntimePackage({
      packageBytes: encryptedPackageBytes,
      artifact,
      companyEncryption,
    });
    parsedPackage = parseAndValidateAgentSkillPackage(
      plaintextPackageBytes,
      artifact.skillId,
    );
    const parsedManifest = {
      format: AGENT_SKILL_PACKAGE_FORMAT,
      skill: {
        id: parsedPackage.skillId,
        runtimeVersion: parsedPackage.runtimeVersion,
      },
      entrypoint: parsedPackage.entrypoint,
      capabilities: [...parsedPackage.capabilities].sort(),
      files: parsedPackage.files.map((file) => ({
        path: file.path,
        mode: file.mode,
        sha256: file.sha256,
        sizeBytes: file.bytes.byteLength,
      })),
    };

    if (
      parsedPackage.runtimeVersion !== artifact.runtimeVersion
      || canonicalJson(parsedManifest) !== canonicalJson(artifact.manifest)
    ) {
      throw new Error(
        "Расшифрованный runtime package не совпадает с локально расшифрованным manifest.",
      );
    }

    return {
      capabilities: [...parsedPackage.capabilities].sort(),
      packageSizeBytes: parsedPackage.packageSizeBytes,
    };
  } finally {
    encryptedPackageBytes.fill(0);
    plaintextPackageBytes?.fill(0);
    for (const file of parsedPackage?.files ?? []) {
      file.bytes.fill(0);
    }
  }
};

const downloadAndMaterializeAgentSkillRuntime = async ({
  origin,
  token,
  packageUrl,
  artifact,
  companyEncryption = null,
}) => {
  const response = await request(origin, token, packageUrl);
  let packageBytes = await readBoundedResponseBuffer(
    response,
    artifact.contentProtection === "company_e2ee_v1"
      ? AGENT_SKILL_MAX_ENCRYPTED_PACKAGE_BYTES
      : AGENT_SKILL_MAX_PACKAGE_BYTES,
    "Runtime package",
  );

  if (
    packageBytes.byteLength !== artifact.packageSizeBytes
    || crypto.createHash("sha256").update(packageBytes).digest("hex")
      !== artifact.packageSha256
  ) {
    throw new Error("Загруженный runtime package не совпадает с resolve metadata.");
  }

  verifyAgentSkillPackageSignature(packageBytes, artifact);
  if (artifact.contentProtection === "company_e2ee_v1") {
    const encryptedPackageBytes = packageBytes;
    try {
      packageBytes = await decryptEncryptedAgentSkillRuntimePackage({
        packageBytes: encryptedPackageBytes,
        artifact,
        companyEncryption,
      });
    } finally {
      encryptedPackageBytes.fill(0);
    }
  }

  artifact.parsedPackage = parseAndValidateAgentSkillPackage(packageBytes, artifact.skillId);

  if (artifact.contentProtection === "company_e2ee_v1") {
    const parsedManifest = {
      format: AGENT_SKILL_PACKAGE_FORMAT,
      skill: {
        id: artifact.parsedPackage.skillId,
        runtimeVersion: artifact.parsedPackage.runtimeVersion,
      },
      entrypoint: artifact.parsedPackage.entrypoint,
      capabilities: [...artifact.parsedPackage.capabilities].sort(),
      files: artifact.parsedPackage.files.map((file) => ({
        path: file.path,
        mode: file.mode,
        sha256: file.sha256,
        sizeBytes: file.bytes.byteLength,
      })),
    };
    if (canonicalJson(parsedManifest) !== canonicalJson(artifact.manifest)) {
      throw new Error(
        "Расшифрованный runtime package не совпадает с локально расшифрованным manifest.",
      );
    }
    // Cache identity is content-addressed by locally verified plaintext. The
    // transport digest and signature were checked immediately above and every
    // encrypted run repeats that live ciphertext check before reusing cache.
    artifact.packageSha256 = artifact.parsedPackage.packageSha256;
    artifact.packageSizeBytes = artifact.parsedPackage.packageSizeBytes;
  }

  if (
    artifact.parsedPackage.runtimeVersion !== artifact.runtimeVersion
    || artifact.parsedPackage.packageSha256 !== artifact.packageSha256
  ) {
    throw new Error("Runtime package metadata не совпадает с подписанным содержимым.");
  }

  const existingDirectory = await readVerifiedSkillRuntimeCache(artifact);

  if (existingDirectory) {
    return { runtimeDirectory: existingDirectory, cacheHit: true };
  }

  const artifactParent = path.join(
    SKILL_RUNTIME_CACHE_DIRECTORY,
    artifact.skillId,
    artifact.runtimeVersion,
  );
  const targetDirectory = path.join(artifactParent, artifact.packageSha256);
  const temporaryDirectory = path.join(
    artifactParent,
    `.${artifact.packageSha256}.materialize-${crypto.randomUUID()}`,
  );
  await fs.mkdir(artifactParent, { recursive: true, mode: 0o700 });

  try {
    await fs.mkdir(temporaryDirectory, { mode: 0o700 });

    for (const file of artifact.parsedPackage.files) {
      const destination = path.join(
        temporaryDirectory,
        ...file.path.split("/"),
      );
      await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
      await fs.writeFile(destination, file.bytes, {
        flag: "wx",
        mode: file.mode,
      });
      await fs.chmod(destination, file.mode);
    }

    // Сохраняем exact подписанный envelope для проверки каждого будущего
    // cache hit. Это не исполняемый дополнительный файл и он никогда не
    // материализуется в workspace.
    await fs.writeFile(
      path.join(temporaryDirectory, ".trelio-package.json"),
      packageBytes,
      { flag: "wx", mode: 0o600 },
    );

    await fs.writeFile(
      path.join(temporaryDirectory, ".trelio-verified.json"),
      `${JSON.stringify({
        artifactId: artifact.id,
        skillId: artifact.skillId,
        runtimeVersion: artifact.runtimeVersion,
        packageSha256: artifact.packageSha256,
        verifiedAt: new Date().toISOString(),
      }, null, 2)}\n`,
      { flag: "wx", mode: 0o600 },
    );

    // Повреждённый cache никогда не чинится поверх существующих файлов:
    // удаляем exact digest-directory и публикуем полностью проверенный snapshot
    // одним rename.
    await fs.rm(targetDirectory, { recursive: true, force: true });
    await fs.rename(temporaryDirectory, targetDirectory);
  } finally {
    await fs.rm(temporaryDirectory, { recursive: true, force: true })
      .catch(() => undefined);
  }

  const verifiedDirectory = await readVerifiedSkillRuntimeCache(artifact);

  if (!verifiedDirectory) {
    throw new Error("Runtime package не прошёл проверку после materialization.");
  }

  return { runtimeDirectory: verifiedDirectory, cacheHit: false };
};

export const normalizeResolvedSkillRuntimeArtifact = (
  payload,
  { allowPendingEncryptedConsent = false } = {},
) => {
  const artifact = payload?.artifact;
  const contentProtection = artifact?.contentProtection ?? "plain";
  const encryptedRuntime = contentProtection === "company_e2ee_v1";
  // Trust is an admission decision, not optional compatibility metadata. A
  // missing object must fail closed: otherwise a response produced by an old
  // or incomplete backend would silently promote arbitrary code to
  // `platform_verified` on the local device.
  const trust = payload?.trust;
  // `localIdentity` is independent from a company connection starting with
  // host v1.6.17. A browser-only runtime still needs the stable member scope
  // for private local preferences even though it receives no connection ID or
  // company config. The nullish fallback keeps compatibility with older
  // connection-free runtime responses that omitted identity altogether.
  const localIdentity = payload?.localIdentity ?? null;
  const companyConnection = payload?.companyConnection ?? null;
  const connectionConfigJson = companyConnection === null
    ? null
    : JSON.stringify(companyConnection?.config);

  if (
    !UUID_PATTERN.test(String(payload?.releaseId || ""))
    || !["plain", "company_e2ee_v1"].includes(contentProtection)
    || !UUID_PATTERN.test(String(artifact?.id || ""))
    || !SKILL_ID_PATTERN.test(String(artifact?.skillId || ""))
    || !STABLE_VERSION_PATTERN.test(String(artifact?.runtimeVersion || ""))
    || artifact?.packageFormat !== (
      encryptedRuntime
        ? AGENT_SKILL_ENCRYPTED_PACKAGE_FORMAT
        : AGENT_SKILL_PACKAGE_FORMAT
    )
    || !SHA256_PATTERN.test(String(artifact?.packageSha256 || ""))
    || !Number.isSafeInteger(artifact?.packageSizeBytes)
    || artifact.packageSizeBytes <= 0
    || artifact.packageSizeBytes > (
      encryptedRuntime
        ? AGENT_SKILL_MAX_ENCRYPTED_PACKAGE_BYTES
        : AGENT_SKILL_MAX_PACKAGE_BYTES
    )
    || typeof artifact?.packageSignature !== "string"
    || !AGENT_SKILL_SIGNING_KEY_ID_PATTERN.test(String(artifact?.signingKeyId || ""))
    || typeof artifact?.signingPublicKeySpki !== "string"
    || !STABLE_VERSION_PATTERN.test(String(artifact?.minimumHostVersion || ""))
    || typeof payload?.packageUrl !== "string"
    || !payload.packageUrl.startsWith("/api/agent-skills/runtime/package?")
    || !["platform_verified", "company_unverified"].includes(trust?.level)
    || !["platform_verified", "company_unverified"].includes(trust?.artifactLevel)
    || (
      encryptedRuntime
      && (
        payload.company?.id !== localIdentity?.companyId
        || typeof payload.company?.slug !== "string"
        || !payload.company.slug
        || typeof payload.company?.name !== "string"
        || !UUID_PATTERN.test(String(payload.encryptedManifestEntityId || ""))
      )
    )
    || typeof trust?.requiresDeviceConsent !== "boolean"
    || (
      trust?.consentId !== null
      && !UUID_PATTERN.test(String(trust?.consentId || ""))
    )
    || (
      trust?.level === "company_unverified"
      && (
        !trust.requiresDeviceConsent
        || (
          !UUID_PATTERN.test(String(trust.consentId || ""))
          && !(
            encryptedRuntime
            && allowPendingEncryptedConsent
            && trust.consentId === null
            && payload?.consentChallenge
            && typeof payload.consentChallenge === "object"
          )
        )
      )
    )
    || (
      trust?.level === "platform_verified"
      && (
        // A platform-verified publication may never downgrade to bytes whose
        // artifact provenance is only company-unverified. The reverse pairing
        // is valid when a company republishes previously verified bytes: the
        // publication itself still requires a fresh exact device consent.
        trust.artifactLevel !== "platform_verified"
        || trust.requiresDeviceConsent
        || trust.consentId !== null
      )
    )
    || (
      localIdentity !== null
      && (
        !UUID_PATTERN.test(String(localIdentity?.companyId || ""))
        || !UUID_PATTERN.test(String(localIdentity?.memberId || ""))
        || !SKILL_ID_PATTERN.test(String(localIdentity?.skillId || ""))
        || (
          localIdentity?.connectionId !== null
          && !UUID_PATTERN.test(String(localIdentity?.connectionId || ""))
        )
        || (
          localIdentity?.projectId !== null
          && !UUID_PATTERN.test(String(localIdentity?.projectId || ""))
        )
      )
    )
    || (
      companyConnection !== null
      && (
        !UUID_PATTERN.test(String(companyConnection?.id || ""))
        || !["configured", "needs_secret", "disabled"].includes(companyConnection?.status)
        || typeof companyConnection?.configured !== "boolean"
        || !companyConnection?.config
        || typeof companyConnection.config !== "object"
        || Array.isArray(companyConnection.config)
        || typeof connectionConfigJson !== "string"
        || Buffer.byteLength(connectionConfigJson, "utf8") > 64 * 1024
        || !Array.isArray(companyConnection?.secretBindings)
        || companyConnection.secretBindings.length > 16
        || companyConnection.secretBindings.some((binding) => (
          typeof binding?.key !== "string"
          || !/^[a-z][a-z0-9_]{0,63}$/u.test(binding.key)
          || typeof binding?.status !== "string"
          || typeof binding?.hasValue !== "boolean"
        ))
      )
    )
    || (companyConnection !== null && localIdentity === null)
    || (
      companyConnection === null
      && localIdentity !== null
      && localIdentity.connectionId !== null
    )
    || (
      companyConnection !== null
      && (
        localIdentity.skillId !== artifact?.skillId
        || localIdentity.connectionId !== companyConnection?.id
      )
    )
    || (
      localIdentity !== null
      && localIdentity.skillId !== artifact?.skillId
    )
  ) {
    throw new Error("Trelio вернул некорректную runtime resolution.");
  }

  return {
    releaseId: payload.releaseId,
    company: payload.company ?? null,
    packageUrl: payload.packageUrl,
    localIdentity,
    companyConnection: companyConnection === null
      ? null
      : {
          id: companyConnection.id,
          status: companyConnection.status,
          configured: companyConnection.configured,
          config: companyConnection.config,
          secretBindings: companyConnection.secretBindings.map((binding) => ({
            key: binding.key,
            status: binding.status,
            hasValue: binding.hasValue,
          })),
        },
    trust: {
      level: trust.level,
      artifactLevel: trust.artifactLevel,
      requiresDeviceConsent: trust.requiresDeviceConsent,
      consentId: trust.consentId,
    },
    artifact: {
      id: artifact.id,
      skillId: artifact.skillId,
      runtimeVersion: artifact.runtimeVersion,
      packageFormat: artifact.packageFormat,
      packageSha256: artifact.packageSha256,
      packageSizeBytes: artifact.packageSizeBytes,
      packageSignature: artifact.packageSignature,
      signingKeyId: String(artifact.signingKeyId || ""),
      signingPublicKeySpki: artifact.signingPublicKeySpki,
      manifest: artifact.manifest,
      minimumHostVersion: String(artifact.minimumHostVersion || ""),
      contentProtection,
      encryptedManifestEntityId: encryptedRuntime
        ? payload.encryptedManifestEntityId
        : null,
      parsedPackage: null,
    },
  };
};

// A runtime that passed signature, digest and (when required) device-consent
// gates may execute, but the shell/workspace that launches the plugin is not a
// trusted source of process configuration. In particular,
// dynamic-loader hooks (LD_PRELOAD/DYLD_*), NODE_OPTIONS/PYTHONPATH and ambient
// credentials can act before the materialized runtime has a chance to sanitize
// itself. Pass only the small set of OS/runtime-location values that an Agent
// Skill may legitimately need. Connection identity is added separately below
// from the fresh server resolution and therefore is intentionally absent here.
const AGENT_SKILL_INHERITED_ENVIRONMENT_KEYS = new Set([
  "ALL_PROXY",
  "APPDATA",
  "COLORTERM",
  "COMSPEC",
  // Linux headed login needs the existing desktop-session endpoints. They do
  // not alter the Node/Python loader before runtime start, unlike the omitted
  // LD_*/DYLD_*/interpreter-hook variables.
  "DBUS_SESSION_BUS_ADDRESS",
  "DISPLAY",
  "FORCE_COLOR",
  "HOME",
  "HOMEDRIVE",
  "HOMEPATH",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "LANG",
  "LANGUAGE",
  "LOCALAPPDATA",
  "LOGNAME",
  "NO_COLOR",
  "NO_PROXY",
  "PATH",
  "PATHEXT",
  "PROGRAMDATA",
  "PROGRAMFILES",
  "PROGRAMFILES(X86)",
  "PROGRAMW6432",
  "SYSTEMROOT",
  "TEMP",
  "TERM",
  "TMP",
  "TMPDIR",
  "TRELIO_CACHE_HOME",
  "TRELIO_CONFIG_HOME",
  "TRELIO_ORIGIN",
  "TZ",
  "USER",
  "USERNAME",
  "USERPROFILE",
  "WAYLAND_DISPLAY",
  "WINDIR",
  "XAUTHORITY",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_RUNTIME_DIR",
  "XDG_STATE_HOME",
]);

const normalizedWindowsInstallationRoot = (value, expectedBasename) => {
  const candidate = path.normalize(String(value || ""));
  if (
    !path.win32.isAbsolute(candidate)
    || !/^[A-Za-z]:[\\/]/u.test(candidate)
    || candidate.startsWith("\\\\")
    || path.win32.basename(candidate).toLocaleLowerCase("en-US")
      !== expectedBasename.toLocaleLowerCase("en-US")
    || path.win32.dirname(candidate).toLocaleLowerCase("en-US")
      !== path.win32.parse(candidate).root.toLocaleLowerCase("en-US")
  ) {
    return null;
  }
  return candidate;
};

/**
 * Never let a workspace-prepended PATH choose an interpreter or shebang
 * helper. The host's own absolute Node directory remains available (important
 * for nvm/asdf installations), followed only by conventional OS-managed
 * executable roots. A runtime that needs another executable must carry
 * it in its package and declare the `executable` interpreter explicitly.
 */
export const buildAgentSkillRuntimePath = (environment = process.env) => {
  const directories = [path.dirname(process.execPath)];

  if (process.platform === "win32") {
    const systemRoot = normalizedWindowsInstallationRoot(
      environment.SYSTEMROOT || environment.SystemRoot || environment.WINDIR,
      "Windows",
    );
    if (systemRoot) {
      directories.push(
        path.win32.join(systemRoot, "System32"),
        systemRoot,
        path.win32.join(systemRoot, "System32", "Wbem"),
        path.win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0"),
      );
    }
  } else {
    directories.push(
      "/opt/homebrew/bin",
      "/usr/local/bin",
      "/usr/bin",
      "/bin",
      "/usr/sbin",
      "/sbin",
      "/run/current-system/sw/bin",
      "/nix/var/nix/profiles/default/bin",
    );
  }

  const seen = new Set();
  return directories
    .filter((directory) => {
      const normalized = process.platform === "win32"
        ? directory.toLocaleLowerCase("en-US")
        : directory;
      if (!path.isAbsolute(directory) || seen.has(normalized)) return false;
      seen.add(normalized);
      return true;
    })
    .join(path.delimiter);
};

export const sanitizeAgentSkillInheritedEnvironment = (inheritedEnvironment = process.env) => {
  const sanitized = {};

  for (const [key, value] of Object.entries(inheritedEnvironment || {})) {
    const normalizedKey = key.toUpperCase();
    const isLocale = normalizedKey.startsWith("LC_");
    const isExplicitlyAllowed = AGENT_SKILL_INHERITED_ENVIRONMENT_KEYS.has(normalizedKey);
    const isLowercaseProxy = [
      "all_proxy",
      "http_proxy",
      "https_proxy",
      "no_proxy",
    ].includes(key);

    // PATH/PATHEXT are reconstructed below. Do not leave a differently-cased
    // duplicate that Windows spawn could choose ahead of the safe value.
    if (
      ["PATH", "PATHEXT"].includes(normalizedKey)
      || (!isLocale && !isExplicitlyAllowed && !isLowercaseProxy)
      || value === undefined
    ) {
      continue;
    }

    // Keep the original spelling. Unix proxy consumers may distinguish lower
    // and upper case; Windows receives the same process.env spelling that the
    // trusted host already had. No unlisted variable survives this boundary.
    sanitized[key] = String(value);
  }

  // PATH and Python startup flags are host-authored values, never inherited
  // policy. `-I` is also used for declared Python runtimes below; these flags
  // protect executable/shebang packages that invoke Python themselves.
  sanitized.PATH = buildAgentSkillRuntimePath(inheritedEnvironment);
  sanitized.PYTHONNOUSERSITE = "1";
  sanitized.PYTHONSAFEPATH = "1";
  sanitized.PYTHONDONTWRITEBYTECODE = "1";
  if (process.platform === "win32") {
    sanitized.PATHEXT = ".COM;.EXE;.BAT;.CMD";
  }

  return sanitized;
};

const pythonInvocationCandidates = (environment = process.env) => {
  if (process.platform !== "win32") {
    return [
      "/opt/homebrew/bin/python3",
      "/usr/local/bin/python3",
      "/usr/bin/python3",
      "/bin/python3",
      "/run/current-system/sw/bin/python3",
      "/nix/var/nix/profiles/default/bin/python3",
    ].map((executable) => ({ executable, argsPrefix: [] }));
  }

  const candidates = [];
  for (const [value, basename] of [
    [environment.PROGRAMFILES, "Program Files"],
    [environment["PROGRAMFILES(X86)"], "Program Files (x86)"],
  ]) {
    const root = normalizedWindowsInstallationRoot(value, basename);
    if (!root) continue;
    for (const version of ["314", "313", "312", "311", "310"]) {
      candidates.push({
        executable: path.win32.join(root, `Python${version}`, "python.exe"),
        argsPrefix: [],
      });
    }
  }
  const systemRoot = normalizedWindowsInstallationRoot(
    environment.SYSTEMROOT || environment.SystemRoot || environment.WINDIR,
    "Windows",
  );
  if (systemRoot) {
    candidates.push({
      executable: path.win32.join(systemRoot, "py.exe"),
      argsPrefix: ["-3"],
    });
  }
  return candidates;
};

const pathOverlaps = (leftPath, rightPath) => {
  const left = path.resolve(leftPath);
  const right = path.resolve(rightPath);
  const leftToRight = path.relative(left, right);
  const rightToLeft = path.relative(right, left);
  return (!leftToRight.startsWith("..") && !path.isAbsolute(leftToRight))
    || (!rightToLeft.startsWith("..") && !path.isAbsolute(rightToLeft));
};

/**
 * Resolve Python without consulting ambient PATH, then execute a tiny isolated
 * version probe.  This is a fixed-path and startup-isolation boundary: it
 * excludes workspace/temp/plugin-cache interpreters, PATH first-hit attacks,
 * user-site imports and interpreter hooks.  The local OS account and its
 * installed Node/Python/browser stack remain machine trust roots; this check
 * deliberately does not claim protection from an active process running as
 * that same user.
 */
export const resolveTrustedPythonInvocation = async ({
  runtimeDirectory,
  environment = process.env,
}) => {
  const forbiddenRoots = [
    runtimeDirectory,
    process.cwd(),
    os.tmpdir(),
    LOADED_CODEX_PLUGIN_DIRECTORY,
  ].map((value) => path.resolve(value));
  const probeEnvironment = sanitizeAgentSkillInheritedEnvironment(environment);

  for (const candidate of pythonInvocationCandidates(environment)) {
    if (!path.isAbsolute(candidate.executable)) continue;
    const canonicalExecutable = await fs.realpath(candidate.executable).catch(() => null);
    if (!canonicalExecutable) continue;
    const metadata = await fs.lstat(canonicalExecutable).catch(() => null);
    if (
      !metadata
      || metadata.isSymbolicLink()
      || !metadata.isFile()
      || (process.platform !== "win32" && (metadata.mode & 0o111) === 0)
      || (process.platform !== "win32" && (metadata.mode & 0o022) !== 0)
      || forbiddenRoots.some((root) => pathOverlaps(root, canonicalExecutable))
    ) {
      continue;
    }

    if (process.platform !== "win32") {
      // Reject a path whose canonical ancestor is writable by every local
      // principal. Homebrew commonly keeps its user-owned Cellar group-
      // writable for the local admin group, so that whole installation is an
      // explicit machine trust root rather than a boundary this host can
      // strengthen selectively. The executable itself must still be neither
      // group- nor world-writable above. Walking the canonical path also keeps
      // a later refactor from accepting a symlinked directory after realpath().
      let current = path.dirname(canonicalExecutable);
      let safeAncestorChain = true;
      while (true) {
        const ancestor = await fs.lstat(current).catch(() => null);
        if (
          !ancestor
          || ancestor.isSymbolicLink()
          || !ancestor.isDirectory()
          || (ancestor.mode & 0o002) !== 0
        ) {
          safeAncestorChain = false;
          break;
        }
        const parent = path.dirname(current);
        if (parent === current) break;
        current = parent;
      }
      if (!safeAncestorChain) continue;
    }

    try {
      const { stdout } = await execFileAsync(
        canonicalExecutable,
        [
          ...candidate.argsPrefix,
          "-I",
          "-B",
          "-c",
          "import json,sys;print(json.dumps(list(sys.version_info[:2])))",
        ],
        {
          cwd: path.parse(canonicalExecutable).root,
          env: probeEnvironment,
          encoding: "utf8",
          timeout: 5_000,
          windowsHide: true,
        },
      );
      const version = JSON.parse(String(stdout || "").trim());
      if (
        !Array.isArray(version)
        || version.length !== 2
        || !version.every(Number.isInteger)
        || version[0] !== 3
        || version[1] < 10
      ) {
        continue;
      }
      return {
        executable: canonicalExecutable,
        argsPrefix: candidate.argsPrefix,
        version: `${version[0]}.${version[1]}`,
      };
    } catch {
      // Probe failures are intentionally indistinguishable. Continue only to
      // another fixed canonical candidate, never to ambient PATH discovery.
    }
  }

  throw new Error(
    "Не найден фиксированный canonical Python 3.10+ вне workspace/temp/plugin cache. Установите системный Python и повторите запуск навыка.",
  );
};

const PYTHON_ISOLATED_RUNTIME_BOOTSTRAP = [
  "import runpy,sys",
  "runtime_root,entrypoint,*arguments=sys.argv[1:]",
  "sys.path.insert(0,runtime_root)",
  "sys.argv=[entrypoint,*arguments]",
  "runpy.run_path(entrypoint,run_name='__main__')",
].join(";");

export const buildIsolatedPythonRuntimeArguments = ({
  argsPrefix = [],
  runtimeDirectory,
  entrypointPath,
  runtimeArguments = [],
}) => [
  ...argsPrefix,
  "-I",
  "-B",
  "-c",
  PYTHON_ISOLATED_RUNTIME_BOOTSTRAP,
  runtimeDirectory,
  entrypointPath,
  ...runtimeArguments,
];

export const buildAgentSkillRuntimeEnvironment = ({
  artifact,
  runtimeDirectory,
  executionContext,
  inheritedEnvironment = process.env,
  grantedEnvironment = {},
}) => {
  // Эти переменные являются доверенной границей package host. Удаляем
  // одноимённые значения из родительского окружения, чтобы старый shell или
  // вызывающая программа не могли подменить company identity/config. Затем
  // добавляем только данные свежего live resolve для exact release.
  const {
    TRELIO_SKILL_ID: _staleSkillId,
    TRELIO_SKILL_RUNTIME_VERSION: _staleRuntimeVersion,
    TRELIO_SKILL_RUNTIME_ROOT: _staleRuntimeRoot,
    TRELIO_SKILL_RELEASE_ID: _staleReleaseId,
    TRELIO_SKILL_COMPANY_ID: _staleCompanyId,
    TRELIO_SKILL_PROJECT_ID: _staleProjectId,
    TRELIO_SKILL_MEMBER_ID: _staleMemberId,
    TRELIO_SKILL_CONNECTION_ID: _staleConnectionId,
    TRELIO_SKILL_CONNECTION_CONFIG_JSON: _staleConnectionConfig,
    ...cleanEnvironment
  } = sanitizeAgentSkillInheritedEnvironment(inheritedEnvironment);
  const connectionConfigJson = executionContext.companyConnection
    ? JSON.stringify(executionContext.companyConnection.config)
    : null;

  const grantedEntries = Object.entries(grantedEnvironment || {});
  if (grantedEntries.length > 1) {
    throw new Error("Agent Secret checkout может передать runtime только одно exact значение.");
  }
  const normalizedGrantedEnvironment = {};
  for (const [key, value] of grantedEntries) {
    const forbiddenGrantedName = (
      AGENT_SKILL_INHERITED_ENVIRONMENT_KEYS.has(key)
      || key.startsWith("LC_")
      || key.startsWith("TRELIO_SKILL_")
      || /^(?:LD_|DYLD_|_RLD_|LDR_|NODE_|NPM_|PYTHON|OPENSSL_|GIT_|SSH_)/u.test(key)
      || [
        "BASH_ENV",
        "ENV",
        "GCONV_PATH",
        "GLIBC_TUNABLES",
        "JAVA_TOOL_OPTIONS",
        "LIBPATH",
        "LOCPATH",
        "MALLOC_TRACE",
        "NLSPATH",
        "PATH",
        "PATHEXT",
        "PERL5LIB",
        "PERL5OPT",
        "RUBYLIB",
        "RUBYOPT",
        "SHLIB_PATH",
        "SSLKEYLOGFILE",
        "TRELIO_CACHE_HOME",
        "TRELIO_CONFIG_HOME",
        "TRELIO_ORIGIN",
      ].includes(key)
    );
    if (
      !/^[A-Z_][A-Z0-9_]{0,127}$/u.test(key)
      || forbiddenGrantedName
      || typeof value !== "string"
      || value.length < 1
      || Buffer.byteLength(value, "utf8") > 64 * 1024
      || value.includes("\0")
    ) {
      throw new Error("Agent Secret checkout вернул небезопасное runtime env binding.");
    }
    normalizedGrantedEnvironment[key] = value;
  }

  return {
    ...cleanEnvironment,
    TRELIO_SKILL_ID: artifact.skillId,
    TRELIO_SKILL_RUNTIME_VERSION: artifact.runtimeVersion,
    TRELIO_SKILL_RUNTIME_ROOT: runtimeDirectory,
    TRELIO_SKILL_RELEASE_ID: executionContext.releaseId,
    TRELIO_SKILL_COMPANY_ID: executionContext.companyId,
    ...(executionContext.projectId
      ? { TRELIO_SKILL_PROJECT_ID: executionContext.projectId }
      : {}),
    ...(executionContext.localIdentity
      ? { TRELIO_SKILL_MEMBER_ID: executionContext.localIdentity.memberId }
      : {}),
    // Connection-owned values stay all-or-nothing. A browser-only skill
    // receives member identity but must not see stringified `null` config or a
    // synthetic connection ID that could be mistaken for authority.
    ...(executionContext.companyConnection
      ? {
          TRELIO_SKILL_CONNECTION_ID: executionContext.localIdentity.connectionId,
          TRELIO_SKILL_CONNECTION_CONFIG_JSON: connectionConfigJson,
        }
      : {}),
    // A server-authorized checkout is not ambient parent environment. It is
    // supplied only by this process's secret-exec -> exact skill-run handoff
    // below, after live release resolution, and cannot override host identity.
    // Whether the opaque grant may authorize a later process is decided and
    // rechecked by backend; this host never caches or broadens that policy.
    ...normalizedGrantedEnvironment,
  };
};

const runMaterializedAgentSkill = async ({
  artifact,
  runtimeDirectory,
  runtimeArguments,
  executionContext,
  grantedEnvironment = {},
  grantedStdin = null,
}) => {
  const entrypointPath = path.join(
    runtimeDirectory,
    ...artifact.parsedPackage.entrypoint.path.split("/"),
  );
  const interpreter = artifact.parsedPackage.entrypoint.interpreter;
  let executable = entrypointPath;
  let args = runtimeArguments;

  if (interpreter === "node") {
    executable = process.execPath;
    args = [entrypointPath, ...runtimeArguments];
  } else if (interpreter === "python") {
    const python = await resolveTrustedPythonInvocation({ runtimeDirectory });
    executable = python.executable;
    args = buildIsolatedPythonRuntimeArguments({
      argsPrefix: python.argsPrefix,
      runtimeDirectory,
      entrypointPath,
      runtimeArguments,
    });
  }

  const exitCode = await new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: runtimeDirectory,
      env: buildAgentSkillRuntimeEnvironment({
        artifact,
        runtimeDirectory,
        executionContext,
        grantedEnvironment,
      }),
      shell: false,
      stdio: [grantedStdin === null ? "inherit" : "pipe", "inherit", "inherit"],
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) {
        reject(new Error(`Runtime процесса завершён сигналом ${signal}.`));
        return;
      }
      resolve(code ?? 1);
    });
    if (grantedStdin !== null) {
      child.stdin.end(grantedStdin);
    }
  });

  if (exitCode !== 0) {
    throw new Error(`Runtime навыка завершился с кодом ${exitCode}.`);
  }
};

const assertOrdinaryRuntimePolicyForCompany = async ({
  origin,
  token,
  companyId,
  runtimeSessionId,
  runtimeAttestation,
}) => {
  const target = normalizeRuntimePolicyTarget({ companyId });
  if (!target) {
    throw new Error("Некорректная company для проверки политики модели.");
  }
  const admission = await fetchRuntimePolicyAdmission({
    origin,
    token,
    target,
    runtimeSessionId,
    runtimeAttestation,
  });
  const evaluation = admission.evaluation;
  if (!evaluation) {
    throw new Error("Trelio не вернул оценку политики модели для запуска навыка.");
  }
  if (evaluation.enforced && !evaluation.satisfied) {
    throw new Error(
      `Trelio заблокировал запуск навыка политикой модели (${evaluation.reasonCode}). `
        + "Выберите разрешённую модель и достаточный уровень рассуждений.",
    );
  }
};

const readEncryptedRuntimeManifestCapabilities = (manifest) => {
  const capabilities = Array.isArray(manifest?.capabilities)
    ? manifest.capabilities
    : [];
  return [...new Set(capabilities.filter((capability) => (
    typeof capability === "string"
    && AGENT_SKILL_DEVICE_CONSENT_CAPABILITIES.has(capability)
  )))].sort();
};

const hydrateEncryptedAgentSkillRuntimeResolution = async ({
  rawResolution,
  origin,
  token,
  companyId,
}) => {
  if (rawResolution?.artifact?.contentProtection !== "company_e2ee_v1") {
    return { rawResolution, companyEncryption: null };
  }
  const manifestReference = parseAgentEncryptedContentReference(
    rawResolution.artifact.manifest,
  );
  if (
    manifestReference?.field !== "manifest_json"
    || rawResolution.company?.id !== companyId
    || typeof rawResolution.company?.slug !== "string"
    || typeof rawResolution.company?.name !== "string"
  ) {
    throw new Error("Trelio вернул некорректную E2EE binding runtime package.");
  }
  const companyEncryption = await ensureCompanyEncryptionContext({
    origin,
    token,
    company: rawResolution.company,
  });
  if (!companyEncryption) {
    throw new Error(
      "Runtime package защищён company E2EE, но компания уже находится в обычном режиме.",
    );
  }

  return {
    rawResolution: {
      ...(await hydrateAgentCompanyEncryptedJson({
        value: rawResolution,
        origin,
        token,
        companyEncryption,
      })),
      encryptedManifestEntityId: manifestReference.entityId,
    },
    companyEncryption,
  };
};

const prepareEncryptedAgentSkillDeviceConsent = async ({
  origin,
  token,
  companyId,
  projectId,
  skillId,
  releaseId,
  rawResolution,
  collectConsentFn,
}) => {
  const hydrated = await hydrateEncryptedAgentSkillRuntimeResolution({
    rawResolution,
    origin,
    token,
    companyId,
  });
  const resolution = normalizeResolvedSkillRuntimeArtifact(
    hydrated.rawResolution,
    { allowPendingEncryptedConsent: true },
  );

  if (
    resolution.releaseId !== releaseId
    || resolution.artifact.skillId !== skillId
    || resolution.trust.consentId !== null
  ) {
    throw new Error("Encrypted runtime consent preview не совпадает с exact skill release.");
  }
  const inspected = await inspectEncryptedAgentSkillRuntimeForConsent({
    origin,
    token,
    packageUrl: resolution.packageUrl,
    artifact: { ...resolution.artifact },
    companyEncryption: hydrated.companyEncryption,
  });
  const rawChallenge = hydrated.rawResolution.consentChallenge;
  const previousCapabilities = readEncryptedRuntimeManifestCapabilities(
    rawChallenge?.artifact?.previousManifest,
  );
  const capabilities = inspected.capabilities;
  const challenge = {
    ...rawChallenge,
    artifact: {
      ...rawChallenge?.artifact,
      packageSizeBytes: inspected.packageSizeBytes,
      capabilities,
    },
    changes: {
      ...rawChallenge?.changes,
      capabilitiesAdded: capabilities.filter(
        (capability) => !previousCapabilities.includes(capability),
      ),
      capabilitiesRemoved: previousCapabilities.filter(
        (capability) => !capabilities.includes(capability),
      ),
    },
  };

  await collectConsentFn({
    origin,
    token,
    challenge,
    companyId,
    projectId,
    skillId,
    releaseId,
  });
};

export const resolveAgentSkillRuntimeWithDeviceConsent = async ({
  origin,
  token,
  companyId,
  projectId,
  skillId,
  releaseId,
}, {
  requestFn = request,
  collectConsentFn = collectAgentSkillDeviceConsentThroughLoopback,
  prepareEncryptedConsentFn = prepareEncryptedAgentSkillDeviceConsent,
} = {}) => {
  const requestResolution = () => requestFn(
    origin,
    token,
    "/api/agent-skills/runtime/resolve",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        companyId,
        ...(projectId ? { projectId } : {}),
        skillId,
        expectedReleaseId: releaseId,
      }),
    },
  );

  try {
    const response = await requestResolution();
    let preview = null;

    try {
      preview = await response.clone().json();
    } catch {
      return response;
    }

    if (
      preview?.artifact?.contentProtection === "company_e2ee_v1"
      && preview?.trust?.requiresDeviceConsent === true
      && preview?.trust?.consentId === null
    ) {
      await prepareEncryptedConsentFn({
        origin,
        token,
        companyId,
        projectId,
        skillId,
        releaseId,
        rawResolution: preview,
        collectConsentFn,
      });
      return requestResolution();
    }

    return response;
  } catch (error) {
    if (
      !(error instanceof TrelioApiError)
      || error.code !== "AGENT_SKILL_DEVICE_CONSENT_REQUIRED"
    ) {
      throw error;
    }

    await collectConsentFn({
      origin,
      token,
      challenge: error.payload?.challenge,
      companyId,
      projectId,
      skillId,
      releaseId,
    });

    // The accepted grant is server-side and exact to the same publication.
    // A second live resolve both proves the write and catches an update that
    // raced with the browser click before any cache/package access.
    return requestResolution();
  }
};

const skillCommand = async (
  origin,
  options,
  positional,
  { grantedEnvironment = {}, grantedStdin = null } = {},
) => {
  const skillSubcommand = positional[0];

  if (skillSubcommand === "pack") {
    const sourceDirectory = path.resolve(String(options.source || ""));
    const outputPath = path.resolve(String(options.output || ""));

    if (!options.source || !options.output) {
      throw new Error("skill pack требует --source и --output.");
    }

    const rawCapabilities = options.capability === undefined
      ? []
      : Array.isArray(options.capability)
        ? options.capability
        : [options.capability];
    const packageBytes = await buildAgentSkillPackage({
      skillId: String(options.skill || ""),
      runtimeVersion: String(options["runtime-version"] || ""),
      sourceDirectory,
      entrypointPath: String(options.entry || ""),
      interpreter: String(options.interpreter || ""),
      capabilities: rawCapabilities,
    });
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, packageBytes, { flag: "wx", mode: 0o644 });
    process.stdout.write(`${outputPath}\n`);
    return;
  }

  if (skillSubcommand !== "run") {
    throw new Error("Поддерживаются `skill pack` и `skill run`.");
  }

  const companyId = requireUuid(options.company, "company");
  const projectId = options.project
    ? requireUuid(options.project, "project")
    : null;
  const releaseId = requireUuid(options.release, "release");
  const skillId = String(options.skill || "");
  const runtimeSessionId = parseRuntimeSessionOption(options);
  const runtimeAttestation = parseSelfReportedRuntimeAttestationOptions(options);

  if (!SKILL_ID_PATTERN.test(skillId)) {
    throw new Error("Параметр --skill должен содержать lowercase kebab-case id.");
  }

  const token = await requireToken(origin);
  await ensureBridgeCompatibility(origin, token);
  await assertOrdinaryRuntimePolicyForCompany({
    origin,
    token,
    companyId,
    runtimeSessionId,
    runtimeAttestation,
  });
  const response = await resolveAgentSkillRuntimeWithDeviceConsent({
    origin,
    token,
    companyId,
    projectId,
    skillId,
    releaseId,
  });
  let rawResolution = await response.json();
  const hydratedRuntime = await hydrateEncryptedAgentSkillRuntimeResolution({
    rawResolution,
    origin,
    token,
    companyId,
  });
  rawResolution = hydratedRuntime.rawResolution;
  const companyEncryption = hydratedRuntime.companyEncryption;
  const resolution = normalizeResolvedSkillRuntimeArtifact(rawResolution);

  if (
    resolution.releaseId !== releaseId
    || resolution.artifact.skillId !== skillId
    || (
      resolution.localIdentity
      && (
        resolution.localIdentity.companyId !== companyId
        || resolution.localIdentity.projectId !== projectId
      )
    )
  ) {
    throw new Error("Trelio runtime resolution не совпадает с get_agent_skill.");
  }

  // Даже cache hit начинается с live resolve. Так агент не должен сам
  // отслеживать обновления, а expected release закрывает гонку между чтением
  // инструкции и запуском runtime.
  const artifactForCache = {
    ...resolution.artifact,
  };
  let cachedDirectory = null;

  // Для проверки cache нужен signed package manifest. Маленький package
  // скачивается только при miss; marker сам по себе не считается достаточным
  // доказательством, поэтому cache metadata хранит content-free manifest.
  const markerCandidate = path.join(
    SKILL_RUNTIME_CACHE_DIRECTORY,
    artifactForCache.skillId,
    artifactForCache.runtimeVersion,
    artifactForCache.packageSha256,
    ".trelio-package.json",
  );

  try {
    if (artifactForCache.contentProtection === "company_e2ee_v1") {
      throw Object.assign(new Error("Encrypted runtime requires a fresh ciphertext check."), {
        code: "ENOENT",
      });
    }
    const cachedPackageBytes = await fs.readFile(markerCandidate);
    if (
      cachedPackageBytes.byteLength !== artifactForCache.packageSizeBytes
      || crypto.createHash("sha256").update(cachedPackageBytes).digest("hex")
        !== artifactForCache.packageSha256
    ) {
      throw new Error("Cached runtime package не совпадает с resolve metadata.");
    }
    verifyAgentSkillPackageSignature(cachedPackageBytes, artifactForCache);
    artifactForCache.parsedPackage = parseAndValidateAgentSkillPackage(
      cachedPackageBytes,
      artifactForCache.skillId,
    );
    if (
      artifactForCache.parsedPackage.runtimeVersion
      !== artifactForCache.runtimeVersion
    ) {
      throw new Error("Cached runtime package version не совпадает с resolve metadata.");
    }
    cachedDirectory = await readVerifiedSkillRuntimeCache(artifactForCache);
  } catch (error) {
    if (error.code !== "ENOENT") {
      cachedDirectory = null;
    }
  }

  let runtimeDirectory;

  if (cachedDirectory) {
    runtimeDirectory = cachedDirectory;
  } else {
    const materialized = await downloadAndMaterializeAgentSkillRuntime({
      origin,
      token,
      packageUrl: resolution.packageUrl,
      artifact: artifactForCache,
      companyEncryption,
    });
    runtimeDirectory = materialized.runtimeDirectory;
  }

  await runMaterializedAgentSkill({
    artifact: artifactForCache,
    runtimeDirectory,
    runtimeArguments: positional.slice(1),
    executionContext: {
      companyId,
      projectId,
      releaseId,
      localIdentity: resolution.localIdentity,
      companyConnection: resolution.companyConnection,
    },
    grantedEnvironment,
    grantedStdin,
  });
};

const getCachedObjectPath = (sha256) => {
  if (!SHA256_PATTERN.test(String(sha256 || ""))) {
    throw new Error("Некорректный SHA-256 для локального cache.");
  }

  return path.join(OBJECT_CACHE_DIRECTORY, sha256.slice(0, 2), sha256);
};

const validateCachedObject = async (pointer) => {
  const cachePath = getCachedObjectPath(pointer.sha256);

  try {
    const stat = await fs.lstat(cachePath);

    if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== pointer.sizeBytes) {
      await fs.rm(cachePath, { force: true });
      return null;
    }

    const digest = await hashFile(cachePath);

    if (digest.sha256 !== pointer.sha256 || digest.sizeBytes !== pointer.sizeBytes) {
      // Cache считается недоверенным локальным ускорителем: любое расхождение
      // удаляем до повторной загрузки и никогда не копируем в Run snapshot.
      await fs.rm(cachePath, { force: true });
      return null;
    }

    const now = new Date();
    await fs.utimes(cachePath, now, now).catch(() => undefined);
    return cachePath;
  } catch (error) {
    if (error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
};

const downloadResponseIntoCache = async (response, pointer) => {
  if (!response.body) {
    throw new Error("Trelio вернул пустой поток workspace object.");
  }

  const cachePath = getCachedObjectPath(pointer.sha256);
  const cacheDirectory = path.dirname(cachePath);
  await fs.mkdir(cacheDirectory, { recursive: true, mode: 0o700 });
  const temporaryPath = path.join(
    cacheDirectory,
    `.${pointer.sha256}.download-${crypto.randomUUID()}`,
  );
  const hash = crypto.createHash("sha256");
  let receivedBytes = 0;
  const verifier = new Transform({
    transform(chunk, _encoding, callback) {
      receivedBytes += chunk.byteLength;

      if (receivedBytes > pointer.sizeBytes) {
        callback(new Error(`Workspace object ${pointer.sha256} превысил заявленный размер.`));
        return;
      }

      hash.update(chunk);
      callback(null, chunk);
    },
  });

  try {
    await pipeline(
      Readable.fromWeb(response.body),
      verifier,
      createWriteStream(temporaryPath, { flags: "wx", mode: 0o600 }),
    );

    if (receivedBytes !== pointer.sizeBytes || hash.digest("hex") !== pointer.sha256) {
      throw new Error(`Workspace object ${pointer.sha256} не прошёл локальную проверку.`);
    }

    try {
      await fs.rename(temporaryPath, cachePath);
    } catch (error) {
      if (error.code !== "EEXIST" && error.code !== "ENOTEMPTY") {
        throw error;
      }

      // Параллельный Run мог первым опубликовать тот же digest. Доверяем ему
      // только после полной повторной проверки, как обычному cache hit.
      const concurrentCachePath = await validateCachedObject(pointer);

      if (!concurrentCachePath) {
        throw new Error(`Параллельная публикация cache object ${pointer.sha256} повреждена.`);
      }
    }
  } finally {
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
  }

  const verifiedCachePath = await validateCachedObject(pointer);

  if (!verifiedCachePath) {
    throw new Error(`Workspace object ${pointer.sha256} не появился в cache после проверки.`);
  }

  return verifiedCachePath;
};

const copyCachedObjectToDestination = async (cachePath, destination, pointer) => {
  const parentDirectory = path.dirname(destination);
  const temporaryPath = path.join(
    parentDirectory,
    `.${path.basename(destination)}.materialize-${crypto.randomUUID()}`,
  );

  try {
    // clonefile/reflink экономит место между Run, но не создаёт mutable hardlink.
    // На неподдерживаемой ФС COPYFILE_FICLONE падает, после чего используем
    // обычную независимую копию.
    try {
      await fs.copyFile(cachePath, temporaryPath, fsConstants.COPYFILE_FICLONE);
    } catch (error) {
      if (error.code !== "ENOTSUP" && error.code !== "EXDEV" && error.code !== "EINVAL") {
        throw error;
      }
      await fs.copyFile(cachePath, temporaryPath);
    }

    const copied = await hashFile(temporaryPath);

    if (copied.sha256 !== pointer.sha256 || copied.sizeBytes !== pointer.sizeBytes) {
      throw new Error(`Локальная копия workspace object ${pointer.sha256} повреждена.`);
    }

    if (process.platform === "win32") {
      await fs.rm(destination, { force: true });
    }
    await fs.rename(temporaryPath, destination);
  } finally {
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
  }
};

const ensureCachedWorkspaceObject = async ({ pointer, fetchResponse }) => {
  const cachedPath = await validateCachedObject(pointer);

  if (cachedPath) {
    return { cachePath: cachedPath, cacheHit: true };
  }

  const response = await fetchResponse();
  return {
    cachePath: await downloadResponseIntoCache(response, pointer),
    cacheHit: false,
  };
};

export const inspectWorkspaceFile = async (filePath) => {
  const fileStat = await fs.lstat(filePath);

  if (!fileStat.isFile() || fileStat.isSymbolicLink()) {
    throw new Error(`Workspace содержит неподдерживаемый тип файла: ${filePath}`);
  }

  if (fileStat.size <= MAX_INLINE_TEXT_BYTES) {
    const bytes = await fs.readFile(filePath);

    if (isUtf8(bytes) && !bytes.includes(0)) {
      return { external: false, sizeBytes: bytes.byteLength };
    }

    return {
      external: true,
      ...(await hashFile(filePath)),
    };
  }

  return {
    external: true,
    ...(await hashFile(filePath)),
  };
};

const listTrackedWorkspacePaths = async (workspaceDirectory) => {
  const result = await runGit(["ls-files", "-z"], { cwd: workspaceDirectory });
  return result.stdout.split("\0").filter(Boolean);
};

export const assertMaterializedWorkspaceFileTypes = async (workspaceDirectory) => {
  const trackedPaths = await listTrackedWorkspacePaths(workspaceDirectory);

  for (const filePath of trackedPaths) {
    const metadata = await fs.lstat(path.join(workspaceDirectory, filePath));

    // A Git symlink can point outside the inspection root even though its path
    // is tracked. Read-only accepted snapshots therefore admit regular files
    // only; otherwise an agent could follow legacy content into unrelated
    // local data, and chmod must never follow that link while hardening.
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error(`Workspace содержит неподдерживаемый тип файла: ${filePath}`);
    }
  }
};

const isForbiddenWorkspaceSecretPath = (filePath) => {
  const normalized = filePath.replaceAll("\\", "/").toLowerCase();
  const segments = normalized.split("/");
  const basename = segments.at(-1) || "";

  return segments.includes(".ssh")
    || segments.includes(".aws")
    || basename === ".env"
    || basename.startsWith(".env.")
    || basename === "credentials.json"
    || basename === "secrets.json"
    || basename === "id_rsa"
    || basename === "id_ed25519"
    || basename.endsWith(".p12")
    || basename.endsWith(".pfx")
    || basename.endsWith(".key");
};

/**
 * The server deliberately cannot inspect an encrypted Git tree.  The local
 * bridge therefore owns the same fail-closed path/type/secret checks before
 * it seals a full snapshot.  These checks run after `git add`, so they inspect
 * the exact candidate rather than an earlier filesystem view.
 */
const assertEncryptedCandidateSafe = async ({ workspaceDirectory, baseHead }) => {
  const trackedPaths = await listTrackedWorkspacePaths(workspaceDirectory);

  if (trackedPaths.length > MAX_ENCRYPTED_WORKSPACE_FILE_COUNT) {
    throw new Error("Зашифрованный Workspace содержит слишком много файлов.");
  }

  let totalBytes = 0;

  for (const filePath of trackedPaths) {
    const segments = filePath.split("/");
    const hasGitControlSegment = segments.some(
      (segment) => segment.toLowerCase().replace(/[ .]+$/gu, "") === ".git",
    );

    if (
      !filePath
      || filePath.length > 2048
      || filePath.startsWith("/")
      || filePath.includes("\\")
      || segments.includes("..")
      || /[<>:"|?*]/u.test(filePath)
      || /[\u0000-\u001f\u007f]/u.test(filePath)
      || hasGitControlSegment
    ) {
      throw new Error(`Workspace содержит небезопасный путь: ${filePath}`);
    }
    if (isForbiddenWorkspaceSecretPath(filePath)) {
      throw new Error(`Workspace содержит запрещённый secret path: ${filePath}`);
    }

    const fileStat = await fs.lstat(path.join(workspaceDirectory, filePath));

    if (!fileStat.isFile() || fileStat.isSymbolicLink()) {
      throw new Error(`Workspace содержит неподдерживаемый тип файла: ${filePath}`);
    }
    totalBytes += fileStat.size;

    if (fileStat.size <= MAX_INLINE_TEXT_BYTES) {
      const bytes = await fs.readFile(path.join(workspaceDirectory, filePath));

      if (
        isUtf8(bytes)
        && !bytes.includes(0)
        && /BEGIN ([A-Z0-9 ]+ )?PRIVATE KEY|AKIA[0-9A-Z]{16}/u.test(bytes.toString("utf8"))
      ) {
        throw new Error(`Candidate похож на приватный ключ или долгоживущий credential: ${filePath}`);
      }
    }

    if (totalBytes > MAX_ENCRYPTED_WORKSPACE_TREE_BYTES) {
      throw new Error("Зашифрованный Workspace превышает локальный лимит полного снимка.");
    }
  }

  if (GIT_OBJECT_PATTERN.test(String(baseHead || ""))) {
    const protectedChanges = (await runGit([
      "diff",
      "--cached",
      "--name-only",
      baseHead,
      "--",
      "AGENTS.md",
      "CLAUDE.md",
      ".trelio",
    ], { cwd: workspaceDirectory })).stdout.trim();

    if (protectedChanges) {
      throw new Error("Candidate изменяет защищённые control-файлы Agent Workspace.");
    }
  }

};

const downloadAndVerifyWorkspaceObject = async ({
  origin,
  token,
  runId,
  pointer,
  destination,
}) => {
  const cached = await ensureCachedWorkspaceObject({
    pointer,
    fetchResponse: () => request(
      origin,
      token,
      `/api/agent-workspaces/runs/${runId}/objects/${pointer.sha256}`,
    ),
  });
  await copyCachedObjectToDestination(cached.cachePath, destination, pointer);
  return cached;
};

const setSkipWorktree = async (workspaceDirectory, filePaths, enabled) => {
  // Ограничиваем argv небольшими группами: workspace может содержать тысячи
  // объектов, а системный ARG_MAX отличается между macOS/Linux/Windows.
  for (let index = 0; index < filePaths.length; index += 100) {
    const chunk = filePaths.slice(index, index + 100);

    if (chunk.length > 0) {
      await runGit(
        ["update-index", enabled ? "--skip-worktree" : "--no-skip-worktree", "--", ...chunk],
        { cwd: workspaceDirectory },
      );
    }
  }
};

const materializeWorkspaceObjects = async ({
  origin,
  token,
  runId,
  workspaceDirectory,
  knownObjects = [],
}) => {
  const objectsByPath = new Map(
    knownObjects
      .filter((object) => (
        object
        && typeof object.filePath === "string"
        && SHA256_PATTERN.test(String(object.sha256 || ""))
        && Number.isSafeInteger(object.sizeBytes)
        && object.sizeBytes > 0
      ))
      .map((object) => [object.filePath, object]),
  );
  const trackedPaths = await listTrackedWorkspacePaths(workspaceDirectory);
  const trackedPathSet = new Set(trackedPaths);

  for (const filePath of trackedPaths) {
    const absolutePath = path.join(workspaceDirectory, filePath);
    const fileStat = await fs.lstat(absolutePath);

    if (!fileStat.isFile() || fileStat.size > POINTER_MAX_BYTES) {
      continue;
    }

    const pointer = parseWorkspaceObjectPointer(await fs.readFile(absolutePath));

    if (!pointer) {
      continue;
    }

    await downloadAndVerifyWorkspaceObject({
      origin,
      token,
      runId,
      pointer,
      destination: absolutePath,
    });
    objectsByPath.set(filePath, { filePath, ...pointer });
  }

  const objects = [...objectsByPath.values()]
    .filter((object) => trackedPathSet.has(object.filePath));
  await setSkipWorktree(
    workspaceDirectory,
    objects.map((object) => object.filePath),
    true,
  );
  return objects;
};

const materializeBundle = async ({ bundlePath, directory, head, branch }) => {
  if (!GIT_OBJECT_PATTERN.test(head)) {
    throw new Error("Сервер вернул некорректный Git head.");
  }

  await fs.mkdir(directory, { recursive: true });
  await runGit(["init", "--initial-branch=main"], { cwd: directory });
  // Ни checkout, ни последующие commit не должны исполнять hooks, которые
  // могли попасть из пользовательского Git template/config на этой машине.
  await runGit(
    ["config", "core.hooksPath", GIT_DISABLED_HOOKS_PATH],
    { cwd: directory },
  );
  await runGit(["config", "fetch.fsckObjects", "true"], { cwd: directory });
  await runGit([
    "fetch",
    bundlePath,
    "+refs/trelio/exports/*:refs/remotes/trelio-export/*",
    "+refs/heads/*:refs/remotes/trelio-encrypted/*",
  ], { cwd: directory });
  await runGit(["cat-file", "-e", `${head}^{commit}`], { cwd: directory });
  await runGit(["checkout", "-B", branch, head], { cwd: directory });
  await runGit(["config", "user.name", "Trelio Agent Workspace"], { cwd: directory });
  await runGit(["config", "user.email", "agent-workspaces@trelio.local"], { cwd: directory });
};

const fastForwardMaterializedBundle = async ({
  bundlePath,
  workspaceDirectory,
  head,
  knownObjects,
  allowHistoryReplacement = false,
  expectedLocalHead = null,
}) => {
  const localHead = (await runGit(["rev-parse", "HEAD"], {
    cwd: workspaceDirectory,
  })).stdout.trim();

  if (expectedLocalHead && localHead !== expectedLocalHead) {
    throw new Error(
      "Локальная Git-история изменилась во время server sync. Автоматическая перезапись запрещена.",
    );
  }

  if (localHead === head) {
    return false;
  }

  const localStatus = await getGitStatus(workspaceDirectory, knownObjects);

  if (localStatus) {
    throw new Error(
      "Локальный Run содержит несохранённые изменения и отстаёт от server draft. "
      + "Откройте актуальный Run в новом каталоге или перенесите изменения осознанно.",
    );
  }

  await runGit(
    [
      "fetch",
      bundlePath,
      "+refs/trelio/exports/*:refs/remotes/trelio-export/*",
      "+refs/heads/*:refs/remotes/trelio-encrypted/*",
    ],
    { cwd: workspaceDirectory },
  );
  await runGit(["cat-file", "-e", `${head}^{commit}`], { cwd: workspaceDirectory });
  if (!allowHistoryReplacement) {
    const mergeBase = (await runGit(["merge-base", localHead, head], {
      cwd: workspaceDirectory,
    })).stdout.trim();

    if (mergeBase !== localHead) {
      throw new Error(
        "Локальная история Run расходится с server draft. Автоматическая перезапись запрещена.",
      );
    }
  }

  await setSkipWorktree(
    workspaceDirectory,
    knownObjects.map((object) => object.filePath),
    false,
  );
  for (const object of knownObjects) {
    const pointer = serializeWorkspaceObjectPointer(object);
    await fs.writeFile(path.join(workspaceDirectory, object.filePath), pointer, "utf8");
  }
  // Неотслеживаемый стандартный WORKLOG является воспроизводимым bootstrap.
  // Убираем только его exact bytes перед checkout: server draft мог уже
  // сохранить тот же путь, и Git иначе справедливо откажется перекрывать
  // untracked-файл. Пользовательскую или изменённую версию не трогаем.
  await removeGeneratedUntrackedWorklog(workspaceDirectory);
  const headBeforeCheckout = (await runGit(["rev-parse", "HEAD"], {
    cwd: workspaceDirectory,
  })).stdout.trim();

  if (headBeforeCheckout !== localHead) {
    throw new Error(
      "Локальная Git-история изменилась непосредственно перед checkout. Автоматическая перезапись запрещена.",
    );
  }
  await runGit(["checkout", "-B", "trelio-candidate", head], {
    cwd: workspaceDirectory,
  });
  return true;
};

const ensureRuntimeControlExcludes = async (workspaceDirectory) => {
  const excludePath = path.join(workspaceDirectory, ".git", "info", "exclude");
  const requiredLines = ["/AGENTS.md", "/CLAUDE.md"];
  let current = "";

  try {
    current = await fs.readFile(excludePath, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }

  const currentLines = new Set(current.split(/\r?\n/).map((line) => line.trim()));
  const missingLines = requiredLines.filter((line) => !currentLines.has(line));

  if (missingLines.length === 0) {
    return;
  }

  await fs.mkdir(path.dirname(excludePath), { recursive: true, mode: 0o700 });
  const prefix = current.length > 0 && !current.endsWith("\n") ? "\n" : "";
  await fs.appendFile(excludePath, `${prefix}${missingLines.join("\n")}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
};

const writeRuntimeControlFile = async (workspaceDirectory, fileName, content) => {
  const destination = path.join(workspaceDirectory, fileName);
  const temporaryPath = path.join(
    workspaceDirectory,
    ".git",
    `runtime-control-${crypto.randomUUID()}`,
  );

  try {
    const existing = await fs.lstat(destination);

    // Никогда не следуем по файлу из принятой legacy-revision: старые Git tree
    // теоретически могли быть импортированы до запрета symlink.
    if (!existing.isFile() || existing.isSymbolicLink()) {
      throw new Error(`Защищённый runtime-файл ${fileName} имеет недопустимый тип.`);
    }
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }

  try {
    await fs.writeFile(temporaryPath, content, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    // Windows не гарантирует replacement существующего файла через rename.
    // Target уже проверен lstat выше; удаляем только точный control path.
    await fs.rm(destination, { force: true });
    await fs.rename(temporaryPath, destination);

    if (process.platform !== "win32") {
      await fs.chmod(destination, 0o444);
    }
  } finally {
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
  }
};

const inspectWorkspaceWorklog = async (workspaceDirectory) => {
  const destination = path.join(workspaceDirectory, WORKLOG_FILE_NAME);

  try {
    const existing = await fs.lstat(destination);

    // Даже отсутствующий в старом backend path не должен позволять bridge
    // пройти по symlink или молча заменить каталог пользовательских данных.
    if (!existing.isFile() || existing.isSymbolicLink()) {
      throw new Error(`${WORKLOG_FILE_NAME} имеет неподдерживаемый тип файла.`);
    }

    return {
      exists: true,
      isDefault: await fs.readFile(destination, "utf8")
        === AGENT_WORKSPACE_DEFAULT_WORKLOG_MARKDOWN,
    };
  } catch (error) {
    if (error.code === "ENOENT") {
      return { exists: false, isDefault: false };
    }
    throw error;
  }
};

export const ensureWorkspaceWorklog = async (workspaceDirectory) => {
  const current = await inspectWorkspaceWorklog(workspaceDirectory);

  if (current.exists) {
    // Сохранённый пользователем или предыдущим Run контракт всегда сильнее
    // стандартного шаблона текущего plugin release и не обновляется молча.
    return { created: false, isDefault: current.isDefault };
  }

  const destination = path.join(workspaceDirectory, WORKLOG_FILE_NAME);

  try {
    // Exclusive create не допускает гонку двух bridge-процессов и, в отличие
    // от rename поверх target, сохраняет гарантию never-overwrite.
    await fs.writeFile(destination, AGENT_WORKSPACE_DEFAULT_WORKLOG_MARKDOWN, {
      encoding: "utf8",
      mode: 0o644,
      flag: "wx",
    });
    return { created: true, isDefault: true };
  } catch (error) {
    if (error.code === "EEXIST") {
      const raced = await inspectWorkspaceWorklog(workspaceDirectory);
      return { created: false, isDefault: raced.isDefault };
    }
    throw error;
  }
};

export const resolveWorkspaceContextFileName = async (workspaceDirectory) => {
  const inspectContextPath = async (fileName) => {
    try {
      const metadata = await fs.lstat(path.join(workspaceDirectory, fileName));

      // Context is writable user data, but bootstrap must never direct an agent
      // through a symlink or directory that escaped the accepted Git tree.
      if (!metadata.isFile() || metadata.isSymbolicLink()) {
        throw new Error(`${fileName} имеет неподдерживаемый тип файла.`);
      }

      return true;
    } catch (error) {
      if (error.code === "ENOENT") {
        return false;
      }
      throw error;
    }
  };
  const [hasCanonicalContext, hasLegacyContext] = await Promise.all([
    inspectContextPath(WORKSPACE_CONTEXT_FILE_NAME),
    inspectContextPath(LEGACY_WORKSPACE_CONTEXT_FILE_NAME),
  ]);

  if (hasCanonicalContext && hasLegacyContext) {
    throw new Error(
      `Workspace одновременно содержит ${WORKSPACE_CONTEXT_FILE_NAME} и ${LEGACY_WORKSPACE_CONTEXT_FILE_NAME}; продолжение неоднозначно.`,
    );
  }

  if (hasCanonicalContext) {
    return WORKSPACE_CONTEXT_FILE_NAME;
  }

  if (hasLegacyContext) {
    // Небольшое окно совместимости нужно между публикацией plugin и backend
    // migration: новый bridge уже безопасен со старым accepted tree, но после
    // format-v5 upgrade сервер принимает только канонический путь.
    return LEGACY_WORKSPACE_CONTEXT_FILE_NAME;
  }

  throw new Error(
    `Workspace не содержит обязательный ${WORKSPACE_CONTEXT_FILE_NAME}.`,
  );
};

const removeGeneratedUntrackedWorklog = async (workspaceDirectory) => {
  const trackedPaths = new Set(await listTrackedWorkspacePaths(workspaceDirectory));

  if (trackedPaths.has(WORKLOG_FILE_NAME)) {
    return false;
  }

  const current = await inspectWorkspaceWorklog(workspaceDirectory);

  if (!current.exists || !current.isDefault) {
    return false;
  }

  await fs.rm(path.join(workspaceDirectory, WORKLOG_FILE_NAME));
  return true;
};

export const materializeRuntimeControlFiles = async (workspaceDirectory) => {
  const trackedPaths = new Set(await listTrackedWorkspacePaths(workspaceDirectory));
  const trackedControlPaths = ["AGENTS.md", "CLAUDE.md"]
    .filter((filePath) => trackedPaths.has(filePath));
  const workspaceContextFileName = await resolveWorkspaceContextFileName(workspaceDirectory);

  // Новые format-v5 workspace держат файлы untracked+ignored. Для legacy
  // revision сначала сохраняем исходные index entries через skip-worktree:
  // локальный актуальный bootstrap не попадёт в candidate поверх старого blob.
  await ensureRuntimeControlExcludes(workspaceDirectory);
  await Promise.all([
    writeRuntimeControlFile(
      workspaceDirectory,
      "AGENTS.md",
      buildAgentWorkspaceRuntimeAgentsMarkdown(workspaceContextFileName),
    ),
    writeRuntimeControlFile(
      workspaceDirectory,
      "CLAUDE.md",
      AGENT_WORKSPACE_RUNTIME_CLAUDE_MARKDOWN,
    ),
  ]);
  // WORKLOG в отличие от runtime control-файлов является обычным сохраняемым
  // материалом workspace. Создаём только fallback для отсутствующего пути:
  // изменённая или уже принятая версия должна пройти в следующий Run exact.
  await ensureWorkspaceWorklog(workspaceDirectory);
  await setSkipWorktree(workspaceDirectory, trackedControlPaths, true);
};

const makeReadOnly = async (directory) => {
  if (process.platform === "win32") {
    return;
  }

  const entries = await fs.readdir(directory, { withFileTypes: true });

  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    const metadata = await fs.lstat(entryPath);

    // chmod follows symlinks on supported POSIX hosts. Skipping them protects
    // paths outside a bridge-owned tree even if an old accepted Git revision
    // or a same-user race introduced a link before hardening.
    if (metadata.isSymbolicLink()) {
      continue;
    }

    if (metadata.isDirectory()) {
      await makeReadOnly(entryPath);
      await fs.chmod(entryPath, 0o555);
    } else {
      await fs.chmod(entryPath, 0o444);
    }
  }
};

const makeWritable = async (directory) => {
  if (process.platform === "win32") {
    return;
  }

  const entries = await fs.readdir(directory, { withFileTypes: true });

  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    const metadata = await fs.lstat(entryPath);

    // Removal needs writable parent directories, not permissions on symlink
    // targets. Never follow a link while restoring a bridge-owned tree.
    if (metadata.isSymbolicLink()) {
      continue;
    }

    if (metadata.isDirectory()) {
      await fs.chmod(entryPath, 0o755);
      await makeWritable(entryPath);
    } else {
      await fs.chmod(entryPath, 0o644);
    }
  }
  await fs.chmod(directory, 0o755);
};

export const buildRunContextSpecifications = (runId, rawContextHeads = {}) => {
  const normalizedRunId = requireUuid(runId, "run");
  const specifications = [];
  const seenWorkspaceIds = new Set();

  const append = ({ dependencyKind, dependency, relativeDirectory, endpoint }) => {
    if (!dependency) {
      return;
    }

    const workspaceId = requireUuid(dependency.workspaceId, "workspace");

    if (!GIT_OBJECT_PATTERN.test(String(dependency.head || ""))) {
      throw new Error(`Контекст ${workspaceId} содержит некорректный Git head.`);
    }

    // Backend не должен присылать один workspace дважды как parent и related.
    // Локальная проверка не даёт такому ответу перезаписать уже выбранный путь.
    if (seenWorkspaceIds.has(workspaceId)) {
      throw new Error(`Workspace ${workspaceId} повторяется в контексте Agent Run.`);
    }
    seenWorkspaceIds.add(workspaceId);
    specifications.push({
      dependencyKind,
      workspaceId,
      head: String(dependency.head),
      scopeType: dependency.scopeType || dependencyKind,
      scopeKey: dependency.scopeKey || "",
      relativeDirectory,
      endpoint,
    });
  };

  append({
    dependencyKind: "company",
    dependency: rawContextHeads.company,
    relativeDirectory: path.join("context", "company"),
    endpoint: `/api/agent-workspaces/runs/${normalizedRunId}/context/company/bundle`,
  });
  append({
    dependencyKind: "project",
    dependency: rawContextHeads.project,
    relativeDirectory: path.join("context", "project"),
    endpoint: `/api/agent-workspaces/runs/${normalizedRunId}/context/project/bundle`,
  });

  const relatedContexts = Array.isArray(rawContextHeads.related) ? rawContextHeads.related : [];

  for (const dependency of relatedContexts) {
    const workspaceId = requireUuid(dependency.workspaceId, "workspace");
    append({
      dependencyKind: "related",
      dependency,
      // UUID является одновременно безопасным segment и стабильным именем:
      // scopeKey может содержать `/` или измениться после переименования.
      relativeDirectory: path.join("context", "related", workspaceId),
      endpoint: `/api/agent-workspaces/runs/${normalizedRunId}/context/related/${workspaceId}/bundle`,
    });
  }

  return specifications;
};

const readMaterializedContextHead = async (directory) => {
  try {
    const directoryStat = await fs.lstat(directory);

    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
      return null;
    }

    const [headResult, statusResult] = await Promise.all([
      runGit(["rev-parse", "HEAD"], { cwd: directory }),
      runGit(["status", "--porcelain", "--untracked-files=all"], { cwd: directory }),
    ]);

    // Даже при неизменном HEAD локально испорченный read-only snapshot нельзя
    // молча считать достоверным: bridge заново скачает pinned server revision.
    return statusResult.stdout.trim() ? null : headResult.stdout.trim();
  } catch {
    return null;
  }
};

const ensureContextDirectoryChain = async (rootDirectory, relativeDirectory) => {
  const relativeParent = path.dirname(relativeDirectory);
  let currentDirectory = rootDirectory;

  for (const segment of relativeParent.split(path.sep).filter((part) => part && part !== ".")) {
    currentDirectory = path.join(currentDirectory, segment);

    try {
      const currentStat = await fs.lstat(currentDirectory);

      if (!currentStat.isDirectory() || currentStat.isSymbolicLink()) {
        throw new Error(`Путь контекста ${currentDirectory} не является обычным каталогом.`);
      }
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
      await fs.mkdir(currentDirectory, { mode: 0o700 });
    }
  }
};

const replaceMaterializedContext = async ({
  origin,
  token,
  runId,
  rootDirectory,
  specification,
  temporaryDirectory,
  companyEncryption,
}) => {
  const destination = path.join(rootDirectory, specification.relativeDirectory);
  const currentHead = await readMaterializedContextHead(destination);

  if (currentHead === specification.head) {
    // Read-only parent/related context остаётся pointer-first. Конкретные
    // external bytes агент получает только через `context fetch --path`.
    return { ...specification, directory: destination, changed: false };
  }

  const bundlePath = path.join(temporaryDirectory, `${specification.workspaceId}.bundle`);
  const stagingDirectory = `${destination}.staging-${crypto.randomUUID()}`;
  await ensureContextDirectoryChain(rootDirectory, specification.relativeDirectory);

  try {
    const endpoint = companyEncryption
      ? specification.endpoint.replace(/\/bundle$/u, "/encrypted-bundle")
      : specification.endpoint;
    const contextResponse = await request(origin, token, endpoint);
    if (companyEncryption) {
      await writeAndDecryptCompanyWorkspaceBundle({
        response: contextResponse,
        destination: bundlePath,
        companyEncryption,
      });
    } else {
      await writeResponseToFile(contextResponse, bundlePath);
    }
    await materializeBundle({
      bundlePath,
      directory: stagingDirectory,
      head: specification.head,
      branch: "trelio-context",
    });
    await makeReadOnly(stagingDirectory);

    try {
      const destinationStat = await fs.lstat(destination);

      if (destinationStat.isDirectory() && !destinationStat.isSymbolicLink()) {
        await makeWritable(destination);
        await fs.rm(destination, { recursive: true, force: true });
      } else {
        // Не следуем по локально подменённой symlink: удаляем только сам exact
        // destination entry внутри принадлежащего Run root.
        await fs.rm(destination, { force: true });
      }
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
    }

    // Rename в пределах одного root атомарно переключает локальный snapshot:
    // агент не увидит наполовину распакованный related context.
    await fs.rename(stagingDirectory, destination);
    return { ...specification, directory: destination, changed: true };
  } finally {
    await makeWritable(stagingDirectory).catch(() => undefined);
    await fs.rm(stagingDirectory, { recursive: true, force: true }).catch(() => undefined);
  }
};

const materializeRunContexts = async ({
  origin,
  token,
  rootDirectory,
  runId,
  contextHeads,
  companyEncryption = null,
}) => {
  const specifications = buildRunContextSpecifications(runId, contextHeads);
  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "trelio-context-"));
  const contexts = [];

  try {
    for (const specification of specifications) {
      contexts.push(await replaceMaterializedContext({
        origin,
        token,
        runId,
        rootDirectory,
        specification,
        temporaryDirectory,
        companyEncryption,
      }));
    }
  } finally {
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
  }

  return contexts;
};

const serializeMaterializedContexts = (contexts) => contexts.map((context) => ({
  dependencyKind: context.dependencyKind,
  workspaceId: context.workspaceId,
  head: context.head,
  scopeType: context.scopeType,
  scopeKey: context.scopeKey,
  directory: context.directory,
}));

const writeRunMetadata = async (metadataPath, metadata) => {
  const temporaryPath = `${metadataPath}.${process.pid}.${crypto.randomUUID()}.tmp`;

  try {
    // Per-file object progress должен переживать остановку bridge. Пишем новый
    // JSON рядом с metadata и публикуем rename-ом, чтобы процесс никогда не
    // оставил обрезанный `.trelio-run.json` между двумя submit.
    await fs.writeFile(temporaryPath, `${JSON.stringify(metadata, null, 2)}\n`, { mode: 0o600 });
    await fs.chmod(temporaryPath, 0o600);
    await fs.rename(temporaryPath, metadataPath);
    await fs.chmod(metadataPath, 0o600);
  } finally {
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
  }
};

const readLocalSettings = async () => {
  let rawSettings = {};

  try {
    rawSettings = JSON.parse(await fs.readFile(LOCAL_SETTINGS_FILE, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }

  const readBoundedInteger = (value, fallback, minimum, maximum) => {
    const numericValue = Number(value);
    return Number.isSafeInteger(numericValue) && numericValue >= minimum && numericValue <= maximum
      ? numericValue
      : fallback;
  };

  // `terminalRunRetentionDays` остаётся только совместимым alias для уже
  // настроенных клиентов. Новый ключ описывает фактическую единицу хранения:
  // один переиспользуемый локальный root на Workspace, а не каталог каждого Run.
  const legacyWorkspaceRetentionDays = readBoundedInteger(
    rawSettings.terminalRunRetentionDays,
    DEFAULT_LOCAL_SETTINGS.workspaceRetentionDays,
    1,
    365,
  );

  return {
    workspaceRetentionDays: readBoundedInteger(
      rawSettings.workspaceRetentionDays,
      legacyWorkspaceRetentionDays,
      1,
      365,
    ),
    objectCacheMaxAgeDays: readBoundedInteger(
      rawSettings.objectCacheMaxAgeDays,
      DEFAULT_LOCAL_SETTINGS.objectCacheMaxAgeDays,
      1,
      3650,
    ),
    objectCacheMaxBytes: readBoundedInteger(
      rawSettings.objectCacheMaxBytes,
      DEFAULT_LOCAL_SETTINGS.objectCacheMaxBytes,
      256 * 1024 * 1024,
      1024 * 1024 * 1024 * 1024,
    ),
    skillRuntimeCacheMaxAgeDays: readBoundedInteger(
      rawSettings.skillRuntimeCacheMaxAgeDays,
      DEFAULT_LOCAL_SETTINGS.skillRuntimeCacheMaxAgeDays,
      1,
      3650,
    ),
    skillRuntimeCacheMaxBytes: readBoundedInteger(
      rawSettings.skillRuntimeCacheMaxBytes,
      DEFAULT_LOCAL_SETTINGS.skillRuntimeCacheMaxBytes,
      64 * 1024 * 1024,
      64 * 1024 * 1024 * 1024,
    ),
  };
};

const readRunRegistry = async () => {
  try {
    const payload = JSON.parse(await fs.readFile(RUN_REGISTRY_FILE, "utf8"));
    return Array.isArray(payload?.roots)
      ? payload.roots.filter((item) => typeof item === "string" && path.isAbsolute(item))
      : [];
  } catch (error) {
    if (error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
};

const writeRunRegistry = async (roots) => {
  await fs.mkdir(CONFIG_DIRECTORY, { recursive: true, mode: 0o700 });
  const temporaryPath = `${RUN_REGISTRY_FILE}.tmp-${crypto.randomUUID()}`;

  try {
    await fs.writeFile(
      temporaryPath,
      `${JSON.stringify({
        schemaVersion: 1,
        roots: [...new Set(roots.map((item) => path.resolve(item)))].sort(),
      }, null, 2)}\n`,
      { mode: 0o600 },
    );
    await fs.rename(temporaryPath, RUN_REGISTRY_FILE);
  } finally {
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
  }
};

const registerRunRoot = async (rootDirectory) => {
  const roots = await readRunRegistry();
  await writeRunRegistry([...roots, path.resolve(rootDirectory)]);
};

const normalizeAgentInstructionsSnapshot = (rawSnapshot) => {
  const snapshot = rawSnapshot && typeof rawSnapshot === "object" ? rawSnapshot : {};
  const compiledMarkdown = typeof snapshot.compiledMarkdown === "string"
    ? snapshot.compiledMarkdown
    : "";

  if (!compiledMarkdown || Buffer.byteLength(compiledMarkdown, "utf8") > 300 * 1024) {
    throw new Error("Trelio вернул некорректный снимок рабочих правил.");
  }

  const normalizeRevision = (revision) => (
    revision
    && typeof revision === "object"
    && UUID_PATTERN.test(String(revision.revisionId || ""))
    && Number.isSafeInteger(revision.version)
    && revision.version > 0
      ? {
          revisionId: String(revision.revisionId),
          version: revision.version,
        }
      : null
  );
  const platform = snapshot.platform === undefined
    ? null
    : normalizeAgentRulesSnapshot(snapshot.platform);

  return {
    schemaVersion: platform ? 2 : 1,
    platform,
    company: normalizeRevision(snapshot.company),
    project: normalizeRevision(snapshot.project),
    compiledMarkdown,
  };
};

const DEFAULT_USER_PROFILE_MARKDOWN = [
  "# Как агенту работать со мной",
  "",
  "Личные настройки пользователя для этой компании пока не заданы.",
  "",
].join("\n");

const normalizeUserProfileSnapshot = (rawSnapshot) => {
  // Старый backend до появления company-scoped personal profile не присылал
  // поле вовсе. Новый bridge остаётся совместимым и материализует честный
  // пустой профиль, но malformed непустой snapshot принимает fail-closed.
  if (rawSnapshot === undefined || rawSnapshot === null) {
    return {
      schemaVersion: 1,
      profile: null,
      compiledMarkdown: DEFAULT_USER_PROFILE_MARKDOWN,
    };
  }

  const snapshot = rawSnapshot && typeof rawSnapshot === "object" ? rawSnapshot : {};
  const compiledMarkdown = typeof snapshot.compiledMarkdown === "string"
    ? snapshot.compiledMarkdown
    : "";

  if (!compiledMarkdown || Buffer.byteLength(compiledMarkdown, "utf8") > 128 * 1024) {
    throw new Error("Trelio вернул некорректный снимок личного профиля.");
  }

  const profile = snapshot.profile
    && typeof snapshot.profile === "object"
    && UUID_PATTERN.test(String(snapshot.profile.revisionId || ""))
    && Number.isSafeInteger(snapshot.profile.version)
    && snapshot.profile.version > 0
      ? {
          revisionId: String(snapshot.profile.revisionId),
          version: snapshot.profile.version,
        }
      : null;

  return {
    schemaVersion: 1,
    profile,
    compiledMarkdown,
  };
};

const writeAgentInstructionsSnapshot = async (rootDirectory, rawSnapshot) => {
  const snapshot = normalizeAgentInstructionsSnapshot(rawSnapshot);
  const contextDirectory = path.join(rootDirectory, "context");
  const instructionsPath = path.join(contextDirectory, "agent-instructions.md");
  await ensureContextDirectoryChain(rootDirectory, path.join("context", "agent-instructions.md"));
  await fs.chmod(instructionsPath, 0o600).catch(() => undefined);
  await fs.writeFile(instructionsPath, snapshot.compiledMarkdown, { mode: 0o600 });

  if (process.platform !== "win32") {
    await fs.chmod(instructionsPath, 0o444);
  }

  return {
    path: instructionsPath,
    platform: snapshot.platform,
    company: snapshot.company,
    project: snapshot.project,
  };
};

const writeUserProfileSnapshot = async (rootDirectory, rawSnapshot) => {
  const snapshot = normalizeUserProfileSnapshot(rawSnapshot);
  const contextDirectory = path.join(rootDirectory, "context");
  const profilePath = path.join(contextDirectory, "user-profile.md");
  await ensureContextDirectoryChain(rootDirectory, path.join("context", "user-profile.md"));
  await fs.chmod(profilePath, 0o600).catch(() => undefined);
  await fs.writeFile(profilePath, snapshot.compiledMarkdown, { mode: 0o600 });

  if (process.platform !== "win32") {
    await fs.chmod(profilePath, 0o444);
  }

  return {
    path: profilePath,
    profile: snapshot.profile,
  };
};

const normalizeRunCheckpoint = (rawCheckpoint, runId) => {
  if (
    !rawCheckpoint
    || typeof rawCheckpoint !== "object"
    || rawCheckpoint.runId !== runId
    || !UUID_PATTERN.test(String(rawCheckpoint.id || ""))
  ) {
    return null;
  }

  const normalizeStringArray = (value) => (
    Array.isArray(value)
      ? value.filter((item) => typeof item === "string" && item.trim()).map((item) => item.trim())
      : []
  );

  return {
    schemaVersion: 1,
    checkpointId: String(rawCheckpoint.id),
    checkpointType: String(rawCheckpoint.checkpointType || "draft"),
    summary: String(rawCheckpoint.summary || "").trim(),
    evidence: Array.isArray(rawCheckpoint.evidenceJson) ? rawCheckpoint.evidenceJson : [],
    filesChanged: normalizeStringArray(rawCheckpoint.filesChangedJson),
    openQuestions: normalizeStringArray(rawCheckpoint.openQuestionsJson),
    nextAction:
      rawCheckpoint.nextActionJson
      && typeof rawCheckpoint.nextActionJson === "object"
      && typeof rawCheckpoint.nextActionJson.instruction === "string"
        ? { instruction: rawCheckpoint.nextActionJson.instruction.trim() }
        : null,
    draftHead: GIT_OBJECT_PATTERN.test(String(rawCheckpoint.candidateHead || ""))
      ? String(rawCheckpoint.candidateHead)
      : null,
    createdAt: typeof rawCheckpoint.createdAt === "string" ? rawCheckpoint.createdAt : null,
  };
};

const writeRunCheckpointSnapshot = async (rootDirectory, rawCheckpoint, runId) => {
  const checkpointPath = path.join(rootDirectory, "context", "run-checkpoint.json");
  const checkpoint = normalizeRunCheckpoint(rawCheckpoint, runId);
  await ensureContextDirectoryChain(rootDirectory, path.join("context", "run-checkpoint.json"));
  await fs.chmod(checkpointPath, 0o600).catch(() => undefined);

  if (!checkpoint) {
    await fs.rm(checkpointPath, { force: true });
    return null;
  }

  await fs.writeFile(
    checkpointPath,
    `${JSON.stringify(checkpoint, null, 2)}\n`,
    { mode: 0o600 },
  );

  if (process.platform !== "win32") {
    await fs.chmod(checkpointPath, 0o444);
  }

  return {
    path: checkpointPath,
    checkpointId: checkpoint.checkpointId,
    checkpointType: checkpoint.checkpointType,
    draftHead: checkpoint.draftHead,
  };
};

const findLatestRunCheckpoint = (overview, runId) => (
  Array.isArray(overview?.checkpoints)
    ? overview.checkpoints.find((checkpoint) => checkpoint?.runId === runId) ?? null
    : null
);

const writeContextIndex = async (
  rootDirectory,
  contexts,
  rawAgentInstructionsSnapshot,
  rawUserProfileSnapshot,
  rawRunCheckpoint,
  runId,
) => {
  const contextDirectory = path.join(rootDirectory, "context");
  const indexPath = path.join(contextDirectory, "index.json");
  const agentInstructions = await writeAgentInstructionsSnapshot(
    rootDirectory,
    rawAgentInstructionsSnapshot,
  );
  const userProfile = await writeUserProfileSnapshot(
    rootDirectory,
    rawUserProfileSnapshot,
  );
  const runCheckpoint = await writeRunCheckpointSnapshot(
    rootDirectory,
    rawRunCheckpoint,
    runId,
  );
  await ensureContextDirectoryChain(rootDirectory, path.join("context", "index.json"));
  await fs.chmod(indexPath, 0o600).catch(() => undefined);
  await fs.writeFile(indexPath, `${JSON.stringify({
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    agentInstructions,
    userProfile,
    runCheckpoint,
    contexts: serializeMaterializedContexts(contexts),
  }, null, 2)}\n`, { mode: 0o600 });

  if (process.platform !== "win32") {
    await fs.chmod(indexPath, 0o444);
  }
};

const readJsonResponse = async (response) => response.json();

export class BridgePluginUpgradeRequiredError extends Error {
  constructor(compatibility) {
    const minimumVersion = typeof compatibility?.minimumVersion === "string"
      ? compatibility.minimumVersion
      : "актуальная";

    super(
      `Версия Trelio Agent Workspaces v${BRIDGE_VERSION} больше не поддерживается; `
      + `требуется ${minimumVersion === "актуальная" ? minimumVersion : `v${minimumVersion}`}.`,
    );
    this.code = "AGENT_WORKSPACE_PLUGIN_UPGRADE_REQUIRED";
    this.compatibility = compatibility;
  }
}

export const ensureBridgeCompatibility = async (
  origin,
  token,
  { signal } = {},
) => {
  try {
    let cachedAgentRules = await readCachedAgentRules(origin);

    // Update считается завершённым только после отдельного ответа `current`.
    // Поэтому bridge не начинает start/claim сразу после записи новых bytes:
    // он повторно отправляет их SHA-256 backend-у. Три bounded попытки также
    // закрывают редкую гонку нескольких последовательных публикаций правил.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const compatibility = await readJsonResponse(await request(
        origin,
        token,
        "/api/agent-workspaces/bridge-compatibility",
        {
          signal,
          headers: cachedAgentRules
            ? { [AGENT_RULES_SHA256_HEADER]: cachedAgentRules.sha256 }
            : {},
        },
      ));

      if (compatibility?.supported !== true) {
        throw new BridgePluginUpgradeRequiredError(compatibility);
      }

      const activeAgentRules = await applyAgentRulesHandshake(
        origin,
        compatibility.agentRules,
        cachedAgentRules,
      );

      // Старый backend в коротком release-окне не возвращает agentRules.
      // Новый backend разрешает работу только после явного подтверждения hash.
      if (
        compatibility.agentRules === undefined
        || compatibility.agentRules === null
        || compatibility.agentRules.status === "current"
      ) {
        return {
          ...compatibility,
          agentRules: activeAgentRules,
        };
      }

      cachedAgentRules = activeAgentRules;
    }

    throw new Error(
      "Платформенные правила Trelio изменились несколько раз подряд и не были подтверждены.",
    );
  } catch (error) {
    if (error instanceof TrelioApiError && error.statusCode === 404) {
      // Плагин публикуется раньше backend hard gate. Короткое окно deploy
      // остаётся обратно совместимым: старый backend игнорирует version header,
      // а новый уже вернёт строгий compatibility payload.
      return null;
    }

    throw error;
  }
};

const TERMINAL_RUN_STATUSES = new Set(["accepted", "cancelled"]);

const readOptionalRunMetadata = async (rootDirectory) => {
  try {
    return JSON.parse(await fs.readFile(
      path.join(rootDirectory, ".trelio-run.json"),
      "utf8",
    ));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
};

const isProcessRunning = (pid) => {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;

  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but is owned by another account. Such a
    // lock must remain fail-closed; only ESRCH proves that its owner is gone.
    return error.code !== "ESRCH";
  }
};

const acquireWorkspaceOpenLock = async (workspaceId) => {
  await ensurePrivateDirectory(CONFIG_DIRECTORY);
  // Lock-и находятся вне видимого Workspace, но всё равно являются частью
  // trust boundary bridge. Проверяем owner/mode/type каталога, а не только
  // создаём его рекурсивно: существующий symlink здесь недопустим.
  await ensurePrivateDirectory(WORKSPACE_OPEN_LOCK_DIRECTORY);
  const lockPath = path.join(WORKSPACE_OPEN_LOCK_DIRECTORY, `${workspaceId}.lock`);
  const ownerToken = crypto.randomUUID();

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await fs.mkdir(lockPath, { mode: 0o700 });
      try {
        await fs.writeFile(
          path.join(lockPath, "owner.json"),
          `${JSON.stringify({
            schemaVersion: 1,
            workspaceId,
            pid: process.pid,
            ownerToken,
            startedAt: new Date().toISOString(),
          }, null, 2)}\n`,
          { mode: 0o600 },
        );
      } catch (error) {
        await fs.rm(lockPath, { recursive: true, force: true }).catch(() => undefined);
        throw error;
      }
      return { lockPath, ownerToken };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }

    let owner = null;
    let lockStat = null;

    try {
      [owner, lockStat] = await Promise.all([
        readPrivateJsonFile(path.join(lockPath, "owner.json")).catch((error) => {
          if (error.code === "ENOENT") return null;
          throw error;
        }),
        fs.lstat(lockPath),
      ]);
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }

    const validOwner = owner?.workspaceId === workspaceId
      && Number.isSafeInteger(Number(owner.pid));
    const liveOwner = validOwner && isProcessRunning(Number(owner.pid));
    const initializing = !validOwner && lockStat.isDirectory()
      && !lockStat.isSymbolicLink()
      && Date.now() - lockStat.mtimeMs < WORKSPACE_OPEN_LOCK_INITIALIZATION_STALE_MS;

    if (liveOwner || initializing) {
      const lockError = new Error(
        "Этот Agent Workspace уже открывается другим локальным процессом. Дождитесь завершения открытия и повторите команду.",
      );
      lockError.code = "TRELIO_WORKSPACE_OPEN_LOCKED";
      throw lockError;
    }

    // Удаляется только exact lock-directory мёртвого процесса или оборванной
    // инициализации. Содержимое Workspace находится в другом namespace.
    await fs.rm(lockPath, { recursive: true, force: true });
  }

  throw new Error("Не удалось получить локальную блокировку Agent Workspace.");
};

const releaseWorkspaceOpenLock = async ({ lockPath, ownerToken }) => {
  try {
    const owner = await readPrivateJsonFile(path.join(lockPath, "owner.json"));

    if (owner.ownerToken === ownerToken && owner.pid === process.pid) {
      await fs.rm(lockPath, { recursive: true, force: true });
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
};

const withWorkspaceOpenLock = async (workspaceId, handler) => {
  const lock = await acquireWorkspaceOpenLock(workspaceId);

  try {
    return await handler();
  } finally {
    await releaseWorkspaceOpenLock(lock);
  }
};

const resolveWorkspaceRootDirectory = async ({ workspaceId, runId, directoryOption }) => {
  if (directoryOption) return path.resolve(String(directoryOption));

  const persistentRoot = path.join(DEFAULT_WORKSPACES_DIRECTORY, workspaceId);

  if (!runId || await readOptionalRunMetadata(persistentRoot)) {
    return persistentRoot;
  }

  // До persistent-layout каждый Run жил в отдельном UUID-каталоге. Уже
  // начатый legacy Run продолжается на месте, чтобы ни один dirty draft не
  // пришлось копировать или молча бросать при обновлении bridge.
  const legacyRoot = path.join(persistentRoot, runId);
  const legacyMetadata = await readOptionalRunMetadata(legacyRoot);

  return legacyMetadata?.workspaceId === workspaceId && legacyMetadata?.runId === runId
    ? legacyRoot
    : persistentRoot;
};

const assertValidMaterializedRoot = async (
  rootDirectory,
  metadata,
  workspaceId,
  origin,
) => {
  if (
    metadata.workspaceId !== workspaceId
    || !UUID_PATTERN.test(String(metadata.runId || ""))
    || normalizeOrigin(metadata.origin || DEFAULT_ORIGIN) !== origin
    || path.resolve(String(metadata.workspaceDirectory || ""))
      !== path.join(rootDirectory, "workspace")
  ) {
    throw new Error("Локальный каталог принадлежит другому или повреждённому Trelio Workspace.");
  }

  const gitDirectoryStat = await fs.stat(path.join(rootDirectory, "workspace", ".git"));

  if (!gitDirectoryStat.isDirectory()) {
    throw new Error("Каталог Workspace повреждён: локальный Git workspace отсутствует.");
  }
};

const resolveRecordedMaterializedHead = (metadata) => [
  metadata.materializedHead,
  metadata.candidateHead,
  metadata.draftHead,
  metadata.baseHead,
].map((value) => String(value || "")).find((value) => GIT_OBJECT_PATTERN.test(value)) || null;

const preflightWorkspaceDirectory = async ({
  workspaceId,
  origin,
  requestedRunId,
  rootDirectory,
  directoryOption,
  overview,
}) => {
  let rootStat;

  try {
    rootStat = await fs.lstat(rootDirectory);
  } catch (error) {
    if (error.code === "ENOENT") {
      return { rootDirectoryExists: false, existingMetadata: null, legacyContainer: false };
    }
    throw error;
  }

  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error("Выбранный локальный root существует и не является безопасным каталогом.");
  }

  const existingMetadata = await readOptionalRunMetadata(rootDirectory);

  if (existingMetadata) {
    await assertValidMaterializedRoot(rootDirectory, existingMetadata, workspaceId, origin);
    if (
      existingMetadata.company?.id
      && overview?.company?.id
      && existingMetadata.company.id !== overview.company.id
    ) {
      throw new Error("Локальный Workspace принадлежит другой компании Trelio.");
    }
    const localRunState = overview?.runs?.find((run) => run.id === existingMetadata.runId);
    const continuingSameRun = requestedRunId === existingMetadata.runId;

    if (!continuingSameRun) {
      if (!localRunState || !TERMINAL_RUN_STATUSES.has(localRunState.status)) {
        throw new Error(
          "В локальной папке уже находится незавершённый Agent Run этого Workspace. Завершите или отмените его перед новым запуском.",
        );
      }

      const localHead = (await runGit(["rev-parse", "HEAD"], {
        cwd: existingMetadata.workspaceDirectory,
      })).stdout.trim();
      const recordedHead = resolveRecordedMaterializedHead(existingMetadata);
      const acceptedHead = String(overview?.workspace?.acceptedHead || "");

      if (!recordedHead || (localHead !== recordedHead && localHead !== acceptedHead)) {
        throw new Error(
          "Локальная Git-история расходится со служебным снимком предыдущего Run. Bridge не будет заменять даже clean committed changes.",
        );
      }

      if (await getGitStatus(
        existingMetadata.workspaceDirectory,
        existingMetadata.objects || [],
      )) {
        throw new Error(
          "Локальная папка содержит несохранённые изменения предыдущего Run. Bridge не будет перезаписывать их новым запуском.",
        );
      }
    }

    return { rootDirectoryExists: true, existingMetadata, legacyContainer: false };
  }

  const defaultPersistentRoot = path.join(DEFAULT_WORKSPACES_DIRECTORY, workspaceId);

  if (directoryOption || path.resolve(rootDirectory) !== path.resolve(defaultPersistentRoot)) {
    throw new Error("Выбранный --dir уже существует, но не принадлежит Trelio Workspace.");
  }

  // Старый layout оставлял под workspace-id только UUID-каталоги Run. Новый
  // persistent root может быть создан рядом с ними, но лишь после проверки
  // каждого legacy Run по серверу и локальному Git.
  const entries = await fs.readdir(rootDirectory, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory() || !UUID_PATTERN.test(entry.name)) {
      throw new Error(
        "Каталог Workspace содержит неизвестные файлы и не может быть автоматически переведён на persistent-layout.",
      );
    }

    const legacyRoot = path.join(rootDirectory, entry.name);
    const legacyMetadata = await readOptionalRunMetadata(legacyRoot);

    if (!legacyMetadata) {
      throw new Error("Legacy Run не содержит служебный metadata-файл; автоматическая миграция остановлена.");
    }
    await assertValidMaterializedRoot(legacyRoot, legacyMetadata, workspaceId, origin);
    if (
      legacyMetadata.company?.id
      && overview?.company?.id
      && legacyMetadata.company.id !== overview.company.id
    ) {
      throw new Error("Legacy Run принадлежит другой компании Trelio.");
    }
    const legacyRunState = overview?.runs?.find((run) => run.id === legacyMetadata.runId);

    if (!legacyRunState || !TERMINAL_RUN_STATUSES.has(legacyRunState.status)) {
      throw new Error(
        "В старой локальной структуре найден незавершённый Agent Run. Сначала продолжите или отмените его.",
      );
    }
    if (await getGitStatus(legacyMetadata.workspaceDirectory, legacyMetadata.objects || [])) {
      throw new Error(
        "В старой локальной структуре найден Run с несохранёнными изменениями. Автоматическая миграция запрещена.",
      );
    }
  }

  return { rootDirectoryExists: true, existingMetadata: null, legacyContainer: true };
};

const synchronizePersistentWorkspaceToAcceptedHead = async ({
  origin,
  token,
  workspaceId,
  acceptedHead,
  metadata,
  companyEncryption,
}) => {
  if (!GIT_OBJECT_PATTERN.test(String(acceptedHead || ""))) {
    throw new Error("Trelio не вернул корректную принятую ревизию Workspace.");
  }

  const workspaceDirectory = metadata.workspaceDirectory;
  const localHead = (await runGit(["rev-parse", "HEAD"], {
    cwd: workspaceDirectory,
  })).stdout.trim();

  if (localHead === acceptedHead) return false;

  if (localHead !== resolveRecordedMaterializedHead(metadata)) {
    throw new Error(
      "Локальная Git-история изменилась после preflight. Новый Run не создан; committed changes сохранены.",
    );
  }

  // Статус проверяется второй раз непосредственно перед заменой tracked tree:
  // пользователь мог изменить файл, пока bridge получал server overview.
  if (await getGitStatus(workspaceDirectory, metadata.objects || [])) {
    throw new Error(
      "Локальная папка изменилась во время сверки с сервером. Новый Run не создан; локальные файлы сохранены.",
    );
  }

  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "trelio-accepted-sync-"));
  const bundlePath = path.join(temporaryDirectory, "accepted.bundle");

  try {
    const endpoint = companyEncryption
      ? `/api/agent-workspaces/workspaces/${workspaceId}/encrypted-bundle`
      : `/api/agent-workspaces/workspaces/${workspaceId}/bundle`;
    const response = await request(
      origin,
      token,
      `${endpoint}?${new URLSearchParams({ head: acceptedHead }).toString()}`,
    );

    if (response.headers.get("x-trelio-accepted-head") !== acceptedHead) {
      throw new Error("Trelio вернул bundle другой принятой ревизии Workspace.");
    }
    if (companyEncryption) {
      await writeAndDecryptCompanyWorkspaceBundle({
        response,
        destination: bundlePath,
        companyEncryption,
      });
    } else {
      await writeResponseToFile(response, bundlePath);
    }

    // Между завершёнными Run история может законно расходиться: например,
    // отменённый draft не является предком нового accepted head. Замена
    // разрешена только после server-terminal + clean проверок выше.
    await fastForwardMaterializedBundle({
      bundlePath,
      workspaceDirectory,
      head: acceptedHead,
      knownObjects: metadata.objects || [],
      allowHistoryReplacement: true,
      expectedLocalHead: localHead,
    });
    return true;
  } finally {
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
  }
};

const openWorkspaceLocked = async (origin, options, workspaceId) => {
  const token = await requireToken(origin);
  let compatibility = await ensureBridgeCompatibility(origin, token);
  let activeAgentRules = compatibility?.agentRules ?? null;
  // Exact open-команду строит уже допущенный MCP-вызов. Новая схема передаёт
  // только server-side runtime-session id; legacy self-attestation остаётся на
  // один rolling-upgrade цикл и не используется новым hook.
  const runtimeSessionId = parseRuntimeSessionOption(options);
  const runtimeAttestation = parseSelfReportedRuntimeAttestationOptions(options);
  const requestedRunId = options.run ? requireUuid(options.run, "run") : null;
  const rootDirectory = await resolveWorkspaceRootDirectory({
    workspaceId,
    runId: requestedRunId,
    directoryOption: options.dir,
  });
  let rootDirectoryExists = false;

  try {
    const rootStat = await fs.lstat(rootDirectory);

    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
      throw new Error("Выбранный локальный root существует и не является безопасным каталогом.");
    }
    rootDirectoryExists = true;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  let runPayload;
  let runOverview = null;
  let companyEncryption = null;

  // Любой reuse существующего root сначала получает live server state. Без
  // этой сверки bridge не может доказать terminal status прежнего Run и не
  // имеет права ни перезаписывать файлы, ни создавать новый writable Run.
  if (requestedRunId || rootDirectoryExists) {
    const rawOverview = await readJsonResponse(await request(
      origin,
      token,
      `/api/agent-workspaces/workspaces/${workspaceId}`,
    ));
    if (
      !rawOverview.company
      || !UUID_PATTERN.test(String(rawOverview.company.id || ""))
      || typeof rawOverview.company.slug !== "string"
    ) {
      throw new Error("Trelio не вернул компанию Agent Workspace.");
    }
    // Продолжение существующего Run может содержать зашифрованные pinned
    // инструкции. Поэтому устройство и scope открываются до чтения snapshot и
    // до claim: в server request никогда не попадает ключ шифрования.
    companyEncryption = await ensureCompanyEncryptionContext({
      origin,
      token,
      company: rawOverview.company,
    });
    const overview = await hydrateAgentCompanyEncryptedJson({
      value: rawOverview,
      origin,
      token,
      companyEncryption,
    });
    runOverview = overview;
  }

  const directoryPreflight = await preflightWorkspaceDirectory({
    workspaceId,
    origin,
    requestedRunId,
    rootDirectory,
    directoryOption: options.dir,
    overview: runOverview,
  });

  if (!requestedRunId && directoryPreflight.existingMetadata) {
    const acceptedHead = runOverview?.workspace?.acceptedHead;
    await synchronizePersistentWorkspaceToAcceptedHead({
      origin,
      token,
      workspaceId,
      acceptedHead,
      metadata: directoryPreflight.existingMetadata,
      companyEncryption,
    });
    // Даже если последующий server start временно не состоится, локальная
    // сверка является активностью и metadata должна честно описывать уже
    // materialized accepted head, а не прежний terminal Run snapshot.
    await writeRunMetadata(path.join(rootDirectory, ".trelio-run.json"), {
      ...directoryPreflight.existingMetadata,
      materializedHead: acceptedHead,
      lastUsedAt: new Date().toISOString(),
    });
  }

  if (requestedRunId) {
    const existingRun = runOverview.runs.find((item) => item.id === requestedRunId);

    if (!existingRun) {
      throw new Error("Run не найден в указанном workspace или недоступен пользователю.");
    }
    const pinnedAgentRules = existingRun.agentInstructionsSnapshotJson?.platform;

    if (pinnedAgentRules) {
      // Claim продолжает exact immutable Run, поэтому его pinned revision
      // важнее более новой live revision, уже загруженной preflight-ом.
      activeAgentRules = await cacheAgentRules(origin, pinnedAgentRules);
    } else {
      activeAgentRules = null;
    }
    const claimedRun = await readJsonResponse(await request(
      origin,
      token,
      `/api/agent-workspaces/runs/${requestedRunId}/claim`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          expectedFencingToken: existingRun.fencingToken,
          clientKind: "workspace-bridge",
          clientVersion: BRIDGE_VERSION,
          ...(runtimeSessionId ? { runtimeSessionId } : {}),
          ...(runtimeAttestation ? { runtimeAttestation } : {}),
          ...(activeAgentRules
            ? { platformRulesSha256: activeAgentRules.sha256 }
            : {}),
        }),
      },
    ));
    runPayload = {
      run: claimedRun,
      workspace: runOverview.workspace,
      company: runOverview.company,
    };
  } else {
    // Если super-admin опубликовал новую revision между preflight и start,
    // backend отклонит старый hash до создания Run. Bridge перечитывает
    // правила и повторяет только безопасный идемпотентный start максимум дважды.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        runPayload = await readJsonResponse(await request(
          origin,
          token,
          `/api/agent-workspaces/workspaces/${workspaceId}/runs`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              clientKind: "workspace-bridge",
              clientVersion: BRIDGE_VERSION,
              ...(runtimeSessionId ? { runtimeSessionId } : {}),
              ...(runtimeAttestation ? { runtimeAttestation } : {}),
              ...(activeAgentRules
                ? { platformRulesSha256: activeAgentRules.sha256 }
                : {}),
            }),
          },
        ));
        break;
      } catch (error) {
        if (
          !(error instanceof TrelioApiError)
          || error.code !== "AGENT_WORKSPACE_RULES_CHANGED"
          || attempt === 2
        ) {
          throw error;
        }

        compatibility = await ensureBridgeCompatibility(origin, token);
        activeAgentRules = compatibility?.agentRules ?? null;
      }
    }
  }

  if (!runPayload) {
    throw new Error("Trelio не создал Agent Run после синхронизации правил.");
  }
  if (
    !runPayload.company
    || !UUID_PATTERN.test(String(runPayload.company.id || ""))
    || typeof runPayload.company.slug !== "string"
  ) {
    throw new Error("Trelio не вернул компанию Agent Workspace.");
  }
  // Encryption access is resolved before any bundle or context bytes are
  // downloaded. For a protected company this is the fail-closed boundary:
  // the bridge either opens the exact local device envelope or materializes
  // nothing at all.
  companyEncryption ??= await ensureCompanyEncryptionContext({
    origin,
    token,
    company: runPayload.company,
  });
  // Все marker-ы раскрываются в памяти bridge до первого обращения к полям
  // Run. На диск затем попадает только локальная рабочая копия пользователя;
  // backend продолжает видеть лишь opaque ciphertext.
  runPayload = await hydrateAgentCompanyEncryptedJson({
    value: runPayload,
    origin,
    token,
    companyEncryption,
  });
  const agentRun = runPayload.run;
  const pinnedRunAgentRules = agentRun.agentInstructionsSnapshotJson?.platform;

  if (pinnedRunAgentRules) {
    activeAgentRules = await cacheAgentRules(origin, pinnedRunAgentRules);
  }
  const runId = requireUuid(agentRun.id, "run");
  const materializedHead = GIT_OBJECT_PATTERN.test(String(agentRun.draftHead || ""))
    ? String(agentRun.draftHead)
    : String(agentRun.baseHead);
  const latestRunCheckpoint = findLatestRunCheckpoint(runOverview, runId);
  const workspaceDirectory = path.join(rootDirectory, "workspace");
  const metadataPath = path.join(rootDirectory, ".trelio-run.json");

  const existingMetadata = await readOptionalRunMetadata(rootDirectory);

  if (existingMetadata) {
    await assertValidMaterializedRoot(rootDirectory, existingMetadata, workspaceId, origin);
    const continuingSameRun = existingMetadata.runId === runId;
    const localHead = (await runGit(["rev-parse", "HEAD"], {
      cwd: workspaceDirectory,
    })).stdout.trim();

    if (localHead !== materializedHead) {
      const syncDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "trelio-draft-sync-"));
      const syncBundlePath = path.join(syncDirectory, "run.bundle");

      try {
        const bundleResponse = await request(
          origin,
          token,
          `/api/agent-workspaces/runs/${runId}/${companyEncryption ? "encrypted-bundle" : "bundle"}`,
        );
        if (companyEncryption) {
          await writeAndDecryptCompanyWorkspaceBundle({
            response: bundleResponse,
            destination: syncBundlePath,
            companyEncryption,
          });
        } else {
          await writeResponseToFile(bundleResponse, syncBundlePath);
        }
        await fastForwardMaterializedBundle({
          bundlePath: syncBundlePath,
          workspaceDirectory,
          head: materializedHead,
          knownObjects: existingMetadata.objects || [],
          // Новый Run переиспользует clean папку завершённого Run. Его base
          // уже server-pinned, поэтому здесь допустима смена ветви истории;
          // продолжение того же Run по-прежнему допускает лишь fast-forward.
          allowHistoryReplacement: !continuingSameRun,
          expectedLocalHead: localHead,
        });
      } finally {
        await fs.rm(syncDirectory, { recursive: true, force: true });
      }
    }
    await materializeRuntimeControlFiles(workspaceDirectory);
    const now = new Date().toISOString();
    // Claim всегда ротирует lease/fencing pair, а новый Run меняет всю
    // server-pinned identity. Metadata публикуется до context sync, чтобы
    // повторный open продолжал уже exact новый Run после сетевого сбоя.
    const refreshedMetadata = {
      ...existingMetadata,
      schemaVersion: 3,
      origin,
      pluginVersion: BRIDGE_VERSION,
      scopeType: runPayload.workspace?.scopeType || existingMetadata.scopeType || null,
      company: runPayload.company,
      encryption: companyEncryption?.metadata ?? { enabled: false },
      workspaceId,
      runId,
      leaseId: agentRun.leaseId,
      fencingToken: agentRun.fencingToken,
      baseHead: agentRun.baseHead,
      draftHead: agentRun.draftHead || null,
      materializedHead,
      workspaceDirectory,
      contextHeads: agentRun.contextHeadsJson || {},
      agentInstructionsSnapshot: agentRun.agentInstructionsSnapshotJson,
      userProfileSnapshot: agentRun.userProfileSnapshotJson,
      runtimePolicySnapshot: agentRun.runtimePolicySnapshotJson,
      runtimeAttestation: agentRun.runtimeAttestationJson,
      contexts: [],
      contextObjects: [],
      terminalStatus: undefined,
      terminalAt: undefined,
      cleanupEligibleAfterDays: undefined,
      claimedAt: now,
      lastUsedAt: now,
    };
    await writeRunMetadata(metadataPath, refreshedMetadata);
    const contexts = await materializeRunContexts({
      origin,
      token,
      rootDirectory,
      runId,
      contextHeads: refreshedMetadata.contextHeads,
      companyEncryption,
    });
    const objects = await materializeWorkspaceObjects({
      origin,
      token,
      runId,
      workspaceDirectory,
      knownObjects: existingMetadata.objects || [],
    });
    await writeContextIndex(
      rootDirectory,
      contexts,
      agentRun.agentInstructionsSnapshotJson,
      agentRun.userProfileSnapshotJson,
      latestRunCheckpoint,
      runId,
    );
    await writeRunMetadata(metadataPath, {
      ...refreshedMetadata,
      contexts: serializeMaterializedContexts(contexts),
      objects,
      lastUsedAt: new Date().toISOString(),
    });
    await registerRunRoot(rootDirectory);
    process.stdout.write(`${workspaceDirectory}\n`);
    return;
  }

  if (rootDirectoryExists && !directoryPreflight.legacyContainer) {
    throw new Error("Локальный root существует, но не прошёл persistent Workspace preflight.");
  }

  if (!rootDirectoryExists) {
    await fs.mkdir(rootDirectory, { recursive: true, mode: 0o700 });
  }
  let ownsRootDirectory = !rootDirectoryExists;
  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "trelio-workspace-"));

  try {
    const baseBundlePath = path.join(temporaryDirectory, "base.bundle");
    const baseResponse = await request(
      origin,
      token,
      `/api/agent-workspaces/runs/${runId}/${companyEncryption ? "encrypted-bundle" : "bundle"}`,
    );
    if (companyEncryption) {
      await writeAndDecryptCompanyWorkspaceBundle({
        response: baseResponse,
        destination: baseBundlePath,
        companyEncryption,
      });
    } else {
      await writeResponseToFile(baseResponse, baseBundlePath);
    }
    await materializeBundle({
      bundlePath: baseBundlePath,
      directory: workspaceDirectory,
      head: materializedHead,
      branch: "trelio-candidate",
    });
    await materializeRuntimeControlFiles(workspaceDirectory);
    const objects = await materializeWorkspaceObjects({
      origin,
      token,
      runId,
      workspaceDirectory,
    });

    const contextHeads = agentRun.contextHeadsJson || {};
    const contexts = await materializeRunContexts({
      origin,
      token,
      rootDirectory,
      runId,
      contextHeads,
      companyEncryption,
    });
    await writeContextIndex(
      rootDirectory,
      contexts,
      agentRun.agentInstructionsSnapshotJson,
      agentRun.userProfileSnapshotJson,
      latestRunCheckpoint,
      runId,
    );

    const now = new Date().toISOString();
    const metadata = {
      schemaVersion: 3,
      origin,
      pluginVersion: BRIDGE_VERSION,
      scopeType: runPayload.workspace?.scopeType || null,
      company: runPayload.company,
      encryption: companyEncryption?.metadata ?? { enabled: false },
      workspaceId,
      runId,
      leaseId: agentRun.leaseId,
      fencingToken: agentRun.fencingToken,
      baseHead: agentRun.baseHead,
      draftHead: agentRun.draftHead || null,
      materializedHead,
      workspaceDirectory,
      contextHeads,
      agentInstructionsSnapshot: agentRun.agentInstructionsSnapshotJson,
      userProfileSnapshot: agentRun.userProfileSnapshotJson,
      runtimePolicySnapshot: agentRun.runtimePolicySnapshotJson,
      runtimeAttestation: agentRun.runtimeAttestationJson,
      contexts: serializeMaterializedContexts(contexts),
      objects,
      createdAt: now,
      claimedAt: now,
      lastUsedAt: now,
    };
    await writeRunMetadata(metadataPath, metadata);
    await registerRunRoot(rootDirectory);
    process.stdout.write(`${workspaceDirectory}\n`);
  } catch (error) {
    // Не оставляем полуматериализованный Run: следующий open должен либо найти
    // полностью готовый metadata, либо начать в чистом каталоге. Для нового
    // root удаляется exact каталог; в legacy-container удаляются только три
    // новых пути persistent-layout, а старые UUID-каталоги не затрагиваются.
    if (ownsRootDirectory) {
      await fs.rm(rootDirectory, { recursive: true, force: true });
      ownsRootDirectory = false;
    } else if (directoryPreflight.legacyContainer) {
      await Promise.all([
        makeWritable(workspaceDirectory).catch(() => undefined),
        makeWritable(path.join(rootDirectory, "context")).catch(() => undefined),
      ]);
      await Promise.all([
        fs.rm(workspaceDirectory, { recursive: true, force: true }),
        fs.rm(path.join(rootDirectory, "context"), { recursive: true, force: true }),
        fs.rm(metadataPath, { force: true }),
      ]);
    }
    throw error;
  } finally {
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
  }
};

const openWorkspace = async (origin, options) => {
  const workspaceId = requireUuid(options.workspace, "workspace");

  await withWorkspaceOpenLock(
    workspaceId,
    () => openWorkspaceLocked(origin, options, workspaceId),
  );

  // Автоочистка запускается только после публикации metadata нового/claimed
  // Run. Поэтому текущий persistent root уже non-terminal и не может попасть
  // в кандидаты, даже если перед open он был старше retention-порога.
  const token = await requireToken(origin);
  await cleanLocalRuns({
    origin,
    token,
    dryRun: false,
    automatic: true,
  }).catch(() => undefined);
};

const validateWorkspaceReadSnapshot = (rawSnapshot, workspaceId) => {
  const acceptedHead = String(rawSnapshot?.workspace?.acceptedHead || "");
  const company = rawSnapshot?.company;

  if (
    rawSnapshot?.schemaVersion !== 1
    || rawSnapshot.workspace?.id !== workspaceId
    || !GIT_OBJECT_PATTERN.test(acceptedHead)
    || !UUID_PATTERN.test(String(company?.id || ""))
    || typeof company?.slug !== "string"
    || !company.slug
    || typeof company?.name !== "string"
    || !rawSnapshot.agentInstructionsSnapshot
  ) {
    throw new Error("Trelio вернул некорректный read-only snapshot Agent Workspace.");
  }

  return { acceptedHead, company };
};

const writeWorkspaceInspectionContext = async ({
  rootDirectory,
  publishedRootDirectory,
  workspace,
  company,
  acceptedHead,
  agentInstructionsSnapshot,
  userProfileSnapshot,
}) => {
  const agentInstructions = await writeAgentInstructionsSnapshot(
    rootDirectory,
    agentInstructionsSnapshot,
  );
  const userProfile = await writeUserProfileSnapshot(
    rootDirectory,
    userProfileSnapshot,
  );
  const contextDirectory = path.join(rootDirectory, "context");
  const indexPath = path.join(contextDirectory, "index.json");
  await fs.writeFile(indexPath, `${JSON.stringify({
    schemaVersion: 1,
    mode: "read_only_accepted_workspace",
    generatedAt: new Date().toISOString(),
    workspace: {
      id: workspace.id,
      scopeType: workspace.scopeType,
      scopeKey: workspace.scopeKey,
      acceptedHead,
    },
    company,
    agentInstructions: {
      ...agentInstructions,
      path: path.join(publishedRootDirectory, "context", "agent-instructions.md"),
    },
    userProfile: {
      ...userProfile,
      path: path.join(publishedRootDirectory, "context", "user-profile.md"),
    },
  }, null, 2)}\n`, { mode: 0o600 });

  if (process.platform !== "win32") {
    await fs.chmod(indexPath, 0o444);
  }
  await makeReadOnly(contextDirectory);
  if (process.platform !== "win32") {
    await fs.chmod(contextDirectory, 0o555);
  }
};

const removePreviousWorkspaceInspection = async (rootDirectory, workspaceId) => {
  try {
    const rootStat = await fs.lstat(rootDirectory);

    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
      throw new Error(`Read-only Workspace path имеет небезопасный тип: ${rootDirectory}`);
    }
    const metadata = await readPrivateJsonFile(
      path.join(rootDirectory, ".trelio-inspection.json"),
    );
    if (
      metadata.schemaVersion !== 1
      || metadata.mode !== "read_only_accepted_workspace"
      || metadata.workspaceId !== workspaceId
      || path.resolve(String(metadata.workspaceDirectory || ""))
        !== path.join(path.resolve(rootDirectory), "workspace")
    ) {
      throw new Error(
        `Существующий каталог не принадлежит read-only Workspace ${workspaceId}: ${rootDirectory}`,
      );
    }

    // Only an exact bridge-owned root with matching private metadata can be
    // replaced. This avoids following or deleting a user-created directory
    // that happens to use the same workspace UUID.
    await makeWritable(rootDirectory);
    await fs.rm(rootDirectory, { recursive: true, force: true });
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
};

const materializeWorkspaceInspection = async ({
  origin,
  token,
  workspaceId,
  rawSnapshot,
  companyEncryption,
}) => {
  const { acceptedHead } = validateWorkspaceReadSnapshot(rawSnapshot, workspaceId);
  const snapshot = await hydrateAgentCompanyEncryptedJson({
    value: rawSnapshot,
    origin,
    token,
    companyEncryption,
  });
  validateWorkspaceReadSnapshot(snapshot, workspaceId);
  await ensurePrivateDirectory(WORKSPACE_INSPECTION_DIRECTORY);
  const targetRoot = path.join(WORKSPACE_INSPECTION_DIRECTORY, workspaceId);
  const stagingRoot = await fs.mkdtemp(path.join(
    WORKSPACE_INSPECTION_DIRECTORY,
    `.${workspaceId}.staging-`,
  ));
  const temporaryDirectory = await fs.mkdtemp(path.join(
    os.tmpdir(),
    "trelio-workspace-inspection-",
  ));
  const workspaceDirectory = path.join(stagingRoot, "workspace");
  const bundlePath = path.join(temporaryDirectory, "accepted.bundle");
  let published = false;

  try {
    const endpoint = companyEncryption
      ? `/api/agent-workspaces/workspaces/${workspaceId}/encrypted-bundle`
      : `/api/agent-workspaces/workspaces/${workspaceId}/bundle`;
    const response = await request(
      origin,
      token,
      `${endpoint}?${new URLSearchParams({ head: acceptedHead }).toString()}`,
    );
    if (response.headers.get("x-trelio-accepted-head") !== acceptedHead) {
      throw new Error("Trelio вернул read-only bundle другой принятой ревизии.");
    }
    if (companyEncryption) {
      await writeAndDecryptCompanyWorkspaceBundle({
        response,
        destination: bundlePath,
        companyEncryption,
      });
    } else {
      await writeResponseToFile(response, bundlePath);
    }
    await materializeBundle({
      bundlePath,
      directory: workspaceDirectory,
      head: acceptedHead,
      branch: "trelio-readonly",
    });
    await assertMaterializedWorkspaceFileTypes(workspaceDirectory);
    // chmod-based protection must not appear as content changes when accepted
    // files carry executable bits. The snapshot has no Run metadata or submit
    // route, and this config adds a second local guard on POSIX.
    await runGit(["config", "core.fileMode", "false"], { cwd: workspaceDirectory });
    await makeReadOnly(workspaceDirectory);
    if (process.platform !== "win32") {
      await fs.chmod(workspaceDirectory, 0o555);
    }
    await writeWorkspaceInspectionContext({
      rootDirectory: stagingRoot,
      publishedRootDirectory: targetRoot,
      workspace: snapshot.workspace,
      company: snapshot.company,
      acceptedHead,
      agentInstructionsSnapshot: snapshot.agentInstructionsSnapshot,
      userProfileSnapshot: snapshot.userProfileSnapshot,
    });
    await writePrivateJsonFile(path.join(stagingRoot, ".trelio-inspection.json"), {
      schemaVersion: 1,
      mode: "read_only_accepted_workspace",
      origin,
      pluginVersion: BRIDGE_VERSION,
      workspaceId,
      acceptedHead,
      company: snapshot.company,
      encryption: companyEncryption?.metadata ?? { enabled: false },
      workspaceDirectory: path.join(targetRoot, "workspace"),
      createdAt: new Date().toISOString(),
    });
    await removePreviousWorkspaceInspection(targetRoot, workspaceId);
    await fs.rename(stagingRoot, targetRoot);
    published = true;
    return path.join(targetRoot, "workspace");
  } finally {
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
    if (!published) {
      await makeWritable(stagingRoot).catch(() => undefined);
      await fs.rm(stagingRoot, { recursive: true, force: true }).catch(() => undefined);
    }
  }
};

const inspectWorkspace = async (origin, options) => {
  const workspaceId = requireUuid(options.workspace, "workspace");
  const token = await requireToken(origin);
  await ensureBridgeCompatibility(origin, token);

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const rawSnapshot = await readJsonResponse(await request(
        origin,
        token,
        `/api/agent-workspaces/workspaces/${workspaceId}/read-snapshot`,
      ));
      const { company } = validateWorkspaceReadSnapshot(rawSnapshot, workspaceId);
      const companyEncryption = await ensureCompanyEncryptionContext({
        origin,
        token,
        company,
      });
      const workspaceDirectory = await materializeWorkspaceInspection({
        origin,
        token,
        workspaceId,
        rawSnapshot,
        companyEncryption,
      });
      process.stdout.write(`${workspaceDirectory}\n`);
      return;
    } catch (error) {
      // The accepted head may legitimately advance between the read-snapshot
      // response and the pinned bundle download. Both operations are read-only,
      // so rebuilding from the new exact head is safe and avoids stale context.
      if (
        !(error instanceof TrelioApiError)
        || error.code !== "WORKSPACE_OUTDATED"
        || attempt === 2
      ) {
        throw error;
      }
    }
  }
};

const findRunMetadata = async (startDirectory = process.cwd()) => {
  let current = path.resolve(startDirectory);

  while (true) {
    for (const candidate of [
      path.join(current, ".trelio-run.json"),
      path.join(current, "..", ".trelio-run.json"),
    ]) {
      try {
        const metadata = JSON.parse(await fs.readFile(candidate, "utf8"));
        return { metadata, metadataPath: path.resolve(candidate) };
      } catch (error) {
        if (error.code !== "ENOENT") {
          throw error;
        }
      }
    }

    const parent = path.dirname(current);

    if (parent === current) {
      throw new Error("Текущий каталог не находится внутри материализованного Trelio Run.");
    }
    current = parent;
  }
};

const withRun = async (handler) => {
  const { metadata, metadataPath } = await findRunMetadata();
  const origin = normalizeOrigin(metadata.origin);
  const token = await requireToken(origin);
  const company = metadata.company;
  const companyEncryption = company?.slug
    ? await ensureCompanyEncryptionContext({ origin, token, company })
    : null;
  const activeMetadata = {
    ...metadata,
    lastUsedAt: new Date().toISOString(),
  };
  // Любая явная команда внутри папки считается локальной активностью. Это
  // отделяет 30-дневный retention Workspace от давности terminal status Run.
  await writeRunMetadata(metadataPath, activeMetadata);
  return handler({
    metadata: activeMetadata,
    metadataPath,
    origin,
    token,
    companyEncryption,
  });
};

const heartbeat = async () => withRun(async ({ metadata, origin, token }) => {
  const response = await request(origin, token, `/api/agent-workspaces/runs/${metadata.runId}/heartbeat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ leaseId: metadata.leaseId, fencingToken: metadata.fencingToken }),
  });
  const runPayload = await response.json();
  process.stdout.write(`Lease продлён до ${runPayload.leaseExpiresAt}.\n`);
});

const synchronizeRunContext = async ({
  metadata,
  metadataPath,
  origin,
  token,
  companyEncryption,
}) => {
  const rawOverview = await readJsonResponse(await request(
    origin,
    token,
    `/api/agent-workspaces/workspaces/${requireUuid(metadata.workspaceId, "workspace")}`,
  ));
  const overview = await hydrateAgentCompanyEncryptedJson({
    value: rawOverview,
    origin,
    token,
    companyEncryption,
  });
  const agentRun = overview.runs.find((item) => item.id === metadata.runId);

  if (!agentRun) {
    throw new Error("Agent Run не найден или больше недоступен пользователю.");
  }

  const rootDirectory = path.dirname(metadataPath);
  const contextHeads = agentRun.contextHeadsJson || {};
  const contexts = await materializeRunContexts({
    origin,
    token,
    rootDirectory,
    runId: metadata.runId,
    contextHeads,
    companyEncryption,
  });
  await writeContextIndex(
    rootDirectory,
    contexts,
    agentRun.agentInstructionsSnapshotJson,
    agentRun.userProfileSnapshotJson,
    findLatestRunCheckpoint(overview, metadata.runId),
    metadata.runId,
  );
  await writeRunMetadata(metadataPath, {
    ...metadata,
    schemaVersion: 3,
    contextHeads,
    agentInstructionsSnapshot: agentRun.agentInstructionsSnapshotJson,
    userProfileSnapshot: agentRun.userProfileSnapshotJson,
    draftHead: agentRun.draftHead || null,
    contexts: serializeMaterializedContexts(contexts),
    contextSyncedAt: new Date().toISOString(),
  });
  const changedCount = contexts.filter((context) => context.changed).length;
  process.stdout.write(`Контекст синхронизирован: ${contexts.length}, обновлено: ${changedCount}.\n`);
  process.stdout.write(`${path.join(rootDirectory, "context", "index.json")}\n`);
};

const fetchRunContextObject = async (
  { metadata, metadataPath, origin, token },
  rawPath,
) => {
  const requestedPath = String(rawPath || "").trim();

  if (!requestedPath) {
    throw new Error("Для `context fetch` укажите --path.");
  }

  const rootDirectory = path.dirname(metadataPath);
  const absolutePath = path.isAbsolute(requestedPath)
    ? path.resolve(requestedPath)
    : requestedPath === "context" || requestedPath.startsWith(`context${path.sep}`)
      ? path.resolve(rootDirectory, requestedPath)
      : path.resolve(process.cwd(), requestedPath);
  const contexts = Array.isArray(metadata.contexts) ? metadata.contexts : [];
  const context = contexts.find((candidate) => {
    const directory = path.resolve(String(candidate?.directory || ""));
    return absolutePath.startsWith(`${directory}${path.sep}`);
  });

  if (!context) {
    throw new Error("Путь не принадлежит pinned read-only context текущего Agent Run.");
  }

  const contextDirectory = path.resolve(context.directory);
  const relativePath = path.relative(contextDirectory, absolutePath).split(path.sep).join("/");

  if (
    !relativePath
    || relativePath.startsWith("../")
    || relativePath.includes("/../")
    || relativePath.includes("\\")
  ) {
    throw new Error("Некорректный путь файла read-only context.");
  }

  const fileStat = await fs.lstat(absolutePath);

  if (!fileStat.isFile() || fileStat.isSymbolicLink() || fileStat.size > POINTER_MAX_BYTES) {
    throw new Error("Выбранный файл не является workspace-object pointer.");
  }

  const pointerBytes = await fs.readFile(absolutePath);
  const pointer = parseWorkspaceObjectPointer(pointerBytes);

  if (!pointer) {
    // Повторный fetch уже материализованного файла не должен заменять его
    // неожиданно: агент получает явный и понятный результат.
    throw new Error("Выбранный файл уже материализован или не содержит корректный workspace-object pointer.");
  }

  const query = new URLSearchParams({
    head: String(context.head || ""),
    path: relativePath,
    sha256: pointer.sha256,
    sizeBytes: String(pointer.sizeBytes),
  });
  const authorization = await readJsonResponse(await request(
    origin,
    token,
    `/api/agent-workspaces/runs/${requireUuid(metadata.runId, "run")}/context-objects/${requireUuid(context.workspaceId, "workspace")}?${query.toString()}`,
  ));

  if (
    authorization.workspaceId !== context.workspaceId
    || authorization.workspaceHead !== context.head
    || authorization.filePath !== relativePath
    || authorization.sha256 !== pointer.sha256
    || authorization.sizeBytes !== pointer.sizeBytes
  ) {
    throw new Error("Trelio вернул несовпадающее разрешение на context object.");
  }

  const cached = await ensureCachedWorkspaceObject({
    pointer,
    fetchResponse: async () => {
      const response = await fetch(new URL(authorization.url, `${origin}/`));

      if (!response.ok) {
        throw new TrelioApiError(response.status, await response.text());
      }

      return response;
    },
  });
  const parentDirectory = path.dirname(absolutePath);

  if (process.platform !== "win32") {
    await fs.chmod(parentDirectory, 0o755);
    await fs.chmod(absolutePath, 0o644);
  }

  try {
    // Защищаемся от локальной подмены между authorization и публикацией bytes.
    const currentPointer = parseWorkspaceObjectPointer(await fs.readFile(absolutePath));

    if (
      !currentPointer
      || currentPointer.sha256 !== pointer.sha256
      || currentPointer.sizeBytes !== pointer.sizeBytes
      || currentPointer.contentType !== pointer.contentType
    ) {
      throw new Error("Workspace-object pointer изменился во время materialization.");
    }

    await copyCachedObjectToDestination(cached.cachePath, absolutePath, pointer);
  } finally {
    if (process.platform !== "win32") {
      await fs.chmod(absolutePath, 0o444).catch(() => undefined);
      await fs.chmod(parentDirectory, 0o555).catch(() => undefined);
    }
  }

  const contextObjects = [
    ...(Array.isArray(metadata.contextObjects) ? metadata.contextObjects : [])
      .filter((item) => !(
        item.workspaceId === context.workspaceId
        && item.workspaceHead === context.head
        && item.filePath === relativePath
      )),
    {
      workspaceId: context.workspaceId,
      workspaceHead: context.head,
      filePath: relativePath,
      sha256: pointer.sha256,
      sizeBytes: pointer.sizeBytes,
      materializedAt: new Date().toISOString(),
    },
  ];
  await writeRunMetadata(metadataPath, {
    ...metadata,
    schemaVersion: 3,
    contextObjects,
  });
  process.stdout.write(`${absolutePath}\n`);
  process.stdout.write(cached.cacheHit ? "Источник: локальный cache.\n" : "Источник: Trelio object storage.\n");
};

const contextCommand = async (options, positional) => withRun(async (runContext) => {
  if (positional[0] === "sync") {
    await synchronizeRunContext(runContext);
    return;
  }

  if (positional[0] === "fetch") {
    await fetchRunContextObject(runContext, options.path);
    return;
  }

  if (positional[0] === "attach") {
    const relatedWorkspaceId = requireUuid(options.workspace, "workspace");
    await readJsonResponse(await request(
      runContext.origin,
      runContext.token,
      `/api/agent-workspaces/runs/${runContext.metadata.runId}/context/related`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          relatedWorkspaceId,
          leaseId: runContext.metadata.leaseId,
          fencingToken: runContext.metadata.fencingToken,
        }),
      },
    ));
    await synchronizeRunContext(runContext);
    return;
  }

  throw new Error("Поддерживаются `trelio-workspace context sync` и `trelio-workspace context attach --workspace UUID`.");
});

const getOptionValues = (options, key) => {
  const rawValue = options[key];
  const values = Array.isArray(rawValue) ? rawValue : rawValue === undefined ? [] : [rawValue];
  return values
    .map((value) => String(value).trim())
    .filter(Boolean);
};

const getChangedPaths = async (workspaceDirectory, knownObjects = []) => {
  const gitStatus = await getGitStatus(workspaceDirectory, knownObjects);

  if (!gitStatus) {
    return [];
  }

  // `git status --short` начинает строку двухсимвольным статусом и пробелом.
  // Для rename человеку полезен итоговый путь справа от ` -> `.
  return gitStatus
    .split("\n")
    .map((line) => line.slice(3).trim())
    .map((changedPath) => changedPath.split(" -> ").at(-1)?.trim() || changedPath)
    .filter(Boolean);
};

const getCandidateChangedPaths = async (metadata) => {
  const [committedResult, localPaths] = await Promise.all([
    runGit(
      ["diff", "--name-only", "-z", metadata.baseHead, "HEAD", "--"],
      { cwd: metadata.workspaceDirectory },
    ),
    getChangedPaths(metadata.workspaceDirectory, metadata.objects || []),
  ]);
  const committedPaths = committedResult.stdout
    .split("\0")
    .filter((filePath) => filePath.length > 0);

  // Draft checkpoint коммитит и загружает завершённую дельту, поэтому чистый
  // git status после checkpoint не означает пустой Run. Для handoff/finish
  // объединяем net-diff уже сохранённого candidate относительно pinned base с
  // новыми локальными правками. Set сохраняет порядок и не дублирует путь,
  // который менялся и до, и после последнего checkpoint.
  return [...new Set([...committedPaths, ...localPaths])];
};

const TASK_OUTCOMES = new Set([
  "work_completed",
  "review_passed",
  "direct_completion",
  "no_status_change",
]);

export const validateHandoffTaskOutcome = ({
  scopeType,
  checkpointType,
  taskOutcome,
  openQuestions,
}) => {
  if (checkpointType !== "handoff") {
    if (taskOutcome) {
      throw new Error("--task-outcome допустим только для checkpoint типа handoff.");
    }
    return;
  }

  if (scopeType === "task" && !taskOutcome) {
    throw new Error(
      "Для handoff задачи обязательно укажите --task-outcome: "
      + "work_completed, review_passed, direct_completion или no_status_change.",
    );
  }

  if (taskOutcome && !TASK_OUTCOMES.has(taskOutcome)) {
    throw new Error("Неизвестный --task-outcome.");
  }

  // Открытый вопрос означает, что результат ещё требует решения. Такой
  // checkpoint можно надёжно сохранить и принять, но нельзя одновременно
  // объявлять выполнением работы или успешной проверкой.
  if (taskOutcome && taskOutcome !== "no_status_change" && openQuestions.length > 0) {
    throw new Error(
      "Handoff с незакрытыми вопросами не может завершать работу или проверку задачи; "
      + "используйте --task-outcome no_status_change.",
    );
  }
};

const buildAgentEncryptedPayloadSignatureRecord = (payload) => ({
  suite: payload.suite,
  scopeId: payload.scopeId,
  scopeEpoch: payload.scopeEpoch,
  entityType: payload.entityType,
  entityId: payload.entityId,
  entityRevision: payload.entityRevision,
  schemaVersion: payload.schemaVersion,
  nonce: payload.nonce,
  ciphertext: payload.ciphertext,
  wrappedDataKey: payload.wrappedDataKey,
  aad: payload.aad,
  ciphertextSha256: payload.ciphertextSha256,
  writerDeviceId: payload.writerDeviceId,
});

const protectAgentWorkspaceCheckpoint = async ({
  metadata,
  origin,
  token,
  companyEncryption,
  summary,
  evidence,
  filesChanged,
  openQuestions,
  nextActionInstruction,
  taskOutcome,
}) => {
  const entityId = crypto.randomUUID();
  const values = {
    summary,
    evidence_json: evidence,
    files_changed_json: filesChanged,
    open_questions_json: openQuestions,
    next_action_instruction: nextActionInstruction,
  };
  const encrypted = await encryptCompanyPayload({
    payload: {
      suite: COMPANY_ENCRYPTION_SUITE,
      version: 1,
      source: { kind: "agent_workspace_checkpoint", runId: metadata.runId },
      values,
    },
    scopePublicEncryptionJwk: companyEncryption.runtime.scope.publicEncryptionJwk,
    aad: {
      companyId: companyEncryption.runtime.company.id,
      scopeId: companyEncryption.runtime.scope.id,
      scopeEpoch: companyEncryption.runtime.scope.epoch,
      entityType: "agent_workspace.checkpoint",
      entityId,
      entityRevision: 1,
      purpose: "content",
    },
  });
  const payload = {
    ...encrypted,
    scopeId: companyEncryption.runtime.scope.id,
    scopeEpoch: companyEncryption.runtime.scope.epoch,
    entityType: "agent_workspace.checkpoint",
    entityId,
    entityRevision: 1,
    writerDeviceId: companyEncryption.runtime.device.id,
  };
  payload.signature = await signCompanyEncryptionRecord(
    companyEncryption.device.privateKeys.signingPrivateKey,
    buildAgentEncryptedPayloadSignatureRecord(payload),
  );
  await readJsonResponse(await request(
    origin,
    token,
    "/api/agent-workspaces/encryption/payloads",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        companySlug: companyEncryption.runtime.company.slug,
        writerDeviceId: companyEncryption.runtime.device.id,
        payloads: [payload],
      }),
    },
  ));

  return {
    summary: buildCompanyEncryptedTextMarker(entityId, "summary"),
    ...(evidence.length > 0
      ? { evidence: buildCompanyEncryptedJsonMarker(entityId, "evidence_json", "array") }
      : {}),
    ...(filesChanged.length > 0
      ? { filesChanged: buildCompanyEncryptedJsonMarker(entityId, "files_changed_json", "array") }
      : {}),
    ...(openQuestions.length > 0
      ? { openQuestions: buildCompanyEncryptedJsonMarker(entityId, "open_questions_json", "array") }
      : {}),
    ...(nextActionInstruction || taskOutcome
      ? {
          nextAction: {
            ...(nextActionInstruction
              ? {
                  instruction: buildCompanyEncryptedTextMarker(
                    entityId,
                    "next_action_instruction",
                  ),
                }
              : {}),
            ...(taskOutcome ? { taskOutcome } : {}),
          },
        }
      : {}),
  };
};

const checkpoint = async (options) => withRun(async ({
  metadata,
  metadataPath,
  origin,
  token,
  companyEncryption,
}) => {
  const checkpointType = String(options.type || "draft");
  const summary = String(options.summary || "").trim();

  if (!summary) {
    throw new Error("Для checkpoint требуется --summary.");
  }

  const allowedTypes = new Set(["research", "analysis", "draft", "decision", "artifact", "blocker", "handoff"]);

  if (!allowedTypes.has(checkpointType)) {
    throw new Error("Неизвестный --type checkpoint.");
  }

  const evidence = getOptionValues(options, "evidence");
  const explicitlyNamedFiles = getOptionValues(options, "file");
  const filesChanged = explicitlyNamedFiles.length > 0
    ? explicitlyNamedFiles
    : checkpointType === "handoff"
      ? await getCandidateChangedPaths(metadata)
      : checkpointType === "blocker" || checkpointType === "draft"
        ? await getChangedPaths(metadata.workspaceDirectory, metadata.objects || [])
        : [];
  const openQuestions = getOptionValues(options, "question");
  const nextActionInstruction = getOptionValues(options, "next-action")[0] || "";
  const taskOutcome = String(options["task-outcome"] || "").trim();

  if (checkpointType === "handoff") {
    if (summary.length < 20) {
      throw new Error("Для handoff опишите итог для человека минимум в 20 символах через --summary.");
    }

    if (evidence.length === 0) {
      throw new Error("Для handoff добавьте хотя бы один результат или проверку через --evidence.");
    }

    if (filesChanged.length === 0) {
      throw new Error("Для handoff укажите материал через --file или оставьте изменения в workspace.");
    }

    if (!nextActionInstruction) {
      throw new Error("Для handoff явно укажите действие оператора через --next-action.");
    }

  }

  validateHandoffTaskOutcome({
    scopeType: metadata.scopeType,
    checkpointType,
    taskOutcome,
    openQuestions,
  });

  if (checkpointType === "blocker") {
    if (openQuestions.length === 0) {
      throw new Error("Для blocker укажите конкретный вопрос человеку через --question.");
    }

    if (!nextActionInstruction) {
      throw new Error("Для blocker явно укажите действие человека через --next-action.");
    }
  }

  // An ordinary draft checkpoint is the continuity boundary between agents,
  // not metadata beside a private local tree. Upload the same validated delta
  // as blocker pause, but keep the Run running and omit a fabricated question.
  const draftSnapshot = checkpointType === "blocker" || checkpointType === "draft"
    ? await saveRunDraftSnapshot({
        metadata,
        metadataPath,
        origin,
        token,
        companyEncryption,
        requireChangedHead: checkpointType === "draft",
        message: String(options.message || (
          checkpointType === "blocker"
            ? "Сохранить draft перед ожиданием решения"
            : "Сохранить переносимый draft Agent Run"
        )),
      })
    : null;
  const protectedContent = companyEncryption
    ? await protectAgentWorkspaceCheckpoint({
        metadata,
        origin,
        token,
        companyEncryption,
        summary,
        evidence,
        filesChanged,
        openQuestions,
        nextActionInstruction,
        taskOutcome,
      })
    : {
        summary,
        ...(evidence.length > 0 ? { evidence } : {}),
        ...(filesChanged.length > 0 ? { filesChanged } : {}),
        ...(openQuestions.length > 0 ? { openQuestions } : {}),
        ...(nextActionInstruction ? { nextAction: { instruction: nextActionInstruction } } : {}),
      };
  const response = await request(origin, token, `/api/agent-workspaces/runs/${metadata.runId}/checkpoints`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      leaseId: metadata.leaseId,
      fencingToken: metadata.fencingToken,
      checkpointType,
      ...protectedContent,
      ...(taskOutcome ? { taskOutcome } : {}),
      ...(draftSnapshot ? { draftHead: draftSnapshot.draftHead } : {}),
    }),
  });
  const checkpointPayload = await response.json();
  if (draftSnapshot) {
    const nextMetadata = {
      ...draftSnapshot.metadata,
      draftHead: draftSnapshot.draftHead,
      ...(checkpointType === "blocker"
        ? {
            waitingCheckpointId: checkpointPayload.id,
            waitingForHumanAt: checkpointPayload.createdAt || new Date().toISOString(),
          }
        : {
            latestDraftCheckpointId: checkpointPayload.id,
            latestDraftCheckpointAt: checkpointPayload.createdAt || new Date().toISOString(),
          }),
    };
    await writeRunMetadata(metadataPath, nextMetadata);
    process.stdout.write(`Draft snapshot сохранён: ${draftSnapshot.draftHead.slice(0, 12)}.\n`);
  }
  process.stdout.write(`Checkpoint сохранён: ${checkpointPayload.id}.\n`);
});

export const getGitStatus = async (workspaceDirectory, knownObjects = []) => {
  const result = await runGit(["status", "--short"], { cwd: workspaceDirectory });
  let statusLines = result.stdout.trim() ? result.stdout.trim().split("\n") : [];

  if (statusLines.includes(`?? ${WORKLOG_FILE_NAME}`)) {
    const worklog = await inspectWorkspaceWorklog(workspaceDirectory);

    if (worklog.exists && worklog.isDefault) {
      // Простое открытие legacy workspace не должно навсегда делать локальный
      // Run dirty и запрещать безопасную retention-очистку. Как только агент
      // изменил шаблон или добавил запись worklog, обычный Git status снова
      // показывает содержательную дельту, а submit сохранит оба файла.
      statusLines = statusLines.filter((line) => line !== `?? ${WORKLOG_FILE_NAME}`);
    }
  }
  const listedPaths = new Set(
    statusLines.map((line) => line.slice(3).split(" -> ").at(-1)?.trim()).filter(Boolean),
  );

  // Hydrated object-файлы помечены skip-worktree, чтобы Git не показывал
  // обычные рабочие bytes как отличие от pointer в index. Для status/handoff
  // сравниваем их с закреплённым digest явно и не теряем реальные изменения.
  for (const object of knownObjects) {
    if (!object?.filePath || listedPaths.has(object.filePath)) {
      continue;
    }

    const absolutePath = path.join(workspaceDirectory, object.filePath);

    try {
      const inspection = await inspectWorkspaceFile(absolutePath);
      const changed = !inspection.external
        || inspection.sizeBytes !== object.sizeBytes
        || inspection.sha256 !== object.sha256;

      if (changed) {
        statusLines.push(` M ${object.filePath}`);
      }
    } catch (error) {
      if (error.code === "ENOENT") {
        statusLines.push(` D ${object.filePath}`);
      } else {
        throw error;
      }
    }
  }

  return statusLines.join("\n");
};

const status = async () => withRun(async ({ metadata }) => {
  const gitStatus = await getGitStatus(metadata.workspaceDirectory, metadata.objects || []);
  process.stdout.write(`${JSON.stringify({
    workspaceId: metadata.workspaceId,
    runId: metadata.runId,
    baseHead: metadata.baseHead,
    draftHead: metadata.draftHead || null,
    workspaceDirectory: metadata.workspaceDirectory,
    contexts: Array.isArray(metadata.contexts) ? metadata.contexts : [],
    dirty: Boolean(gitStatus),
    changes: gitStatus ? gitStatus.split("\n") : [],
  }, null, 2)}\n`);
});

const assertRunHasMeaningfulChanges = async (commandName) => withRun(async ({ metadata }) => {
  const changedPaths = commandName === "finish"
    ? await getCandidateChangedPaths(metadata)
    : await getChangedPaths(metadata.workspaceDirectory, metadata.objects || []);

  if (changedPaths.length === 0) {
    throw new Error(
      commandName === "pause"
        ? "В workspace нет изменений для переносимого pause. Задайте подготовительный вопрос напрямую."
        : "В workspace нет изменений для finish.",
    );
  }

  // Compact-команды не заставляют модель отдельно переносить Git-состояние
  // между вызовами. Для pause это новые локальные изменения, а для finish —
  // полный candidate delta, включая уже сохранённые draft checkpoint. Backend
  // затем повторно проверяет paths, protected files, pointers и secret paths.
  process.stdout.write(`Проверены изменённые пути (${changedPaths.length}):\n`);
  changedPaths.forEach((changedPath) => {
    process.stdout.write(`- ${changedPath}\n`);
  });
});

const pause = async (options) => {
  await assertRunHasMeaningfulChanges("pause");
  await checkpoint({ ...options, type: "blocker" });
};

const finish = async (options) => {
  await assertRunHasMeaningfulChanges("finish");
  await checkpoint({ ...options, type: "handoff" });
  // `submit` сам продлевает lease до и после подготовки candidate. Отдельный
  // model-facing heartbeat здесь не нужен и только создавал лишнее состояние.
  await submit(options);
};

const registerWorkspaceObject = async ({
  metadata,
  origin,
  token,
  filePath,
  inspection,
  contentType,
}) => {
  const registerResponse = await requestWithRateLimitRetry({
    origin,
    token,
    pathname: `/api/agent-workspaces/runs/${metadata.runId}/objects/register`,
    createOptions: () => ({
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        leaseId: metadata.leaseId,
        fencingToken: metadata.fencingToken,
        filePath,
        sha256: inspection.sha256,
        sizeBytes: inspection.sizeBytes,
        contentType,
      }),
    }),
  });
  let result = await registerResponse.json();

  if (result.uploadRequired) {
    const absolutePath = path.join(metadata.workspaceDirectory, filePath);
    const uploadResponse = await requestWithRateLimitRetry({
      origin,
      token,
      pathname: `/api/agent-workspaces/runs/${metadata.runId}/objects/${inspection.sha256}/content`,
      createOptions: () => ({
        method: "PUT",
        duplex: "half",
        headers: {
          "content-type": "application/octet-stream",
          "content-length": String(inspection.sizeBytes),
          "x-trelio-file-path": encodeURIComponent(filePath),
          "x-trelio-object-content-type": contentType,
          "x-trelio-lease-id": metadata.leaseId,
          "x-trelio-fencing-token": String(metadata.fencingToken),
        },
        body: createReadStream(absolutePath),
      }),
    });
    result = await uploadResponse.json();
  }

  const expectedPointer = serializeWorkspaceObjectPointer({
    sha256: inspection.sha256,
    sizeBytes: inspection.sizeBytes,
    contentType,
  });

  if (result.pointer !== expectedPointer) {
    throw new Error(`Trelio вернул некорректный указатель для ${filePath}.`);
  }

  return {
    filePath,
    sha256: inspection.sha256,
    sizeBytes: inspection.sizeBytes,
    contentType,
    pointer: expectedPointer,
  };
};

const matchesWorkspaceObjectIdentity = (object, plannedObject) => (
  object?.filePath === plannedObject.filePath
  && object?.sha256 === plannedObject.inspection.sha256
  && object?.sizeBytes === plannedObject.inspection.sizeBytes
  && object?.contentType === plannedObject.contentType
);

const serializeObjectRegistrationProgress = (plannedObjects, progressByPath) => (
  plannedObjects.flatMap((plannedObject) => {
    const object = progressByPath.get(plannedObject.filePath);

    if (!object) {
      return [];
    }

    return [{
      filePath: object.filePath,
      sha256: object.sha256,
      sizeBytes: object.sizeBytes,
      contentType: object.contentType,
    }];
  })
);

const prepareCandidateIndex = async ({
  metadata,
  metadataPath,
  origin,
  token,
  companyEncryption,
}) => {
  const workspaceDirectory = metadata.workspaceDirectory;
  const knownObjectPaths = (metadata.objects || []).map((object) => object.filePath);
  await setSkipWorktree(workspaceDirectory, knownObjectPaths, false);
  await runGit(["add", "--all"], { cwd: workspaceDirectory });

  if (companyEncryption) {
    // Paths, pointer manifests and plaintext digests are protected content.
    // A full encrypted bundle can safely carry ordinary Git blobs, including
    // binaries, so encrypted companies deliberately bypass server-visible
    // per-file object registration altogether.
    await assertEncryptedCandidateSafe({
      workspaceDirectory,
      baseHead: metadata.baseHead,
    });
    return [];
  }
  const candidateObjects = [];
  const trackedPaths = await listTrackedWorkspacePaths(workspaceDirectory);
  const inspections = new Map();
  const inlineCandidates = [];
  let inlineTreeBytes = 0;

  for (const filePath of trackedPaths) {
    const inspection = await inspectWorkspaceFile(path.join(workspaceDirectory, filePath));
    inspections.set(filePath, inspection);

    if (!inspection.external) {
      inlineTreeBytes += inspection.sizeBytes;

      if (!isProtectedWorkspaceControlPath(filePath)) {
        inlineCandidates.push({ filePath, sizeBytes: inspection.sizeBytes });
      }
    }
  }

  // Много небольших текстов не должно превращать внутренний Git tree cap в
  // пользовательское ограничение. При необходимости переносим самые крупные
  // из них в object storage, пока pointer/text tree снова не станет компактным.
  inlineCandidates.sort((left, right) => right.sizeBytes - left.sizeBytes);
  for (const candidate of inlineCandidates) {
    if (inlineTreeBytes <= TARGET_INLINE_GIT_TREE_BYTES) {
      break;
    }

    const absolutePath = path.join(workspaceDirectory, candidate.filePath);
    inspections.set(candidate.filePath, {
      external: true,
      ...(await hashFile(absolutePath)),
    });
    inlineTreeBytes -= candidate.sizeBytes;
  }

  const plannedObjects = trackedPaths.flatMap((filePath) => {
    if (isProtectedWorkspaceControlPath(filePath)) {
      return [];
    }

    const inspection = inspections.get(filePath);

    if (!inspection?.external) {
      return [];
    }

    return [{
      filePath,
      inspection,
      contentType: inferWorkspaceObjectContentType(filePath),
    }];
  });
  const plannedObjectsByPath = new Map(
    plannedObjects.map((plannedObject) => [plannedObject.filePath, plannedObject]),
  );
  const progressByPath = new Map();

  // Progress относится не просто к пути, а к exact содержимому. Изменённый
  // после неудачного submit файл обязан пройти регистрацию заново; совпавший
  // exact object можно сразу вернуть в index без сетевого запроса.
  for (const object of Array.isArray(metadata.objectRegistrationProgress)
    ? metadata.objectRegistrationProgress
    : []) {
    const plannedObject = plannedObjectsByPath.get(object?.filePath);

    if (plannedObject && matchesWorkspaceObjectIdentity(object, plannedObject)) {
      progressByPath.set(object.filePath, object);
    }
  }

  for (const filePath of trackedPaths) {
    // Эти control-plane файлы обязаны остаться обычным небольшим текстом.
    // Backend отдельно запрещает их изменение и не примет pointer-обход.
    if (isProtectedWorkspaceControlPath(filePath)) {
      continue;
    }

    const inspection = inspections.get(filePath);

    if (!inspection?.external) {
      continue;
    }

    const plannedObject = plannedObjectsByPath.get(filePath);

    if (!plannedObject) {
      throw new Error(`Не удалось построить план workspace object для ${filePath}.`);
    }

    let object = progressByPath.get(filePath);

    if (object) {
      object = {
        ...object,
        pointer: serializeWorkspaceObjectPointer(object),
      };
    } else {
      object = await registerWorkspaceObject({
        metadata,
        origin,
        token,
        filePath,
        inspection,
        contentType: plannedObject.contentType,
      });
      progressByPath.set(filePath, object);

      // Checkpoint публикуется сразу после подтверждённой регистрации/upload.
      // Если bridge остановится до update-index, следующий submit восстановит
      // pointer из этого exact progress и продолжит с первого незавершённого.
      await writeRunMetadata(metadataPath, {
        ...metadata,
        schemaVersion: 3,
        objectRegistrationProgress: serializeObjectRegistrationProgress(
          plannedObjects,
          progressByPath,
        ),
        objectRegistrationProgressUpdatedAt: new Date().toISOString(),
      });
    }

    const hashResult = await runGit(["hash-object", "-w", "--stdin"], {
      cwd: workspaceDirectory,
      input: object.pointer,
    });
    const pointerObjectId = hashResult.stdout.trim();
    const indexResult = await runGit(["ls-files", "-s", "--", filePath], {
      cwd: workspaceDirectory,
    });
    const mode = indexResult.stdout.match(/^([0-7]{6})\s/)?.[1] || "100644";
    await runGit(
      ["update-index", "--add", "--cacheinfo", mode, pointerObjectId, filePath],
      { cwd: workspaceDirectory },
    );
    candidateObjects.push({
      filePath: object.filePath,
      sha256: object.sha256,
      sizeBytes: object.sizeBytes,
      contentType: object.contentType,
    });
  }

  return candidateObjects;
};

const hasStagedChanges = async (workspaceDirectory) => {
  const result = await runGit(["diff", "--cached", "--name-only", "-z"], {
    cwd: workspaceDirectory,
  });
  return Boolean(result.stdout);
};

const prepareLocalCandidateSnapshot = async ({
  metadata,
  metadataPath,
  origin,
  token,
  companyEncryption,
  message,
}) => {
  const workspaceDirectory = metadata.workspaceDirectory;
  const gitStatus = await getGitStatus(workspaceDirectory, metadata.objects || []);
  const initialHeadResult = await runGit(["rev-parse", "HEAD"], { cwd: workspaceDirectory });
  const hasCommittedCandidate = initialHeadResult.stdout.trim() !== metadata.baseHead;
  let candidateObjects = metadata.objects || [];

  if (gitStatus || hasCommittedCandidate) {
    // Подготовку нельзя пропускать для clean precommitted candidate: exact
    // external-object mappings принадлежат Run и должны восстановиться перед
    // draft/submit даже когда working tree уже чист.
    candidateObjects = await prepareCandidateIndex({
      metadata,
      metadataPath,
      origin,
      token,
      companyEncryption,
    });

    if (await hasStagedChanges(workspaceDirectory)) {
      await runGit(["commit", "-m", message], { cwd: workspaceDirectory });
    }
  }

  const headResult = await runGit(["rev-parse", "HEAD"], { cwd: workspaceDirectory });
  const head = headResult.stdout.trim();
  await setSkipWorktree(
    workspaceDirectory,
    candidateObjects.map((object) => object.filePath),
    true,
  );
  const candidateMetadata = {
    ...metadata,
    schemaVersion: 3,
    objects: candidateObjects,
    candidateHead: head,
    materializedHead: head,
    objectRegistrationProgress: undefined,
    objectRegistrationProgressUpdatedAt: undefined,
  };
  await writeRunMetadata(metadataPath, candidateMetadata);

  return {
    head,
    candidateObjects,
    candidateMetadata,
  };
};

const withLocalCandidateBundle = async (
  { metadata, temporaryPrefix, fullSnapshot = false },
  handler,
) => {
  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), `${temporaryPrefix}-`));
  const bundlePath = path.join(temporaryDirectory, "candidate.bundle");

  try {
    // Plain companies keep the compact delta protocol. An encrypted server
    // cannot merge or inspect Git objects, so every protected revision is a
    // self-contained bundle that another trusted device can materialize.
    await runGit(
      fullSnapshot
        ? ["bundle", "create", bundlePath, "refs/heads/trelio-candidate"]
        : [
            "bundle",
            "create",
            bundlePath,
            "refs/heads/trelio-candidate",
            `^${metadata.baseHead}`,
          ],
      { cwd: metadata.workspaceDirectory },
    );
    return await handler(bundlePath);
  } finally {
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
  }
};

const uploadEncryptedAgentWorkspaceRevision = async ({
  metadata,
  origin,
  token,
  companyEncryption,
  bundlePath,
  workspaceHead,
  revisionKind,
}) => {
  if (!companyEncryption) {
    throw new Error("Encrypted Workspace upload requires an unlocked company context.");
  }
  const encryptedPath = `${bundlePath}.trelioe1`;
  try {
    const encrypted = await encryptFileToCompanyContainer({
      sourcePath: bundlePath,
      destinationPath: encryptedPath,
      scopePublicEncryptionJwk: companyEncryption.runtime.scope.publicEncryptionJwk,
      aad: {
        companyId: companyEncryption.runtime.company.id,
        scopeId: companyEncryption.runtime.scope.id,
        scopeEpoch: companyEncryption.runtime.scope.epoch,
        entityType: "agent_workspace_revision",
        entityId: requireUuid(metadata.runId, "run"),
        entityRevision: Number(metadata.fencingToken),
      },
      originalName: "workspace.bundle",
      mimeType: "application/vnd.git.bundle",
      writerDeviceId: companyEncryption.runtime.device.id,
      signingPrivateKey: companyEncryption.device.privateKeys.signingPrivateKey,
    });
    const manifest = buildEncryptedAgentWorkspaceRevisionRecord({
      companyId: companyEncryption.runtime.company.id,
      workspaceId: requireUuid(metadata.workspaceId, "workspace"),
      runId: requireUuid(metadata.runId, "run"),
      revisionKind,
      baseHead: metadata.baseHead,
      workspaceHead,
      scopeId: companyEncryption.runtime.scope.id,
      scopeEpoch: companyEncryption.runtime.scope.epoch,
      writerDeviceId: companyEncryption.runtime.device.id,
      ciphertextSha256: encrypted.ciphertextSha256,
      ciphertextSizeBytes: encrypted.ciphertextSizeBytes,
      fencingToken: Number(metadata.fencingToken),
    });
    const signature = await signCompanyEncryptionRecord(
      companyEncryption.device.privateKeys.signingPrivateKey,
      manifest,
    );
    const response = await request(
      origin,
      token,
      `/api/agent-workspaces/runs/${metadata.runId}/encrypted-${revisionKind === "draft" ? "draft" : "candidate"}`,
      {
        method: "POST",
        duplex: "half",
        headers: {
          "content-type": "application/vnd.trelio.encrypted-workspace",
          "content-length": String(encrypted.ciphertextSizeBytes),
          "x-trelio-lease-id": metadata.leaseId,
          "x-trelio-fencing-token": String(metadata.fencingToken),
          "x-trelio-base-head": metadata.baseHead,
          "x-trelio-workspace-head": workspaceHead,
          "x-trelio-scope-id": companyEncryption.runtime.scope.id,
          "x-trelio-scope-epoch": String(companyEncryption.runtime.scope.epoch),
          "x-trelio-writer-device-id": companyEncryption.runtime.device.id,
          "x-trelio-ciphertext-sha256": encrypted.ciphertextSha256,
          "x-trelio-signature": signature,
        },
        body: createReadStream(encryptedPath),
      },
    );
    return response.json();
  } finally {
    await fs.rm(encryptedPath, { force: true }).catch(() => undefined);
  }
};

const saveRunDraftSnapshot = async ({
  metadata,
  metadataPath,
  origin,
  token,
  companyEncryption,
  message,
  requireChangedHead = false,
}) => {
  // Даже draft без файловых изменений должен получить свежую lease перед
  // blocker checkpoint. В этом случае baseHead уже является полным
  // переносимым состоянием и пустой Git bundle не создаётся.
  await heartbeat();
  const prepared = await prepareLocalCandidateSnapshot({
    metadata,
    metadataPath,
    origin,
    token,
    companyEncryption,
    message,
  });

  // Ordinary autosave checkpoints describe new coherent work, not another
  // timestamp beside the same server tree. A blocker is different: it may
  // legitimately refresh the lease and attach a human question to the exact
  // draft that was already uploaded by the preceding autosave.
  if (
    requireChangedHead
    && prepared.head === (metadata.draftHead || metadata.baseHead)
  ) {
    throw new Error("После предыдущего draft checkpoint нет новых изменений.");
  }

  if (prepared.head === metadata.baseHead) {
    const draftMetadata = {
      ...prepared.candidateMetadata,
      draftHead: metadata.baseHead,
      draftSavedAt: new Date().toISOString(),
    };
    await writeRunMetadata(metadataPath, draftMetadata);
    return { draftHead: metadata.baseHead, metadata: draftMetadata };
  }

  await heartbeat();
  const result = await withLocalCandidateBundle(
    {
      metadata: prepared.candidateMetadata,
      temporaryPrefix: "trelio-draft",
      fullSnapshot: Boolean(companyEncryption),
    },
    async (bundlePath) => {
      if (companyEncryption) {
        return uploadEncryptedAgentWorkspaceRevision({
          metadata: prepared.candidateMetadata,
          origin,
          token,
          companyEncryption,
          bundlePath,
          workspaceHead: prepared.head,
          revisionKind: "draft",
        });
      }
      const bundleStat = await fs.stat(bundlePath);
      const response = await request(
        origin,
        token,
        `/api/agent-workspaces/runs/${metadata.runId}/draft`,
        {
          method: "POST",
          duplex: "half",
          headers: {
            "content-type": "application/vnd.git.bundle",
            "content-length": String(bundleStat.size),
            "x-trelio-lease-id": metadata.leaseId,
            "x-trelio-fencing-token": String(metadata.fencingToken),
          },
          body: createReadStream(bundlePath),
        },
      );
      return response.json();
    },
  );

  if (
    result?.draft?.head !== prepared.head
    || result?.run?.draftHead !== prepared.head
  ) {
    throw new Error("Trelio вернул draft head, который не совпадает с локальным snapshot.");
  }

  const draftMetadata = {
    ...prepared.candidateMetadata,
    draftHead: prepared.head,
    draftSavedAt: result.run.draftUpdatedAt || new Date().toISOString(),
  };
  await writeRunMetadata(metadataPath, draftMetadata);
  return { draftHead: prepared.head, metadata: draftMetadata };
};

const submit = async (options) => withRun(async ({
  metadata,
  metadataPath,
  origin,
  token,
  companyEncryption,
}) => {
  await heartbeat();
  const prepared = await prepareLocalCandidateSnapshot({
    metadata,
    metadataPath,
    origin,
    token,
    companyEncryption,
    message: String(options.message || "Подготовить результат Agent Run"),
  });
  const head = prepared.head;

  if (head === metadata.baseHead) {
    throw new Error("В workspace нет изменений для отправки.");
  }

  await heartbeat();
  await withLocalCandidateBundle(
    {
      metadata: prepared.candidateMetadata,
      temporaryPrefix: "trelio-candidate",
      fullSnapshot: Boolean(companyEncryption),
    },
    async (bundlePath) => {
      if (companyEncryption) {
        const result = await uploadEncryptedAgentWorkspaceRevision({
          metadata: prepared.candidateMetadata,
          origin,
          token,
          companyEncryption,
          bundlePath,
          workspaceHead: head,
          revisionKind: "accepted",
        });
        if (result.run.status !== "accepted") {
          throw new Error(`Trelio вернул неожиданный статус Agent Run: ${result.run.status}.`);
        }
        await writeRunMetadata(metadataPath, {
          ...prepared.candidateMetadata,
          schemaVersion: 3,
          candidateHead: head,
          terminalStatus: "accepted",
          terminalAt: result.run.acceptedAt || new Date().toISOString(),
          lastUsedAt: new Date().toISOString(),
          cleanupEligibleAfterDays: (await readLocalSettings()).workspaceRetentionDays,
        });
        process.stdout.write("Зашифрованный результат записан в рабочее пространство Trelio.\n");
        return;
      }
      const bundleStat = await fs.stat(bundlePath);
      const response = await request(origin, token, `/api/agent-workspaces/runs/${metadata.runId}/candidate`, {
        method: "POST",
        duplex: "half",
        headers: {
          "content-type": "application/vnd.git.bundle",
          "content-length": String(bundleStat.size),
          "x-trelio-lease-id": metadata.leaseId,
          "x-trelio-fencing-token": String(metadata.fencingToken),
        },
        body: createReadStream(bundlePath),
      });
      const result = await response.json();
      if (result.run.status !== "accepted") {
        throw new Error(`Trelio вернул неожиданный статус Agent Run: ${result.run.status}.`);
      }
      // Accepted Run остаётся на месте для проверки результата. Cleanup увидит
      // terminal mark, но удалит root только после server-confirmed retention.
      await writeRunMetadata(metadataPath, {
        ...prepared.candidateMetadata,
        schemaVersion: 3,
        candidateHead: head,
        terminalStatus: "accepted",
        terminalAt: result.run.acceptedAt || new Date().toISOString(),
        lastUsedAt: new Date().toISOString(),
        cleanupEligibleAfterDays: (await readLocalSettings()).workspaceRetentionDays,
      });
      process.stdout.write("Результат записан в рабочее пространство Trelio.\n");
      process.stdout.write("Статус: принят автоматически.\n");
      process.stdout.write("Проверки структуры, безопасности и актуальности базовой версии пройдены.\n");
      if (result.taskStatusTransition?.state === "applied") {
        process.stdout.write(
          `Статус задачи: ${result.taskStatusTransition.fromStatusName} -> `
          + `${result.taskStatusTransition.toStatusName}.\n`,
        );
      } else if (result.taskStatusTransition?.state === "unchanged") {
        process.stdout.write(
          `Статус задачи не изменён: ${result.taskStatusTransition.currentStatusName}.\n`,
        );
      } else if (result.taskStatusTransition?.state === "blocked") {
        process.stdout.write(
          `Статус задачи не изменён: ${result.taskStatusTransition.reason}.\n`,
        );
      } else if (result.taskStatusTransition?.state === "pending") {
        process.stdout.write(
          `Смена статуса задачи отложена: ${result.taskStatusTransition.reason}.\n`,
        );
      } else if (result.taskStatusTransition?.state === "skipped") {
        process.stdout.write(
          `Статус задачи оставлен без изменений: ${result.taskStatusTransition.reason}.\n`,
        );
      }
      if (result.projection?.status === "pending_reconciliation") {
        process.stdout.write("Git-проекция будет восстановлена фоновым reconciliation; повторять submit не нужно.\n");
      }
    },
  );
});

const spawnSecretCommand = async ({
  commandArguments,
  deliveryMode,
  environmentVariable,
  environmentVariables,
  secretValue,
  secretValues,
}) => {
  const [logicalExecutable, ...logicalArgs] = commandArguments;
  // Codex/Claude plugins ship the bridge as this module and do not promise a
  // global `trelio-workspace` binary in PATH. Keep the grant bound to the
  // narrow logical executable, but resolve that reserved token only to this
  // already-loaded bridge source. Besides making the documented Node fallback
  // work for secret checkout, this prevents a caller-controlled PATH entry
  // from replacing the bridge after the server has approved the grant.
  const executable = logicalExecutable === "trelio-workspace"
    ? process.execPath
    : logicalExecutable;
  const args = logicalExecutable === "trelio-workspace"
    ? [BRIDGE_ENTRYPOINT_PATH, ...logicalArgs]
    : logicalArgs;
  const childEnvironment = { ...process.env };
  let temporaryDirectory = null;
  let childStdin = "inherit";
  let grantedEnvironment = {};
  let grantedStdin = null;

  if (deliveryMode === "env") {
    if (environmentVariables && secretValues) {
      for (const [fieldKey, variableName] of Object.entries(environmentVariables)) {
        if (typeof secretValues[fieldKey] !== "string") {
          throw new Error("Сервер не вернул значение для одного из env-полей checkout.");
        }
        childEnvironment[variableName] = secretValues[fieldKey];
        grantedEnvironment[variableName] = secretValues[fieldKey];
      }
    } else {
      if (!environmentVariable || typeof secretValue !== "string") {
        throw new Error("Сервер не указал переменную окружения для env checkout.");
      }
      childEnvironment[environmentVariable] = secretValue;
      grantedEnvironment = { [environmentVariable]: secretValue };
    }
  } else if (deliveryMode === "stdin") {
    childStdin = "pipe";
    grantedStdin = secretValue;
  } else if (deliveryMode === "file") {
    temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "trelio-secret-"));
    await fs.chmod(temporaryDirectory, 0o700);
    const secretFilePath = path.join(temporaryDirectory, "value");
    await fs.writeFile(secretFilePath, secretValue, { mode: 0o600 });
    await fs.chmod(secretFilePath, 0o600);
    // Фиксированное имя не содержит название секрета и позволяет инструменту
    // прочитать файл без подстановки plaintext в argv или shell history.
    childEnvironment.TRELIO_SECRET_FILE = secretFilePath;
    grantedEnvironment = { TRELIO_SECRET_FILE: secretFilePath };
  } else {
    throw new Error(`Неизвестный delivery mode: ${deliveryMode}`);
  }

  try {
    if (logicalExecutable === "trelio-workspace") {
      const parsed = parseArguments(logicalArgs);
      if (parsed.command === "skill" && parsed.positional[0] === "run") {
        // Do not re-enter the bridge through inherited process.env: the skill
        // host intentionally strips ambient variables before the signed child
        // starts. Keep the already-consumed one-use value in this process and
        // hand it explicitly to exactly one live-resolved runtime invocation.
        // This also covers file/stdin delivery without a forgeable marker env.
        const origin = normalizeOrigin(parsed.options.origin || DEFAULT_ORIGIN);
        await skillCommand(origin, parsed.options, parsed.positional, {
          grantedEnvironment,
          grantedStdin,
        });
        return;
      }
    }

    const exitCode = await new Promise((resolve, reject) => {
      const child = spawn(executable, args, {
        cwd: process.cwd(),
        env: childEnvironment,
        shell: false,
        stdio: [childStdin, "inherit", "inherit"],
      });

      child.once("error", reject);
      child.once("exit", (code, signal) => {
        if (signal) {
          reject(new Error(`Локальная команда остановлена сигналом ${signal}.`));
          return;
        }
        resolve(code ?? 1);
      });

      if (deliveryMode === "stdin") {
        child.stdin.end(secretValue);
      }
    });

    if (exitCode !== 0) {
      throw new Error(`Локальная команда завершилась с кодом ${exitCode}.`);
    }
  } finally {
    // Значение не логируем и не сохраняем в workspace. В file mode удаляем
    // весь отдельный private temp directory независимо от результата команды.
    if (temporaryDirectory) {
      await fs.rm(temporaryDirectory, { recursive: true, force: true });
    }
  }
};

const readSecretInput = async (fileOption) => {
  if (fileOption) {
    const filePath = path.resolve(String(fileOption));
    const stat = await fs.stat(filePath);
    if (!stat.isFile() || stat.size < 1 || stat.size > 64 * 1024) {
      throw new Error("Файл секрета должен содержать от 1 до 65536 байт.");
    }
    return fs.readFile(filePath, "utf8");
  }

  if (process.stdin.isTTY) {
    throw new Error("Передайте значение через stdin или --file. Не указывайте секрет в аргументах команды.");
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > 64 * 1024) throw new Error("Значение секрета превышает 65536 байт.");
    chunks.push(bytes);
  }
  const value = Buffer.concat(chunks).toString("utf8");
  if (!value) throw new Error("Значение секрета не может быть пустым.");
  return value;
};

const AGENT_SECRET_FIELD_KEY_PATTERN = /^[a-z][a-z0-9_]{0,63}$/u;
const AGENT_SECRET_MAX_FIELD_COUNT = 50;
const AGENT_SECRET_FIELDS_JSON_FORMAT = "fields-json";
const LOCAL_AGENT_SECRET_SCHEMA_VERSION = 1;

const resolveLocalAgentSecretFile = (origin, companyMemberId, secretId) => {
  const originKey = crypto.createHash("sha256").update(origin).digest("hex");
  return path.join(
    LOCAL_AGENT_SECRETS_DIRECTORY,
    originKey,
    requireUuid(companyMemberId, "company member"),
    requireUuid(secretId, "secret"),
    "secret.json",
  );
};

const normalizeLocalAgentSecretRecord = (rawRecord, expected) => {
  const record = rawRecord && typeof rawRecord === "object" ? rawRecord : {};
  const values = record.values && typeof record.values === "object" && !Array.isArray(record.values)
    ? record.values
    : null;
  if (
    record.schemaVersion !== LOCAL_AGENT_SECRET_SCHEMA_VERSION
    || record.origin !== expected.origin
    || record.companyId !== expected.companyId
    || record.companyMemberId !== expected.companyMemberId
    || record.secretId !== expected.secretId
    || !Number.isSafeInteger(record.secretVersion)
    || record.secretVersion < 1
    || !UUID_PATTERN.test(record.attestationId || "")
    || !values
  ) {
    throw new Error("Локальная копия Agent Secret не совпадает с текущей карточкой Trelio.");
  }
  const normalizedValues = Object.create(null);
  for (const [key, value] of Object.entries(values)) {
    if (!AGENT_SECRET_FIELD_KEY_PATTERN.test(key) || typeof value !== "string") {
      throw new Error("Локальная копия Agent Secret содержит некорректное поле.");
    }
    normalizedValues[key] = value;
  }
  return { ...record, values: normalizedValues };
};

const readLocalAgentSecretRecord = async (origin, context) => {
  const filePath = resolveLocalAgentSecretFile(origin, context.companyMemberId, context.secretId);
  const rawRecord = await readPrivateJsonFile(filePath);
  if (!rawRecord || Object.keys(rawRecord).length === 0) {
    throw new Error("На этом компьютере нет локальной копии Agent Secret.");
  }
  return {
    filePath,
    record: normalizeLocalAgentSecretRecord(rawRecord, {
      origin,
      companyId: context.companyId,
      companyMemberId: context.companyMemberId,
      secretId: context.secretId,
    }),
  };
};

const readExistingLocalAgentSecretRecord = async (origin, context) => {
  const filePath = resolveLocalAgentSecretFile(origin, context.companyMemberId, context.secretId);
  const rawRecord = await readPrivateJsonFile(filePath);
  if (!rawRecord || Object.keys(rawRecord).length === 0) return null;
  return normalizeLocalAgentSecretRecord(rawRecord, {
    origin,
    companyId: context.companyId,
    companyMemberId: context.companyMemberId,
    secretId: context.secretId,
  });
};

const isRetryableLocalSecretMutationError = (error) => (
  error instanceof TypeError
  || (error instanceof TrelioApiError && error.statusCode >= 500)
);

// prepare/confirm идемпотентны по attestationId. Три коротких повтора нужны
// только для transport/5xx; явные 4xx никогда не маскируются новым запросом.
const requestLocalSecretMutation = async (origin, token, pathname, body) => {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await request(origin, token, pathname, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      return response.json();
    } catch (error) {
      lastError = error;
      if (!isRetryableLocalSecretMutationError(error) || attempt === 3) throw error;
      await wait(250 * attempt);
    }
  }
  throw lastError;
};

const fetchAgentSecretWriteContext = async ({ origin, token, secretId, runId }) => {
  const response = await request(
    origin,
    token,
    `/api/agent-secrets/secrets/${secretId}/bridge-write-context?runId=${encodeURIComponent(runId)}`,
  );
  const context = await response.json();
  if (
    context.secretId !== secretId
    || !["trelio", "local_device"].includes(context.storageMode)
    || !UUID_PATTERN.test(context.companyId || "")
    || !UUID_PATTERN.test(context.companyMemberId || "")
    || !Number.isSafeInteger(context.currentVersion)
    || context.currentVersion < 0
    || !Array.isArray(context.fields)
  ) {
    throw new Error("Trelio вернул некорректный контекст записи Agent Secret.");
  }
  return context;
};

const buildCompleteLocalAgentSecretValues = ({ valuePayload, context, previousRecord }) => {
  const fields = context.fields;
  const allowedKeys = new Set(fields.map((field) => field.key));
  const values = Object.create(null);
  if (previousRecord?.secretVersion === context.currentVersion) {
    for (const [key, value] of Object.entries(previousRecord.values)) {
      if (allowedKeys.has(key)) values[key] = value;
    }
  }
  if (valuePayload.value !== undefined) {
    if (fields.length !== 1) {
      throw new Error("Для многополевого Agent Secret обязателен --format fields-json.");
    }
    values[fields[0].key] = valuePayload.value;
  }
  for (const [key, value] of Object.entries(valuePayload.values || {})) {
    if (!allowedKeys.has(key)) throw new Error(`Поле Agent Secret «${key}» отсутствует в схеме Trelio.`);
    if (value === null || value === "") delete values[key];
    else values[key] = value;
  }
  for (const field of fields) {
    if (field.required && typeof values[field.key] !== "string") {
      throw new Error(`Обязательное поле Agent Secret «${field.key}» не задано локально.`);
    }
  }
  return values;
};

const persistAndConfirmLocalAgentSecret = async ({
  origin,
  token,
  runId,
  context,
  values,
  sourceAttestationId,
}) => {
  const attestationId = crypto.randomUUID();
  const fieldKeys = context.fields
    .map((field) => field.key)
    .filter((key) => typeof values[key] === "string");
  const prepared = await requestLocalSecretMutation(
    origin,
    token,
    `/api/agent-secrets/secrets/${context.secretId}/local-writes/prepare`,
    {
      runId,
      attestationId,
      expectedCurrentVersion: context.currentVersion,
      fieldKeys,
      ...(sourceAttestationId ? { sourceAttestationId } : {}),
    },
  );
  if (
    prepared.attestationId !== attestationId
    || prepared.secretId !== context.secretId
    || prepared.companyId !== context.companyId
    || prepared.companyMemberId !== context.companyMemberId
    || !Number.isSafeInteger(prepared.secretVersion)
    || prepared.secretVersion < 1
  ) {
    throw new Error("Trelio вернул некорректное подтверждение локальной записи Agent Secret.");
  }
  const filePath = resolveLocalAgentSecretFile(origin, context.companyMemberId, context.secretId);
  await writePrivateJsonFile(filePath, {
    schemaVersion: LOCAL_AGENT_SECRET_SCHEMA_VERSION,
    origin,
    companyId: context.companyId,
    companyMemberId: context.companyMemberId,
    secretId: context.secretId,
    secretVersion: prepared.secretVersion,
    attestationId,
    values,
  });
  await requestLocalSecretMutation(
    origin,
    token,
    `/api/agent-secrets/local-writes/${attestationId}/confirm`,
    { runId },
  );
  return { filePath, secretVersion: prepared.secretVersion };
};

/**
 * Convert protected stdin/file bytes into the exact server payload for
 * `secret set` without guessing from their contents.
 *
 * JSON auto-detection is intentionally forbidden: an ordinary one-field
 * secret may itself be a JSON document, and silently reinterpreting it as a
 * named-field bundle would rotate a different logical value. The explicit
 * format flag keeps legacy scalar writes byte-for-byte compatible while still
 * allowing one atomic multi-field write.
 */
export const parseAgentSecretSetInput = (input, formatOption) => {
  if (formatOption === undefined) {
    return { value: input };
  }

  if (Array.isArray(formatOption) || formatOption !== AGENT_SECRET_FIELDS_JSON_FORMAT) {
    throw new Error(
      "Параметр --format поддерживает только `fields-json`; без параметра ввод сохраняется как одно строковое значение.",
    );
  }

  let parsed;
  try {
    parsed = JSON.parse(input);
  } catch {
    // Не включаем parser message или исходные bytes: оба могут содержать
    // фрагмент plaintext секрета и не должны попасть в stderr/tool log.
    throw new Error("Ввод Agent Secret в формате `fields-json` должен быть корректным JSON-объектом.");
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Ввод Agent Secret в формате `fields-json` должен быть JSON-объектом именованных полей.");
  }

  const entries = Object.entries(parsed);
  if (entries.length < 1 || entries.length > AGENT_SECRET_MAX_FIELD_COUNT) {
    throw new Error("JSON-объект Agent Secret должен содержать от 1 до 50 именованных полей.");
  }

  // Null-prototype не позволяет специальному ключу вроде `__proto__`
  // изменить локальный объект до server-side schema validation.
  const values = Object.create(null);
  for (const [rawKey, fieldValue] of entries) {
    const key = rawKey.trim().toLowerCase();
    if (!AGENT_SECRET_FIELD_KEY_PATTERN.test(key)) {
      throw new Error("JSON-объект Agent Secret содержит некорректный ключ поля.");
    }
    if (Object.hasOwn(values, key)) {
      throw new Error("JSON-объект Agent Secret содержит повторяющийся ключ поля.");
    }
    if (fieldValue !== null && typeof fieldValue !== "string") {
      throw new Error("Значение каждого поля Agent Secret должно быть строкой или null.");
    }
    values[key] = fieldValue;
  }

  return { values };
};

const setSecretValue = async (options, positional) => withRun(async ({ metadata, origin, token }) => {
  if (positional[0] !== "set") {
    throw new Error("Поддерживаются `secret set` и `secret exec`.");
  }
  const secretId = requireUuid(options.secret, "secret");

  // Проверяем plugin до чтения одноразового stdin. Тогда upgrade-required
  // может передать ещё не потреблённый pipe exact новому bridge в той же
  // задаче, не сохраняя secret value на диск или в process arguments.
  await ensureBridgeCompatibility(origin, token);
  if (!metadata.runId) {
    throw new Error("Текущая папка не содержит активный Trelio Agent Run.");
  }
  const context = await fetchAgentSecretWriteContext({
    origin,
    token,
    secretId,
    runId: metadata.runId,
  });
  const input = await readSecretInput(options.file);
  const valuePayload = parseAgentSecretSetInput(input, options.format);
  if (context.storageMode === "local_device") {
    const previousRecord = await readExistingLocalAgentSecretRecord(origin, context);
    const values = buildCompleteLocalAgentSecretValues({ valuePayload, context, previousRecord });
    await persistAndConfirmLocalAgentSecret({
      origin,
      token,
      runId: metadata.runId,
      context,
      values,
    });
    process.stdout.write("Значение секрета сохранено только на этом компьютере; Trelio получил подтверждение локальной копии.\n");
    return;
  }
  const response = await request(origin, token, `/api/agent-secrets/secrets/${secretId}/value-from-bridge`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ runId: metadata.runId, ...valuePayload }),
  });
  await response.json();
  process.stdout.write("Значение секрета зашифровано и сохранено новой версией.\n");
});

const adoptLocalSecretValue = async (options, positional) => withRun(async ({
  metadata,
  origin,
  token,
}) => {
  if (positional[0] !== "adopt") {
    throw new Error("Поддерживается команда `trelio-workspace secret adopt --secret UUID`.");
  }
  const secretId = requireUuid(options.secret, "secret");
  if (!metadata.runId) {
    throw new Error("Текущая папка не содержит активный Trelio Agent Run.");
  }
  await ensureBridgeCompatibility(origin, token);
  const context = await fetchAgentSecretWriteContext({
    origin,
    token,
    secretId,
    runId: metadata.runId,
  });
  if (context.storageMode !== "local_device") {
    throw new Error("Переподтверждение устройства доступно только для local-device Agent Secret.");
  }
  const { record } = await readLocalAgentSecretRecord(origin, context);
  if (record.secretVersion !== context.currentVersion) {
    throw new Error("Скопированная локальная версия Agent Secret устарела относительно Trelio.");
  }
  await persistAndConfirmLocalAgentSecret({
    origin,
    token,
    runId: metadata.runId,
    context,
    values: record.values,
    sourceAttestationId: record.attestationId,
  });
  process.stdout.write("Локальная копия Agent Secret подтверждена на этом компьютере.\n");
});

const decodeAgentSecretBase32 = (rawValue) => {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const normalized = rawValue.toUpperCase().replace(/=+$/u, "").replace(/[\s-]/gu, "");
  if (!normalized || /[^A-Z2-7]/u.test(normalized)) {
    throw new Error("Локальный TOTP seed имеет некорректную Base32-кодировку.");
  }
  let bits = "";
  for (const character of normalized) bits += alphabet.indexOf(character).toString(2).padStart(5, "0");
  const bytes = [];
  for (let offset = 0; offset + 8 <= bits.length; offset += 8) {
    bytes.push(Number.parseInt(bits.slice(offset, offset + 8), 2));
  }
  return Buffer.from(bytes);
};

// В local_device даже одноразовый TOTP вычисляется локально: seed не нужен
// Trelio ни для хранения, ни для checkout. Возвращается только текущий код.
const deriveLocalAgentSecretTotp = (seed, nowMs = Date.now()) => {
  const counter = Math.floor(nowMs / 30_000);
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const digest = crypto.createHmac("sha1", decodeAgentSecretBase32(seed)).update(message).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary = ((digest[offset] & 0x7f) << 24)
    | (digest[offset + 1] << 16)
    | (digest[offset + 2] << 8)
    | digest[offset + 3];
  return String(binary % 1_000_000).padStart(6, "0");
};

const resolveCheckoutSecretValues = async (origin, payload) => {
  if (payload.storageMode !== "local_device") {
    if (typeof payload.value === "string") {
      return payload.values && typeof payload.values === "object" && !Array.isArray(payload.values)
        ? payload.values
        : { value: payload.value };
    }
    if (!payload.values || typeof payload.values !== "object" || Array.isArray(payload.values)) {
      throw new Error("Trelio вернул некорректный набор полей Agent Secret.");
    }
    return payload.values;
  }
  if (
    !UUID_PATTERN.test(payload.secretId || "")
    || !UUID_PATTERN.test(payload.companyId || "")
    || !UUID_PATTERN.test(payload.companyMemberId || "")
    || !UUID_PATTERN.test(payload.localAttestationId || "")
    || !Number.isSafeInteger(payload.secretVersion)
    || !Array.isArray(payload.fieldKeys)
    || !Array.isArray(payload.fields)
  ) {
    throw new Error("Trelio вернул некорректную metadata локального Agent Secret.");
  }
  const context = {
    secretId: payload.secretId,
    companyId: payload.companyId,
    companyMemberId: payload.companyMemberId,
  };
  const { record } = await readLocalAgentSecretRecord(origin, context);
  if (
    record.secretVersion !== payload.secretVersion
    || record.attestationId !== payload.localAttestationId
  ) {
    throw new Error("Локальная копия Agent Secret не подтверждена для этого checkout grant.");
  }
  const fieldTypes = new Map(payload.fields.map((field) => [field.key, field.type]));
  const values = Object.create(null);
  for (const fieldKey of payload.fieldKeys) {
    const value = record.values[fieldKey];
    if (
      !AGENT_SECRET_FIELD_KEY_PATTERN.test(fieldKey)
      || typeof value !== "string"
      || !fieldTypes.has(fieldKey)
    ) {
      throw new Error("Локальная копия Agent Secret не содержит поле checkout grant.");
    }
    values[fieldKey] = fieldTypes.get(fieldKey) === "totp"
      ? deriveLocalAgentSecretTotp(value)
      : value;
  }
  return values;
};

const executeSecretCheckout = async (options, positional) => withRun(async ({ metadata, origin, token }) => {
  if (positional[0] !== "exec") {
    throw new Error("Поддерживается команда `trelio-workspace secret exec --grant UUID -- COMMAND [ARGS...]`.");
  }

  const grantId = requireUuid(options.grant, "grant");
  const commandArguments = positional.slice(1);

  if (commandArguments.length === 0) {
    throw new Error("После `--` укажите локальную программу и её аргументы.");
  }

  if (!metadata.runId) {
    throw new Error("Текущая папка не содержит активный Trelio Agent Run.");
  }

  // Endpoint атомарно учитывает текущее использование grant. Обычные Agent
  // Secrets остаются one-use; installation-managed grant может быть
  // time-bound только по server policy. Ответ в любом случае живёт лишь в
  // памяти этого bridge process и не печатается, не пишется в metadata и не
  // передаётся MCP.
  const response = await request(origin, token, `/api/agent-secrets/checkout-grants/${grantId}/consume`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    // runId берётся только из materialized `.trelio-run.json`. Backend сверяет
    // его с grant и повторно проверяет активную lease в atomic consume.
    body: JSON.stringify({ runId: metadata.runId }),
  });
  const payload = await response.json();

  if (payload.executable !== commandArguments[0]) {
    throw new Error("Локальная программа не совпадает с executable, закреплённым в checkout grant.");
  }

  if (payload.runId !== metadata.runId) {
    throw new Error("Checkout grant принадлежит другому Trelio Agent Run.");
  }

  const secretValues = await resolveCheckoutSecretValues(origin, payload);
  const secretValue = typeof payload.value === "string"
    ? payload.value
    : payload.fieldKeys?.length === 1 && typeof secretValues[payload.fieldKeys[0]] === "string"
      ? secretValues[payload.fieldKeys[0]]
      : JSON.stringify(secretValues);
  if (typeof secretValue !== "string") {
    throw new Error("Trelio вернул некорректный набор полей Agent Secret.");
  }

  await spawnSecretCommand({
    commandArguments,
    deliveryMode: payload.deliveryMode,
    environmentVariable: payload.environmentVariable,
    environmentVariables: payload.environmentVariables,
    secretValue,
    secretValues,
  });
});

const isRetryableBrowserOutcomeError = (error) => (
  error instanceof TypeError
  || (error instanceof TrelioApiError && error.statusCode >= 500)
);

// Outcome endpoint идемпотентен для того же результата. Поэтому после
// транспортного сбоя безопасно сделать три bounded retry, не повторяя ни
// checkout, ни саму подстановку значения.
const reportSecretBrowserFillOutcome = async ({
  origin,
  token,
  grantId,
  runId,
  outcome,
  reasonCode,
}) => {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await request(
        origin,
        token,
        `/api/agent-secrets/checkout-grants/${grantId}/browser-fill-outcome`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            runId,
            outcome,
            ...(reasonCode ? { reasonCode } : {}),
          }),
        },
      );
      await response.json();
      return;
    } catch (error) {
      lastError = error;
      if (!isRetryableBrowserOutcomeError(error) || attempt === 3) throw error;
      await wait(250 * attempt);
    }
  }
  throw lastError;
};

const executeSecretBrowserFill = async (options, positional) => withRun(async ({
  metadata,
  origin,
  token,
}) => {
  if (positional[0] !== "browser-fill") {
    throw new Error("Поддерживается команда `trelio-workspace secret browser-fill --grant UUID --target HTTPS_URL`.");
  }
  const grantId = requireUuid(options.grant, "grant");
  const targetUrl = String(options.target || "");
  if (!targetUrl || Array.isArray(options.target)) {
    throw new Error("Для browser-fill требуется один exact --target HTTPS_URL.");
  }
  if (!metadata.runId) {
    throw new Error("Текущая папка не содержит активный Trelio Agent Run.");
  }

  // Plaintext появляется только в памяти bridge после atomic consume. Target
  // URL не доверяется: helper повторно сравнит его с закреплённым origin.
  const response = await request(origin, token, `/api/agent-secrets/checkout-grants/${grantId}/consume`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ runId: metadata.runId }),
  });
  const payload = await response.json();
  if (
    payload.runId !== metadata.runId
    || payload.deliveryMode !== "browser"
    || payload.executable !== "trelio-workspace"
    || typeof payload.targetOrigin !== "string"
    || !/^[0-9a-f]{64}$/u.test(payload.targetUrlSha256 || "")
    || (
      (!Array.isArray(payload.browserSteps) || payload.browserSteps.length === 0)
      && (typeof payload.browserFieldSelector !== "string" || !payload.browserFieldSelector)
    )
  ) {
    throw new Error("Trelio вернул некорректный browser-fill grant.");
  }

  process.stdout.write(`Автоматически подставляю Agent Secret на ${payload.targetOrigin}.\n`);

  let localResult = null;
  let outcomeReported = false;
  try {
    const secretValues = await resolveCheckoutSecretValues(origin, payload);
    const result = await runSecretBrowserFill({
      secretValues,
      targetUrl,
      targetOrigin: payload.targetOrigin,
      targetUrlSha256: payload.targetUrlSha256,
      fieldSelector: payload.browserFieldSelector,
      browserSteps: payload.browserSteps,
      profileDirectory: SECRET_BROWSER_PROFILE_DIRECTORY,
      ensurePrivateDirectory,
    });
    localResult = result;

    await reportSecretBrowserFillOutcome({
      origin,
      token,
      grantId,
      runId: metadata.runId,
      outcome: result.outcome,
      reasonCode: result.reasonCode,
    });
    outcomeReported = true;
    if (result.outcome !== "succeeded") {
      throw new SecretBrowserFillError(
        "Trelio Secret Browser не выполнил автоматическую подстановку значения.",
        result.reasonCode || "adapter_error",
      );
    }
    process.stdout.write("Секрет автоматически вставлен в exact поле; plaintext агенту не возвращался.\n");
  } catch (error) {
    // Локальный результат уже мог наступить, а потерялся только ответ audit
    // endpoint. В таком случае нельзя записывать противоречивый outcome.
    if (localResult && !outcomeReported) {
      throw new Error(
        "Browser fill завершился локально, но безопасный audit outcome не удалось подтвердить после трёх попыток. Не повторяйте операцию автоматически.",
        { cause: error },
      );
    }
    if (localResult && outcomeReported) throw error;
    const reasonCode = error instanceof SecretBrowserFillError
      ? error.reasonCode
      : "adapter_error";
    let outcomeError = null;
    try {
      await reportSecretBrowserFillOutcome({
        origin,
        token,
        grantId,
        runId: metadata.runId,
        outcome: "failed",
        reasonCode,
      });
    } catch (reportError) {
      outcomeError = reportError;
    }
    if (outcomeError) {
      throw new Error(
        "Browser fill завершился ошибкой, а безопасный audit outcome не удалось подтвердить после трёх попыток.",
        { cause: new AggregateError([error, outcomeError]) },
      );
    }
    throw error;
  }
});

const calculateDirectoryBytes = async (directory) => {
  let totalBytes = 0;
  const entries = await fs.readdir(directory, { withFileTypes: true });

  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);

    if (entry.isSymbolicLink()) {
      totalBytes += (await fs.lstat(entryPath)).size;
    } else if (entry.isDirectory()) {
      totalBytes += await calculateDirectoryBytes(entryPath);
    } else if (entry.isFile()) {
      totalBytes += (await fs.lstat(entryPath)).size;
    }
  }

  return totalBytes;
};

const discoverDefaultRunRoots = async () => {
  const roots = [];
  let workspaceEntries = [];

  try {
    workspaceEntries = await fs.readdir(DEFAULT_WORKSPACES_DIRECTORY, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") {
      return roots;
    }
    throw error;
  }

  for (const workspaceEntry of workspaceEntries) {
    if (!workspaceEntry.isDirectory() || !UUID_PATTERN.test(workspaceEntry.name)) {
      continue;
    }

    const workspaceDirectory = path.join(DEFAULT_WORKSPACES_DIRECTORY, workspaceEntry.name);
    if (await readOptionalRunMetadata(workspaceDirectory)) {
      roots.push(workspaceDirectory);
    }
    const runEntries = await fs.readdir(workspaceDirectory, { withFileTypes: true });

    for (const runEntry of runEntries) {
      if (runEntry.isDirectory() && UUID_PATTERN.test(runEntry.name)) {
        roots.push(path.join(workspaceDirectory, runEntry.name));
      }
    }
  }

  return roots;
};

const discoverRegisteredRunRoots = async () => {
  const roots = [...new Set([
    ...(await readRunRegistry()),
    ...(await discoverDefaultRunRoots()),
  ].map((item) => path.resolve(item)))];
  const discovered = [];

  for (const rootDirectory of roots) {
    try {
      const [rootStat, metadata] = await Promise.all([
        fs.lstat(rootDirectory),
        fs.readFile(path.join(rootDirectory, ".trelio-run.json"), "utf8").then(JSON.parse),
      ]);

      if (
        rootStat.isDirectory()
        && !rootStat.isSymbolicLink()
        && UUID_PATTERN.test(String(metadata.workspaceId || ""))
        && UUID_PATTERN.test(String(metadata.runId || ""))
        && path.resolve(metadata.workspaceDirectory || "") === path.join(rootDirectory, "workspace")
      ) {
        discovered.push({ rootDirectory, metadata });
      }
    } catch (error) {
      if (error.code !== "ENOENT") {
        // Повреждённый/неизвестный root намеренно не становится кандидатом на
        // удаление. clean продолжает проверять остальные зарегистрированные Run.
      }
    }
  }

  return discovered;
};

const readRunStatusMap = async ({ origin, token, roots }) => {
  const statusByRunId = new Map();
  const latestRunActivityByWorkspaceId = new Map();
  const workspacesWithOpenRuns = new Set();
  const workspaceIds = [...new Set(
    roots
      .filter((item) => normalizeOrigin(item.metadata.origin || DEFAULT_ORIGIN) === origin)
      .map((item) => item.metadata.workspaceId),
  )];

  for (const workspaceId of workspaceIds) {
    const overview = await readJsonResponse(await request(
      origin,
      token,
      `/api/agent-workspaces/workspaces/${requireUuid(workspaceId, "workspace")}`,
    ));

    for (const run of Array.isArray(overview.runs) ? overview.runs : []) {
      statusByRunId.set(run.id, run);
      const activityAt = Math.max(...[
        run.updatedAt,
        run.acceptedAt,
        run.cancelledAt,
        run.draftUpdatedAt,
        run.createdAt,
      ].map((value) => Date.parse(String(value || ""))).filter(Number.isFinite));

      if (Number.isFinite(activityAt)) {
        latestRunActivityByWorkspaceId.set(
          workspaceId,
          Math.max(latestRunActivityByWorkspaceId.get(workspaceId) || 0, activityAt),
        );
      }
      if (!TERMINAL_RUN_STATUSES.has(run.status)) {
        workspacesWithOpenRuns.add(workspaceId);
      }
    }
  }

  return {
    statusByRunId,
    latestRunActivityByWorkspaceId,
    workspacesWithOpenRuns,
  };
};

const hasUnmanagedIgnoredWorkspaceFiles = async (workspaceDirectory) => {
  const result = await runGit(
    ["ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"],
    { cwd: workspaceDirectory },
  );
  const ignoredPaths = result.stdout.split("\0").filter(Boolean);

  for (const ignoredPath of ignoredPaths) {
    if (ignoredPath === "AGENTS.md") {
      if (
        await fs.readFile(path.join(workspaceDirectory, ignoredPath), "utf8")
        === AGENT_WORKSPACE_RUNTIME_AGENTS_MARKDOWN
      ) {
        continue;
      }
    }
    if (ignoredPath === "CLAUDE.md") {
      if (
        await fs.readFile(path.join(workspaceDirectory, ignoredPath), "utf8")
        === AGENT_WORKSPACE_RUNTIME_CLAUDE_MARKDOWN
      ) {
        continue;
      }
    }
    if (ignoredPath === WORKLOG_FILE_NAME) {
      const worklog = await inspectWorkspaceWorklog(workspaceDirectory);

      if (worklog.exists && worklog.isDefault) continue;
    }

    return true;
  }

  return false;
};

const isWritableWorkspaceDirty = async (root) => {
  try {
    const localHead = (await runGit(["rev-parse", "HEAD"], {
      cwd: root.metadata.workspaceDirectory,
    })).stdout.trim();

    if (localHead !== resolveRecordedMaterializedHead(root.metadata)) {
      // A clean working tree may still contain unpublished commits. Retention
      // treats that divergence as user data and never removes the root.
      return true;
    }

    if (await hasUnmanagedIgnoredWorkspaceFiles(root.metadata.workspaceDirectory)) {
      return true;
    }

    return Boolean(await getGitStatus(
      root.metadata.workspaceDirectory,
      root.metadata.objects || [],
    ));
  } catch {
    // Неизвестное состояние безопаснее считать dirty, чем пытаться удалить.
    return true;
  }
};

const isWorkspaceOpenLocked = async (workspaceId) => {
  try {
    const lockStat = await fs.lstat(path.join(
      WORKSPACE_OPEN_LOCK_DIRECTORY,
      `${workspaceId}.lock`,
    ));
    // Cleanup never tries to repair locks: an uncertain/opening Workspace is
    // simply not reclaimable in this pass.
    return lockStat.isDirectory() || lockStat.isSymbolicLink();
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
};

const formatBytes = (value) => {
  if (value < 1024) return `${value} Б`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} КиБ`;
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} МиБ`;
  return `${(value / 1024 ** 3).toFixed(2)} ГиБ`;
};

const collectProtectedCacheDigests = (roots) => {
  const digests = new Set();

  for (const root of roots) {
    for (const object of [
      ...(Array.isArray(root.metadata.objects) ? root.metadata.objects : []),
      ...(Array.isArray(root.metadata.contextObjects) ? root.metadata.contextObjects : []),
    ]) {
      if (SHA256_PATTERN.test(String(object?.sha256 || ""))) {
        digests.add(String(object.sha256));
      }
    }
  }

  return digests;
};

const listCacheEntries = async () => {
  const entries = [];
  let prefixDirectories = [];

  try {
    prefixDirectories = await fs.readdir(OBJECT_CACHE_DIRECTORY, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") {
      return entries;
    }
    throw error;
  }

  for (const prefix of prefixDirectories) {
    if (!prefix.isDirectory() || !/^[0-9a-f]{2}$/.test(prefix.name)) {
      continue;
    }

    const prefixDirectory = path.join(OBJECT_CACHE_DIRECTORY, prefix.name);
    const files = await fs.readdir(prefixDirectory, { withFileTypes: true });

    for (const file of files) {
      if (!file.isFile() || !SHA256_PATTERN.test(file.name)) {
        continue;
      }

      const filePath = path.join(prefixDirectory, file.name);
      const stat = await fs.lstat(filePath);

      if (!stat.isSymbolicLink()) {
        entries.push({
          sha256: file.name,
          filePath,
          sizeBytes: stat.size,
          lastUsedAtMs: Math.max(stat.atimeMs, stat.mtimeMs),
        });
      }
    }
  }

  return entries;
};

const planObjectCachePrune = async ({ roots, settings }) => {
  const protectedDigests = collectProtectedCacheDigests(roots);
  const entries = (await listCacheEntries())
    .sort((left, right) => left.lastUsedAtMs - right.lastUsedAtMs);
  const maximumAgeMs = settings.objectCacheMaxAgeDays * 24 * 60 * 60 * 1000;
  const now = Date.now();
  let retainedBytes = entries.reduce((sum, entry) => sum + entry.sizeBytes, 0);
  const candidates = [];

  for (const entry of entries) {
    if (protectedDigests.has(entry.sha256)) {
      continue;
    }

    if (
      now - entry.lastUsedAtMs >= maximumAgeMs
      || retainedBytes > settings.objectCacheMaxBytes
    ) {
      candidates.push(entry);
      retainedBytes -= entry.sizeBytes;
    }
  }

  return candidates;
};

const listSkillRuntimeCacheEntries = async () => {
  const entries = [];
  let skillDirectories = [];

  try {
    skillDirectories = await fs.readdir(
      SKILL_RUNTIME_CACHE_DIRECTORY,
      { withFileTypes: true },
    );
  } catch (error) {
    if (error.code === "ENOENT") return entries;
    throw error;
  }

  for (const skillDirectory of skillDirectories) {
    if (!skillDirectory.isDirectory() || !SKILL_ID_PATTERN.test(skillDirectory.name)) {
      continue;
    }
    const skillPath = path.join(SKILL_RUNTIME_CACHE_DIRECTORY, skillDirectory.name);
    const runtimeDirectories = await fs.readdir(skillPath, { withFileTypes: true });

    for (const runtimeDirectory of runtimeDirectories) {
      if (!runtimeDirectory.isDirectory() || !STABLE_VERSION_PATTERN.test(runtimeDirectory.name)) {
        continue;
      }
      const runtimePath = path.join(skillPath, runtimeDirectory.name);
      const digestDirectories = await fs.readdir(runtimePath, { withFileTypes: true });

      for (const digestDirectory of digestDirectories) {
        if (!digestDirectory.isDirectory() || !SHA256_PATTERN.test(digestDirectory.name)) {
          continue;
        }

        const directoryPath = path.join(runtimePath, digestDirectory.name);
        const markerPath = path.join(directoryPath, ".trelio-verified.json");

        try {
          const [directoryStat, markerStat, sizeBytes] = await Promise.all([
            fs.lstat(directoryPath),
            fs.lstat(markerPath),
            calculateDirectoryBytes(directoryPath),
          ]);

          if (
            directoryStat.isDirectory()
            && !directoryStat.isSymbolicLink()
            && markerStat.isFile()
            && !markerStat.isSymbolicLink()
          ) {
            entries.push({
              directoryPath,
              sizeBytes,
              lastUsedAtMs: Math.max(markerStat.atimeMs, markerStat.mtimeMs),
            });
          }
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
      }
    }
  }

  return entries;
};

const planSkillRuntimeCachePrune = async ({ settings }) => {
  const entries = (await listSkillRuntimeCacheEntries())
    .sort((left, right) => left.lastUsedAtMs - right.lastUsedAtMs);
  const maximumAgeMs =
    settings.skillRuntimeCacheMaxAgeDays * 24 * 60 * 60 * 1000;
  const now = Date.now();
  let retainedBytes = entries.reduce((sum, entry) => sum + entry.sizeBytes, 0);
  const candidates = [];

  for (const entry of entries) {
    if (
      now - entry.lastUsedAtMs >= maximumAgeMs
      || retainedBytes > settings.skillRuntimeCacheMaxBytes
    ) {
      candidates.push(entry);
      retainedBytes -= entry.sizeBytes;
    }
  }

  return candidates;
};

const assertSafeRegisteredRunRoot = (root, registeredRoots) => {
  const resolvedRoot = path.resolve(root.rootDirectory);
  const defaultPrefix = `${path.resolve(DEFAULT_WORKSPACES_DIRECTORY)}${path.sep}`;

  if (
    !resolvedRoot.startsWith(defaultPrefix)
    && !registeredRoots.has(resolvedRoot)
  ) {
    throw new Error(`Run root не зарегистрирован для безопасного удаления: ${resolvedRoot}`);
  }

  if (
    path.resolve(root.metadata.workspaceDirectory || "") !== path.join(resolvedRoot, "workspace")
    || path.dirname(path.resolve(path.join(resolvedRoot, ".trelio-run.json"))) !== resolvedRoot
  ) {
    throw new Error(`Run root не прошёл проверку структуры: ${resolvedRoot}`);
  }
};

const planWorkspaceCleanup = async ({
  origin,
  token,
  settings,
  ignoredOpenLockWorkspaceIds = new Set(),
}) => {
  const roots = await discoverRegisteredRunRoots();
  const {
    statusByRunId,
    latestRunActivityByWorkspaceId,
    workspacesWithOpenRuns,
  } = await readRunStatusMap({ origin, token, roots });
  const retentionMs = settings.workspaceRetentionDays * 24 * 60 * 60 * 1000;
  const candidates = [];

  for (const root of roots) {
    if (normalizeOrigin(root.metadata.origin || DEFAULT_ORIGIN) !== origin) {
      continue;
    }

    const runState = statusByRunId.get(root.metadata.runId);

    if (!runState || !TERMINAL_RUN_STATUSES.has(runState.status)) {
      continue;
    }

    if (workspacesWithOpenRuns.has(root.metadata.workspaceId)) {
      continue;
    }

    const terminalAt = Date.parse(
      runState.acceptedAt
      || runState.cancelledAt
      || runState.updatedAt
      || "",
    );
    const localActivityAt = Math.max(...[
      root.metadata.lastUsedAt,
      root.metadata.claimedAt,
      root.metadata.createdAt,
    ].map((value) => Date.parse(String(value || ""))).filter(Number.isFinite));
    const inactiveSince = Math.max(
      Number.isFinite(terminalAt) ? terminalAt : Number.NEGATIVE_INFINITY,
      Number.isFinite(localActivityAt) ? localActivityAt : Number.NEGATIVE_INFINITY,
      latestRunActivityByWorkspaceId.get(root.metadata.workspaceId)
        || Number.NEGATIVE_INFINITY,
    );

    if (!Number.isFinite(inactiveSince) || Date.now() - inactiveSince < retentionMs) {
      continue;
    }

    if (
      !ignoredOpenLockWorkspaceIds.has(root.metadata.workspaceId)
      && await isWorkspaceOpenLocked(root.metadata.workspaceId)
    ) {
      continue;
    }

    const rootEntries = await fs.readdir(root.rootDirectory, { withFileTypes: true });
    const containsUnmanagedRootEntry = rootEntries.some((entry) => ![
      ".trelio-run.json",
      "context",
      "workspace",
    ].includes(entry.name));

    if (containsUnmanagedRootEntry) {
      // При rolling migration persistent root может временно соседствовать со
      // старыми `<workspaceId>/<runId>` roots. Родителя нельзя удалить вместе
      // с ними. Любой другой неизвестный top-level path также может содержать
      // пользовательские данные и поэтому делает весь root non-reclaimable.
      continue;
    }

    if (await isWritableWorkspaceDirty(root)) {
      continue;
    }

    candidates.push({
      ...root,
      status: runState.status,
      terminalAt: Number.isFinite(terminalAt) ? new Date(terminalAt).toISOString() : null,
      lastUsedAt: new Date(inactiveSince).toISOString(),
      sizeBytes: await calculateDirectoryBytes(root.rootDirectory),
    });
  }

  return { roots, candidates };
};

const cleanLocalRuns = async ({ origin, token, dryRun, automatic = false }) => {
  const settings = await readLocalSettings();
  let cleanupPlan;

  try {
    cleanupPlan = await planWorkspaceCleanup({ origin, token, settings });
  } catch (error) {
    if (automatic) {
      // Backend недоступен или статус не доказан — автоматическая очистка
      // ничего не удаляет, включая cache.
      return { skipped: true, reason: error instanceof Error ? error.message : String(error) };
    }
    throw error;
  }

  const registeredRoots = new Set((await readRunRegistry()).map((item) => path.resolve(item)));
  const cacheCandidates = await planObjectCachePrune({
    roots: cleanupPlan.roots,
    settings,
  });
  const skillRuntimeCacheCandidates = await planSkillRuntimeCachePrune({
    settings,
  });
  const reclaimableBytes = [
    ...cleanupPlan.candidates,
    ...cacheCandidates,
    ...skillRuntimeCacheCandidates,
  ].reduce((sum, item) => sum + item.sizeBytes, 0);

  if (!automatic || dryRun) {
    process.stdout.write(`Inactive Workspace roots: ${cleanupPlan.candidates.length}\n`);
    for (const candidate of cleanupPlan.candidates) {
      process.stdout.write(
        `- ${candidate.rootDirectory} · ${candidate.status} · ${formatBytes(candidate.sizeBytes)}\n`,
      );
    }
    process.stdout.write(`Cache objects: ${cacheCandidates.length}\n`);
    for (const candidate of cacheCandidates) {
      process.stdout.write(`- ${candidate.filePath} · ${formatBytes(candidate.sizeBytes)}\n`);
    }
    process.stdout.write(`Skill runtime packages: ${skillRuntimeCacheCandidates.length}\n`);
    for (const candidate of skillRuntimeCacheCandidates) {
      process.stdout.write(`- ${candidate.directoryPath} · ${formatBytes(candidate.sizeBytes)}\n`);
    }
    process.stdout.write(`Можно освободить: ${formatBytes(reclaimableBytes)}\n`);
  }

  if (dryRun) {
    return {
      deletedRuns: 0,
      deletedCacheObjects: 0,
      deletedSkillRuntimePackages: 0,
      reclaimableBytes,
    };
  }

  const workspaceLocks = new Map();
  const initiallyPlannedRoots = new Set(
    cleanupPlan.candidates.map((item) => path.resolve(item.rootDirectory)),
  );
  let deletionCandidates = [];

  try {
    // Между dry-plan и rm другой процесс мог начать open. Берём тот же lock,
    // который защищает materialization, затем полностью перечитываем backend,
    // metadata и Git. Ни один root не удаляется по устаревшему плану.
    for (const candidate of cleanupPlan.candidates) {
      const workspaceId = candidate.metadata.workspaceId;

      if (workspaceLocks.has(workspaceId)) continue;

      try {
        workspaceLocks.set(workspaceId, await acquireWorkspaceOpenLock(workspaceId));
      } catch (error) {
        if (error.code !== "TRELIO_WORKSPACE_OPEN_LOCKED") throw error;
      }
    }

    let refreshedCleanupPlan;

    try {
      refreshedCleanupPlan = await planWorkspaceCleanup({
        origin,
        token,
        settings,
        // Собственные locks этой cleanup-транзакции не делают root active;
        // locks другого процесса по-прежнему исключают его из fresh plan.
        ignoredOpenLockWorkspaceIds: new Set(workspaceLocks.keys()),
      });
    } catch (error) {
      if (automatic) {
        return { skipped: true, reason: error instanceof Error ? error.message : String(error) };
      }
      throw error;
    }

    deletionCandidates = refreshedCleanupPlan.candidates.filter((candidate) => (
      initiallyPlannedRoots.has(path.resolve(candidate.rootDirectory))
      && workspaceLocks.has(candidate.metadata.workspaceId)
    ));

    for (const candidate of deletionCandidates) {
      assertSafeRegisteredRunRoot(candidate, registeredRoots);
      await fs.rm(candidate.rootDirectory, { recursive: true, force: true });
    }
  } finally {
    for (const lock of workspaceLocks.values()) {
      await releaseWorkspaceOpenLock(lock);
    }
  }

  for (const candidate of cacheCandidates) {
    await fs.rm(candidate.filePath, { force: true });
  }

  const skillRuntimeCachePrefix =
    `${path.resolve(SKILL_RUNTIME_CACHE_DIRECTORY)}${path.sep}`;
  for (const candidate of skillRuntimeCacheCandidates) {
    const resolvedDirectory = path.resolve(candidate.directoryPath);

    if (!resolvedDirectory.startsWith(skillRuntimeCachePrefix)) {
      throw new Error(
        `Skill runtime cache path не прошёл проверку: ${resolvedDirectory}`,
      );
    }
    await fs.rm(resolvedDirectory, { recursive: true, force: true });
  }

  const deletedRootSet = new Set(
    deletionCandidates.map((item) => path.resolve(item.rootDirectory)),
  );
  await writeRunRegistry(
    (await readRunRegistry()).filter((item) => !deletedRootSet.has(path.resolve(item))),
  );

  if (!automatic) {
    process.stdout.write("Очистка завершена.\n");
  }

  return {
    deletedRuns: deletionCandidates.length,
    deletedCacheObjects: cacheCandidates.length,
    deletedSkillRuntimePackages: skillRuntimeCacheCandidates.length,
    reclaimableBytes,
  };
};

const printHelp = () => {
  process.stdout.write(`Trelio Agent Workspace Bridge ${BRIDGE_VERSION}\n\n`);
  process.stdout.write("Команды:\n");
  process.stdout.write("  trelio-workspace doctor [--json] [--origin URL]\n");
  process.stdout.write("  trelio-workspace login [--origin https://trelio.ru]\n");
  process.stdout.write("  trelio-workspace login --legacy-oauth [--origin https://trelio.ru]\n");
  process.stdout.write("  trelio-workspace encryption setup --company SLUG [--json] [--origin https://trelio.ru]\n");
  process.stdout.write("  trelio-workspace inspect --workspace UUID [--origin https://trelio.ru]\n");
  process.stdout.write("  trelio-workspace open --workspace UUID [--run UUID] [--dir PATH]\n");
  process.stdout.write("  trelio-workspace status\n");
  process.stdout.write("  trelio-workspace heartbeat\n");
  process.stdout.write("  trelio-workspace context sync\n");
  process.stdout.write("  trelio-workspace context attach --workspace UUID\n");
  process.stdout.write("  trelio-workspace context fetch --path ../context/project/path/to/file\n");
  process.stdout.write("  trelio-workspace clean --dry-run\n");
  process.stdout.write("  trelio-workspace clean\n");
  process.stdout.write("  trelio-workspace checkpoint --type draft --summary TEXT\n");
  process.stdout.write("  trelio-workspace checkpoint --type blocker --summary TEXT --question TEXT --next-action TEXT\n");
  process.stdout.write("  trelio-workspace checkpoint --type handoff --summary TEXT --evidence TEXT [--file PATH] [--question TEXT] --next-action TEXT [--task-outcome work_completed|review_passed|direct_completion|no_status_change]\n");
  process.stdout.write("  trelio-workspace pause --summary TEXT --question TEXT --next-action TEXT\n");
  process.stdout.write("  trelio-workspace finish --summary TEXT --evidence TEXT [--file PATH] [--question TEXT] --next-action TEXT [--task-outcome work_completed|review_passed|direct_completion|no_status_change]\n");
  process.stdout.write("  trelio-workspace submit [--message TEXT]\n");
  process.stdout.write("  trelio-workspace skill pack --skill ID --runtime-version X.Y.Z --source DIR --entry PATH --interpreter node|python|executable --output FILE [--capability VALUE]\n");
  process.stdout.write("  trelio-workspace skill run --company UUID [--project UUID] --skill ID --release UUID -- [ARGS...]\n");
  process.stdout.write("  trelio-workspace secret exec --grant UUID -- COMMAND [ARGS...]\n");
  process.stdout.write("  trelio-workspace secret browser-fill --grant UUID --target HTTPS_URL\n");
  process.stdout.write("  COMMAND | trelio-workspace secret set --secret UUID\n");
  process.stdout.write("  trelio-workspace secret set --secret UUID --file PATH\n");
  process.stdout.write("  JSON_PRODUCER | trelio-workspace secret set --secret UUID --format fields-json\n");
  process.stdout.write("  trelio-workspace secret set --secret UUID --file PATH --format fields-json\n");
  process.stdout.write("  trelio-workspace secret adopt --secret UUID\n");
};

const runUpdatedBridgeEntrypoint = async (
  bridgePath,
  rawArguments,
  {
    environment = process.env,
    spawnProcess = spawn,
  } = {},
) => (
  new Promise((resolve, reject) => {
    const child = spawnProcess(
      process.execPath,
      [bridgePath, ...rawArguments],
      {
        env: {
          ...environment,
          TRELIO_WORKSPACE_AUTO_UPDATE_REEXEC: "1",
        },
        shell: false,
        stdio: "inherit",
        windowsHide: true,
      },
    );
    child.once("error", reject);
    child.once("exit", (exitCode, signal) => {
      if (signal) {
        reject(new Error(`Обновлённый Trelio bridge завершён сигналом ${signal}.`));
        return;
      }
      resolve(exitCode ?? 1);
    });
  })
);

const buildPluginUpdateFallbackError = ({
  compatibility,
  updated,
  cause = null,
  codexRuntime,
}) => {
  const updateCommand = typeof compatibility?.update?.codexCommand === "string"
    ? compatibility.update.codexCommand
    : "codex plugin marketplace upgrade trelio-plugins";
  const minimumVersion = typeof compatibility?.minimumVersion === "string"
    ? `v${compatibility.minimumVersion}`
    : "актуальная версия";

  if (updated) {
    return new Error(
      `Trelio Agent Workspaces обновлён до ${minimumVersion}, но текущая задача `
      + "не смогла безопасно перечитать plugin. Начните новую задачу и повторите "
      + "исходное действие. Полностью перезапускайте Codex только если новая "
      + "задача по-прежнему видит старую версию или не загружает MCP tools.",
    );
  }

  if (!codexRuntime) {
    return new Error(
      `Обновите Trelio Agent Workspaces до ${minimumVersion} штатным plugin manager `
      + "клиента и сначала перечитайте plugins или начните новую задачу. Полный "
      + "перезапуск нужен только если новый контекст остаётся на старой версии.",
    );
  }

  const causeDetail = cause
    ? ` Причина автоматического обновления: ${buildChildProcessErrorDetail(cause)}`
    : "";
  return new Error(
    `Не удалось тихо обновить Trelio Agent Workspaces до ${minimumVersion}. `
    + `Выполните \`${updateCommand}\` и повторите действие в этой задаче. `
    + "Если она продолжает использовать старую версию, начните новую задачу; "
    + `полный перезапуск Codex оставьте последним fallback.${causeDetail}`,
  );
};

export const recoverBridgePluginUpgrade = async (
  error,
  {
    rawArguments = process.argv.slice(2),
    environment = process.env,
    execFileCommand = execFileAsync,
    filesystem = fs,
    spawnProcess = spawn,
    waitForRetry = wait,
    preserveLoadedPlugin = true,
    loadedPluginDirectory = LOADED_CODEX_PLUGIN_DIRECTORY,
    loadedPluginVersion = BRIDGE_VERSION,
    retentionDirectory = CODEX_PLUGIN_RETENTION_DIRECTORY,
  } = {},
) => {
  if (!(error instanceof BridgePluginUpgradeRequiredError)) {
    return { handled: false, error };
  }

  const compatibility = error.compatibility;
  const codexRuntime = isCodexPluginAutoUpdateEnvironment(environment);
  const codexTask = Boolean(
    environment.CODEX_THREAD_ID
    && !environment.CLAUDE_CODE_ENTRYPOINT
    && !environment.CLAUDE_ENV_FILE
    && !environment.CLAUDE_EFFORT,
  );
  const minimumVersion = typeof compatibility?.minimumVersion === "string"
    ? compatibility.minimumVersion
    : null;
  const sameTaskRetryAllowed =
    compatibility?.update?.sameTaskRetryAllowed === true;

  if (environment.TRELIO_WORKSPACE_AUTO_UPDATE_REEXEC === "1") {
    return {
      handled: false,
      error: buildPluginUpdateFallbackError({
        compatibility,
        updated: true,
        codexRuntime: codexTask,
      }),
    };
  }

  if (!codexRuntime) {
    return {
      handled: false,
      error: buildPluginUpdateFallbackError({
        compatibility,
        updated: false,
        codexRuntime: codexTask,
      }),
    };
  }

  let installation = null;

  try {
    // Background updater мог уже установить новую immutable cache-версию.
    // Сначала спрашиваем exact installedPath у Codex и только при необходимости
    // выполняем сетевой marketplace refresh.
    installation = await resolveInstalledCodexPluginBridge({
      minimumVersion,
      execFileCommand,
      environment,
      filesystem,
      preserveLoadedPlugin,
      loadedPluginDirectory,
      loadedPluginVersion,
      retentionDirectory,
    });
    if (!installation) {
      installation = await updateCodexPluginMarketplace({
        minimumVersion,
        execFileCommand,
        environment,
        filesystem,
        waitForRetry,
        preserveLoadedPlugin,
        loadedPluginDirectory,
        loadedPluginVersion,
        retentionDirectory,
      });
    }
  } catch (updateError) {
    return {
      handled: false,
      error: buildPluginUpdateFallbackError({
        compatibility,
        updated: false,
        cause: updateError,
        codexRuntime: true,
      }),
    };
  }

  if (!installation || !sameTaskRetryAllowed) {
    return {
      handled: false,
      error: buildPluginUpdateFallbackError({
        compatibility,
        updated: true,
        codexRuntime: true,
      }),
    };
  }

  try {
    const exitCode = await runUpdatedBridgeEntrypoint(
      installation.bridgePath,
      rawArguments,
      { environment, spawnProcess },
    );
    return { handled: true, exitCode };
  } catch (reexecError) {
    return {
      handled: false,
      error: buildPluginUpdateFallbackError({
        compatibility,
        updated: true,
        cause: reexecError,
        codexRuntime: true,
      }),
    };
  }
};

const main = async () => {
  const { command, options, positional } = parseArguments(process.argv.slice(2));
  const origin = normalizeOrigin(options.origin || DEFAULT_ORIGIN);

  if (command === "__plugin-update") {
    if (process.env.TRELIO_WORKSPACE_BACKGROUND_UPDATE !== "1") {
      throw new Error("Внутренняя команда updater недоступна напрямую.");
    }
    await runBackgroundCodexPluginUpdate();
  } else if (command === "doctor") {
    await doctor(options);
  } else if (command === "login") {
    if (options["legacy-oauth"] === true) {
      await legacyOAuthLogin(origin);
    } else {
      await pairBridge(origin);
    }
  } else if (command === "encryption") {
    if (positional[0] !== "setup" || positional.length !== 1) {
      throw new Error("Команда encryption поддерживает только подкоманду setup.");
    }
    await setupCompanyEncryption(origin, options);
  } else if (command === "inspect") {
    if (positional.length !== 0) {
      throw new Error("Команда inspect не принимает позиционные параметры.");
    }
    await inspectWorkspace(origin, options);
  } else if (command === "open") {
    await openWorkspace(origin, options);
  } else if (command === "status") {
    await status();
  } else if (command === "heartbeat") {
    await heartbeat();
  } else if (command === "context") {
    await contextCommand(options, positional);
  } else if (command === "clean") {
    const token = await requireToken(origin);
    await ensureBridgeCompatibility(origin, token);
    await cleanLocalRuns({
      origin,
      token,
      dryRun: options["dry-run"] === true,
    });
  } else if (command === "checkpoint") {
    await checkpoint(options);
  } else if (command === "pause") {
    await pause(options);
  } else if (command === "finish") {
    await finish(options);
  } else if (command === "submit") {
    await submit(options);
  } else if (command === "skill") {
    await skillCommand(origin, options, positional);
  } else if (command === "secret") {
    if (positional[0] === "set") {
      await setSecretValue(options, positional);
    } else if (positional[0] === "adopt") {
      await adoptLocalSecretValue(options, positional);
    } else if (positional[0] === "browser-fill") {
      await executeSecretBrowserFill(options, positional);
    } else {
      await executeSecretCheckout(options, positional);
    }
  } else if (command === "help" || command === "--help" || command === "-h") {
    printHelp();
  } else {
    throw new Error(`Неизвестная команда: ${command}`);
  }
};

const runEntrypoint = async () => {
  try {
    await main();

    if (!["__plugin-update", "doctor"].includes(process.argv[2])) {
      // Успешную workspace-команду не задерживаем сетью: отдельный скрытый
      // процесс обновит официальный marketplace и новую immutable plugin cache.
      await startQuietCodexPluginUpdate().catch(() => undefined);
    }
  } catch (error) {
    const recovery = await recoverBridgePluginUpgrade(error);

    if (recovery.handled) {
      process.exitCode = recovery.exitCode;
      return;
    }

    throw recovery.error;
  }
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runEntrypoint().catch((error) => fail(error instanceof Error ? error.message : String(error)));
}
