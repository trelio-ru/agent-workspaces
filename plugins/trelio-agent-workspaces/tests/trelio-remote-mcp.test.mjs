import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  AGENT_SKILL_ROUTING_INSTRUCTIONS,
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
  runStdioHost,
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

/**
 * Small catalog fixture evaluator used only to make the routing contract
 * concrete in regression tests. The evaluator deliberately matches by
 * declared purpose and execution field, never by a known integration id.
 */
const resolveCatalogFixtureRoute = ({ catalog, purpose }) => {
  const relevantSkill = catalog.find(
    (skill) => Array.isArray(skill.purposes) && skill.purposes.includes(purpose),
  );
  if (!relevantSkill) {
    return { type: "fallback", reason: "no_relevant_skill" };
  }
  if (relevantSkill.configured === false) {
    return { type: "fallback", reason: "not_configured" };
  }
  if (
    Array.isArray(relevantSkill.supportedOperations)
    && !relevantSkill.supportedOperations.includes(purpose)
  ) {
    return { type: "fallback", reason: "unsupported_operation" };
  }
  if (relevantSkill.runtimeExecution) {
    return { type: "runtimeExecution", skillId: relevantSkill.id };
  }
  if (relevantSkill.remoteMcpExecution) {
    return { type: "remoteMcpExecution", skillId: relevantSkill.id };
  }
  return { type: "fallback", reason: "unsupported_operation" };
};

const readRoutingInstructionsFromInitialize = async () => {
  const response = await handleLocalMcpMessage({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-03-26" },
  });
  return response.result.instructions;
};

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
      headers: response.headers,
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

const assertLoopbackPortClosed = async (port) => new Promise((resolve, reject) => {
  const socket = net.connect({
    host: "127.0.0.1",
    port,
  });
  socket.once("connect", () => {
    socket.destroy();
    reject(new Error("loopback listener remained reachable"));
  });
  socket.once("error", (error) => {
    if (error.code === "ECONNREFUSED") {
      resolve();
      return;
    }
    reject(error);
  });
});

const createStdioHarness = (callTool) => {
  const inputStream = new PassThrough();
  const outputStream = new PassThrough();
  const frames = [];
  const waiters = new Set();
  let outputBuffer = "";
  outputStream.setEncoding("utf8");
  outputStream.on("data", (chunk) => {
    outputBuffer += chunk;
    while (outputBuffer.includes("\n")) {
      const boundary = outputBuffer.indexOf("\n");
      const line = outputBuffer.slice(0, boundary);
      outputBuffer = outputBuffer.slice(boundary + 1);
      if (!line) {
        continue;
      }
      const frame = JSON.parse(line);
      frames.push(frame);
      for (const waiter of waiters) {
        if (waiter.predicate(frame)) {
          waiters.delete(waiter);
          clearTimeout(waiter.timeout);
          waiter.resolve(frame);
        }
      }
    }
  });
  const host = runStdioHost({
    inputStream,
    outputStream,
    origin: "https://trelio.test",
    callTool,
  });

  return {
    frames,
    host,
    send: (message) => {
      inputStream.write(`${JSON.stringify(message)}\n`);
    },
    waitForFrame: (predicate, timeoutMs = 1_000) => {
      const existing = frames.find(predicate);
      if (existing) {
        return Promise.resolve(existing);
      }
      return new Promise((resolve, reject) => {
        const waiter = {
          predicate,
          resolve,
          timeout: setTimeout(() => {
            waiters.delete(waiter);
            reject(new Error("stdio MCP response timeout"));
          }, timeoutMs),
        };
        waiters.add(waiter);
      });
    },
    close: async () => {
      inputStream.end();
      await host;
      outputStream.end();
    },
  };
};

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
  await assertLoopbackPortClosed(listenerPort);
});

const chromeDocumentNavigationHeaders = (origin) => ({
  "content-type": "application/x-www-form-urlencoded",
  ...(origin === undefined ? {} : { origin }),
  "sec-fetch-site": "same-origin",
  "sec-fetch-mode": "navigate",
  "sec-fetch-dest": "document",
  "sec-fetch-user": "?1",
});

