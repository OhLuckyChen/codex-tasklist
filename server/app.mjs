import { randomUUID } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { mkdir, open, readFile, readdir, stat, unlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { isIP } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  DEFAULT_PROJECT_ID,
  TASK_STATUSES,
  isTaskPriority,
  isTaskStatus,
} from "../shared/domain.mjs";
import { normalizeCodexThreadId } from "../shared/codex-thread-id.mjs";
import { normalizeWorkflowSnapshot } from "../shared/workflow-control-flow.mjs";
import { withoutTaskboardLauncherEnvironment } from "../shared/codex-environment.mjs";
import { ApiError, TaskboardDatabase } from "./database.mjs";
import { createClaudeLauncher } from "./claude-launcher.mjs";
import { createOmpLauncher } from "./omp-launcher.mjs";
import { KnowledgeService, knowledgeInternals } from "./knowledge-service.mjs";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const execFileAsync = promisify(execFile);
const JSON_BODY_LIMIT = 1024 * 1024;
const ATTACHMENT_BODY_LIMIT = 25 * 1024 * 1024;
const KNOWLEDGE_BODY_LIMIT = 6 * 1024 * 1024;
const HOST_RUNTIME_TTL_MS = 3_000;
const CODEX_PLAN_TAIL_BYTES = 16 * 1024 * 1024;
const INLINE_ATTACHMENT_TYPES = new Set([
  "application/pdf",
  "image/avif",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
  "text/plain",
]);
const PROJECT_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const TRUSTED_EMBED_ORIGINS = new Set(["app://-"]);
const DIRECTORY_PICKER_SCRIPT = 'POSIX path of (choose folder with prompt "选择本地项目目录")';
const CODEX_AGENT_ACTOR = {
  type: "agent",
  id: "codex-agent",
  name: "Codex Agent",
  avatarUrl: null,
};
const CLAUDE_AGENT_ACTOR = {
  type: "agent",
  id: "claude-agent",
  name: "Claude Agent",
  avatarUrl: null,
};
const OMP_AGENT_ACTOR = {
  type: "agent",
  id: "omp-agent",
  name: "OMP Agent",
  avatarUrl: null,
};
const AGENT_RUNTIME_ACTORS = {
  "codex": CODEX_AGENT_ACTOR,
  "claude": CLAUDE_AGENT_ACTOR,
  "omp": OMP_AGENT_ACTOR,
};
const CONTENT_TYPES = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".ico", "image/x-icon"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".map", "application/json; charset=utf-8"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".webp", "image/webp"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"],
]);

function sendJson(response, status, value, headers = {}) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body),
    "content-type": "application/json; charset=utf-8",
    ...headers,
  });
  response.end(body);
}

function sendEmpty(response, status, headers = {}) {
  response.writeHead(status, { "cache-control": "no-store", ...headers });
  response.end();
}

function normalizeHostname(hostname) {
  return hostname.toLowerCase().replace(/^\[|\]$/g, "");
}

function isTrustedNetworkHost(hostname) {
  const host = normalizeHostname(hostname);
  if (host === "localhost" || host === "::1" || host.endsWith(".local")) return true;
  if (isIP(host) === 4) {
    const octets = host.split(".").map(Number);
    return octets[0] === 127
      || octets[0] === 10
      || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
      || (octets[0] === 192 && octets[1] === 168)
      || (octets[0] === 169 && octets[1] === 254);
  }
  if (isIP(host) === 6) {
    return host.startsWith("fc")
      || host.startsWith("fd")
      || /^fe[89ab]/.test(host);
  }
  return false;
}

function assertTrustedNetworkRequest(request) {
  let host;
  try {
    host = new URL(`http://${request.headers.host ?? ""}`).hostname;
  } catch {
    throw new ApiError(403, "INVALID_HOST", "Request Host must be local or private");
  }
  if (!isTrustedNetworkHost(host)) {
    throw new ApiError(403, "INVALID_HOST", "Request Host must be local or private");
  }

  const origin = request.headers.origin;
  if (!origin) return;
  if (TRUSTED_EMBED_ORIGINS.has(origin)) return;
  let originHost;
  try {
    originHost = new URL(origin).hostname;
  } catch {
    throw new ApiError(403, "INVALID_ORIGIN", "Request Origin must be local or private");
  }
  if (!isTrustedNetworkHost(originHost)) {
    throw new ApiError(403, "INVALID_ORIGIN", "Request Origin must be local or private");
  }
}

function assertLoopbackRequest(request) {
  const address = request.socket.remoteAddress;
  if (
    address !== "127.0.0.1"
    && address !== "::1"
    && address !== "::ffff:127.0.0.1"
  ) {
    throw new ApiError(403, "LOCAL_ONLY", "This endpoint is only available on this device");
  }
}

async function chooseLocalDirectory() {
  if (process.platform !== "darwin") {
    throw new ApiError(501, "DIRECTORY_PICKER_UNAVAILABLE", "当前系统不支持文件夹选择器");
  }
  try {
    const { stdout } = await execFileAsync("/usr/bin/osascript", ["-e", DIRECTORY_PICKER_SCRIPT]);
    return path.resolve(stdout.trim());
  } catch (error) {
    if (String(error.stderr ?? error.message).includes("-128")) return null;
    throw new ApiError(500, "DIRECTORY_PICKER_FAILED", "无法打开文件夹选择器");
  }
}

function assertPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError(400, "INVALID_BODY", "Request body must be a JSON object");
  }
}

function assertAllowedKeys(value, allowed) {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new ApiError(400, "UNKNOWN_FIELD", `Unknown field${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}`);
  }
}

function assertAllowedQuery(searchParams, allowed, routeLabel) {
  for (const key of searchParams.keys()) {
    if (!allowed.has(key)) {
      throw new ApiError(400, "UNKNOWN_QUERY_PARAMETER", `${routeLabel} does not accept query parameter '${key}'`);
    }
    if (searchParams.getAll(key).length !== 1) {
      throw new ApiError(400, "INVALID_QUERY_PARAMETER", `Query parameter '${key}' cannot be repeated`);
    }
  }
}

function assertNoQuery(searchParams, routeLabel) {
  assertAllowedQuery(searchParams, new Set(), routeLabel);
}

function decodeRouteSegment(value, name) {
  let decoded;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    throw new ApiError(400, "INVALID_PATH", `${name} contains invalid encoding`);
  }
  if (!decoded || decoded.length > 256 || decoded.includes("\0")) {
    throw new ApiError(400, "INVALID_PATH", `${name} is invalid`);
  }
  return decoded;
}

function isLoopbackAddress(value) {
  if (typeof value !== "string") return false;
  const address = value.toLowerCase().split("%", 1)[0];
  return address === "::1"
    || address === "127.0.0.1"
    || address.startsWith("127.")
    || address === "::ffff:127.0.0.1"
    || address.startsWith("::ffff:127.");
}

function assertAiLoopbackRequest(request) {
  if (!isLoopbackAddress(request.socket.remoteAddress)) {
    throw new ApiError(403, "LOCAL_AI_LOOPBACK_REQUIRED", "Local AI routes are only available from this device");
  }
}

function stringField(value, name, { required = false, nullable = false, maxLength }) {
  if (value === undefined) {
    if (required) {
      throw new ApiError(400, "INVALID_FIELD", `'${name}' is required`);
    }
    return undefined;
  }
  if (nullable && value === null) {
    return null;
  }
  if (typeof value !== "string") {
    throw new ApiError(400, "INVALID_FIELD", `'${name}' must be a string${nullable ? " or null" : ""}`);
  }
  const normalized = value.trim();
  if (required && normalized.length === 0) {
    throw new ApiError(400, "INVALID_FIELD", `'${name}' cannot be empty`);
  }
  if (normalized.length > maxLength) {
    throw new ApiError(400, "INVALID_FIELD", `'${name}' cannot exceed ${maxLength} characters`);
  }
  return normalized;
}

function pathField(value, name) {
  const normalized = stringField(value, name, { nullable: true, maxLength: 4096 });
  if (normalized === "") {
    throw new ApiError(400, "INVALID_FIELD", `'${name}' cannot be empty`);
  }
  if (normalized?.includes("\0")) {
    throw new ApiError(400, "INVALID_FIELD", `'${name}' cannot contain null bytes`);
  }
  return normalized;
}

function parseDueDate(value, name = "dueDate") {
  const date = stringField(value, name, { nullable: true, maxLength: 10 });
  if (date !== null && date !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new ApiError(400, "INVALID_FIELD", `'${name}' must use YYYY-MM-DD`);
  }
  return date;
}

function parseDevelopmentContext(value) {
  if (value === null) return null;
  assertPlainObject(value);
  if (value.type === "branch") {
    assertAllowedKeys(value, new Set(["type", "branch"]));
    return {
      type: "branch",
      branch: stringField(value.branch, "developmentContext.branch", { required: true, maxLength: 512 }),
    };
  }
  if (value.type === "worktree") {
    assertAllowedKeys(value, new Set(["type", "path", "branch"]));
    const worktreePath = stringField(value.path, "developmentContext.path", { required: true, maxLength: 4096 });
    if (worktreePath.includes("\0")) {
      throw new ApiError(400, "INVALID_FIELD", "'developmentContext.path' cannot contain null bytes");
    }
    return {
      type: "worktree",
      path: worktreePath,
      branch: stringField(value.branch ?? null, "developmentContext.branch", { nullable: true, maxLength: 512 }),
    };
  }
  throw new ApiError(400, "INVALID_FIELD", "'developmentContext.type' must be branch or worktree");
}

function parseRecurrence(value) {
  if (value === null) return null;
  assertPlainObject(value);
  assertAllowedKeys(value, new Set(["interval", "unit"]));
  if (!Number.isSafeInteger(value.interval) || value.interval < 1 || value.interval > 365) {
    throw new ApiError(400, "INVALID_FIELD", "'recurrence.interval' must be an integer from 1 to 365");
  }
  if (!["day", "week", "month", "year"].includes(value.unit)) {
    throw new ApiError(400, "INVALID_FIELD", "'recurrence.unit' must be day, week, month, or year");
  }
  return { interval: value.interval, unit: value.unit };
}

function parseVersion(value) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new ApiError(400, "INVALID_FIELD", "'version' must be a positive integer");
  }
  return value;
}

function parseWorkflowVersion(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ApiError(400, "INVALID_FIELD", "'version' must be a non-negative integer");
  }
  return value;
}

function parseWorkflowWorkspace(value) {
  assertPlainObject(value);
  assertAllowedKeys(value, new Set(["version", "tabs", "activeWorkflowId", "snapshots"]));
  if (value.version !== 1) {
    throw new ApiError(400, "INVALID_FIELD", "'workspace.version' must be 1");
  }
  if (!Array.isArray(value.tabs) || value.tabs.length === 0 || value.tabs.length > 100) {
    throw new ApiError(400, "INVALID_FIELD", "'workspace.tabs' must contain 1 to 100 workflows");
  }
  const tabs = value.tabs.map((tab, index) => {
    assertPlainObject(tab);
    assertAllowedKeys(tab, new Set(["id", "name"]));
    return {
      id: stringField(tab.id, `workspace.tabs[${index}].id`, { required: true, maxLength: 128 }),
      name: stringField(tab.name, `workspace.tabs[${index}].name`, { required: true, maxLength: 120 }),
    };
  });
  if (new Set(tabs.map((tab) => tab.id)).size !== tabs.length) {
    throw new ApiError(400, "INVALID_FIELD", "'workspace.tabs' ids must be unique");
  }
  const activeWorkflowId = stringField(value.activeWorkflowId, "workspace.activeWorkflowId", {
    required: true,
    maxLength: 128,
  });
  if (!tabs.some((tab) => tab.id === activeWorkflowId)) {
    throw new ApiError(400, "INVALID_FIELD", "'workspace.activeWorkflowId' must reference a workflow tab");
  }
  assertPlainObject(value.snapshots);
  const snapshots = {};
  for (const tab of tabs) {
    const snapshot = value.snapshots[tab.id];
    assertPlainObject(snapshot);
    assertAllowedKeys(snapshot, new Set(["nodes", "edges", "flow", "selectedNodeId"]));
    if (!Array.isArray(snapshot.nodes) || snapshot.nodes.length > 10_000) {
      throw new ApiError(400, "INVALID_FIELD", `'workspace.snapshots.${tab.id}.nodes' must be an array`);
    }
    if (snapshot.flow === undefined && (!Array.isArray(snapshot.edges) || snapshot.edges.length > 20_000)) {
      throw new ApiError(400, "INVALID_FIELD", `'workspace.snapshots.${tab.id}.edges' must be an array`);
    }
    if (snapshot.flow !== undefined && snapshot.edges !== undefined) {
      throw new ApiError(400, "INVALID_FIELD", `'workspace.snapshots.${tab.id}' cannot contain both 'flow' and 'edges'`);
    }
    const selectedNodeId = stringField(
      snapshot.selectedNodeId ?? null,
      `workspace.snapshots.${tab.id}.selectedNodeId`,
      { nullable: true, maxLength: 256 },
    );
    try {
      snapshots[tab.id] = normalizeWorkflowSnapshot({
        nodes: snapshot.nodes,
        edges: snapshot.edges,
        flow: snapshot.flow,
        selectedNodeId,
      });
    } catch (error) {
      throw new ApiError(
        400,
        "INVALID_FIELD",
        `'workspace.snapshots.${tab.id}' is not a valid workflow: ${error.message}`,
      );
    }
  }
  return { version: 1, tabs, activeWorkflowId, snapshots };
}

function parseWorkflowWorkspaceSave(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, new Set(["version", "workspace"]));
  return {
    version: parseWorkflowVersion(body.version),
    workspace: parseWorkflowWorkspace(body.workspace),
  };
}

function parseSortOrder(value) {
  if (typeof value !== "number" || !Number.isFinite(value) || Math.abs(value) > 1_000_000_000_000) {
    throw new ApiError(400, "INVALID_FIELD", "'sortOrder' must be a finite number between -1000000000000 and 1000000000000");
  }
  return value;
}

function parseLabels(value) {
  if (!Array.isArray(value) || value.length > 20) {
    throw new ApiError(400, "INVALID_FIELD", "'labels' must be an array with at most 20 entries");
  }
  const labels = value.map((label) => {
    if (typeof label !== "string") {
      throw new ApiError(400, "INVALID_FIELD", "Every label must be a string");
    }
    const normalized = label.trim();
    if (normalized.length === 0 || normalized.length > 64) {
      throw new ApiError(400, "INVALID_FIELD", "Labels must contain 1 to 64 characters");
    }
    return normalized;
  });
  if (new Set(labels).size !== labels.length) {
    throw new ApiError(400, "INVALID_FIELD", "Labels must be unique");
  }
  return labels;
}

