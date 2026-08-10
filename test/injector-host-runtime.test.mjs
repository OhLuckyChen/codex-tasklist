import assert from "node:assert/strict";
import { test } from "node:test";

import {
  classifyHeartbeatFailure,
  frameUrlMatches,
  findResidentInjectorPids,
  handleHostBindingPayload,
  reconcileInjectionRuntime,
  rendererBootstrapReason,
  restartResidentInjector,
} from "../scripts/codex-injector-runtime.mjs";

test("Taskboard frame matching permits in-app route parameters but rejects another origin or path", () => {
  const expected = "http://127.0.0.1:47823/?host=codex&__codex_taskboard_refresh=abc";
  assert.equal(frameUrlMatches(
    "http://127.0.0.1:47823/?host=codex&__codex_taskboard_refresh=abc&view=global&issue=LOCAL-1",
    expected,
  ), true);
  assert.equal(frameUrlMatches(
    "http://127.0.0.1:47823/other?host=codex&__codex_taskboard_refresh=abc",
    expected,
  ), false);
  assert.equal(frameUrlMatches(
    "http://example.com/?host=codex&__codex_taskboard_refresh=abc",
    expected,
  ), false);
  assert.equal(frameUrlMatches("chrome-error://chromewebdata/", expected), false);
});

test("heartbeat recovery ignores transient delays and reconnects only at the threshold", () => {
  assert.deepEqual(classifyHeartbeatFailure({
    previousFailures: 0,
    connectionClosed: false,
    threshold: 3,
  }), { failures: 1, shouldReconnect: false });
  assert.deepEqual(classifyHeartbeatFailure({
    previousFailures: 1,
    connectionClosed: false,
    threshold: 3,
  }), { failures: 2, shouldReconnect: false });
  assert.deepEqual(classifyHeartbeatFailure({
    previousFailures: 2,
    connectionClosed: false,
    threshold: 3,
  }), { failures: 3, shouldReconnect: true });
  assert.deepEqual(classifyHeartbeatFailure({
    previousFailures: 0,
    connectionClosed: true,
    threshold: 3,
  }), { failures: 1, shouldReconnect: true });
});

test("renderer bootstrap reload is limited to a fresh renderer or failed Taskboard frame", () => {
  assert.equal(rendererBootstrapReason({
    injectionVersion: null,
    frameTree: null,
    expectedFrameUrl: "http://127.0.0.1:47823/?host=codex",
  }), "missing-injection");
  assert.equal(rendererBootstrapReason({
    injectionVersion: "0.6.8",
    expectedFrameUrl: "http://127.0.0.1:47823/?host=codex",
    frameTree: {
      frame: { url: "app://-/index.html" },
      childFrames: [{
        frame: {
          url: "chrome-error://chromewebdata/",
          unreachableUrl: "http://127.0.0.1:47823/?host=codex&retry=1",
        },
      }],
    },
  }), "taskboard-frame-unreachable");
  assert.equal(rendererBootstrapReason({
    injectionVersion: "0.6.8",
    expectedFrameUrl: "http://127.0.0.1:47823/?host=codex",
    frameTree: {
      frame: { url: "app://-/index.html" },
      childFrames: [{ frame: { url: "http://127.0.0.1:47823/?host=codex" } }],
    },
  }), null);
});

const currentAutomationRequest = {
  id: "host-request-1",
  action: "automation",
  requestId: "automation-request-1",
  operation: "ensure-active",
  taskboardProjectId: "local",
  codexProjectId: "codex-project",
  projectName: "Local",
  workspacePath: "/tmp/project",
  skillPath: "/tmp/manage-taskboard/SKILL.md",
  intervalMinutes: 10,
  model: "gpt-5.6-sol",
  reasoningEffort: "ultra",
};

test("a stale automation parser receives an immediate host error instead of timing out", async () => {
  const responses = [];
  const staleParser = () => null;

  const result = await Promise.race([
    handleHostBindingPayload(
      {
        payload: JSON.stringify(currentAutomationRequest),
        executionContextId: 12,
      },
      {
        parseAutomationRequest: staleParser,
        ensure: async () => assert.fail("ensure must not run"),
        runAutomation: async () => assert.fail("automation must not run"),
        prefill: async () => assert.fail("prefill must not run"),
        sendResponse: async (_executionContextId, response) => responses.push(response),
      },
    ),
    new Promise((_, reject) => setTimeout(() => reject(new Error("host response timed out")), 50)),
  ]);

  assert.deepEqual(result, { responded: true, accepted: false });
  assert.deepEqual(responses, [{
    id: currentAutomationRequest.id,
    ok: false,
    error: "自动认领配置暂时无法应用，请刷新后重试",
    diagnosticCode: "AUTOMATION_SCHEMA_MISMATCH",
  }]);
});

test("the host bridge resolves a taskboard request marker to a Codex thread", async () => {
  const responses = [];
  const result = await handleHostBindingPayload(
    {
      payload: JSON.stringify({
        id: "resolve-request-1",
        action: "resolve-task-thread",
        marker: "[taskboard-request:req-12345678]",
        startedAt: 1_785_991_070_000,
      }),
      executionContextId: 19,
    },
    {
      parseAutomationRequest: () => null,
      ensure: async () => assert.fail("ensure must not run"),
      runAutomation: async () => assert.fail("automation must not run"),
      prefill: async () => assert.fail("prefill must not run"),
      resolveTaskThread: async () => ({
        status: "resolved",
        threadId: "019fd55d-010a-76d1-90ec-dcde7169b1c3",
      }),
      sendResponse: async (_executionContextId, response) => responses.push(response),
    },
  );

  assert.deepEqual(result, { responded: true, accepted: true });
  assert.deepEqual(responses, [{
    id: "resolve-request-1",
    ok: true,
    status: "resolved",
    threadId: "019fd55d-010a-76d1-90ec-dcde7169b1c3",
  }]);
});

