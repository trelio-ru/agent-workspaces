import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  detectAgentRuntimeAttestation,
  evaluatePinnedRuntimePolicy,
  resolveInitialChatTitleReminder,
} from "../scripts/trelio-runtime-policy.mjs";

const runtimePolicyScriptPath = fileURLToPath(
  new URL("../scripts/trelio-runtime-policy.mjs", import.meta.url),
);

const runPolicyHook = (hookInput, environment) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [runtimePolicyScriptPath], {
    env: {
      ...process.env,
      CLAUDE_CODE_ENTRYPOINT: "",
      CLAUDE_EFFORT: "",
      CODEX_THREAD_ID: "",
      ...environment,
    },
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
  child.once("error", reject);
  child.once("close", (exitCode) => {
    resolve({ exitCode, stdout, stderr });
  });
  child.stdin.end(JSON.stringify(hookInput));
});

const buildPolicySnapshot = ({
  mode = "enforce",
  otherClientsAction = "deny",
} = {}) => ({
  schemaVersion: 1,
  revision: {
    revisionId: "11111111-1111-4111-8111-111111111111",
    version: 1,
    createdAt: "2026-07-26T12:00:00.000Z",
  },
  policy: {
    schemaVersion: 1,
    mode,
    providers: {
      codex: {
        unlistedModelsAction: "deny",
        models: [
          {
            modelId: "gpt-5.6-sol",
            decision: "allow",
            minimumEffort: "high",
          },
        ],
      },
      claudeCode: {
        unlistedModelsAction: "deny",
        models: [
          {
            modelId: "claude-opus-5",
            decision: "allow",
            minimumEffort: "xhigh",
          },
        ],
      },
    },
    otherClientsAction,
  },
});

test("new Codex startup receives one non-blocking chat title reminder", async () => {
  const threadId = "019f9fcd-899a-72b3-91f6-fdf3134381bb";
  const hookInput = {
    hook_event_name: "SessionStart",
    source: "startup",
  };

  const reminder = resolveInitialChatTitleReminder({
    hookInput,
    environment: {
      CODEX_THREAD_ID: threadId,
    },
  });
  const hookResult = await runPolicyHook(hookInput, {
    CODEX_THREAD_ID: threadId,
  });

  assert.match(reminder, /первый ход нового основного чата/u);
  assert.match(reminder, /В следующих ходах автоматически к названию не возвращайся/u);
  assert.equal(hookResult.exitCode, 0);
  assert.equal(hookResult.stdout, `${reminder}\n`);
  assert.equal(hookResult.stderr, "");
});

test("chat title reminder stays silent outside the first Codex startup", () => {
  const codexEnvironment = {
    CODEX_THREAD_ID: "019f9fcd-899a-72b3-91f6-fdf3134381bb",
  };

  for (const source of ["resume", "clear", "compact"]) {
    assert.equal(resolveInitialChatTitleReminder({
      hookInput: {
        hook_event_name: "SessionStart",
        source,
      },
      environment: codexEnvironment,
    }), null);
  }

  assert.equal(resolveInitialChatTitleReminder({
    hookInput: {
      hook_event_name: "PreToolUse",
      source: "startup",
    },
    environment: codexEnvironment,
  }), null);
  assert.equal(resolveInitialChatTitleReminder({
    hookInput: {
      hook_event_name: "SessionStart",
      source: "startup",
      effort: { level: "high" },
    },
    environment: {
      ...codexEnvironment,
      CLAUDE_CODE_ENTRYPOINT: "cli",
    },
  }), null);
});