function parseStatus(value, fallback) {
  const result = value ?? fallback;
  if (!isTaskStatus(result)) {
    throw new ApiError(400, "INVALID_FIELD", `'status' must be one of: ${TASK_STATUSES.join(", ")}`);
  }
  return result;
}

function parsePriority(value, fallback) {
  const result = value ?? fallback;
  if (!isTaskPriority(result)) {
    throw new ApiError(400, "INVALID_FIELD", "'priority' must be none, urgent, high, medium, or low");
  }
  return result;
}

function slugify(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
}

function validateProjectId(value, { required = true } = {}) {
  const id = stringField(value, "id", { required, maxLength: 64 });
  if (id !== undefined && !PROJECT_ID_PATTERN.test(id)) {
    throw new ApiError(400, "INVALID_FIELD", "'id' must be a lowercase slug containing letters, numbers, or hyphens");
  }
  return id;
}

function parseProjectCreate(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, new Set(["id", "name", "workspacePath"]));
  const name = stringField(body.name, "name", { required: true, maxLength: 120 });
  const id = validateProjectId(body.id ?? slugify(name));
  if (!id) {
    throw new ApiError(400, "INVALID_FIELD", "Project name must contain at least one letter or number when 'id' is omitted");
  }
  const workspacePath = stringField(body.workspacePath ?? null, "workspacePath", { nullable: true, maxLength: 4096 });
  if (workspacePath === "") {
    throw new ApiError(400, "INVALID_FIELD", "'workspacePath' cannot be empty");
  }
  if (workspacePath?.includes("\0")) {
    throw new ApiError(400, "INVALID_FIELD", "'workspacePath' cannot contain null bytes");
  }
  return { id, name, workspacePath };
}

function parseThreadId(value) {
  if (value === undefined) return undefined;
  const raw = stringField(value, "threadId", { required: true, maxLength: 256 });
  const threadId = normalizeCodexThreadId(raw);
  if (!threadId) {
    throw new ApiError(400, "INVALID_FIELD", "'threadId' must be a finalized Codex UUID");
  }
  return threadId;
}

function requestHeader(request, name) {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function actorFromRequest(request) {
  if (request.headers["x-taskboard-client"] === "taskctl") {
    const runtime = requestHeader(request, "x-taskboard-agent-runtime");
    if (runtime === "claude") return CLAUDE_AGENT_ACTOR;
    if (runtime === "omp") return OMP_AGENT_ACTOR;
    return CODEX_AGENT_ACTOR;
  }

  const rawId = requestHeader(request, "x-taskboard-user-id");
  const rawName = requestHeader(request, "x-taskboard-user-name");
  const rawAvatarUrl = requestHeader(request, "x-taskboard-user-avatar");
  if (rawId === undefined && rawName === undefined && rawAvatarUrl === undefined) {
    return { type: "user", id: "local-user", name: "本地用户", avatarUrl: null };
  }
  if (rawId === undefined || rawName === undefined) {
    throw new ApiError(400, "INVALID_ACTOR", "User identity requires both an ID and name");
  }

  const id = stringField(rawId, "X-Taskboard-User-Id", { required: true, maxLength: 96 });
  if (!/^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/.test(id)) {
    throw new ApiError(400, "INVALID_ACTOR", "User ID contains unsupported characters");
  }
  let decodedName;
  try {
    decodedName = decodeURIComponent(rawName);
  } catch {
    throw new ApiError(400, "INVALID_ACTOR", "User name is not valid URL-encoded text");
  }
  const name = stringField(decodedName, "X-Taskboard-User-Name", { required: true, maxLength: 120 });

  let avatarUrl = null;
  if (rawAvatarUrl !== undefined) {
    const value = stringField(rawAvatarUrl, "X-Taskboard-User-Avatar", { required: true, maxLength: 2048 });
    let parsed;
    try {
      parsed = new URL(value);
    } catch {
      throw new ApiError(400, "INVALID_ACTOR", "User avatar URL is invalid");
    }
    if (!["http:", "https:"].includes(parsed.protocol)) {
      throw new ApiError(400, "INVALID_ACTOR", "User avatar URL must use HTTP or HTTPS");
    }
    avatarUrl = parsed.toString();
  }
  return { type: "user", id, name, avatarUrl };
}

function parseAssigneeTarget(value) {
  if (value === undefined) return undefined;
  if (value !== "current-user" && value !== "codex-agent" && value !== "claude-agent" && value !== "omp-agent") {
    throw new ApiError(400, "INVALID_FIELD", "'assigneeTarget' must be current-user, codex-agent, claude-agent or omp-agent");
  }
  return value;
}

function resolveAssignee(target, actor) {
  if (target === undefined) return actor;
  if (target === "codex-agent") return CODEX_AGENT_ACTOR;
  if (target === "claude-agent") return CLAUDE_AGENT_ACTOR;
  if (target === "omp-agent") return OMP_AGENT_ACTOR;
  if (actor.type !== "user") {
    throw new ApiError(400, "INVALID_FIELD", "'current-user' requires a user request identity");
  }
  return actor;
}

function parseWorkflowId(value) {
  const workflowId = stringField(value, "workflowId", { nullable: true, maxLength: 128 });
  if (workflowId === "") {
    throw new ApiError(400, "INVALID_FIELD", "'workflowId' cannot be empty");
  }
  return workflowId;
}

function parseRuntime(value) {
  if (value === undefined) return undefined;
  if (value !== "codex" && value !== "claude" && value !== "omp") {
    throw new ApiError(400, "INVALID_FIELD", "'runtime' must be 'codex', 'claude' or 'omp'");
  }
  return value;
}

function parseTaskCreate(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, new Set([
    "projectId", "title", "description", "status", "priority", "labels", "sortOrder", "threadId",
    "runtime", "assigneeTarget", "workflowId", "developmentContext", "startDate", "dueDate", "recurrence",
  ]));
  const projectId = validateProjectId(body.projectId ?? DEFAULT_PROJECT_ID);
  const task = {
    projectId,
    title: stringField(body.title, "title", { required: true, maxLength: 240 }),
    description: stringField(body.description ?? "", "description", { maxLength: 100_000 }),
    status: parseStatus(body.status, "todo"),
    priority: parsePriority(body.priority, "none"),
    labels: body.labels === undefined ? [] : parseLabels(body.labels),
    sortOrder: body.sortOrder === undefined ? undefined : parseSortOrder(body.sortOrder),
    threadId: parseThreadId(body.threadId),
    runtime: parseRuntime(body.runtime) ?? "codex",
    assigneeTarget: parseAssigneeTarget(body.assigneeTarget),
    workflowId: parseWorkflowId(body.workflowId ?? null),
    developmentContext: parseDevelopmentContext(body.developmentContext ?? null),
    startDate: parseDueDate(body.startDate ?? null, "startDate"),
    dueDate: parseDueDate(body.dueDate ?? null),
    recurrence: parseRecurrence(body.recurrence ?? null),
  };
  if (task.recurrence && !task.dueDate) {
    throw new ApiError(400, "INVALID_FIELD", "A recurring issue requires 'dueDate'");
  }
  return task;
}

function parseTaskPatch(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, new Set([
    "version", "title", "description", "status", "priority", "labels", "threadId",
    "runtime", "assigneeTarget", "workflowId", "developmentContext", "startDate", "dueDate", "recurrence",
  ]));
  const version = parseVersion(body.version);
  const threadId = parseThreadId(body.threadId);
  const assigneeTarget = parseAssigneeTarget(body.assigneeTarget);
  const runtime = parseRuntime(body.runtime);
  const changes = {};
  if (body.title !== undefined) changes.title = stringField(body.title, "title", { required: true, maxLength: 240 });
  if (body.description !== undefined) changes.description = stringField(body.description, "description", { maxLength: 100_000 });
  if (body.status !== undefined) changes.status = parseStatus(body.status);
  if (body.priority !== undefined) changes.priority = parsePriority(body.priority);
  if (body.labels !== undefined) changes.labels = parseLabels(body.labels);
  if (body.workflowId !== undefined) changes.workflowId = parseWorkflowId(body.workflowId);
  if (body.developmentContext !== undefined) changes.developmentContext = parseDevelopmentContext(body.developmentContext);
  if (body.startDate !== undefined) changes.startDate = parseDueDate(body.startDate, "startDate");
  if (body.dueDate !== undefined) changes.dueDate = parseDueDate(body.dueDate);
  if (body.recurrence !== undefined) changes.recurrence = parseRecurrence(body.recurrence);
  if (runtime !== undefined) changes.runtime = runtime;
  if (changes.recurrence && body.dueDate === null) {
    throw new ApiError(400, "INVALID_FIELD", "A recurring issue requires 'dueDate'");
  }
  if (Object.keys(changes).length === 0 && assigneeTarget === undefined && threadId === undefined) {
    throw new ApiError(400, "INVALID_BODY", "PATCH requires at least one task field");
  }
  return { version, changes, threadId, assigneeTarget };
}

function parseMove(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, new Set(["version", "status", "sortOrder", "threadId"]));
  return {
    version: parseVersion(body.version),
    status: parseStatus(body.status),
    sortOrder: body.sortOrder === undefined ? undefined : parseSortOrder(body.sortOrder),
    threadId: parseThreadId(body.threadId),
  };
}

function parseTaskTransfer(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, new Set(["version", "projectId", "threadId"]));
  return {
    version: parseVersion(body.version),
    projectId: validateProjectId(body.projectId),
    threadId: parseThreadId(body.threadId),
  };
}

function parseArchive(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, new Set(["version", "threadId"]));
  return { version: parseVersion(body.version), threadId: parseThreadId(body.threadId) };
}

function parseTaskThreadDelete(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, new Set(["version"]));
  return { version: parseVersion(body.version) };
}

function parseConnectorRuntime(value) {
  if (value === undefined) {
    throw new ApiError(400, "INVALID_FIELD", "'runtime' is required");
  }
  if (value !== "claude" && value !== "omp") {
    throw new ApiError(400, "INVALID_FIELD", "'runtime' must be 'claude' or 'omp' (codex not supported)");
  }
  return value;
}

function parseConnectorCustomHeaders(value) {
  if (value === undefined) return undefined;
  if (value === null) return null;
  assertPlainObject(value);
  const result = {};
  for (const [key, raw] of Object.entries(value)) {
    result[stringField(key, "customHeaders key", { required: true, maxLength: 120 })] =
      stringField(raw, "customHeaders value", { required: true, maxLength: 1024 });
  }
  return result;
}

function parseConnectorCreate(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, new Set([
    "name", "runtime", "baseUrl", "apiKey", "model", "customHeaders",
    "executable", "isDefault", "sortOrder",
  ]));
  const runtime = parseConnectorRuntime(body.runtime);
  const name = stringField(body.name, "name", { required: true, maxLength: 120 });
  const baseUrl = stringField(body.baseUrl ?? null, "baseUrl", { nullable: true, maxLength: 2048 });
  const apiKey = stringField(body.apiKey ?? null, "apiKey", { nullable: true, maxLength: 512 });
  const model = stringField(body.model ?? null, "model", { nullable: true, maxLength: 120 });
  const executable = stringField(body.executable ?? null, "executable", { nullable: true, maxLength: 4096 });
  const customHeaders = parseConnectorCustomHeaders(body.customHeaders);
  const isDefault = body.isDefault === undefined ? false : Boolean(body.isDefault);
  const sortOrder = body.sortOrder === undefined ? 0 : parseSortOrder(body.sortOrder);
  return { name, runtime, baseUrl, apiKey, model, customHeaders, executable, isDefault, sortOrder };
}

function parseConnectorPatch(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, new Set([
    "version", "name", "baseUrl", "apiKey", "model", "customHeaders",
    "executable", "isDefault", "sortOrder",
  ]));
  const version = parseVersion(body.version);
  const changes = {};
  if (body.name !== undefined) {
    changes.name = stringField(body.name, "name", { required: true, maxLength: 120 });
  }
  if (body.baseUrl !== undefined) {
    changes.baseUrl = stringField(body.baseUrl ?? null, "baseUrl", { nullable: true, maxLength: 2048 });
  }
  if (body.apiKey !== undefined) {
    changes.apiKey = stringField(body.apiKey ?? null, "apiKey", { nullable: true, maxLength: 512 });
  }
  if (body.model !== undefined) {
    changes.model = stringField(body.model ?? null, "model", { nullable: true, maxLength: 120 });
  }
  if (body.executable !== undefined) {
    changes.executable = stringField(body.executable ?? null, "executable", { nullable: true, maxLength: 4096 });
  }
  if (body.customHeaders !== undefined) changes.customHeaders = parseConnectorCustomHeaders(body.customHeaders);
  if (body.isDefault !== undefined) changes.isDefault = Boolean(body.isDefault);
  if (body.sortOrder !== undefined) changes.sortOrder = parseSortOrder(body.sortOrder);
  if (Object.keys(changes).length === 0) {
    throw new ApiError(400, "INVALID_BODY", "PATCH requires at least one connector field");
  }
  return { version, changes };
}

function parseConnectorVersionBody(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, new Set(["version"]));
  return { version: parseVersion(body.version) };
}

function parseIssueRelationType(value) {
  if (!["parent", "blocks", "blocked_by", "related"].includes(value)) {
    throw new ApiError(
      400,
      "INVALID_FIELD",
      "'relation type' must be parent, blocks, blocked_by, or related",
    );
  }
  return value;
}

function parseCommentCreate(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, new Set(["body", "threadId"]));
  return {
    body: stringField(body.body ?? "", "body", { maxLength: 100_000 }),
    threadId: parseThreadId(body.threadId),
  };
}

function parseCommentPatch(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, new Set(["version", "body", "threadId"]));
  if (body.body === undefined) {
    throw new ApiError(400, "INVALID_FIELD", "'body' is required");
  }
  return {
    version: parseVersion(body.version),
    body: stringField(body.body, "body", { maxLength: 100_000 }),
    threadId: body.threadId === null ? null : parseThreadId(body.threadId),
  };
}

