import type {
  ActorIdentity,
  AiChatCatalog,
  AiChatAttachmentInput,
  AiChatRun,
  AiChatSandbox,
  AiChatThread,
  AiChatThreadSnapshot,
  Attachment,
  Comment,
  DevelopmentScan,
  IssueRelationType,
  GeneratedKnowledgeProposal,
  KnowledgeAnswer,
  KnowledgeDevelopmentContext,
  KnowledgeOverview,
  KnowledgePage,
  KnowledgeProposal,
  KnowledgeProposalChange,
  KnowledgeProposalStatus,
  KnowledgeSearchResult,
  KnowledgeSourceType,
  Project,
  Task,
  TaskboardMetadata,
  TaskDraft,
  TaskProjectTransferResult,
  TaskRuntime,
  TaskStatus,
  WorkflowCapabilities,
  WorkflowWorkspaceRecord,
} from "./types";

const DEFAULT_USER_ACTOR: ActorIdentity = {
  type: "user",
  id: "local-user",
  name: "本地用户",
  avatarUrl: null,
};

let currentUserActor = DEFAULT_USER_ACTOR;

export function setCurrentUserActor(actor?: ActorIdentity) {
  currentUserActor = actor?.type === "user" ? actor : DEFAULT_USER_ACTOR;
}

