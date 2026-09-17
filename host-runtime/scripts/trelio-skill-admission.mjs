/**
 * Краткоживущий допуск к exact опубликованному Agent Skill. Это сознательная
 * отсрочка повторного server resolve, а не кэш содержимого внешнего сервиса.
 * Timestamp фиксирует начало проверки допуска и никогда не продлевается при чтении.
 * HMAC связывает запись с private bridge credential: редактирование JSON или
 * перенос записи между пользователями не создают новое разрешение.
 */
import crypto from "node:crypto";

export const SKILL_ADMISSION_TTL_MS = 12 * 60 * 60 * 1000;
export const SKILL_ADMISSION_MAX_BYTES = 256 * 1024;
export const SKILL_ADMISSION_MAX_ENTRIES = 64;

export const skillAdmissionKey = ({ origin, token, sessionId, kind, companyId,
  projectId = null, skillId, releaseId, hostVersion }) => {
  // Token никогда не сохраняется. Его keyed fingerprint отделяет namespace
  // после logout/re-pairing; sessionId дополнительно запрещает перенос допуска
  // в новую задачу даже при том же bridge device-session.
  if (!sessionId || !token) return null;
  return crypto.createHmac("sha256", token).update(JSON.stringify([
    "trelio-skill-admission/v1", origin, sessionId, kind, companyId,
    projectId, skillId, releaseId, hostVersion,
  ])).digest("hex");
};

const signedBytes = ({ key, verifiedAt, expiresAt, resolution }) => JSON.stringify({
  schemaVersion: 1, key, verifiedAt, expiresAt, resolution,
});

export const sealSkillAdmission = ({ key, token, resolution, now = Date.now() }) => {
  if (!key || !Number.isSafeInteger(now)) return null;
  const entry = { schemaVersion: 1, key, verifiedAt: now,
    expiresAt: now + SKILL_ADMISSION_TTL_MS, resolution: structuredClone(resolution) };
  const bytes = signedBytes(entry);
  if (Buffer.byteLength(bytes, "utf8") > SKILL_ADMISSION_MAX_BYTES - 256) return null;
  return { ...entry, mac: crypto.createHmac("sha256", token).update(bytes).digest("hex") };
};

export const openSkillAdmission = ({ entry, key, token, now = Date.now() }) => {
  if (!key || !entry || entry.schemaVersion !== 1 || entry.key !== key
    || !Number.isSafeInteger(entry.verifiedAt) || !Number.isSafeInteger(entry.expiresAt)
    || entry.expiresAt !== entry.verifiedAt + SKILL_ADMISSION_TTL_MS
    || now < entry.verifiedAt || now >= entry.expiresAt
    || !/^[0-9a-f]{64}$/u.test(String(entry.mac || ""))) return null;
  const bytes = signedBytes(entry);
  if (Buffer.byteLength(bytes, "utf8") > SKILL_ADMISSION_MAX_BYTES - 256) return null;
  const expected = crypto.createHmac("sha256", token).update(bytes).digest();
  if (!crypto.timingSafeEqual(expected, Buffer.from(entry.mac, "hex"))) return null;
  // Каждый caller получает собственный объект: hydration/normalization не могут
  // незаметно записать plaintext или parsed package обратно в исходный snapshot.
  return structuredClone(entry.resolution);
};

/** Plaintext private E2EE declarations must never enter this disk/memory cache. */
export const canCacheSkillAdmission = (resolution) => {
  const text = JSON.stringify(resolution);
  return !text.includes("company_e2ee_v1") && !text.includes("~e1:");
};