function parseAttachmentHeaders(request) {
  const encodedFilename = request.headers["x-taskboard-filename"];
  if (typeof encodedFilename !== "string") {
    throw new ApiError(400, "INVALID_FILENAME", "X-Taskboard-Filename is required");
  }
  let filename;
  try {
    filename = decodeURIComponent(encodedFilename).trim();
  } catch {
    throw new ApiError(400, "INVALID_FILENAME", "Attachment filename contains invalid encoding");
  }
  if (
    filename.length === 0
    || filename.length > 240
    || filename === "."
    || filename === ".."
    || /[\u0000-\u001f\u007f/\\]/.test(filename)
  ) {
    throw new ApiError(400, "INVALID_FILENAME", "Attachment filename is invalid");
  }

  const rawContentType = request.headers["content-type"];
  const contentType = typeof rawContentType === "string"
    ? rawContentType.split(";", 1)[0].trim().toLowerCase()
    : "application/octet-stream";
  if (contentType.length === 0 || contentType.length > 200 || !/^[!#$%&'*+.^_`|~0-9a-z-]+\/[!#$%&'*+.^_`|~0-9a-z-]+$/.test(contentType)) {
    throw new ApiError(415, "UNSUPPORTED_MEDIA_TYPE", "Attachment Content-Type is invalid");
  }
  return { filename, contentType };
}

async function readBody(request, limit, tooLargeMessage) {
  const declaredLength = Number(request.headers["content-length"] ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > limit) {
    throw new ApiError(413, "BODY_TOO_LARGE", tooLargeMessage);
  }

  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > limit) {
      throw new ApiError(413, "BODY_TOO_LARGE", tooLargeMessage);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readJson(
  request,
  limit = JSON_BODY_LIMIT,
  tooLargeMessage = "Request body cannot exceed 1 MiB",
) {
  const contentType = request.headers["content-type"]?.split(";", 1)[0].trim().toLowerCase();
  if (contentType !== "application/json") {
    throw new ApiError(415, "UNSUPPORTED_MEDIA_TYPE", "Content-Type must be application/json");
  }
  const body = await readBody(request, limit, tooLargeMessage);
  const length = body.length;
  if (length === 0) {
    throw new ApiError(400, "INVALID_JSON", "Request body cannot be empty");
  }
  try {
    return JSON.parse(body.toString("utf8"));
  } catch {
    throw new ApiError(400, "INVALID_JSON", "Request body must contain valid JSON");
  }
}

async function assertEmptyRequestBody(request, routeLabel) {
  const body = await readBody(request, JSON_BODY_LIMIT, "Request body cannot exceed 1 MiB");
  if (body.length > 0) {
    throw new ApiError(400, "INVALID_BODY", `${routeLabel} does not accept a request body`);
  }
}

function parseTaskFilters(searchParams) {
  const allowed = new Set(["projectId", "status", "archived"]);
  for (const key of searchParams.keys()) {
    if (!allowed.has(key)) {
      throw new ApiError(400, "UNKNOWN_QUERY_PARAMETER", `Unknown query parameter '${key}'`);
    }
    if (searchParams.getAll(key).length !== 1) {
      throw new ApiError(400, "INVALID_QUERY_PARAMETER", `Query parameter '${key}' cannot be repeated`);
    }
  }

  const projectIdValue = searchParams.get("projectId");
  const statusValue = searchParams.get("status");
  const archived = searchParams.get("archived") ?? "all";
  if (statusValue !== null && !isTaskStatus(statusValue)) {
    throw new ApiError(400, "INVALID_QUERY_PARAMETER", "Invalid task status");
  }
  if (!new Set(["true", "false", "all"]).has(archived)) {
    throw new ApiError(400, "INVALID_QUERY_PARAMETER", "'archived' must be true, false, or all");
  }
  const projectId = projectIdValue === null ? undefined : validateProjectId(projectIdValue);
  return { projectId, status: statusValue ?? undefined, archived };
}

function parseKnowledgeContext(value) {
  if (value === undefined || value === null) return null;
  assertPlainObject(value);
  assertAllowedKeys(value, new Set(["type", "branch"]));
  if (value.type !== "branch" && value.type !== "worktree") {
    throw new ApiError(400, "INVALID_FIELD", "Knowledge development context must be branch or worktree");
  }
  const branch = stringField(value.branch ?? null, "branch", { nullable: true, maxLength: 512 });
  if (value.type === "branch" && !branch) {
    throw new ApiError(400, "INVALID_FIELD", "Branch knowledge context requires a branch name");
  }
  return { type: value.type, branch };
}

function parseKnowledgeSourceSnapshot(value) {
  if (value === undefined) return {};
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError(400, "INVALID_FIELD", "Knowledge source snapshot must be an object");
  }
  return value;
}

function knowledgeTextField(value, name, { nullable = false, maxLength } = {}) {
  if (nullable && value === null) return null;
  if (typeof value !== "string") {
    throw new ApiError(400, "INVALID_FIELD", `'${name}' must be a string${nullable ? " or null" : ""}`);
  }
  if (value.length > maxLength) {
    throw new ApiError(400, "INVALID_FIELD", `'${name}' cannot exceed ${maxLength} characters`);
  }
  return value;
}

function parseKnowledgeChanges(value) {
  if (!Array.isArray(value) || value.length > 50) {
    throw new ApiError(400, "INVALID_FIELD", "Knowledge changes must contain at most 50 items");
  }
  return value.map((change, index) => {
    assertPlainObject(change);
    assertAllowedKeys(change, new Set([
      "id", "proposalId", "targetPath", "operation", "baseDigest",
      "beforeContent", "afterContent", "sortOrder",
    ]));
    const targetPath = knowledgeInternals.normalizeRelativePath(change.targetPath);
    if (!knowledgeInternals.isAllowedTarget(targetPath)) {
      throw new ApiError(400, "INVALID_KNOWLEDGE_PATH", `Knowledge target '${targetPath}' is not allowed`);
    }
    if (!["create", "update", "delete"].includes(change.operation)) {
      throw new ApiError(400, "INVALID_FIELD", "Knowledge operation must be create, update or delete");
    }
    const beforeContent = knowledgeTextField(change.beforeContent ?? null, "beforeContent", {
      nullable: true,
      maxLength: 1024 * 1024,
    });
    const afterContent = knowledgeTextField(change.afterContent ?? null, "afterContent", {
      nullable: true,
      maxLength: 1024 * 1024,
    });
    if (change.operation !== "delete" && !afterContent) {
      throw new ApiError(400, "INVALID_FIELD", "Create and update changes require afterContent");
    }
    return {
      id: stringField(change.id ?? randomUUID(), "changeId", { required: true, maxLength: 128 }),
      targetPath,
      operation: change.operation,
      baseDigest: stringField(change.baseDigest ?? null, "baseDigest", { nullable: true, maxLength: 256 }),
      beforeContent,
      afterContent: change.operation === "delete" ? null : afterContent,
      sortOrder: Number.isSafeInteger(change.sortOrder) ? change.sortOrder : index,
    };
  });
}

function parseKnowledgeProposalCreate(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, new Set([
    "id", "title", "sourceType", "sourceSnapshot", "developmentContext",
    "status", "summary", "error", "changes",
  ]));
  const sourceType = stringField(body.sourceType, "sourceType", { required: true, maxLength: 64 });
  if (!["project_scan", "issue", "comments", "question", "stale_refresh", "project_review"].includes(sourceType)) {
    throw new ApiError(400, "INVALID_FIELD", "Unknown knowledge proposal source type");
  }
  const status = stringField(body.status ?? "ready", "status", { required: true, maxLength: 32 });
  if (!["generating", "ready", "failed"].includes(status)) {
    throw new ApiError(400, "INVALID_FIELD", "New knowledge proposals must be generating, ready or failed");
  }
  return {
    id: stringField(body.id ?? randomUUID(), "id", { required: true, maxLength: 128 }),
    title: stringField(body.title, "title", { required: true, maxLength: 240 }),
    sourceType,
    sourceSnapshot: parseKnowledgeSourceSnapshot(body.sourceSnapshot),
    developmentContext: parseKnowledgeContext(body.developmentContext),
    status,
    summary: stringField(body.summary ?? "", "summary", { maxLength: 20_000 }),
    error: stringField(body.error ?? null, "error", { nullable: true, maxLength: 65_536 }),
    changes: parseKnowledgeChanges(body.changes ?? []),
  };
}

function parseKnowledgeProposalPatch(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, new Set(["version", "title", "summary", "status", "error", "changes"]));
  const changes = {};
  if (body.title !== undefined) changes.title = stringField(body.title, "title", { required: true, maxLength: 240 });
  if (body.summary !== undefined) changes.summary = stringField(body.summary, "summary", { maxLength: 20_000 });
  if (body.error !== undefined) changes.error = stringField(body.error, "error", { nullable: true, maxLength: 65_536 });
  if (body.status !== undefined) {
    const status = stringField(body.status, "status", { required: true, maxLength: 32 });
    if (!["generating", "ready", "published", "rejected", "failed"].includes(status)) {
      throw new ApiError(400, "INVALID_FIELD", "Unknown knowledge proposal status");
    }
    changes.status = status;
  }
  if (body.changes !== undefined) changes.changes = parseKnowledgeChanges(body.changes);
  return { version: parseVersion(body.version), changes };
}

function parseQuestionnaireCreate(body) {
  assertPlainObject(body); assertAllowedKeys(body, new Set(["scopeType", "scopeRef", "title", "questions"]));
  const scopeType = stringField(body.scopeType, "scopeType", { required: true, maxLength: 16 });
  if (!["project", "page", "gap"].includes(scopeType)) throw new ApiError(400, "INVALID_FIELD", "Unknown questionnaire scope");
  if (!Array.isArray(body.questions) || body.questions.length < 1 || body.questions.length > 30) throw new ApiError(400, "INVALID_FIELD", "questions must contain 1 to 30 items");
  return { scopeType, scopeRef: stringField(body.scopeRef ?? null, "scopeRef", { nullable: true, maxLength: 4096 }), title: stringField(body.title, "title", { required: true, maxLength: 240 }), questions: body.questions.map((question) => {
    assertPlainObject(question); assertAllowedKeys(question, new Set(["context", "prompt", "gapReason", "checkedSources", "targetRole", "answerFormat", "knowledgeTarget"]));
    if (!Array.isArray(question.checkedSources) || question.checkedSources.length < 1) throw new ApiError(400, "MISSING_GAP_EVIDENCE", "Each question requires checkedSources");
    return { context: stringField(question.context, "context", { required: true, maxLength: 4000 }), prompt: stringField(question.prompt, "prompt", { required: true, maxLength: 4000 }), gapReason: stringField(question.gapReason, "gapReason", { required: true, maxLength: 4000 }), checkedSources: question.checkedSources.map((source) => stringField(source, "checkedSource", { required: true, maxLength: 1024 })), targetRole: stringField(question.targetRole, "targetRole", { required: true, maxLength: 240 }), answerFormat: stringField(question.answerFormat, "answerFormat", { required: true, maxLength: 1000 }), knowledgeTarget: stringField(question.knowledgeTarget, "knowledgeTarget", { required: true, maxLength: 1000 }) };
  }) };
}

class EventHub {
  constructor() {
    this.clients = new Set();
    this.keepAlive = setInterval(() => {
      for (const response of this.clients) response.write(": keep-alive\n\n");
    }, 20_000);
    this.keepAlive.unref();
  }

  connect(request, response) {
    response.writeHead(200, {
      connection: "keep-alive",
      "cache-control": "no-cache, no-transform",
      "content-type": "text/event-stream; charset=utf-8",
      "x-accel-buffering": "no",
    });
    response.write(": connected\n\n");
    this.clients.add(response);
    request.once("close", () => this.clients.delete(response));
  }

  emit(type, value) {
    const event = {
      type,
      projectId: value.projectId ?? value.project?.id ?? value.task?.projectId,
      taskId: value.task?.id ?? value.comment?.taskId ?? value.attachment?.taskId,
      ...value,
      at: new Date().toISOString(),
    };
    const message = `event: ${type}\ndata: ${JSON.stringify(event)}\n\n`;
    for (const response of this.clients) response.write(message);
  }

  close() {
    clearInterval(this.keepAlive);
    for (const response of this.clients) response.end();
    this.clients.clear();
  }
}

