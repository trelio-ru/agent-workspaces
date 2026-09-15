import { isUtf8 } from "node:buffer";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const CODEX_TRELIO_DIRECT_TOOL_NAMESPACES = Object.freeze([
  "mcp__trelio",
  "mcp__trelio_remote_skills",
]);

export const CODEX_ROUTING_PLAN_TOOL_NAME = "plan_codex_trelio_hook_routing";
export const CODEX_ROUTING_APPLY_TOOL_NAME = "apply_codex_trelio_hook_routing";

const MAX_CODEX_CONFIG_BYTES = 1024 * 1024;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const TARGET_CONFIG_KEY = "features.code_mode.direct_only_tool_namespaces";

export class CodexRoutingConfigError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = "CodexRoutingConfigError";
    this.code = code;
  }
}

const failUnsupported = (message) => {
  throw new CodexRoutingConfigError(
    "TRELIO_CODEX_ROUTING_CONFIG_UNSUPPORTED",
    message,
  );
};

const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");

export const resolveCodexConfigPath = ({
  environment = process.env,
  homeDirectory = os.homedir(),
  platform = process.platform,
} = {}) => {
  const pathApi = platform === "win32" ? path.win32 : path;
  const configuredHome = typeof environment.CODEX_HOME === "string"
    ? environment.CODEX_HOME.trim()
    : "";
  if (configuredHome) {
    return pathApi.resolve(configuredHome, "config.toml");
  }
  const defaultHome = platform === "win32"
    ? environment.USERPROFILE || homeDirectory
    : homeDirectory;
  return pathApi.resolve(defaultHome, ".codex", "config.toml");
};

/**
 * Splits TOML into complete statements without attempting to interpret
 * unrelated configuration. Arrays and multiline strings may span lines, so a
 * line regexp alone could mistake their contents for a new table or key.
 */
const scanTomlStatements = (source) => {
  const statements = [];
  let statementStart = 0;
  let squareDepth = 0;
  let curlyDepth = 0;
  let quote = null;
  let multiline = false;
  let escaped = false;
  let comment = false;

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];

    if (comment) {
      if (character === "\n") comment = false;
    } else if (quote) {
      if (quote === '"' && escaped) {
        escaped = false;
      } else if (quote === '"' && character === "\\") {
        escaped = true;
      } else if (
        multiline
        && character === quote
        && source.slice(index, index + 3) === quote.repeat(3)
      ) {
        quote = null;
        multiline = false;
        index += 2;
      } else if (!multiline && character === quote) {
        quote = null;
      }
    } else if (
      (character === '"' || character === "'")
      && source.slice(index, index + 3) === character.repeat(3)
    ) {
      quote = character;
      multiline = true;
      index += 2;
    } else if (character === '"' || character === "'") {
      quote = character;
      multiline = false;
    } else if (character === "#") {
      comment = true;
    } else if (character === "[") {
      squareDepth += 1;
    } else if (character === "]") {
      squareDepth -= 1;
    } else if (character === "{") {
      curlyDepth += 1;
    } else if (character === "}") {
      curlyDepth -= 1;
    }

    if (squareDepth < 0 || curlyDepth < 0) {
      failUnsupported("config.toml содержит несбалансированные скобки.");
    }
    if (
      character === "\n"
      && !quote
      && squareDepth === 0
      && curlyDepth === 0
    ) {
      statements.push({
        start: statementStart,
        end: index + 1,
        text: source.slice(statementStart, index + 1),
      });
      statementStart = index + 1;
    }
  }

  if (quote || squareDepth !== 0 || curlyDepth !== 0) {
    failUnsupported("config.toml содержит незавершённую строку, массив или inline table.");
  }
  if (statementStart < source.length) {
    statements.push({
      start: statementStart,
      end: source.length,
      text: source.slice(statementStart),
    });
  }
  return statements;
};

