import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  RemoteMcpHostError,
  assertExactReadOnlyToolList,
  buildRemoteMcpRequestHeaders,
  collectCredentialThroughLoopback,
  doctorWithCredential,
  fingerprintRemoteMcpConfig,
  handleLocalMcpMessage,
  openCredentialFormInBrowser,
  remoteMcpHttpRequest,
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
    minimumHostVersion: "1.4.3",
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

const listenOnLoopback = async (handler) => {
  const server = http.createServer(handler);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return server;
};

const closeTestServer = async (server) => {
  server.closeAllConnections();
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
};

const requestLoopback = async (rawUrl, {
  method = "GET",
  headers = {},
  body = "",
} = {}) => new Promise((resolve, reject) => {
  const request = http.request(rawUrl, { method, headers }, (response) => {
    const chunks = [];
    response.on("data", (chunk) => chunks.push(chunk));
    response.once("end", () => resolve({
      statusCode: response.statusCode,
      body: Buffer.concat(chunks).toString("utf8"),
    }));
  });
  request.once("error", reject);
  request.end(body);
});

const createPinnedLoopbackResolver = () => async (rawEndpoint) => ({
  endpoint: new URL(rawEndpoint),
  address: "127.0.0.1",
  family: 4,
});

test("Remote MCP browser handoff verifies the form GET and uses a private macOS fallback", async () => {
  const setupUrl = "http://127.0.0.1:45678/?nonce=must-stay-local";
  const attempts = [];
  let formOpened = false;

  await openCredentialFormInBrowser(setupUrl, {
    platform: "darwin",
    handoffTimeoutMs: 5,
    openBrowserFn: async (url, { application }) => {
      attempts.push({ url, application });
      if (application === "Google Chrome") {
        formOpened = true;
      }
    },
    waitForForm: async () => formOpened,
  });

  assert.deepEqual(
    attempts.map(({ application }) => application),
    [null, "Google Chrome"],
  );
  assert.deepEqual(
    attempts.map(({ url }) => url),
    [setupUrl, setupUrl],
    "the protected URL stays inside the verified opener callback",
  );
});

test("Remote MCP browser handoff fails safely without returning its nonce", async () => {
  const setupUrl = "http://127.0.0.1:45678/?nonce=must-not-leak";

  await assert.rejects(
    openCredentialFormInBrowser(setupUrl, {
      platform: "darwin",
      handoffTimeoutMs: 1,
      openBrowserFn: async () => {
        throw new Error("browser unavailable");
      },
      waitForForm: async () => false,
    }),
    (error) => (
      error instanceof RemoteMcpHostError
      && error.code === "REMOTE_MCP_BROWSER_OPEN_FAILED"
      && !error.message.includes(setupUrl)
      && !error.message.includes("must-not-leak")
    ),
  );
});

test("Remote MCP connect closes the loopback listener when browser opening fails", async () => {
  let listenerPort = null;

  await assert.rejects(
    collectCredentialThroughLoopback("https://trelio.test", resolvedDodo, {
      browserPlatform: "linux",
      handoffTimeoutMs: 1,
      openBrowserFn: async () => {
        throw new Error("xdg-open unavailable");
      },
      onListening: ({ port }) => {
        listenerPort = port;
      },
    }),
    (error) => (
      error instanceof RemoteMcpHostError
      && error.code === "REMOTE_MCP_BROWSER_OPEN_FAILED"
    ),
  );

  assert.equal(Number.isInteger(listenerPort), true);
  await new Promise((resolve, reject) => {
    const socket = net.connect({
      host: "127.0.0.1",
      port: listenerPort,
    });
    socket.once("connect", () => {
      socket.destroy();
      reject(new Error("loopback listener remained reachable after failed handoff"));
    });
    socket.once("error", (error) => {
      if (error.code === "ECONNREFUSED") {
        resolve();
        return;
      }
      reject(error);
    });
  });
});

