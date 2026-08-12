import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";

import { createTaskboardServer } from "../server/index.mjs";
import { createOmpLauncher } from "../server/omp-launcher.mjs";
import { createClaudeLauncher } from "../server/claude-launcher.mjs";

const runningApps = [];

afterEach(async () => {
  while (runningApps.length > 0) {
    const { app, directory } = runningApps.pop();
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});

async function startServer() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "connectors-test-"));
  const app = createTaskboardServer({ dataDirectory: directory });
  const address = await app.listen({ port: 0 });
  runningApps.push({ app, directory });
  return { baseUrl: `http://127.0.0.1:${address.port}`, directory };
}

async function request(baseUrl, pathname, options = {}) {
  const headers = new Headers(options.headers);
  if (options.body !== undefined && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  if (options.method && options.method !== "GET" && options.method !== "HEAD") {
    headers.set("X-Taskboard-User-Id", "local-user");
    headers.set("X-Taskboard-User-Name", "test");
  }
  const response = await fetch(`${baseUrl}${pathname}`, {
    ...options,
    headers,
    body: options.body === undefined || typeof options.body === "string"
      ? options.body
      : JSON.stringify(options.body),
  });
  const text = await response.text();
  return { response, body: text ? JSON.parse(text) : undefined };
}

function uuid(prefix) {
  return `${prefix}a` + "0".repeat(31) + "1";
}

test("connectors table migrates and starts empty", async () => {
  const { baseUrl } = await startServer();
  const { response, body } = await request(baseUrl, "/api/connectors");
  assert.equal(response.status, 200);
  assert.deepEqual(body.connectors, []);
});

test("meta exposes connectors list", async () => {
  const { baseUrl } = await startServer();
  const { body } = await request(baseUrl, "/api/meta");
  assert.deepEqual(body.connectors, []);
});

test("create, update, and delete a connector round-trip", async () => {
  const { baseUrl } = await startServer();
  const created = await request(baseUrl, "/api/connectors", {
    method: "POST",
    body: {
      name: "glm proxy",
      runtime: "omp",
      baseUrl: "https://gw.example.com",
      apiKey: "secret",
      model: "glm-5.2",
      isDefault: true,
    },
  });
  assert.equal(created.response.status, 201);
  assert.equal(created.body.connector.name, "glm proxy");
  assert.equal(created.body.connector.isDefault, true);
  assert.equal(created.body.connector.version, 1);
  const id = created.body.connector.id;

  const patched = await request(baseUrl, `/api/connectors/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: { version: 1, name: "glm proxy 2" },
  });
  assert.equal(patched.response.status, 200);
  assert.equal(patched.body.connector.name, "glm proxy 2");
  assert.equal(patched.body.connector.version, 2);

  const deleted = await request(baseUrl, `/api/connectors/${encodeURIComponent(id)}`, {
    method: "DELETE",
    body: { version: 2 },
  });
  assert.equal(deleted.response.status, 200);

  const { body } = await request(baseUrl, "/api/connectors");
  assert.deepEqual(body.connectors, []);
});

test("version conflict on stale update", async () => {
  const { baseUrl } = await startServer();
  const created = await request(baseUrl, "/api/connectors", {
    method: "POST",
    body: { name: "c", runtime: "omp" },
  });
  const id = created.body.connector.id;
  const stale = await request(baseUrl, `/api/connectors/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: { version: 99, name: "stale" },
  });
  assert.equal(stale.response.status, 409);
  assert.equal(stale.body.error.code, "VERSION_CONFLICT");
});

test("version conflict on stale delete", async () => {
  const { baseUrl } = await startServer();
  const created = await request(baseUrl, "/api/connectors", {
    method: "POST",
    body: { name: "c", runtime: "omp" },
  });
  const id = created.body.connector.id;
  const stale = await request(baseUrl, `/api/connectors/${encodeURIComponent(id)}`, {
    method: "DELETE",
    body: { version: 99 },
  });
  assert.equal(stale.response.status, 409);
});

test("only one default per runtime", async () => {
  const { baseUrl } = await startServer();
  const a = await request(baseUrl, "/api/connectors", {
    method: "POST",
    body: { name: "a", runtime: "omp", isDefault: true },
  });
  const b = await request(baseUrl, "/api/connectors", {
    method: "POST",
    body: { name: "b", runtime: "omp", isDefault: true },
  });
  const aAfter = await request(baseUrl, `/api/connectors/${encodeURIComponent(a.body.connector.id)}`);
  assert.equal(aAfter.body.connector.isDefault, false);
  assert.equal(b.body.connector.isDefault, true);

  const setDefault = await request(baseUrl, `/api/connectors/${encodeURIComponent(a.body.connector.id)}/default`, {
    method: "POST",
    body: { version: aAfter.body.connector.version },
  });
  assert.equal(setDefault.response.status, 200);
  assert.equal(setDefault.body.connector.isDefault, true);

  const bAfter = await request(baseUrl, `/api/connectors/${encodeURIComponent(b.body.connector.id)}`);
  assert.equal(bAfter.body.connector.isDefault, false);
});