const stripTrailingTomlComment = (statement) => {
  let quote = null;
  let escaped = false;
  for (let index = 0; index < statement.length; index += 1) {
    const character = statement[index];
    if (quote === '"') {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quote = null;
    } else if (quote === "'") {
      if (character === "'") quote = null;
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === "#") {
      return statement.slice(0, index);
    }
  }
  return statement;
};

const decodeComparableTomlString = (raw) => {
  if (raw.startsWith("'") && raw.endsWith("'")) return raw.slice(1, -1);
  if (!raw.startsWith('"') || !raw.endsWith('"')) return null;
  try {
    let invalidCodePoint = false;
    const jsonCompatible = raw.replace(/\\U([0-9A-Fa-f]{8})/gu, (_match, hex) => {
      const codePoint = Number.parseInt(hex, 16);
      if (codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)) {
        invalidCodePoint = true;
        return "";
      }
      if (codePoint <= 0xffff) {
        return `\\u${codePoint.toString(16).padStart(4, "0")}`;
      }
      const pair = codePoint - 0x10000;
      const high = 0xd800 + (pair >> 10);
      const low = 0xdc00 + (pair & 0x3ff);
      return `\\u${high.toString(16)}\\u${low.toString(16)}`;
    });
    return invalidCodePoint ? null : JSON.parse(jsonCompatible);
  } catch {
    return null;
  }
};

/**
 * Parses only the TOML key grammar needed to identify a table/assignment.
 * Values remain opaque. Supporting quoted keys matters on Windows because a
 * normal Codex config often contains tables such as `[projects."C:\\\\work"]`;
 * the editor must cross those boundaries without mistaking their settings for
 * Code Mode settings.
 */
const parseTomlKeyPath = (rawKey) => {
  const segments = [];
  let index = 0;
  while (index < rawKey.length) {
    while (/\s/u.test(rawKey[index] || "")) index += 1;
    if (index >= rawKey.length) return null;

    let rawSegment;
    const first = rawKey[index];
    if (first === '"' || first === "'") {
      const quote = first;
      const start = index;
      index += 1;
      let escaped = false;
      while (index < rawKey.length) {
        const character = rawKey[index];
        if (quote === '"' && escaped) escaped = false;
        else if (quote === '"' && character === "\\") escaped = true;
        else if (character === quote) {
          index += 1;
          break;
        }
        index += 1;
      }
      rawSegment = rawKey.slice(start, index);
      if (!rawSegment.endsWith(quote)) return null;
    } else {
      const match = rawKey.slice(index).match(/^[A-Za-z0-9_-]+/u);
      if (!match) return null;
      rawSegment = match[0];
      index += rawSegment.length;
    }

    const decoded = first === '"' || first === "'"
      ? decodeComparableTomlString(rawSegment)
      : rawSegment;
    if (typeof decoded !== "string") return null;
    segments.push(decoded);

    while (/\s/u.test(rawKey[index] || "")) index += 1;
    if (index >= rawKey.length) return segments;
    if (rawKey[index] !== ".") return null;
    index += 1;
  }
  return null;
};

const parseTablePath = (statement) => {
  const code = stripTrailingTomlComment(statement).trim();
  if (!code.startsWith("[") || !code.endsWith("]") || code.startsWith("[[")) {
    return null;
  }
  return parseTomlKeyPath(code.slice(1, -1));
};

const findTomlAssignmentEquals = (code) => {
  let quote = null;
  let escaped = false;
  for (let index = 0; index < code.length; index += 1) {
    const character = code[index];
    if (quote === '"') {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quote = null;
    } else if (quote === "'") {
      if (character === "'") quote = null;
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === "=") {
      return index;
    }
  }
  return -1;
};

const readAssignment = (statement) => {
  const code = stripTrailingTomlComment(statement);
  const equalsIndex = findTomlAssignmentEquals(code);
  if (equalsIndex < 0) return null;
  const keyPath = parseTomlKeyPath(code.slice(0, equalsIndex));
  return keyPath ? { keyPath, equalsIndex } : null;
};

const keyPathEquals = (actual, expected) => (
  actual.length === expected.length
  && actual.every((segment, index) => segment === expected[index])
);

