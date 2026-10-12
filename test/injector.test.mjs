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
const installerSource = await readFile(
  new URL("../scripts/install-macos-launcher.sh", import.meta.url),
  "utf8",
);
const injectionSource = await readFile(
  new URL("../inject/codex-taskboard.user.js", import.meta.url),
  "utf8",
);
const packageJson = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
);

test("the resident injector supervises an independently-lived local Taskboard service", () => {
  assert.match(source, /function createTaskboardSupervisor/);
  assert.match(source, /function readTaskboardHealth/);
  assert.match(source, /function healthMatchesCurrentProject/);
  assert.match(source, /function healthBelongsToAnotherProject/);
  assert.match(source, /projectRoot/);
  assert.match(source, /Taskboard port \$\{resolvePort\(\)\} is owned by/);
  assert.match(source, /ensureInFlight/);
  assert.match(source, /restartInFlight/);
  assert.match(source, /if \(restartInFlight\) return restartInFlight/);
  assert.match(source, /async function stopCurrentTaskboardServers/);
  assert.match(source, /async function stopTaskboardServerProcess/);
  assert.match(source, /process\.kill\(pid, "SIGKILL"\)/);
  assert.match(source, /async function startFreshTaskboard/);
  assert.match(source, /async function restart\(\)/);
  assert.match(source, /await supervisor\.ensure\(\)/);
  assert.match(source, /it will be restarted automatically/);
  assert.match(source, /AbortSignal\.timeout\(1_500\)/);
  assert.match(source, /CODEX_TASKBOARD_HOST: "127\.0\.0\.1"/);
  assert.match(source, /CODEX_TASKBOARD_PORT: String\(resolvePort\(\)\)/);
  assert.match(source, /residentTaskboardServerPids\(\)/);
  assert.match(source, /event: "taskboard-health-delayed"/);
  assert.match(source, /return \{ status: "degraded", restarted: false \}/);
  assert.match(source, /event: "taskboard-startup-delayed"/);
  assert.match(source, /"\/usr\/sbin\/taskpolicy"/);
  assert.match(source, /\["-a", process\.execPath/);
  assert.match(source, /startTaskboard\(\{ detached: true \}\)/);
  assert.match(source, /started\.unref\(\)/);
  assert.match(source, /function detach\(\) \{\s*child = null;\s*\}/);
  assert.match(runtimeSource, /findResidentTaskboardServerPids/);
});

test("the CDP bridge accepts service, composer, and exact thread correlation actions", () => {
  assert.match(source, /const hostBindingName = "__codexTaskboardHostV1"/);
  assert.match(runtimeSource, /request\.action === "ensure"/);
  assert.match(runtimeSource, /request\.action === "restart-service"/);
  assert.match(source, /restartService: \(\) => supervisor\.restart\(\)/);
  assert.match(runtimeSource, /request\.action === "prefill-task-composer"/);
  assert.match(runtimeSource, /request\.action === "resolve-task-thread"/);
  assert.match(runtimeSource, /request\.action === "rename-thread"/);
  assert.match(source, /function requestCodexThreadRenameViaCdp/);
  assert.match(source, /"thread\/name\/set"/);
  assert.match(runtimeSource, /request\.instruction\.length <= 8_192/);
  assert.match(runtimeSource, /request\.skillPath\.length <= 1_024/);
  assert.match(source, /function prefillTaskComposerViaCdp/);
  assert.match(source, /function submitTaskComposerViaCdp/);
  assert.match(source, /label === "发送" \|\| label === "send" \|\| label === "submit"/);
  assert.match(runtimeSource, /typeof request\.submit === "boolean"/);
  assert.match(source, /resolveCodexSessionByMarker/);
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

test("task composer waits for asynchronously loaded personal Skills", () => {
  const prefillSource = source.slice(
    source.indexOf("async function prefillTaskComposerViaCdp"),
    source.indexOf("async function prefillPlainComposerViaCdp"),
  );
  assert.match(prefillSource, /const composerDeadline = Date\.now\(\) \+ 8_000/);
  assert.match(prefillSource, /const skillSelectionDeadline = Date\.now\(\) \+ 12_000/);
  assert.match(prefillSource, /const mentionDeadline = Date\.now\(\) \+ 4_000/);
  assert.match(
    prefillSource,
    /if \(!selection\.result\.value\?\.found\) \{\s*await new Promise\(\(resolve\) => setTimeout\(resolve, 80\)\);\s*continue;/,
  );
  assert.doesNotMatch(prefillSource, /if \(!selection\.result\.value\?\.found\) break/);
});

test("composer verification tolerates ProseMirror paragraph boundaries", () => {
  const composerSource = source.slice(
    source.indexOf("async function prefillTaskComposerViaCdp"),
    source.indexOf("async function sendHostResponse"),
  );
  const lineBasedChecks = composerSource.match(/instruction\.split\(\/\\\\r\?\\\\n\/\)/g) || [];
  assert.equal(lineBasedChecks.length, 5);
  assert.match(
    composerSource,
    /instructionParts\.every\(\(part\) => editorText\.includes\(part\)\)/,
  );
  assert.doesNotMatch(composerSource, /textContent \|\| ""\)\.includes\(instruction\)/);
});

test("new task threads use a durable request marker instead of sidebar ordering", () => {
  assert.match(injectionSource, /pendingThreadLinkRequest\.v2/);
  assert.match(injectionSource, /\[taskboard-request:\$\{requestId\}\]/);
  assert.match(injectionSource, /requestHost\("resolve-task-thread"/);
  assert.doesNotMatch(injectionSource, /检测到多个新会话/);
  assert.doesNotMatch(injectionSource, /ambiguitySeenCount/);
  assert.match(injectionSource, /THREAD_LINK_BLOCKING_TIMEOUT_MS = 5 \* 60 \* 1_000/);
  assert.match(injectionSource, /releaseExpiredThreadTransaction\(\)/);
});

test("the CDP bridge exposes only the fixed Taskboard automation operations", () => {
  assert.match(source, /parseTaskboardAutomationHostRequest/);
  assert.match(source, /reconcileTaskboardAutomation/);
  assert.match(runtimeSource, /request\.action === "automation"/);
  assert.match(source, /function requestCodexAutomationViaCdp/);
  assert.match(source, /new Set\(\[\s*"list-automations",\s*"automation-create",\s*"automation-update",\s*"thread\/name\/set",\s*\]\)/);
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
  assert.match(launcherSource, /--disable-features=LocalNetworkAccessChecks/);
  assert.match(source, /--disable-features=LocalNetworkAccessChecks/);
  assert.match(launcherSource, /if codex_is_running; then/);
  assert.match(launcherSource, /inject_current_codex/);
  assert.match(launcherSource, /--port "\$cdp_port" --open/);
  assert.match(launcherSource, /leaving the current session untouched/);
  assert.doesNotMatch(launcherSource, /osascript/);
  assert.doesNotMatch(launcherSource, /kill -TERM/);
});

test("the login supervisor is passive and never requests a Codex restart", () => {
  assert.match(supervisorSource, /unsetopt BG_NICE/);
  assert.match(supervisorSource, /taskpolicy -B -p \$\$/);
  assert.match(supervisorSource, /taskpolicy -a "\$node_binary" "\$injector"/);
  assert.match(supervisorSource, /--watch --open --attach-existing/);
  assert.match(supervisorSource, /codex-taskboard-supervisor\.lock/);
  assert.match(supervisorSource, /owns_lock=true/);
  assert.match(supervisorSource, /Another Taskboard supervisor already owns/);
  assert.match(supervisorSource, /attached_cdp_signature/);
  assert.match(supervisorSource, /cdp_failure_threshold=6/);
  assert.match(supervisorSource, /CDP probe delayed/);
  assert.match(supervisorSource, /cdp-unavailable-after-\$\{cdp_failure_count\}-probes/);
  assert.match(supervisorSource, /Taskboard service remains running/);
  assert.match(supervisorSource, /trigger=\$restart_trigger/);
  assert.match(supervisorSource, /function stop_duplicate_injectors|stop_duplicate_injectors\(\)/);
  assert.match(supervisorSource, /Stopping duplicate Taskboard injector/);
  assert.match(supervisorSource, /targets_port = explicit_port \|\| !has_any_port/);
  assert.match(supervisorSource, /waiting without restarting or quitting it/);
  assert.doesNotMatch(supervisorSource, /osascript/);
  assert.doesNotMatch(supervisorSource, /--launch/);
  assert.doesNotMatch(supervisorSource, /tell application/);
});

test("the macOS installer removes stale Taskboard LaunchAgents before installing the canonical one", () => {
  assert.match(installerSource, /cleanup_conflicting_launch_agent/);
  assert.match(installerSource, /\*taskboard\*\.plist/);
  assert.match(installerSource, /ProgramArguments:1/);
  assert.match(installerSource, /CODEX_TASKBOARD_DATA_DIR/);
  assert.match(installerSource, /launchctl bootout/);
  assert.match(installerSource, /rm -f "\$candidate"/);
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

test("a completed web build reloads the current injection source and iframe", () => {
  assert.match(packageJson.scripts.build, /--refresh-if-running/);
  assert.match(packageJson.scripts["codex:refresh"], /--refresh/);
  assert.match(source, /async function refreshTaskboardFrames/);
  assert.match(source, /const \{ source, sourceHash \} = await currentInjectionSource\(\)/);
  assert.match(source, /const reconciled = await reconcileInjectionRuntime\(\{/);
  assert.match(source, /sourceReplaced: reconciled\.replaced/);
  assert.match(source, /function codexDebuggingPorts/);
  assert.match(source, /--remote-debugging-port=/);
  assert.match(source, /taskboard\.reloadFrame\(\)/);
  assert.match(source, /__codex_taskboard_refresh/);
  assert.match(source, /if \(options\.refresh\) await restartResidentInjectorForRefresh\(port\)/);
});

test("renderer recovery tolerates transient delays and reattaches without reloading Codex", () => {
  assert.match(source, /const hostHeartbeatTimeoutMs = 5_000/);
  assert.match(source, /const hostHeartbeatFailureThreshold = 3/);
  assert.match(source, /const heartbeatFailures = new Map\(\)/);
  assert.match(source, /"cdp-heartbeat-delayed"/);
  assert.match(source, /"cdp-reconnect-required"/);
  assert.match(source, /classifyHeartbeatFailure/);
  assert.match(source, /const closeInjectedTargets = \(\) =>/);
  assert.match(source, /if \(!cdpReachable && options\.attachExisting\)/);
  assert.match(source, /await waitUntilReachable\(cdpVersionUrl, 10_000\)/);
  assert.match(source, /injectedTargets\.forEach\(\(connection\) => connection\.close\(\)\)/);
  assert.match(source, /closeInjectedTargets\(\);\s*supervisor\.detach\(\);/);
  assert.match(source, /true,\s*options\.startupToken,/);
  assert.match(launcherSource, /--open --attach-existing/);
});

test("an explicit service restart has one timeout budget longer than backend cleanup and startup", () => {
  assert.match(source, /forceAfterMs: 1_000/);
  assert.match(source, /timeoutMs: 3_000/);
  assert.match(injectionSource, /const SERVICE_RESTART_TIMEOUT_MS = 16_000/);
  assert.match(
    injectionSource,
    /requestHost\("restart-service", \{\}, \{\s*requireLiveHeartbeat: false,\s*timeoutMs: SERVICE_RESTART_TIMEOUT_MS,/,
  );
});

test("a fresh renderer performs one CSP bootstrap reload before loading Taskboard", () => {
  assert.match(source, /rendererBootstrapReason/);
  assert.match(source, /event: "cdp-csp-bootstrap-reload"/);
  assert.match(source, /reason: bootstrapReason/);
  assert.match(source, /await cdp\.send\("Page\.reload"\)/);
});

test("an iframe URL is not reported loaded before the Taskboard ready handshake makes it visible", () => {
  assert.match(source, /frameVisible: document\.getElementById\("codex-taskboard-frame"\)\?\.hidden === false/);
  assert.match(source, /!status\.pageVisible \|\| !status\.frameUrl \|\| !status\.frameVisible/);
  assert.match(source, /status\.frameVisible && status\.frameUrl/);
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