test("claude and omp defaults coexist independently", async () => {
  const { baseUrl } = await startServer();
  const claude = await request(baseUrl, "/api/connectors", {
    method: "POST",
    body: { name: "cc", runtime: "claude", isDefault: true },
  });
  const omp = await request(baseUrl, "/api/connectors", {
    method: "POST",
    body: { name: "omp", runtime: "omp", isDefault: true },
  });
  assert.equal(claude.body.connector.isDefault, true);
  assert.equal(omp.body.connector.isDefault, true);
});

test("runtime must be claude or omp", async () => {
  const { baseUrl } = await startServer();
  const bad = await request(baseUrl, "/api/connectors", {
    method: "POST",
    body: { name: "x", runtime: "codex" },
  });
  assert.equal(bad.response.status, 400);
});

test("omp launcher uses provider/model flag without ANTHROPIC env", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "omp-launch-"));
  try {
    const launcher = createOmpLauncher({ dataDirectory: directory, ompExecutable: "omp" });
    const sessionId = "11111111-1111-1111-1111-111111111111";
    // launchSession computes model via ompModelArg (provider/model) and passes it in.
    const { scriptPath } = launcher.writeSessionFiles(sessionId, {
      workspacePath: directory,
      prompt: "hi",
      connector: { apiKey: "secret-key", model: "glm-5.2" },
      model: "aliyun/glm-5.2",
    });
    const script = await readFile(scriptPath, "utf8");
    assert.match(script, /--model='aliyun\/glm-5\.2'/);
    // omp credentials live in ~/.omp/agent/.env (overwritten at launch time),
    // not in ANTHROPIC_* env vars injected into the script.
    assert.doesNotMatch(script, /ANTHROPIC_BASE_URL/);
    assert.doesNotMatch(script, /ANTHROPIC_API_KEY=/);
    assert.doesNotMatch(script, /ANTHROPIC_CUSTOM_HEADERS/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("omp launcher omits model without connector (fallback)", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "omp-fallback-"));
  try {
    const launcher = createOmpLauncher({ dataDirectory: directory, ompExecutable: "omp" });
    const { scriptPath } = launcher.writeSessionFiles("22222222-2222-2222-2222-222222222222", {
      workspacePath: directory,
      prompt: "hi",
      connector: null,
    });
    const script = await readFile(scriptPath, "utf8");
    assert.doesNotMatch(script, /--model=/);
    assert.doesNotMatch(script, /ANTHROPIC/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("claude launcher injects AUTH_TOKEN and model arg", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "claude-launch-"));
  try {
    const launcher = createClaudeLauncher({
      dataDirectory: directory,
      claudeExecutable: "claude",
      skillSourceDir: null,
    });
    const { scriptPath } = launcher.writeSessionFiles("33333333-3333-3333-3333-333333333333", {
      workspacePath: directory,
      prompt: "hi",
      claudeArgs: ["--dangerously-skip-permissions"],
      connector: {
        baseUrl: "https://gw.example.com",
        apiKey: "tok",
        model: "opus",
      },
    });
    const script = await readFile(scriptPath, "utf8");
    assert.match(script, /export ANTHROPIC_BASE_URL='https:\/\/gw\.example\.com'/);
    assert.match(script, /export ANTHROPIC_AUTH_TOKEN='tok'/);
    assert.match(script, /--model 'opus'/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("claude launcher omits env without connector (fallback)", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "claude-fallback-"));
  try {
    const launcher = createClaudeLauncher({
      dataDirectory: directory,
      claudeExecutable: "claude",
      skillSourceDir: null,
    });
    const { scriptPath } = launcher.writeSessionFiles("44444444-4444-4444-4444-444444444444", {
      workspacePath: directory,
      prompt: "hi",
      claudeArgs: ["--dangerously-skip-permissions"],
      connector: null,
    });
    const script = await readFile(scriptPath, "utf8");
    assert.doesNotMatch(script, /ANTHROPIC_BASE_URL/);
    assert.doesNotMatch(script, /ANTHROPIC_AUTH_TOKEN=/);
    assert.doesNotMatch(script, /--model /);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
