#!/usr/bin/env node

/**
 * Build the content-addressed JSON package accepted by Trelio's signed runtime
 * publisher. This tool deliberately lives outside the plugin subtree: a
 * provider release must not depend on, mutate or rebuild the generic host.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

export const PACKAGE_FORMAT = "trelio-agent-skill-package/v1";
const STABLE_VERSION = /^\d+\.\d+\.\d+$/u;
const SKILL_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const ALLOWED_CAPABILITIES = new Set([
  "browser",
  "local-session",
  "network",
  "secret-checkout",
]);
const ALLOWED_INTERPRETERS = new Set(["node", "python", "executable"]);
const WINDOWS_RESERVED_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu;

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

const assertObject = (value, label) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value;
};

/**
 * Package paths have one portable meaning on macOS, Linux and Windows. Reject
 * unsafe input instead of normalizing it into a different path on one host.
 */
export const validatePackagePath = (rawPath, label = "package path") => {
  if (typeof rawPath !== "string" || !rawPath) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  if (
    rawPath.includes("\\")
    || rawPath.includes("\0")
    || path.posix.isAbsolute(rawPath)
    || rawPath.endsWith("/")
  ) {
    throw new Error(`${label} is not a safe relative POSIX path.`);
  }

  const normalized = path.posix.normalize(rawPath);
  const segments = normalized.split("/");
  if (
    normalized !== rawPath
    || segments.some((segment) => (
      !segment
      || segment === "."
      || segment === ".."
      || /[\u0000-\u001f\u007f:*?"<>|]/u.test(segment)
      || /[. ]$/u.test(segment)
      || WINDOWS_RESERVED_NAME.test(segment)
    ))
  ) {
    throw new Error(`${label} is not normalized or portable.`);
  }
  return normalized;
};

const readReleaseDefinition = (skillDirectory) => {
  const definitionPath = path.join(skillDirectory, "release.json");
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(definitionPath, "utf8"));
  } catch (error) {
    throw new Error(`Cannot read ${definitionPath}: ${error.message}`);
  }

  const definition = assertObject(parsed, "release.json");
  if (definition.schemaVersion !== 1) {
    throw new Error("release.json schemaVersion must equal 1.");
  }

  const release = assertObject(definition.release, "release");
  const runtime = assertObject(definition.runtime, "runtime");
  const entrypoint = assertObject(runtime.entrypoint, "runtime.entrypoint");
  if (!SKILL_ID.test(String(release.skillId || ""))) {
    throw new Error("release.skillId is invalid.");
  }
  if (!STABLE_VERSION.test(String(release.version || ""))) {
    throw new Error("release.version must be stable SemVer.");
  }
  if (!new Set(["current", "planned"]).has(release.state)) {
    throw new Error("release.state must be current or planned.");
  }
  if (path.basename(skillDirectory) !== release.skillId) {
    throw new Error("release.skillId must match the platform skill directory name.");
  }
  if (!STABLE_VERSION.test(String(runtime.version || ""))) {
    throw new Error("runtime.version must be stable SemVer.");
  }
  if (!STABLE_VERSION.test(String(runtime.minimumHostVersion || ""))) {
    throw new Error("runtime.minimumHostVersion must be stable SemVer.");
  }
  if (!ALLOWED_INTERPRETERS.has(entrypoint.interpreter)) {
    throw new Error("runtime.entrypoint.interpreter is unsupported.");
  }
  const entrypointPath = validatePackagePath(
    entrypoint.path,
    "runtime.entrypoint.path",
  );

  if (!Array.isArray(runtime.capabilities)) {
    throw new Error("runtime.capabilities must be an array.");
  }
  const capabilities = runtime.capabilities.map((capability) => {
    if (!ALLOWED_CAPABILITIES.has(capability)) {
      throw new Error(`Unsupported runtime capability: ${capability}.`);
    }
    return capability;
  });
  if (new Set(capabilities).size !== capabilities.length) {
    throw new Error("runtime.capabilities must not contain duplicates.");
  }
  if (!Array.isArray(runtime.files) || runtime.files.length === 0) {
    throw new Error("runtime.files must contain at least one file.");
  }

  return {
    definitionPath,
    release,
    runtime,
    entrypointPath,
    capabilities,
  };
};

/**
 * Return package bytes and safe metadata without signing. Signing remains a
 * backend trust assertion; keeping private keys out of this repository is an
 * intentional boundary, not a missing build step.
 */