/**
 * Reads only a plain array of strings. Comments inside the value are rejected
 * rather than silently discarded, because the repair must preserve user
 * intent outside the two namespaces it appends.
 */
const parseStringArray = (statement, equalsIndex) => {
  const valueStart = statement.indexOf("[", equalsIndex + 1);
  if (valueStart < 0 || statement.slice(equalsIndex + 1, valueStart).trim()) {
    failUnsupported(`${TARGET_CONFIG_KEY} должен быть обычным массивом строк.`);
  }

  const values = [];
  let index = valueStart + 1;
  let expectValue = true;
  let closingIndex = -1;
  while (index < statement.length) {
    const character = statement[index];
    if (/\s/u.test(character)) {
      index += 1;
      continue;
    }
    if (character === "#") {
      failUnsupported(
        `Комментарии внутри ${TARGET_CONFIG_KEY} требуют ручного изменения.`,
      );
    }
    if (character === "]") {
      closingIndex = index;
      break;
    }
    if (!expectValue) {
      if (character !== ",") {
        failUnsupported(`${TARGET_CONFIG_KEY} содержит неподдерживаемое значение.`);
      }
      expectValue = true;
      index += 1;
      continue;
    }
    if (character !== '"' && character !== "'") {
      failUnsupported(`${TARGET_CONFIG_KEY} должен содержать только строки.`);
    }

    const quote = character;
    const start = index;
    index += 1;
    let escaped = false;
    while (index < statement.length) {
      const current = statement[index];
      if (quote === '"' && escaped) {
        escaped = false;
      } else if (quote === '"' && current === "\\") {
        escaped = true;
      } else if (current === quote) {
        index += 1;
        break;
      } else if (current === "\n" || current === "\r") {
        failUnsupported(`${TARGET_CONFIG_KEY} содержит неподдерживаемую multiline-строку.`);
      }
      index += 1;
    }
    const raw = statement.slice(start, index);
    if (!raw.endsWith(quote)) {
      failUnsupported(`${TARGET_CONFIG_KEY} содержит незавершённую строку.`);
    }
    values.push({ raw, comparable: decodeComparableTomlString(raw) });
    expectValue = false;
  }

  if (closingIndex < 0) {
    failUnsupported(`${TARGET_CONFIG_KEY} содержит незавершённый массив.`);
  }
  const suffix = statement.slice(closingIndex + 1);
  if (stripTrailingTomlComment(suffix).trim()) {
    failUnsupported(`${TARGET_CONFIG_KEY} содержит лишние данные после массива.`);
  }
  return { valueStart, closingIndex, suffix, values };
};

/**
 * Codex 0.154 still writes the legacy `[features] code_mode = true|false`
 * shape from `codex features enable/disable code_mode`. The richer Code Mode
 * options require `[features.code_mode]`, so preserve the boolean as `enabled`
 * while migrating only this one related assignment.
 */