test("Codex attestation reads the actual effort from the current turn context", async () => {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "trelio-codex-policy-"));
  const transcriptPath = path.join(temporaryDirectory, "rollout.jsonl");

  try {
    await writeFile(
      transcriptPath,
      [
        JSON.stringify({
          type: "turn_context",
          payload: {
            model: "gpt-5.6-sol",
            effort: "medium",
          },
        }),
        JSON.stringify({
          type: "turn_context",
          payload: {
            model: "gpt-5.6-sol",
            effort: "xhigh",
          },
        }),
      ].join("\n"),
    );

    const result = await detectAgentRuntimeAttestation({
      hookInput: {
        hook_event_name: "PreToolUse",
        model: "gpt-5.6-sol",
        transcript_path: transcriptPath,
      },
      environment: {
        CODEX_THREAD_ID: "019f9fcd-899a-72b3-91f6-fdf3134381bb",
      },
    });

    assert.equal(result.clientFamily, "codex");
    assert.equal(result.modelId, "gpt-5.6-sol");
    assert.equal(result.effortLevel, "xhigh");
    assert.equal(result.evidenceLevel, "local_observed");
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test("Claude Code attestation uses hook model and effective effort", async () => {
  const result = await detectAgentRuntimeAttestation({
    hookInput: {
      hook_event_name: "PreToolUse",
      model: "claude-opus-5",
      effort: {
        level: "max",
      },
    },
    environment: {
      CLAUDE_PLUGIN_ROOT: "/tmp/plugin",
    },
  });

  assert.equal(result.clientFamily, "claude-code");
  assert.equal(result.modelId, "claude-opus-5");
  assert.equal(result.effortLevel, "max");
  assert.equal(result.evidenceLevel, "local_observed");
});

test("Codex is not misclassified when the compatibility plugin root is present", async () => {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "trelio-codex-policy-"));
  const transcriptPath = path.join(temporaryDirectory, "rollout.jsonl");

  try {
    await writeFile(
      transcriptPath,
      JSON.stringify({
        type: "turn_context",
        payload: {
          model: "gpt-5.6-terra",
          effort: "high",
        },
      }),
    );

    const result = await detectAgentRuntimeAttestation({
      hookInput: {
        hook_event_name: "PreToolUse",
        model: "gpt-5.6-terra",
        transcript_path: transcriptPath,
      },
      environment: {
        CODEX_THREAD_ID: "019f9fcd-899a-72b3-91f6-fdf3134381bb",
        // Codex устанавливает эту совместимую с Claude plugins переменную.
        // Само её наличие не доказывает, что runtime — Claude Code.
        CLAUDE_PLUGIN_ROOT: "/tmp/plugin",
      },
    });

    assert.equal(result.clientFamily, "codex");
    assert.equal(result.effortLevel, "high");
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test("a Cowork-like runtime without Claude Code evidence stays an other client", async () => {
  const result = await detectAgentRuntimeAttestation({
    environment: {
      // Session model alone is insufficient: Cowork may expose the same plugin
      // data without the Claude Code effort/tool hook contract.
      TRELIO_CLAUDE_MODEL: "claude-opus-5",
      CLAUDE_PLUGIN_ROOT: "/tmp/plugin",
    },
  });

  assert.equal(result.clientFamily, "other");
  assert.equal(result.evidenceLevel, "unavailable");
});

test("pinned strict policy blocks low effort and accepts sufficient effort", () => {
  const snapshot = buildPolicySnapshot();
  const low = evaluatePinnedRuntimePolicy(snapshot, {
    clientFamily: "codex",
    modelId: "gpt-5.6-sol",
    effortLevel: "medium",
    evidenceLevel: "local_observed",
  });
  const high = evaluatePinnedRuntimePolicy(snapshot, {
    clientFamily: "codex",
    modelId: "gpt-5.6-sol",
    effortLevel: "high",
    evidenceLevel: "local_observed",
  });

  assert.equal(low.satisfied, false);
  assert.equal(low.reasonCode, "EFFORT_TOO_LOW");
  assert.equal(high.satisfied, true);
});

test("other clients use the explicit allow or deny fallback", () => {
  const attestation = {
    clientFamily: "other",
    modelId: null,
    effortLevel: null,
    evidenceLevel: "unavailable",
  };
  const denied = evaluatePinnedRuntimePolicy(
    buildPolicySnapshot({ otherClientsAction: "deny" }),
    attestation,
  );
  const allowed = evaluatePinnedRuntimePolicy(
    buildPolicySnapshot({ otherClientsAction: "allow" }),
    attestation,
  );

  assert.equal(denied.reasonCode, "OTHER_CLIENT_DENIED");
  assert.equal(allowed.reasonCode, "OTHER_CLIENT_ALLOWED");
  assert.equal(allowed.satisfied, true);
});

test("observe mode records a failed evaluation without enforcing it", () => {
  const result = evaluatePinnedRuntimePolicy(
    buildPolicySnapshot({ mode: "observe" }),
    {
      clientFamily: "codex",
      modelId: "gpt-5.4-mini",
      effortLevel: "xhigh",
      evidenceLevel: "local_observed",
    },
  );

  assert.equal(result.satisfied, false);
  assert.equal(result.enforced, false);
});

test("client guard rejects an effort level unsupported by the selected model", () => {
  const snapshot = buildPolicySnapshot();
  snapshot.policy.providers.claudeCode.models[0].minimumEffort = "max";

  const result = evaluatePinnedRuntimePolicy(snapshot, {
    clientFamily: "claude-code",
    modelId: "claude-opus-5",
    effortLevel: "ultra",
    evidenceLevel: "local_observed",
  });

  assert.equal(result.satisfied, false);
  assert.equal(result.reasonCode, "EFFORT_TOO_LOW");
});

test("PreToolUse hook blocks a low-effort Codex action inside a pinned Run", async () => {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "trelio-policy-hook-"));
  const workspaceDirectory = path.join(temporaryDirectory, "workspace");
  const transcriptPath = path.join(temporaryDirectory, "rollout.jsonl");

  try {
    await mkdir(workspaceDirectory);
    await writeFile(
      path.join(temporaryDirectory, ".trelio-run.json"),
      `${JSON.stringify({ runtimePolicySnapshot: buildPolicySnapshot() })}\n`,
      { mode: 0o600 },
    );
    await writeFile(
      transcriptPath,
      `${JSON.stringify({
        type: "turn_context",
        payload: {
          model: "gpt-5.6-sol",
          effort: "medium",
        },
      })}\n`,
    );

    const result = await runPolicyHook(
      {
        hook_event_name: "PreToolUse",
        cwd: workspaceDirectory,
        model: "gpt-5.6-sol",
        transcript_path: transcriptPath,
      },
      {
        CODEX_THREAD_ID: "019f9fcd-899a-72b3-91f6-fdf3134381bb",
      },
    );

    assert.equal(result.exitCode, 2);
    assert.match(result.stderr, /EFFORT_TOO_LOW/u);
    assert.equal(result.stdout, "");
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});
