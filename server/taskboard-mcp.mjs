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
  {
    name: "taskboard_resolve_project_by_workspace",
    description: "Resolve the Taskboard project mapped to a local workspace path. Uses exact or longest ancestor matching.",
    inputSchema: {
      type: "object",
      properties: { workspacePath: { type: "string" } },
      required: ["workspacePath"],
      additionalProperties: false,
    },
  },
  {
    name: "taskboard_get_project_context",
    description: "Read the Taskboard project context and the labels/source types expected for Hermes data flywheel writes.",
    inputSchema: {
      type: "object",
      properties: { projectId: { type: "string" } },
      required: ["projectId"],
      additionalProperties: false,
    },
  },
  {
    name: "taskboard_search_project_knowledge",
    description: "Search project knowledge with source-backed results. Pass workspacePath when Hermes is serving a specific local workspace.",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string" },
        query: { type: "string" },
        workspacePath: { type: "string" },
      },
      required: ["projectId", "query"],
      additionalProperties: false,
    },
  },
  {
    name: "taskboard_record_interaction",
    description: "Record a Hermes answer as a Taskboard interaction. Label must be one of the existing Taskboard tags: 咨询 or 缺陷.",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string" },
        workspacePath: { type: "string" },
        sourceRuntime: { type: "string" },
        channel: { type: "string" },
        conversationId: { type: "string" },
        question: { type: "string" },
        answer: { type: "string" },
        label: { type: "string", enum: ["咨询", "缺陷"] },
        sources: { type: "array", items: { type: "object" } },
      },
      required: ["projectId", "workspacePath", "conversationId", "question", "answer", "label"],
      additionalProperties: false,
    },
  },
  {
    name: "taskboard_create_knowledge_candidate",
    description: "Create a ready knowledge proposal from a Hermes consultation. It does not publish or write knowledge files.",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string" },
        title: { type: "string" },
        summary: { type: "string" },
        content: { type: "string" },
        targetPath: { type: "string" },
        interactionId: { type: "string" },
        sources: { type: "array", items: { type: "object" } },
      },
      required: ["projectId", "title", "content"],
      additionalProperties: false,
    },
  },
  {
    name: "taskboard_create_self_service_defect",
    description: "Create a Taskboard issue for a Hermes-detected self-service defect using the existing 缺陷 label.",
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
    name: "taskboard_link_sources",
    description: "Attach or replace source citations on a recorded Hermes interaction.",
    inputSchema: {
      type: "object",
      properties: {
        interactionId: { type: "string" },
        sources: { type: "array", items: { type: "object" } },
      },
      required: ["interactionId", "sources"],
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
      case "taskboard_resolve_project_by_workspace": {
        const query = new URLSearchParams({ workspacePath: args.workspacePath });
        return api("GET", `/api/projects/resolve-by-workspace?${query}`);
      }
      case "taskboard_get_project_context": return api("GET", `/api/projects/${encodeURIComponent(args.projectId)}/context`);
      case "taskboard_search_project_knowledge": {
        const query = new URLSearchParams({ q: args.query });
        if (args.workspacePath) query.set("workspacePath", args.workspacePath);
        return api("GET", `/api/local/projects/${encodeURIComponent(args.projectId)}/knowledge/search?${query}`);
      }
      case "taskboard_record_interaction": return api("POST", `/api/projects/${encodeURIComponent(args.projectId)}/interactions`, {
        workspacePath: args.workspacePath,
        sourceRuntime: args.sourceRuntime ?? "hermes",
        channel: args.channel ?? "wecom",
        conversationId: args.conversationId,
        question: args.question,
        answer: args.answer,
        label: args.label,
        sources: args.sources ?? [],
      });
      case "taskboard_create_knowledge_candidate": return api("POST", `/api/projects/${encodeURIComponent(args.projectId)}/knowledge-candidates`, {
        title: args.title,
        summary: args.summary ?? "",
        content: args.content,
        targetPath: args.targetPath,
        interactionId: args.interactionId,
        sources: args.sources ?? [],
      });
      case "taskboard_create_self_service_defect": return api("POST", "/api/tasks", {
        projectId: args.projectId,
        title: args.title,
        description: args.description ?? "",
        priority: args.priority ?? "none",
        status: "todo",
        labels: ["缺陷"],
        ...(args.threadId ? { threadId: args.threadId } : {}),
      });
      case "taskboard_link_sources": return api("PATCH", `/api/interactions/${encodeURIComponent(args.interactionId)}/sources`, {
        sources: args.sources,
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