const parseLegacyCodeModeBoolean = (statement, equalsIndex) => {
  const value = statement.slice(equalsIndex + 1);
  const match = value.match(/^[ \t]*(true|false)([ \t]*(?:#[^\r\n]*)?)[\r\n]*$/u);
  if (!match) {
    failUnsupported("features.code_mode должен быть boolean или обычным table.");
  }
  return {
    value: match[1],
    trailingComment: match[2],
  };
};

const renderMergedArray = ({ values, missingNamespaces, multiline, newline, indent }) => {
  const renderedValues = [
    ...values.map(({ raw }) => raw),
    ...missingNamespaces.map((namespace) => JSON.stringify(namespace)),
  ];
  if (!multiline) return `[${renderedValues.join(", ")}]`;
  const itemIndent = `${indent}  `;
  return `[${newline}${renderedValues.map((value) => `${itemIndent}${value},`).join(newline)}${newline}${indent}]`;
};

const insertIntoExactTable = ({ source, nextTableStatement, setting, newline }) => {
  const insertionOffset = nextTableStatement?.start ?? source.length;
  let before = source.slice(0, insertionOffset);
  const after = source.slice(insertionOffset);
  if (!before.endsWith("\n") && !before.endsWith("\r")) before += newline;
  before += `${setting}${newline}`;
  if (after && !after.startsWith("\n") && !after.startsWith("\r")) before += newline;
  return `${before}${after}`;
};

/**
 * Produces a minimal TOML rewrite while leaving every unrelated statement
 * byte-for-byte intact. Unsupported representations fail closed so Trelio can
 * show a manual next step instead of risking a broken client configuration.
 */
export const buildCodexRoutingConfigPatch = (source) => {
  const newline = source.includes("\r\n") ? "\r\n" : "\n";
  const statements = scanTomlStatements(source);
  let currentTablePath = [];
  const exactTableStatements = [];
  const tableStatements = [];
  const assignments = [];
  const legacyCodeModeAssignments = [];
  let featuresStructureConflict = false;
  let implicitCodeModeDottedKey = false;

  for (const statement of statements) {
    const statementCode = stripTrailingTomlComment(statement.text).trim();
    const tablePath = parseTablePath(statement.text);
    if (statementCode.startsWith("[") && statementCode.endsWith("]")) {
      // An array or malformed table is still a section boundary even though
      // this focused editor deliberately does not interpret its contents.
      currentTablePath = tablePath;
      tableStatements.push({ ...statement, tablePath });
      if (tablePath && keyPathEquals(tablePath, ["features", "code_mode"])) {
        exactTableStatements.push(statement);
      } else if (
        !tablePath
        && /features/iu.test(statementCode)
        && /code_mode/iu.test(statementCode)
      ) {
        failUnsupported("features.code_mode использует неподдерживаемый table header.");
      }
      continue;
    }
    const assignment = readAssignment(statement.text);
    if (!assignment) {
      if (statementCode.includes("direct_only_tool_namespaces")) {
        failUnsupported(`${TARGET_CONFIG_KEY} записан в неподдерживаемой форме.`);
      }
      continue;
    }
    const effectiveKeyPath = currentTablePath
      ? [...currentTablePath, ...assignment.keyPath]
      : null;
    if (!effectiveKeyPath) {
      if (statementCode.includes("direct_only_tool_namespaces")) {
        failUnsupported(`${TARGET_CONFIG_KEY} записан в неподдерживаемой table.`);
      }
      continue;
    }
    if (keyPathEquals(effectiveKeyPath, ["features"])) {
      // An inline/scalar `features` value seals the namespace and cannot safely
      // coexist with the Code Mode table we may need to add.
      featuresStructureConflict = true;
    }
    if (keyPathEquals(effectiveKeyPath, ["features", "code_mode"])) {
      legacyCodeModeAssignments.push({ ...statement, ...assignment });
    }
    if (
      !keyPathEquals(currentTablePath, ["features", "code_mode"])
      && effectiveKeyPath.length > 2
      && effectiveKeyPath[0] === "features"
      && effectiveKeyPath[1] === "code_mode"
      && !keyPathEquals(effectiveKeyPath, [
        "features",
        "code_mode",
        "direct_only_tool_namespaces",
      ])
    ) implicitCodeModeDottedKey = true;
    if (keyPathEquals(effectiveKeyPath, [
      "features",
      "code_mode",
      "direct_only_tool_namespaces",
    ])) {
      assignments.push({ ...statement, ...assignment });
    }
  }

  if (
    assignments.length > 1
    || exactTableStatements.length > 1
    || legacyCodeModeAssignments.length > 1
  ) {
    failUnsupported(`${TARGET_CONFIG_KEY} или его table объявлены больше одного раза.`);
  }
  if (featuresStructureConflict) {
    failUnsupported("features уже задан как scalar или inline table.");
  }
  if (legacyCodeModeAssignments.length && (exactTableStatements.length || assignments.length)) {
    failUnsupported("features.code_mode одновременно задан в legacy- и table-форме.");
  }
  if (assignments.length === 1) {
    const assignment = assignments[0];
    const parsed = parseStringArray(assignment.text, assignment.equalsIndex);
    const present = new Set(parsed.values.map(({ comparable }) => comparable));
    const missingNamespaces = CODEX_TRELIO_DIRECT_TOOL_NAMESPACES.filter(
      (namespace) => !present.has(namespace),
    );
    if (missingNamespaces.length === 0) {
      return { status: "ready", missingNamespaces, nextSource: source };
    }
    const assignmentPrefix = assignment.text.slice(0, parsed.valueStart);
    const indent = assignmentPrefix.match(/^\s*/u)?.[0]?.replace(/[\r\n]/gu, "") || "";
    const multiline = assignment.text.slice(parsed.valueStart, parsed.closingIndex).includes("\n");
    const renderedArray = renderMergedArray({
      values: parsed.values,
      missingNamespaces,
      multiline,
      newline,
      indent,
    });
    const replacement = `${assignmentPrefix}${renderedArray}${parsed.suffix}`;
    return {
      status: "action_required",
      missingNamespaces,
      migratesLegacyBoolean: false,
      nextSource: `${source.slice(0, assignment.start)}${replacement}${source.slice(assignment.end)}`,
    };
  }

  if (implicitCodeModeDottedKey) {
    failUnsupported("features.code_mode уже создан dotted key без явного table.");
  }
  if (tableStatements.some(({ tablePath }) => (
    tablePath?.length > 2
    && tablePath[0] === "features"
    && tablePath[1] === "code_mode"
  ))) {
    failUnsupported("features.code_mode уже имеет дочерние table без явного родительского table.");
  }

  const setting = `direct_only_tool_namespaces = ${JSON.stringify(CODEX_TRELIO_DIRECT_TOOL_NAMESPACES)}`;
  let nextSource;
  let migratesLegacyBoolean = false;
  if (legacyCodeModeAssignments.length === 1) {
    const legacyAssignment = legacyCodeModeAssignments[0];
    const legacy = parseLegacyCodeModeBoolean(
      legacyAssignment.text,
      legacyAssignment.equalsIndex,
    );
    let prefix = `${source.slice(0, legacyAssignment.start)}${source.slice(legacyAssignment.end)}`;
    if (prefix && !prefix.endsWith("\n") && !prefix.endsWith("\r")) prefix += newline;
    if (prefix && !prefix.endsWith(`${newline}${newline}`)) prefix += newline;
    nextSource = `${prefix}[features.code_mode]${newline}`
      + `enabled = ${legacy.value}${legacy.trailingComment}${newline}`
      + `${setting}${newline}`;
    migratesLegacyBoolean = true;
  } else if (exactTableStatements.length === 1) {
    const tableStatement = exactTableStatements[0];
    const tableIndex = tableStatements.findIndex(({ start }) => start === tableStatement.start);
    nextSource = insertIntoExactTable({
      source,
      nextTableStatement: tableStatements[tableIndex + 1],
      setting,
      newline,
    });
  } else {
    let prefix = source;
    if (prefix && !prefix.endsWith("\n") && !prefix.endsWith("\r")) prefix += newline;
    if (prefix && !prefix.endsWith(`${newline}${newline}`)) prefix += newline;
    nextSource = `${prefix}[features.code_mode]${newline}${setting}${newline}`;
  }
  return {
    status: "action_required",
    missingNamespaces: [...CODEX_TRELIO_DIRECT_TOOL_NAMESPACES],
    migratesLegacyBoolean,
    nextSource,
  };
};

const readCodexConfig = async (configPath, filesystem = fs) => {
  let metadata;
  try {
    metadata = await filesystem.lstat(configPath);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return {
        exists: false,
        bytes: Buffer.alloc(0),
        source: "",
        mode: 0o600,
      };
    }
    throw new CodexRoutingConfigError(
      "TRELIO_CODEX_ROUTING_CONFIG_UNREADABLE",
      "Не удалось проверить пользовательский config.toml Codex.",
    );
  }
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new CodexRoutingConfigError(
      "TRELIO_CODEX_ROUTING_CONFIG_UNSAFE",
      "Пользовательский config.toml Codex должен быть обычным файлом, не ссылкой.",
    );
  }
  if (metadata.size > MAX_CODEX_CONFIG_BYTES) {
    throw new CodexRoutingConfigError(
      "TRELIO_CODEX_ROUTING_CONFIG_TOO_LARGE",
      "Пользовательский config.toml Codex превышает безопасный лимит 1 MiB.",
    );
  }
  let bytes;
  try {
    bytes = await filesystem.readFile(configPath);
  } catch {
    throw new CodexRoutingConfigError(
      "TRELIO_CODEX_ROUTING_CONFIG_UNREADABLE",
      "Не удалось прочитать пользовательский config.toml Codex.",
    );
  }
  if (bytes.byteLength > MAX_CODEX_CONFIG_BYTES) {
    throw new CodexRoutingConfigError(
      "TRELIO_CODEX_ROUTING_CONFIG_TOO_LARGE",
      "Пользовательский config.toml Codex превышает безопасный лимит 1 MiB.",
    );
  }
  if (!isUtf8(bytes) || bytes.includes(0)) {
    throw new CodexRoutingConfigError(
      "TRELIO_CODEX_ROUTING_CONFIG_INVALID_ENCODING",
      "Пользовательский config.toml Codex должен быть UTF-8 без NUL bytes.",
    );
  }
  const hasBom = bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]));
  return {
    exists: true,
    bytes,
    source: bytes.subarray(hasBom ? 3 : 0).toString("utf8"),
    bom: hasBom,
    mode: metadata.mode & 0o777,
  };
};