interface ApiErrorBody {
  error?: {
    code?: string;
    message?: string;
    details?: unknown;
  };
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(status: number, body: ApiErrorBody) {
    super(body.error?.message ?? `Request failed (${status})`);
    this.name = "ApiError";
    this.status = status;
    this.code = body.error?.code ?? "REQUEST_FAILED";
    this.details = body.error?.details;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  const method = (init?.method ?? "GET").toUpperCase();
  if (method !== "GET" && method !== "HEAD") {
    headers.set("X-Taskboard-User-Id", currentUserActor.id);
    headers.set("X-Taskboard-User-Name", encodeURIComponent(currentUserActor.name));
    if (currentUserActor.avatarUrl) {
      headers.set("X-Taskboard-User-Avatar", currentUserActor.avatarUrl);
    }
  }

  let response: Response;
  try {
    response = await fetch(path, { ...init, headers });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw error;
    throw new ApiError(0, {
      error: {
        code: "SERVICE_UNAVAILABLE",
        message: "无法连接本地 Taskboard 服务，请重新通过 Taskboard 启动 Codex。",
      },
    });
  }
  let body: T & ApiErrorBody;
  try {
    body = await response.json() as T & ApiErrorBody;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw error;
    body = {} as T & ApiErrorBody;
  }

  if (!response.ok) throw new ApiError(response.status, body);
  return body;
}

export async function listProjects(signal?: AbortSignal): Promise<Project[]> {
  const data = await request<{ projects: Project[] }>("/api/projects", { signal });
  return data.projects;
}

export async function chooseLocalDirectory(): Promise<string | null> {
  const data = await request<{ workspacePath: string | null }>("/api/local/directory-picker", {
    method: "POST",
  });
  return data.workspacePath;
}

export async function getTaskboardMetadata(signal?: AbortSignal): Promise<TaskboardMetadata> {
  return request<TaskboardMetadata>("/api/meta", { signal });
}

export async function getTaskboardRevision(
  since: number,
  signal?: AbortSignal,
): Promise<{ changed: boolean; revision: number }> {
  const query = new URLSearchParams({ since: String(since) });
  return request<{ changed: boolean; revision: number }>(`/api/revisions?${query}`, { signal });
}

export async function getAiChatCatalog(
  projectId: string,
  signal?: AbortSignal,
): Promise<AiChatCatalog> {
  return request<AiChatCatalog>(
    `/api/local/ai/catalog?projectId=${encodeURIComponent(projectId)}`,
    { signal },
  );
}

export async function listAiChatThreads(signal?: AbortSignal): Promise<AiChatThread[]> {
  const data = await request<{ threads: AiChatThread[] }>("/api/local/ai/threads", { signal });
  return data.threads;
}

export async function createAiChatThread(input: {
  projectId: string;
  issueId?: string;
  title?: string;
  model?: string;
  reasoningEffort?: string;
  sandbox?: AiChatSandbox;
}): Promise<AiChatThread> {
  const data = await request<{ thread: AiChatThread }>("/api/local/ai/threads", {
    method: "POST",
    body: JSON.stringify(input),
  });
  return data.thread;
}

export async function getAiChatThread(
  threadId: string,
  signal?: AbortSignal,
): Promise<AiChatThreadSnapshot> {
  return request<AiChatThreadSnapshot>(
    `/api/local/ai/threads/${encodeURIComponent(threadId)}`,
    { signal },
  );
}

export async function updateAiChatThread(
  threadId: string,
  input: {
    title?: string;
    model?: string;
    reasoningEffort?: string;
    sandbox?: AiChatSandbox;
  },
): Promise<AiChatThread> {
  const data = await request<{ thread: AiChatThread }>(
    `/api/local/ai/threads/${encodeURIComponent(threadId)}`,
    {
      method: "PATCH",
      body: JSON.stringify(input),
    },
  );
  return data.thread;
}

export async function deleteAiChatThread(threadId: string): Promise<void> {
  await request<void>(
    `/api/local/ai/threads/${encodeURIComponent(threadId)}`,
    { method: "DELETE" },
  );
}

export async function startAiChatTurn(
  threadId: string,
  input: {
    message: string;
    skillIds?: string[];
    attachments?: AiChatAttachmentInput[];
    dangerFullAccessConfirmed?: boolean;
  },
): Promise<AiChatRun> {
  const data = await request<{ run: AiChatRun }>(
    `/api/local/ai/threads/${encodeURIComponent(threadId)}/turns`,
    {
      method: "POST",
      body: JSON.stringify(input),
    },
  );
  return data.run;
}

export async function interruptAiChatRun(runId: string): Promise<AiChatRun> {
  const data = await request<{ run: AiChatRun }>(
    `/api/local/ai/runs/${encodeURIComponent(runId)}/interrupt`,
    { method: "POST" },
  );
  return data.run;
}

export function subscribeAiChatThread(
  threadId: string,
  onHint: (type: "ai.event" | "ai.run") => void,
  onError?: () => void,
): () => void {
  const source = new EventSource(`/api/local/ai/threads/${encodeURIComponent(threadId)}/events`);
  source.addEventListener("ai.event", () => onHint("ai.event"));
  source.addEventListener("ai.run", () => onHint("ai.run"));
  if (onError) source.addEventListener("error", onError);
  return () => source.close();
}

export async function listDeviceWorkspaces(signal?: AbortSignal): Promise<Record<string, string>> {
  try {
    const data = await request<{ workspaces: Record<string, string> }>("/api/device-workspaces", { signal });
    return data.workspaces;
  } catch (error) {
    if (error instanceof ApiError && error.code === "LOCAL_COMPANION_REQUIRED") return {};
    throw error;
  }
}

export async function listWorkflowCapabilities(
  workspacePath?: string,
  signal?: AbortSignal,
): Promise<WorkflowCapabilities> {
  const query = new URLSearchParams();
  if (workspacePath) query.set("workspacePath", workspacePath);
  const suffix = query.size > 0 ? `?${query}` : "";
  return request<WorkflowCapabilities>(`/api/workflow-capabilities${suffix}`, { signal });
}

export async function getWorkflowWorkspace<T>(
  projectId: string,
  signal?: AbortSignal,
): Promise<WorkflowWorkspaceRecord<T>> {
  const data = await request<{ workflow: WorkflowWorkspaceRecord<T> }>(
    `/api/projects/${encodeURIComponent(projectId)}/workflow-workspace`,
    { signal },
  );
  return data.workflow;
}

export async function saveWorkflowWorkspace<T>(
  projectId: string,
  workspace: T,
  version: number,
): Promise<WorkflowWorkspaceRecord<T>> {
  const data = await request<{ workflow: WorkflowWorkspaceRecord<T> }>(
    `/api/projects/${encodeURIComponent(projectId)}/workflow-workspace`,
    {
      method: "PUT",
      body: JSON.stringify({ version, workspace }),
    },
  );
  return data.workflow;
}

export async function createProject(input: {
  id?: string;
  name: string;
  workspacePath: string | null;
}): Promise<Project> {
  const data = await request<{ project: Project }>("/api/projects", {
    method: "POST",
    body: JSON.stringify(input),
  });
  return data.project;
}

export async function listDevelopmentContexts(
  projectId: string,
  codexProjectId?: string,
  codexThreadId?: string,
  signal?: AbortSignal,
  workspacePath?: string,
): Promise<DevelopmentScan> {
  const query = new URLSearchParams();
  if (codexProjectId) query.set("codexProjectId", codexProjectId);
  if (codexThreadId) query.set("codexThreadId", codexThreadId);
  if (workspacePath) query.set("workspacePath", workspacePath);
  const suffix = query.size > 0 ? `?${query}` : "";
  return request<DevelopmentScan>(
    `/api/projects/${encodeURIComponent(projectId)}/development-contexts${suffix}`,
    { signal },
  );
}

function knowledgeWorkspaceQuery(workspacePath?: string): URLSearchParams {
  const query = new URLSearchParams();
  if (workspacePath) query.set("workspacePath", workspacePath);
  return query;
}

export async function getKnowledgeOverview(
  projectId: string,
  workspacePath?: string,
  signal?: AbortSignal,
): Promise<KnowledgeOverview> {
  const query = knowledgeWorkspaceQuery(workspacePath);
  const suffix = query.size > 0 ? `?${query}` : "";
  return request<KnowledgeOverview>(
    `/api/local/projects/${encodeURIComponent(projectId)}/knowledge${suffix}`,
    { signal },
  );
}

export async function getKnowledgePage(
  projectId: string,
  pagePath: string,
  workspacePath?: string,
  signal?: AbortSignal,
): Promise<KnowledgePage> {
  const query = knowledgeWorkspaceQuery(workspacePath);
  query.set("path", pagePath);
  return request<KnowledgePage>(
    `/api/local/projects/${encodeURIComponent(projectId)}/knowledge/pages?${query}`,
    { signal },
  );
}

export async function searchKnowledge(
  projectId: string,
  value: string,
  workspacePath?: string,
  signal?: AbortSignal,
): Promise<KnowledgeSearchResult[]> {
  const query = knowledgeWorkspaceQuery(workspacePath);
  query.set("q", value);
  const data = await request<{ results: KnowledgeSearchResult[] }>(
    `/api/local/projects/${encodeURIComponent(projectId)}/knowledge/search?${query}`,
    { signal },
  );
  return data.results;
}

export async function checkKnowledge(
  projectId: string,
  workspacePath?: string,
  sourceVersions?: Record<string, string | number>,
): Promise<KnowledgeOverview> {
  return request<KnowledgeOverview>(
    `/api/local/projects/${encodeURIComponent(projectId)}/knowledge/check`,
    {
      method: "POST",
      body: JSON.stringify({ workspacePath, sourceVersions: sourceVersions ?? {} }),
    },
  );
}

export async function generateKnowledgeProposal(
  projectId: string,
  input: {
    workspacePath?: string;
    sourceType: KnowledgeSourceType;
    sourceSnapshot?: Record<string, unknown>;
    developmentContext?: KnowledgeDevelopmentContext | null;
  },
): Promise<GeneratedKnowledgeProposal> {
  const data = await request<{ proposal: GeneratedKnowledgeProposal }>(
    `/api/local/projects/${encodeURIComponent(projectId)}/knowledge/generate`,
    {
      method: "POST",
      body: JSON.stringify(input),
    },
  );
  return data.proposal;
}

export async function askProjectKnowledge(
  projectId: string,
  question: string,
  workspacePath?: string,
): Promise<KnowledgeAnswer> {
  return request<KnowledgeAnswer>(
    `/api/local/projects/${encodeURIComponent(projectId)}/knowledge/ask`,
    {
      method: "POST",
      body: JSON.stringify({ workspacePath, question }),
    },
  );
}

export async function listKnowledgeProposals(
  projectId: string,
  status?: KnowledgeProposalStatus,
  signal?: AbortSignal,
): Promise<KnowledgeProposal[]> {
  const query = new URLSearchParams();
  if (status) query.set("status", status);
  const suffix = query.size > 0 ? `?${query}` : "";
  const data = await request<{ proposals: KnowledgeProposal[] }>(
    `/api/projects/${encodeURIComponent(projectId)}/knowledge-proposals${suffix}`,
    { signal },
  );
  return data.proposals;
}

export async function createKnowledgeProposal(
  projectId: string,
  proposal: GeneratedKnowledgeProposal & {
    id?: string;
    status?: "generating" | "ready" | "failed";
    error?: string | null;
  },
): Promise<KnowledgeProposal> {
  const data = await request<{ proposal: KnowledgeProposal }>(
    `/api/projects/${encodeURIComponent(projectId)}/knowledge-proposals`,
    {
      method: "POST",
      body: JSON.stringify({ ...proposal, status: proposal.status ?? "ready" }),
    },
  );
  return data.proposal;
}

export async function getKnowledgeProposal(
  proposalId: string,
  signal?: AbortSignal,
): Promise<KnowledgeProposal> {
  const data = await request<{ proposal: KnowledgeProposal }>(
    `/api/knowledge-proposals/${encodeURIComponent(proposalId)}`,
    { signal },
  );
  return data.proposal;
}

export async function updateKnowledgeProposal(
  proposal: KnowledgeProposal,
  changes: {
    title?: string;
    summary?: string;
    status?: KnowledgeProposalStatus;
    error?: string | null;
    changes?: KnowledgeProposalChange[];
  },
): Promise<KnowledgeProposal> {
  const data = await request<{ proposal: KnowledgeProposal }>(
    `/api/knowledge-proposals/${encodeURIComponent(proposal.id)}`,
    {
      method: "PATCH",
      body: JSON.stringify({ version: proposal.version, ...changes }),
    },
  );
  return data.proposal;
}

export async function publishKnowledgeProposal(
  projectId: string,
  proposal: KnowledgeProposal,
  workspacePath?: string,
): Promise<{
  publishedAt: string;
  changes: Array<{ targetPath: string; operation: string; digest: string | null }>;
}> {
  const data = await request<{
    receipt: {
      publishedAt: string;
      changes: Array<{ targetPath: string; operation: string; digest: string | null }>;
    };
  }>(`/api/local/projects/${encodeURIComponent(projectId)}/knowledge/publish`, {
    method: "POST",
    body: JSON.stringify({
      workspacePath,
      proposal: { id: proposal.id, version: proposal.version, changes: proposal.changes },
    }),
  });
  return data.receipt;
}

export async function listTasks(projectId?: string, signal?: AbortSignal): Promise<Task[]> {
  const params = new URLSearchParams({ archived: "all" });
  if (projectId) params.set("projectId", projectId);
  const data = await request<{ tasks: Task[] }>(`/api/tasks?${params}`, { signal });
  return data.tasks;
}

export async function createTask(projectId: string, draft: TaskDraft, threadId?: string): Promise<Task> {
  const data = await request<{ task: Task }>("/api/tasks", {
    method: "POST",
    body: JSON.stringify({ projectId, ...draft, ...(threadId ? { threadId } : {}) }),
  });
  return data.task;
}

export async function updateTask(task: Task, draft: TaskDraft, threadId?: string): Promise<Task> {
  const data = await request<{ task: Task }>(`/api/tasks/${encodeURIComponent(task.id)}`, {
    method: "PATCH",
    body: JSON.stringify({ version: task.version, ...draft, ...(threadId ? { threadId } : {}) }),
  });
  return data.task;
}

export async function linkTaskThread(task: Task, threadId: string, runtime?: TaskRuntime): Promise<Task> {
  const data = await request<{ task: Task }>(`/api/tasks/${encodeURIComponent(task.id)}`, {
    method: "PATCH",
    body: JSON.stringify({ version: task.version, threadId, ...(runtime ? { runtime } : {}) }),
  });
  return data.task;
}

export async function unlinkTaskThread(task: Task, threadId: string): Promise<Task> {
  const data = await request<{ task: Task }>(
    `/api/tasks/${encodeURIComponent(task.id)}/threads/${encodeURIComponent(threadId)}`,
    {
      method: "DELETE",
      body: JSON.stringify({ version: task.version }),
    },
  );
  return data.task;
}

export async function createClaudeSession(input: {
  taskId: string;
  workspacePath: string;
  instruction: string;
  requestId: string;
  commentId?: string;
}): Promise<{ threadId: string; runtime: "claude" }> {
  return request<{ threadId: string; runtime: "claude" }>("/api/local/claude/session", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function resumeClaudeSession(input: {
  threadId: string;
  workspacePath: string;
  followUp?: string;
}): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>("/api/local/claude/resume", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function getClaudeSessionStatus(sessionId: string): Promise<{ running: boolean }> {
  return request<{ running: boolean }>(
    `/api/local/claude/status?sessionId=${encodeURIComponent(sessionId)}`,
  );
}

export async function moveTask(
  task: Task,
  status: TaskStatus,
  sortOrder?: number,
  threadId?: string,
): Promise<Task> {
  const data = await request<{ task: Task }>(
    `/api/tasks/${encodeURIComponent(task.id)}/move`,
    {
      method: "POST",
      body: JSON.stringify({ version: task.version, status, sortOrder, ...(threadId ? { threadId } : {}) }),
    },
  );
  return data.task;
}

export async function transferTaskProject(
  task: Task,
  projectId: string,
  threadId?: string,
): Promise<TaskProjectTransferResult> {
  return request<TaskProjectTransferResult>(
    `/api/tasks/${encodeURIComponent(task.id)}/transfer`,
    {
      method: "POST",
      body: JSON.stringify({
        version: task.version,
        projectId,
        ...(threadId ? { threadId } : {}),
      }),
    },
  );
}

export async function archiveTask(task: Task, threadId?: string): Promise<Task> {
  const data = await request<{ task: Task }>(
    `/api/tasks/${encodeURIComponent(task.id)}/archive`,
    {
      method: "POST",
      body: JSON.stringify({ version: task.version, ...(threadId ? { threadId } : {}) }),
    },
  );
  return data.task;
}

export async function restoreTask(task: Task, threadId?: string): Promise<Task> {
  const data = await request<{ task: Task }>(
    `/api/tasks/${encodeURIComponent(task.id)}/restore`,
    {
      method: "POST",
      body: JSON.stringify({ version: task.version, ...(threadId ? { threadId } : {}) }),
    },
  );
  return data.task;
}

export async function addTaskRelation(
  task: Task,
  type: IssueRelationType,
  relatedTaskId: string,
  threadId?: string,
): Promise<{ task: Task; relatedTask: Task }> {
  return request<{ task: Task; relatedTask: Task }>(
    `/api/tasks/${encodeURIComponent(task.id)}/relations/${type}/${encodeURIComponent(relatedTaskId)}`,
    {
      method: "POST",
      body: JSON.stringify({ version: task.version, ...(threadId ? { threadId } : {}) }),
    },
  );
}

export async function removeTaskRelation(
  task: Task,
  type: IssueRelationType,
  relatedTaskId: string,
  threadId?: string,
): Promise<{ task: Task; relatedTask: Task }> {
  return request<{ task: Task; relatedTask: Task }>(
    `/api/tasks/${encodeURIComponent(task.id)}/relations/${type}/${encodeURIComponent(relatedTaskId)}`,
    {
      method: "DELETE",
      body: JSON.stringify({ version: task.version, ...(threadId ? { threadId } : {}) }),
    },
  );
}

export async function listComments(taskId: string, signal?: AbortSignal): Promise<Comment[]> {
  const data = await request<{ comments: Comment[] }>(
    `/api/tasks/${encodeURIComponent(taskId)}/comments`,
    { signal },
  );
  return Array.isArray(data.comments)
    ? data.comments.map((comment) => ({
        ...comment,
        attachments: Array.isArray(comment.attachments) ? comment.attachments : [],
      }))
    : [];
}

export async function createComment(taskId: string, body: string, threadId?: string): Promise<Comment> {
  const data = await request<{ comment: Comment }>(
    `/api/tasks/${encodeURIComponent(taskId)}/comments`,
    {
      method: "POST",
      body: JSON.stringify({ body, ...(threadId ? { threadId } : {}) }),
    },
  );
  return {
    ...data.comment,
    attachments: Array.isArray(data.comment.attachments) ? data.comment.attachments : [],
  };
}

export async function updateComment(comment: Comment, body: string, threadId?: string | null): Promise<Comment> {
  const data = await request<{ comment: Comment }>(
    `/api/comments/${encodeURIComponent(comment.id)}`,
    {
      method: "PATCH",
      body: JSON.stringify({
        version: comment.version,
        body,
        ...(threadId !== undefined ? { threadId } : {}),
      }),
    },
  );
  return {
    ...data.comment,
    attachments: Array.isArray(data.comment.attachments) ? data.comment.attachments : [],
  };
}

export async function deleteComment(comment: Comment, threadId?: string): Promise<void> {
  await request(`/api/comments/${encodeURIComponent(comment.id)}`, {
    method: "DELETE",
    body: JSON.stringify({ version: comment.version, ...(threadId ? { threadId } : {}) }),
  });
}

export async function listAttachments(taskId: string, signal?: AbortSignal): Promise<Attachment[]> {
  const data = await request<{ attachments: Attachment[] }>(
    `/api/tasks/${encodeURIComponent(taskId)}/attachments`,
    { signal },
  );
  return data.attachments;
}

export async function uploadAttachment(taskId: string, file: File): Promise<Attachment> {
  const data = await request<{ attachment: Attachment }>(
    `/api/tasks/${encodeURIComponent(taskId)}/attachments`,
    {
      method: "POST",
      headers: {
        "Content-Type": file.type || "application/octet-stream",
        "X-Taskboard-Filename": encodeURIComponent(file.name),
      },
      body: file,
    },
  );
  return data.attachment;
}

export async function uploadCommentAttachment(commentId: string, file: File): Promise<Attachment> {
  const data = await request<{ attachment: Attachment }>(
    `/api/comments/${encodeURIComponent(commentId)}/attachments`,
    {
      method: "POST",
      headers: {
        "Content-Type": file.type || "application/octet-stream",
        "X-Taskboard-Filename": encodeURIComponent(file.name),
      },
      body: file,
    },
  );
  return data.attachment;
}

export async function deleteAttachment(attachment: Attachment): Promise<void> {
  await request(`/api/attachments/${encodeURIComponent(attachment.id)}`, {
    method: "DELETE",
  });
}

export function attachmentContentUrl(attachment: Attachment): string {
  return `/api/attachments/${encodeURIComponent(attachment.id)}/content`;
}
