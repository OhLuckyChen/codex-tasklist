#!/usr/bin/env node

import { pathToFileURL } from "node:url";

const DEFAULT_API_URL = "http://127.0.0.1:47823";

export const tools = [
  {
    name: "taskboard_list_projects",
    description: "List Taskboard projects available to the local agent.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "taskboard_list_issues",
    description: "List Taskboard issues. Optionally filter by project ID and status.",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string" },
        status: { type: "string", enum: ["backlog", "todo", "in_progress", "in_review", "blocked", "done", "canceled", "archived"] },
      },
      additionalProperties: false,
    },
  },
  {
    name: "taskboard_get_issue",
    description: "Read one Taskboard issue by its stable ID or human-readable identifier.",
    inputSchema: {
      type: "object",
      properties: { issueId: { type: "string" } },
      required: ["issueId"],
      additionalProperties: false,
    },
  },
  {
    name: "taskboard_create_issue",
    description: "Create a Taskboard issue for work that should be tracked durably.",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string" },
        title: { type: "string" },
        description: { type: "string" },
        priority: { type: "string", enum: ["none", "urgent", "high", "medium", "low"] },
        threadId: { type: "string" },
      },
      required: ["projectId", "title"],
      additionalProperties: false,
    },
  },
  {
    name: "taskboard_claim_issue",
    description: "Claim a todo Taskboard issue by moving it to in_progress. Read the issue first and pass its latest version.",
    inputSchema: {
      type: "object",
      properties: { issueId: { type: "string" }, version: { type: "integer", minimum: 1 }, threadId: { type: "string" } },
      required: ["issueId", "version"],
      additionalProperties: false,
    },
  },
  {
    name: "taskboard_add_comment",
    description: "Append progress, evidence, blockers, or review notes to a Taskboard issue.",
    inputSchema: {
      type: "object",
      properties: { issueId: { type: "string" }, body: { type: "string" }, threadId: { type: "string" } },
      required: ["issueId", "body"],
      additionalProperties: false,
    },
  },
  {
    name: "taskboard_move_issue",
    description: "Move an issue to a new Taskboard status. Read the issue first and pass its latest version.",
    inputSchema: {
      type: "object",
      properties: {
        issueId: { type: "string" },
        version: { type: "integer", minimum: 1 },
        status: { type: "string", enum: ["backlog", "todo", "in_progress", "in_review", "blocked", "done", "canceled", "archived"] },
        threadId: { type: "string" },
      },
      required: ["issueId", "version", "status"],
      additionalProperties: false,
    },
  },
];

function textResult(value) {
  return { content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value };
}

function normalizeBaseUrl(value) {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("TASKBOARD_MCP_URL must use http or https");
  url.pathname = url.pathname.replace(/\/$/, "");
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

export function createMcpHandler({ baseUrl = process.env.TASKBOARD_MCP_URL ?? DEFAULT_API_URL, fetchImplementation = globalThis.fetch } = {}) {
  const apiUrl = normalizeBaseUrl(baseUrl);
  if (typeof fetchImplementation !== "function") throw new Error("fetch is not available");

  async function api(method, pathname, body) {
    const response = await fetchImplementation(new URL(pathname, `${apiUrl}/`), {
      method,
      headers: {
        accept: "application/json",
        "x-taskboard-client": "taskctl",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    let payload;
    try { payload = text ? JSON.parse(text) : {}; } catch { throw new Error("Taskboard service returned invalid JSON"); }
    if (!response.ok) throw new Error(payload?.error?.message ?? `Taskboard service returned HTTP ${response.status}`);
    return payload;
  }

  async function callTool(name, args = {}) {
    switch (name) {
      case "taskboard_list_projects": return api("GET", "/api/projects");
      case "taskboard_list_issues": {
        const query = new URLSearchParams();
        if (args.projectId !== undefined) query.set("projectId", args.projectId);
        if (args.status !== undefined) query.set("status", args.status);
        return api("GET", `/api/tasks${query.size ? `?${query}` : ""}`);
      }
      case "taskboard_get_issue": return api("GET", `/api/tasks/${encodeURIComponent(args.issueId)}`);
      case "taskboard_create_issue": return api("POST", "/api/tasks", {
        projectId: args.projectId, title: args.title, description: args.description ?? "",
        priority: args.priority ?? "none", status: "todo", ...(args.threadId ? { threadId: args.threadId } : {}),
      });
      case "taskboard_claim_issue": return api("POST", `/api/tasks/${encodeURIComponent(args.issueId)}/move`, {
        version: args.version, status: "in_progress", ...(args.threadId ? { threadId: args.threadId } : {}),
      });
      case "taskboard_add_comment": return api("POST", `/api/tasks/${encodeURIComponent(args.issueId)}/comments`, {
        body: args.body, ...(args.threadId ? { threadId: args.threadId } : {}),
      });
      case "taskboard_move_issue": return api("POST", `/api/tasks/${encodeURIComponent(args.issueId)}/move`, {
        version: args.version, status: args.status, ...(args.threadId ? { threadId: args.threadId } : {}),
      });
      default: throw Object.assign(new Error(`Unknown tool: ${name}`), { code: -32601 });
    }
  }

  return async function handle(request) {
    switch (request.method) {
      case "initialize":
        return { protocolVersion: request.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: { listChanged: false } }, serverInfo: { name: "taskboard", title: "Taskboard", version: "0.1.0" } };
      case "ping": return {};
      case "tools/list": return { tools };
      case "tools/call": return textResult(await callTool(request.params?.name, request.params?.arguments ?? {}));
      case "notifications/initialized": return null;
      default: throw Object.assign(new Error("Method not found"), { code: -32601 });
    }
  };
}

export async function main(input = process.stdin, output = process.stdout, options = {}) {
  const handle = createMcpHandler(options);
  input.setEncoding("utf8");
  let buffer = "";
  for await (const chunk of input) {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      let request;
      try {
        request = JSON.parse(line);
        const result = await handle(request);
        if (request.id != null && result != null) output.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`);
      } catch (error) {
        if (request?.id != null) output.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: Number(error?.code) || -32603, message: error?.message || "Internal error" } })}\n`);
      }
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
