import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  RemoteMcpHostError,
  assertExactReadOnlyToolList,
  buildRemoteMcpRequestHeaders,
  doctorWithCredential,
  fingerprintRemoteMcpConfig,
  handleLocalMcpMessage,
  resolveRemoteMcpCredentialFile,
  resolveSafeRemoteMcpEndpoint,
  validateResolvedRemoteMcp,
} from "../scripts/trelio-remote-mcp.mjs";

const companyId = "11111111-1111-4111-8111-111111111111";
const memberId = "22222222-2222-4222-8222-222222222222";
const releaseId = "33333333-3333-4333-8333-333333333333";

const dodoConfig = {
  schemaVersion: 1,
  transport: "streamable_http",
  endpoint: "https://knowledgebase.dodois.io/mcp",
  protocolVersion: "2025-03-26",
  authentication: { type: "personal_bearer_pat" },
  allowedTools: [
    "current_user",
    "get_announcements",
    "get_content",
    "get_space_content",
    "get_spaces",
    "preview_content",
    "search_content",
  ],
  headers: {},
  credentialHelp: {
    url: "https://dodopizza.info/next/settings/mcp-tokens",
    label: "Получить персональный токен",
    instructions: "Создайте токен и введите его в локальной защищённой форме.",
  },
};

const resolvedDodo = {
  releaseId,
  skill: {
    id: "dodo-knowledge-base",
    title: "База знаний Додо",
    version: "1.0.0",
  },
  localIdentity: {
    companyId,
    projectId: null,
    memberId,
    skillId: "dodo-knowledge-base",
  },
  remoteMcp: {
    config: dodoConfig,
    configFingerprint: fingerprintRemoteMcpConfig(dodoConfig),
    minimumHostVersion: "1.4.2",
  },
};

const dodoTools = dodoConfig.allowedTools.map((name) => ({
  name,
  description: `${name} description`,
  inputSchema: { type: "object" },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
  },
}));

test("Remote MCP declaration accepts the exact Dodo read-only contract", () => {
  const validated = validateResolvedRemoteMcp(resolvedDodo);

  assert.deepEqual(validated.remoteMcp.config.allowedTools, dodoConfig.allowedTools);
  assert.equal(
    validated.remoteMcp.config.credentialHelp.url,
    "https://dodopizza.info/next/settings/mcp-tokens",
  );
  assert.deepEqual(
    assertExactReadOnlyToolList(validated.remoteMcp.config, dodoTools),
    dodoTools,
  );
});

test("Remote MCP fingerprint matches the backend canonical JSON contract", () => {
  assert.equal(
    fingerprintRemoteMcpConfig({
      ...dodoConfig,
      allowedTools: ["current_user", "get_spaces", "search_content"],
      credentialHelp: {
        ...dodoConfig.credentialHelp,
        instructions: "Создайте токен и сохраните его через локальную защищённую форму.",
      },
    }),
    "7e4071d98b348290661d51fd3100cebb53e7186930efeeb6c1ab8ebab17068c8",
  );
});

test("Remote MCP declaration blocks unsafe headers and write-like tools", () => {
  const unsafeConfig = {
    ...dodoConfig,
    headers: { "Mcp-Mode": "Write" },
  };
  assert.throws(
    () => validateResolvedRemoteMcp({
      ...resolvedDodo,
      remoteMcp: {
        ...resolvedDodo.remoteMcp,
        config: unsafeConfig,
        configFingerprint: fingerprintRemoteMcpConfig(unsafeConfig),
      },
    }),
    (error) => (
      error instanceof RemoteMcpHostError
      && error.code === "REMOTE_MCP_UNSAFE_HEADER"
    ),
  );

  assert.throws(
    () => assertExactReadOnlyToolList(
      {
        ...dodoConfig,
        allowedTools: [...dodoConfig.allowedTools, "update_content"],
      },
      [...dodoTools, {
        name: "update_content",
        inputSchema: { type: "object" },
        annotations: { readOnlyHint: false },
      }],
    ),
    (error) => (
      error instanceof RemoteMcpHostError
      && error.code === "REMOTE_MCP_WRITE_TOOL_BLOCKED"
    ),
  );
});

test("Remote MCP doctor fails closed on an extra server tool", async () => {
  const requests = [];
  const fakeHttpRequest = async (request) => {
    requests.push(request);
    if (request.method === "DELETE") {
      return { message: null, sessionId: request.sessionId };
    }
    if (request.payload?.method === "initialize") {
      return {
        sessionId: "session-1",
        message: {
          jsonrpc: "2.0",
          id: request.payload.id,
          result: { protocolVersion: "2025-03-26", capabilities: {} },
        },
      };
    }
    if (request.payload?.method === "notifications/initialized") {
      return { sessionId: "session-1", message: null };
    }
    if (request.payload?.method === "tools/list") {
      return {
        sessionId: "session-1",
        message: {
          jsonrpc: "2.0",
          id: request.payload.id,
          result: {
            tools: [...dodoTools, {
              name: "delete_content",
              inputSchema: { type: "object" },
              annotations: { destructiveHint: true, readOnlyHint: false },
            }],
          },
        },
      };
    }
    throw new Error(`Unexpected request: ${JSON.stringify(request)}`);
  };

  await assert.rejects(
    doctorWithCredential(resolvedDodo, "personal-test-token", {
      httpRequest: fakeHttpRequest,
    }),
    (error) => (
      error instanceof RemoteMcpHostError
      && error.code === "REMOTE_MCP_ALLOWLIST_MISMATCH"
    ),
  );
  assert.equal(requests.at(-1).method, "DELETE");
});