export const buildRuntimePackage = (rawSkillDirectory) => {
  const skillDirectory = path.resolve(rawSkillDirectory);
  const definition = readReleaseDefinition(skillDirectory);
  const seenPackagePaths = new Set();
  const files = definition.runtime.files.map((rawFile, index) => {
    const file = assertObject(rawFile, `runtime.files[${index}]`);
    const sourcePath = validatePackagePath(
      file.source,
      `runtime.files[${index}].source`,
    );
    const packagePath = validatePackagePath(
      file.path,
      `runtime.files[${index}].path`,
    );
    const portablePackagePath = packagePath.toLocaleLowerCase("en-US");
    if (seenPackagePaths.has(portablePackagePath)) {
      throw new Error(`Duplicate or case-colliding package path: ${packagePath}.`);
    }
    seenPackagePaths.add(portablePackagePath);

    if (file.mode !== 0o644 && file.mode !== 0o755) {
      throw new Error(`runtime.files[${index}].mode must be 420 or 493.`);
    }
    const absoluteSourcePath = path.resolve(skillDirectory, sourcePath);
    const relativeSourcePath = path.relative(skillDirectory, absoluteSourcePath);
    if (
      relativeSourcePath.startsWith("..")
      || path.isAbsolute(relativeSourcePath)
    ) {
      throw new Error(`Runtime source escapes the skill directory: ${sourcePath}.`);
    }

    const stat = fs.lstatSync(absoluteSourcePath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`Runtime source must be a regular non-symlink file: ${sourcePath}.`);
    }
    const bytes = fs.readFileSync(absoluteSourcePath);
    if (bytes.length === 0) {
      throw new Error(`Runtime source is empty: ${sourcePath}.`);
    }
    return {
      path: packagePath,
      mode: file.mode,
      sha256: sha256(bytes),
      contentBase64: bytes.toString("base64"),
    };
  });

  if (!seenPackagePaths.has(definition.entrypointPath.toLocaleLowerCase("en-US"))) {
    throw new Error("runtime.entrypoint.path is missing from runtime.files.");
  }
  const entrypointFile = files.find((file) => file.path === definition.entrypointPath);
  if (definition.runtime.entrypoint.interpreter === "executable" && entrypointFile?.mode !== 0o755) {
    throw new Error("An executable entrypoint must use mode 0755.");
  }

  // Property order and compact JSON are fixed so identical source produces
  // identical package bytes and therefore the same package SHA-256 everywhere.
  const runtimePackage = {
    format: PACKAGE_FORMAT,
    skill: {
      id: definition.release.skillId,
      runtimeVersion: definition.runtime.version,
    },
    entrypoint: {
      path: definition.entrypointPath,
      interpreter: definition.runtime.entrypoint.interpreter,
    },
    capabilities: definition.capabilities,
    files,
  };
  // The final LF is part of the canonical package bytes. Besides keeping the
  // artifact a normal text file, it reproduces already published packages
  // byte-for-byte when their source and manifest are unchanged.
  const packageBytes = Buffer.from(`${JSON.stringify(runtimePackage)}\n`, "utf8");

  return {
    definitionPath: definition.definitionPath,
    releaseState: definition.release.state,
    skillId: definition.release.skillId,
    skillVersion: definition.release.version,
    runtimeVersion: definition.runtime.version,
    minimumHostVersion: definition.runtime.minimumHostVersion,
    packageBytes,
    packageSha256: sha256(packageBytes),
    packageSizeBytes: packageBytes.length,
    manifest: {
      format: runtimePackage.format,
      skill: runtimePackage.skill,
      entrypoint: runtimePackage.entrypoint,
      capabilities: runtimePackage.capabilities,
      files: files.map(({ contentBase64: _contentBase64, ...file }) => ({
        ...file,
        sizeBytes: Buffer.from(contentBase64For(file, runtimePackage), "base64").length,
      })),
    },
  };
};

/** Locate original base64 after the content-free manifest projection above. */
const contentBase64For = (manifestFile, runtimePackage) => (
  runtimePackage.files.find((file) => file.path === manifestFile.path)?.contentBase64 || ""
);

const parseArguments = (argv) => {
  const options = {
    skillDirectory: "",
    outputPath: "",
    check: false,
    expectedSkillVersion: "",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--skill-dir") options.skillDirectory = argv[++index] || "";
    else if (argument === "--output") options.outputPath = argv[++index] || "";
    else if (argument === "--check") options.check = true;
    else if (argument === "--expect-skill-version") {
      options.expectedSkillVersion = argv[++index] || "";
    } else {
      throw new Error(`Unknown argument: ${argument}.`);
    }
  }
  if (!options.skillDirectory) throw new Error("--skill-dir is required.");
  if (options.check === Boolean(options.outputPath)) {
    throw new Error("Choose exactly one of --check or --output.");
  }
  return options;
};

const run = () => {
  const options = parseArguments(process.argv.slice(2));
  const result = buildRuntimePackage(options.skillDirectory);
  if (
    options.expectedSkillVersion
    && result.skillVersion !== options.expectedSkillVersion
  ) {
    throw new Error(
      `Tag expects skill version ${options.expectedSkillVersion}, `
      + `but release.json declares ${result.skillVersion}.`,
    );
  }

  if (options.outputPath) {
    const outputPath = path.resolve(options.outputPath);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    const temporaryPath = `${outputPath}.tmp-${process.pid}`;
    fs.writeFileSync(temporaryPath, result.packageBytes, { mode: 0o600 });
    fs.renameSync(temporaryPath, outputPath);
  }

  process.stdout.write(`${JSON.stringify({
    skillId: result.skillId,
    skillVersion: result.skillVersion,
    releaseState: result.releaseState,
    runtimeVersion: result.runtimeVersion,
    minimumHostVersion: result.minimumHostVersion,
    packageSha256: result.packageSha256,
    packageSizeBytes: result.packageSizeBytes,
    outputPath: options.outputPath ? path.resolve(options.outputPath) : null,
  })}\n`);
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    run();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
