/**
 * Бюджет stable shell нужен ДО запуска подписанного runtime. Он не является
 * admission/доверенным временем: launcher может только сократить срок, но не
 * продлить его относительно начала Node. Ни payload, ни пути сюда не попадают.
 */
export const MCP_UPDATE_TIMEOUT_MS = 20_000;
export const MCP_LOCAL_STARTUP_TIMEOUT_MS = 25_000;

export const createMcpStartupBudget = ({
  environment = process.env,
  now = Date.now,
  uptimeMs = process.uptime() * 1000,
} = {}) => {
  // process.uptime включает bootstrap Node и static imports loader-а. Новый
  // Date.now() внутри runHostRuntimeLoader раньше выдавал им бесплатное время.
  const observedNow = now();
  let startedAt = observedNow - Math.max(0, uptimeMs);
  const stamp = String(environment.TRELIO_MCP_LAUNCH_TIME || "");
  if (/^unix:\d{10}$/u.test(stamp)) {
    const seconds = Number(stamp.slice(5));
    if (Number.isSafeInteger(seconds) && seconds > 0) startedAt = Math.min(startedAt, seconds * 1000);
  } else {
    // %TIME% — cmd builtin: для отметки ДО выбора Node не запускаем ещё один
    // PowerShell. Даты/имена месяцев локализованы, поэтому передаём только
    // часы. Переход через полночь восстанавливаем как ближайшее прошлое время.
    const match = /^win-time:\s*(\d{1,2}):(\d{2}):(\d{2})[.,](\d{2})$/u.exec(stamp);
    if (match) {
      const [, hours, minutes, seconds, centiseconds] = match.map(Number);
      if (hours < 24 && minutes < 60 && seconds < 60) {
        const local = new Date(observedNow);
        local.setHours(hours, minutes, seconds, centiseconds * 10);
        if (local.getTime() > observedNow) local.setDate(local.getDate() - 1);
        startedAt = Math.min(startedAt, local.getTime());
      }
    }
  }

  const deadline = startedAt + MCP_LOCAL_STARTUP_TIMEOUT_MS;
  return {
    startedAt,
    deadline,
    updateDeadline: startedAt + MCP_UPDATE_TIMEOUT_MS,
    check(stage) {
      if (now() < deadline) return;
      const diagnostic = {
        code: "TRELIO_MCP_STARTUP_TIMEOUT",
        operation: "mcp_startup",
        stage,
        timeoutKind: "total",
        timeoutMs: MCP_LOCAL_STARTUP_TIMEOUT_MS,
      };
      throw Object.assign(new Error(JSON.stringify(diagnostic)), { diagnostic });
    },
    trace(stage) {
      if (environment.TRELIO_MCP_STARTUP_TRACE !== "1") return;
      // Opt-in stderr не загрязняет MCP stdout и не раскрывает даже argv/env.
      process.stderr.write(`${JSON.stringify({
        type: "trelio_mcp_startup", stage, pid: process.pid,
        elapsedMs: Math.max(0, Math.round(now() - startedAt)),
      })}\n`);
    },
  };
};
