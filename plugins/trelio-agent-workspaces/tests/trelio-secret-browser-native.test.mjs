import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import {
  assertBrowserFillBindingUnchanged, browserFillBinding, buildNativeSecretBrowserHelper,
  EmbeddedBrowserUnavailable, nativeIdFromSecretSelector, openNativeSecretBrowserChannel,
  prepareSecretBrowserSession,
} from "../scripts/trelio-secret-browser-native.mjs";
import { createSecretBrowserControllerExpression, SecretBrowserFillError } from "../scripts/trelio-secret-browser.mjs";

const targetUrl = "https://login.example.test/account?flow=1";
const context = {
  grantId: "66666666-6666-4666-8666-666666666663",
  runId: "66666666-6666-4666-8666-666666666662",
  secretVersion: 1, clientFamily: "codex", deliveryMode: "browser", executable: "trelio-workspace",
  fieldKeys: ["username", "password"], targetOrigin: new URL(targetUrl).origin,
  targetUrlSha256: createHash("sha256").update(targetUrl).digest("hex"),
};
context.browserSteps = [{
  targetOrigin: context.targetOrigin, targetUrlSha256: context.targetUrlSha256,
  fields: [{ fieldKey: "username", selector: "#username" }, { fieldKey: "password", selector: "#password" }],
  submitSelector: "#login",
}];
const values = { username: "CANARY-native-user", password: "CANARY-native-password" };
const fixture = (reply = { status: "ready" }) => {
  const requests = [];
  let closed = false, chromeCalls = 0, builds = 0;
  return {
    requests,
    get closed() { return closed; },
    get chromeCalls() { return chromeCalls; },
    get builds() { return builds; },
    args: {
      context: structuredClone(context), targetUrl, platform: "darwin",
      buildHelper: async () => { builds++; return "/synthetic/private/helper"; },
      openChannel: () => ({
        request: async (request) => {
          requests.push(request);
          return request.command === "prepare" ? reply : { status: "succeeded" };
        },
        close: () => { closed = true; },
      }),
      runChrome: async () => { chromeCalls++; return { outcome: "succeeded" }; },
    },
  };
};

test("native selectors preserve CSS id meaning; compound, type and pseudo selectors fall back before delivery", () => {
  assert.equal(nativeIdFromSecretSelector("#login-password"), "login-password");
  assert.equal(nativeIdFromSecretSelector('[id="login.password"]'), "login.password");
  for (const selector of ["#password.hidden", "#password:focus", "input#password", "[name=password]", "#a #b", "#a\\:b"]) {
    assert.throws(() => nativeIdFromSecretSelector(selector), EmbeddedBrowserUnavailable);
  }
});

for (const platform of ["darwin", "win32"]) for (const clientFamily of ["codex", "claude-code"]) {
  test("auto prefers embedded with no secret in preflight: " + platform + "/" + clientFamily, async () => {
    const f = fixture();
    const session = await prepareSecretBrowserSession({ ...f.args, platform, context: { ...context, clientFamily } });
    assert.equal(session.surface, "embedded");
    assert.equal(f.chromeCalls, 0);
    assert.equal(f.requests.length, 1);
    assert.doesNotMatch(JSON.stringify(f.requests), /CANARY/);
    assert.equal(f.requests[0].steps[0].submitId, "login");
    assert.deepEqual(await session.fill({ secretValues: values }), { outcome: "succeeded" });
    assert.equal(f.requests[1].command, "fill");
    assert.equal(f.requests[1].values, values);
    await assert.rejects(session.fill({ secretValues: values }));
    assert.equal(f.requests.length, 2);
    assert.equal(f.chromeCalls, 0);
    await session.close();
    assert.ok(f.closed);
  });
}