test("the host bridge accepts an explicit submit request for a prepared task composer", async () => {
  const responses = [];
  const received = [];
  const request = {
    id: "submit-request-1",
    action: "prefill-task-composer",
    instruction: "Address ISSUE-1",
    skillName: "manage-taskboard",
    skillDisplayName: "Manage Taskboard",
    skillPath: "/tmp/manage-taskboard/SKILL.md",
    submit: true,
  };
  const result = await handleHostBindingPayload(
    { payload: JSON.stringify(request), executionContextId: 23 },
    {
      parseAutomationRequest: () => null,
      ensure: async () => assert.fail("ensure must not run"),
      runAutomation: async () => assert.fail("automation must not run"),
      resolveTaskThread: async () => assert.fail("resolution must not run"),
      prefill: async (payload) => {
        received.push(payload);
        return { prefilled: true, submitted: true };
      },
      sendResponse: async (_executionContextId, response) => responses.push(response),
    },
  );

  assert.deepEqual(result, { responded: true, accepted: true });
  assert.deepEqual(received, [request]);
  assert.deepEqual(responses, [{
    id: request.id,
    ok: true,
    prefilled: true,
    submitted: true,
  }]);
});

test("attach replaces an old runtime with the current source and restores an open page", async () => {
  const calls = [];
  const result = await reconcileInjectionRuntime({
    currentStatus: {
      version: "0.6.7",
      sourceHash: null,
      pageVisible: true,
      scriptIdentifier: "old-registration",
    },
    source: "current-source",
    sourceHash: "current-hash",
    removeRegisteredSource: async (identifier) => calls.push(["remove", identifier]),
    registerCurrentSource: async (source) => {
      calls.push(["register", source]);
      return "current-registration";
    },
    evaluateCurrentSource: async (source) => calls.push(["evaluate", source]),
    publishRegistration: async (identifier) => calls.push(["publish", identifier]),
    reopen: async () => calls.push(["open"]),
  });

  assert.deepEqual(result, {
    replaced: true,
    scriptIdentifier: "current-registration",
    shouldRemainOpen: true,
  });
  assert.deepEqual(calls, [
    ["remove", "old-registration"],
    ["register", "current-source"],
    ["evaluate", "current-source"],
    ["publish", "current-registration"],
    ["open"],
  ]);
});

test("attach is idempotent for the same source hash and does not open a closed page", async () => {
  const calls = [];
  const result = await reconcileInjectionRuntime({
    currentStatus: {
      version: "0.6.8",
      sourceHash: "current-hash",
      pageVisible: false,
      scriptIdentifier: "old-registration",
    },
    source: "current-source",
    sourceHash: "current-hash",
    removeRegisteredSource: async (identifier) => calls.push(["remove", identifier]),
    registerCurrentSource: async (source) => {
      calls.push(["register", source]);
      return "current-registration";
    },
    evaluateCurrentSource: async (source) => calls.push(["evaluate", source]),
    publishRegistration: async (identifier) => calls.push(["publish", identifier]),
    reopen: async () => calls.push(["open"]),
  });

  assert.deepEqual(result, {
    replaced: false,
    scriptIdentifier: "current-registration",
    shouldRemainOpen: false,
  });
  assert.deepEqual(calls, [
    ["remove", "old-registration"],
    ["register", "current-source"],
    ["evaluate", "current-source"],
    ["publish", "current-registration"],
  ]);
});

test("resident discovery accepts this repository's absolute and relative launch forms only", () => {
  const projectRoot = "/workspace/codex-taskboard";
  const injectorPath = `${projectRoot}/scripts/codex-injector.mjs`;
  const processList = [
    `101 node ${injectorPath} --watch --port 9231`,
    "102 node scripts/codex-injector.mjs --watch",
    "103 node ./scripts/codex-injector.mjs --watch --port=9231",
    "104 node scripts/codex-injector.mjs --watch",
    `105 node ${injectorPath} --watch --port 9229`,
    `106 node ${injectorPath} --port 9231`,
  ].join("\n");
  const cwdByPid = new Map([
    [102, projectRoot],
    [103, projectRoot],
    [104, "/workspace/another-repository"],
  ]);

  assert.deepEqual(findResidentInjectorPids({
    processList,
    currentPid: 999,
    injectorPath,
    projectRoot,
    port: 9231,
    defaultPort: 9229,
    cwdForPid: (pid) => cwdByPid.get(pid) ?? null,
  }), [101, 103]);
  assert.deepEqual(findResidentInjectorPids({
    processList,
    currentPid: 999,
    injectorPath,
    projectRoot,
    port: 9229,
    defaultPort: 9229,
    cwdForPid: (pid) => cwdByPid.get(pid) ?? null,
  }), [102, 105]);
});

test("refresh stops every stale resident before starting one token-verified replacement", async () => {
  const calls = [];
  const startupToken = "replacement-token";
  const replacement = await restartResidentInjector(9231, {
    findResidents: () => [4321, 5432],
    stopResident: async (pid) => calls.push(["stop", pid]),
    createStartupToken: () => startupToken,
    startResident: (port, token) => {
      calls.push(["start", port, token]);
      return { pid: 9876, started: true };
    },
    waitUntilReady: async (port, pid, token) => calls.push(["ready", port, pid, token]),
  });

  assert.deepEqual(replacement, {
    previousPids: [4321, 5432],
    pid: 9876,
    restarted: true,
  });
  assert.deepEqual(calls, [
    ["stop", 4321],
    ["stop", 5432],
    ["start", 9231, startupToken],
    ["ready", 9231, 9876, startupToken],
  ]);
});
