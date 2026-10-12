import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createClaudeLauncher } from "../server/claude-launcher.mjs";
import { createOmpLauncher } from "../server/omp-launcher.mjs";
import { checkTaskCompletion, evaluateTaskCompletion } from "../shared/task-completion-guard.mjs";
import taskCompletionOmpHook from "../scripts/task-completion-omp-hook.mjs";
import { handleHostBindingPayload } from "../scripts/codex-injector-runtime.mjs";

const threadId = "044170c0-5d5a-458f-9888-7cd35dce0186";

function runNodeScript(scriptPath, args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath, ...args], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`hook exited ${code}: ${stderr}`));
    });
    child.stdin.end(input);
  });
}

function task(status, overrides = {}) {
  return {
    id: "task-1",
    identifier: "ABC-1",
    status,
    threadId,
    threadIds: [threadId],
    ...overrides,
  };
}

async function taskServer(status) {
  const server = http.createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ task: task(status) }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

test("shared guard corrects incomplete linked tasks and allows closed tasks", () => {
  assert.equal(evaluateTaskCompletion({ task: task("in_progress"), taskId: "task-1", threadId }).action, "correct");
  for (const status of ["in_review", "blocked", "done", "canceled", "archived"]) {
    assert.equal(evaluateTaskCompletion({ task: task(status), taskId: "task-1", threadId }).action, "allow");
  }
  assert.equal(evaluateTaskCompletion({ task: task("in_progress"), taskId: "other", threadId }).action, "inactive");
  assert.equal(evaluateTaskCompletion({ task: task("in_progress"), taskId: "task-1", threadId: crypto.randomUUID() }).action, "inactive");
});

test("shared guard fails open with a visible diagnostic when taskboard is unavailable", async () => {
  const result = await checkTaskCompletion({ taskId: "task-1", threadId, taskboardUrl: "http://127.0.0.1:1" }, { timeoutMs: 100 });
  assert.equal(result.action, "error");
  assert.match(result.reason, /无法读取任务面板状态/);
});

test("shared guard ignores a configured Taskboard page query when building its API URL", async () => {
  let requestedUrl = "";
  const result = await checkTaskCompletion({
    taskId: "task-1",
    threadId,
    taskboardUrl: "http://127.0.0.1:47823/?host=codex",
  }, {
    fetchImpl: async (url) => {
      requestedUrl = String(url);
      return { ok: true, json: async () => ({ task: task("in_review") }) };
    },
  });
  assert.equal(requestedUrl, "http://127.0.0.1:47823/api/tasks/task-1");
  assert.equal(result.action, "allow");
});