for (const reasonCode of ["access_required", "application_unavailable", "accessibility_unavailable"]) {
  test("only preflight unavailability permits Chrome: " + reasonCode, async () => {
    const f = fixture({ status: "unavailable", reasonCode });
    const session = await prepareSecretBrowserSession(f.args);
    assert.equal(session.surface, "chrome");
    assert.equal(session.fallbackReason, reasonCode);
    assert.equal(f.chromeCalls, 0, "selection never launches Chrome before checkout");
    assert.ok(f.closed);
    await session.fill({});
    assert.equal(f.chromeCalls, 1);
    assert.doesNotMatch(JSON.stringify(f.requests), /CANARY/);
  });
}
for (const reasonCode of ["target_url_changed", "field_ambiguous", "field_not_found", "adapter_error", "timeout"]) {
  test("preflight failure cannot downgrade: " + reasonCode, async () => {
    const f = fixture({ status: "failed", reasonCode });
    await assert.rejects(prepareSecretBrowserSession(f.args), SecretBrowserFillError);
    assert.ok(f.closed);
    assert.equal(f.chromeCalls, 0);
    assert.equal(f.requests.length, 1);
  });
}
test("embedded-only forbids fallback; explicit Chrome does not inspect other apps", async () => {
  const f = fixture({ status: "unavailable", reasonCode: "access_required" });
  await assert.rejects(prepareSecretBrowserSession({ ...f.args, mode: "embedded" }), EmbeddedBrowserUnavailable);
  const g = fixture();
  assert.equal((await prepareSecretBrowserSession({ ...g.args, mode: "chrome" })).surface, "chrome");
  assert.equal(g.builds, 0);
});

test("a final button without an id uses one embedded field-only fill and no native submit", async () => {
  const f = fixture();
  // The caller identified a non-id login button on the empty page and retains
  // it for its ordinary browser click. It must not send that selector to AX/UIA
  // or let auto switch the value delivery to a different browser profile.
  delete f.args.context.browserSteps[0].submitSelector;
  const session = await prepareSecretBrowserSession({ ...f.args, mode: "embedded" });
  assert.equal(session.surface, "embedded");
  assert.equal(f.requests[0].steps[0].fields.length, 2);
  assert.equal(Object.hasOwn(f.requests[0].steps[0], "submitId"), false);
  assert.deepEqual(await session.fill({ secretValues: values }), { outcome: "succeeded" });
  assert.equal(f.requests.length, 2);
  assert.deepEqual(f.requests[1].values, values);
  assert.equal(f.chromeCalls, 0);
  await session.close();

  const unavailable = fixture({ status: "unavailable", reasonCode: "access_required" });
  delete unavailable.args.context.browserSteps[0].submitSelector;
  await assert.rejects(prepareSecretBrowserSession({ ...unavailable.args, mode: "embedded" }), EmbeddedBrowserUnavailable);
  assert.equal(unavailable.chromeCalls, 0);
  assert.equal(unavailable.requests.length, 1, "no value delivery when this same-tab plan cannot be prepared");
});

test("missing Run client identity and unsupported submit remain distinct pre-delivery failures", async () => {
  for (const [clientFamily, reason] of [[null, "client_unsupported"], ["codex", "selector_unsupported"]]) {
    const f = fixture();
    f.args.context.clientFamily = clientFamily;
    f.args.context.browserSteps[0].submitSelector = 'button[type="submit"]';
    await assert.rejects(prepareSecretBrowserSession({ ...f.args, mode: "embedded" }),
      (error) => error instanceof EmbeddedBrowserUnavailable && error.nativeReason === reason);
    assert.equal(f.builds, 0);
    assert.equal(f.requests.length, 0);
    assert.equal(f.chromeCalls, 0);
  }
});

test("native capability errors expose only allowlisted reason codes", () => {
  const error = new EmbeddedBrowserUnavailable("CANARY-private-helper-diagnostic");
  assert.equal(error.nativeReason, "helper_unavailable");
  assert.equal(error.reasonCode, "browser_unavailable");
  assert.doesNotMatch(error.message, /CANARY/u);
});


