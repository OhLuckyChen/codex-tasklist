import assert from "node:assert/strict";
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, test } from "node:test";

import { createTaskboardServer } from "../server/index.mjs";
import { KnowledgeService } from "../server/knowledge-service.mjs";

const runningApps = [];
const fakeWebSockets = [];

class FakeWecomSocket extends EventTarget {
  static OPEN = 1;

  readyState = FakeWecomSocket.OPEN;
  sent = [];

  constructor(url) {
    super();
    this.url = url;
    fakeWebSockets.push(this);
    queueMicrotask(() => this.dispatchEvent(new Event("open")));
  }

  send(payload) {
    this.sent.push(JSON.parse(payload));
  }

  close() {
    this.readyState = 3;
  }
}

afterEach(async () => {
  while (runningApps.length > 0) {
    const { app, directory } = runningApps.pop();
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
  fakeWebSockets.length = 0;
});

async function startServer(configure, listenOptions = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codex-taskboard-test-"));
  const options = configure ? await configure(directory) : {};
  const app = createTaskboardServer({ dataDirectory: directory, ...options });
  const address = await app.listen({ port: 0, ...listenOptions });
  runningApps.push({ app, directory });
  return `http://127.0.0.1:${address.port}`;
}

async function request(baseUrl, pathname, options = {}) {
  const headers = new Headers(options.headers);
  if (options.body !== undefined && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  const response = await fetch(`${baseUrl}${pathname}`, {
    ...options,
    headers,
    body: options.body === undefined || typeof options.body === "string"
      ? options.body
      : JSON.stringify(options.body),
  });
  const text = await response.text();
  return {
    response,
    body: text ? JSON.parse(text) : undefined,
  };
}

async function requestWithHost(baseUrl, host) {
  const target = new URL("/health", baseUrl);
  return new Promise((resolve, reject) => {
    const outgoing = httpRequest(target, { headers: { host } }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({
        status: response.statusCode,
        body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
      }));
    });
    outgoing.on("error", reject);
    outgoing.end();
  });
}

test("health and the default local project are available", async () => {
  let skillPath;
  const baseUrl = await startServer(async (directory) => {
    skillPath = path.join(directory, "skills", "manage-taskboard", "SKILL.md");
    return { skillPath };
  });

  const health = await request(baseUrl, "/health");
  assert.equal(health.response.status, 200);
  assert.deepEqual(health.body, { status: "ok" });

  const metadata = await request(baseUrl, "/api/meta");
  assert.equal(metadata.response.status, 200);
  assert.deepEqual(metadata.body, {
    manageTaskboardSkillPath: skillPath,
    projectKnowledgeSkillPath: path.resolve("skills/project-knowledge-builder/SKILL.md"),
    claudeRuntime: true,
    ompRuntime: true,
    connectors: [],
    capabilities: { localKnowledge: true },
  });

  const result = await request(baseUrl, "/api/projects");
  assert.equal(result.response.status, 200);
  assert.equal(result.body.projects.length, 1);
  assert.equal(result.body.projects[0].id, "local");
  assert.equal(result.body.projects[0].name, "Local");
  assert.equal(result.body.projects[0].workspacePath, null);
  assert.equal(result.body.projects[0].issueCount, 0);
});

test("renaming a project preserves its ID, workspace mapping, and issues", async () => {
  const baseUrl = await startServer();
  const created = await request(baseUrl, "/api/projects", {
    method: "POST",
    body: { id: "runtime", name: "runtime", workspacePath: "/workspace/runtime" },
  });
  const task = await request(baseUrl, "/api/tasks", {
    method: "POST",
    body: { projectId: "runtime", title: "Existing issue" },
  });
  const renamed = await request(baseUrl, "/api/projects/runtime", {
    method: "PATCH",
    body: { name: "星枢" },
  });
  assert.equal(renamed.response.status, 200);
  assert.equal(renamed.body.project.id, created.body.project.id);
  assert.equal(renamed.body.project.name, "星枢");
  assert.equal(renamed.body.project.workspacePath, "/workspace/runtime");
  const retained = await request(baseUrl, `/api/tasks/${task.body.task.id}`);
  assert.equal(retained.body.task.projectId, "runtime");
});

test("project knowledge proposals preserve review state and publish only through the local workspace", async () => {
  let workspacePath;
  const knowledgeService = new KnowledgeService({
    analyze: async () => ({
      title: "Knowledge proposal",
      summary: "A reviewed project fact",
      changes: [{
        targetPath: "docs/knowledge/index.md",
        operation: "create",
        afterContent: "---\nid: index\ntitle: Project knowledge\nkind: index\n---\n# Project knowledge\n",
      }],
    }),
  });
  const baseUrl = await startServer(async (directory) => {
    workspacePath = path.join(directory, "workspace");
    await mkdir(workspacePath, { recursive: true });
    return { knowledgeService };
  });
  const project = await request(baseUrl, "/api/projects", {
    method: "POST",
    body: { id: "knowledge", name: "Knowledge", workspacePath },
  });
  assert.equal(project.response.status, 201);
  const task = await request(baseUrl, "/api/tasks", {
    method: "POST",
    body: {
      projectId: "knowledge",
      title: "Capture architecture",
      description: "",
      status: "in_review",
      priority: "none",
      labels: [],
    },
  });
  const comment = await request(baseUrl, `/api/tasks/${task.body.task.id}/comments`, {
    method: "POST",
    body: { body: "The verified implementation detail" },
  });
  const versions = await request(baseUrl, "/api/projects/knowledge/knowledge-source-versions");
  assert.equal(versions.body.versions[`issue:${task.body.task.identifier}`], 1);
  assert.equal(versions.body.versions[`comment:${comment.body.comment.id}`], 1);

  const generated = await request(baseUrl, "/api/local/projects/knowledge/knowledge/generate", {
    method: "POST",
    body: {
      workspacePath,
      sourceType: "issue",
      sourceSnapshot: { issue: { id: task.body.task.id, version: 1 } },
    },
  });
  assert.equal(generated.response.status, 200);
  assert.equal(await access(path.join(workspacePath, "docs", "knowledge", "index.md")).then(() => true, () => false), false);

  const stored = await request(baseUrl, "/api/projects/knowledge/knowledge-proposals", {
    method: "POST",
    body: generated.body.proposal,
  });
  assert.equal(stored.response.status, 201);
  assert.equal(stored.body.proposal.status, "ready");
  const listed = await request(baseUrl, "/api/projects/knowledge/knowledge-proposals?status=ready");
  assert.equal(listed.body.proposals.length, 1);

  const receipt = await request(baseUrl, "/api/local/projects/knowledge/knowledge/publish", {
    method: "POST",
    body: {
      workspacePath,
      proposal: {
        id: stored.body.proposal.id,
        version: stored.body.proposal.version,
        changes: stored.body.proposal.changes,
      },
    },
  });
  assert.equal(receipt.response.status, 200);
  assert.match(await readFile(path.join(workspacePath, "docs", "knowledge", "index.md"), "utf8"), /Project knowledge/);

  const published = await request(baseUrl, `/api/knowledge-proposals/${stored.body.proposal.id}`, {
    method: "PATCH",
    body: { version: stored.body.proposal.version, status: "published" },
  });
  assert.equal(published.response.status, 200);
  assert.equal(published.body.proposal.status, "published");
});

test("knowledge questionnaires require gap evidence and only accepted answers create reviewable proposals", async () => {
  let workspacePath;
  const baseUrl = await startServer(async (directory) => { workspacePath = path.join(directory, "workspace"); await mkdir(workspacePath, { recursive: true }); return {}; });
  await request(baseUrl, "/api/projects", { method: "POST", body: { id: "survey", name: "Survey", workspacePath } });
  const invalid = await request(baseUrl, "/api/projects/survey/knowledge-questionnaires", { method: "POST", body: { scopeType: "project", title: "Bad", questions: [{ context: "c", prompt: "p", gapReason: "", checkedSources: [], targetRole: "r", answerFormat: "f", knowledgeTarget: "docs/knowledge/index.md" }] } });
  assert.equal(invalid.response.status, 400);
  const created = await request(baseUrl, "/api/projects/survey/knowledge-questionnaires", { method: "POST", body: { scopeType: "project", title: "Business gap", questions: [{ context: "订单取消", prompt: "实际取消规则是什么？", gapReason: "现有源码只有状态枚举，未说明业务口径。", checkedSources: ["docs/knowledge/architecture.md", "server/orders.ts"], targetRole: "订单负责人", answerFormat: "规则和例外", knowledgeTarget: "docs/knowledge/index.md" }] } });
  assert.equal(created.response.status, 201);
  const questionnaire = created.body.questionnaire;
  const questionId = questionnaire.questions[0].id;
  const beforeOpen = await request(baseUrl, `/api/knowledge-questions/${questionId}/answers`, { method: "POST", body: { content: "人工规则", confidence: "high" } });
  assert.equal(beforeOpen.response.status, 409);
  const opened = await request(baseUrl, `/api/projects/survey/knowledge-questionnaires/${questionnaire.id}`, { method: "PATCH", body: { status: "open" } });
  assert.equal(opened.response.status, 200);
  const answer = await request(baseUrl, `/api/knowledge-questions/${questionId}/answers`, { method: "POST", body: { content: "已付款订单只有财务确认后才能取消。", confidence: "high" } });
  assert.equal(answer.response.status, 201);
  const review = await request(baseUrl, `/api/knowledge-answers/${answer.body.answerId}/review`, { method: "POST", body: { status: "accepted", reviewNote: "已确认" } });
  assert.equal(review.response.status, 200);
  assert.equal(review.body.proposal.status, "ready");
  assert.match(review.body.proposal.changes[0].afterContent, /财务确认/);
  assert.equal(review.body.proposal.changes[0].operation, "create");
  const receipt = await request(baseUrl, "/api/local/projects/survey/knowledge/publish", { method: "POST", body: { workspacePath, proposal: { id: review.body.proposal.id, version: review.body.proposal.version, changes: review.body.proposal.changes } } });
  assert.equal(receipt.response.status, 200);
  assert.match(await readFile(path.join(workspacePath, review.body.proposal.changes[0].targetPath), "utf8"), /人工确认回答/);
  const duplicateReview = await request(baseUrl, `/api/knowledge-answers/${answer.body.answerId}/review`, { method: "POST", body: { status: "accepted" } });
  assert.equal(duplicateReview.response.status, 409);
  const proposals = await request(baseUrl, "/api/projects/survey/knowledge-proposals?status=ready");
  assert.equal(proposals.body.proposals.length, 1);
  const closed = await request(baseUrl, `/api/projects/survey/knowledge-questionnaires/${questionnaire.id}`, { method: "PATCH", body: { status: "closed" } });
  assert.equal(closed.response.status, 200);
});