const buildPlanHash = ({ configPath, currentSha256, nextSha256 }) => sha256(JSON.stringify({
  schemaVersion: 1,
  operation: "configure_codex_trelio_direct_tool_routing",
  configPath: path.resolve(configPath),
  currentSha256,
  nextSha256,
  requiredNamespaces: CODEX_TRELIO_DIRECT_TOOL_NAMESPACES,
}));

const buildPublicPlan = ({ patch, planHash = null }) => ({
  schemaVersion: 1,
  status: patch.status,
  client: "codex",
  configTarget: "codex_user_config",
  requiredNamespaces: [...CODEX_TRELIO_DIRECT_TOOL_NAMESPACES],
  missingNamespaces: patch.missingNamespaces,
  change: patch.status === "action_required"
    ? {
        table: "features.code_mode",
        key: "direct_only_tool_namespaces",
        add: patch.missingNamespaces,
        preservesExistingNamespaces: true,
        preservesCodeModeEnabledState: true,
        migratesLegacyBoolean: patch.migratesLegacyBoolean === true,
      }
    : null,
  planHash,
  restartRequired: patch.status === "action_required",
  verification: patch.status === "action_required"
    ? "После apply полностью перезапустите Codex/ChatGPT, начните новую задачу и повторите одно защищённое чтение Trelio."
    : "Пользовательский config Codex уже закрепляет Trelio MCP за direct routing; итог проверяет защищённое чтение в текущей задаче.",
});

