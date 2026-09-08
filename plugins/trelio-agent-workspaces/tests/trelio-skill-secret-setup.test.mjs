import assert from "node:assert/strict";
import test from "node:test";
import { readSkillSecretSetupCommand, deliverSkillSetupEnvironment } from "../scripts/trelio-skill-secret-setup.mjs";

const command = { id: "configure", arguments: ["configure"], bindingKey: "service_token",
  fieldKey: "value", environmentVariable: "TRELIO_TEST_SETUP_TOKEN" };
const packageWith = (commands, extra = {}) => ({ capabilities: ["secret-checkout"], files: [{
  path: "trelio-secret-setup.json", bytes: Buffer.from(JSON.stringify({ schemaVersion: 1, commands, ...extra })),
}] });

test("setup declaration permits only complete signed argument vectors", () => {
  assert.deepEqual(readSkillSecretSetupCommand(packageWith([command]), ["configure"]), command);
  assert.equal(readSkillSecretSetupCommand(packageWith([command]), ["configure", "--export"]), null);
  assert.equal(readSkillSecretSetupCommand(packageWith([command]), ["query"]), null);
  for (const descriptor of [
    packageWith([command, command]), packageWith([command], { wildcard: true }),
    packageWith([{ ...command, arguments: ["configure", "*"] }]),
    packageWith([{ ...command, environmentVariable: "NODE_OPTIONS" }]),
    packageWith([{ ...command, environmentVariable: "TRELIO_SKILL_CONNECTION_CONFIG_JSON" }]),
    packageWith([{ ...command, environmentVariable: "TRELIO_ORIGIN" }]),
    { ...packageWith([command]), capabilities: [] },
  ]) assert.throws(() => readSkillSecretSetupCommand(descriptor, ["configure"]));
});

test("setup delivery rejects changed identity/config/env and never retries or leaks an error value", async () => {
  const inputs = { origin: "https://example.test", token: "fixture-token", command,
    companyId: "company", projectId: null, skillId: "synthetic-skill", releaseId: "release", runtimeSessionId: "session",
    resolution: { companyConnection: { id: "connection", configured: true, config: { baseUrl: "https://example.com/" } },
      localIdentity: { memberId: "member", connectionId: "connection" },
      artifact: { id: "artifact", packageSha256: "a".repeat(64) } } };
  let calls = 0;
  for (const override of [{}, { connectionId: "other" }, { memberId: "other" }, { configSha256: "0".repeat(64) },
    { environmentVariable: "TRELIO_ORIGIN" }, { packageSha256: "b".repeat(64) }]) {
    const request = async (_origin, _token, _path, options) => {
      calls += 1;
      const body = JSON.parse(options.body);
      assert.equal(body.secretId, undefined);
      assert.equal(body.runId, undefined);
      return { json: async () => ({ schemaVersion: 1, companyId: inputs.companyId, memberId: "member", releaseId: "release",
        artifactId: "artifact", packageSha256: "a".repeat(64), connectionId: "connection", configSha256: body.configSha256,
        commandId: command.id, environmentVariable: command.environmentVariable, value: "fixture-sensitive-value", ...override }) };
    };
    if (!Object.keys(override).length) {
      assert.deepEqual(await deliverSkillSetupEnvironment({ ...inputs, request }), { TRELIO_TEST_SETUP_TOKEN: "fixture-sensitive-value" });
    } else await assert.rejects(deliverSkillSetupEnvironment({ ...inputs, request }), (error) => {
      assert.ok(!error.message.includes("fixture-sensitive-value"));
      return true;
    });
  }
  assert.equal(calls, 6);
});