async function serveStatic(request, response, pathname, staticDirectory) {
  if (request.method !== "GET" && request.method !== "HEAD") return false;
  let decodedPath;
  try {
    decodedPath = decodeURIComponent(pathname);
  } catch {
    throw new ApiError(400, "INVALID_PATH", "URL path contains invalid encoding");
  }
  if (decodedPath.includes("\0")) {
    throw new ApiError(400, "INVALID_PATH", "URL path is invalid");
  }

  const root = path.resolve(staticDirectory);
  const relativePath = decodedPath === "/" ? "index.html" : decodedPath.replace(/^\/+/, "");
  let filename = path.resolve(root, relativePath);
  if (filename !== root && !filename.startsWith(`${root}${path.sep}`)) {
    throw new ApiError(400, "INVALID_PATH", "URL path is outside the static directory");
  }

  let fileStats;
  try {
    fileStats = await stat(filename);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (!fileStats?.isFile() && !path.extname(relativePath)) {
    filename = path.join(root, "index.html");
    try {
      fileStats = await stat(filename);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  if (!fileStats?.isFile()) return false;

  const body = await readFile(filename);
  const headers = {
    "cache-control": path.basename(filename) === "index.html" ? "no-cache" : "public, max-age=31536000, immutable",
    "content-length": body.length,
    "content-type": CONTENT_TYPES.get(path.extname(filename).toLowerCase()) ?? "application/octet-stream",
  };
  response.writeHead(200, headers);
  response.end(request.method === "HEAD" ? undefined : body);
  return true;
}

function methodNotAllowed(response, allowed) {
  sendJson(response, 405, {
    error: { code: "METHOD_NOT_ALLOWED", message: `Allowed methods: ${allowed.join(", ")}` },
  }, { allow: allowed.join(", ") });
}

function codexProjectRoot(state, projectId) {
  if (!projectId || !state || typeof state !== "object") return null;
  const project = state["local-projects"]?.[projectId];
  const root = Array.isArray(project?.rootPaths) ? project.rootPaths[0] : null;
  return typeof root === "string" && root.trim() ? root : null;
}

async function readCodexProjectWorkspaces(codexStatePath) {
  try {
    const state = JSON.parse(await readFile(codexStatePath, "utf8"));
    const projects = state["local-projects"];
    if (!projects || typeof projects !== "object" || Array.isArray(projects)) return {};
    return Object.fromEntries(Object.keys(projects).flatMap((projectId) => {
      const root = codexProjectRoot(state, projectId);
      return root ? [[projectId, root]] : [];
    }));
  } catch {
    return {};
  }
}

function latestThreadCwd(value, threadId) {
  const matches = [];
  const stack = [value];
  while (stack.length > 0) {
    const candidate = stack.pop();
    if (!candidate || typeof candidate !== "object") continue;
    if (candidate.conversationId === threadId && typeof candidate.cwd === "string" && candidate.cwd.trim()) {
      matches.push(candidate);
    }
    stack.push(...(Array.isArray(candidate) ? candidate : Object.values(candidate)));
  }
  matches.sort((left, right) => Number(right.updatedAtMs ?? 0) - Number(left.updatedAtMs ?? 0));
  return matches[0]?.cwd ?? null;
}

async function resolveProjectWorkspace(project, codexProjectId, codexThreadId, codexStatePath, codexProcessesPath) {
  try {
    const state = JSON.parse(await readFile(codexStatePath, "utf8"));
    const assignment = state["thread-project-assignments"]?.[codexThreadId];
    const root = codexProjectRoot(state, project.id)
      ?? codexProjectRoot(state, codexProjectId)
      ?? codexProjectRoot(state, assignment?.projectId)
      ?? (typeof assignment?.cwd === "string" ? assignment.cwd : null);
    if (root) return root;
  } catch {}
  if (project.workspacePath) return project.workspacePath;
  if (!codexThreadId) return null;
  try {
    const processes = JSON.parse(await readFile(codexProcessesPath, "utf8"));
    return latestThreadCwd(processes, codexThreadId);
  } catch {
    return null;
  }
}

function parseWorktrees(output) {
  const contexts = [];
  for (const block of output.trim().split(/\n\s*\n/)) {
    if (!block) continue;
    let worktreePath = "";
    let branch = null;
    for (const line of block.split("\n")) {
      if (line.startsWith("worktree ")) worktreePath = line.slice(9);
      if (line.startsWith("branch refs/heads/")) branch = line.slice(18);
    }
    if (worktreePath) contexts.push({ type: "worktree", path: worktreePath, branch });
  }
  return contexts;
}

async function scanDevelopmentContexts(workspacePath) {
  if (!workspacePath) return { workspacePath: null, contexts: [] };
  try {
    const rootResult = await execFileAsync("git", ["-C", workspacePath, "rev-parse", "--show-toplevel"], {
      timeout: 4_000,
      maxBuffer: 1024 * 1024,
    });
    const root = rootResult.stdout.trim();
    const [branchesResult, worktreesResult] = await Promise.all([
      execFileAsync("git", ["-C", root, "for-each-ref", "--format=%(refname:short)", "refs/heads"], {
        timeout: 4_000,
        maxBuffer: 1024 * 1024,
      }),
      execFileAsync("git", ["-C", root, "worktree", "list", "--porcelain"], {
        timeout: 4_000,
        maxBuffer: 1024 * 1024,
      }),
    ]);
    const branches = branchesResult.stdout.split("\n").map((branch) => branch.trim()).filter(Boolean);
    return {
      workspacePath: root,
      contexts: [
        ...branches.map((branch) => ({ type: "branch", branch })),
        ...parseWorktrees(worktreesResult.stdout),
      ],
    };
  } catch {
    return { workspacePath, contexts: [] };
  }
}

async function discoverSkills(codexExecutable, workspacePath) {
  const entries = await new Promise((resolve, reject) => {
    const child = spawn(codexExecutable, ["app-server", "--stdio"], {
      cwd: workspacePath,
      stdio: ["pipe", "pipe", "ignore"],
    });
    let settled = false;
    let buffer = "";
    const timeout = setTimeout(() => {
      finish(new Error("Timed out while reading Codex skills"));
    }, 10_000);

    function finish(error, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.stdin.end();
      child.kill("SIGTERM");
      if (error) reject(error);
      else resolve(value);
    }

    function send(message) {
      child.stdin.write(`${JSON.stringify(message)}\n`);
    }

    function handleMessage(message) {
      if (message?.id === 1) {
        if (message.error) {
          finish(new Error("Codex app-server rejected initialization"));
          return;
        }
        send({ method: "initialized" });
        send({
          id: 2,
          method: "skills/list",
          params: { cwds: [workspacePath], forceReload: false },
        });
        return;
      }
      if (message?.id !== 2) return;
      if (message.error) {
        finish(new Error("Codex app-server could not list skills"));
        return;
      }
      finish(null, Array.isArray(message.result?.data) ? message.result.data : []);
    }

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex >= 0) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        if (line) {
          try {
            handleMessage(JSON.parse(line));
          } catch {}
        }
        newlineIndex = buffer.indexOf("\n");
      }
    });
    child.stdin.on("error", (error) => finish(error));
    child.once("error", (error) => finish(error));
    child.once("exit", (code, signal) => {
      if (!settled) {
        finish(new Error(`Codex app-server exited before listing skills (${signal || code})`));
      }
    });
    child.once("spawn", () => {
      send({
        id: 1,
        method: "initialize",
        params: {
          clientInfo: { name: "codex-taskboard", version: "0.1.0" },
          capabilities: { experimentalApi: true },
        },
      });
    });
  });

  const unique = new Map();
  for (const entry of entries) {
    if (!Array.isArray(entry?.skills)) continue;
    for (const skill of entry.skills) {
      if (
        !skill
        || typeof skill !== "object"
        || skill.enabled === false
        || typeof skill.name !== "string"
        || !skill.name.trim()
      ) {
        continue;
      }
      const id = skill.name.trim();
      if (unique.has(id)) continue;
      const displayName = typeof skill.interface?.displayName === "string"
        ? skill.interface.displayName.trim()
        : "";
      unique.set(id, {
        id,
        label: displayName || id,
        description: typeof skill.description === "string" ? skill.description.trim() : "",
        path: typeof skill.path === "string" ? skill.path.trim() : "",
        scope: ["user", "repo", "system", "admin"].includes(skill.scope)
          ? skill.scope
          : "user",
      });
    }
  }
  return [...unique.values()].sort((left, right) => left.label.localeCompare(right.label));
}

async function discoverMcpServers(codexExecutable) {
  const result = await execFileAsync(codexExecutable, ["mcp", "list", "--json"], {
    timeout: 8_000,
    maxBuffer: 2 * 1024 * 1024,
  });
  const entries = JSON.parse(result.stdout);
  if (!Array.isArray(entries)) throw new Error("Codex returned an invalid MCP server list");
  return entries
    .filter((entry) => (
      entry
      && typeof entry === "object"
      && typeof entry.name === "string"
      && entry.name.trim()
      && entry.enabled !== false
    ))
    .map((entry) => ({
      id: entry.name.trim(),
      label: entry.name.trim(),
      transport: typeof entry.transport?.type === "string"
        ? entry.transport.type
        : "unknown",
    }))
    .sort((left, right) => left.label.localeCompare(right.label));
}

async function discoverWorkflowCapabilities(resolved, workspacePath) {
  const [skills, mcpServers] = await Promise.all([
    discoverSkills(resolved.codexExecutable, workspacePath),
    discoverMcpServers(resolved.codexExecutable),
  ]);
  return { skills, mcpServers };
}

export function resolveServerOptions(options = {}) {
  const configuredDataDirectory = options.dataDirectory ?? process.env.CODEX_TASKBOARD_DATA_DIR;
  const dataDirectory = configuredDataDirectory
    ? path.resolve(configuredDataDirectory)
    : path.join(PROJECT_ROOT, ".data");
  const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  return {
    dataDirectory,
    databasePath: options.databasePath ?? path.join(dataDirectory, "taskboard.sqlite"),
    attachmentsDirectory: options.attachmentsDirectory ?? path.join(dataDirectory, "attachments"),
    staticDirectory: options.staticDirectory ?? path.join(PROJECT_ROOT, "dist", "web"),
    skillPath: options.skillPath ?? path.join(PROJECT_ROOT, "skills", "manage-taskboard", "SKILL.md"),
    claudeExecutable: options.claudeExecutable ?? process.env.CLAUDE_EXECUTABLE ?? "claude",
    ompExecutable: options.ompExecutable ?? process.env.OMP_EXECUTABLE ?? "omp",
    codexExecutable: options.codexExecutable ?? process.env.CODEX_EXECUTABLE ?? "codex",
    codexStatePath: options.codexStatePath
      ?? path.join(codexHome, ".codex-global-state.json"),
    codexProcessesPath: options.codexProcessesPath
      ?? path.join(codexHome, "process_manager", "chat_processes.json"),
  };
}

export function resolvePort(value = process.env.CODEX_TASKBOARD_PORT ?? "47823") {
  const port = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("CODEX_TASKBOARD_PORT must be an integer between 1 and 65535");
  }
  return port;
}

export function resolveHost(value = process.env.CODEX_TASKBOARD_HOST ?? "0.0.0.0") {
  const host = String(value).trim();
  if (host !== "127.0.0.1" && host !== "0.0.0.0") {
    throw new Error("CODEX_TASKBOARD_HOST must be 127.0.0.1 or 0.0.0.0");
  }
  return host;
}