const prepareCodexRoutingPlan = async ({
  configPath = resolveCodexConfigPath(),
  filesystem = fs,
} = {}) => {
  const state = await readCodexConfig(configPath, filesystem);
  const patch = buildCodexRoutingConfigPatch(state.source);
  const nextBytes = Buffer.concat([
    ...(state.bom ? [Buffer.from([0xef, 0xbb, 0xbf])] : []),
    Buffer.from(patch.nextSource, "utf8"),
  ]);
  const currentSha256 = sha256(state.bytes);
  const nextSha256 = sha256(nextBytes);
  const planHash = patch.status === "action_required"
    ? buildPlanHash({ configPath, currentSha256, nextSha256 })
    : null;
  return {
    configPath,
    state,
    patch,
    nextBytes,
    currentSha256,
    nextSha256,
    planHash,
    publicPlan: buildPublicPlan({ patch, planHash }),
  };
};

export const planCodexTrelioHookRouting = async (options = {}) => (
  (await prepareCodexRoutingPlan(options)).publicPlan
);

const writeCodexConfigAtomically = async ({
  prepared,
  filesystem = fs,
}) => {
  const directory = path.dirname(prepared.configPath);
  await filesystem.mkdir(directory, { recursive: true, mode: 0o700 });
  const temporaryPath = path.join(
    directory,
    `.config.toml.trelio-${process.pid}-${crypto.randomUUID()}.tmp`,
  );
  let handle = null;
  try {
    handle = await filesystem.open(temporaryPath, "wx", prepared.state.mode || 0o600);
    await handle.writeFile(prepared.nextBytes);
    await handle.sync();
    await handle.close();
    handle = null;
    if (process.platform !== "win32") {
      await filesystem.chmod(temporaryPath, prepared.state.mode || 0o600);
    }

    // The plan hash is content-bound, and this second read narrows the only
    // non-atomic filesystem race to the final rename. We never overwrite a
    // config that already changed between the user's confirmation and apply.
    const current = await readCodexConfig(prepared.configPath, filesystem);
    if (
      current.exists !== prepared.state.exists
      || sha256(current.bytes) !== prepared.currentSha256
    ) {
      throw new CodexRoutingConfigError(
        "TRELIO_CODEX_ROUTING_PLAN_STALE",
        "config.toml изменился после plan; перечитайте новый plan и подтвердите его отдельно.",
      );
    }
    await filesystem.rename(temporaryPath, prepared.configPath);
  } catch (error) {
    if (error instanceof CodexRoutingConfigError) throw error;
    throw new CodexRoutingConfigError(
      "TRELIO_CODEX_ROUTING_WRITE_FAILED",
      "Не удалось безопасно записать пользовательский config.toml Codex.",
    );
  } finally {
    if (handle) await handle.close().catch(() => undefined);
    await filesystem.rm(temporaryPath, { force: true }).catch(() => undefined);
  }
};