test("a persistent project knowledge run stores its callback as a ready proposal", async () => {
  let workspacePath;
  const baseUrl = await startServer(async (directory) => {
    workspacePath = path.join(directory, "workspace");
    await mkdir(workspacePath, { recursive: true });
    return {};
  });
  await request(baseUrl, "/api/projects", {
    method: "POST",
    body: { id: "knowledge-run", name: "Knowledge Run", workspacePath },
  });

  const created = await request(baseUrl, "/api/local/projects/knowledge-run/knowledge-runs", {
    method: "POST",
    body: {
      workspacePath,
      sourceType: "project_scan",
      sourceSnapshot: { trigger: "knowledge-initialization-issue" },
      developmentContext: null,
      persist: true,
    },
  });
  assert.equal(created.response.status, 201);
  assert.match(created.body.run.instruction, /Do not publish or write knowledge files yourself/);

  const completed = await request(
    baseUrl,
    `/api/local/knowledge-runs/${created.body.run.id}/complete`,
    {
      method: "POST",
      headers: { "x-taskboard-knowledge-run-token": created.body.run.token },
      body: {
        analysis: {
          title: "Initial project knowledge",
          summary: "Durable project orientation",
          changes: [{
            targetPath: "docs/knowledge/index.md",
            operation: "create",
            afterContent: "---\nid: index\ntitle: Project knowledge\nkind: index\nupdated_at: 2026-08-10T00:00:00.000Z\nsources:\n  - type: file\n    ref: package.json\n---\n# Project knowledge\n",
          }],
        },
      },
    },
  );
  assert.equal(completed.response.status, 200);
  assert.deepEqual(completed.body, { ok: true });

  const proposals = await request(
    baseUrl,
    "/api/projects/knowledge-run/knowledge-proposals?status=ready",
  );
  assert.equal(proposals.body.proposals.length, 1);
  assert.equal(proposals.body.proposals[0].id, created.body.run.id);
  assert.equal(proposals.body.proposals[0].creator.id, "codex-agent");
  assert.equal(
    await access(path.join(workspacePath, "docs", "knowledge", "index.md")).then(() => true, () => false),
    false,
  );
});

test("project WeCom bots keep secrets encrypted and route isolated sessions to project knowledge", async () => {
  let workspacePath;
  const asked = [];
  const knowledgeService = {
    ask: async (workspace, question) => {
      asked.push({ workspace, question });
      return {
        answer: `answer ${asked.length}`,
        citations: [{ type: "file", ref: "server/app.mjs", label: "server app" }],
      };
    },
  };
  const baseUrl = await startServer(async (directory) => {
    workspacePath = path.join(directory, "workspace");
    await mkdir(workspacePath, { recursive: true });
    return { knowledgeService, botSecretKey: "test-secret-key" };
  });
  await request(baseUrl, "/api/projects", {
    method: "POST",
    body: { id: "wecom", name: "WeCom", workspacePath },
  });

  const created = await request(baseUrl, "/api/projects/wecom/bots", {
    method: "POST",
    body: {
      botId: "bot-alpha",
      secret: "plain-secret-value",
      enabled: true,
      runtime: "codex",
      workspacePath,
      knowledgeEnabled: true,
      codeSearchEnabled: true,
    },
  });
  assert.equal(created.response.status, 201);
  assert.equal(created.body.bot.hasSecret, true);
  assert.equal("secret" in created.body.bot, false);
  assert.equal(JSON.stringify(created.body).includes("plain-secret-value"), false);

  const listed = await request(baseUrl, "/api/projects/wecom/bots");
  assert.equal(listed.response.status, 200);
  assert.equal(listed.body.bots.length, 1);
  assert.equal(JSON.stringify(listed.body).includes("plain-secret-value"), false);

  const first = await request(baseUrl, "/api/wecom/bots/bot-alpha/messages", {
    method: "POST",
    body: {
      conversationId: "single-user-a",
      messageType: "text",
      text: "调用链在哪里？",
    },
  });
  assert.equal(first.response.status, 200);
  assert.equal(first.body.answer.answer, "answer 1");
  assert.equal(first.body.session.wecomConversationId, "single-user-a");

  const second = await request(baseUrl, "/api/wecom/bots/bot-alpha/messages", {
    method: "POST",
    body: {
      conversationId: "room-b",
      messageType: "text",
      text: "排障怎么查？",
    },
  });
  assert.equal(second.response.status, 200);
  assert.notEqual(second.body.session.id, first.body.session.id);
  assert.equal(asked.length, 2);
  assert.equal(asked[0].workspace, workspacePath);
  assert.match(asked[0].question, /只读回答/);

  const audit = await request(baseUrl, `/api/project-bots/${created.body.bot.id}/audit`);
  assert.equal(audit.response.status, 200);
  assert.equal(audit.body.events.length, 4);
  const answered = audit.body.events.find((event) => event.direction === "outbound" && event.status === "answered");
  assert.deepEqual(answered.citations, [{ type: "file", ref: "server/app.mjs", label: "server app" }]);
});

