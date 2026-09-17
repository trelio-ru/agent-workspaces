#!/usr/bin/env node

/**
 * Builds the independently publishable Trelio host runtime package.
 *
 * The stable plugin loader and Node resolver stay in the plugin shell. Only
 * executable runtime implementation is copied into the signed package, so a
 * routine host rollout cannot modify Codex plugin registration or hooks.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildAgentSkillPackage } from "../host-runtime/scripts/trelio-workspace.mjs";

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT_SOURCE = path.join(REPOSITORY_ROOT, "host-runtime", "scripts");
const EXCLUDED_SCRIPT_NAMES = new Set([
  "report-context-budget.mjs",
]);

const parseArguments = (rawArguments) => {
  const values = {};

  for (let index = 0; index < rawArguments.length; index += 2) {
    const flag = rawArguments[index];
    const value = rawArguments[index + 1];
    if (!flag?.startsWith("--") || !value) {
      throw new Error("Use --runtime-version X.Y.Z --output /path/runtime.skillpkg.");
    }
    values[flag.slice(2)] = value;
  }

  if (!/^\d+\.\d+\.\d+$/u.test(values["runtime-version"] || "")) {
    throw new Error("--runtime-version must use stable X.Y.Z format.");
  }
  if (!values.output) throw new Error("--output is required.");
  return values;
};

const copyRuntimeSource = async (stagingDirectory) => {
  const targetScripts = path.join(stagingDirectory, "scripts");
  await fs.mkdir(targetScripts, { recursive: true });
  const entries = await fs.readdir(SCRIPT_SOURCE, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith(".mjs") && !EXCLUDED_SCRIPT_NAMES.has(entry.name)) {
      await fs.copyFile(
        path.join(SCRIPT_SOURCE, entry.name),
        path.join(targetScripts, entry.name),
      );
    }
  }

  // Native browser-fill helpers are source-reviewed runtime dependencies.
  // They are compiled locally and never carry user credentials in the package.
  await fs.cp(
    path.join(SCRIPT_SOURCE, "native-secret-browser"),
    path.join(targetScripts, "native-secret-browser"),
    { recursive: true, errorOnExist: true },
  );
};

const main = async () => {
  const options = parseArguments(process.argv.slice(2));
  const stagingDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "trelio-host-runtime-package-"));

  try {
    await copyRuntimeSource(stagingDirectory);
    const packageBytes = await buildAgentSkillPackage({
      skillId: "trelio-host-runtime",
      runtimeVersion: options["runtime-version"],
      sourceDirectory: stagingDirectory,
      entrypointPath: "scripts/trelio-host-runtime-entry.mjs",
      interpreter: "node",
      capabilities: ["local-session", "network"],
    });
    const outputPath = path.resolve(options.output);
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, packageBytes, { flag: "wx", mode: 0o600 });
    process.stdout.write(`${JSON.stringify({
      ok: true,
      outputPath,
      runtimeVersion: options["runtime-version"],
      sizeBytes: packageBytes.byteLength,
    })}\n`);
  } finally {
    await fs.rm(stagingDirectory, { recursive: true, force: true });
  }
};

await main();