const submitAcceptedLoopbackCredential = async (originMode) => {
  const credential = "loopback-accepted-test-value";
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
      assert.match(
        String(page.headers["content-security-policy"]),
        /form-action 'self'/u,
      );
      assert.equal(page.headers.connection, "close");
      assert.equal(page.body.includes(credential), false);

      const origin = originMode === "exact"
        ? expectedOrigin
        : originMode === "null"
          ? "null"
          : undefined;
      const accepted = await requestLoopback(`${expectedOrigin}/credential`, {
        method: "POST",
        headers: chromeDocumentNavigationHeaders(origin),
        body: new URLSearchParams({ nonce, credential }).toString(),
      });
      assert.equal(accepted.statusCode, 200);
      assert.equal(accepted.headers.connection, "close");
    },
  });

  assert.deepEqual(doctorCalls, [credential]);
  assert.deepEqual(persistedCredentials, [credential]);
};

test("Remote MCP loopback accepts exact and Chrome null/absent Origin submits", async () => {
  // Exact Origin remains the preferred path. Chrome's opaque and missing
  // variants are accepted only with all same-origin document-navigation
  // metadata, exact Host/port, loopback socket and the one-time nonce.
  for (const originMode of ["exact", "null", "absent"]) {
    await submitAcceptedLoopbackCredential(originMode);
  }
});

test("stdio connect returns only after submit doctor and local persistence complete", async () => {
  const credential = "stdio-connect-test-credential";
  const doctorCalls = [];
  const persistedCredentials = [];
  const harness = createStdioHarness(async (
    _origin,
    toolName,
    _arguments,
    { signal },
  ) => {
    assert.equal(toolName, "connect_remote_agent_skill");
    await collectCredentialThroughLoopback("https://trelio.test", resolvedDodo, {
      browserPlatform: "darwin",
      handoffTimeoutMs: 100,
      setupTimeoutMs: 1_000,
      signal,
      doctorCredential: async (_resolved, candidate) => {
        doctorCalls.push(candidate);
      },
      persistCredential: async (_originValue, _resolved, candidate) => {
        persistedCredentials.push(candidate);
      },
      openBrowserFn: async (setupUrl) => {
        const protectedUrl = new URL(setupUrl);
        const page = await requestLoopback(protectedUrl);
        assert.equal(page.statusCode, 200);
        const accepted = await requestLoopback(
          `${protectedUrl.origin}/credential`,
          {
            method: "POST",
            headers: chromeDocumentNavigationHeaders(protectedUrl.origin),
            body: new URLSearchParams({
              nonce: protectedUrl.searchParams.get("nonce"),
              credential,
            }).toString(),
          },
        );
        assert.equal(accepted.statusCode, 200);
      },
    });
    return {
      content: [{
        type: "text",
        text: JSON.stringify({ connected: true }),
      }],
    };
  });

  try {
    harness.send({
      jsonrpc: "2.0",
      id: 10,
      method: "tools/call",
      params: {
        name: "connect_remote_agent_skill",
        arguments: {},
      },
    });
    const response = await harness.waitForFrame(({ id }) => id === 10);
    assert.equal(response.result.isError, undefined);
    assert.deepEqual(
      JSON.parse(response.result.content[0].text),
      { connected: true },
    );
    assert.deepEqual(doctorCalls, [credential]);
    assert.deepEqual(persistedCredentials, [credential]);
  } finally {
    await harness.close();
  }
});

test("cancelled connect aborts an in-flight doctor before persistence", async () => {
  const credential = "cancelled-doctor-test-credential";
  const controller = new AbortController();
  const persistedCredentials = [];
  let listenerPort = null;
  let markDoctorStarted;
  const doctorStarted = new Promise((resolve) => {
    markDoctorStarted = resolve;
  });
  let submittedRequest = null;

  const connection = collectCredentialThroughLoopback(
    "https://trelio.test",
    resolvedDodo,
    {
      browserPlatform: "darwin",
      handoffTimeoutMs: 100,
      setupTimeoutMs: 10_000,
      signal: controller.signal,
      onListening: ({ port }) => {
        listenerPort = port;
      },
      doctorCredential: async (_resolved, candidate, { signal }) => {
        assert.equal(candidate, credential);
        markDoctorStarted();
        await new Promise((_, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        });
      },
      persistCredential: async (_origin, _resolved, candidate) => {
        persistedCredentials.push(candidate);
      },
      openBrowserFn: async (setupUrl) => {
        const protectedUrl = new URL(setupUrl);
        assert.equal((await requestLoopback(protectedUrl)).statusCode, 200);
        submittedRequest = requestLoopback(
          `${protectedUrl.origin}/credential`,
          {
            method: "POST",
            headers: chromeDocumentNavigationHeaders(protectedUrl.origin),
            body: new URLSearchParams({
              nonce: protectedUrl.searchParams.get("nonce"),
              credential,
            }).toString(),
          },
        ).catch(() => null);
      },
    },
  );

  await doctorStarted;
  controller.abort(new RemoteMcpHostError(
    "REMOTE_MCP_TOOL_CALL_CANCELLED",
    "Вызов Remote MCP отменён.",
  ));
  await assert.rejects(
    connection,
    (error) => (
      error instanceof RemoteMcpHostError
      && error.code === "REMOTE_MCP_TOOL_CALL_CANCELLED"
    ),
  );
  await submittedRequest;
  assert.deepEqual(persistedCredentials, []);
  assert.equal(Number.isInteger(listenerPort), true);
  await assertLoopbackPortClosed(listenerPort);
});

