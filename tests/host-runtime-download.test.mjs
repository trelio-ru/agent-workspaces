import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { downloadHostRuntimeResponse } from "../plugins/trelio-agent-workspaces/scripts/trelio-host-runtime-download.mjs";

const withServer = async (handler, run) => {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    return await run(`http://127.0.0.1:${server.address().port}/runtime`);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
};
const policy = {
  resource: "package",
  maximumBytes: 1_024,
  requestTimeoutMs: 200,
  totalTimeoutMs: 5_000,
  retryDelaysMs: [10, 20, 30],
};

for (const resource of ["metadata", "package"]) {
  for (const part of ["headers", "body"]) {
    test(`${resource} retries three stalled ${part} responses, then returns only the complete fourth body`, async () => {
      let requests = 0;
      await withServer((_request, response) => {
        requests += 1;
        if (requests <= 3) {
          if (part === "body") response.writeHead(200).write("partial-discard-me");
          return;
        }
        response.end("complete-fourth-response");
      }, async (url) => {
        const result = await downloadHostRuntimeResponse(url, { ...policy, resource });
        assert.equal(result.bytes.toString(), "complete-fourth-response");
        assert.equal(requests, 4);
      });
    });
  }
}

test("continuous slow download can outlive idle timeout without restarting", async () => {
  let requests = 0;
  await withServer((_request, response) => {
    requests += 1;
    response.write("start");
    let chunks = 0;
    const timer = setInterval(() => {
      response.write(".");
      if (++chunks === 8) response.end("end");
    }, 70);
    response.once("close", () => clearInterval(timer));
  }, async (url) => {
    const start = Date.now();
    const result = await downloadHostRuntimeResponse(url, policy);
    assert.ok(Date.now() - start > policy.requestTimeoutMs * 2);
    assert.equal(result.bytes.toString(), "start........end");
    assert.equal(requests, 1);
  });
});

test("continuous progress cannot extend the overall update deadline", async () => {
  let requests = 0;
  await withServer((_request, response) => {
    requests += 1;
    response.write(".");
    const timer = setInterval(() => response.write("."), 40);
    response.once("close", () => clearInterval(timer));
  }, async (url) => {
    await assert.rejects(downloadHostRuntimeResponse(url, {
      ...policy,
      totalTimeoutMs: 350,
    }), (error) => {
      assert.equal(error.diagnostic.code, "TRELIO_HOST_RUNTIME_UPDATE_FAILED");
      assert.equal(error.diagnostic.stage, "package_body");
      assert.equal(error.diagnostic.reason, "timeout");
      assert.equal(error.diagnostic.timeoutKind, "total");
      assert.equal(error.diagnostic.timeoutMs, 350);
      assert.ok(error.diagnostic.receivedBytes > 0);
      assert.equal(error.message.includes(url), false);
      return true;
    });
    assert.equal(requests, 1);
  });
});

test("exhausted body retries report the exact phase and idle limit", async () => {
  let requests = 0;
  await withServer((_request, response) => {
    requests += 1;
    response.write("part");
  }, async (url) => {
    await assert.rejects(downloadHostRuntimeResponse(url, policy), (error) => {
      assert.deepEqual(error.diagnostic, {
        code: "TRELIO_HOST_RUNTIME_UPDATE_FAILED",
        operation: "host_runtime_update",
        reason: "timeout",
        stage: "package_body",
        attempt: 4,
        maxAttempts: 4,
        receivedBytes: 4,
        timeoutKind: "idle",
        timeoutMs: 200,
      });
      return true;
    });
    assert.equal(requests, 4);
  });
});

test("metadata and package share a deadline, including retry backoff", async () => {
  let requests = 0;
  await withServer((_request, response) => {
    requests += 1;
    // Первый запрос занимает часть общего бюджета; новый resource не получает
    // новый срок. Второй непрерывно присылает bytes до общего deadline.
    if (requests === 1) {
      setTimeout(() => response.end("{}"), 120);
    } else {
      response.write(".");
      const timer = setInterval(() => response.write("."), 30);
      response.once("close", () => clearInterval(timer));
    }
  }, async (url) => {
    const deadline = Date.now() + 400;
    await downloadHostRuntimeResponse(url, { ...policy, resource: "metadata", deadline, totalTimeoutMs: 400 });
    await assert.rejects(downloadHostRuntimeResponse(url, { ...policy, deadline, totalTimeoutMs: 400 }), (error) => {
      assert.equal(error.diagnostic.timeoutKind, "total");
      assert.equal(error.diagnostic.stage, "package_body");
      return true;
    });
    assert.equal(requests, 2);
  });
});

for (const declared of [true, false]) {
  test(`oversized ${declared ? "declared" : "chunked"} body fails without retries`, async () => {
    let requests = 0;
    await withServer((_request, response) => {
      requests += 1;
      if (declared) response.setHeader("content-length", "20");
      else response.setHeader("transfer-encoding", "chunked");
      response.end("x".repeat(20));
    }, async (url) => {
      await assert.rejects(downloadHostRuntimeResponse(url, { ...policy, maximumBytes: 10 }), (error) => {
        assert.equal(error.diagnostic.reason, "response_too_large");
        return true;
      });
      assert.equal(requests, 1);
    });
  });
}

for (const status of [401, 403, 404, 429, 503]) {
  test(`HTTP ${status} retains explicit status and retry policy`, async () => {
    let requests = 0;
    await withServer((_request, response) => {
      requests += 1;
      // Не заканчиваем error body: loader обязан закрыть его сам до retry.
      response.writeHead(status).write("server-error-body-must-not-leak");
    }, async (url) => {
      await assert.rejects(downloadHostRuntimeResponse(url, policy), (error) => {
        assert.equal(error.diagnostic.reason, "http");
        assert.equal(error.diagnostic.httpStatus, status);
        assert.equal(error.message.includes("server-error-body"), false);
        return true;
      });
      assert.equal(requests, status >= 500 ? 4 : 1);
    });
  });
}

test("metadata 404 retains the no-published-runtime bootstrap contract", async () => {
  await withServer((_request, response) => response.writeHead(404).write("ignored"), async (url) => {
    assert.deepEqual(await downloadHostRuntimeResponse(url, { ...policy, resource: "metadata" }), {
      status: 404,
      bytes: null,
    });
  });
});
