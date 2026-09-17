import { isUtf8 } from "node:buffer";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";

// This module is intentionally the complete executable dependency surface of
// the stable plugin loader. Domain logic, bridge commands and search behavior
// live in the independently signed host-runtime package.
export const PLUGIN_VERSION = "2.3.1";

const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const STABLE_VERSION_PATTERN = /^\d+\.\d+\.\d+$/u;
const SKILL_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const PACKAGE_FORMAT = "trelio-agent-skill-package/v1";
const MAX_PACKAGE_BYTES = 64 * 1024 * 1024;
const MAX_DECODED_FILE_BYTES = 48 * 1024 * 1024;
const MAX_FILE_COUNT = 100;
const ALLOWED_CAPABILITIES = new Set([
  "browser",
  "local-session",
  "network",
  "secret-checkout",
]);
const WINDOWS_RESERVED_PATH_PATTERN =
  /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu;

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
      throw new Error(`${label} превышает допустимый размер ${maximumBytes} байт.`);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, totalBytes);
};

const normalizePackagePath = (rawValue) => {
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
      || WINDOWS_RESERVED_PATH_PATTERN.test(segment)
    ))
  ) {
    throw new Error(`Путь runtime package "${rawPath}" не нормализован.`);
  }
  return normalizedPath;
};

const decodeCanonicalBase64 = (value, label) => {
  const normalizedValue = String(value || "");
  if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(normalizedValue)) {
    throw new Error(`${label} содержит некорректный base64.`);
  }
  const bytes = Buffer.from(normalizedValue, "base64");
  const canonical = (candidate) => String(candidate || "").replace(/=+$/u, "");
  if (canonical(bytes.toString("base64")) !== canonical(normalizedValue)) {
    throw new Error(`${label} содержит неканонический base64.`);
  }
  return bytes;
};

export const parseAndValidateHostRuntimePackage = (
  packageBytes,
  expectedSkillId,
) => {
  if (
    !Buffer.isBuffer(packageBytes)
    || packageBytes.byteLength <= 0
    || packageBytes.byteLength > MAX_PACKAGE_BYTES
    || !isUtf8(packageBytes)
  ) {
    throw new Error("Host runtime package имеет некорректный размер или кодировку.");
  }

  let runtimePackage;
  try {
    runtimePackage = JSON.parse(packageBytes.toString("utf8"));
  } catch {
    throw new Error("Host runtime package должен содержать корректный UTF-8 JSON.");
  }

  const skillId = String(runtimePackage?.skill?.id || "");
  const runtimeVersion = String(runtimePackage?.skill?.runtimeVersion || "");
  const entrypointPath = normalizePackagePath(runtimePackage?.entrypoint?.path);
  const interpreter = String(runtimePackage?.entrypoint?.interpreter || "");
  const capabilities = Array.isArray(runtimePackage?.capabilities)
    ? runtimePackage.capabilities.map(String)
    : [];
  const files = runtimePackage?.files;

  if (runtimePackage?.format !== PACKAGE_FORMAT) throw new Error("Host runtime package использует неподдерживаемый format.");
  if (!SKILL_ID_PATTERN.test(skillId) || skillId !== expectedSkillId) throw new Error("Host runtime package принадлежит другой runtime identity.");
  if (!STABLE_VERSION_PATTERN.test(runtimeVersion)) throw new Error("Host runtime package version должна использовать формат X.Y.Z.");
  if (!["node", "python", "executable"].includes(interpreter)) throw new Error("Host runtime package содержит неподдерживаемый interpreter.");
  if (capabilities.length !== new Set(capabilities).size || capabilities.some((item) => !ALLOWED_CAPABILITIES.has(item))) {
    throw new Error("Host runtime package содержит неизвестные или повторяющиеся capabilities.");
  }
  if (!Array.isArray(files) || files.length === 0 || files.length > MAX_FILE_COUNT) {
    throw new Error(`Host runtime package должен содержать от 1 до ${MAX_FILE_COUNT} файлов.`);
  }

  const seenPaths = new Set();
  const portablePaths = new Set();
  const parsedFiles = [];
  let decodedBytes = 0;
  for (const file of files) {
    const filePath = normalizePackagePath(file?.path);
    const portablePath = filePath.toLocaleLowerCase("en-US");
    const mode = Number(file?.mode);
    if (seenPaths.has(filePath) || portablePaths.has(portablePath)) throw new Error(`Host runtime package повторяет путь ${filePath}.`);
    if (mode !== 0o644 && mode !== 0o755) throw new Error(`Host runtime package использует небезопасный mode для ${filePath}.`);
    if (!SHA256_PATTERN.test(String(file?.sha256 || ""))) throw new Error(`Host runtime package содержит некорректный SHA-256 для ${filePath}.`);
    const bytes = decodeCanonicalBase64(file?.contentBase64, `Host runtime package file ${filePath}`);
    decodedBytes += bytes.byteLength;
    if (decodedBytes > MAX_DECODED_FILE_BYTES) throw new Error(`Host runtime package files превышают ${MAX_DECODED_FILE_BYTES} байт.`);
    if (crypto.createHash("sha256").update(bytes).digest("hex") !== file.sha256) {
      throw new Error(`Host runtime package file ${filePath} не прошёл SHA-256 проверку.`);
    }
    seenPaths.add(filePath);
    portablePaths.add(portablePath);
    parsedFiles.push({ path: filePath, mode, sha256: file.sha256, bytes });
  }
  if (!seenPaths.has(entrypointPath)) throw new Error(`Entrypoint ${entrypointPath} отсутствует в host runtime package.`);
  if (interpreter === "executable" && parsedFiles.find((file) => file.path === entrypointPath)?.mode !== 0o755) {
    throw new Error(`Executable entrypoint ${entrypointPath} должен иметь mode 0755.`);
  }
  return {
    skillId,
    runtimeVersion,
    entrypoint: { path: entrypointPath, interpreter },
    capabilities,
    files: parsedFiles,
    packageSha256: crypto.createHash("sha256").update(packageBytes).digest("hex"),
    packageSizeBytes: packageBytes.byteLength,
  };
};
