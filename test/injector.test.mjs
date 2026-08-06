import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const source = await readFile(new URL("../scripts/codex-injector.mjs", import.meta.url), "utf8");
const runtimeSource = await readFile(
  new URL("../scripts/codex-injector-runtime.mjs", import.meta.url),
  "utf8",
);
const launcherSource = await readFile(
  new URL("../scripts/codex-taskboard-launcher.sh", import.meta.url),
  "utf8",
);
const supervisorSource = await readFile(
  new URL("../scripts/codex-taskboard-supervisor.sh", import.meta.url),
  "utf8",
);
const injectionSource = await readFile(
  new URL("../inject/codex-taskboard.user.js", import.meta.url),
  "utf8",
);
const packageJson = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
);

test("the resident injector supervises the fixed local Taskboard service", () => {
  assert.match(source, /function createTaskboardSupervisor/);
  assert.match(source, /await isReachable\(taskboardHealthUrl\)/);
  assert.match(source, /ensureInFlight/);
  assert.match(source, /await supervisor\.ensure\(\)/);
  assert.match(source, /it will be restarted automatically/);
  assert.match(source, /AbortSignal\.timeout\(1_500\)/);
  assert.match(source, /CODEX_TASKBOARD_HOST: "127\.0\.0\.1"/);
  assert.match(source, /CODEX_TASKBOARD_PORT: String\(resolvePort\(\)\)/);
});

test("the CDP bridge accepts only service ensure and native Skill composer prefill actions", () => {
  assert.match(source, /const hostBindingName = "__codexTaskboardHostV1"/);
  assert.match(runtimeSource, /request\.action === "ensure"/);
  assert.match(runtimeSource, /request\.action === "prefill-task-composer"/);
  assert.match(runtimeSource, /request\.instruction\.length <= 8_192/);
  assert.match(runtimeSource, /request\.skillPath\.length <= 1_024/);
  assert.match(source, /function prefillTaskComposerViaCdp/);
  assert.match(source, /cdp\.send\("Input\.insertText", \{ text: "\$" \}\)/);
  assert.match(source, /data-composer-overlay-floating-ui/);
  assert.match(source, /button\[data-list-navigation-item="true"\]/);
  assert.match(source, /\[skill-mention-name\]/);
  assert.match(source, /skill-mention-path/);
  assert.match(source, /cdp\.send\("Input\.insertText", \{ text: instruction \}\)/);
  assert.match(source, /Runtime\.bindingCalled/);
  assert.match(runtimeSource, /params\.executionContextId/);
  assert.match(source, /hostResponse/);
  assert.match(source, /if \(keepAlive\) await installTaskboardHostBinding/);
  assert.match(source, /publishHostHeartbeat/);
  assert.match(source, /__codexTaskboardHostHeartbeatV1/);
});

