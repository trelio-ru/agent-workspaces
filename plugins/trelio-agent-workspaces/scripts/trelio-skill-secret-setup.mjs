import crypto from "node:crypto";
import { canonicalJson } from "./trelio-company-encryption.mjs";

export const SKILL_SECRET_SETUP_FILE = "trelio-secret-setup.json";
const invalid = () => new Error("Подписанная декларация настройки навыка недействительна.");
const exactKeys = (value, keys) => value && typeof value === "object" && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));

/** Read only the bytes whose package signature and per-file hashes were verified. */
export const readSkillSecretSetupCommand = (parsedPackage, runtimeArguments) => {
  const file = parsedPackage.files.find((item) => item.path === SKILL_SECRET_SETUP_FILE);
  if (!file) return null;
  if (file.bytes.length > 16 * 1024 || !parsedPackage.capabilities.includes("secret-checkout")) throw invalid();
  let descriptor;
  try { descriptor = JSON.parse(file.bytes.toString("utf8")); } catch { throw invalid(); }
  if (!exactKeys(descriptor, ["schemaVersion", "commands"]) || descriptor.schemaVersion !== 1
    || !Array.isArray(descriptor.commands) || !descriptor.commands.length || descriptor.commands.length > 8) throw invalid();
  const ids = new Set();
  const argumentSets = new Set();
  for (const command of descriptor.commands) {
    if (!exactKeys(command, ["id", "arguments", "bindingKey", "fieldKey", "environmentVariable"])
      || typeof command.id !== "string" || !/^[a-z][a-z0-9-]{0,47}$/u.test(command.id)
      || !Array.isArray(command.arguments) || !command.arguments.length || command.arguments.length > 8
      || command.arguments.some((arg) => typeof arg !== "string" || !/^[a-zA-Z0-9_-]{1,80}$/u.test(arg))
      || [command.bindingKey, command.fieldKey].some((key) => typeof key !== "string" || !/^[a-z][a-z0-9_]{0,63}$/u.test(key))
      || typeof command.environmentVariable !== "string" || !/^TRELIO_[A-Z0-9_]{1,100}$/u.test(command.environmentVariable)
      || command.environmentVariable.startsWith("TRELIO_SKILL_")
      || ["TRELIO_CONFIG_HOME", "TRELIO_CACHE_HOME", "TRELIO_ORIGIN"].includes(command.environmentVariable)
      || ids.has(command.id) || argumentSets.has(JSON.stringify(command.arguments))) throw invalid();
    ids.add(command.id);
    argumentSets.add(JSON.stringify(command.arguments));
  }
  return descriptor.commands.find((command) => JSON.stringify(command.arguments) === JSON.stringify(runtimeArguments)) ?? null;
};

/**
 * A setup request cannot use an arbitrary secret id, executable, env name or
 * argument prefix. The server resolves them from its own signed package and
 * current connection. Never cache/print the response or retry a failed delivery.
 */
export const deliverSkillSetupEnvironment = async ({ request, origin, token, command, resolution,
  companyId, projectId, skillId, releaseId, runtimeSessionId }) => {
  const connection = resolution.companyConnection;
  const identity = resolution.localIdentity;
  if (!connection?.configured || !identity?.memberId || identity.connectionId !== connection.id) {
    throw new Error("Сначала настройте подключение навыка для компании.");
  }
  const configSha256 = crypto.createHash("sha256").update(canonicalJson(connection.config)).digest("hex");
  const expected = {
    schemaVersion: 1, companyId, memberId: identity.memberId, releaseId,
    artifactId: resolution.artifact.id, packageSha256: resolution.artifact.packageSha256,
    connectionId: connection.id, configSha256, commandId: command.id,
    environmentVariable: command.environmentVariable,
  };
  const response = await request(origin, token, "/api/agent-skills/runtime/setup-secret", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ companyId, projectId, skillId, expectedReleaseId: releaseId,
      artifactId: expected.artifactId, packageSha256: expected.packageSha256,
      connectionId: connection.id, configSha256, commandId: command.id, runtimeSessionId }),
  });
  const result = await response.json();
  if (!exactKeys(result, [...Object.keys(expected), "value"])
    || Object.entries(expected).some(([key, value]) => result[key] !== value)
    || typeof result.value !== "string" || !result.value.length
    || Buffer.byteLength(result.value, "utf8") > 64 * 1024 || result.value.includes("\0")) {
    // Never interpolate a malformed value-bearing response in an error.
    throw new Error("Trelio вернул несовпадающее разрешение настройки навыка.");
  }
  return { [command.environmentVariable]: result.value };
};