test("stdio doctor is not blocked by connect and cancellation closes its listener", async () => {
  let listenerPort = null;
  let markListening;
  const listening = new Promise((resolve) => {
    markListening = resolve;
  });
  const harness = createStdioHarness(async (
    _origin,
    toolName,
    _arguments,
    { signal },
  ) => {
    if (toolName === "doctor_remote_agent_skill") {
      throw new RemoteMcpHostError(
        "REMOTE_MCP_PERSONAL_TOKEN_REQUIRED",
        "Для Remote MCP нужен персональный credential на этом устройстве.",
      );
    }
    assert.equal(toolName, "connect_remote_agent_skill");
    await collectCredentialThroughLoopback("https://trelio.test", resolvedDodo, {
      browserPlatform: "darwin",
      handoffTimeoutMs: 100,
      setupTimeoutMs: 10_000,
      signal,
      onListening: ({ port }) => {
        listenerPort = port;
        markListening();
      },
      openBrowserFn: async (setupUrl) => {
        assert.equal((await requestLoopback(setupUrl)).statusCode, 200);
      },
    });
    throw new Error("cancelled connect unexpectedly completed");
  });

  try {
    harness.send({
      jsonrpc: "2.0",
      id: 20,
      method: "tools/call",
      params: {
        name: "connect_remote_agent_skill",
        arguments: {},
      },
    });
    await listening;

    const doctorStartedAt = Date.now();
    harness.send({
      jsonrpc: "2.0",
      id: 21,
      method: "tools/call",
      params: {
        name: "doctor_remote_agent_skill",
        arguments: {},
      },
    });
    const doctorResponse = await harness.waitForFrame(({ id }) => id === 21);
    assert.ok(
      Date.now() - doctorStartedAt < 500,
      "doctor remained serialized behind the human setup wait",
    );
    assert.equal(
      JSON.parse(doctorResponse.result.content[0].text).code,
      "REMOTE_MCP_PERSONAL_TOKEN_REQUIRED",
    );

    harness.send({
      jsonrpc: "2.0",
      method: "notifications/cancelled",
      params: {
        requestId: 20,
        reason: "client interrupted the tool call",
      },
    });
    const connectResponse = await harness.waitForFrame(({ id }) => id === 20);
    assert.equal(
      JSON.parse(connectResponse.result.content[0].text).code,
      "REMOTE_MCP_TOOL_CALL_CANCELLED",
    );
    assert.equal(Number.isInteger(listenerPort), true);
    await assertLoopbackPortClosed(listenerPort);
  } finally {
    await harness.close();
  }
});

test("stdio transport EOF aborts connect and closes its listener", async () => {
  let listenerPort = null;
  let markListening;
  const listening = new Promise((resolve) => {
    markListening = resolve;
  });
  const harness = createStdioHarness(async (
    _origin,
    _toolName,
    _arguments,
    { signal },
  ) => collectCredentialThroughLoopback(
    "https://trelio.test",
    resolvedDodo,
    {
      browserPlatform: "darwin",
      handoffTimeoutMs: 100,
      setupTimeoutMs: 10_000,
      signal,
      onListening: ({ port }) => {
        listenerPort = port;
        markListening();
      },
      openBrowserFn: async (setupUrl) => {
        assert.equal((await requestLoopback(setupUrl)).statusCode, 200);
      },
    },
  ));

  harness.send({
    jsonrpc: "2.0",
    id: 30,
    method: "tools/call",
    params: {
      name: "connect_remote_agent_skill",
      arguments: {},
    },
  });
  await listening;
  await harness.close();
  assert.equal(Number.isInteger(listenerPort), true);
  await assertLoopbackPortClosed(listenerPort);
});