export function createTaskboardServer(options = {}) {
  const resolved = resolveServerOptions(options);
  const database = new TaskboardDatabase(resolved.databasePath);
  const events = new EventHub();
  const codexProcessEnvironment = withoutTaskboardLauncherEnvironment(
    options.processEnv ?? process.env,
  );

  const knowledge = options.knowledgeService ?? new KnowledgeService({
    codexExecutable: resolved.codexExecutable,
    processEnv: options.processEnv ?? process.env,
  });
  const claudeLauncher = createClaudeLauncher({
    dataDirectory: resolved.dataDirectory,
    claudeExecutable: resolved.claudeExecutable,
    skillSourceDir: path.join(PROJECT_ROOT, "skills", "manage-taskboard"),
  });
  // Ensure the manage-taskboard skill is discoverable by Claude Code. This only
  // manages the ~/.claude/skills/manage-taskboard symlink (idempotent, never
  // overwrites a foreign entry); it does not touch model, settings, keybindings,
  // or any other Claude Code configuration.
  claudeLauncher.ensureClaudeSkill();
  const ompLauncher = createOmpLauncher({
    dataDirectory: resolved.dataDirectory,
    ompExecutable: resolved.ompExecutable,
  });
  const knowledgeRuns = new Map();

  // Codex session plan-progress scanning (backported from upstream v0.2.3).
  // Reads the tail of ~/.codex/sessions/*-<threadId>.jsonl to derive plan step
  // completion. Returns null for non-codex threads (claude/omp have no such
  // session files), so it is safe to call for any thread id.
  const codexSessionSearches = new Map();
  const codexSessionStateCache = new Map();
  const codexSessionsDirectory = path.join(path.dirname(resolved.codexStatePath), "sessions");
  let hostRuntime = null;

  async function findCodexSession(threadId) {
    const cached = codexSessionSearches.get(threadId);
    if (cached && (cached.path || Date.now() - cached.checkedAt < 5_000)) return cached.path;

    const suffix = `-${threadId}.jsonl`;
    const directories = [codexSessionsDirectory];
    while (directories.length > 0) {
      const directory = directories.pop();
      let entries;
      try {
        entries = await readdir(directory, { withFileTypes: true });
      } catch (error) {
        if (error.code === "ENOENT") continue;
        throw error;
      }
      for (const entry of entries) {
        const entryPath = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          directories.push(entryPath);
        } else if (entry.isFile() && entry.name.endsWith(suffix)) {
          codexSessionSearches.set(threadId, { path: entryPath, checkedAt: Date.now() });
          return entryPath;
        }
      }
    }

    codexSessionSearches.set(threadId, { path: null, checkedAt: Date.now() });
    return null;
  }

  async function runtimeForThread(threadId, fallback = "codex") {
    if (await findCodexSession(threadId)) return "codex";
    for (const runtime of ["claude", "omp"]) {
      const scriptPath = path.join(resolved.dataDirectory, `${runtime}-runs`, `resume-${threadId}.sh`);
      try {
        const source = await readFile(scriptPath, "utf8");
        if (source.includes(`TASKBOARD_AGENT_RUNTIME='${runtime}'`)) return runtime;
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
    return fallback;
  }

  async function reconcileTaskThreadRuntimes(records) {
    for (const record of records) {
      const runtime = await runtimeForThread(record.thread_id, record.runtime ?? "codex");
      if (runtime !== record.runtime || record.thread_id === record.current_thread_id) {
        database.updateTaskThreadRuntime(record.task_id, record.thread_id, runtime);
      }
    }
  }

  async function listTasksWithResolvedRuntimes(filters) {
    await reconcileTaskThreadRuntimes(database.listTaskThreadRuntimeRecords(filters));
    return database.listTasks(filters);
  }

  async function getTaskWithResolvedRuntimes(id) {
    await reconcileTaskThreadRuntimes(database.getTaskThreadRuntimeRecords(id));
    return database.getTask(id);
  }

  async function readCodexSessionState(threadId) {
    const sessionPath = await findCodexSession(threadId);
    if (!sessionPath) return null;

    const sessionStat = await stat(sessionPath);
    const cached = codexSessionStateCache.get(sessionPath);
    if (cached?.size === sessionStat.size && cached.mtimeMs === sessionStat.mtimeMs) {
      return cached.state;
    }

    const length = Math.min(sessionStat.size, CODEX_PLAN_TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    const handle = await open(sessionPath, "r");
    try {
      await handle.read(buffer, 0, length, sessionStat.size - length);
    } finally {
      await handle.close();
    }

    const lines = buffer.toString("utf8").split("\n");
    if (length < sessionStat.size) lines.shift();
    const records = [];
    for (const line of lines) {
      try {
        records.push(JSON.parse(line));
      } catch {}
    }

    let runningTurnId = null;
    for (const record of records) {
      const payload = record?.payload;
      if (record?.type !== "event_msg" || typeof payload?.turn_id !== "string") continue;
      if (payload.type === "task_started") runningTurnId = payload.turn_id;
      if (
        (payload.type === "task_complete" || payload.type === "turn_aborted")
        && payload.turn_id === runningTurnId
      ) {
        runningTurnId = null;
      }
    }

    let progress = null;
    for (let index = records.length - 1; index >= 0; index -= 1) {
      const record = records[index];
      const payload = record?.payload;
      if (payload?.type !== "custom_tool_call" || typeof payload.input !== "string") continue;

      let statuses = [];
      if (payload.name === "update_plan") {
        try {
          const input = JSON.parse(payload.input);
          statuses = Array.isArray(input.plan)
            ? input.plan.map((item) => item?.status).filter(Boolean)
            : [];
        } catch {}
      } else if (payload.name === "exec") {
        const callIndex = payload.input.lastIndexOf("tools.update_plan(");
        if (callIndex < 0) continue;
        statuses = [...payload.input.slice(callIndex).matchAll(
          /["']?status["']?\s*:\s*["'](completed|in_progress|pending)["']/g,
        )].map((match) => match[1]);
      }

      if (statuses.length > 0) {
        progress = {
          completed: statuses.filter((status) => status === "completed").length,
          total: statuses.length,
        };
        break;
      }
    }

    const state = {
      completed: progress?.completed ?? null,
      total: progress?.total ?? null,
      running: runningTurnId !== null,
    };
    codexSessionStateCache.set(sessionPath, {
      size: sessionStat.size,
      mtimeMs: sessionStat.mtimeMs,
      state,
    });
    return state;
  }

  function knowledgeRun(runId, token) {
    const run = knowledgeRuns.get(runId);
    if (!run || run.expiresAt <= Date.now()) {
      knowledgeRuns.delete(runId);
      throw new ApiError(404, "KNOWLEDGE_RUN_NOT_FOUND", "Knowledge analysis run was not found");
    }
    if (typeof token !== "string" || token !== run.token) {
      throw new ApiError(403, "KNOWLEDGE_RUN_TOKEN_INVALID", "Knowledge analysis run token is invalid");
    }
    return run;
  }

  async function readDeviceProjectWorkspaces() {
    const localProjects = database.listProjects();
    const codexProjects = await readCodexProjectWorkspaces(resolved.codexStatePath);
    const workspaces = Object.fromEntries(localProjects
      .filter((project) => project.workspacePath)
      .map((project) => [project.id, project.workspacePath]));
    for (const [projectId, workspacePath] of Object.entries(codexProjects)) {
      if (!workspaces[projectId]) workspaces[projectId] = workspacePath;
    }
    return workspaces;
  }

  async function resolveKnowledgeWorkspace(projectId, requestedWorkspacePath) {
    const deviceWorkspaces = await readDeviceProjectWorkspaces();
    const dbProject = database.getProject(projectId);
    const project = dbProject
      ? { ...dbProject, workspacePath: deviceWorkspaces[projectId] ?? dbProject.workspacePath ?? null }
      : null;
    if (!project) {
      throw new ApiError(404, "PROJECT_NOT_FOUND", `Project '${projectId}' does not exist`);
    }
    if (!project.workspacePath) {
      throw new ApiError(409, "PROJECT_WORKSPACE_REQUIRED", "Map this project to a local workspace before using project knowledge");
    }
    const scan = await scanDevelopmentContexts(project.workspacePath);
    const allowed = new Set([
      path.resolve(project.workspacePath),
      ...(scan.workspacePath ? [path.resolve(scan.workspacePath)] : []),
      ...scan.contexts
        .filter((context) => context.type === "worktree")
        .map((context) => path.resolve(context.path)),
    ]);
    const selected = path.resolve(requestedWorkspacePath || scan.workspacePath || project.workspacePath);
    if (!allowed.has(selected)) {
      throw new ApiError(400, "INVALID_WORKSPACE_CONTEXT", "Knowledge workspace must match the project or one of its discovered worktrees");
    }
    return selected;
  }

  const server = createServer(async (request, response) => {
    response.setHeader("x-content-type-options", "nosniff");
    response.setHeader("referrer-policy", "no-referrer");
    try {
      assertTrustedNetworkRequest(request);
      const url = new URL(request.url, "http://127.0.0.1");
      const pathname = url.pathname;
      if (pathname.startsWith("/api/local/")) {
        assertLoopbackRequest(request);
      }
      if (pathname === "/health") {
        if (request.method !== "GET") return methodNotAllowed(response, ["GET"]);
        return sendJson(response, 200, { status: "ok" });
      }

      if (pathname === "/api/local/directory-picker") {
        if (request.method !== "POST") return methodNotAllowed(response, ["POST"]);
        assertNoQuery(url.searchParams, "POST /api/local/directory-picker");
        await assertEmptyRequestBody(request, "POST /api/local/directory-picker");
        return sendJson(response, 200, { workspacePath: await chooseLocalDirectory() });
      }

      const createKnowledgeRunRoute = pathname.match(
        /^\/api\/local\/projects\/([^/]+)\/knowledge-runs$/,
      );
      if (createKnowledgeRunRoute) {
        if (request.method !== "POST") return methodNotAllowed(response, ["POST"]);
        assertNoQuery(url.searchParams, "Create project knowledge analysis run");
        const projectId = validateProjectId(decodeRouteSegment(createKnowledgeRunRoute[1], "Project id"));
        const body = await readJson(request, KNOWLEDGE_BODY_LIMIT, "Knowledge run request is too large");
        assertPlainObject(body);
        assertAllowedKeys(body, new Set([
          "workspacePath", "sourceType", "sourceSnapshot", "developmentContext", "persist",
        ]));
        const workspacePath = await resolveKnowledgeWorkspace(
          projectId,
          stringField(body.workspacePath ?? null, "workspacePath", { nullable: true, maxLength: 4096 }),
        );
        const sourceType = stringField(body.sourceType, "sourceType", { required: true, maxLength: 64 });
        const sourceSnapshot = parseKnowledgeSourceSnapshot(body.sourceSnapshot);
        const developmentContext = parseKnowledgeContext(body.developmentContext);
        const persist = body.persist === true;
        const runId = randomUUID();
        const token = `${randomUUID()}${randomUUID()}`;
        const callbackUrl = `http://127.0.0.1:${request.socket.localPort}/api/local/knowledge-runs/${runId}/complete`;
        const run = {
          id: runId,
          token,
          projectId,
          workspacePath,
          sourceType,
          sourceSnapshot,
          developmentContext,
          persist,
          status: "waiting",
          proposal: null,
          expiresAt: Date.now() + 60 * 60 * 1000,
        };
        knowledgeRuns.set(runId, run);
        return sendJson(response, 201, {
          run: {
            id: runId,
            token,
            status: run.status,
            instruction: knowledge.knowledgeRunInstruction({
              sourceType,
              sourceSnapshot,
              workspacePath,
              callbackUrl,
              callbackToken: token,
            }),
          },
        });
      }

      const knowledgeRunRoute = pathname.match(/^\/api\/local\/knowledge-runs\/([^/]+)(?:\/(complete))?$/);
      if (knowledgeRunRoute) {
        assertNoQuery(url.searchParams, "Project knowledge analysis run");
        const runId = decodeRouteSegment(knowledgeRunRoute[1], "Knowledge run id");
        const token = request.headers["x-taskboard-knowledge-run-token"];
        const run = knowledgeRun(runId, Array.isArray(token) ? token[0] : token);
        if (knowledgeRunRoute[2] === "complete") {
          if (request.method !== "POST") return methodNotAllowed(response, ["POST"]);
          if (run.status === "completed") return sendJson(response, 200, { ok: true });
          const body = await readJson(request, KNOWLEDGE_BODY_LIMIT, "Knowledge analysis result is too large");
          assertPlainObject(body);
          assertAllowedKeys(body, new Set(["analysis", "error"]));
          if (body.error !== undefined) {
            run.error = stringField(body.error, "error", { required: true, maxLength: 20_000 });
            run.status = "failed";
            return sendJson(response, 200, { ok: true });
          }
          assertPlainObject(body.analysis);
          const proposal = await knowledge.prepareProposal(run.workspacePath, {
            sourceType: run.sourceType,
            sourceSnapshot: run.sourceSnapshot,
            developmentContext: run.developmentContext,
          }, body.analysis);
          run.proposal = run.persist
            ? database.createKnowledgeProposal({
              projectId: run.projectId,
              ...proposal,
              id: run.id,
              actor: CODEX_AGENT_ACTOR,
            })
            : { ...proposal, id: run.id };
          run.status = "completed";
          if (run.persist) {
            events.emit("knowledge-proposal.created", {
              projectId: run.projectId,
              proposal: run.proposal,
            });
          }
          return sendJson(response, 200, { ok: true });
        }
        if (request.method !== "GET") return methodNotAllowed(response, ["GET"]);
        return sendJson(response, 200, {
          run: {
            id: run.id,
            status: run.status,
            ...(run.proposal ? { proposal: run.proposal } : {}),
            ...(run.error ? { error: run.error } : {}),
          },
        });
      }

      const projectMappingRoute = pathname.match(/^\/api\/local\/project-mappings\/([^/]+)$/);
      if (projectMappingRoute) {
        if (request.method !== "PUT") return methodNotAllowed(response, ["PUT"]);
        if ([...url.searchParams.keys()].length > 0) {
          throw new ApiError(400, "UNKNOWN_QUERY_PARAMETER", "Project mapping routes do not accept query parameters");
        }
        let projectId;
        try {
          projectId = decodeURIComponent(projectMappingRoute[1]);
        } catch {
          throw new ApiError(400, "INVALID_PATH", "Project id contains invalid encoding");
        }
        validateProjectId(projectId);
        const body = await readJson(request);
        assertPlainObject(body);
        assertAllowedKeys(body, new Set(["workspacePath"]));
        const workspacePath = pathField(body.workspacePath, "workspacePath");
        if (!workspacePath || !path.isAbsolute(workspacePath)) {
          throw new ApiError(400, "INVALID_FIELD", "'workspacePath' must be absolute");
        }
        const project = database.setProjectWorkspace(projectId, workspacePath);
        events.emit("project.updated", { project });
        return sendJson(response, 200, { projectId, workspacePath });
      }

      if (pathname === "/api/meta") {
        if (request.method !== "GET") return methodNotAllowed(response, ["GET"]);
        if ([...url.searchParams.keys()].length > 0) {
          throw new ApiError(400, "UNKNOWN_QUERY_PARAMETER", "GET /api/meta does not accept query parameters");
        }
        return sendJson(response, 200, {
          manageTaskboardSkillPath: resolved.skillPath,
          projectKnowledgeSkillPath: path.join(
            PROJECT_ROOT,
            "skills",
            "project-knowledge-builder",
            "SKILL.md",
          ),
          claudeRuntime: claudeLauncher.supportedPlatform,
          ompRuntime: ompLauncher.supportedPlatform,
          connectors: database.listConnectors(),
          capabilities: {
            localKnowledge: isLoopbackAddress(request.socket.remoteAddress),
          },
        });
      }

      if (pathname === "/api/local/codex-thread-progress") {
        if (request.method !== "GET") return methodNotAllowed(response, ["GET"]);
        if ([...url.searchParams.keys()].some((key) => key !== "threadId")) {
          throw new ApiError(400, "UNKNOWN_QUERY_PARAMETER", "Only 'threadId' is supported");
        }
        const threadIds = [...new Set(
          url.searchParams.getAll("threadId")
            .map((value) => normalizeCodexThreadId(value))
            .filter((value) => value !== null),
        )];
        if (threadIds.length > 64) {
          throw new ApiError(400, "INVALID_FIELD", "'threadId' must contain valid Codex thread IDs");
        }
        const entries = await Promise.all(threadIds.map(async (threadId) => (
          [threadId, await readCodexSessionState(threadId)]
        )));
        return sendJson(response, 200, { progress: Object.fromEntries(entries) });
      }

      if (pathname === "/api/local/host-runtime") {
        if (request.method === "GET") {
          const runtime = hostRuntime && Date.now() - hostRuntime.updatedAt <= HOST_RUNTIME_TTL_MS
            ? hostRuntime
            : null;
          return sendJson(response, 200, { runtime });
        }
        if (request.method === "PUT") {
          const body = await readJson(request);
          assertPlainObject(body);
          assertAllowedKeys(body, new Set(["threadId", "threadRunning", "threadTodoProgress"]));
          const threadId = stringField(body.threadId, "threadId", { required: true, maxLength: 256 });
          if (typeof body.threadRunning !== "boolean") {
            throw new ApiError(400, "INVALID_FIELD", "'threadRunning' must be a boolean");
          }
          let threadTodoProgress = null;
          if (body.threadTodoProgress != null) {
            assertPlainObject(body.threadTodoProgress);
            assertAllowedKeys(body.threadTodoProgress, new Set(["completed", "total"]));
            const { completed, total } = body.threadTodoProgress;
            if (!Number.isInteger(completed) || !Number.isInteger(total) || completed < 0 || total < 1) {
              throw new ApiError(400, "INVALID_FIELD", "'threadTodoProgress' is invalid");
            }
            threadTodoProgress = { completed: Math.min(completed, total), total };
          }
          hostRuntime = {
            threadId,
            threadRunning: body.threadRunning,
            threadTodoProgress,
            updatedAt: Date.now(),
          };
          return sendJson(response, 200, { runtime: hostRuntime });
        }
        return methodNotAllowed(response, ["GET", "PUT"]);
      }

      const localKnowledgeRoute = pathname.match(
        /^\/api\/local\/projects\/([^/]+)\/knowledge(?:\/(pages|search|check|generate|ask|publish))?$/,
      );
      if (localKnowledgeRoute) {
        const projectId = validateProjectId(decodeRouteSegment(localKnowledgeRoute[1], "Project id"));
        const action = localKnowledgeRoute[2] ?? "overview";
        if (action === "overview") {
          if (request.method !== "GET") return methodNotAllowed(response, ["GET"]);
          assertAllowedQuery(url.searchParams, new Set(["workspacePath"]), "GET project knowledge");
          const workspacePath = await resolveKnowledgeWorkspace(
            projectId,
            stringField(url.searchParams.get("workspacePath") ?? null, "workspacePath", {
              nullable: true,
              maxLength: 4096,
            }),
          );
          return sendJson(response, 200, await knowledge.overview(workspacePath));
        }
        if (action === "pages") {
          if (request.method !== "GET") return methodNotAllowed(response, ["GET"]);
          assertAllowedQuery(url.searchParams, new Set(["workspacePath", "path"]), "GET project knowledge page");
          const workspacePath = await resolveKnowledgeWorkspace(
            projectId,
            stringField(url.searchParams.get("workspacePath") ?? null, "workspacePath", {
              nullable: true,
              maxLength: 4096,
            }),
          );
          const pagePath = stringField(url.searchParams.get("path") ?? "", "path", {
            required: true,
            maxLength: 4096,
          });
          return sendJson(response, 200, await knowledge.readPage(workspacePath, pagePath));
        }
        if (action === "search") {
          if (request.method !== "GET") return methodNotAllowed(response, ["GET"]);
          assertAllowedQuery(url.searchParams, new Set(["workspacePath", "q"]), "GET project knowledge search");
          const workspacePath = await resolveKnowledgeWorkspace(
            projectId,
            stringField(url.searchParams.get("workspacePath") ?? null, "workspacePath", {
              nullable: true,
              maxLength: 4096,
            }),
          );
          const query = stringField(url.searchParams.get("q") ?? "", "q", { required: true, maxLength: 200 });
          return sendJson(response, 200, { results: await knowledge.search(workspacePath, query) });
        }
        if (request.method !== "POST") return methodNotAllowed(response, ["POST"]);
        const body = await readJson(
          request,
          KNOWLEDGE_BODY_LIMIT,
          "Knowledge requests cannot exceed 6 MiB",
        );
        assertPlainObject(body);
        const requestedWorkspace = stringField(body.workspacePath ?? null, "workspacePath", {
          nullable: true,
          maxLength: 4096,
        });
        const workspacePath = await resolveKnowledgeWorkspace(projectId, requestedWorkspace);
        if (action === "check") {
          assertAllowedKeys(body, new Set(["workspacePath", "sourceVersions"]));
          const sourceVersions = body.sourceVersions ?? {};
          if (sourceVersions === null || typeof sourceVersions !== "object" || Array.isArray(sourceVersions)) {
            throw new ApiError(400, "INVALID_FIELD", "sourceVersions must be an object");
          }
          return sendJson(response, 200, await knowledge.overview(workspacePath, sourceVersions));
        }
        if (action === "generate") {
          assertAllowedKeys(body, new Set([
            "workspacePath", "sourceType", "sourceSnapshot", "developmentContext",
          ]));
          const sourceType = stringField(body.sourceType, "sourceType", { required: true, maxLength: 64 });
          const proposal = await knowledge.generateProposal(workspacePath, {
            sourceType,
            sourceSnapshot: parseKnowledgeSourceSnapshot(body.sourceSnapshot),
            developmentContext: parseKnowledgeContext(body.developmentContext),
          });
          return sendJson(response, 200, { proposal });
        }
        if (action === "ask") {
          assertAllowedKeys(body, new Set(["workspacePath", "question"]));
          const question = knowledgeTextField(body.question, "question", { maxLength: 20_000 });
          return sendJson(response, 200, await knowledge.ask(workspacePath, question));
        }
        if (action === "publish") {
          assertAllowedKeys(body, new Set(["workspacePath", "proposal"]));
          assertPlainObject(body.proposal);
          assertAllowedKeys(body.proposal, new Set(["id", "version", "changes"]));
          const receipt = await knowledge.publish(workspacePath, {
            id: stringField(body.proposal.id, "proposalId", { required: true, maxLength: 128 }),
            version: parseVersion(body.proposal.version),
            changes: parseKnowledgeChanges(body.proposal.changes),
          });
          return sendJson(response, 200, { receipt });
        }
      }

      if (pathname === "/api/local/claude/session") {
        assertNoQuery(url.searchParams, "/api/local/claude/session");
        if (request.method !== "POST") return methodNotAllowed(response, ["POST"]);
        const body = await readJson(request);
        assertPlainObject(body);
        assertAllowedKeys(body, new Set(["taskId", "workspacePath", "instruction", "requestId", "commentId"]));
        const taskId = stringField(body.taskId, "taskId", { required: true, maxLength: 128 });
        const workspacePath = stringField(body.workspacePath, "workspacePath", { required: true, maxLength: 4096 });
        if (!path.isAbsolute(workspacePath) || workspacePath.includes("\0")) {
          throw new ApiError(400, "INVALID_FIELD", "'workspacePath' must be an absolute local path");
        }
        const home = os.homedir();
        const resolvedWorkspace = path.resolve(workspacePath);
        if (resolvedWorkspace !== home && !resolvedWorkspace.startsWith(`${home}/`)) {
          throw new ApiError(400, "INVALID_FIELD", "'workspacePath' must be inside the user home directory");
        }
        const instruction = stringField(body.instruction, "instruction", { required: true, maxLength: 20_000 });
        const requestId = stringField(body.requestId, "requestId", { required: true, maxLength: 64 });
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(requestId)) {
          throw new ApiError(400, "INVALID_FIELD", "'requestId' must be a valid UUID (used as the Claude session id)");
        }
        if (!claudeLauncher.supportedPlatform) {
          throw new ApiError(400, "UNSUPPORTED", "Claude runtime is only supported on macOS (Terminal.app).");
        }
        const prompt = `Use the manage-taskboard skill to work on this task.\n\n${instruction}\n\n[taskboard-request:${requestId}]`;
        const connector = database.getDefaultConnector("claude");
        try {
          claudeLauncher.launchSession({ workspacePath: resolvedWorkspace, sessionId: requestId, prompt, connector });
        } catch (error) {
          throw new ApiError(500, "CLAUDE_LAUNCH_FAILED", error instanceof Error ? error.message : "Failed to launch Claude session");
        }
        return sendJson(response, 201, { threadId: requestId, runtime: "claude" });
      }

      if (pathname === "/api/local/claude/resume") {
        assertNoQuery(url.searchParams, "/api/local/claude/resume");
        if (request.method !== "POST") return methodNotAllowed(response, ["POST"]);
        const body = await readJson(request);
        assertPlainObject(body);
        assertAllowedKeys(body, new Set(["threadId", "workspacePath", "followUp"]));
        const threadId = stringField(body.threadId, "threadId", { required: true, maxLength: 128 });
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(threadId)) {
          throw new ApiError(400, "INVALID_FIELD", "'threadId' must be a valid Claude session UUID");
        }
        const workspacePath = stringField(body.workspacePath, "workspacePath", { required: true, maxLength: 4096 });
        if (!path.isAbsolute(workspacePath) || workspacePath.includes("\0")) {
          throw new ApiError(400, "INVALID_FIELD", "'workspacePath' must be an absolute local path");
        }
        const home = os.homedir();
        const resolvedWorkspace = path.resolve(workspacePath);
        if (resolvedWorkspace !== home && !resolvedWorkspace.startsWith(`${home}/`)) {
          throw new ApiError(400, "INVALID_FIELD", "'workspacePath' must be inside the user home directory");
        }
        const followUp = body.followUp === undefined
          ? undefined
          : stringField(body.followUp, "followUp", { maxLength: 20_000 });
        if (!claudeLauncher.supportedPlatform) {
          throw new ApiError(400, "UNSUPPORTED", "Claude runtime is only supported on macOS (Terminal.app).");
        }
        const connector = database.getDefaultConnector("claude");
        try {
          claudeLauncher.resumeSession({ workspacePath: resolvedWorkspace, sessionId: threadId, followUp, connector });
        } catch (error) {
          throw new ApiError(500, "CLAUDE_LAUNCH_FAILED", error instanceof Error ? error.message : "Failed to resume Claude session");
        }
        return sendJson(response, 200, { ok: true });
      }

      if (pathname === "/api/local/claude/status") {
        if (request.method !== "GET") return methodNotAllowed(response, ["GET"]);
        const sessionId = stringField(url.searchParams.get("sessionId") ?? "", "sessionId", { required: true, maxLength: 64 });
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sessionId)) {
          throw new ApiError(400, "INVALID_FIELD", "'sessionId' must be a valid Claude session UUID");
        }
        return sendJson(response, 200, { running: claudeLauncher.isRunning(sessionId) });
      }
      if (pathname === "/api/local/omp/session") {
        assertNoQuery(url.searchParams, "/api/local/omp/session");
        if (request.method !== "POST") return methodNotAllowed(response, ["POST"]);
        const body = await readJson(request);
        assertPlainObject(body);
        assertAllowedKeys(body, new Set(["taskId", "workspacePath", "instruction", "requestId", "commentId"]));
        const taskId = stringField(body.taskId, "taskId", { required: true, maxLength: 128 });
        const workspacePath = stringField(body.workspacePath, "workspacePath", { required: true, maxLength: 4096 });
        if (!path.isAbsolute(workspacePath) || workspacePath.includes("\0")) {
          throw new ApiError(400, "INVALID_FIELD", "'workspacePath' must be an absolute local path");
        }
        const home = os.homedir();
        const resolvedWorkspace = path.resolve(workspacePath);
        if (resolvedWorkspace !== home && !resolvedWorkspace.startsWith(`${home}/`)) {
          throw new ApiError(400, "INVALID_FIELD", "'workspacePath' must be inside the user home directory");
        }
        const instruction = stringField(body.instruction, "instruction", { required: true, maxLength: 20_000 });
        const requestId = stringField(body.requestId, "requestId", { required: true, maxLength: 64 });
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(requestId)) {
          throw new ApiError(400, "INVALID_FIELD", "'requestId' must be a valid UUID (used as the OMP session id)");
        }
        if (!ompLauncher.supportedPlatform) {
          throw new ApiError(400, "UNSUPPORTED", "OMP runtime is only supported on macOS (Terminal.app).");
        }
        const prompt = `Use the manage-taskboard skill to work on this task.\n\n${instruction}\n\n[taskboard-request:${requestId}]`;
        const connector = database.getDefaultConnector("omp");
        try {
          ompLauncher.launchSession({ workspacePath: resolvedWorkspace, sessionId: requestId, prompt, connector });
        } catch (error) {
          throw new ApiError(500, "OMP_LAUNCH_FAILED", error instanceof Error ? error.message : "Failed to launch OMP session");
        }
        return sendJson(response, 201, { threadId: requestId, runtime: "omp" });
      }

      if (pathname === "/api/local/omp/resume") {
        assertNoQuery(url.searchParams, "/api/local/omp/resume");
        if (request.method !== "POST") return methodNotAllowed(response, ["POST"]);
        const body = await readJson(request);
        assertPlainObject(body);
        assertAllowedKeys(body, new Set(["threadId", "workspacePath", "followUp"]));
        const threadId = stringField(body.threadId, "threadId", { required: true, maxLength: 128 });
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(threadId)) {
          throw new ApiError(400, "INVALID_FIELD", "'threadId' must be a valid OMP session UUID");
        }
        const workspacePath = stringField(body.workspacePath, "workspacePath", { required: true, maxLength: 4096 });
        if (!path.isAbsolute(workspacePath) || workspacePath.includes("\0")) {
          throw new ApiError(400, "INVALID_FIELD", "'workspacePath' must be an absolute local path");
        }
        const home = os.homedir();
        const resolvedWorkspace = path.resolve(workspacePath);
        if (resolvedWorkspace !== home && !resolvedWorkspace.startsWith(`${home}/`)) {
          throw new ApiError(400, "INVALID_FIELD", "'workspacePath' must be inside the user home directory");
        }
        const followUp = body.followUp === undefined
          ? undefined
          : stringField(body.followUp, "followUp", { maxLength: 20_000 });
        if (!ompLauncher.supportedPlatform) {
          throw new ApiError(400, "UNSUPPORTED", "OMP runtime is only supported on macOS (Terminal.app).");
        }
        const connector = database.getDefaultConnector("omp");
        try {
          ompLauncher.resumeSession({ workspacePath: resolvedWorkspace, sessionId: threadId, followUp, connector });
        } catch (error) {
          throw new ApiError(500, "OMP_LAUNCH_FAILED", error instanceof Error ? error.message : "Failed to resume OMP session");
        }
        return sendJson(response, 200, { ok: true });
      }

      if (pathname === "/api/local/omp/status") {
        if (request.method !== "GET") return methodNotAllowed(response, ["GET"]);
        const sessionId = stringField(url.searchParams.get("sessionId") ?? "", "sessionId", { required: true, maxLength: 64 });
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sessionId)) {
          throw new ApiError(400, "INVALID_FIELD", "'sessionId' must be a valid OMP session UUID");
        }
        return sendJson(response, 200, { running: ompLauncher.isRunning(sessionId) });
      }

      if (pathname === "/api/device-workspaces") {
        if (request.method !== "GET") return methodNotAllowed(response, ["GET"]);
        if ([...url.searchParams.keys()].length > 0) {
          throw new ApiError(400, "UNKNOWN_QUERY_PARAMETER", "GET /api/device-workspaces does not accept query parameters");
        }
        return sendJson(response, 200, {
          workspaces: await readDeviceProjectWorkspaces(),
        });
      }

      if (pathname === "/api/workflow-capabilities") {
        if (request.method !== "GET") return methodNotAllowed(response, ["GET"]);
        const unknownQuery = [...url.searchParams.keys()].filter((key) => key !== "workspacePath");
        if (unknownQuery.length > 0) {
          throw new ApiError(400, "UNKNOWN_QUERY_PARAMETER", `Unknown query parameter: ${unknownQuery[0]}`);
        }
        const workspacePath = stringField(
          url.searchParams.get("workspacePath") ?? null,
          "workspacePath",
          { nullable: true, maxLength: 4096 },
        );
        if (workspacePath?.includes("\0")) {
          throw new ApiError(400, "INVALID_FIELD", "'workspacePath' cannot contain null bytes");
        }
        if (workspacePath && !path.isAbsolute(workspacePath)) {
          throw new ApiError(400, "INVALID_FIELD", "'workspacePath' must be absolute");
        }
        return sendJson(
          response,
          200,
          await discoverWorkflowCapabilities(resolved, workspacePath ?? PROJECT_ROOT),
        );
      }

      if (pathname === "/api/connectors") {
        if (request.method === "GET") {
          if ([...url.searchParams.keys()].length > 0) {
            throw new ApiError(400, "UNKNOWN_QUERY_PARAMETER", "GET /api/connectors does not accept query parameters");
          }
          return sendJson(response, 200, { connectors: database.listConnectors() });
        }
        if (request.method === "POST") {
          const connector = database.createConnector(parseConnectorCreate(await readJson(request)));
          events.emit("connector.changed", { connector });
          return sendJson(response, 201, { connector });
        }
        return methodNotAllowed(response, ["GET", "POST"]);
      }

      const connectorDefaultRoute = pathname.match(/^\/api\/connectors\/([^/]+)\/default$/);
      if (connectorDefaultRoute) {
        const id = decodeRouteSegment(connectorDefaultRoute[1], "Connector id");
        assertNoQuery(url.searchParams, "POST /api/connectors/:id/default");
        if (request.method !== "POST") return methodNotAllowed(response, ["POST"]);
        const { version } = parseConnectorVersionBody(await readJson(request));
        const connector = database.setDefaultConnector(id, version);
        events.emit("connector.changed", { connector });
        return sendJson(response, 200, { connector });
      }

      const connectorItemRoute = pathname.match(/^\/api\/connectors\/([^/]+)$/);
      if (connectorItemRoute) {
        const id = decodeRouteSegment(connectorItemRoute[1], "Connector id");
        assertNoQuery(url.searchParams, "/api/connectors/:id");
        if (request.method === "GET") {
          const connector = database.getConnector(id);
          if (!connector) throw new ApiError(404, "CONNECTOR_NOT_FOUND", `Connector '${id}' does not exist`);
          return sendJson(response, 200, { connector });
        }
        if (request.method === "PATCH") {
          const { version, changes } = parseConnectorPatch(await readJson(request));
          const connector = database.updateConnector(id, version, changes);
          events.emit("connector.changed", { connector });
          return sendJson(response, 200, { connector });
        }
        if (request.method === "DELETE") {
          const { version } = parseConnectorVersionBody(await readJson(request));
          database.deleteConnector(id, version);
          events.emit("connector.changed", { id });
          return sendJson(response, 200, { id });
        }
        return methodNotAllowed(response, ["GET", "PATCH", "DELETE"]);
      }

      if (pathname === "/api/projects") {
        if (request.method === "GET") {
          if ([...url.searchParams.keys()].length > 0) {
            throw new ApiError(400, "UNKNOWN_QUERY_PARAMETER", "GET /api/projects does not accept query parameters");
          }
          return sendJson(response, 200, { projects: database.listProjects() });
        }
        if (request.method === "POST") {
          const project = database.createProject(parseProjectCreate(await readJson(request)));
          events.emit("project.created", { project });
          return sendJson(response, 201, { project });
        }
        return methodNotAllowed(response, ["GET", "POST"]);
      }

      const projectKnowledgeSourcesRoute = pathname.match(
        /^\/api\/projects\/([^/]+)\/knowledge-source-versions$/,
      );
      if (projectKnowledgeSourcesRoute) {
        const projectId = validateProjectId(decodeRouteSegment(projectKnowledgeSourcesRoute[1], "Project id"));
        assertNoQuery(url.searchParams, "Project knowledge source versions");
        if (request.method !== "GET") return methodNotAllowed(response, ["GET"]);
        return sendJson(response, 200, { versions: database.knowledgeSourceVersions(projectId) });
      }

      const projectKnowledgeProposalsRoute = pathname.match(
        /^\/api\/projects\/([^/]+)\/knowledge-proposals$/,
      );
      if (projectKnowledgeProposalsRoute) {
        const projectId = validateProjectId(decodeRouteSegment(projectKnowledgeProposalsRoute[1], "Project id"));
        if (request.method === "GET") {
          assertAllowedQuery(url.searchParams, new Set(["status"]), "GET project knowledge proposals");
          const status = stringField(url.searchParams.get("status") ?? null, "status", {
            nullable: true,
            maxLength: 32,
          });
          if (status && !["generating", "ready", "published", "rejected", "failed"].includes(status)) {
            throw new ApiError(400, "INVALID_FIELD", "Unknown knowledge proposal status");
          }
          return sendJson(response, 200, {
            proposals: database.listKnowledgeProposals(projectId, status),
          });
        }
        if (request.method === "POST") {
          assertNoQuery(url.searchParams, "POST project knowledge proposal");
          const proposal = database.createKnowledgeProposal({
            projectId,
            ...parseKnowledgeProposalCreate(await readJson(
              request,
              KNOWLEDGE_BODY_LIMIT,
              "Knowledge proposals cannot exceed 6 MiB",
            )),
            actor: actorFromRequest(request),
          });
          events.emit("knowledge-proposal.created", { projectId, proposal });
          return sendJson(response, 201, { proposal });
        }
        return methodNotAllowed(response, ["GET", "POST"]);
      }

      const questionnairesRoute = pathname.match(/^\/api\/projects\/([^/]+)\/knowledge-questionnaires(?:\/([^/]+))?$/);
      if (questionnairesRoute) {
        const projectId = validateProjectId(decodeRouteSegment(questionnairesRoute[1], "Project id")); const questionnaireId = questionnairesRoute[2] ? decodeRouteSegment(questionnairesRoute[2], "Questionnaire id") : null;
        if (!questionnaireId && request.method === "GET") return sendJson(response, 200, { questionnaires: database.listKnowledgeQuestionnaires(projectId) });
        if (!questionnaireId && request.method === "POST") return sendJson(response, 201, { questionnaire: database.createKnowledgeQuestionnaire({ projectId, ...parseQuestionnaireCreate(await readJson(request)), actor: actorFromRequest(request) }) });
        if (questionnaireId && request.method === "PATCH") { const body = await readJson(request); assertPlainObject(body); assertAllowedKeys(body, new Set(["status"])); const status = stringField(body.status, "status", { required: true, maxLength: 16 }); if (!["open", "closed"].includes(status)) throw new ApiError(400, "INVALID_FIELD", "status must be open or closed"); database.updateKnowledgeQuestionnaire(questionnaireId, status); return sendJson(response, 200, { questionnaires: database.listKnowledgeQuestionnaires(projectId) }); }
        return methodNotAllowed(response, ["GET", "POST", "PATCH"]);
      }
      const answerRoute = pathname.match(/^\/api\/knowledge-questions\/([^/]+)\/answers$/);
      if (answerRoute && request.method === "POST") { const body = await readJson(request); assertPlainObject(body); assertAllowedKeys(body, new Set(["content", "confidence"])); const confidence = stringField(body.confidence, "confidence", { required: true, maxLength: 16 }); if (!["high", "medium", "low", "unknown"].includes(confidence)) throw new ApiError(400, "INVALID_FIELD", "Unknown confidence"); const answerId = database.submitKnowledgeAnswer(decodeRouteSegment(answerRoute[1], "Question id"), { content: stringField(body.content, "content", { required: true, maxLength: 20000 }), confidence, actor: actorFromRequest(request) }); return sendJson(response, 201, { answerId }); }
      const reviewRoute = pathname.match(/^\/api\/knowledge-answers\/([^/]+)\/review$/);
      if (reviewRoute && request.method === "POST") { const body = await readJson(request); assertPlainObject(body); assertAllowedKeys(body, new Set(["status", "reviewNote"])); const status = stringField(body.status, "status", { required: true, maxLength: 20 }); if (!["accepted", "needs_revision", "rejected"].includes(status)) throw new ApiError(400, "INVALID_FIELD", "Unknown answer review status"); const answerId = decodeRouteSegment(reviewRoute[1], "Answer id"); const actor = actorFromRequest(request); const context = database.knowledgeAnswerContext(answerId); if (!context) throw new ApiError(404, "KNOWLEDGE_ANSWER_NOT_FOUND", "Knowledge answer does not exist"); if (context.status !== "submitted") throw new ApiError(409, "INVALID_ANSWER_TRANSITION", "Only submitted answers can be reviewed"); let proposal = null; if (status === "accepted") { proposal = database.createKnowledgeProposal({ projectId: context.project_id, title: `待确认：${context.knowledge_target}`, sourceType: "question", sourceSnapshot: { questionnaireAnswerId: answerId, question: context.prompt }, summary: "人工问卷回答已审核采纳；请审阅下方内容，确认后才会发布为正式知识。", changes: [{ targetPath: context.knowledge_target, operation: "update", baseDigest: null, beforeContent: null, afterContent: `\n## 人工确认补充\n\n${context.content}\n` }], actor }); } database.reviewKnowledgeAnswer(answerId, status, stringField(body.reviewNote ?? "", "reviewNote", { maxLength: 4000 }), actor, proposal?.id ?? null); return sendJson(response, 200, { proposal }); }

      const knowledgeProposalRoute = pathname.match(/^\/api\/knowledge-proposals\/([^/]+)$/);
      if (knowledgeProposalRoute) {
        const proposalId = decodeRouteSegment(knowledgeProposalRoute[1], "Knowledge proposal id");
        assertNoQuery(url.searchParams, "Knowledge proposal routes");
        if (request.method === "GET") {
          const proposal = database.getKnowledgeProposal(proposalId);
          if (!proposal) {
            throw new ApiError(404, "KNOWLEDGE_PROPOSAL_NOT_FOUND", `Knowledge proposal '${proposalId}' does not exist`);
          }
          return sendJson(response, 200, { proposal });
        }
        if (request.method === "PATCH") {
          const parsed = parseKnowledgeProposalPatch(await readJson(
            request,
            KNOWLEDGE_BODY_LIMIT,
            "Knowledge proposals cannot exceed 6 MiB",
          ));
          const proposal = database.updateKnowledgeProposal(
            proposalId,
            parsed.version,
            parsed.changes,
            actorFromRequest(request),
          );
          events.emit("knowledge-proposal.updated", { projectId: proposal.projectId, proposal });
          return sendJson(response, 200, { proposal });
        }
        return methodNotAllowed(response, ["GET", "PATCH"]);
      }

      const workflowWorkspaceRoute = pathname.match(/^\/api\/projects\/([^/]+)\/workflow-workspace$/);
      if (workflowWorkspaceRoute) {
        if ([...url.searchParams.keys()].length > 0) {
          throw new ApiError(400, "UNKNOWN_QUERY_PARAMETER", "Workflow workspace routes do not accept query parameters");
        }
        let projectId;
        try {
          projectId = decodeURIComponent(workflowWorkspaceRoute[1]);
        } catch {
          throw new ApiError(400, "INVALID_PATH", "Project id contains invalid encoding");
        }
        validateProjectId(projectId);
        if (request.method === "GET") {
          return sendJson(response, 200, { workflow: database.getWorkflowWorkspace(projectId) });
        }
        if (request.method === "PUT") {
          const input = parseWorkflowWorkspaceSave(await readJson(request));
          const workflow = database.saveWorkflowWorkspace(projectId, input.version, input.workspace);
          events.emit("workflow.updated", {
            projectId,
            workflowVersion: workflow.version,
          });
          return sendJson(response, 200, { workflow });
        }
        return methodNotAllowed(response, ["GET", "PUT"]);
      }

      const developmentContextsRoute = pathname.match(/^\/api\/projects\/([^/]+)\/development-contexts$/);
      if (developmentContextsRoute) {
        if (request.method !== "GET") return methodNotAllowed(response, ["GET"]);
        const unknownQuery = [...url.searchParams.keys()].filter((key) => (
          !["codexProjectId", "codexThreadId", "workspacePath"].includes(key)
        ));
        if (unknownQuery.length > 0) {
          throw new ApiError(400, "UNKNOWN_QUERY_PARAMETER", `Unknown query parameter: ${unknownQuery[0]}`);
        }
        let projectId;
        try {
          projectId = decodeURIComponent(developmentContextsRoute[1]);
        } catch {
          throw new ApiError(400, "INVALID_PATH", "Project id contains invalid encoding");
        }
        validateProjectId(projectId);
        const project = database.getProject(projectId);
        if (!project) throw new ApiError(404, "PROJECT_NOT_FOUND", `Project '${projectId}' does not exist`);
        const codexProjectId = stringField(url.searchParams.get("codexProjectId") ?? null, "codexProjectId", {
          nullable: true,
          maxLength: 128,
        });
        const codexThreadId = stringField(url.searchParams.get("codexThreadId") ?? null, "codexThreadId", {
          nullable: true,
          maxLength: 256,
        });
        const deviceWorkspacePath = stringField(
          url.searchParams.get("workspacePath") ?? null,
          "workspacePath",
          { nullable: true, maxLength: 4096 },
        );
        if (deviceWorkspacePath?.includes("\0")) {
          throw new ApiError(400, "INVALID_FIELD", "'workspacePath' cannot contain null bytes");
        }
        const workspacePath = deviceWorkspacePath ?? await resolveProjectWorkspace(
          project,
          codexProjectId,
          codexThreadId,
          resolved.codexStatePath,
          resolved.codexProcessesPath,
        );
        return sendJson(response, 200, await scanDevelopmentContexts(workspacePath));
      }

      if (pathname === "/api/tasks") {
        if (request.method === "GET") {
          return sendJson(response, 200, { tasks: await listTasksWithResolvedRuntimes(parseTaskFilters(url.searchParams)) });
        }
        if (request.method === "POST") {
          const actor = actorFromRequest(request);
          const { assigneeTarget, ...input } = parseTaskCreate(await readJson(request));
          // An issue created by a runtime agent inherits that runtime, so the
          // taskboard routes its linked session to the right launcher.
          if (input.runtime === "codex" && actor.id === "claude-agent") {
            input.runtime = "claude";
          }
          if (input.runtime === "codex" && actor.id === "omp-agent") {
            input.runtime = "omp";
          }
          const createdTask = database.createTask({
            ...input,
            actor,
            assignee: resolveAssignee(assigneeTarget, actor),
          });
          const task = await getTaskWithResolvedRuntimes(createdTask.id);
          events.emit("task.created", { task });
          return sendJson(response, 201, { task });
        }
        return methodNotAllowed(response, ["GET", "POST"]);
      }

      if (pathname === "/api/events") {
        if (request.method !== "GET") return methodNotAllowed(response, ["GET"]);
        if ([...url.searchParams.keys()].length > 0) {
          throw new ApiError(400, "UNKNOWN_QUERY_PARAMETER", "GET /api/events does not accept query parameters");
        }
        events.connect(request, response);
        return;
      }

      const taskRelationRoute = pathname.match(
        /^\/api\/tasks\/([^/]+)\/relations\/([^/]+)\/([^/]+)$/,
      );
      if (taskRelationRoute) {
        let taskId;
        let type;
        let relatedTaskId;
        try {
          taskId = decodeURIComponent(taskRelationRoute[1]);
          type = decodeURIComponent(taskRelationRoute[2]);
          relatedTaskId = decodeURIComponent(taskRelationRoute[3]);
        } catch {
          throw new ApiError(400, "INVALID_PATH", "Issue relation path contains invalid encoding");
        }
        if (
          taskId.length === 0
          || taskId.length > 128
          || relatedTaskId.length === 0
          || relatedTaskId.length > 128
        ) {
          throw new ApiError(400, "INVALID_PATH", "Issue relation task id is invalid");
        }
        if ([...url.searchParams.keys()].length > 0) {
          throw new ApiError(400, "UNKNOWN_QUERY_PARAMETER", "Issue relation routes do not accept query parameters");
        }
        const relationType = parseIssueRelationType(type);
        if (request.method === "POST") {
          const { version, threadId } = parseArchive(await readJson(request));
          const result = database.addTaskRelation(
            taskId,
            version,
            relationType,
            relatedTaskId,
            threadId,
          );
          events.emit("task.relation.updated", result);
          return sendJson(response, 200, result);
        }
        if (request.method === "DELETE") {
          const { version, threadId } = parseArchive(await readJson(request));
          const result = database.removeTaskRelation(
            taskId,
            version,
            relationType,
            relatedTaskId,
            threadId,
          );
          events.emit("task.relation.updated", result);
          return sendJson(response, 200, result);
        }
        return methodNotAllowed(response, ["POST", "DELETE"]);
      }

      const taskCommentsRoute = pathname.match(/^\/api\/tasks\/([^/]+)\/comments$/);
      if (taskCommentsRoute) {
        let taskId;
        try {
          taskId = decodeURIComponent(taskCommentsRoute[1]);
        } catch {
          throw new ApiError(400, "INVALID_PATH", "Task id contains invalid encoding");
        }
        if (taskId.length === 0 || taskId.length > 128) {
          throw new ApiError(400, "INVALID_PATH", "Task id is invalid");
        }
        if ([...url.searchParams.keys()].length > 0) {
          throw new ApiError(400, "UNKNOWN_QUERY_PARAMETER", "Comment routes do not accept query parameters");
        }
        if (request.method === "GET") {
          return sendJson(response, 200, { comments: database.listComments(taskId) });
        }
        if (request.method === "POST") {
          const comment = database.createComment(taskId, {
            ...parseCommentCreate(await readJson(request)),
            actor: actorFromRequest(request),
          });
          const task = await getTaskWithResolvedRuntimes(taskId);
          events.emit("comment.created", { comment, task });
          return sendJson(response, 201, { comment });
        }
        return methodNotAllowed(response, ["GET", "POST"]);
      }

      const commentRoute = pathname.match(/^\/api\/comments\/([^/]+)$/);
      if (commentRoute) {
        let id;
        try {
          id = decodeURIComponent(commentRoute[1]);
        } catch {
          throw new ApiError(400, "INVALID_PATH", "Comment id contains invalid encoding");
        }
        if (id.length === 0 || id.length > 128) {
          throw new ApiError(400, "INVALID_PATH", "Comment id is invalid");
        }
        if ([...url.searchParams.keys()].length > 0) {
          throw new ApiError(400, "UNKNOWN_QUERY_PARAMETER", "Comment routes do not accept query parameters");
        }
        if (request.method === "PATCH") {
          const patch = parseCommentPatch(await readJson(request));
          const comment = database.updateComment(id, patch.version, patch.body, patch.threadId);
          const task = await getTaskWithResolvedRuntimes(comment.taskId);
          events.emit("comment.updated", { comment, task });
          return sendJson(response, 200, { comment });
        }
        if (request.method === "DELETE") {
          const { version, threadId } = parseArchive(await readJson(request));
          const comment = database.deleteComment(id, version, threadId);
          for (const attachment of comment.attachments) {
            try {
              await unlink(path.join(resolved.attachmentsDirectory, attachment.id));
            } catch (error) {
              if (error.code !== "ENOENT") throw error;
            }
          }
          const task = await getTaskWithResolvedRuntimes(comment.taskId);
          events.emit("comment.deleted", { comment, task });
          return sendEmpty(response, 204);
        }
        return methodNotAllowed(response, ["PATCH", "DELETE"]);
      }

      const commentAttachmentsRoute = pathname.match(/^\/api\/comments\/([^/]+)\/attachments$/);
      if (commentAttachmentsRoute) {
        let commentId;
        try {
          commentId = decodeURIComponent(commentAttachmentsRoute[1]);
        } catch {
          throw new ApiError(400, "INVALID_PATH", "Comment id contains invalid encoding");
        }
        if (commentId.length === 0 || commentId.length > 128) {
          throw new ApiError(400, "INVALID_PATH", "Comment id is invalid");
        }
        if ([...url.searchParams.keys()].length > 0) {
          throw new ApiError(400, "UNKNOWN_QUERY_PARAMETER", "Attachment routes do not accept query parameters");
        }
        if (request.method === "GET") {
          return sendJson(response, 200, { attachments: database.listCommentAttachments(commentId) });
        }
        if (request.method === "POST") {
          const comment = database.getComment(commentId);
          if (!comment) throw new ApiError(404, "COMMENT_NOT_FOUND", `Comment '${commentId}' does not exist`);
          const metadata = parseAttachmentHeaders(request);
          const body = await readBody(request, ATTACHMENT_BODY_LIMIT, "Attachment cannot exceed 25 MiB");
          const id = randomUUID();
          await mkdir(resolved.attachmentsDirectory, { recursive: true });
          const storagePath = path.join(resolved.attachmentsDirectory, id);
          await writeFile(storagePath, body, { flag: "wx" });
          let attachment;
          try {
            attachment = database.createCommentAttachment(commentId, { id, ...metadata, size: body.length });
          } catch (error) {
            await unlink(storagePath);
            throw error;
          }
          const task = await getTaskWithResolvedRuntimes(comment.taskId);
          events.emit("attachment.created", { attachment, comment: database.getComment(commentId), task });
          return sendJson(response, 201, { attachment });
        }
        return methodNotAllowed(response, ["GET", "POST"]);
      }

      const taskThreadRoute = pathname.match(/^\/api\/tasks\/([^/]+)\/threads\/([^/]+)$/);
      if (taskThreadRoute) {
        let taskId;
        let threadId;
        try {
          taskId = decodeURIComponent(taskThreadRoute[1]);
          threadId = decodeURIComponent(taskThreadRoute[2]);
        } catch {
          throw new ApiError(400, "INVALID_PATH", "Task or thread id contains invalid encoding");
        }
        if (taskId.length === 0 || taskId.length > 128) {
          throw new ApiError(400, "INVALID_PATH", "Task id is invalid");
        }
        if (threadId.length === 0 || threadId.length > 256) {
          throw new ApiError(400, "INVALID_PATH", "Thread id is invalid");
        }
        if ([...url.searchParams.keys()].length > 0) {
          throw new ApiError(400, "UNKNOWN_QUERY_PARAMETER", "Task thread routes do not accept query parameters");
        }
        if (request.method !== "DELETE") return methodNotAllowed(response, ["DELETE"]);
        const { version } = parseTaskThreadDelete(await readJson(request));
        const unlinkedTask = database.unlinkTaskThread(taskId, version, threadId);
        const task = await getTaskWithResolvedRuntimes(unlinkedTask.id);
        events.emit("task.updated", { task });
        return sendJson(response, 200, { task });
      }

      const taskAttachmentsRoute = pathname.match(/^\/api\/tasks\/([^/]+)\/attachments$/);
      if (taskAttachmentsRoute) {
        let taskId;
        try {
          taskId = decodeURIComponent(taskAttachmentsRoute[1]);
        } catch {
          throw new ApiError(400, "INVALID_PATH", "Task id contains invalid encoding");
        }
        if (taskId.length === 0 || taskId.length > 128) {
          throw new ApiError(400, "INVALID_PATH", "Task id is invalid");
        }
        if ([...url.searchParams.keys()].length > 0) {
          throw new ApiError(400, "UNKNOWN_QUERY_PARAMETER", "Attachment routes do not accept query parameters");
        }
        if (request.method === "GET") {
          return sendJson(response, 200, { attachments: database.listAttachments(taskId) });
        }
        if (request.method === "POST") {
          const task = database.getTask(taskId);
          if (!task) throw new ApiError(404, "TASK_NOT_FOUND", `Task '${taskId}' does not exist`);
          const metadata = parseAttachmentHeaders(request);
          const body = await readBody(request, ATTACHMENT_BODY_LIMIT, "Attachment cannot exceed 25 MiB");
          const id = randomUUID();
          await mkdir(resolved.attachmentsDirectory, { recursive: true });
          const storagePath = path.join(resolved.attachmentsDirectory, id);
          await writeFile(storagePath, body, { flag: "wx" });
          let attachment;
          try {
            attachment = database.createAttachment(taskId, { id, ...metadata, size: body.length });
          } catch (error) {
            await unlink(storagePath);
            throw error;
          }
          events.emit("attachment.created", { attachment, task });
          return sendJson(response, 201, { attachment });
        }
        return methodNotAllowed(response, ["GET", "POST"]);
      }

      const attachmentContentRoute = pathname.match(/^\/api\/attachments\/([^/]+)\/content$/);
      if (attachmentContentRoute) {
        let id;
        try {
          id = decodeURIComponent(attachmentContentRoute[1]);
        } catch {
          throw new ApiError(400, "INVALID_PATH", "Attachment id contains invalid encoding");
        }
        if (id.length === 0 || id.length > 128) {
          throw new ApiError(400, "INVALID_PATH", "Attachment id is invalid");
        }
        if ([...url.searchParams.keys()].length > 0) {
          throw new ApiError(400, "UNKNOWN_QUERY_PARAMETER", "Attachment routes do not accept query parameters");
        }
        if (request.method !== "GET" && request.method !== "HEAD") {
          return methodNotAllowed(response, ["GET", "HEAD"]);
        }
        const attachment = database.getAttachment(id);
        if (!attachment) throw new ApiError(404, "ATTACHMENT_NOT_FOUND", `Attachment '${id}' does not exist`);
        const body = await readFile(path.join(resolved.attachmentsDirectory, attachment.id));
        const encodedFilename = encodeURIComponent(attachment.filename).replace(/['()*]/g, (character) => (
          `%${character.charCodeAt(0).toString(16).toUpperCase()}`
        ));
        const canOpenInline = INLINE_ATTACHMENT_TYPES.has(attachment.contentType);
        response.writeHead(200, {
          "cache-control": "private, no-store",
          "content-disposition": `${canOpenInline ? "inline" : "attachment"}; filename*=UTF-8''${encodedFilename}`,
          "content-length": body.length,
          "content-security-policy": "sandbox; default-src 'none'",
          "content-type": canOpenInline ? attachment.contentType : "application/octet-stream",
        });
        response.end(request.method === "HEAD" ? undefined : body);
        return;
      }

      const attachmentRoute = pathname.match(/^\/api\/attachments\/([^/]+)$/);
      if (attachmentRoute) {
        let id;
        try {
          id = decodeURIComponent(attachmentRoute[1]);
        } catch {
          throw new ApiError(400, "INVALID_PATH", "Attachment id contains invalid encoding");
        }
        if (id.length === 0 || id.length > 128) {
          throw new ApiError(400, "INVALID_PATH", "Attachment id is invalid");
        }
        if ([...url.searchParams.keys()].length > 0) {
          throw new ApiError(400, "UNKNOWN_QUERY_PARAMETER", "Attachment routes do not accept query parameters");
        }
        if (request.method !== "DELETE") return methodNotAllowed(response, ["DELETE"]);
        const attachment = database.getAttachment(id);
        if (!attachment) throw new ApiError(404, "ATTACHMENT_NOT_FOUND", `Attachment '${id}' does not exist`);
        try {
          await unlink(path.join(resolved.attachmentsDirectory, attachment.id));
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
        database.deleteAttachment(id);
        const task = await getTaskWithResolvedRuntimes(attachment.taskId);
        events.emit("attachment.deleted", { attachment, task });
        return sendEmpty(response, 204);
      }

      const taskRoute = pathname.match(/^\/api\/tasks\/([^/]+)(?:\/(archive|restore|move|transfer))?$/);
      if (taskRoute) {
        let id;
        try {
          id = decodeURIComponent(taskRoute[1]);
        } catch {
          throw new ApiError(400, "INVALID_PATH", "Task id contains invalid encoding");
        }
        if (id.length === 0 || id.length > 128) {
          throw new ApiError(400, "INVALID_PATH", "Task id is invalid");
        }
        const action = taskRoute[2];
        if (!action && request.method === "GET") {
          if ([...url.searchParams.keys()].length > 0) {
            throw new ApiError(400, "UNKNOWN_QUERY_PARAMETER", "GET /api/tasks/:id does not accept query parameters");
          }
          const task = database.getTask(id);
          if (!task) throw new ApiError(404, "TASK_NOT_FOUND", `Task '${id}' does not exist`);
          return sendJson(response, 200, { task: await getTaskWithResolvedRuntimes(id) });
        }
        if (!action && request.method === "PATCH") {
          const { version, changes, threadId, assigneeTarget } = parseTaskPatch(await readJson(request));
          if (assigneeTarget !== undefined) {
            changes.assignee = resolveAssignee(assigneeTarget, actorFromRequest(request));
          }
          const updatedTask = database.updateTask(id, version, changes, threadId);
          const task = await getTaskWithResolvedRuntimes(updatedTask.id);
          events.emit("task.updated", { task });
          return sendJson(response, 200, { task });
        }
        if (action === "move" && request.method === "POST") {
          const move = parseMove(await readJson(request));
          const movedTask = database.moveTask(id, move.version, move.status, move.sortOrder, move.threadId);
          const task = await getTaskWithResolvedRuntimes(movedTask.id);
          events.emit("task.moved", { task });
          return sendJson(response, 200, { task });
        }
        if (action === "transfer" && request.method === "POST") {
          const transfer = parseTaskTransfer(await readJson(request));
          const result = database.transferTask(
            id,
            transfer.version,
            transfer.projectId,
            transfer.threadId,
          );
          events.emit("task.transferred", result);
          return sendJson(response, 200, result);
        }
        if (action === "archive" && request.method === "POST") {
          const { version, threadId } = parseArchive(await readJson(request));
          const archivedTask = database.archiveTask(id, version, threadId);
          const task = await getTaskWithResolvedRuntimes(archivedTask.id);
          events.emit("task.archived", { task });
          return sendJson(response, 200, { task });
        }
        if (action === "restore" && request.method === "POST") {
          const { version, threadId } = parseArchive(await readJson(request));
          const restoredTask = database.restoreTask(id, version, threadId);
          const task = await getTaskWithResolvedRuntimes(restoredTask.id);
          events.emit("task.restored", { task });
          return sendJson(response, 200, { task });
        }
        return methodNotAllowed(response, action ? ["POST"] : ["GET", "PATCH"]);
      }

      if (pathname.startsWith("/api/")) {
        throw new ApiError(404, "NOT_FOUND", "API route not found");
      }
      if (await serveStatic(request, response, pathname, resolved.staticDirectory)) return;
      throw new ApiError(404, "NOT_FOUND", "Resource not found");
    } catch (error) {
      if (response.headersSent) {
        response.destroy(error);
        return;
      }
      if (error instanceof ApiError) {
        const payload = { error: { code: error.code, message: error.message } };
        if (error.details !== undefined) payload.error.details = error.details;
        sendJson(response, error.status, payload);
        return;
      }
      console.error(error);
      sendJson(response, 500, { error: { code: "INTERNAL_ERROR", message: "Internal server error" } });
    }
  });

  let listening = false;
  return {
    database,
    server,
    options: resolved,
    async listen({ host = "127.0.0.1", port = resolvePort() } = {}) {
      if (host !== "127.0.0.1" && host !== "0.0.0.0") {
        throw new Error("Taskboard server must bind to 127.0.0.1 or 0.0.0.0");
      }
      await new Promise((resolve, reject) => {
        const onError = (error) => {
          server.off("listening", onListening);
          reject(error);
        };
        const onListening = () => {
          server.off("error", onError);
          resolve();
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(port, host);
      });
      listening = true;
      return server.address();
    },
    async close() {
      const serverClosed = listening
        ? new Promise((resolve, reject) => {
            server.close((error) => error ? reject(error) : resolve());
          })
        : Promise.resolve();
      events.close();
      await serverClosed;
      listening = false;
      database.close();
    },
  };
}
