import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildRuntimePackage,
  PACKAGE_FORMAT,
  validatePackagePath,
} from "./build-runtime-package.mjs";

const writeFixture = (root, overrides = {}) => {
  const skillDirectory = path.join(root, "fixture-skill");
  fs.mkdirSync(path.join(skillDirectory, "scripts"), { recursive: true });
  fs.writeFileSync(
    path.join(skillDirectory, "scripts", "runtime.mjs"),
    "#!/usr/bin/env node\nconsole.log('ok');\n",
  );
  fs.writeFileSync(
    path.join(skillDirectory, "release.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      release: {
        skillId: "fixture-skill",
        version: "1.2.3",
        state: "planned",
        summary: "Test fixture",
      },
      runtime: {
        version: "2.3.4",
        minimumHostVersion: "1.4.0",
        entrypoint: { path: "runtime.mjs", interpreter: "node" },
        capabilities: ["network"],
        files: [{
          source: "scripts/runtime.mjs",
          path: "runtime.mjs",
          mode: 493,
        }],
      },
      ...overrides,
    }, null, 2)}\n`,
  );
  return skillDirectory;
};

test("runtime package build is deterministic and content-addressed", () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "trelio-runtime-build-"));
  try {
    const skillDirectory = writeFixture(temporaryRoot);
    const first = buildRuntimePackage(skillDirectory);
    const second = buildRuntimePackage(skillDirectory);
    const parsed = JSON.parse(first.packageBytes.toString("utf8"));

    assert.equal(first.packageSha256, second.packageSha256);
    assert.deepEqual(first.packageBytes, second.packageBytes);
    assert.equal(parsed.format, PACKAGE_FORMAT);
    assert.deepEqual(parsed.skill, {
      id: "fixture-skill",
      runtimeVersion: "2.3.4",
    });
    assert.equal(parsed.files[0].path, "runtime.mjs");
    assert.match(parsed.files[0].sha256, /^[0-9a-f]{64}$/u);
    assert.equal(first.manifest.files[0].contentBase64, undefined);
    assert.equal(first.manifest.files[0].sizeBytes, 39);
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("portable package paths fail closed", () => {
  for (const unsafePath of ["../runtime.mjs", "runtime\\main.mjs", "CON", "a/../b"]) {
    assert.throws(() => validatePackagePath(unsafePath), /safe|normalized|portable/u);
  }
});

test("runtime sources cannot be symlinks", (context) => {
  if (process.platform === "win32") {
    context.skip("A non-elevated Windows runner cannot create this symlink fixture.");
    return;
  }
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "trelio-runtime-link-"));
  try {
    const skillDirectory = writeFixture(temporaryRoot);
    const runtimePath = path.join(skillDirectory, "scripts", "runtime.mjs");
    fs.unlinkSync(runtimePath);
    fs.symlinkSync(path.join(temporaryRoot, "outside.mjs"), runtimePath);
    assert.throws(
      () => buildRuntimePackage(skillDirectory),
      /regular non-symlink file/u,
    );
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});
