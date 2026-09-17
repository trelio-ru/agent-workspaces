#!/usr/bin/env node

/**
 * Единый entrypoint independently released Trelio host runtime.
 *
 * Stable plugin shell знает только этот маленький контракт. Runtime package
 * может менять внутренние bridge, hook и MCP implementation без изменения
 * plugin manifest и без удаления Codex plugin cache, откуда уже работают
 * открытые задачи.
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const MODE_ENTRYPOINTS = Object.freeze({
  bridge: "trelio-workspace.mjs",
  hook: "trelio-runtime-session.mjs",
  mcp: "trelio-remote-mcp.mjs",
});

export const resolveHostRuntimeInvocation = (rawArguments) => {
  const [mode, ...argumentsAfterMode] = rawArguments;
  const entrypointName = MODE_ENTRYPOINTS[mode];

  if (!entrypointName) {
    throw new Error("Trelio host runtime ожидает mode bridge, hook или mcp.");
  }

  return {
    mode,
    entrypointPath: path.join(SCRIPT_DIRECTORY, entrypointName),
    arguments: argumentsAfterMode,
  };
};

export const runHostRuntime = async ({
  rawArguments = process.argv.slice(2),
  spawnProcess = spawn,
} = {}) => {
  const invocation = resolveHostRuntimeInvocation(rawArguments);

  return await new Promise((resolve, reject) => {
    // Запускаем exact Node, которым stable shell уже был запущен. Это не
    // зависит от PATH и не допускает смены runtime между loader и payload.
    const child = spawnProcess(
      process.execPath,
      [invocation.entrypointPath, ...invocation.arguments],
      {
        cwd: path.resolve(SCRIPT_DIRECTORY, ".."),
        env: process.env,
        shell: false,
        stdio: "inherit",
        windowsHide: true,
      },
    );

    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) {
        process.kill(process.pid, signal);
        return;
      }
      resolve(code ?? 1);
    });
  });
};

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  runHostRuntime()
    .then((exitCode) => {
      process.exitCode = exitCode;
    })
    .catch((error) => {
      process.stderr.write(`Trelio host runtime failed: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
