export const TASK_STATUSES = [
  "backlog",
  "todo",
  "in_progress",
  "in_review",
  "done",
  "blocked",
  "canceled",
  "archived",
] as const;
export const TASK_PRIORITIES = ["none", "urgent", "high", "medium", "low"] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];
export type TaskPriority = (typeof TASK_PRIORITIES)[number];
export type ActorType = "user" | "agent";
export type AssigneeTarget = "current-user" | "codex-agent" | "claude-agent" | "omp-agent";
export type TaskRuntime = "codex" | "claude" | "omp";
export type IssueRelationType = "parent" | "blocks" | "blocked_by" | "related";

export interface ActorIdentity {
  type: ActorType;
  id: string;
  name: string;
  avatarUrl: string | null;
}

export type DevelopmentContext =
  | { type: "branch"; branch: string }
  | { type: "worktree"; path: string; branch: string | null };

export type Recurrence = {
  interval: number;
  unit: "day" | "week" | "month" | "year";
};

export interface DevelopmentScan {
  workspacePath: string | null;
  contexts: DevelopmentContext[];
}

export interface TaskboardMetadata {
  manageTaskboardSkillPath?: string;
  projectKnowledgeSkillPath?: string;
  claudeRuntime?: boolean;
  ompRuntime?: boolean;
  connectors?: Connector[];
  capabilities?: TaskboardCapabilities;
}

export type ConnectorRuntime = "claude" | "omp";

