/**
 * Transport stable shell: повтор охватывает HTTP headers И весь bounded body.
 * Этот код нужен до materialization runtime, поэтому не может быть доставлен
 * исправляемым signed package. Он не интерпретирует manifest и не меняет cache.
 */
import { readBoundedResponseBuffer } from "./trelio-host-runtime-shell.mjs";

export const UPDATE_NETWORK_TIMEOUT_MS = 120_000;
export const REQUEST_IDLE_TIMEOUT_MS = 15_000;
export const UPDATE_RETRY_DELAYS_MS = Object.freeze([250, 1_000, 3_000]);

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export const downloadHostRuntimeResponse = async (url, {
  resource,
  maximumBytes,
  requestTimeoutMs = REQUEST_IDLE_TIMEOUT_MS,
  totalTimeoutMs = UPDATE_NETWORK_TIMEOUT_MS,
  deadline = Date.now() + totalTimeoutMs,
  retryDelaysMs = UPDATE_RETRY_DELAYS_MS,
} = {}) => {
  if (!["metadata", "package"].includes(resource)) throw new Error("Unknown host runtime resource.");
  let lastError;

  for (let attempt = 1; attempt <= retryDelaysMs.length + 1; attempt += 1) {
    let stage = `${resource}_headers`;
    let receivedBytes = 0;
    let idleTimer;
    let totalTimer;
    const controller = new AbortController();
    const failure = (reason, extra = {}) => {
      // Только закрытые этапы и числовые факты. URL, filesystem paths, raw
      // fetch/OS errors и response body не попадают в вывод loader-а.
      const diagnostic = {
        code: "TRELIO_HOST_RUNTIME_UPDATE_FAILED",
        operation: "host_runtime_update",
        reason,
        stage,
        attempt,
        maxAttempts: retryDelaysMs.length + 1,
        receivedBytes,
        ...extra,
      };
      return Object.assign(new Error(JSON.stringify(diagnostic)), { diagnostic });
    };
    const armIdleTimer = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => controller.abort(failure("timeout", {
        timeoutKind: "idle",
        timeoutMs: requestTimeoutMs,
      })), requestTimeoutMs);
    };

    try {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) throw failure("timeout", { timeoutKind: "total", timeoutMs: totalTimeoutMs });
      // Общий deadline один на metadata, package и все backoff/retries. Каждый
      // полученный chunk продлевает только idle timer, не общий бюджет и lock.
      totalTimer = setTimeout(() => controller.abort(failure("timeout", {
        timeoutKind: "total", timeoutMs: totalTimeoutMs,
      })), remainingMs);
      armIdleTimer();
      const response = await fetch(url, { signal: controller.signal });
      if (!response.ok) {
        if (response.status === 404 && resource === "metadata") {
          return { status: 404, bytes: null };
        }
        throw failure("http", { httpStatus: response.status });
      }
      stage = `${resource}_body`;
      armIdleTimer();
      const bytes = await readBoundedResponseBuffer(response, maximumBytes, "Host runtime response", (size) => {
        receivedBytes = size;
        armIdleTimer();
      });
      return { status: response.status, bytes };
    } catch (error) {
      if (controller.signal.aborted) {
        lastError = controller.signal.reason;
      } else if (error?.diagnostic) {
        lastError = error;
      } else if (error?.code === "HOST_RUNTIME_RESPONSE_TOO_LARGE") {
        lastError = failure("response_too_large");
      } else {
        // Node/undici exposes machine codes separately from messages that can
        // contain hostnames. Preserve only a bounded code, never cause.message.
        const code = error?.cause?.code ?? error?.code;
        lastError = failure("network", typeof code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/u.test(code)
          ? { networkCode: code }
          : {});
      }
    } finally {
      clearTimeout(idleTimer);
      clearTimeout(totalTimer);
      // Освобождаем в том числе непрочитанный 5xx/404 body и оборванный stream
      // ДО backoff. Частичный ответ никогда не склеивается со следующей попыткой.
      controller.abort();
    }

    const { reason, httpStatus, timeoutKind } = lastError.diagnostic;
    const retryable = reason === "network"
      || (reason === "timeout" && timeoutKind === "idle")
      || (reason === "http" && httpStatus >= 500);
    if (!retryable || attempt > retryDelaysMs.length) throw lastError;
    const delay = retryDelaysMs[attempt - 1];
    if (Date.now() + delay >= deadline) {
      throw failure("timeout", { timeoutKind: "total", timeoutMs: totalTimeoutMs });
    }
    await sleep(delay);
  }
  throw lastError;
};