test("Remote MCP loopback keeps nonce, Origin and content-type checks before persistence", async () => {
  const credential = "personal-test-token";
  const doctorCalls = [];
  const persistedCredentials = [];

  await collectCredentialThroughLoopback("https://trelio.test", resolvedDodo, {
    browserPlatform: "darwin",
    handoffTimeoutMs: 100,
    setupTimeoutMs: 500,
    doctorCredential: async (_resolved, candidate) => {
      doctorCalls.push(candidate);
    },
    persistCredential: async (_origin, _resolved, candidate) => {
      persistedCredentials.push(candidate);
    },
    openBrowserFn: async (setupUrl) => {
      const protectedUrl = new URL(setupUrl);
      const expectedOrigin = protectedUrl.origin;
      const nonce = protectedUrl.searchParams.get("nonce");

      const wrongNonceUrl = new URL(protectedUrl);
      wrongNonceUrl.searchParams.set("nonce", "wrong");
      assert.equal((await requestLoopback(wrongNonceUrl)).statusCode, 404);

      const page = await requestLoopback(protectedUrl);
      assert.equal(page.statusCode, 200);
      assert.doesNotMatch(page.body, new RegExp(credential, "u"));

      const formBody = new URLSearchParams({ nonce, credential }).toString();
      const wrongOrigin = await requestLoopback(`${expectedOrigin}/credential`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          origin: "http://127.0.0.1:1",
        },
        body: formBody,
      });
      assert.equal(wrongOrigin.statusCode, 404);
      assert.equal(doctorCalls.length, 0);

      const wrongContentType = await requestLoopback(`${expectedOrigin}/credential`, {
        method: "POST",
        headers: {
          "content-type": "text/plain",
          origin: expectedOrigin,
        },
        body: formBody,
      });
      assert.equal(wrongContentType.statusCode, 404);
      assert.equal(doctorCalls.length, 0);

      const accepted = await requestLoopback(`${expectedOrigin}/credential`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          origin: expectedOrigin,
        },
        body: formBody,
      });
      assert.equal(accepted.statusCode, 200);
    },
  });

  assert.deepEqual(doctorCalls, [credential]);
  assert.deepEqual(persistedCredentials, [credential]);
});

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

test("Remote MCP request completes on a matching SSE response without waiting for stream end", {
  timeout: 2_000,
}, async () => {
  let markStreamClosed;
  const streamClosed = new Promise((resolve) => {
    markStreamClosed = resolve;
  });
  const server = await listenOnLoopback((_request, response) => {
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "mcp-session-id": "session-sse",
    });
    response.write(": ready\n\n");
    response.write("event: message\n");
    response.write('data: {"jsonrpc":"2.0","id":1,"result":{"ok":true}}\n\n');
    const heartbeat = setInterval(() => response.write(": heartbeat\n\n"), 10);
    response.once("close", () => {
      clearInterval(heartbeat);
      markStreamClosed();
    });
  });

  try {
    const { port } = server.address();
    const startedAt = Date.now();
    const result = await remoteMcpHttpRequest({
      config: {
        ...dodoConfig,
        endpoint: `http://remote-mcp.test:${port}/mcp`,
      },
      credential: "personal-test-token",
      payload: {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {},
      },
    }, {
      // Production always uses resolveSafeRemoteMcpEndpoint. This injected
      // resolver only lets the regression exercise the real HTTP parser on a
      // local server while still verifying connection pinning.
      resolveEndpoint: createPinnedLoopbackResolver(),
      timeoutMs: 1_000,
    });

    assert.equal(result.sessionId, "session-sse");
    assert.deepEqual(result.message, {
      jsonrpc: "2.0",
      id: 1,
      result: { ok: true },
    });
    assert.ok(Date.now() - startedAt < 500);
    await streamClosed;
  } finally {
    await closeTestServer(server);
  }
});

test("Remote MCP absolute deadline is not extended by SSE heartbeats", {
  timeout: 2_000,
}, async () => {
  let markStreamClosed;
  const streamClosed = new Promise((resolve) => {
    markStreamClosed = resolve;
  });
  const server = await listenOnLoopback((_request, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(": ready\n\n");
    const heartbeat = setInterval(() => response.write(": heartbeat\n\n"), 10);
    response.once("close", () => {
      clearInterval(heartbeat);
      markStreamClosed();
    });
  });

  try {
    const { port } = server.address();
    const startedAt = Date.now();
    await assert.rejects(
      remoteMcpHttpRequest({
        config: {
          ...dodoConfig,
          endpoint: `http://remote-mcp.test:${port}/mcp`,
        },
        credential: "personal-test-token",
        payload: {
          jsonrpc: "2.0",
          id: 7,
          method: "tools/list",
          params: {},
        },
      }, {
        resolveEndpoint: createPinnedLoopbackResolver(),
        timeoutMs: 120,
      }),
      (error) => (
        error instanceof RemoteMcpHostError
        && error.code === "REMOTE_MCP_TIMEOUT"
      ),
    );
    const elapsedMs = Date.now() - startedAt;
    assert.ok(elapsedMs >= 100, `deadline fired too early after ${elapsedMs}ms`);
    assert.ok(elapsedMs < 600, `heartbeats extended deadline to ${elapsedMs}ms`);
    await streamClosed;
  } finally {
    await closeTestServer(server);
  }
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
  assert.equal(frames[0].result.serverInfo.version, "1.4.4");
  assert.equal(frames[1].result.tools.length, 4);
});