test("the CDP bridge exposes only the fixed Taskboard automation operations", () => {
  assert.match(source, /parseTaskboardAutomationHostRequest/);
  assert.match(source, /reconcileTaskboardAutomation/);
  assert.match(runtimeSource, /request\.action === "automation"/);
  assert.match(source, /function requestCodexAutomationViaCdp/);
  assert.match(source, /new Set\(\[\s*"list-automations",\s*"automation-create",\s*"automation-update",\s*\]\)/);
  assert.match(source, /bridge\.sendMessageFromView\(\{\s*type: "fetch",\s*requestId,/);
  assert.match(source, /method: "POST"/);
  assert.match(source, /vscode:\/\/codex\/\$\{method\}/);
  assert.match(source, /body: JSON\.stringify\(params\)/);
  assert.match(source, /message\.type !== "fetch-response"/);
  assert.match(source, /message\.responseType/);
  assert.match(source, /message\.status/);
  assert.match(source, /message\.bodyJsonString/);
  assert.doesNotMatch(source, /automation-delete/);
  assert.doesNotMatch(source, /automations\.toml/);
});

test("the package injection command remains resident for tab-triggered recovery", () => {
  assert.match(packageJson.scripts["codex:inject"], /--watch/);
  assert.match(packageJson.scripts["codex:daemon"], /--daemon --open/);
  assert.match(source, /function startResidentInjector/);
  assert.match(source, /const defaultCodexDebuggingPort = 9229/);
  assert.match(source, /port: defaultCodexDebuggingPort/);
  assert.match(source, /--startup-token/);
  assert.match(source, /__codexTaskboardHostStartupTokenV1/);
});

test("the macOS Dock launcher enables loopback-only CDP before Codex starts", () => {
  assert.match(launcherSource, /--remote-debugging-address=127\.0\.0\.1/);
  assert.match(launcherSource, /--remote-debugging-port=\$cdp_port/);
  assert.match(launcherSource, /--remote-allow-origins=http:\/\/127\.0\.0\.1:/);
  assert.match(launcherSource, /if codex_is_running; then/);
  assert.match(launcherSource, /inject_current_codex/);
  assert.match(launcherSource, /--port "\$cdp_port" --open/);
  assert.match(launcherSource, /leaving the current session untouched/);
  assert.doesNotMatch(launcherSource, /osascript/);
  assert.doesNotMatch(launcherSource, /kill -TERM/);
});

test("the login supervisor is passive and never requests a Codex restart", () => {
  assert.match(supervisorSource, /--watch --open/);
  assert.match(supervisorSource, /attached_cdp_signature/);
  assert.match(supervisorSource, /Detected a new Codex CDP instance/);
  assert.match(supervisorSource, /function stop_duplicate_injectors|stop_duplicate_injectors\(\)/);
  assert.match(supervisorSource, /Stopping duplicate Taskboard injector/);
  assert.match(supervisorSource, /targets_port = explicit_port \|\| !has_any_port/);
  assert.match(supervisorSource, /waiting without restarting or quitting it/);
  assert.doesNotMatch(supervisorSource, /osascript/);
  assert.doesNotMatch(supervisorSource, /--launch/);
  assert.doesNotMatch(supervisorSource, /tell application/);
});

test("attach reconciles the renderer against a hashed current injection source", () => {
  assert.match(source, /createHash\("sha256"\)/);
  assert.match(source, /__CODEX_TASKBOARD_SOURCE_HASH__/);
  assert.match(source, /sourceHash: window\.__codexTaskboardInjection__\?\.sourceHash \|\| null/);
  assert.match(source, /const injectionScriptIdentifierName = "__CODEX_TASKBOARD_SCRIPT_IDENTIFIER__"/);
  assert.match(source, /scriptIdentifier: window\[\$\{JSON\.stringify\(injectionScriptIdentifierName\)\}\] \|\| null/);
  assert.match(source, /Page\.removeScriptToEvaluateOnNewDocument/);
  assert.match(source, /Page\.addScriptToEvaluateOnNewDocument/);
  assert.match(source, /reconcileInjectionRuntime/);
  assert.match(source, /expectedSourceHash/);
});

test("the injector ignores auxiliary Codex windows", () => {
  assert.match(source, /!target\.url\?\.includes\("initialRoute=%2Fglobal-dictation"\)/);
  assert.match(source, /!target\.url\?\.includes\("initialRoute=%2Favatar-overlay"\)/);
});

test("a completed web build refreshes an already-open Codex iframe", () => {
  assert.match(packageJson.scripts.build, /--refresh-if-running/);
  assert.match(packageJson.scripts["codex:refresh"], /--refresh/);
  assert.match(source, /async function refreshTaskboardFrames/);
  assert.match(source, /function codexDebuggingPorts/);
  assert.match(source, /--remote-debugging-port=/);
  assert.match(source, /taskboard\.reloadFrame\(\)/);
  assert.match(source, /__codex_taskboard_refresh/);
  assert.doesNotMatch(source, /if \(options\.refreshIfRunning\) await restartResidentInjectorForRefresh\(port\)/);
});

test("the injected iframe follows the configured local service port", () => {
  assert.match(source, /const taskboardPageUrl = `\$\{taskboardOrigin\}\/\?host=codex`/);
  assert.match(source, /window\.__CODEX_TASKBOARD_URL__ = \$\{JSON\.stringify\(taskboardPageUrl\)\}/);
});

test("an open Taskboard remounts on its existing surface when Codex has no native thread frame", () => {
  assert.match(injectionSource, /const existingSurface = page\.parentElement\?\.closest\?\.\("main"\)/);
  assert.match(injectionSource, /const surface = mount\?\.surface \|\| existingSurface/);
  assert.match(injectionSource, /if \(!surface\) return/);
});