test("enabled WeCom bots restore websocket subscriptions after server start", async () => {
  let workspacePath;
  const directory = await mkdtemp(path.join(os.tmpdir(), "codex-taskboard-test-"));
  try {
    workspacePath = path.join(directory, "workspace");
    await mkdir(workspacePath, { recursive: true });
    const app = createTaskboardServer({
      dataDirectory: directory,
      botSecretKey: "test-secret-key",
      wecomWebSocketFactory: (url) => new FakeWecomSocket(url),
      wecomHeartbeatMs: 60_000,
    });
    const address = await app.listen({ port: 0 });
    const baseUrl = `http://127.0.0.1:${address.port}`;
    await request(baseUrl, "/api/projects", {
      method: "POST",
      body: { id: "wecom-restore", name: "WeCom Restore", workspacePath },
    });
    const created = await request(baseUrl, "/api/projects/wecom-restore/bots", {
      method: "POST",
      body: {
        botId: "bot-restore",
        secret: "restore-secret",
        enabled: true,
        runtime: "codex",
        workspacePath,
        knowledgeEnabled: true,
        codeSearchEnabled: true,
      },
    });
    await app.close();
    fakeWebSockets.length = 0;

    const restoredApp = createTaskboardServer({
      dataDirectory: directory,
      botSecretKey: "test-secret-key",
      wecomWebSocketFactory: (url) => new FakeWecomSocket(url),
      wecomHeartbeatMs: 60_000,
    });
    const restoredAddress = await restoredApp.listen({ port: 0 });
    const restoredBaseUrl = `http://127.0.0.1:${restoredAddress.port}`;
    try {
      await new Promise((resolve) => setTimeout(resolve, 20));

      assert.equal(fakeWebSockets.length, 1);
      assert.deepEqual(fakeWebSockets[0].sent[0], {
        cmd: "aibot_subscribe",
        headers: { req_id: fakeWebSockets[0].sent[0].headers.req_id },
        body: { bot_id: "bot-restore", secret: "restore-secret" },
      });
      const listed = await request(restoredBaseUrl, "/api/projects/wecom-restore/bots");
      assert.equal(listed.body.bots[0].id, created.body.bot.id);
      assert.equal(listed.body.bots[0].connectionStatus, "connecting");
    } finally {
      await restoredApp.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("WeCom bot answers with a timeout fallback when project knowledge is slow", async () => {
  let workspacePath;
  const knowledgeService = {
    ask: () => new Promise(() => {}),
  };
  const baseUrl = await startServer(async (directory) => {
    workspacePath = path.join(directory, "workspace");
    await mkdir(workspacePath, { recursive: true });
    return { knowledgeService, botSecretKey: "test-secret-key", wecomAnswerTimeoutMs: 5 };
  });
  await request(baseUrl, "/api/projects", {
    method: "POST",
    body: { id: "wecom-timeout", name: "WeCom Timeout", workspacePath },
  });
  const created = await request(baseUrl, "/api/projects/wecom-timeout/bots", {
    method: "POST",
    body: {
      botId: "bot-timeout",
      secret: "plain-secret-value",
      enabled: true,
      runtime: "codex",
      workspacePath,
      knowledgeEnabled: true,
      codeSearchEnabled: true,
    },
  });

  const answered = await request(baseUrl, "/api/wecom/bots/bot-timeout/messages", {
    method: "POST",
    body: {
      conversationId: "single-user-timeout",
      messageType: "text",
      text: "你是谁",
    },
  });
  assert.equal(answered.response.status, 200);
  assert.match(answered.body.answer.answer, /已收到你的问题/);

  const audit = await request(baseUrl, `/api/project-bots/${created.body.bot.id}/audit`);
  assert.equal(audit.response.status, 200);
  assert.equal(audit.body.events.length, 2);
  const outbound = audit.body.events.find((event) => event.direction === "outbound");
  assert.equal(outbound.status, "failed");
  assert.equal(outbound.error, "Project knowledge answer timed out");
});

test("workflow workspaces persist centrally with optimistic concurrency", async () => {
  const baseUrl = await startServer();
  const initial = await request(baseUrl, "/api/projects/local/workflow-workspace");
  assert.deepEqual(initial.body.workflow, {
    projectId: "local",
    workspace: null,
    version: 0,
    updatedAt: null,
  });

  const workspace = {
    version: 1,
    tabs: [{ id: "issue-delivery", name: "议题处理与交付" }],
    activeWorkflowId: "issue-delivery",
    snapshots: {
      "issue-delivery": {
        nodes: [{ id: "issue-trigger", position: { x: 100, y: 80 }, data: { kind: "issue-trigger" } }],
        flow: {
          version: 2,
          root: { items: [{ type: "step", nodeId: "issue-trigger" }] },
        },
        selectedNodeId: "issue-trigger",
      },
    },
  };
  const created = await request(baseUrl, "/api/projects/local/workflow-workspace", {
    method: "PUT",
    body: { version: 0, workspace },
  });
  assert.equal(created.response.status, 200);
  assert.equal(created.body.workflow.version, 1);
  assert.deepEqual(created.body.workflow.workspace, workspace);

  const fromAnotherClient = await request(baseUrl, "/api/projects/local/workflow-workspace");
  assert.equal(fromAnotherClient.body.workflow.version, 1);
  assert.deepEqual(fromAnotherClient.body.workflow.workspace, workspace);

  const renamedWorkspace = {
    ...workspace,
    tabs: [{ id: "issue-delivery", name: "统一交付流程" }],
  };
  const updated = await request(baseUrl, "/api/projects/local/workflow-workspace", {
    method: "PUT",
    body: { version: 1, workspace: renamedWorkspace },
  });
  assert.equal(updated.response.status, 200);
  assert.equal(updated.body.workflow.version, 2);

  const stale = await request(baseUrl, "/api/projects/local/workflow-workspace", {
    method: "PUT",
    body: { version: 1, workspace },
  });
  assert.equal(stale.response.status, 409);
  assert.equal(stale.body.error.code, "VERSION_CONFLICT");
  assert.deepEqual(stale.body.error.details, {
    expectedVersion: 1,
    actualVersion: 2,
  });
});

test("Twitter post content survives the shared workflow workspace round trip", async () => {
  const baseUrl = await startServer();
  const workspace = {
    version: 1,
    tabs: [{ id: "twitter-publishing", name: "Twitter 发布" }],
    activeWorkflowId: "twitter-publishing",
    snapshots: {
      "twitter-publishing": {
        nodes: [
          {
            id: "issue-trigger",
            position: { x: 0, y: 0 },
            data: { kind: "issue-trigger" },
          },
          {
            id: "twitter-post",
            position: { x: 0, y: 220 },
            data: {
              kind: "twitter-post",
              twitterPostContent: "发布产品更新",
            },
          },
        ],
        flow: {
          version: 2,
          root: {
            items: [
              { type: "step", nodeId: "issue-trigger" },
              { type: "step", nodeId: "twitter-post" },
            ],
          },
        },
        selectedNodeId: "twitter-post",
      },
    },
  };

  const saved = await request(baseUrl, "/api/projects/local/workflow-workspace", {
    method: "PUT",
    body: { version: 0, workspace },
  });
  assert.equal(saved.response.status, 200);
  assert.equal(
    saved.body.workflow.workspace.snapshots["twitter-publishing"].nodes[1].data.twitterPostContent,
    "发布产品更新",
  );

  const restored = await request(baseUrl, "/api/projects/local/workflow-workspace");
  assert.equal(restored.response.status, 200);
  assert.equal(
    restored.body.workflow.workspace.snapshots["twitter-publishing"].nodes[1].data.twitterPostContent,
    "发布产品更新",
  );
});

test("workflow service accepts legacy edge snapshots and persists them as V2 control flow", async () => {
  const baseUrl = await startServer();
  const workspace = {
    version: 1,
    tabs: [{ id: "legacy", name: "Legacy" }],
    activeWorkflowId: "legacy",
    snapshots: {
      legacy: {
        nodes: [
          { id: "trigger", position: { x: 0, y: 0 }, data: { kind: "issue-trigger" } },
          { id: "condition", position: { x: 0, y: 100 }, data: { kind: "condition" } },
          { id: "yes", position: { x: -180, y: 280 }, data: { kind: "skill" } },
          { id: "no", position: { x: 180, y: 280 }, data: { kind: "mcp" } },
        ],
        edges: [
          { id: "root", source: "trigger", target: "condition" },
          {
            id: "yes-edge",
            source: "condition",
            target: "yes",
            data: { conditionId: "condition", conditionOutcome: "true" },
          },
          {
            id: "no-edge",
            source: "condition",
            target: "no",
            data: { conditionId: "condition", conditionOutcome: "false" },
          },
        ],
        selectedNodeId: null,
      },
    },
  };

  const saved = await request(baseUrl, "/api/projects/local/workflow-workspace", {
    method: "PUT",
    body: { version: 0, workspace },
  });

  assert.equal(saved.response.status, 200);
  const snapshot = saved.body.workflow.workspace.snapshots.legacy;
  assert.equal("edges" in snapshot, false);
  assert.deepEqual(snapshot.flow, {
    version: 2,
    root: {
      items: [
        { type: "step", nodeId: "trigger" },
        {
          type: "condition",
          nodeId: "condition",
          branches: {
            true: { items: [{ type: "step", nodeId: "yes" }] },
            false: { items: [{ type: "step", nodeId: "no" }] },
          },
        },
      ],
    },
  });
});

test("workflow service recursively migrates V1 linear conditions and persists V2 control flow", async () => {
  const baseUrl = await startServer();
  const result = await request(baseUrl, "/api/projects/local/workflow-workspace", {
    method: "PUT",
    body: {
      version: 0,
      workspace: {
        version: 1,
        tabs: [{ id: "legacy", name: "Legacy" }],
        activeWorkflowId: "legacy",
        snapshots: {
          legacy: {
            nodes: [
              { id: "trigger", position: { x: 0, y: 0 }, data: { kind: "issue-trigger" } },
              { id: "first", position: { x: 0, y: 100 }, data: { kind: "condition" } },
              { id: "action", position: { x: 0, y: 200 }, data: { kind: "skill" } },
              { id: "second", position: { x: 0, y: 300 }, data: { kind: "condition" } },
              { id: "tail", position: { x: 0, y: 400 }, data: { kind: "mcp" } },
            ],
            edges: [
              { id: "a", source: "trigger", target: "first" },
              { id: "b", source: "first", target: "action" },
              { id: "c", source: "action", target: "second" },
              { id: "d", source: "second", target: "tail" },
            ],
            selectedNodeId: null,
          },
        },
      },
    },
  });

  assert.equal(result.response.status, 200);
  const snapshot = result.body.workflow.workspace.snapshots.legacy;
  assert.equal("edges" in snapshot, false);
  assert.deepEqual(snapshot.flow.root.items, [
    { type: "step", nodeId: "trigger" },
    {
      type: "condition",
      nodeId: "first",
      branches: {
        true: {
          items: [
            { type: "step", nodeId: "action" },
            {
              type: "condition",
              nodeId: "second",
              branches: {
                true: { items: [{ type: "step", nodeId: "tail" }] },
                false: { items: [] },
              },
            },
          ],
        },
        false: { items: [] },
      },
    },
  ]);
});

test("workflow service rejects snapshots with unknown flow versions", async () => {
  const baseUrl = await startServer();
  const result = await request(baseUrl, "/api/projects/local/workflow-workspace", {
    method: "PUT",
    body: {
      version: 0,
      workspace: {
        version: 1,
        tabs: [{ id: "invalid", name: "Invalid" }],
        activeWorkflowId: "invalid",
        snapshots: {
          invalid: {
            nodes: [
              { id: "trigger", position: { x: 0, y: 0 }, data: { kind: "issue-trigger" } },
            ],
            flow: {
              version: 3,
              root: { items: [{ type: "step", nodeId: "trigger" }] },
            },
            selectedNodeId: null,
          },
        },
      },
    },
  });

  assert.equal(result.response.status, 400);
  assert.equal(result.body.error.code, "INVALID_FIELD");
  assert.match(result.body.error.message, /version 2/i);
});

test("workflow service rejects malformed V2 snapshots with repeated triggers", async () => {
  const baseUrl = await startServer();
  const result = await request(baseUrl, "/api/projects/local/workflow-workspace", {
    method: "PUT",
    body: {
      version: 0,
      workspace: {
        version: 1,
        tabs: [{ id: "invalid", name: "Invalid" }],
        activeWorkflowId: "invalid",
        snapshots: {
          invalid: {
            nodes: [
              { id: "first", position: { x: 0, y: 0 }, data: { kind: "issue-trigger" } },
              { id: "second", position: { x: 0, y: 100 }, data: { kind: "git-trigger" } },
            ],
            flow: {
              version: 2,
              root: {
                items: [
                  { type: "step", nodeId: "first" },
                  { type: "step", nodeId: "second" },
                ],
              },
            },
            selectedNodeId: null,
          },
        },
      },
    },
  });

  assert.equal(result.response.status, 400);
  assert.equal(result.body.error.code, "INVALID_FIELD");
  assert.match(result.body.error.message, /trigger/i);
});

test("workflow service rejects V2 item types that do not match node kinds", async () => {
  const baseUrl = await startServer();
  const result = await request(baseUrl, "/api/projects/local/workflow-workspace", {
    method: "PUT",
    body: {
      version: 0,
      workspace: {
        version: 1,
        tabs: [{ id: "invalid", name: "Invalid" }],
        activeWorkflowId: "invalid",
        snapshots: {
          invalid: {
            nodes: [
              { id: "trigger", position: { x: 0, y: 0 }, data: { kind: "issue-trigger" } },
              { id: "condition", position: { x: 0, y: 100 }, data: { kind: "condition" } },
            ],
            flow: {
              version: 2,
              root: {
                items: [
                  { type: "step", nodeId: "trigger" },
                  { type: "step", nodeId: "condition" },
                ],
              },
            },
            selectedNodeId: null,
          },
        },
      },
    },
  });

  assert.equal(result.response.status, 400);
  assert.equal(result.body.error.code, "INVALID_FIELD");
  assert.match(result.body.error.message, /condition/i);
});

test("workflow service rejects V2 snapshots with duplicate node records", async () => {
  const baseUrl = await startServer();
  const result = await request(baseUrl, "/api/projects/local/workflow-workspace", {
    method: "PUT",
    body: {
      version: 0,
      workspace: {
        version: 1,
        tabs: [{ id: "invalid", name: "Invalid" }],
        activeWorkflowId: "invalid",
        snapshots: {
          invalid: {
            nodes: [
              { id: "trigger", position: { x: 0, y: 0 }, data: { kind: "issue-trigger" } },
              { id: "trigger", position: { x: 0, y: 100 }, data: { kind: "issue-trigger" } },
            ],
            flow: {
              version: 2,
              root: {
                items: [{ type: "step", nodeId: "trigger" }],
              },
            },
            selectedNodeId: null,
          },
        },
      },
    },
  });

  assert.equal(result.response.status, 400);
  assert.equal(result.body.error.code, "INVALID_FIELD");
  assert.match(result.body.error.message, /node ids must be unique/i);
});

test("workflow service rejects V2 flow items that reference parented plan children", async () => {
  const baseUrl = await startServer();
  const result = await request(baseUrl, "/api/projects/local/workflow-workspace", {
    method: "PUT",
    body: {
      version: 0,
      workspace: {
        version: 1,
        tabs: [{ id: "invalid", name: "Invalid" }],
        activeWorkflowId: "invalid",
        snapshots: {
          invalid: {
            nodes: [
              { id: "trigger", position: { x: 0, y: 0 }, data: { kind: "issue-trigger" } },
              { id: "plan", position: { x: 0, y: 100 }, data: { kind: "planning" } },
              {
                id: "plan-child",
                parentId: "plan",
                position: { x: 0, y: 0 },
                data: { kind: "skill" },
              },
            ],
            flow: {
              version: 2,
              root: {
                items: [
                  { type: "step", nodeId: "trigger" },
                  { type: "step", nodeId: "plan" },
                  { type: "step", nodeId: "plan-child" },
                ],
              },
            },
            selectedNodeId: null,
          },
        },
      },
    },
  });

  assert.equal(result.response.status, 400);
  assert.equal(result.body.error.code, "INVALID_FIELD");
  assert.match(result.body.error.message, /root node/i);
});

test("workflow service rejects malformed parented workflow nodes", async () => {
  const cases = [
    {
      name: "missing parent",
      nodes: [
        { id: "trigger", position: { x: 0, y: 0 }, data: { kind: "issue-trigger" } },
        {
          id: "orphan",
          parentId: "missing-plan",
          position: { x: 0, y: 0 },
          data: { kind: "skill" },
        },
      ],
      items: [{ type: "step", nodeId: "trigger" }],
      message: /missing parent/i,
    },
    {
      name: "nested parent",
      nodes: [
        { id: "trigger", position: { x: 0, y: 0 }, data: { kind: "issue-trigger" } },
        {
          id: "root-plan",
          position: { x: 0, y: 100 },
          data: { kind: "basic-planning", acceptsChildren: true },
        },
        {
          id: "nested-plan",
          parentId: "root-plan",
          position: { x: 0, y: 0 },
          data: { kind: "basic-planning", acceptsChildren: true },
        },
        {
          id: "nested-child",
          parentId: "nested-plan",
          position: { x: 0, y: 0 },
          data: { kind: "skill" },
        },
      ],
      items: [
        { type: "step", nodeId: "trigger" },
        { type: "step", nodeId: "root-plan" },
      ],
      message: /root parent/i,
    },
    {
      name: "parent cannot accept children",
      nodes: [
        { id: "trigger", position: { x: 0, y: 0 }, data: { kind: "issue-trigger" } },
        { id: "plain-step", position: { x: 0, y: 100 }, data: { kind: "skill" } },
        {
          id: "invalid-child",
          parentId: "plain-step",
          position: { x: 0, y: 0 },
          data: { kind: "mcp" },
        },
      ],
      items: [
        { type: "step", nodeId: "trigger" },
        { type: "step", nodeId: "plain-step" },
      ],
      message: /acceptsChildren/i,
    },
  ];

  for (const invalidCase of cases) {
    const baseUrl = await startServer();
    const result = await request(baseUrl, "/api/projects/local/workflow-workspace", {
      method: "PUT",
      body: {
        version: 0,
        workspace: {
          version: 1,
          tabs: [{ id: "invalid", name: "Invalid" }],
          activeWorkflowId: "invalid",
          snapshots: {
            invalid: {
              nodes: invalidCase.nodes,
              flow: {
                version: 2,
                root: { items: invalidCase.items },
              },
              selectedNodeId: null,
            },
          },
        },
      },
    });

    assert.equal(result.response.status, 400, invalidCase.name);
    assert.equal(result.body.error.code, "INVALID_FIELD", invalidCase.name);
    assert.match(result.body.error.message, invalidCase.message, invalidCase.name);
  }
});

test("workflow service rejects non-empty V2 snapshots without a trigger", async () => {
  const baseUrl = await startServer();
  const result = await request(baseUrl, "/api/projects/local/workflow-workspace", {
    method: "PUT",
    body: {
      version: 0,
      workspace: {
        version: 1,
        tabs: [{ id: "invalid", name: "Invalid" }],
        activeWorkflowId: "invalid",
        snapshots: {
          invalid: {
            nodes: [
              { id: "step", position: { x: 0, y: 0 }, data: { kind: "skill" } },
            ],
            flow: {
              version: 2,
              root: {
                items: [{ type: "step", nodeId: "step" }],
              },
            },
            selectedNodeId: null,
          },
        },
      },
    },
  });

  assert.equal(result.response.status, 400);
  assert.equal(result.body.error.code, "INVALID_FIELD");
  assert.match(result.body.error.message, /trigger/i);
});

test("workflow service rejects unknown node kinds that only look like triggers", async () => {
  const baseUrl = await startServer();
  const result = await request(baseUrl, "/api/projects/local/workflow-workspace", {
    method: "PUT",
    body: {
      version: 0,
      workspace: {
        version: 1,
        tabs: [{ id: "invalid", name: "Invalid" }],
        activeWorkflowId: "invalid",
        snapshots: {
          invalid: {
            nodes: [
              {
                id: "unknown-trigger",
                position: { x: 0, y: 0 },
                data: { kind: "made-up-trigger" },
              },
            ],
            flow: {
              version: 2,
              root: {
                items: [{ type: "step", nodeId: "unknown-trigger" }],
              },
            },
            selectedNodeId: null,
          },
        },
      },
    },
  });

  assert.equal(result.response.status, 400);
  assert.equal(result.body.error.code, "INVALID_FIELD");
  assert.match(result.body.error.message, /trigger kind/i);
});

test("workflow workspace changes are broadcast to other open clients", async () => {
  const baseUrl = await startServer();
  const eventResponse = await fetch(`${baseUrl}/api/events`);
  const reader = eventResponse.body.getReader();
  const decoder = new TextDecoder();
  await reader.read();

  const workspace = {
    version: 1,
    tabs: [{ id: "issue-delivery", name: "议题处理与交付" }],
    activeWorkflowId: "issue-delivery",
    snapshots: {
      "issue-delivery": { nodes: [], edges: [], selectedNodeId: null },
    },
  };
  const saved = await request(baseUrl, "/api/projects/local/workflow-workspace", {
    method: "PUT",
    body: { version: 0, workspace },
  });
  assert.equal(saved.response.status, 200);

  let message = "";
  while (!message.includes("\n\n")) {
    const chunk = await reader.read();
    assert.equal(chunk.done, false);
    message += decoder.decode(chunk.value, { stream: true });
  }
  assert.match(message, /event: workflow\.updated/);
  const dataLine = message.split("\n").find((line) => line.startsWith("data: "));
  const event = JSON.parse(dataLine.slice(6));
  assert.equal(event.type, "workflow.updated");
  assert.equal(event.projectId, "local");
  assert.equal(event.workflowVersion, 1);
  await reader.cancel();
});

test("workflow capabilities come from the live Codex skill and MCP catalogs", async () => {
  let workspacePath;
  const baseUrl = await startServer(async (directory) => {
    workspacePath = directory;
    const codexExecutable = path.join(directory, "fake-codex");
    await writeFile(codexExecutable, `#!/bin/sh
if [ "$1" = "mcp" ]; then
  printf '%s\\n' '[{"name":"context7","enabled":true,"transport":{"type":"streamable_http"}},{"name":"disabled-server","enabled":false,"transport":{"type":"stdio"}}]'
  exit 0
fi
while IFS= read -r line; do
  case "$line" in
    *'"id":1'*) printf '%s\\n' '{"id":1,"result":{"platformFamily":"unix"}}' ;;
    *'"id":2'*) printf '%s\\n' '{"id":2,"result":{"data":[{"cwd":"workspace","skills":[{"name":"user-skill","enabled":true,"scope":"user","interface":null},{"name":"repo-skill","enabled":true,"scope":"repo","interface":{"displayName":"Repository Skill"}},{"name":"user-skill","enabled":true,"scope":"system","interface":{"displayName":"Duplicate"}},{"name":"disabled-skill","enabled":false,"scope":"user","interface":null}],"errors":[]}]}}' ;;
  esac
done
`);
    await chmod(codexExecutable, 0o755);
    return { codexExecutable };
  });

  const result = await request(
    baseUrl,
    `/api/workflow-capabilities?workspacePath=${encodeURIComponent(workspacePath)}`,
  );
  assert.equal(result.response.status, 200);
  assert.deepEqual(result.body, {
    skills: [
      { id: "repo-skill", label: "Repository Skill", scope: "repo", description: "", path: "" },
      { id: "user-skill", label: "user-skill", scope: "user", description: "", path: "" },
    ],
    mcpServers: [
      { id: "context7", label: "context7", transport: "streamable_http" },
    ],
  });

  const invalidPath = await request(baseUrl, "/api/workflow-capabilities?workspacePath=relative");
  assert.equal(invalidPath.response.status, 400);
  assert.equal(invalidPath.body.error.code, "INVALID_FIELD");

  const unknownQuery = await request(baseUrl, "/api/workflow-capabilities?extra=true");
  assert.equal(unknownQuery.response.status, 400);
  assert.equal(unknownQuery.body.error.code, "UNKNOWN_QUERY_PARAMETER");

  const wrongMethod = await request(baseUrl, "/api/workflow-capabilities", { method: "POST" });
  assert.equal(wrongMethod.response.status, 405);
});

test("workflow capability discovery fails instead of inventing fallback options", async () => {
  const baseUrl = await startServer(async (directory) => ({
    codexExecutable: path.join(directory, "missing-codex"),
  }));
  const result = await request(baseUrl, "/api/workflow-capabilities");
  assert.equal(result.response.status, 500);
  assert.equal(result.body.error.code, "INTERNAL_ERROR");
});

test("existing task and comment thread attribution remains content-specific", async () => {
  const baseUrl = await startServer(async (directory) => {
    const databasePath = path.join(directory, "taskboard.sqlite");
    const database = new DatabaseSync(databasePath);
    database.exec(`
      CREATE TABLE projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        workspace_path TEXT,
        next_task_number INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        identifier TEXT NOT NULL UNIQUE,
        project_id TEXT NOT NULL REFERENCES projects(id),
        title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL CHECK (status IN ('backlog', 'todo', 'in_progress', 'done')),
        priority TEXT NOT NULL,
        labels TEXT NOT NULL DEFAULT '[]',
        sort_order REAL NOT NULL,
        thread_id TEXT,
        git_branch TEXT,
        worktree_path TEXT,
        worktree_branch TEXT,
        due_date TEXT,
        recurrence_interval INTEGER,
        recurrence_unit TEXT,
        archived_at TEXT,
        version INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE comments (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        body TEXT NOT NULL,
        thread_id TEXT,
        author_id TEXT NOT NULL,
        author_name TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE attachments (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        filename TEXT NOT NULL,
        content_type TEXT NOT NULL,
        size INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );
      INSERT INTO projects VALUES ('local', 'Local', NULL, 2, '2026-07-20T00:00:00.000Z', '2026-07-20T00:00:00.000Z');
      INSERT INTO tasks VALUES (
        'legacy-task', 'LOCAL-1', 'local', 'Legacy task', '', 'todo', 'none', '[]', 1000,
        '00000000-0000-4000-8000-000000000001', NULL, NULL, NULL, NULL, NULL, NULL, '2026-07-20T00:00:00.000Z', 1,
        '2026-07-20T00:00:00.000Z', '2026-07-20T00:00:00.000Z'
      );
      INSERT INTO comments VALUES (
        'legacy-comment', 'legacy-task', 'Legacy comment', '00000000-0000-4000-8000-000000000002', 'local', '本地用户', 1,
        '2026-07-20T00:00:00.000Z', '2026-07-20T00:00:00.000Z'
      );
      INSERT INTO attachments VALUES (
        'legacy-attachment', 'legacy-task', 'legacy.txt', 'text/plain', 0,
        '2026-07-20T00:00:00.000Z'
      );
    `);
    database.close();
    return { databasePath };
  });

  const result = await request(baseUrl, "/api/tasks/legacy-task");
  assert.equal(result.response.status, 200);
  assert.equal(result.body.task.threadId, "00000000-0000-4000-8000-000000000001");
  assert.deepEqual(result.body.task.threadIds, [
    "00000000-0000-4000-8000-000000000001",
    "00000000-0000-4000-8000-000000000002",
  ]);
  assert.equal(result.body.task.creatorType, "agent");
  assert.equal(result.body.task.status, "archived");
  assert.equal(result.body.task.creatorId, "codex-agent");
  assert.equal(result.body.task.creatorName, "Codex Agent");
  assert.deepEqual(result.body.task.assignee, {
    type: "agent",
    id: "codex-agent",
    name: "Codex Agent",
    avatarUrl: null,
  });
  assert.equal(Object.hasOwn(result.body.task, "linkedThreadId"), false);
  const columns = runningApps.at(-1).app.database.database.prepare("PRAGMA table_info(tasks)").all();
  assert.equal(columns.some((column) => column.name === "thread_id"), true);
  assert.equal(columns.some((column) => column.name === "workflow_id"), true);
  assert.equal(columns.some((column) => column.name === "assignee_type"), true);
  assert.equal(columns.some((column) => column.name === "assignee_id"), true);
  assert.equal(columns.some((column) => column.name === "assignee_name"), true);
  assert.equal(columns.some((column) => column.name === "assignee_avatar_url"), true);
  assert.equal(columns.some((column) => column.name === "linked_thread_id"), false);
  assert.equal(result.body.task.workflowId, null);
  const taskThreads = runningApps.at(-1).app.database.database.prepare(`
    SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'task_threads'
  `).get();
  assert.equal(taskThreads?.[1], 1);
  const comments = await request(baseUrl, "/api/tasks/legacy-task/comments");
  assert.equal(comments.body.comments[0].threadId, "00000000-0000-4000-8000-000000000002");
  assert.equal(comments.body.comments[0].authorType, "agent");
  assert.equal(comments.body.comments[0].authorId, "codex-agent");
  assert.equal(comments.body.comments[0].authorName, "Codex Agent");
  assert.deepEqual(comments.body.comments[0].attachments, []);
  const attachments = await request(baseUrl, "/api/tasks/legacy-task/attachments");
  assert.equal(attachments.body.attachments[0].commentId, null);

  let version = result.body.task.version;
  for (const status of ["in_review", "blocked", "canceled", "archived"]) {
    const moveResult = await request(baseUrl, "/api/tasks/legacy-task/move", {
      method: "POST",
      body: { version, status },
    });
    assert.equal(moveResult.response.status, 200);
    assert.equal(moveResult.body.task.status, status);
    version = moveResult.body.task.version;
  }
  const tasksSql = runningApps.at(-1).app.database.database.prepare(`
    SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'tasks'
  `).get().sql;
  assert.match(tasksSql, /'in_review'/);
  assert.match(tasksSql, /'blocked'/);
  assert.match(tasksSql, /'canceled'/);
  assert.match(tasksSql, /'archived'/);
  const commentForeignKeys = runningApps.at(-1).app.database.database
    .prepare("PRAGMA foreign_key_list(comments)")
    .all();
  assert.equal(commentForeignKeys.some((foreignKey) => foreignKey.table === "tasks"), true);
});

test("task thread migration preserves aggregate and comment-only entries", async () => {
  const baseUrl = await startServer(async (directory) => {
    const databasePath = path.join(directory, "taskboard.sqlite");
    const database = new DatabaseSync(databasePath);
    database.exec(`
      CREATE TABLE projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        workspace_path TEXT,
        next_task_number INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        identifier TEXT NOT NULL UNIQUE,
        project_id TEXT NOT NULL REFERENCES projects(id),
        title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL,
        priority TEXT NOT NULL,
        labels TEXT NOT NULL DEFAULT '[]',
        sort_order REAL NOT NULL,
        git_branch TEXT,
        worktree_path TEXT,
        worktree_branch TEXT,
        due_date TEXT,
        recurrence_interval INTEGER,
        recurrence_unit TEXT,
        archived_at TEXT,
        version INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE task_threads (
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        thread_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (task_id, thread_id)
      );
      CREATE TABLE comments (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        body TEXT NOT NULL,
        thread_id TEXT,
        author_id TEXT NOT NULL,
        author_name TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO projects VALUES ('local', 'Local', NULL, 2, '2026-07-20T00:00:00.000Z', '2026-07-20T00:00:00.000Z');
      INSERT INTO tasks VALUES (
        'aggregate-task', 'LOCAL-1', 'local', 'Aggregate task', '', 'todo', 'none', '[]', 1000,
        NULL, NULL, NULL, NULL, NULL, NULL, NULL, 1,
        '2026-07-20T00:00:00.000Z', '2026-07-20T03:00:00.000Z'
      );
      INSERT INTO task_threads VALUES ('aggregate-task', '00000000-0000-4000-8000-000000000003', '2026-07-20T01:00:00.000Z');
      INSERT INTO task_threads VALUES ('aggregate-task', '00000000-0000-4000-8000-000000000004', '2026-07-20T02:00:00.000Z');
      INSERT INTO comments VALUES (
        'aggregate-comment', 'aggregate-task', 'Comment', '00000000-0000-4000-8000-000000000004', 'local', '本地用户', 1,
        '2026-07-20T02:00:00.000Z', '2026-07-20T02:00:00.000Z'
      );
    `);
    database.close();
    return { databasePath };
  });

  const task = await request(baseUrl, "/api/tasks/aggregate-task");
  assert.equal(task.body.task.threadId, "00000000-0000-4000-8000-000000000003");
  assert.deepEqual(task.body.task.threadIds, [
    "00000000-0000-4000-8000-000000000003",
    "00000000-0000-4000-8000-000000000004",
  ]);
  const taskThreads = runningApps.at(-1).app.database.database.prepare(`
    SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'task_threads'
  `).get();
  assert.equal(taskThreads?.[1], 1);
  const taskThreadColumns = runningApps.at(-1).app.database.database
    .prepare("PRAGMA table_info(task_threads)")
    .all();
  assert.equal(taskThreadColumns.some((column) => column.name === "linked_at"), true);
  assert.equal(taskThreadColumns.some((column) => column.name === "created_at"), false);
  const comments = await request(baseUrl, "/api/tasks/aggregate-task/comments");
  assert.equal(comments.body.comments[0].threadId, "00000000-0000-4000-8000-000000000004");
});

test("development context scan resolves the current Codex conversation workspace", async () => {
  let expectedWorkspace;
  const baseUrl = await startServer(async (directory) => {
    expectedWorkspace = directory;
    const processesPath = path.join(directory, "chat_processes.json");
    await writeFile(processesPath, JSON.stringify({
      recent: [{
        conversationId: "019f7f96-287b-7da0-bc7f-ffe03af85cc8",
        cwd: directory,
        updatedAtMs: 20,
      }],
    }));
    return {
      codexStatePath: path.join(directory, "missing-state.json"),
      codexProcessesPath: processesPath,
    };
  });
  const result = await request(
    baseUrl,
    "/api/projects/local/development-contexts?codexThreadId=019f7f96-287b-7da0-bc7f-ffe03af85cc8",
  );
  assert.equal(result.response.status, 200);
  assert.equal(result.body.workspacePath, expectedWorkspace);
  assert.deepEqual(result.body.contexts, []);

  const deviceWorkspace = path.join(expectedWorkspace, "another-device-workspace");
  const deviceResult = await request(
    baseUrl,
    `/api/projects/local/development-contexts?workspacePath=${encodeURIComponent(deviceWorkspace)}`,
  );
  assert.equal(deviceResult.response.status, 200);
  assert.equal(deviceResult.body.workspacePath, deviceWorkspace);
});

test("device workspaces come from this machine's Codex project roots", async () => {
  const baseUrl = await startServer(async (directory) => {
    const codexStatePath = path.join(directory, "codex-state.json");
    await writeFile(codexStatePath, JSON.stringify({
      "local-projects": {
        "local-project-a": { rootPaths: ["/Users/alice/project-a"] },
        "local-project-b": { rootPaths: ["/Users/alice/project-b"] },
      },
    }));
    return { codexStatePath };
  });
  const result = await request(baseUrl, "/api/device-workspaces");
  assert.equal(result.response.status, 200);
  assert.deepEqual(result.body.workspaces, {
    "local-project-a": "/Users/alice/project-a",
    "local-project-b": "/Users/alice/project-b",
  });
});

test("project mappings persist in SQLite and populate device workspaces", async () => {
  const workspacePath = "/Users/alice/mapped-project";
  const baseUrl = await startServer();

  const mapResult = await request(baseUrl, "/api/local/project-mappings/local", {
    method: "PUT",
    body: JSON.stringify({ workspacePath }),
  });
  assert.equal(mapResult.response.status, 200);
  assert.equal(mapResult.body.workspacePath, workspacePath);

  const result = await request(baseUrl, "/api/device-workspaces");
  assert.equal(result.response.status, 200);
  assert.equal(result.body.workspaces.local, workspacePath);
});

test("accepts private LAN requests and rejects public Host and Origin headers", async () => {
  const baseUrl = await startServer(undefined, { host: "0.0.0.0" });

  const codexOriginResult = await request(baseUrl, "/health", {
    headers: { origin: "app://-" },
  });
  assert.equal(codexOriginResult.response.status, 200);

  const lanHostResult = await requestWithHost(baseUrl, "192.168.1.24:47823");
  assert.equal(lanHostResult.status, 200);

  const lanOriginResult = await request(baseUrl, "/health", {
    headers: { origin: "http://192.168.1.24:47823" },
  });
  assert.equal(lanOriginResult.response.status, 200);

  const localHostnameResult = await requestWithHost(baseUrl, "taskboard.local:47823");
  assert.equal(localHostnameResult.status, 200);

  const hostResult = await requestWithHost(baseUrl, "taskboard.example.com");
  assert.equal(hostResult.status, 403);
  assert.equal(hostResult.body.error.code, "INVALID_HOST");

  const originResult = await request(baseUrl, "/health", {
    headers: { origin: "https://evil.example" },
  });
  assert.equal(originResult.response.status, 403);
  assert.equal(originResult.body.error.code, "INVALID_ORIGIN");
});

test("project and task CRUD flow", async () => {
  const baseUrl = await startServer();

  const projectResult = await request(baseUrl, "/api/projects", {
    method: "POST",
    body: { id: "website", name: "Website", workspacePath: "/work/website" },
  });
  assert.equal(projectResult.response.status, 201);
  assert.equal(projectResult.body.project.id, "website");
  assert.equal(projectResult.body.project.workspacePath, "/work/website");

  const createResult = await request(baseUrl, "/api/tasks", {
    method: "POST",
    body: {
      projectId: "website",
      title: "Build task board",
      description: "Create the first local board",
      status: "todo",
      priority: "high",
      labels: ["frontend", "mvp"],
      threadId: "00000000-0000-4000-8000-000000000123",
      developmentContext: {
        type: "worktree",
        path: "/work/website/.worktrees/taskboard",
        branch: "worktree/taskboard",
      },
      dueDate: "2026-07-24",
      recurrence: { interval: 2, unit: "week" },
    },
  });
  assert.equal(createResult.response.status, 201);
  const created = createResult.body.task;
  assert.equal(created.identifier, "WEBSITE-1");
  assert.equal(created.version, 1);
  assert.equal(created.sortOrder, 1000);
  assert.equal(created.archivedAt, null);
  assert.deepEqual(created.labels, ["frontend", "mvp"]);
  assert.equal(created.threadId, "00000000-0000-4000-8000-000000000123");
  assert.equal(created.creatorType, "user");
  assert.equal(created.creatorId, "local-user");
  assert.equal(created.creatorName, "本地用户");
  assert.equal(created.creatorAvatarUrl, null);
  assert.deepEqual(created.developmentContext, {
    type: "worktree",
    path: "/work/website/.worktrees/taskboard",
    branch: "worktree/taskboard",
  });
  assert.equal(created.dueDate, "2026-07-24");
  assert.deepEqual(created.recurrence, { interval: 2, unit: "week" });

  const projectsAfterCreate = await request(baseUrl, "/api/projects");
  const websiteProject = projectsAfterCreate.body.projects.find((project) => project.id === "website");
  assert.equal(websiteProject.issueCount, 1);

  const getResult = await request(baseUrl, `/api/tasks/${created.id}`);
  assert.equal(getResult.response.status, 200);
  assert.deepEqual(getResult.body.task, created);
  const getByIdentifier = await request(baseUrl, `/api/tasks/${created.identifier}`);
  assert.equal(getByIdentifier.response.status, 200);
  assert.equal(getByIdentifier.body.task.id, created.id);

  const listResult = await request(baseUrl, "/api/tasks?projectId=website&status=todo");
  assert.equal(listResult.response.status, 200);
  assert.deepEqual(listResult.body.tasks.map((task) => task.id), [created.id]);

  const patchResult = await request(baseUrl, `/api/tasks/${created.identifier}`, {
    method: "PATCH",
    body: {
      version: created.version,
      title: "Build polished task board",
      priority: "urgent",
      threadId: "00000000-0000-4000-8000-000000000456",
      developmentContext: { type: "branch", branch: "feature/polish" },
    },
  });
  assert.equal(patchResult.response.status, 200);
  const updated = patchResult.body.task;
  assert.equal(updated.title, "Build polished task board");
  assert.equal(updated.priority, "urgent");
  assert.equal(updated.threadId, "00000000-0000-4000-8000-000000000456");
  assert.deepEqual(updated.developmentContext, { type: "branch", branch: "feature/polish" });
  assert.equal(updated.version, 2);

  const archiveResult = await request(baseUrl, `/api/tasks/${created.id}/archive`, {
    method: "POST",
    body: { version: updated.version, threadId: "00000000-0000-4000-8000-000000000005" },
  });
  assert.equal(archiveResult.response.status, 200);
  assert.equal(archiveResult.body.task.version, 3);
  assert.equal(archiveResult.body.task.threadId, "00000000-0000-4000-8000-000000000005");
  assert.equal(archiveResult.body.task.status, "archived");
  assert.match(archiveResult.body.task.archivedAt, /^\d{4}-\d{2}-\d{2}T/);

  const activeList = await request(baseUrl, "/api/tasks?projectId=website");
  assert.deepEqual(activeList.body.tasks.map((task) => task.id), [created.id]);
  const unarchivedList = await request(baseUrl, "/api/tasks?projectId=website&archived=false");
  assert.deepEqual(unarchivedList.body.tasks, []);
  const archivedList = await request(baseUrl, "/api/tasks?projectId=website&archived=true");
  assert.deepEqual(archivedList.body.tasks.map((task) => task.id), [created.id]);

  const projectsAfterArchive = await request(baseUrl, "/api/projects");
  const archivedWebsiteProject = projectsAfterArchive.body.projects.find((project) => project.id === "website");
  assert.equal(archivedWebsiteProject.issueCount, 0);

  const restoreResult = await request(baseUrl, `/api/tasks/${created.id}/restore`, {
    method: "POST",
    body: { version: archiveResult.body.task.version, threadId: "00000000-0000-4000-8000-000000000006" },
  });
  assert.equal(restoreResult.response.status, 200);
  assert.equal(restoreResult.body.task.archivedAt, null);
  assert.equal(restoreResult.body.task.status, "todo");
  assert.equal(restoreResult.body.task.version, 4);
  assert.equal(restoreResult.body.task.threadId, "00000000-0000-4000-8000-000000000006");

  const activeAfterRestore = await request(baseUrl, "/api/tasks?projectId=website");
  assert.deepEqual(activeAfterRestore.body.tasks.map((task) => task.id), [created.id]);
  const projectsAfterRestore = await request(baseUrl, "/api/projects");
  const restoredWebsiteProject = projectsAfterRestore.body.projects.find((project) => project.id === "website");
  assert.equal(restoredWebsiteProject.issueCount, 1);
});

test("moving a task updates its status and sort order", async () => {
  const baseUrl = await startServer();
  const createResult = await request(baseUrl, "/api/tasks", {
    method: "POST",
    body: { title: "Move me" },
  });
  const task = createResult.body.task;

  const moveResult = await request(baseUrl, `/api/tasks/${task.id}/move`, {
    method: "POST",
    body: { version: task.version, status: "in_progress", sortOrder: 2500.5, threadId: "00000000-0000-4000-8000-000000000007" },
  });
  assert.equal(moveResult.response.status, 200);
  assert.equal(moveResult.body.task.status, "in_progress");
  assert.equal(moveResult.body.task.sortOrder, 2500.5);
  assert.equal(moveResult.body.task.threadId, "00000000-0000-4000-8000-000000000007");
  assert.equal(moveResult.body.task.version, 2);
});

test("tasks can bind, change, and unbind one project workflow", async () => {
  const baseUrl = await startServer();
  const createResult = await request(baseUrl, "/api/tasks", {
    method: "POST",
    body: {
      title: "Bind workflow",
      workflowId: "issue-delivery",
    },
  });
  assert.equal(createResult.response.status, 201);
  assert.equal(createResult.body.task.workflowId, "issue-delivery");

  const changedResult = await request(baseUrl, `/api/tasks/${createResult.body.task.id}`, {
    method: "PATCH",
    body: {
      version: createResult.body.task.version,
      workflowId: "workflow-123",
    },
  });
  assert.equal(changedResult.response.status, 200);
  assert.equal(changedResult.body.task.workflowId, "workflow-123");

  const unboundResult = await request(baseUrl, `/api/tasks/${createResult.body.task.id}`, {
    method: "PATCH",
    body: {
      version: changedResult.body.task.version,
      workflowId: null,
    },
  });
  assert.equal(unboundResult.response.status, 200);
  assert.equal(unboundResult.body.task.workflowId, null);

  const invalidResult = await request(baseUrl, `/api/tasks/${createResult.body.task.id}`, {
    method: "PATCH",
    body: {
      version: unboundResult.body.task.version,
      workflowId: " ",
    },
  });
  assert.equal(invalidResult.response.status, 400);
  assert.equal(invalidResult.body.error.code, "INVALID_FIELD");
});

test("issues support parent, sub-issue, blocking, and related issue relationships", async () => {
  const baseUrl = await startServer();
  const createIssue = async (title, status = "todo", projectId = "local") => {
    const result = await request(baseUrl, "/api/tasks", {
      method: "POST",
      body: { projectId, title, status },
    });
    assert.equal(result.response.status, 201);
    return result.body.task;
  };
  const latest = async (id) => (await request(baseUrl, `/api/tasks/${id}`)).body.task;
  const mutateRelation = async (method, task, type, related, version = task.version) => (
    request(
      baseUrl,
      `/api/tasks/${encodeURIComponent(task.id)}/relations/${type}/${encodeURIComponent(related.id)}`,
      {
        method,
        body: { version, threadId: "00000000-0000-4000-8000-000000000008" },
      },
    )
  );

  const parent = await createIssue("Parent issue");
  const child = await createIssue("Child issue", "done");
  const grandchild = await createIssue("Grandchild issue", "canceled");
  const blocker = await createIssue("Blocking issue", "in_progress");
  const related = await createIssue("Related issue");

  const parentAdded = await mutateRelation("POST", child, "parent", parent);
  assert.equal(parentAdded.response.status, 200);
  assert.equal(parentAdded.body.task.version, child.version + 1);
  assert.equal(parentAdded.body.task.threadId, "00000000-0000-4000-8000-000000000008");
  assert.equal(parentAdded.body.task.relations.parent.id, parent.id);
  assert.equal(parentAdded.body.relatedTask.id, parent.id);

  const parentAfterAdd = await latest(parent.id);
  assert.deepEqual(parentAfterAdd.relations.subIssues.map((issue) => issue.id), [child.id]);
  assert.equal(parentAfterAdd.relations.subIssues[0].status, "done");

  const childWithGrandchild = await mutateRelation("POST", grandchild, "parent", await latest(child.id));
  assert.equal(childWithGrandchild.response.status, 200);
  const cycle = await mutateRelation("POST", await latest(parent.id), "parent", await latest(grandchild.id));
  assert.equal(cycle.response.status, 409);
  assert.equal(cycle.body.error.code, "RELATION_CYCLE");

  const self = await mutateRelation("POST", await latest(parent.id), "related", await latest(parent.id));
  assert.equal(self.response.status, 400);
  assert.equal(self.body.error.code, "SELF_RELATION");

  const blocksAdded = await mutateRelation("POST", await latest(parent.id), "blocks", blocker);
  assert.equal(blocksAdded.response.status, 200);
  assert.deepEqual(blocksAdded.body.task.relations.blocks.map((issue) => issue.id), [blocker.id]);
  assert.deepEqual((await latest(blocker.id)).relations.blockedBy.map((issue) => issue.id), [parent.id]);

  const duplicateBlocks = await mutateRelation(
    "POST",
    await latest(blocker.id),
    "blocked_by",
    await latest(parent.id),
  );
  assert.equal(duplicateBlocks.response.status, 409);
  assert.equal(duplicateBlocks.body.error.code, "RELATION_EXISTS");

  const relatedAdded = await mutateRelation("POST", await latest(parent.id), "related", related);
  assert.equal(relatedAdded.response.status, 200);
  assert.deepEqual(relatedAdded.body.task.relations.related.map((issue) => issue.id), [related.id]);
  assert.deepEqual((await latest(related.id)).relations.related.map((issue) => issue.id), [parent.id]);

  const stale = await mutateRelation(
    "DELETE",
    relatedAdded.body.task,
    "related",
    related,
    relatedAdded.body.task.version - 1,
  );
  assert.equal(stale.response.status, 409);
  assert.equal(stale.body.error.code, "VERSION_CONFLICT");

  const relatedRemoved = await mutateRelation("DELETE", relatedAdded.body.task, "related", related);
  assert.equal(relatedRemoved.response.status, 200);
  assert.deepEqual(relatedRemoved.body.task.relations.related, []);
  assert.deepEqual((await latest(related.id)).relations.related, []);

  const replacementParent = await createIssue("Replacement parent");
  const childBeforeReplace = await latest(child.id);
  const replaced = await mutateRelation("POST", childBeforeReplace, "parent", replacementParent);
  assert.equal(replaced.response.status, 200);
  assert.equal(replaced.body.task.relations.parent.id, replacementParent.id);
  assert.deepEqual((await latest(parent.id)).relations.subIssues, []);
  assert.deepEqual((await latest(replacementParent.id)).relations.subIssues.map((issue) => issue.id), [child.id]);

  const parentRemoved = await mutateRelation("DELETE", replaced.body.task, "parent", replacementParent);
  assert.equal(parentRemoved.response.status, 200);
  assert.equal(parentRemoved.body.task.relations.parent, null);
  assert.deepEqual((await latest(replacementParent.id)).relations.subIssues, []);

  const projectResult = await request(baseUrl, "/api/projects", {
    method: "POST",
    body: { id: "other", name: "Other" },
  });
  assert.equal(projectResult.response.status, 201);
  const crossProject = await createIssue("Other project issue", "todo", "other");
  const crossProjectRelation = await mutateRelation(
    "POST",
    await latest(parent.id),
    "related",
    crossProject,
  );
  assert.equal(crossProjectRelation.response.status, 400);
  assert.equal(crossProjectRelation.body.error.code, "CROSS_PROJECT_RELATION");
});

test("issue relationship changes are broadcast in realtime", async () => {
  const baseUrl = await startServer();
  const first = (await request(baseUrl, "/api/tasks", {
    method: "POST",
    body: { title: "Realtime source" },
  })).body.task;
  const second = (await request(baseUrl, "/api/tasks", {
    method: "POST",
    body: { title: "Realtime target" },
  })).body.task;

  const eventResponse = await fetch(`${baseUrl}/api/events`);
  const reader = eventResponse.body.getReader();
  const decoder = new TextDecoder();
  await reader.read();

  const changed = await request(
    baseUrl,
    `/api/tasks/${first.id}/relations/related/${second.id}`,
    {
      method: "POST",
      body: { version: first.version, threadId: "00000000-0000-4000-8000-000000000009" },
    },
  );
  assert.equal(changed.response.status, 200);

  let message = "";
  while (!message.includes("\n\n")) {
    const chunk = await reader.read();
    assert.equal(chunk.done, false);
    message += decoder.decode(chunk.value, { stream: true });
  }
  assert.match(message, /event: task\.relation\.updated/);
  const dataLine = message.split("\n").find((line) => line.startsWith("data: "));
  const event = JSON.parse(dataLine.slice(6));
  assert.equal(event.type, "task.relation.updated");
  assert.equal(event.task.id, first.id);
  assert.equal(event.relatedTask.id, second.id);
  await reader.cancel();
});

test("all task statuses are accepted, filtered, and listed in workflow order", async () => {
  const baseUrl = await startServer();
  const statuses = ["canceled", "done", "blocked", "in_review", "in_progress", "todo", "backlog"];

  for (const status of statuses) {
    const createResult = await request(baseUrl, "/api/tasks", {
      method: "POST",
      body: { title: status, status },
    });
    assert.equal(createResult.response.status, 201);
    assert.equal(createResult.body.task.status, status);
  }

  const listResult = await request(baseUrl, "/api/tasks");
  assert.deepEqual(
    listResult.body.tasks.map((task) => task.status),
    ["backlog", "todo", "in_progress", "in_review", "blocked", "done", "canceled"],
  );

  for (const status of ["in_review", "blocked", "canceled"]) {
    const filteredResult = await request(baseUrl, `/api/tasks?status=${status}`);
    assert.equal(filteredResult.response.status, 200);
    assert.deepEqual(filteredResult.body.tasks.map((task) => task.status), [status]);
  }
});

test("task and comment mutations keep content-specific conversation attribution", async () => {
  const baseUrl = await startServer();
  const createResult = await request(baseUrl, "/api/tasks", {
    method: "POST",
    body: { title: "Keep attribution", threadId: "00000000-0000-4000-8000-000000000010" },
  });
  const task = createResult.body.task;
  const updateResult = await request(baseUrl, `/api/tasks/${task.id}`, {
    method: "PATCH",
    body: { version: task.version, title: "Still attributed" },
  });
  assert.equal(updateResult.body.task.threadId, "00000000-0000-4000-8000-000000000010");

  const repeatedUpdate = await request(baseUrl, `/api/tasks/${task.id}`, {
    method: "PATCH",
    body: { version: updateResult.body.task.version, title: "Still attributed again", threadId: "00000000-0000-4000-8000-000000000010" },
  });
  assert.equal(repeatedUpdate.body.task.threadId, "00000000-0000-4000-8000-000000000010");

  const commentCreate = await request(baseUrl, `/api/tasks/${task.id}/comments`, {
    method: "POST",
    body: { body: "Attributed comment", threadId: "00000000-0000-4000-8000-000000000011" },
  });
  const comment = commentCreate.body.comment;
  const commentUpdate = await request(baseUrl, `/api/comments/${comment.id}`, {
    method: "PATCH",
    body: { version: comment.version, body: "Edited from the UI" },
  });
  assert.equal(commentUpdate.body.comment.threadId, "00000000-0000-4000-8000-000000000011");
  const taskAfterComment = await request(baseUrl, `/api/tasks/${task.id}`);
  assert.equal(taskAfterComment.body.task.threadId, "00000000-0000-4000-8000-000000000010");
});

test("issues retain multiple processing conversations while one remains current", async () => {
  const baseUrl = await startServer();
  const threadOne = "00000000-0000-4000-8000-000000000101";
  const threadTwo = "00000000-0000-4000-8000-000000000102";
  const threadThree = "00000000-0000-4000-8000-000000000103";
  const threadFour = "00000000-0000-4000-8000-000000000104";
  const threadFive = "00000000-0000-4000-8000-000000000105";
  const staleThread = "00000000-0000-4000-8000-000000000199";
  const created = await request(baseUrl, "/api/tasks", {
    method: "POST",
    body: { title: "Multiple conversations", threadId: threadOne, runtime: "claude" },
  });
  assert.equal(created.body.task.threadRuntimes[threadOne], "claude");
  const updated = await request(baseUrl, `/api/tasks/${created.body.task.id}`, {
    method: "PATCH",
    body: {
      version: created.body.task.version,
      title: "Handled again",
      threadId: threadTwo,
      runtime: "omp",
    },
  });
  assert.equal(updated.body.task.threadId, threadTwo);
  assert.equal(updated.body.task.threadIds[0], threadTwo);
  assert.deepEqual(new Set(updated.body.task.threadIds), new Set([threadOne, threadTwo]));
  assert.equal(updated.body.task.threadRuntimes[threadOne], "claude");
  assert.equal(updated.body.task.threadRuntimes[threadTwo], "omp");
  const stale = await request(baseUrl, `/api/tasks/${created.body.task.id}`, {
    method: "PATCH",
    body: { version: created.body.task.version, threadId: staleThread },
  });
  assert.equal(stale.response.status, 409);
  const afterStale = await request(baseUrl, `/api/tasks/${created.body.task.id}`);
  assert.equal(afterStale.body.task.threadIds.includes(staleThread), false);

  const commentCreated = await request(baseUrl, `/api/tasks/${created.body.task.id}/comments`, {
    method: "POST",
    body: { body: "Review from another conversation", threadId: threadThree },
  });
  const commentUpdated = await request(baseUrl, `/api/comments/${commentCreated.body.comment.id}`, {
    method: "PATCH",
    body: {
      version: commentCreated.body.comment.version,
      body: "Review updated elsewhere",
      threadId: threadFour,
    },
  });
  await request(baseUrl, `/api/comments/${commentCreated.body.comment.id}`, {
    method: "DELETE",
    body: { version: commentUpdated.body.comment.version, threadId: threadFive },
  });
  const afterComment = await request(baseUrl, `/api/tasks/${created.body.task.id}`);
  assert.equal(afterComment.body.task.threadId, threadTwo);
  assert.equal(afterComment.body.task.threadIds[0], threadTwo);
  assert.deepEqual(
    new Set(afterComment.body.task.threadIds),
    new Set([threadOne, threadTwo, threadThree, threadFour, threadFive]),
  );
  assert.equal(afterComment.body.task.threadRuntimes[threadThree], "codex");
  assert.equal(afterComment.body.task.threadRuntimes[threadFour], "codex");
  assert.equal(afterComment.body.task.threadRuntimes[threadFive], "codex");

  const relinked = await request(baseUrl, `/api/tasks/${created.body.task.id}`, {
    method: "PATCH",
    body: { version: afterComment.body.task.version, threadId: threadOne, runtime: "claude" },
  });
  assert.equal(relinked.response.status, 200);
  assert.equal(relinked.body.task.threadId, threadOne);
  assert.equal(relinked.body.task.threadIds[0], threadOne);
  assert.equal(relinked.body.task.threadIds.length, 5);
  assert.equal(relinked.body.task.threadRuntimes[threadOne], "claude");
});

test("task thread runtimes are reconciled from concrete local session evidence", async () => {
  const threadId = "00000000-0000-4000-8000-000000000201";
  const baseUrl = await startServer(async (directory) => {
    const codexStatePath = path.join(directory, "codex-state.json");
    const sessionsDirectory = path.join(directory, "sessions", "2026", "08", "12");
    await mkdir(sessionsDirectory, { recursive: true });
    await writeFile(codexStatePath, "{}");
    await writeFile(
      path.join(sessionsDirectory, `rollout-2026-08-12T15-35-11-${threadId}.jsonl`),
      JSON.stringify({
        timestamp: "2026-08-12T07:35:12.001Z",
        type: "session_meta",
        payload: { session_id: threadId },
      }),
    );
    return { codexStatePath };
  });
  const created = await request(baseUrl, "/api/tasks", {
    method: "POST",
    body: { title: "Wrong runtime", threadId, runtime: "claude" },
  });
  assert.equal(created.body.task.runtime, "codex");
  assert.equal(created.body.task.threadRuntimes[threadId], "codex");

  const listed = await request(baseUrl, "/api/tasks");
  assert.equal(listed.body.tasks.find((task) => task.id === created.body.task.id).runtime, "codex");
  assert.equal(
    listed.body.tasks.find((task) => task.id === created.body.task.id).threadRuntimes[threadId],
    "codex",
  );
});

test("stale updates receive a version conflict", async () => {
  const baseUrl = await startServer();
  const createResult = await request(baseUrl, "/api/tasks", {
    method: "POST",
    body: { title: "Concurrent edit" },
  });
  const task = createResult.body.task;

  const firstUpdate = await request(baseUrl, `/api/tasks/${task.id}`, {
    method: "PATCH",
    body: { version: task.version, title: "First editor" },
  });
  assert.equal(firstUpdate.response.status, 200);

  const staleUpdate = await request(baseUrl, `/api/tasks/${task.id}/move`, {
    method: "POST",
    body: { version: task.version, status: "done", sortOrder: 1 },
  });
  assert.equal(staleUpdate.response.status, 409);
  assert.equal(staleUpdate.body.error.code, "VERSION_CONFLICT");
  assert.deepEqual(staleUpdate.body.error.details, {
    expectedVersion: 1,
    actualVersion: 2,
  });
});

test("issue comments can be created, edited, listed, and deleted", async () => {
  const baseUrl = await startServer();
  const createTaskResult = await request(baseUrl, "/api/tasks", {
    method: "POST",
    body: { title: "Discuss me" },
  });
  const task = createTaskResult.body.task;

  const emptyList = await request(baseUrl, `/api/tasks/${task.id}/comments`);
  assert.equal(emptyList.response.status, 200);
  assert.deepEqual(emptyList.body.comments, []);

  const createResult = await request(baseUrl, `/api/tasks/${task.id}/comments`, {
    method: "POST",
    body: { body: "First comment", threadId: "00000000-0000-4000-8000-000000000012" },
  });
  assert.equal(createResult.response.status, 201);
  const comment = createResult.body.comment;
  assert.equal(comment.taskId, task.id);
  assert.equal(comment.body, "First comment");
  assert.equal(comment.threadId, "00000000-0000-4000-8000-000000000012");
  assert.deepEqual(comment.attachments, []);
  assert.equal(comment.authorType, "user");
  assert.equal(comment.authorId, "local-user");
  assert.equal(comment.authorName, "本地用户");
  assert.equal(comment.version, 1);

  const listResult = await request(baseUrl, `/api/tasks/${task.id}/comments`);
  assert.deepEqual(listResult.body.comments.map((item) => item.id), [comment.id]);

  const updateResult = await request(baseUrl, `/api/comments/${comment.id}`, {
    method: "PATCH",
    body: { version: comment.version, body: "Edited comment", threadId: "00000000-0000-4000-8000-000000000013" },
  });
  assert.equal(updateResult.response.status, 200);
  const updated = updateResult.body.comment;
  assert.equal(updated.body, "Edited comment");
  assert.equal(updated.threadId, "00000000-0000-4000-8000-000000000013");
  assert.equal(updated.version, 2);

  const taskAfterUpdate = await request(baseUrl, `/api/tasks/${task.id}`);
  assert.equal(taskAfterUpdate.body.task.threadId, null);

  const unlinkResult = await request(baseUrl, `/api/comments/${comment.id}`, {
    method: "PATCH",
    body: { version: updated.version, body: updated.body, threadId: null },
  });
  assert.equal(unlinkResult.response.status, 200);
  const unlinked = unlinkResult.body.comment;
  assert.equal(unlinked.threadId, null);
  assert.equal(unlinked.version, 3);
  const taskAfterUnlink = await request(baseUrl, `/api/tasks/${task.id}`);
  assert.equal(
    taskAfterUnlink.body.task.threadIds.includes("00000000-0000-4000-8000-000000000013"),
    false,
  );

  const staleUpdate = await request(baseUrl, `/api/comments/${comment.id}`, {
    method: "PATCH",
    body: { version: comment.version, body: "Stale edit" },
  });
  assert.equal(staleUpdate.response.status, 409);
  assert.equal(staleUpdate.body.error.code, "VERSION_CONFLICT");

  const deleteResult = await request(baseUrl, `/api/comments/${comment.id}`, {
    method: "DELETE",
    body: { version: unlinked.version, threadId: "00000000-0000-4000-8000-000000000014" },
  });
  assert.equal(deleteResult.response.status, 204);

  const finalList = await request(baseUrl, `/api/tasks/${task.id}/comments`);
  assert.deepEqual(finalList.body.comments, []);
  const taskAfterDelete = await request(baseUrl, `/api/tasks/${task.id}`);
  assert.equal(taskAfterDelete.body.task.threadId, null);
});

test("taskctl issue creation and comments use the Codex Agent identity", async () => {
  const baseUrl = await startServer();
  const agentHeaders = {
    "x-taskboard-client": "taskctl",
    "x-taskboard-user-id": "spoofed-user",
    "x-taskboard-user-name": "Spoofed User",
    "x-taskboard-user-avatar": "https://example.com/spoofed.png",
  };
  const createTaskResult = await request(baseUrl, "/api/tasks", {
    method: "POST",
    headers: agentHeaders,
    body: { title: "Created by Codex", threadId: "00000000-0000-4000-8000-000000000015" },
  });
  assert.equal(createTaskResult.response.status, 201);
  const task = createTaskResult.body.task;
  assert.equal(task.creatorType, "agent");
  assert.equal(task.creatorId, "codex-agent");
  assert.equal(task.creatorName, "Codex Agent");
  assert.equal(task.creatorAvatarUrl, null);
  assert.deepEqual(task.assignee, {
    type: "agent",
    id: "codex-agent",
    name: "Codex Agent",
    avatarUrl: null,
  });

  const createCommentResult = await request(baseUrl, `/api/tasks/${task.id}/comments`, {
    method: "POST",
    headers: agentHeaders,
    body: { body: "Implemented by Codex", threadId: "00000000-0000-4000-8000-000000000016" },
  });
  assert.equal(createCommentResult.response.status, 201);
  const comment = createCommentResult.body.comment;
  assert.equal(comment.authorType, "agent");
  assert.equal(comment.authorId, "codex-agent");
  assert.equal(comment.authorName, "Codex Agent");
  assert.equal(comment.authorAvatarUrl, null);
  assert.equal(comment.threadId, "00000000-0000-4000-8000-000000000016");
});

test("Codex-hosted user mutations persist the current account identity and avatar", async () => {
  const baseUrl = await startServer();
  const userHeaders = {
    "x-taskboard-user-id": "test-user",
    "x-taskboard-user-name": "Test%20User",
    "x-taskboard-user-avatar": "https://example.com/test-user.png",
  };
  const createTaskResult = await request(baseUrl, "/api/tasks", {
    method: "POST",
    headers: userHeaders,
    body: { title: "Created in Codex UI" },
  });
  assert.equal(createTaskResult.response.status, 201);
  const task = createTaskResult.body.task;
  assert.equal(task.creatorType, "user");
  assert.equal(task.creatorId, "test-user");
  assert.equal(task.creatorName, "Test User");
  assert.equal(task.creatorAvatarUrl, "https://example.com/test-user.png");
  assert.deepEqual(task.assignee, {
    type: "user",
    id: "test-user",
    name: "Test User",
    avatarUrl: "https://example.com/test-user.png",
  });

  const assignedToCodexResult = await request(baseUrl, `/api/tasks/${task.id}`, {
    method: "PATCH",
    headers: userHeaders,
    body: {
      version: task.version,
      assigneeTarget: "codex-agent",
    },
  });
  assert.equal(assignedToCodexResult.response.status, 200);
  assert.deepEqual(assignedToCodexResult.body.task.assignee, {
    type: "agent",
    id: "codex-agent",
    name: "Codex Agent",
    avatarUrl: null,
  });

  const assignedToUserResult = await request(baseUrl, `/api/tasks/${task.id}`, {
    method: "PATCH",
    headers: userHeaders,
    body: {
      version: assignedToCodexResult.body.task.version,
      assigneeTarget: "current-user",
    },
  });
  assert.equal(assignedToUserResult.response.status, 200);
  assert.deepEqual(assignedToUserResult.body.task.assignee, {
    type: "user",
    id: "test-user",
    name: "Test User",
    avatarUrl: "https://example.com/test-user.png",
  });

  const updatedByCodexResult = await request(baseUrl, `/api/tasks/${task.id}`, {
    method: "PATCH",
    headers: { "x-taskboard-client": "taskctl" },
    body: {
      version: assignedToUserResult.body.task.version,
      title: "Updated through taskctl",
    },
  });
  assert.equal(updatedByCodexResult.response.status, 200);
  assert.deepEqual(updatedByCodexResult.body.task.assignee, assignedToUserResult.body.task.assignee);

  const invalidAssigneeResult = await request(baseUrl, `/api/tasks/${task.id}`, {
    method: "PATCH",
    headers: userHeaders,
    body: {
      version: updatedByCodexResult.body.task.version,
      assigneeTarget: { type: "agent" },
    },
  });
  assert.equal(invalidAssigneeResult.response.status, 400);
  assert.equal(invalidAssigneeResult.body.error.code, "INVALID_FIELD");

  const createCommentResult = await request(baseUrl, `/api/tasks/${task.id}/comments`, {
    method: "POST",
    headers: userHeaders,
    body: { body: "Commented in Codex UI" },
  });
  assert.equal(createCommentResult.response.status, 201);
  const comment = createCommentResult.body.comment;
  assert.equal(comment.authorType, "user");
  assert.equal(comment.authorId, "test-user");
  assert.equal(comment.authorName, "Test User");
  assert.equal(comment.authorAvatarUrl, "https://example.com/test-user.png");
});

test("issue attachments can be uploaded, listed, opened, downloaded, and deleted", async () => {
  const baseUrl = await startServer();
  const createTaskResult = await request(baseUrl, "/api/tasks", {
    method: "POST",
    body: { title: "Attach files" },
  });
  const task = createTaskResult.body.task;

  const emptyList = await request(baseUrl, `/api/tasks/${task.id}/attachments`);
  assert.equal(emptyList.response.status, 200);
  assert.deepEqual(emptyList.body.attachments, []);

  const contents = "attachment contents\n";
  const uploadResult = await request(baseUrl, `/api/tasks/${task.id}/attachments`, {
    method: "POST",
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "x-taskboard-filename": encodeURIComponent("设计说明.txt"),
    },
    body: contents,
  });
  assert.equal(uploadResult.response.status, 201);
  const attachment = uploadResult.body.attachment;
  assert.equal(attachment.taskId, task.id);
  assert.equal(attachment.commentId, null);
  assert.equal(attachment.filename, "设计说明.txt");
  assert.equal(attachment.contentType, "text/plain");
  assert.equal(attachment.size, Buffer.byteLength(contents));
  assert.match(attachment.createdAt, /^\d{4}-\d{2}-\d{2}T/);

  const listResult = await request(baseUrl, `/api/tasks/${task.id}/attachments`);
  assert.deepEqual(listResult.body.attachments, [attachment]);

  const contentResponse = await fetch(`${baseUrl}/api/attachments/${attachment.id}/content`);
  assert.equal(contentResponse.status, 200);
  assert.equal(contentResponse.headers.get("content-type"), "text/plain");
  assert.match(contentResponse.headers.get("content-disposition"), /^inline; filename\*=UTF-8''/);
  assert.equal(await contentResponse.text(), contents);

  const headResponse = await fetch(`${baseUrl}/api/attachments/${attachment.id}/content`, { method: "HEAD" });
  assert.equal(headResponse.status, 200);
  assert.equal(Number(headResponse.headers.get("content-length")), Buffer.byteLength(contents));
  assert.equal(await headResponse.text(), "");

  const htmlUpload = await request(baseUrl, `/api/tasks/${task.id}/attachments`, {
    method: "POST",
    headers: {
      "content-type": "text/html",
      "x-taskboard-filename": encodeURIComponent("page.html"),
    },
    body: "<script>document.body.textContent = 'unsafe'</script>",
  });
  const htmlAttachment = htmlUpload.body.attachment;
  const htmlContent = await fetch(`${baseUrl}/api/attachments/${htmlAttachment.id}/content`);
  assert.equal(htmlContent.headers.get("content-type"), "application/octet-stream");
  assert.match(htmlContent.headers.get("content-disposition"), /^attachment;/);
  assert.equal(htmlContent.headers.get("content-security-policy"), "sandbox; default-src 'none'");
  const htmlDelete = await request(baseUrl, `/api/attachments/${htmlAttachment.id}`, { method: "DELETE" });
  assert.equal(htmlDelete.response.status, 204);

  const deleteResult = await request(baseUrl, `/api/attachments/${attachment.id}`, { method: "DELETE" });
  assert.equal(deleteResult.response.status, 204);
  const finalList = await request(baseUrl, `/api/tasks/${task.id}/attachments`);
  assert.deepEqual(finalList.body.attachments, []);
  const deletedContent = await request(baseUrl, `/api/attachments/${attachment.id}/content`);
  assert.equal(deletedContent.response.status, 404);
  assert.equal(deletedContent.body.error.code, "ATTACHMENT_NOT_FOUND");
});

test("comments support attachments and deleting a comment removes its files", async () => {
  const baseUrl = await startServer();
  const createTaskResult = await request(baseUrl, "/api/tasks", {
    method: "POST",
    body: { title: "Comment files" },
  });
  const task = createTaskResult.body.task;
  const createCommentResult = await request(baseUrl, `/api/tasks/${task.id}/comments`, {
    method: "POST",
    body: { body: "", threadId: "00000000-0000-4000-8000-000000000017" },
  });
  assert.equal(createCommentResult.response.status, 201);
  const comment = createCommentResult.body.comment;
  assert.equal(comment.body, "");

  const contents = "comment attachment\n";
  const uploadResult = await request(baseUrl, `/api/comments/${comment.id}/attachments`, {
    method: "POST",
    headers: {
      "content-type": "text/plain",
      "x-taskboard-filename": encodeURIComponent("comment.txt"),
    },
    body: contents,
  });
  assert.equal(uploadResult.response.status, 201);
  const attachment = uploadResult.body.attachment;
  assert.equal(attachment.taskId, task.id);
  assert.equal(attachment.commentId, comment.id);

  const attachmentList = await request(baseUrl, `/api/comments/${comment.id}/attachments`);
  assert.deepEqual(attachmentList.body.attachments, [attachment]);
  const commentList = await request(baseUrl, `/api/tasks/${task.id}/comments`);
  assert.deepEqual(commentList.body.comments[0].attachments, [attachment]);
  const taskAttachmentList = await request(baseUrl, `/api/tasks/${task.id}/attachments`);
  assert.deepEqual(taskAttachmentList.body.attachments, []);

  const storagePath = path.join(runningApps.at(-1).app.options.attachmentsDirectory, attachment.id);
  await access(storagePath);
  const deleteResult = await request(baseUrl, `/api/comments/${comment.id}`, {
    method: "DELETE",
    body: { version: comment.version, threadId: "00000000-0000-4000-8000-000000000018" },
  });
  assert.equal(deleteResult.response.status, 204);
  await assert.rejects(access(storagePath), { code: "ENOENT" });
  const deletedContent = await request(baseUrl, `/api/attachments/${attachment.id}/content`);
  assert.equal(deletedContent.response.status, 404);
  const taskAfterDelete = await request(baseUrl, `/api/tasks/${task.id}`);
  assert.equal(taskAfterDelete.body.task.threadId, null);
});

test("attachment uploads reject unsafe filenames", async () => {
  const baseUrl = await startServer();
  const createTaskResult = await request(baseUrl, "/api/tasks", {
    method: "POST",
    body: { title: "Validate attachments" },
  });
  const task = createTaskResult.body.task;

  const result = await request(baseUrl, `/api/tasks/${task.id}/attachments`, {
    method: "POST",
    headers: {
      "content-type": "text/plain",
      "x-taskboard-filename": encodeURIComponent("../outside.txt"),
    },
    body: "unsafe",
  });
  assert.equal(result.response.status, 400);
  assert.equal(result.body.error.code, "INVALID_FILENAME");
});

test("request boundaries reject unknown fields and invalid values", async () => {
  const baseUrl = await startServer();

  const unknown = await request(baseUrl, "/api/tasks", {
    method: "POST",
    body: { title: "Invalid", unexpected: true },
  });
  assert.equal(unknown.response.status, 400);
  assert.equal(unknown.body.error.code, "UNKNOWN_FIELD");

  const invalid = await request(baseUrl, "/api/tasks", {
    method: "POST",
    body: { title: "Invalid", status: "started" },
  });
  assert.equal(invalid.response.status, 400);
  assert.equal(invalid.body.error.code, "INVALID_FIELD");
  assert.match(invalid.body.error.message, /in_review/);
  assert.match(invalid.body.error.message, /blocked/);
  assert.match(invalid.body.error.message, /canceled/);

  const invalidWorktree = await request(baseUrl, "/api/tasks", {
    method: "POST",
    body: {
      title: "Invalid",
      developmentContext: { type: "worktree", path: "/tmp/bad\0path", branch: null },
    },
  });
  assert.equal(invalidWorktree.response.status, 400);
  assert.equal(invalidWorktree.body.error.code, "INVALID_FIELD");
});

test("task changes from one LAN client are broadcast to another client", async () => {
  const baseUrl = await startServer(undefined, { host: "0.0.0.0" });
  const lanHeaders = {
    host: "192.168.1.24:47823",
    origin: "http://192.168.1.24:47823",
  };
  const eventResponse = await fetch(`${baseUrl}/api/events`, { headers: lanHeaders });
  assert.equal(eventResponse.status, 200);
  const reader = eventResponse.body.getReader();
  const decoder = new TextDecoder();
  await reader.read();

  const createResult = await request(baseUrl, "/api/tasks", {
    method: "POST",
    headers: lanHeaders,
    body: { title: "Broadcast me" },
  });
  assert.equal(createResult.response.status, 201);

  let message = "";
  while (!message.includes("\n\n")) {
    const chunk = await reader.read();
    assert.equal(chunk.done, false);
    message += decoder.decode(chunk.value, { stream: true });
  }
  assert.match(message, /event: task\.created/);
  const dataLine = message.split("\n").find((line) => line.startsWith("data: "));
  const event = JSON.parse(dataLine.slice(6));
  assert.equal(event.type, "task.created");
  assert.equal(event.task.id, createResult.body.task.id);

  const listResult = await request(baseUrl, "/api/tasks?projectId=local", {
    headers: lanHeaders,
  });
  assert.equal(listResult.response.status, 200);
  assert.equal(listResult.body.tasks.some((task) => task.id === createResult.body.task.id), true);
  await reader.cancel();
});