test("Remote MCP doctor verifies initialize and exact allowlist", async () => {
  const methods = [];
  const fakeHttpRequest = async (request) => {
    methods.push(request.method === "DELETE" ? "DELETE" : request.payload?.method);
    if (request.method === "DELETE") {
      return { message: null, sessionId: request.sessionId };
    }
    if (request.payload?.method === "initialize") {
      return {
        sessionId: "session-2",
        message: {
          jsonrpc: "2.0",
          id: request.payload.id,
          result: { protocolVersion: "2025-03-26", capabilities: {} },
        },
      };
    }
    if (request.payload?.method === "notifications/initialized") {
      return { sessionId: "session-2", message: null };
    }
    return {
      sessionId: "session-2",
      message: {
        jsonrpc: "2.0",
        id: request.payload.id,
        result: { tools: dodoTools },
      },
    };
  };

  const result = await doctorWithCredential(resolvedDodo, "personal-test-token", {
    httpRequest: fakeHttpRequest,
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.tools.map(({ name }) => name), dodoConfig.allowedTools);
  assert.deepEqual(methods, [
    "initialize",
    "notifications/initialized",
    "tools/list",
    "DELETE",
  ]);
});

test("SSRF guard rejects private DNS answers and pins a public address", async () => {
  await assert.rejects(
    resolveSafeRemoteMcpEndpoint("https://knowledgebase.dodois.io/mcp", {
      lookup: async () => [{ address: "127.0.0.1", family: 4 }],
    }),
    (error) => (
      error instanceof RemoteMcpHostError
      && error.code === "REMOTE_MCP_SSRF_BLOCKED"
    ),
  );
  await assert.rejects(
    resolveSafeRemoteMcpEndpoint("https://knowledgebase.dodois.io/mcp", {
      lookup: async () => [{ address: "64:ff9b::7f00:1", family: 6 }],
    }),
    (error) => (
      error instanceof RemoteMcpHostError
      && error.code === "REMOTE_MCP_SSRF_BLOCKED"
    ),
  );

  const safe = await resolveSafeRemoteMcpEndpoint(
    "https://knowledgebase.dodois.io/mcp",
    {
      lookup: async () => [{ address: "203.0.113.10", family: 4 }],
      // TEST-NET is intentionally blocked in production. This explicit unit
      // test override never participates in the runtime request path.
      allowInsecureTestEndpoint: true,
    },
  );
  assert.equal(safe.address, "203.0.113.10");
});

test("request headers add only bearer auth and host-controlled MCP metadata", () => {
  const headers = buildRemoteMcpRequestHeaders({
    config: {
      ...dodoConfig,
      headers: { "x-client-name": "trelio" },
    },
    credential: "personal-test-token",
    body: Buffer.from("{}"),
    sessionId: "session-3",
  });

  assert.equal(headers.authorization, "Bearer personal-test-token");
  assert.equal(headers["mcp-protocol-version"], "2025-03-26");
  assert.equal(headers["mcp-session-id"], "session-3");
  assert.equal(headers["mcp-mode"], undefined);
  assert.equal(headers["mcp-write-spaces"], undefined);
});

test("personal credential path follows the stable local integration namespace", () => {
  const identity = resolvedDodo.localIdentity;
  assert.equal(
    resolveRemoteMcpCredentialFile(identity, {
      platform: "linux",
      environment: {},
      homeDirectory: "/home/alice",
    }),
    `/home/alice/.config/trelio/integrations/dodo-knowledge-base/${companyId}/${memberId}/remote-mcp/secrets/personal-credential.json`,
  );
  assert.equal(
    resolveRemoteMcpCredentialFile(identity, {
      platform: "win32",
      environment: { LOCALAPPDATA: "C:\\Users\\Alice\\AppData\\Local" },
      homeDirectory: "C:\\Users\\Alice",
    }),
    `C:\\Users\\Alice\\AppData\\Local\\Trelio\\integrations\\dodo-knowledge-base\\${companyId}\\${memberId}\\remote-mcp\\secrets\\personal-credential.json`,
  );
});

test("local MCP exposes only the four static trusted-host tools", async () => {
  const response = await handleLocalMcpMessage({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/list",
    params: {},
  });

  assert.deepEqual(response.result.tools.map(({ name }) => name), [
    "connect_remote_agent_skill",
    "doctor_remote_agent_skill",
    "call_remote_agent_skill_tool",
    "forget_remote_agent_skill_credential",
  ]);
  assert.doesNotMatch(JSON.stringify(response), /personal-test-token/u);
});

test("stdio host emits only newline-delimited JSON-RPC frames", async () => {
  const scriptPath = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../scripts/trelio-remote-mcp.mjs",
  );
  const child = spawn(process.execPath, [scriptPath], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  child.stdin.end([
    JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-03-26" },
    }),
    JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {},
    }),
    "",
  ].join("\n"));
  const exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });

  assert.equal(exitCode, 0, stderr);
  const frames = stdout.trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(frames.map(({ id }) => id), [1, 2]);
  assert.equal(frames[0].result.serverInfo.version, "1.4.2");
  assert.equal(frames[1].result.tools.length, 4);
});