const assertRejectedLoopbackCredential = async ({
  expectedDiagnostics,
  makeBody,
  makeHeaders,
}) => {
  const credential = "loopback-rejected-test-value";
  const doctorCalls = [];
  const persistedCredentials = [];
  let protectedNonce = "";

  await assert.rejects(
    collectCredentialThroughLoopback("https://trelio.test", resolvedDodo, {
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
        protectedNonce = protectedUrl.searchParams.get("nonce");
        assert.equal((await requestLoopback(protectedUrl)).statusCode, 200);

        const rejected = await requestLoopback(
          `${protectedUrl.origin}/credential`,
          {
            method: "POST",
            headers: makeHeaders(protectedUrl.origin),
            body: makeBody({ nonce: protectedNonce, credential }),
          },
        );
        assert.equal(rejected.statusCode, 403);
      },
    }),
    (error) => {
      assert.equal(error instanceof RemoteMcpHostError, true);
      assert.equal(error.code, "REMOTE_MCP_CREDENTIAL_REQUEST_REJECTED");
      assert.deepEqual(error.details, expectedDiagnostics);
      const safeDiagnostic = JSON.stringify({
        message: error.message,
        details: error.details,
      });
      assert.equal(safeDiagnostic.includes(credential), false);
      assert.equal(safeDiagnostic.includes(protectedNonce), false);
      return true;
    },
  );

  assert.deepEqual(doctorCalls, []);
  assert.deepEqual(persistedCredentials, []);
};

test("Remote MCP loopback rejects wrong Host, nonce and content type", async () => {
  await assertRejectedLoopbackCredential({
    expectedDiagnostics: {
      method: "post",
      path: "credential",
      origin: "exact",
      contentType: "urlencoded",
    },
    makeHeaders: (origin) => ({
      ...chromeDocumentNavigationHeaders(origin),
      host: "127.0.0.1:1",
    }),
    makeBody: ({ nonce, credential }) => (
      new URLSearchParams({ nonce, credential }).toString()
    ),
  });

  await assertRejectedLoopbackCredential({
    expectedDiagnostics: {
      method: "post",
      path: "credential",
      origin: "exact",
      contentType: "urlencoded",
    },
    makeHeaders: (origin) => chromeDocumentNavigationHeaders(origin),
    makeBody: ({ credential }) => (
      new URLSearchParams({ nonce: "wrong", credential }).toString()
    ),
  });

  await assertRejectedLoopbackCredential({
    expectedDiagnostics: {
      method: "post",
      path: "credential",
      origin: "exact",
      contentType: "other",
    },
    makeHeaders: (origin) => ({
      ...chromeDocumentNavigationHeaders(origin),
      "content-type": "text/plain",
    }),
    makeBody: ({ nonce, credential }) => (
      new URLSearchParams({ nonce, credential }).toString()
    ),
  });
});