test("lost native reply after a setter never calls Chrome or repeats the write", async () => {
  const f = fixture();
  let calls = 0;
  const session = await prepareSecretBrowserSession({
    ...f.args,
    openChannel: () => ({
      request: async () => {
        if (++calls === 1) return { status: "ready" };
        throw new Error("synthetic broken pipe after mutation");
      }, close: () => {},
    }),
  });
  await assert.rejects(session.fill({ secretValues: values }));
  await assert.rejects(session.fill({ secretValues: values }));
  assert.equal(calls, 2);
  assert.equal(f.chromeCalls, 0);
});
test("consume must preserve every binding including application, submit control, version and field order", () => {
  assertBrowserFillBindingUnchanged(context, { ...context, values, encryptedPayload: { canary: true } });
  for (const mutation of [
    (c) => { c.clientFamily = "claude-code"; },
    (c) => { c.secretVersion++; },
    (c) => { c.runId = context.grantId; },
    (c) => { c.browserSteps[0].submitSelector = "#other-button"; },
    (c) => { c.browserSteps[0].fields.reverse(); },
  ]) {
    const candidate = structuredClone(context);
    mutation(candidate);
    assert.throws(() => assertBrowserFillBindingUnchanged(context, candidate));
  }
});
test("different URL, duplicate target ids and missing fields fail before any native process", async () => {
  const f = fixture();
  await assert.rejects(prepareSecretBrowserSession({ ...f.args, targetUrl: targetUrl + "changed" }));
  const duplicate = structuredClone(context);
  duplicate.browserSteps[0].fields[1].selector = '[id="username"]';
  await assert.rejects(prepareSecretBrowserSession({ ...f.args, context: duplicate }), (e) => e.reasonCode === "field_ambiguous");
  const missing = structuredClone(context);
  missing.browserSteps[0].fields.pop();
  assert.throws(() => browserFillBinding(missing));
  assert.equal(f.builds, 0);
});
test("multi-step native fill requires explicit advance button; legacy plans remain Chrome-compatible", async () => {
  const c = structuredClone(context);
  c.browserSteps = [
    { ...c.browserSteps[0], fields: [c.browserSteps[0].fields[0]] },
    { ...c.browserSteps[0], fields: [c.browserSteps[0].fields[1]] },
  ];
  const f = fixture();
  assert.equal((await prepareSecretBrowserSession({ ...f.args, context: c })).surface, "embedded");
  delete c.browserSteps[0].submitSelector;
  const g = fixture();
  const session = await prepareSecretBrowserSession({ ...g.args, context: c });
  assert.equal(session.fallbackReason, "step_unsupported");
  assert.equal(g.builds, 0);
});
test("native helper compiles locally, caches exact bytes and rejects an unprepared value without UI access", {
  skip: !["darwin", "win32"].includes(process.platform), timeout: 90_000,
}, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "trelio-native-helper-test-"));
  const ensurePrivateDirectory = async (directory) => {
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") await fs.chmod(directory, 0o700);
  };
  let channel;
  try {
    const executable = await buildNativeSecretBrowserHelper({ directory, ensurePrivateDirectory });
    assert.equal(await buildNativeSecretBrowserHelper({ directory, ensurePrivateDirectory }), executable);
    channel = openNativeSecretBrowserChannel({ executable });
    // No "prepare": the adapter must reject this command without enumerating,
    // selecting or inspecting Codex, Claude or any other application.
    assert.deepEqual(await channel.request({ command: "fill", values }), { status: "failed", reasonCode: "adapter_error" });
    await channel.close();
    if (process.platform === "win32") {
      // Exercise the constructor and its native lease without selecting an
      // application: this family is rejected before any process/UI discovery.
      channel = openNativeSecretBrowserChannel({ executable });
      assert.deepEqual(await channel.request({ command: "prepare", clientFamily: "other" }), {
        status: "unavailable", reasonCode: "client_unsupported",
      });
      await channel.close();
    }
    await fs.appendFile(executable, "modified");
    await assert.rejects(buildNativeSecretBrowserHelper({ directory, ensurePrivateDirectory }), /изменён/);
  } finally {
    await channel?.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("Windows UIA core fills a real synthetic document without keyboard focus and rejects stale bindings", {
  skip: process.platform !== "win32", timeout: 90_000,
}, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "trelio-native-uia-test-"));
  try {
    const executable = await buildNativeSecretBrowserHelper({
      directory, ensurePrivateDirectory: (p) => fs.mkdir(p, { recursive: true }),
    });
    const framework = path.join(process.env.SystemRoot, "Microsoft.NET", "Framework64", "v4.0.30319");
    const output = path.join(path.dirname(executable), "TrelioNativeFixture.exe");
    const exec = promisify(execFile);
    await exec(path.join(framework, "csc.exe"), [
      "/nologo", "/target:exe", "/out:" + output, "/reference:" + executable,
      "/reference:System.Xaml.dll",
      ...["UIAutomationClient", "UIAutomationTypes", "UIAutomationProvider", "WindowsBase", "PresentationCore", "PresentationFramework"]
        .map((name) => "/reference:" + path.join(framework, "WPF", name + ".dll")),
      fileURLToPath(new URL("./fixtures/native-secret-browser-windows.cs", import.meta.url)),
    ], { timeout: 30_000 }).catch((error) => {
      // This compiler only sees a synthetic fixture, never a real secret.
      throw new Error("Windows fixture compiler: " + (error.stdout || error.stderr || error.message));
    });
    const result = await exec(output, [], { timeout: 30_000 });
    assert.match(result.stdout, /Windows UIA:.*passed/);
    assert.doesNotMatch(result.stdout + result.stderr, /synthetic-native-user|synthetic-native-password/);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

// Exercise the actual isolated-world function instead of mirroring its logic.
// The synthetic DOM has two fields and a granted submit; input/change can
// synchronously mutate URL, which must stop the next secret before its setter.
const controllerFixture = (navigateAfterFirst = false) => {
  const location = { origin: context.targetOrigin, href: targetUrl };
  const events = [];
  class Input {
    constructor(id) { this.id = id; this.type = "text"; this.isConnected = true; this.disabled = false; this.readOnly = false; }
    get value() { return this.stored || ""; }
    set value(value) { this.stored = value; events.push(this.id); }
    getBoundingClientRect() { return { width: 10, height: 10 }; }
    dispatchEvent() { if (navigateAfterFirst && this.id === "username") location.href += "changed"; }
  }
  class Button extends Input { click() { events.push("submit"); } }
  const fields = { "#username": new Input("username"), "#password": new Input("password"), "#login": new Button("login") };
  const realm = vm.createContext({
    location, HTMLInputElement: Input, HTMLTextAreaElement: class {}, HTMLButtonElement: Button,
    InputEvent: class {}, Event: class {},
    getComputedStyle: () => ({ display: "block", visibility: "visible" }),
    document: { querySelectorAll: (selector) => fields[selector] ? [fields[selector]] : [] },
  });
  vm.runInContext(createSecretBrowserControllerExpression(context.targetOrigin, context.browserSteps[0].fields, "#login", targetUrl), realm);
  return { realm, events, fields };
};
test("Chrome fallback fills both fields then invokes only the explicitly granted button", () => {
  const f = controllerFixture();
  assert.equal(f.realm.__trelioSecretBrowserController().status, "ready");
  assert.equal(f.realm.__trelioSecretBrowserApply(values).outcome, "succeeded");
  assert.deepEqual(f.events, ["username", "password", "submit"]);
});
test("a synchronous page navigation stops the next Chrome setter and submit", () => {
  const f = controllerFixture(true);
  assert.equal(f.realm.__trelioSecretBrowserController().status, "ready");
  assert.equal(f.realm.__trelioSecretBrowserApply(values).outcome, "failed");
  assert.deepEqual(f.events, ["username"]);
  assert.equal(f.fields["#password"].value, "");
});
