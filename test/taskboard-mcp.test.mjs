import assert from "node:assert/strict";
import test from "node:test";

import { createMcpHandler, tools } from "../server/taskboard-mcp.mjs";

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
}

test("MCP advertises the core Taskboard agent tools", async () => {
  const handle = createMcpHandler({ fetchImplementation: async () => assert.fail("fetch should not run") });
  const listed = await handle({ method: "tools/list" });
  assert.deepEqual(listed.tools, tools);
  assert.deepEqual(tools.map((tool) => tool.name), [
    "taskboard_list_projects", "taskboard_list_issues", "taskboard_get_issue", "taskboard_create_issue",
    "taskboard_claim_issue", "taskboard_add_comment", "taskboard_move_issue",
  ]);
});

test("MCP tools delegate issue actions to the existing local HTTP API", async () => {
  const calls = [];
  const handle = createMcpHandler({ baseUrl: "http://127.0.0.1:47823", fetchImplementation: async (url, init) => {
    calls.push({ url: url.toString(), init });
    return jsonResponse({ task: { id: "task-1", status: "in_progress", version: 2 } });
  } });

  const result = await handle({ method: "tools/call", params: { name: "taskboard_claim_issue", arguments: { issueId: "TASK-1", version: 1, threadId: "019ff524-fbdd-7b33-9a5b-bc90eda8b3aa" } } });
  assert.equal(calls[0].url, "http://127.0.0.1:47823/api/tasks/TASK-1/move");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.headers["x-taskboard-client"], "taskctl");
  assert.deepEqual(JSON.parse(calls[0].init.body), { version: 1, status: "in_progress", threadId: "019ff524-fbdd-7b33-9a5b-bc90eda8b3aa" });
  assert.deepEqual(result.structuredContent, { task: { id: "task-1", status: "in_progress", version: 2 } });
});
