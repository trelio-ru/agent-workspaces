import assert from "node:assert/strict";
import test from "node:test";
import {
  SKILL_ADMISSION_TTL_MS, SKILL_ADMISSION_MAX_BYTES,
  canCacheSkillAdmission, openSkillAdmission, sealSkillAdmission, skillAdmissionKey,
} from "../scripts/trelio-skill-admission.mjs";

const context = { origin: "https://trelio.example", token: "synthetic-device-token",
  sessionId: "session-a", kind: "runtime", companyId: "company-a", projectId: null,
  skillId: "test-runtime", releaseId: "release-a", hostVersion: "2.0.6" };
const key = skillAdmissionKey(context);
const at = 1_800_000_000_000;
const resolution = { releaseId: context.releaseId, artifact: { contentProtection: "plain" } };
const entry = sealSkillAdmission({ key, token: context.token, resolution, now: at });
const open = (overrides = {}) => openSkillAdmission({ entry, key, token: context.token, now: at, ...overrides });

test("admission has an absolute twelve-hour boundary without sliding renewal or clock rollback", () => {
  assert.equal(SKILL_ADMISSION_TTL_MS, 43_200_000);
  assert.deepEqual(open(), resolution);
  assert.deepEqual(open({ now: at + SKILL_ADMISSION_TTL_MS - 1 }), resolution);
  assert.equal(open({ now: at + SKILL_ADMISSION_TTL_MS }), null);
  assert.equal(open({ now: at - 1 }), null);
  assert.equal(entry.verifiedAt, at);
  assert.equal(entry.expiresAt, at + SKILL_ADMISSION_TTL_MS);
  const copy = open(); copy.releaseId = "changed";
  assert.deepEqual(open(), resolution);
});

test("another identity, scope, session, host or release cannot inherit a positive admission", () => {
  for (const field of Object.keys(context)) {
    const changed = { ...context, [field]: `${context[field]}-other` };
    assert.equal(open({ key: skillAdmissionKey(changed), token: changed.token }), null, field);
  }
  assert.equal(skillAdmissionKey({ ...context, sessionId: null }), null);
  assert.equal(open({ token: "other-user-device-token" }), null);
});

test("editing access metadata, expiry or payload cannot forge an admission", () => {
  for (const change of [
    { expiresAt: entry.expiresAt + 1 }, { verifiedAt: at - 1 },
    { resolution: { ...resolution, allow: true } }, { schemaVersion: 2 },
    { mac: "00".repeat(32) }, { key: "other" },
  ]) assert.equal(open({ entry: { ...entry, ...change } }), null);
  assert.equal(open({ entry: {} }), null);
  assert.equal(open({ entry: null }), null);
  assert.equal(sealSkillAdmission({ key, token: context.token, now: at,
    resolution: { large: "x".repeat(SKILL_ADMISSION_MAX_BYTES) } }), null);
  assert.ok(!JSON.stringify(entry).includes(context.token));
});

test("encrypted declarations and encrypted connection markers are never cached as plaintext", () => {
  assert.equal(canCacheSkillAdmission(resolution), true);
  assert.equal(canCacheSkillAdmission({ remoteMcp: { contentProtection: "company_e2ee_v1", config: { title: "private" } } }), false);
  assert.equal(canCacheSkillAdmission({ companyConnection: { config: "~e1:opaque:config_json~" } }), false);
});