test("Claude launcher writes a session-only Stop hook and leaves ordinary sessions untouched", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-claude-guard-"));
  try {
    const launcher = createClaudeLauncher({
      dataDirectory: directory,
      claudeExecutable: "/bin/echo",
      completionHookPath: "/tmp/task-completion-stop-hook.mjs",
    });
    const managed = launcher.writeSessionFiles(threadId, {
      workspacePath: "/tmp",
      prompt: "managed",
      claudeArgs: [],
      taskId: "task-1",
    });
    const script = await readFile(managed.scriptPath, "utf8");
    const settings = JSON.parse(await readFile(managed.settingsPath, "utf8"));
    assert.match(script, /--settings/);
    assert.match(settings.hooks.Stop[0].hooks[0].command, /task-completion-stop-hook\.mjs/);

    const ordinaryId = crypto.randomUUID();
    const ordinary = launcher.writeSessionFiles(ordinaryId, {
      workspacePath: "/tmp",
      prompt: "ordinary",
      claudeArgs: [],
    });
    assert.doesNotMatch(await readFile(ordinary.scriptPath, "utf8"), /--settings/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Claude Stop hook blocks once and then allows to prevent a loop", async () => {
  const server = await taskServer("in_progress");
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-claude-stop-"));
  const metadataPath = path.join(directory, "metadata.json");
  await writeFile(metadataPath, JSON.stringify({ taskId: "task-1", threadId, taskboardUrl: server.url }));
  try {
    const hookPath = path.resolve("scripts/task-completion-stop-hook.mjs");
    const first = await runNodeScript(hookPath, [metadataPath], JSON.stringify({ stop_hook_active: false }));
    assert.equal(JSON.parse(first.stdout).decision, "block");
    const second = await runNodeScript(hookPath, [metadataPath], JSON.stringify({ stop_hook_active: true }));
    assert.match(JSON.parse(second.stdout).systemMessage, /避免循环/);
  } finally {
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("OMP hook queues one corrective turn and reports the second incomplete ending", async () => {
  const server = await taskServer("in_progress");
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-omp-hook-"));
  const metadataPath = path.join(directory, "metadata.json");
  await writeFile(metadataPath, JSON.stringify({ taskId: "task-1", threadId, taskboardUrl: server.url }));
  const previousMetadata = process.env.TASKBOARD_GUARD_METADATA;
  process.env.TASKBOARD_GUARD_METADATA = metadataPath;
  try {
    let callback;
    const messages = [];
    const notifications = [];
    taskCompletionOmpHook({
      on(event, handler) { assert.equal(event, "agent_end"); callback = handler; },
      sendMessage(message, options) { messages.push({ message, options }); },
    });
    const context = { ui: { notify(message, level) { notifications.push({ message, level }); } } };
    await callback({}, context);
    await callback({}, context);
    assert.equal(messages.length, 1);
    assert.deepEqual(messages[0].options, { deliverAs: "nextTurn", triggerTurn: true });
    assert.match(notifications[0].message, /避免循环/);
  } finally {
    if (previousMetadata === undefined) delete process.env.TASKBOARD_GUARD_METADATA;
    else process.env.TASKBOARD_GUARD_METADATA = previousMetadata;
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("OMP launcher injects its hook only for taskboard-managed sessions", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-omp-guard-"));
  try {
    const launcher = createOmpLauncher({
      dataDirectory: directory,
      ompExecutable: "/bin/echo",
      completionHookPath: "/tmp/task-completion-omp-hook.mjs",
    });
    const managed = launcher.writeSessionFiles(threadId, {
      workspacePath: "/tmp",
      prompt: "managed",
      taskId: "task-1",
    });
    assert.match(await readFile(managed.scriptPath, "utf8"), /--hook.*task-completion-omp-hook/);
    const ordinaryId = crypto.randomUUID();
    const ordinary = launcher.writeSessionFiles(ordinaryId, { workspacePath: "/tmp", prompt: "ordinary" });
    assert.doesNotMatch(await readFile(ordinary.scriptPath, "utf8"), /--hook/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Codex host binding accepts a completion check without exposing write operations", async () => {
  const responses = [];
  await handleHostBindingPayload({
    payload: JSON.stringify({ id: "request-1", action: "task-completion-check", taskId: "task-1", threadId }),
    executionContextId: 7,
  }, {
    parseAutomationRequest: () => null,
    checkTaskCompletion: async (request) => ({ action: "allow", taskId: request.taskId }),
    sendResponse: async (_contextId, response) => responses.push(response),
  });
  assert.deepEqual(responses, [{ id: "request-1", ok: true, action: "allow", taskId: "task-1" }]);
});

test("resume paths reload session-only hooks and Codex guards only Taskboard-created threads", async () => {
  const claudeSource = await readFile(new URL("../server/claude-launcher.mjs", import.meta.url), "utf8");
  const ompSource = await readFile(new URL("../server/omp-launcher.mjs", import.meta.url), "utf8");
  const codexSource = await readFile(new URL("../inject/codex-taskboard.user.js", import.meta.url), "utf8");
  assert.match(claudeSource, /--resume[^\n]*\$\{settingsArg\}/);
  assert.match(ompSource, /--continue[^\n]*\$\{promptArg\}/);
  assert.match(ompSource, /const hookFlag = guard\.enabled[\s\S]*?--continue/);
  assert.match(codexSource, /if \(request\.action === "create"\) \{[\s\S]*?rememberManagedTaskThread/);
  assert.match(codexSource, /const managedRecord = managedTaskThreads\[threadId\]/);
  assert.doesNotMatch(codexSource, /rememberManagedTaskThread\([^)]*action === "follow-up"/);
});

test("all three runtimes resume an in-review issue only after a follow-up is accepted", async () => {
  const appSource = await readFile(new URL("../web/src/App.tsx", import.meta.url), "utf8");
  const helper = appSource.slice(
    appSource.indexOf("async function resumeReviewedTaskAfterFollowUp"),
    appSource.indexOf("function changeProject"),
  );
  assert.match(helper, /task\.status !== "in_review"/);
  assert.match(helper, /moveTaskRequest\(current, "in_progress", undefined, threadId\)/);
  assert.match(helper, /VERSION_CONFLICT/);

  const followUp = appSource.slice(
    appSource.indexOf("function followUpTaskInThread"),
    appSource.indexOf("async function resumeReviewedTaskAfterFollowUp"),
  );
  assert.match(followUp, /resumeClaudeSession\([\s\S]*?\.then\(async \(\) => \{[\s\S]*?resumeReviewedTaskAfterFollowUp/);
  assert.match(followUp, /resumeOmpSession\([\s\S]*?\.then\(async \(\) => \{[\s\S]*?resumeReviewedTaskAfterFollowUp/);
  const claudeBranch = followUp.slice(followUp.indexOf('runtime === "claude"'), followUp.indexOf('runtime === "omp"'));
  const ompBranch = followUp.slice(followUp.indexOf('runtime === "omp"'), followUp.indexOf("const skill = taskSkill"));
  assert.ok(claudeBranch.indexOf("resumeClaudeSession") < claudeBranch.indexOf("resumeReviewedTaskAfterFollowUp"));
  assert.ok(ompBranch.indexOf("resumeOmpSession") < ompBranch.indexOf("resumeReviewedTaskAfterFollowUp"));
});