test("Remote MCP loopback rejects null/absent Origin without strict Fetch Metadata", async () => {
  for (const origin of ["null", undefined]) {
    await assertRejectedLoopbackCredential({
      expectedDiagnostics: {
        method: "post",
        path: "credential",
        origin: origin === undefined ? "absent" : "null",
        contentType: "urlencoded",
      },
      makeHeaders: () => ({
        "content-type": "application/x-www-form-urlencoded",
        ...(origin === undefined ? {} : { origin }),
      }),
      makeBody: ({ nonce, credential }) => (
        new URLSearchParams({ nonce, credential }).toString()
      ),
    });
  }
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

test("SSRF guard allows public IPv4 and rejects private or mismatched IPv4 answers", async () => {
  const safe = await resolveSafeRemoteMcpEndpoint(
    "https://knowledgebase.dodois.io/mcp",
    {
      lookup: async () => [{ address: "91.221.165.34", family: 4 }],
    },
  );
  assert.equal(safe.address, "91.221.165.34");
  assert.equal(safe.family, 4);

  await assert.rejects(
    resolveSafeRemoteMcpEndpoint("https://knowledgebase.dodois.io/mcp", {
      lookup: async () => [{ address: "10.20.30.40", family: 4 }],
    }),
    (error) => (
      error instanceof RemoteMcpHostError
      && error.code === "REMOTE_MCP_SSRF_BLOCKED"
    ),
  );

  await assert.rejects(
    resolveSafeRemoteMcpEndpoint("https://knowledgebase.dodois.io/mcp", {
      lookup: async () => [{ address: "91.221.165.34", family: 6 }],
    }),
    (error) => (
      error instanceof RemoteMcpHostError
      && error.code === "REMOTE_MCP_SSRF_BLOCKED"
    ),
  );
});

test("SSRF guard rejects IPv4-mapped, NAT64 and 6to4 IPv6 answers", async () => {
  const blockedAddresses = [
    "::ffff:5bdd:a522",
    "64:ff9b::5bdd:a522",
    "64:ff9b:1::5bdd:a522",
    "2002:5bdd:a522::",
  ];

  for (const address of blockedAddresses) {
    await assert.rejects(
      resolveSafeRemoteMcpEndpoint("https://knowledgebase.dodois.io/mcp", {
        lookup: async () => [{ address, family: 6 }],
      }),
      (error) => (
        error instanceof RemoteMcpHostError
        && error.code === "REMOTE_MCP_SSRF_BLOCKED"
      ),
      `expected ${address} to be rejected`,
    );
  }
});

test("SSRF guard still permits explicit insecure test endpoints", async () => {
  const safe = await resolveSafeRemoteMcpEndpoint(
    "http://127.0.0.1:4567/mcp",
    {
      lookup: async () => [{ address: "127.0.0.1", family: 4 }],
      allowInsecureTestEndpoint: true,
    },
  );
  assert.equal(safe.address, "127.0.0.1");
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

test("Remote MCP external cancellation destroys a heartbeat SSE request", {
  timeout: 2_000,
}, async () => {
  let markStreamStarted;
  const streamStarted = new Promise((resolve) => {
    markStreamStarted = resolve;
  });
  let markStreamClosed;
  const streamClosed = new Promise((resolve) => {
    markStreamClosed = resolve;
  });
  const server = await listenOnLoopback((_request, response) => {
    markStreamStarted();
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
    const controller = new AbortController();
    const pendingRequest = remoteMcpHttpRequest({
      config: {
        ...dodoConfig,
        endpoint: `http://remote-mcp.test:${port}/mcp`,
      },
      credential: "personal-test-token",
      payload: {
        jsonrpc: "2.0",
        id: 8,
        method: "tools/list",
        params: {},
      },
    }, {
      resolveEndpoint: createPinnedLoopbackResolver(),
      timeoutMs: 1_000,
      signal: controller.signal,
    });
    await streamStarted;
    controller.abort(new RemoteMcpHostError(
      "REMOTE_MCP_TOOL_CALL_CANCELLED",
      "Вызов Remote MCP отменён.",
    ));

    await assert.rejects(
      pendingRequest,
      (error) => (
        error instanceof RemoteMcpHostError
        && error.code === "REMOTE_MCP_TOOL_CALL_CANCELLED"
      ),
    );
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

test("local MCP initialize publishes the universal skill-first routing gate", async () => {
  const instructions = await readRoutingInstructionsFromInitialize();

  assert.equal(instructions, AGENT_SKILL_ROUTING_INSTRUCTIONS);
  assert.match(instructions, /call `list_agent_skills` for that exact company and project/u);
  assert.match(instructions, /immediately before the action call `get_agent_skill`/u);
  assert.match(instructions, /missing active tool is not evidence that the integration is unavailable/u);
  assert.match(instructions, /Never bypass a matching skill through a browser, Computer Use, direct HTTP, another MCP server, or a local script/u);
  assert.match(instructions, /State that exact reason before using a fallback/u);
  assert.match(instructions, /Native Trelio MCP control-plane and Agent Workspace operations/u);
  assert.match(instructions, /do not search for or announce a missing catalog skill merely to discover tasks, manage a workspace or Run, read workspace context, checkpoint, submit, or restore/u);
  assert.match(instructions, /fallback-reason requirement applies only when choosing another implementation for an operation that a relevant catalog skill could handle/u);
  assert.match(instructions, /does not weaken any existing secret-delivery rule, personal-session boundary, approval policy, or confirmation requirement/u);
});

test("platform routing sends 1c-edo through runtimeExecution", async () => {
  const instructions = await readRoutingInstructionsFromInitialize();
  const oneCEdoSkill = await readFile(
    path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../../../platform-skills/1c-edo/SKILL.md",
    ),
    "utf8",
  );
  const route = resolveCatalogFixtureRoute({
    purpose: "search_edo_documents",
    catalog: [{
      id: "1c-edo",
      purposes: ["search_edo_documents"],
      supportedOperations: ["search_edo_documents"],
      configured: true,
      runtimeExecution: { command: ["trelio-workspace", "skill", "run"] },
    }],
  });

  assert.deepEqual(route, { type: "runtimeExecution", skillId: "1c-edo" });
  assert.match(instructions, /contains `runtimeExecution`, run only its exact command/u);
  assert.match(oneCEdoSkill, /Use only the signed `runtimeExecution\.command`/u);
});

test("platform routing sends the Dodo knowledge base through remoteMcpExecution", async () => {
  const instructions = await readRoutingInstructionsFromInitialize();
  const route = resolveCatalogFixtureRoute({
    purpose: "search_company_knowledge",
    catalog: [{
      id: resolvedDodo.skill.id,
      purposes: ["search_company_knowledge"],
      supportedOperations: ["search_company_knowledge"],
      configured: true,
      remoteMcpExecution: {
        identity: resolvedDodo.localIdentity,
        releaseId: resolvedDodo.releaseId,
      },
    }],
  });

  assert.deepEqual(route, {
    type: "remoteMcpExecution",
    skillId: "dodo-knowledge-base",
  });
  assert.match(instructions, /contains `remoteMcpExecution`, use only the declared local `trelio-remote-skills` host tools/u);
});

test("platform routing discovers Telegram even without a separate Telegram tool", async () => {
  const instructions = await readRoutingInstructionsFromInitialize();
  const toolsResponse = await handleLocalMcpMessage({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/list",
    params: {},
  });
  const activeToolNames = toolsResponse.result.tools.map(({ name }) => name);
  const route = resolveCatalogFixtureRoute({
    purpose: "read_team_chat",
    catalog: [{
      id: "telegram-mtproto",
      purposes: ["read_team_chat"],
      supportedOperations: ["read_team_chat"],
      configured: true,
      runtimeExecution: { command: ["trelio-workspace", "skill", "run"] },
    }],
  });

  assert.equal(activeToolNames.some((name) => /telegram/iu.test(name)), false);
  assert.deepEqual(route, {
    type: "runtimeExecution",
    skillId: "telegram-mtproto",
  });
  assert.match(instructions, /even when no integration-specific tool appears in the active tool list/u);
});

test("platform routing is purpose-based and works for an unknown future skill", async () => {
  const instructions = await readRoutingInstructionsFromInitialize();
  const route = resolveCatalogFixtureRoute({
    purpose: "inspect_orbital_inventory",
    catalog: [{
      id: "future-orbital-inventory",
      purposes: ["inspect_orbital_inventory"],
      supportedOperations: ["inspect_orbital_inventory"],
      configured: true,
      remoteMcpExecution: {
        identity: { skillId: "future-orbital-inventory" },
        releaseId: "44444444-4444-4444-8444-444444444444",
      },
    }],
  });

  assert.deepEqual(route, {
    type: "remoteMcpExecution",
    skillId: "future-orbital-inventory",
  });
  assert.match(instructions, /Select a relevant assigned skill by its purpose/u);
  assert.doesNotMatch(
    instructions,
    /1c-edo|dodo-knowledge-base|telegram-mtproto|future-orbital-inventory/iu,
  );
});

test("platform routing allows a named fallback only when no relevant skill exists", async () => {
  const instructions = await readRoutingInstructionsFromInitialize();
  const route = resolveCatalogFixtureRoute({
    purpose: "read_unsupported_service",
    catalog: [],
  });

  assert.deepEqual(route, {
    type: "fallback",
    reason: "no_relevant_skill",
  });
  assert.match(instructions, /Fallback is allowed only when the exact catalog has no relevant skill/u);
  assert.match(instructions, /the relevant skill or required connection is not configured/u);
  assert.match(instructions, /the current skill does not support the requested operation/u);
  assert.match(instructions, /primary workspace workflow, not a fallback from the Agent Skill catalog/u);
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
  assert.equal(frames[0].result.serverInfo.version, "1.6.3");
  assert.equal(frames[0].result.instructions, AGENT_SKILL_ROUTING_INSTRUCTIONS);
  assert.match(frames[0].result.instructions, /logical launcher/u);
  assert.match(frames[0].result.instructions, /do not announce/u);
  assert.match(frames[0].result.instructions, /not a fallback/u);
  assert.equal(frames[1].result.tools.length, 4);
});