export const applyCodexTrelioHookRouting = async ({
  planHash,
  confirmed,
  configPath = resolveCodexConfigPath(),
  filesystem = fs,
} = {}) => {
  if (confirmed !== true) {
    throw new CodexRoutingConfigError(
      "TRELIO_CODEX_ROUTING_CONFIRMATION_REQUIRED",
      "Apply разрешён только после отдельного явного подтверждения показанного planHash.",
    );
  }
  if (!SHA256_PATTERN.test(String(planHash || ""))) {
    throw new CodexRoutingConfigError(
      "TRELIO_CODEX_ROUTING_PLAN_INVALID",
      "planHash должен содержать exact SHA-256 из read-only plan.",
    );
  }

  const prepared = await prepareCodexRoutingPlan({ configPath, filesystem });
  if (prepared.patch.status === "ready") {
    return {
      ...prepared.publicPlan,
      status: "already_ready",
      restartRequired: false,
    };
  }
  if (prepared.planHash !== planHash) {
    throw new CodexRoutingConfigError(
      "TRELIO_CODEX_ROUTING_PLAN_STALE",
      "config.toml не совпадает с подтверждённым planHash; подготовьте новый plan.",
    );
  }

  await writeCodexConfigAtomically({ prepared, filesystem });
  const verified = await prepareCodexRoutingPlan({ configPath, filesystem });
  if (verified.patch.status !== "ready") {
    throw new CodexRoutingConfigError(
      "TRELIO_CODEX_ROUTING_WRITE_FAILED",
      "Настройка записана, но read-back не подтвердил оба Trelio namespace.",
    );
  }
  return {
    schemaVersion: 1,
    status: "applied",
    client: "codex",
    configTarget: "codex_user_config",
    addedNamespaces: prepared.patch.missingNamespaces,
    requiredNamespaces: [...CODEX_TRELIO_DIRECT_TOOL_NAMESPACES],
    restartRequired: true,
    verification: "Полностью перезапустите Codex/ChatGPT, начните новую задачу и повторите одно защищённое чтение Trelio.",
  };
};