export interface Connector {
  id: string;
  name: string;
  runtime: ConnectorRuntime;
  baseUrl: string | null;
  apiKey: string | null;
  model: string | null;
  customHeaders: Record<string, string> | null;
  executable: string | null;
  isDefault: boolean;
  sortOrder: number;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface CodexThreadProgress {
  completed: number | null;
  total: number | null;
  running: boolean;
}

export type ConnectorDraft = {
  name: string;
  runtime: ConnectorRuntime;
  baseUrl?: string | null;
  apiKey?: string | null;
  model?: string | null;
  customHeaders?: Record<string, string> | null;
  executable?: string | null;
  isDefault?: boolean;
  sortOrder?: number;
};

export interface ProjectBotConfig {
  id: string;
  projectId: string;
  botId: string;
  enabled: boolean;
  runtime: TaskRuntime;
  workspacePath: string;
  knowledgeEnabled: boolean;
  codeSearchEnabled: boolean;
  hasSecret: boolean;
  connectionStatus: "disabled" | "disconnected" | "connecting" | "connected" | "error";
  lastConnectedAt: string | null;
  lastError: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export type ProjectBotDraft = {
  botId: string;
  secret?: string;
  enabled?: boolean;
  runtime: TaskRuntime;
  workspacePath: string;
  knowledgeEnabled?: boolean;
  codeSearchEnabled?: boolean;
};

export interface TaskboardCapabilities {
  localKnowledge?: boolean;
}

export type KnowledgeSourceType =
  | "project_scan"
  | "issue"
  | "comments"
  | "question"
  | "stale_refresh"
  | "project_review";

export type KnowledgeProposalStatus = "generating" | "ready" | "published" | "rejected" | "failed";
export type KnowledgeOperation = "create" | "update" | "delete";
export type KnowledgeHealthStatus = "fresh" | "stale" | "unverified" | "missing_sources";

export interface KnowledgeDevelopmentContext {
  type: "branch" | "worktree";
  branch: string | null;
}

export interface KnowledgeSourceState {
  type?: string;
  ref?: string;
  revision?: string;
  symbol?: string;
  actualRevision?: string | number | null;
  status: "fresh" | "stale" | "missing" | "unverified";
}

export interface KnowledgePageSummary {
  path: string;
  id: string;
  title: string;
  kind: string;
  updatedAt: string | null;
  health: KnowledgeHealthStatus;
  sources: KnowledgeSourceState[];
}

export interface KnowledgePage extends KnowledgePageSummary {
  content: string;
}

export interface KnowledgeOverview {
  initialized: boolean;
  pages: KnowledgePageSummary[];
  health: {
    fresh: number;
    stale: number;
    unverified: number;
    missingSources: number;
  };
  indexPath: string | null;
}

export interface KnowledgeSearchResult {
  path: string;
  title: string;
  kind: string;
  excerpt: string;
}

export interface KnowledgeProposalChange {
  id: string;
  proposalId?: string;
  targetPath: string;
  operation: KnowledgeOperation;
  baseDigest: string | null;
  beforeContent: string | null;
  afterContent: string | null;
  sortOrder: number;
}

export interface KnowledgeProposal {
  id: string;
  projectId: string;
  title: string;
  sourceType: KnowledgeSourceType;
  sourceSnapshot: Record<string, unknown>;
  developmentContext: KnowledgeDevelopmentContext | null;
  status: KnowledgeProposalStatus;
  summary: string;
  error: string | null;
  creator: Pick<ActorIdentity, "type" | "id" | "name">;
  publisher: Pick<ActorIdentity, "type" | "id" | "name"> | null;
  version: number;
  createdAt: string;
  updatedAt: string;
  publishedAt: string | null;
  changes: KnowledgeProposalChange[];
}

export interface GeneratedKnowledgeProposal {
  title: string;
  summary: string;
  sourceType: KnowledgeSourceType;
  sourceSnapshot: Record<string, unknown>;
  developmentContext: KnowledgeDevelopmentContext | null;
  changes: KnowledgeProposalChange[];
}

export interface KnowledgeAnswer {
  answer: string;
  citations: Array<{
    type: "knowledge" | "file" | "issue";
    ref: string;
    label: string;
  }>;
}

export interface WorkflowCapabilityOption {
  id: string;
  label: string;
  scope: "user" | "repo" | "system" | "admin";
}

export interface WorkflowMcpServerOption {
  id: string;
  label: string;
  transport: string;
}

export interface WorkflowCapabilities {
  skills: WorkflowCapabilityOption[];
  mcpServers: WorkflowMcpServerOption[];
}

export interface WorkflowOption {
  id: string;
  name: string;
}

export interface WorkflowWorkspaceRecord<T = unknown> {
  projectId: string;
  workspace: T | null;
  version: number;
  updatedAt: string | null;
}

export interface Project {
  id: string;
  name: string;
  workspacePath: string | null;
  issueCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface TaskRelationSummary {
  id: string;
  identifier: string;
  projectId: string;
  title: string;
  status: TaskStatus;
  priority: TaskPriority;
  assignee: ActorIdentity;
  archivedAt: string | null;
}

export interface TaskRelations {
  parent: TaskRelationSummary | null;
  subIssues: TaskRelationSummary[];
  blockedBy: TaskRelationSummary[];
  blocks: TaskRelationSummary[];
  related: TaskRelationSummary[];
}

export type DetachedTaskRelationType =
  | "parent"
  | "sub_issue"
  | "blocked_by"
  | "blocks"
  | "related";

export interface TaskProjectTransferResult {
  task: Task;
  previousProjectId: string;
  previousIdentifier: string;
  detachedRelations: Array<{
    type: DetachedTaskRelationType;
    task: TaskRelationSummary;
  }>;
}

export interface Task {
  id: string;
  identifier: string;
  projectId: string;
  title: string;
  description: string;
  status: TaskStatus;
  priority: TaskPriority;
  labels: string[];
  sortOrder: number;
  threadId: string | null;
  threadIds: string[];
  threadRuntimes: Record<string, TaskRuntime>;
  runtime: TaskRuntime;
  creatorType: ActorType;
  creatorId: string;
  creatorName: string;
  creatorAvatarUrl: string | null;
  assignee: ActorIdentity;
  workflowId: string | null;
  developmentContext: DevelopmentContext | null;
  dueDate: string | null;
  recurrence: Recurrence | null;
  archivedAt: string | null;
  relations: TaskRelations;
  version: number;
  createdAt: string;
  updatedAt: string;
  statusChangedAt: string;
  startDate: string | null;
}

export interface Comment {
  id: string;
  taskId: string;
  body: string;
  authorType: ActorType;
  authorId: string;
  authorName: string;
  authorAvatarUrl: string | null;
  threadId: string | null;
  attachments: Attachment[];
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface Attachment {
  id: string;
  taskId: string;
  commentId: string | null;
  filename: string;
  contentType: string;
  size: number;
  createdAt: string;
}

export interface CodexThreadSummary {
  id: string;
  title: string;
  projectId: string;
}

export interface HostContext {
  user?: ActorIdentity;
  workspacePath?: string;
  threadId?: string;
  theme?: "light" | "dark";
  projectId?: string;
  projects?: Array<{ id: string; name: string }>;
  threads?: CodexThreadSummary[];
  titlebarLeftInset?: number;
  sidebarCollapsed?: boolean;
}

export interface TaskDraft {
  title: string;
  description: string;
  status: TaskStatus;
  priority: TaskPriority;
  labels: string[];
  assigneeTarget?: AssigneeTarget;
  workflowId: string | null;
  developmentContext: DevelopmentContext | null;
  dueDate: string | null;
  startDate: string | null;
  recurrence: Recurrence | null;
}

export interface IssueDraft {
  id: string;
  projectId: string;
  content: TaskDraft;
  createdAt: string;
  updatedAt: string;
}

export interface TaskEvent {
  type: string;
  projectId?: string;
  taskId?: string;
  task?: Task;
  comment?: Comment;
  attachment?: Attachment;
  project?: Project;
  at: string;
}
