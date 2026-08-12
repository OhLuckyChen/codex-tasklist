import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type Dispatch,
  type SetStateAction,
} from "react";
import {
  isAutomationModel,
  isAutomationReasoningEffort,
  isSupportedModelEffort,
  type AutomationModel,
  type AutomationReasoningEffort,
} from "../../shared/taskboard-automation-options.mjs";
import { normalizeCodexThreadId } from "../../shared/codex-thread-id.mjs";
import {
  ApiError,
  addTaskRelation,
  archiveTask as archiveTaskRequest,
  chooseLocalDirectory,
  createProject as createProjectRequest,
  createTask as createTaskRequest,
  createKnowledgeRun,
  createKnowledgeProposal,
  createClaudeSession,
  createOmpSession,
  generateKnowledgeProposal,
  getCodexThreadProgress,
  getKnowledgeRun,
  resumeClaudeSession,
  resumeOmpSession,
  getWorkflowWorkspace,
  getTaskboardMetadata,
  linkTaskThread as linkTaskThreadRequest,
  listKnowledgeProposals,
  unlinkTaskThread as unlinkTaskThreadRequest,
  listComments,
  listConnectors,
  listDevelopmentContexts,
  listDeviceWorkspaces,
  setDeviceWorkspace,
  listProjects,
  listTasks,
  moveTask as moveTaskRequest,
  removeTaskRelation,
  setCurrentUserActor,
  transferTaskProject as transferTaskProjectRequest,
  uploadAttachment,
  updateComment as updateCommentRequest,
  updateKnowledgeProposal,
  updateTask as updateTaskRequest,
} from "./api";
import {
  actorForAssigneeTarget,
  assigneeTargetForActor,
} from "./actors";
import { BoardColumn, STATUS_DETAILS } from "./components/BoardColumn";
import { BoardSettingsMenu } from "./components/BoardSettingsMenu";
import { ConnectorsPanel } from "./components/ConnectorsPanel";
import { DraftBox } from "./components/DraftBox";
import { FavoriteTaskList } from "./components/FavoriteTaskList";
import { HiddenColumns } from "./components/HiddenColumns";
import { KnowledgeCenter } from "./components/KnowledgeCenter";
import {
  resolveInlineMediaMarkdown,
  type PendingInlineImage,
} from "./components/InlineMediaComposer";
import { LinearIcon } from "./components/LinearIcon";
import { ProjectAutomationMenu } from "./components/ProjectAutomationMenu";
import { ProjectCreator, type ProjectCreateDraft } from "./components/ProjectCreator";
import { TaskContextMenu } from "./components/TaskContextMenu";
import { TaskDetail } from "./components/TaskDetail";
import { TaskEditor } from "./components/TaskEditor";
import { TaskFilterMenu } from "./components/TaskFilterMenu";
import { buildIssueUrl, readIssueIdentifier } from "./issueRoute";
import { DEFAULT_LABELS } from "./labels";
import {
  EMPTY_TASK_FILTERS,
  matchesTaskFilters,
  matchesTaskSearch,
  readTaskFilters,
  taskFilterCount,
  writeTaskFilters,
} from "./taskFilters";
import {
  taskThreadRuntime,
} from "./taskConversations";
import {
  TASK_STATUSES,
  type ActorIdentity,
  type CodexThreadSummary,
  type Comment,
  type DevelopmentScan,
  type GeneratedKnowledgeProposal,
  type HostContext,
  type IssueDraft,
  type IssueRelationType,
  type KnowledgeDevelopmentContext,
  type KnowledgeSourceType,
  type Project,
  type Task,
  type CodexThreadProgress,
  type Connector,
  type TaskboardMetadata,
  type TaskDraft,
  type TaskRuntime,
  type TaskStatus,
  type WorkflowOption,
} from "./types";
import {
  DEFAULT_WORKFLOW_OPTIONS,
  readLegacyWorkflowWorkspace,
  workflowOptionsFromWorkspace,
} from "./workflowStore";
type ConnectionState = "connecting" | "live" | "reconnecting";
type Theme = "light" | "dark";
type BoardView = "issues" | "drafts" | "knowledge" | "workflow";
const SHOW_WORKFLOW_BOARD_ENTRY = false;
const GLOBAL_PROJECT_ID = "__all_projects__";
const GLOBAL_VIEW_QUERY_PARAM = "view";
const GLOBAL_VIEW_QUERY_VALUE = "global";

const WorkflowBoard = lazy(() => import("./components/WorkflowBoard").then((module) => ({
  default: module.WorkflowBoard,
})));

interface EditorState {
  task: Task | null;
  status: TaskStatus;
  projectId: string;
  draft?: IssueDraft;
  parentTaskId?: string;
}

interface ContextMenuState {
  taskId: string;
  x: number;
  y: number;
}

interface ProjectChoice {
  id: string;
  name: string;
  sourceName: string;
  issueCount: number;
  inCodex: boolean;
  persisted: boolean;
  createdAt: string;
  sourceOrder: number;
}

interface UndoOperation {
  id: number;
  message: string;
  undo: () => Promise<void>;
}

interface UndoNotice {
  id: number;
  message: string;
}

type ColumnVisibilityByProject = Record<string, Partial<Record<TaskStatus, boolean>>>;
type ProjectAutomationStatus = "ACTIVE" | "PAUSED";
type AutomationQuotaState = "available" | "blocked" | "unknown" | "unavailable";
type AutomationIntervalMinutes = 5 | 10 | 15 | 30 | 60;

interface PendingThreadRequest {
  taskId: string;
  projectId: string;
  commentId?: string;
  action?: "create" | "follow-up";
  threadId?: string;
  createdAt: number;
}

interface AutomationQuotaStatus {
  state: AutomationQuotaState;
  checkedAt: number;
  resetsAt?: number;
  reason?: "api-key";
}

interface ProjectAutomationRecord {
  automationId?: string;
  codexProjectId: string;
  status: ProjectAutomationStatus;
  enabledByUser: boolean;
  quotaAware: boolean;
  quota?: AutomationQuotaStatus;
  intervalMinutes: AutomationIntervalMinutes;
  model: AutomationModel;
  reasoningEffort: AutomationReasoningEffort;
}

type ProjectAutomations = Record<string, ProjectAutomationRecord>;

interface AutomationHostItem {
  id: string;
  status: ProjectAutomationStatus;
  model: AutomationModel;
  reasoningEffort: AutomationReasoningEffort;
  rrule: string;
}

interface AutomationHostResponse {
  requestId: string;
  ok: boolean;
  item?: AutomationHostItem;
  items?: AutomationHostItem[];
  quota?: AutomationQuotaStatus;
  policy?: {
    automationId?: string;
    enabledByUser: boolean;
    quotaAware: boolean;
    intervalMinutes: AutomationIntervalMinutes;
    model: AutomationModel;
    reasoningEffort: AutomationReasoningEffort;
  };
  error?: string;
}

interface PendingAutomationRequest {
  resolve: (response: AutomationHostResponse) => void;
  reject: (error: Error) => void;
  timeoutId: number;
}

interface CodexProjectActivationResponse {
  requestId: string;
  ok: boolean;
  project?: { id: string; name: string };
  error?: string;
}

interface PendingProjectActivation {
  resolve: (response: CodexProjectActivationResponse) => void;
  reject: (error: Error) => void;
  timeoutId: number;
}

interface PendingKnowledgeThread {
  resolve: () => void;
  reject: (error: Error) => void;
  timeoutId: number;
}

const DEFAULT_USER_ACTOR: ActorIdentity = {
  type: "user",
  id: "local-user",
  name: "本地用户",
  avatarUrl: null,
};

const LAST_PROJECT_KEY = "taskboard.lastProjectId";
const PENDING_THREAD_REQUESTS_KEY = "taskboard.pendingThreadRequests.v1";
const PENDING_THREAD_REQUEST_TTL_MS = 5 * 60 * 1_000;
const FAVORITE_PROJECTS_KEY = "taskboard.favoriteProjectIds";
const FAVORITE_TASKS_KEY = "taskboard.favoriteTaskIds.v1";
const FAVORITE_VIEW_MODE_KEY = "taskboard.favoriteTaskViewMode.v1";
const PROJECT_ALIASES_KEY = "taskboard.projectAliases.v1";
const PROJECT_ORDER_KEY = "taskboard.projectOrder.v1";
const ARCHIVED_PROJECTS_KEY = "taskboard.archivedProjectIds.v1";
const PROJECT_HOME_MODE_KEY = "taskboard.projectHomeMode.v1";
const DEVICE_WORKSPACE_PATHS_KEY = "taskboard.deviceWorkspacePaths.v1";
const SHOW_EMPTY_COLUMNS_KEY = "taskboard.showEmptyColumns.v1";
const COLUMN_VISIBILITY_KEY = "taskboard.columnVisibility.v1";
const GLOBAL_COLUMN_VISIBILITY_KEY = "taskboard.globalColumnVisibility.v1";
const COLUMN_ORDER_KEY = "taskboard.columnOrder.v1";
const PROJECT_BOARD_VIEW_KEY = "taskboard.projectBoardView.v1";
const PROJECT_AUTOMATIONS_KEY = "taskboard.projectAutomations.v1";
const ISSUE_DRAFTS_KEY = "taskboard.issueDrafts.v1";
const DEFAULT_AUTOMATION_OPTIONS = {
  enabledByUser: false,
  quotaAware: false,
  intervalMinutes: 5,
  model: "gpt-5.5",
  reasoningEffort: "high",
} as const;

const EVENT_NAMES = [
  "task.created",
  "task.updated",
  "task.moved",
  "task.archived",
  "task.restored",
  "task.relation.updated",
  "comment.created",
  "comment.updated",
  "comment.deleted",
  "attachment.created",
  "attachment.deleted",
  "project.created",
  "workflow.updated",
  "knowledge-proposal.created",
  "knowledge-proposal.updated",
] as const;

function isTheme(value: unknown): value is Theme {
  return value === "light" || value === "dark";
}

function getInitialTheme(): Theme {
  const fromQuery = new URLSearchParams(window.location.search).get("theme");
  if (isTheme(fromQuery)) return fromQuery;
  const stored = window.localStorage.getItem("taskboard.theme");
  if (isTheme(stored)) return stored;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function readFavoriteProjectIds(): Set<string> {
  try {
    const value = JSON.parse(window.localStorage.getItem(FAVORITE_PROJECTS_KEY) ?? "[]");
    return new Set(Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []);
  } catch {
    return new Set();
  }
}

function readFavoriteTaskIds(): Set<string> {
  try {
    const value = JSON.parse(window.localStorage.getItem(FAVORITE_TASKS_KEY) ?? "[]");
    return new Set(Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []);
  } catch {
    return new Set();
  }
}

function readFavoriteViewMode(): "list" | "board" {
  return window.localStorage.getItem(FAVORITE_VIEW_MODE_KEY) === "list" ? "list" : "board";
}

function readProjectAliases(): Record<string, string> {
  try {
    const value = JSON.parse(window.localStorage.getItem(PROJECT_ALIASES_KEY) ?? "{}");
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => (
      typeof entry[1] === "string" && entry[1].trim().length > 0
    )));
  } catch {
    return {};
  }
}

function readProjectOrder(): string[] {
  try {
    const value = JSON.parse(window.localStorage.getItem(PROJECT_ORDER_KEY) ?? "[]");
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function readArchivedProjectIds(): Set<string> {
  try {
    const value = JSON.parse(window.localStorage.getItem(ARCHIVED_PROJECTS_KEY) ?? "[]");
    return new Set(Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []);
  } catch {
    return new Set();
  }
}

function readProjectHomeMode(): "groups" | "priority" {
  return window.localStorage.getItem(PROJECT_HOME_MODE_KEY) === "priority" ? "priority" : "groups";
}

function readPendingThreadRequests(): Map<string, PendingThreadRequest> {
  const result = new Map<string, PendingThreadRequest>();
  try {
    const value = JSON.parse(window.localStorage.getItem(PENDING_THREAD_REQUESTS_KEY) ?? "{}");
    if (!value || typeof value !== "object" || Array.isArray(value)) return result;
    const cutoff = Date.now() - PENDING_THREAD_REQUEST_TTL_MS;
    for (const [requestId, request] of Object.entries(value)) {
      if (!request || typeof request !== "object" || Array.isArray(request)) continue;
      const candidate = request as Partial<PendingThreadRequest>;
      if (
        typeof requestId !== "string"
        || typeof candidate.taskId !== "string"
        || typeof candidate.projectId !== "string"
        || (candidate.commentId !== undefined && typeof candidate.commentId !== "string")
        || (candidate.action !== undefined && candidate.action !== "create" && candidate.action !== "follow-up")
        || (candidate.threadId !== undefined && typeof candidate.threadId !== "string")
        || typeof candidate.createdAt !== "number"
        || candidate.createdAt < cutoff
      ) continue;
      result.set(requestId, candidate as PendingThreadRequest);
    }
  } catch {}
  writePendingThreadRequests(result);
  return result;
}

function writePendingThreadRequests(requests: Map<string, PendingThreadRequest>): void {
  if (requests.size === 0) {
    window.localStorage.removeItem(PENDING_THREAD_REQUESTS_KEY);
    return;
  }
  window.localStorage.setItem(
    PENDING_THREAD_REQUESTS_KEY,
    JSON.stringify(Object.fromEntries(requests)),
  );
}

function readDeviceWorkspacePaths(): Record<string, string> {
  try {
    const value = JSON.parse(window.localStorage.getItem(DEVICE_WORKSPACE_PATHS_KEY) ?? "{}");
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => (
      typeof entry[1] === "string" && entry[1].trim().length > 0
    )));
  } catch {
    return {};
  }
}

function readShowEmptyColumns(): boolean {
  return window.localStorage.getItem(SHOW_EMPTY_COLUMNS_KEY) === "true";
}

function readProjectAutomations(): ProjectAutomations {
  try {
    const value = JSON.parse(window.localStorage.getItem(PROJECT_AUTOMATIONS_KEY) ?? "{}");
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    const result: ProjectAutomations = {};
    for (const [projectId, record] of Object.entries(value)) {
      if (!record || typeof record !== "object" || Array.isArray(record)) continue;
      const candidate = record as Partial<ProjectAutomationRecord>;
      const model = candidate.model ?? "gpt-5.5";
      const reasoningEffort = candidate.reasoningEffort ?? "high";
      const enabledByUser = candidate.enabledByUser ?? candidate.status === "ACTIVE";
      const quotaAware = candidate.quotaAware ?? false;
      if (
        (candidate.automationId !== undefined && typeof candidate.automationId !== "string")
        || typeof candidate.codexProjectId !== "string"
        || (candidate.status !== "ACTIVE" && candidate.status !== "PAUSED")
        || !isAutomationIntervalMinutes(candidate.intervalMinutes ?? 5)
        || !isAutomationModel(model)
        || !isAutomationReasoningEffort(reasoningEffort)
        || !isSupportedModelEffort(model, reasoningEffort)
        || (candidate.status === "ACTIVE" && !candidate.automationId)
        || typeof enabledByUser !== "boolean"
        || typeof quotaAware !== "boolean"
      ) continue;
      const quota = isAutomationQuotaStatus(candidate.quota) ? candidate.quota : undefined;
      result[projectId] = {
        automationId: candidate.automationId,
        codexProjectId: candidate.codexProjectId,
        status: candidate.status,
        enabledByUser,
        quotaAware,
        ...(quota ? { quota } : {}),
        intervalMinutes: candidate.intervalMinutes ?? 5,
        model,
        reasoningEffort,
      };
    }
    return result;
  } catch {
    return {};
  }
}

function isAutomationQuotaStatus(value: unknown): value is AutomationQuotaStatus {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Partial<AutomationQuotaStatus>;
  return (
    (candidate.state === "available"
      || candidate.state === "blocked"
      || candidate.state === "unknown"
      || candidate.state === "unavailable")
    && Number.isFinite(candidate.checkedAt)
    && (candidate.resetsAt === undefined || Number.isFinite(candidate.resetsAt))
    && (candidate.reason === undefined || candidate.reason === "api-key")
  );
}

function isAutomationHostPolicy(
  value: AutomationHostResponse["policy"] | undefined,
): value is NonNullable<AutomationHostResponse["policy"]> {
  return Boolean(
    value
    && (value.automationId === undefined || typeof value.automationId === "string")
    && typeof value.enabledByUser === "boolean"
    && typeof value.quotaAware === "boolean"
    && isAutomationIntervalMinutes(value.intervalMinutes)
    && isAutomationModel(value.model)
    && isAutomationReasoningEffort(value.reasoningEffort)
    && isSupportedModelEffort(value.model, value.reasoningEffort),
  );
}

function isAutomationIntervalMinutes(value: unknown): value is AutomationIntervalMinutes {
  return value === 5 || value === 10 || value === 15 || value === 30 || value === 60;
}

function intervalMinutesFromRrule(value: string): AutomationIntervalMinutes | null {
  const match = /^RRULE:FREQ=MINUTELY;INTERVAL=(5|10|15|30|60)$/.exec(value);
  return match ? Number(match[1]) as AutomationIntervalMinutes : null;
}

function readColumnVisibilityByProject(): ColumnVisibilityByProject {
  try {
    const value = JSON.parse(window.localStorage.getItem(COLUMN_VISIBILITY_KEY) ?? "{}");
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    const result: ColumnVisibilityByProject = {};
    for (const [projectId, visibilityValue] of Object.entries(value)) {
      if (!visibilityValue || typeof visibilityValue !== "object" || Array.isArray(visibilityValue)) continue;
      const visibility: Partial<Record<TaskStatus, boolean>> = {};
      for (const status of TASK_STATUSES) {
        const visible = (visibilityValue as Record<string, unknown>)[status];
        if (typeof visible === "boolean") visibility[status] = visible;
      }
      result[projectId] = visibility;
    }
    return result;
  } catch {
    return {};
  }
}

function readGlobalColumnVisibility(): Partial<Record<TaskStatus, boolean>> | null {
  try {
    const raw = window.localStorage.getItem(GLOBAL_COLUMN_VISIBILITY_KEY);
    if (raw === null) return null;
    const value = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const visibility: Partial<Record<TaskStatus, boolean>> = {};
    for (const status of TASK_STATUSES) {
      const visible = (value as Record<string, unknown>)[status];
      if (typeof visible === "boolean") visibility[status] = visible;
    }
    return visibility;
  } catch {
    return null;
  }
}

function readColumnOrder(): TaskStatus[] {
  try {
    const value = JSON.parse(window.localStorage.getItem(COLUMN_ORDER_KEY) ?? "[]");
    if (!Array.isArray(value)) return [...TASK_STATUSES];
    const stored = value.filter(
      (status, index): status is TaskStatus => (
        TASK_STATUSES.includes(status as TaskStatus) && value.indexOf(status) === index
      ),
    );
    return [...stored, ...TASK_STATUSES.filter((status) => !stored.includes(status))];
  } catch {
    return [...TASK_STATUSES];
  }
}

function readIssueDrafts(): IssueDraft[] {
  try {
    const value = JSON.parse(window.localStorage.getItem(ISSUE_DRAFTS_KEY) ?? "[]");
    if (!Array.isArray(value)) return [];
    return value.filter((candidate): candidate is IssueDraft => {
      if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return false;
      const draft = candidate as Partial<IssueDraft>;
      const content = draft.content as Partial<TaskDraft> | undefined;
      return (
        typeof draft.id === "string"
        && typeof draft.projectId === "string"
        && typeof draft.createdAt === "string"
        && typeof draft.updatedAt === "string"
        && content !== undefined
        && typeof content.title === "string"
        && typeof content.description === "string"
        && TASK_STATUSES.includes(content.status as TaskStatus)
        && Array.isArray(content.labels)
      );
    }).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  } catch {
    return [];
  }
}

function persistIssueDrafts(drafts: IssueDraft[]) {
  window.localStorage.setItem(ISSUE_DRAFTS_KEY, JSON.stringify(drafts));
}

function workspaceName(path?: string): string | null {
  if (!path) return null;
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.at(-1) ?? path;
}

function isAbsoluteWorkspacePath(path: string): boolean {
  return path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path);
}

function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return "Something went wrong while loading your issues.";
}

function isAutomationHostItem(value: unknown): value is AutomationHostItem {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Partial<AutomationHostItem>;
  return (
    typeof item.id === "string"
    && (item.status === "ACTIVE" || item.status === "PAUSED")
    && isAutomationModel(item.model)
    && isAutomationReasoningEffort(item.reasoningEffort)
    && isSupportedModelEffort(item.model, item.reasoningEffort)
    && typeof item.rrule === "string"
    && intervalMinutesFromRrule(item.rrule) !== null
  );
}

function isLocalTaskboardOrigin(origin: string): boolean {
  try {
    const { protocol, hostname } = new URL(origin);
    return (protocol === "http:" || protocol === "https:")
      && (hostname === "127.0.0.1" || hostname === "localhost");
  } catch {
    return false;
  }
}

function sortTasks(tasks: Task[]): Task[] {
  return [...tasks].sort(
    (left, right) => left.sortOrder - right.sortOrder || left.createdAt.localeCompare(right.createdAt),
  );
}

function isProjectBoardView(value: string | null): value is BoardView {
  return value === "issues"
    || value === "drafts"
    || value === "knowledge"
    || value === "workflow";
}

function readProjectBoardViews(): Record<string, BoardView> {
  try {
    const value = JSON.parse(window.localStorage.getItem(PROJECT_BOARD_VIEW_KEY) ?? "{}");
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, BoardView] => (
      typeof entry[0] === "string" && isProjectBoardView(typeof entry[1] === "string" ? entry[1] : null)
    )));
  } catch {
    return {};
  }
}

function readProjectBoardView(projectId: string): BoardView {
  return readProjectBoardViews()[projectId] ?? "issues";
}

function writeProjectBoardView(projectId: string, view: BoardView) {
  if (!projectId || projectId === GLOBAL_PROJECT_ID) return;
  const next = { ...readProjectBoardViews(), [projectId]: view };
  window.localStorage.setItem(PROJECT_BOARD_VIEW_KEY, JSON.stringify(next));
}

function taskToDraft(task: Task): TaskDraft {
  return {
    title: task.title,
    description: task.description,
    status: task.status,
    priority: task.priority,
    labels: task.labels,
    workflowId: task.workflowId,
    developmentContext: task.developmentContext,
    dueDate: task.dueDate,
    startDate: task.startDate,
    recurrence: task.recurrence,
  };
}

interface LocalRealtimeSyncProps {
  selectedProjectId: string;
  detailTaskId: string | null;
  onTaskChange: (task: Task) => void;
  refreshProjectList: () => Promise<void>;
  refreshTasks: (
    projectId: string,
    options?: { quiet?: boolean; signal?: AbortSignal },
  ) => Promise<void>;
  refreshWorkflowOptions: (projectId: string, signal?: AbortSignal) => Promise<void>;
  setConnection: Dispatch<SetStateAction<ConnectionState>>;
  setCommentsRevision: Dispatch<SetStateAction<number>>;
  setAttachmentsRevision: Dispatch<SetStateAction<number>>;
  setKnowledgeRevision: Dispatch<SetStateAction<number>>;
}

function LocalRealtimeSync({
  selectedProjectId,
  detailTaskId,
  onTaskChange,
  refreshProjectList,
  refreshTasks,
  refreshWorkflowOptions,
  setConnection,
  setCommentsRevision,
  setAttachmentsRevision,
  setKnowledgeRevision,
}: LocalRealtimeSyncProps) {
  const isGlobalBoard = selectedProjectId === GLOBAL_PROJECT_ID;
  useEffect(() => {
    const source = new EventSource("/api/events");
    let refreshTimer: number | undefined;
    let refreshProjectsPending = false;
    let refreshTasksPending = false;

    const scheduleRefresh = (options: { projects?: boolean; tasks?: boolean }) => {
      refreshProjectsPending ||= options.projects === true;
      refreshTasksPending ||= options.tasks === true;
      window.clearTimeout(refreshTimer);
      refreshTimer = window.setTimeout(() => {
        if (refreshProjectsPending) void refreshProjectList();
        if (refreshTasksPending && selectedProjectId) {
          void refreshTasks(selectedProjectId, { quiet: true });
        }
        refreshProjectsPending = false;
        refreshTasksPending = false;
      }, 120);
    };

    const handleEvent = (event: Event) => {
      const message = event as MessageEvent<string>;
      let payload: { projectId?: string; taskId?: string; task?: Task } = {};
      try {
        payload = JSON.parse(message.data) as { projectId?: string; taskId?: string; task?: Task };
      } catch {
        // A malformed event should not interrupt later updates.
      }
      const affectsSelectedProject = Boolean(selectedProjectId)
        && (isGlobalBoard || !payload.projectId || payload.projectId === selectedProjectId);
      if (event.type === "project.created") {
        scheduleRefresh({ projects: true });
        return;
      }
      if (event.type.startsWith("task.")) {
        if (payload.task) onTaskChange(payload.task);
        scheduleRefresh({ projects: true, tasks: affectsSelectedProject });
        return;
      }
      if (!affectsSelectedProject) return;
      if (event.type === "workflow.updated") {
        if (selectedProjectId && !isGlobalBoard) void refreshWorkflowOptions(selectedProjectId);
        return;
      }
      if (event.type.startsWith("comment.")) {
        if (!detailTaskId || !payload.taskId || payload.taskId === detailTaskId) {
          setCommentsRevision((current) => current + 1);
        }
        scheduleRefresh({ tasks: true });
        return;
      }
      if (event.type.startsWith("knowledge-proposal.")) {
        setKnowledgeRevision((current) => current + 1);
        return;
      }
      if (event.type.startsWith("attachment.")) {
        if (!detailTaskId || !payload.taskId || payload.taskId === detailTaskId) {
          setAttachmentsRevision((current) => current + 1);
          setCommentsRevision((current) => current + 1);
        }
      }
    };

    EVENT_NAMES.forEach((name) => source.addEventListener(name, handleEvent));
    source.onopen = () => {
      setConnection("live");
      scheduleRefresh({ projects: true, tasks: Boolean(selectedProjectId) });
      if (selectedProjectId && !isGlobalBoard) void refreshWorkflowOptions(selectedProjectId);
      if (detailTaskId) {
        setCommentsRevision((current) => current + 1);
        setAttachmentsRevision((current) => current + 1);
      }
    };
    source.onerror = () => setConnection("reconnecting");

    return () => {
      window.clearTimeout(refreshTimer);
      EVENT_NAMES.forEach((name) => source.removeEventListener(name, handleEvent));
      source.close();
    };
  }, [
    detailTaskId,
    isGlobalBoard,
    onTaskChange,
    refreshProjectList,
    refreshTasks,
    refreshWorkflowOptions,
    selectedProjectId,
    setAttachmentsRevision,
    setKnowledgeRevision,
    setCommentsRevision,
    setConnection,
  ]);

  return null;
}

export function App() {
  const query = useMemo(() => new URLSearchParams(window.location.search), []);
  const embedded = query.get("host") === "codex";
  const undoShortcut = navigator.userAgent.includes("Macintosh") ? "⌘Z" : "Ctrl+Z";
  const [theme, setTheme] = useState<Theme>(getInitialTheme);
  const [hostContext, setHostContext] = useState<HostContext | null>(null);
  const [developmentScan, setDevelopmentScan] = useState<DevelopmentScan>({ workspacePath: null, contexts: [] });
  const [developmentScanLoading, setDevelopmentScanLoading] = useState(false);
  const [manageTaskboardSkillPath, setManageTaskboardSkillPath] = useState("");
  const [projectKnowledgeSkillPath, setProjectKnowledgeSkillPath] = useState("");
  const [claudeRuntimeSupported, setClaudeRuntimeSupported] = useState(false);
  const [ompRuntimeSupported, setOmpRuntimeSupported] = useState(false);
  const [taskboardMetadata, setTaskboardMetadata] = useState<TaskboardMetadata | null>(null);
  const [connectors, setConnectors] = useState<Connector[]>([]);
  const [showConnectorsPanel, setShowConnectorsPanel] = useState(false);
  const [localKnowledgeAvailable, setLocalKnowledgeAvailable] = useState(false);
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState("");
  const [tasks, setTasks] = useState<Task[]>([]);
  const [codexThreadProgress, setCodexThreadProgress] = useState<
    Record<string, CodexThreadProgress | null>
  >({});
  const [projectsLoading, setProjectsLoading] = useState(true);
  const [tasksLoading, setTasksLoading] = useState(false);
  const [hasLoadedTasks, setHasLoadedTasks] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [connection, setConnection] = useState<ConnectionState>("connecting");
  const [search, setSearch] = useState("");
  const [filters, setFilters] = useState(readTaskFilters);
  const [showEmptyColumns] = useState(readShowEmptyColumns);
  const [columnVisibilityByProject, setColumnVisibilityByProject] = useState(readColumnVisibilityByProject);
  const [globalColumnVisibility, setGlobalColumnVisibility] = useState(readGlobalColumnVisibility);
  const [columnOrder, setColumnOrder] = useState(readColumnOrder);
  const [boardView, setBoardView] = useState<BoardView>(() => (
    selectedProjectId ? readProjectBoardView(selectedProjectId) : "issues"
  ));
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [issueDrafts, setIssueDrafts] = useState(readIssueDrafts);
  const [detailTaskIdentifier, setDetailTaskIdentifier] = useState<string | null>(
    () => readIssueIdentifier(window.location.search),
  );
  const [commentsRevision, setCommentsRevision] = useState(0);
  const [attachmentsRevision, setAttachmentsRevision] = useState(0);
  const [workflowRevision, setWorkflowRevision] = useState(0);
  const [knowledgeRevision, setKnowledgeRevision] = useState(0);
  const [knowledgeProposalCount, setKnowledgeProposalCount] = useState(0);
  const [workflowOptions, setWorkflowOptions] = useState<WorkflowOption[]>(DEFAULT_WORKFLOW_OPTIONS);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [draggedTaskId, setDraggedTaskId] = useState<string | null>(null);
  const [draggedTaskHeight, setDraggedTaskHeight] = useState(0);
  const [dropTarget, setDropTarget] = useState<TaskStatus | null>(null);
  const [draggedColumnStatus, setDraggedColumnStatus] = useState<TaskStatus | null>(null);
  const [columnDropTarget, setColumnDropTarget] = useState<{
    status: TaskStatus;
    position: "before" | "after";
  } | null>(null);
  const [movingTaskId, setMovingTaskId] = useState<string | null>(null);
  const [settlingTaskId, setSettlingTaskId] = useState<string | null>(null);
  const [openingProjectId, setOpeningProjectId] = useState<string | null>(null);
  const [openingThreadTaskId, setOpeningThreadTaskId] = useState<string | null>(null);
  const pendingThreadRequestsRef = useRef(readPendingThreadRequests());
  const finalizingThreadRequestsRef = useRef(new Set<string>());
  const [projectMenuOpen, setProjectMenuOpen] = useState(false);
  const [favoriteProjectIds, setFavoriteProjectIds] = useState(readFavoriteProjectIds);
  const [favoriteTaskIds, setFavoriteTaskIds] = useState(readFavoriteTaskIds);
  const [favoriteTasksOnly, setFavoriteTasksOnly] = useState(false);
  const [favoriteViewMode, setFavoriteViewMode] = useState(readFavoriteViewMode);
  const [projectAliases, setProjectAliases] = useState(readProjectAliases);
  const [projectOrder, setProjectOrder] = useState(readProjectOrder);
  const [archivedProjectIds, setArchivedProjectIds] = useState(readArchivedProjectIds);
  const [projectHomeMode, setProjectHomeMode] = useState(readProjectHomeMode);
  const [projectCreatorOpen, setProjectCreatorOpen] = useState(false);
  const [projectCreatePending, setProjectCreatePending] = useState(false);
  const [showArchivedProjects, setShowArchivedProjects] = useState(false);
  const [renamingProjectId, setRenamingProjectId] = useState<string | null>(null);
  const [projectNameDraft, setProjectNameDraft] = useState("");
  const [draggedProjectId, setDraggedProjectId] = useState<string | null>(null);
  const [deviceWorkspacePaths, setDeviceWorkspacePaths] = useState(readDeviceWorkspacePaths);
  const [projectAutomations, setProjectAutomations] = useState(readProjectAutomations);
  const [automationPending, setAutomationPending] = useState(false);
  const [automationError, setAutomationError] = useState<string | null>(null);
  const [announcement, setAnnouncementValue] = useState("");
  const [undoNotice, setUndoNotice] = useState<UndoNotice | null>(null);
  const tasksRequestRef = useRef(0);
  const tasksRef = useRef<Task[]>([]);
  const reviewTaskSnapshotsRef = useRef(new Map<string, Pick<Task, "status" | "version">>());
  const reviewTaskSnapshotsReadyRef = useRef(false);
  const undoSequenceRef = useRef(0);
  const undoStackRef = useRef<UndoOperation[]>([]);
  const undoInFlightRef = useRef(false);
  const dragRegionRef = useRef<HTMLDivElement>(null);
  const selectedProjectIdRef = useRef(selectedProjectId);
  selectedProjectIdRef.current = selectedProjectId;

  const pendingAutomationRequestsRef = useRef(new Map<string, PendingAutomationRequest>());
  const pendingProjectActivationsRef = useRef(new Map<string, PendingProjectActivation>());
  const pendingKnowledgeThreadsRef = useRef(new Map<string, PendingKnowledgeThread>());
  const automationRequestInFlightRef = useRef(false);
  const projectAutomationsRef = useRef(projectAutomations);

  const setAnnouncement = useCallback((message: string) => {
    setUndoNotice(null);
    setAnnouncementValue(message);
  }, []);

  const showReviewNotification = useCallback((task: Task) => {
    const threadId = normalizeCodexThreadId(task.threadId ?? "");
    if (!threadId || typeof Notification !== "function" || Notification.permission !== "granted") return;
    const notification = new Notification("任务已完成，等待审核", {
      body: `${task.identifier} · ${task.title}`,
      tag: `taskboard-review-${task.id}-${task.version}`,
    });
    notification.onclick = () => {
      notification.close();
      window.focus();
      openThread(threadId);
    };
  }, [embedded]);

  const recordReviewTaskChange = useCallback((task: Task) => {
    const previous = reviewTaskSnapshotsRef.current.get(task.id);
    reviewTaskSnapshotsRef.current.set(task.id, {
      status: task.status,
      version: task.version,
    });
    if (
      reviewTaskSnapshotsReadyRef.current
      && previous
      && previous.status !== "in_review"
      && task.status === "in_review"
    ) {
      showReviewNotification(task);
    }
  }, [showReviewNotification]);

  const refreshReviewTaskSnapshots = useCallback(async (
    notifyChanges: boolean,
    signal?: AbortSignal,
  ) => {
    try {
      const nextTasks = await listTasks(undefined, signal);
      if (signal?.aborted) return;
      const previousSnapshots = reviewTaskSnapshotsRef.current;
      const nextSnapshots = new Map<string, Pick<Task, "status" | "version">>();
      for (const task of nextTasks) {
        const previous = previousSnapshots.get(task.id);
        nextSnapshots.set(task.id, { status: task.status, version: task.version });
        if (
          notifyChanges
          && reviewTaskSnapshotsReadyRef.current
          && previous
          && previous.status !== "in_review"
          && task.status === "in_review"
        ) {
          showReviewNotification(task);
        }
      }
      reviewTaskSnapshotsRef.current = nextSnapshots;
      reviewTaskSnapshotsReadyRef.current = true;
    } catch (error) {
      if ((error as Error).name !== "AbortError") {
        // Notification synchronization must not interrupt the board itself.
      }
    }
  }, [showReviewNotification]);

  const activateCodexProject = useCallback((draft: ProjectCreateDraft) => {
    if (!embedded || window.parent === window) {
      return Promise.resolve<CodexProjectActivationResponse>({ requestId: "standalone", ok: true });
    }
    const requestId = crypto.randomUUID();
    return new Promise<CodexProjectActivationResponse>((resolve, reject) => {
      const timeoutId = window.setTimeout(() => {
        pendingProjectActivationsRef.current.delete(requestId);
        reject(new Error("Codex 项目同步超时，请确认目录存在后重试。"));
      }, 8_000);
      pendingProjectActivationsRef.current.set(requestId, { resolve, reject, timeoutId });
      window.parent.postMessage({
        type: "taskboard:activate-project",
        payload: {
          requestId,
          projectName: draft.name,
          workspacePath: draft.workspacePath,
        },
      }, "*");
    });
  }, [embedded]);

  const rememberDeviceWorkspacePath = useCallback((projectId: string, workspacePath: string) => {
    const normalizedPath = workspacePath.trim();
    setDeviceWorkspacePaths((current) => {
      if (current[projectId] === normalizedPath || (!normalizedPath && !(projectId in current))) {
        return current;
      }
      const next = { ...current };
      if (normalizedPath) next[projectId] = normalizedPath;
      else delete next[projectId];
      window.localStorage.setItem(DEVICE_WORKSPACE_PATHS_KEY, JSON.stringify(next));
      return next;
    });
  }, []);

  const saveDeviceWorkspacePath = useCallback(async (projectId: string, workspacePath: string) => {
    const normalizedPath = workspacePath.trim();
    if (!isAbsoluteWorkspacePath(normalizedPath)) {
      setActionError("本地项目目录必须填写绝对路径。");
      return;
    }
    setActionError(null);
    try {
      await setDeviceWorkspace(projectId, normalizedPath);
      rememberDeviceWorkspacePath(projectId, normalizedPath);
      setAnnouncement("本地项目目录已保存。");
    } catch (error) {
      setActionError(errorMessage(error));
    }
  }, [rememberDeviceWorkspacePath]);

  const isGlobalBoard = selectedProjectId === GLOBAL_PROJECT_ID;
  const selectedProject = projects.find((project) => project.id === selectedProjectId) ?? null;
  const projectNames = useMemo(
    () => Object.fromEntries(projects.map((project) => [
      project.id,
      projectAliases[project.id] ?? project.name,
    ])),
    [projectAliases, projects],
  );
  const visibleIssueDrafts = useMemo(
    () => (isGlobalBoard
      ? issueDrafts
      : issueDrafts.filter((draft) => draft.projectId === selectedProjectId)),
    [isGlobalBoard, issueDrafts, selectedProjectId],
  );
  const currentUser = hostContext?.user ?? DEFAULT_USER_ACTOR;
  const selectedDeviceWorkspacePath = deviceWorkspacePaths[selectedProjectId];
  const selectedProjectAutomation = projectAutomations[selectedProjectId];
  const automationProjectContext = useMemo(() => {
    if (!embedded || window.parent === window) {
      return { unavailableReason: "仅可在 Codex App 中使用" };
    }
    if (!isLocalTaskboardOrigin(window.location.origin)) {
      return { unavailableReason: "仅本地任务面板可用" };
    }
    if (!selectedProject) return { unavailableReason: "请先选择项目" };

    const directCodexProject = hostContext?.projects?.some(
      (project) => project.id === selectedProject.id,
    );
    const workspacePath = deviceWorkspacePaths[selectedProject.id]
      ?? selectedProject.workspacePath
      ?? (
        directCodexProject && hostContext?.projectId === selectedProject.id
          ? hostContext.workspacePath
          : undefined
      );
    const codexProjectId = directCodexProject
      ? selectedProject.id
      : hostContext?.projects?.find(
        (project) => deviceWorkspacePaths[project.id] === workspacePath,
      )?.id;

    if (!workspacePath || !codexProjectId) {
      return { unavailableReason: "请先在 Codex 中添加并映射该项目目录" };
    }
    if (!manageTaskboardSkillPath) {
      return { unavailableReason: "任务面板还没有读取到 Skill 路径" };
    }
    return { workspacePath, codexProjectId, unavailableReason: null };
  }, [
    deviceWorkspacePaths,
    embedded,
    hostContext,
    manageTaskboardSkillPath,
    selectedProject,
  ]);
  const runKnowledgeAnalysisInCodex = useCallback(async (input: {
    workspacePath: string;
    sourceType: KnowledgeSourceType;
    sourceSnapshot: Record<string, unknown>;
    developmentContext: KnowledgeDevelopmentContext | null;
  }): Promise<GeneratedKnowledgeProposal> => {
    if (!selectedProject) throw new Error("请先选择项目。");
    if (!embedded || window.parent === window) {
      throw new Error("项目知识初始化需要在 Codex App 内创建项目分析会话。");
    }
    const run = await createKnowledgeRun(selectedProject.id, input);
    const requestId = crypto.randomUUID();
    const prepared = new Promise<void>((resolve, reject) => {
      const timeoutId = window.setTimeout(() => {
        pendingKnowledgeThreadsRef.current.delete(requestId);
        reject(new Error("Codex 项目分析会话在 45 秒内没有完成创建，请检查项目切换或发送指令阶段。"));
      }, 45_000);
      pendingKnowledgeThreadsRef.current.set(requestId, { resolve, reject, timeoutId });
    });
    const codexProject = hostContext?.projects?.find(
      (project) => project.id === selectedProject.id,
    );
    window.parent.postMessage({
      type: "taskboard:create-knowledge-thread",
      payload: {
        requestId,
        instruction: run.instruction,
        codexProjectId: codexProject?.id ?? selectedProject.id,
        projectName: selectedProject.name,
        workspacePath: input.workspacePath,
        workspaceLabel: workspaceName(input.workspacePath),
      },
    }, "*");
    await prepared;
    setAnnouncement("Codex 已开始分析完整项目；分析完成后会生成待确认提案。");

    const deadline = Date.now() + 60 * 60 * 1_000;
    while (Date.now() < deadline) {
      const current = await getKnowledgeRun(run);
      if (current.status === "completed") {
        if (!current.proposal) throw new Error("项目分析已完成，但没有返回知识提案。");
        return current.proposal;
      }
      if (current.status === "failed") {
        throw new Error(current.error || "Codex 未能完成项目分析。");
      }
      await new Promise((resolve) => window.setTimeout(resolve, 2_000));
    }
    throw new Error("项目分析超过一小时仍未完成，请在 Codex 会话中查看执行状态。");
  }, [embedded, hostContext?.projects, selectedProject, setAnnouncement]);

  async function openKnowledgeInitializationIssue(workspacePath: string) {
    if (!selectedProject) throw new Error("请先选择项目。");
    if (!projectKnowledgeSkillPath) {
      throw new Error("任务面板还没有读取到项目知识库 Skill，请刷新后重试。");
    }
    const projectName = projectNames[selectedProject.id] ?? selectedProject.name;
    const title = "初始化项目知识库";
    const existing = tasks.find((task) => (
      task.projectId === selectedProject.id
      && task.title === title
      && task.labels.includes("项目知识库")
      && !["done", "canceled", "archived"].includes(task.status)
    ));
    if (existing) {
      setBoardView("issues");
      openTaskDetail(existing);
      setAnnouncement(`${existing.identifier} 已存在，已打开该初始化议题。`);
      return;
    }

    const saved = await createTaskRequest(selectedProject.id, {
      title,
      description: [
        "## 目标",
        "",
        `对“${projectName}”执行首次项目知识库构建，并在 Taskboard 生成可查看、可审核的待确认提案。`,
        "",
        "## 给 Codex 的执行提示词",
        "",
        "1. 不使用 Codex 的 Skill 选择菜单，直接执行本提示词。",
        "2. 先读取当前 Git 仓库自带的 `skills/manage-taskboard/SKILL.md`，按其规范处理本 Issue、评论和状态。",
        "3. 再读取同仓库的 `skills/project-knowledge-builder/SKILL.md` 及其知识契约，按其中标准分析和组织知识。",
        "4. 只读分析完整项目代码、配置、测试、项目文档，以及本项目已有 Issue 与评论。",
        "5. 严格区分已确认事实、已完成方案与未完成、待确认内容。",
        "6. 将结果回传为待确认提案；用户发布前不得写入正式知识文件。",
        "",
        "## 项目上下文",
        "",
        `- Taskboard 项目 ID：\`${selectedProject.id}\``,
        `- 项目目录：\`${workspacePath}\``,
        "- 执行模式：`INIT`",
        "",
        "## 验收",
        "",
        "- 项目知识页覆盖项目概览、架构、代码地图、核心流程和工程说明；有证据时再增加设计、决策、专项流程或指南。",
        "- 有价值的 Issue/评论内容被综合为可复用知识，而不是原样复制对话。",
        "- 已完成、已确认内容与未完成、待确认内容严格分开。",
        "- Taskboard 中出现一条可查看的“待确认”提案，正式项目文件保持未发布状态。",
      ].join("\n"),
      status: "todo",
      priority: "none",
      labels: ["项目知识库"],
      assigneeTarget: "codex-agent",
      workflowId: null,
      developmentContext: null,
      dueDate: null,
      startDate: null,
      recurrence: null,
    });
    setTasks((current) => sortTasks([saved, ...current]));
    setProjects((current) => current.map((project) => (
      project.id === selectedProject.id
        ? { ...project, issueCount: project.issueCount + 1 }
        : project
    )));
    setBoardView("issues");
    openTaskDetail(saved);
    setAnnouncement(`${saved.identifier} 已创建；请在议题中点击“创建会话”开始分析。`);
  }
  const detailTask = detailTaskIdentifier
    ? tasks.find((task) => task.identifier === detailTaskIdentifier) ?? null
    : null;
  const detailTaskId = detailTask?.id ?? null;
  const projectCodexThreads = useMemo<CodexThreadSummary[]>(
    () => (hostContext?.threads ?? []).filter((thread) => thread.projectId === selectedProjectId),
    [hostContext?.threads, selectedProjectId],
  );
  const contextMenuTask = contextMenu
    ? tasks.find((task) => task.id === contextMenu.taskId) ?? null
    : null;
  const availableLabels = useMemo(
    () => [...new Set([
      ...DEFAULT_LABELS.map((label) => label.name),
      ...tasks.flatMap((task) => task.labels),
    ])],
    [tasks],
  );
  const projectChoices = useMemo<ProjectChoice[]>(() => {
    const persistedById = new Map(projects.map((project) => [project.id, project]));
    const seen = new Set<string>();
    const choices: ProjectChoice[] = [];
    for (const [sourceOrder, project] of (hostContext?.projects ?? []).entries()) {
      if (!project.id || !project.name || seen.has(project.id)) continue;
      seen.add(project.id);
      const persisted = persistedById.get(project.id);
      choices.push({
        id: project.id,
        name: projectAliases[project.id] ?? persisted?.name ?? project.name,
        sourceName: persisted?.name ?? project.name,
        issueCount: persisted?.issueCount ?? 0,
        inCodex: true,
        persisted: Boolean(persisted),
        createdAt: persisted?.createdAt ?? "",
        sourceOrder,
      });
    }
    for (const [index, project] of projects.entries()) {
      if (seen.has(project.id)) continue;
      choices.push({
        id: project.id,
        name: projectAliases[project.id] ?? project.name,
        sourceName: project.name,
        issueCount: project.issueCount,
        inCodex: false,
        persisted: true,
        createdAt: project.createdAt,
        sourceOrder: (hostContext?.projects?.length ?? 0) + index,
      });
    }
    return choices;
  }, [hostContext?.projects, projectAliases, projects]);
  const orderedProjectChoices = useMemo(() => {
    const manualIndex = new Map(projectOrder.map((projectId, index) => [projectId, index]));
    return [...projectChoices].sort((left, right) => {
      const favoriteDifference = Number(favoriteProjectIds.has(right.id))
        - Number(favoriteProjectIds.has(left.id));
      if (favoriteDifference !== 0) return favoriteDifference;
      const leftManualIndex = manualIndex.get(left.id);
      const rightManualIndex = manualIndex.get(right.id);
      if (leftManualIndex !== undefined || rightManualIndex !== undefined) {
        if (leftManualIndex === undefined) return 1;
        if (rightManualIndex === undefined) return -1;
        if (leftManualIndex !== rightManualIndex) return leftManualIndex - rightManualIndex;
      }
      if (left.createdAt !== right.createdAt) return right.createdAt.localeCompare(left.createdAt);
      return right.sourceOrder - left.sourceOrder;
    });
  }, [favoriteProjectIds, projectChoices, projectOrder]);
  const activeProjectChoices = useMemo(
    () => orderedProjectChoices.filter((project) => !archivedProjectIds.has(project.id)),
    [archivedProjectIds, orderedProjectChoices],
  );
  const archivedProjectChoices = useMemo(
    () => orderedProjectChoices.filter((project) => archivedProjectIds.has(project.id)),
    [archivedProjectIds, orderedProjectChoices],
  );
  const projectsWithIssues = useMemo(
    () => activeProjectChoices.filter((project) => project.issueCount > 0),
    [activeProjectChoices],
  );
  const projectsWithoutIssues = useMemo(
    () => activeProjectChoices.filter((project) => project.issueCount === 0),
    [activeProjectChoices],
  );
  const favoriteProjectChoices = useMemo(
    () => activeProjectChoices.filter((project) => favoriteProjectIds.has(project.id)),
    [activeProjectChoices, favoriteProjectIds],
  );
  const otherProjectChoices = useMemo(
    () => activeProjectChoices.filter((project) => !favoriteProjectIds.has(project.id)),
    [activeProjectChoices, favoriteProjectIds],
  );
  const closeContextMenu = useCallback(() => setContextMenu(null), []);

  const writeProjectAutomation = useCallback((
    projectId: string,
    record: ProjectAutomationRecord | null | undefined,
  ) => {
    setProjectAutomations((current) => {
      if (
        record
        && current[projectId]?.automationId === record.automationId
        && current[projectId]?.codexProjectId === record.codexProjectId
        && current[projectId]?.status === record.status
        && current[projectId]?.enabledByUser === record.enabledByUser
        && current[projectId]?.quotaAware === record.quotaAware
        && JSON.stringify(current[projectId]?.quota) === JSON.stringify(record.quota)
        && current[projectId]?.intervalMinutes === record.intervalMinutes
        && current[projectId]?.model === record.model
        && current[projectId]?.reasoningEffort === record.reasoningEffort
      ) {
        return current;
      }
      const next = { ...current };
      if (record) next[projectId] = record;
      else delete next[projectId];
      projectAutomationsRef.current = next;
      window.localStorage.setItem(PROJECT_AUTOMATIONS_KEY, JSON.stringify(next));
      return next;
    });
  }, []);

  const sendAutomationRequest = useCallback((
    operation: "ensure-active" | "pause" | "list" | "apply-policy",
    options: Pick<
      ProjectAutomationRecord,
      "enabledByUser" | "quotaAware" | "intervalMinutes" | "model" | "reasoningEffort"
    >,
    automationId?: string,
  ) => {
    if (
      !selectedProject
      || !automationProjectContext.codexProjectId
      || !automationProjectContext.workspacePath
    ) {
      return Promise.reject(new Error(
        automationProjectContext.unavailableReason ?? "无法读取项目自动化信息",
      ));
    }
    const requestId = window.crypto.randomUUID();
    const response = new Promise<AutomationHostResponse>((resolve, reject) => {
      const timeoutId = window.setTimeout(() => {
        pendingAutomationRequestsRef.current.delete(requestId);
        reject(new Error("Codex 自动化没有响应，请稍后重试"));
      }, 10_000);
      pendingAutomationRequestsRef.current.set(requestId, { resolve, reject, timeoutId });
    });
    window.parent.postMessage({
      type: "taskboard:automation-request",
      payload: {
        requestId,
        operation,
        taskboardProjectId: selectedProjectId,
        codexProjectId: automationProjectContext.codexProjectId,
        projectName: selectedProject.name,
        workspacePath: automationProjectContext.workspacePath,
        skillPath: manageTaskboardSkillPath,
        ...(automationId ? { automationId } : {}),
        enabledByUser: options.enabledByUser,
        quotaAware: options.quotaAware,
        intervalMinutes: options.intervalMinutes,
        model: options.model,
        reasoningEffort: options.reasoningEffort,
      },
    }, "*");
    return response;
  }, [
    automationProjectContext,
    manageTaskboardSkillPath,
    selectedProject,
    selectedProjectId,
  ]);

  const reconcileProjectAutomation = useCallback(async () => {
    if (automationProjectContext.unavailableReason) {
      setAutomationError(null);
      return;
    }
    if (!selectedProjectId || !automationProjectContext.codexProjectId || automationRequestInFlightRef.current) return;
    const stored = projectAutomationsRef.current[selectedProjectId];
    automationRequestInFlightRef.current = true;
    setAutomationPending(true);
    setAutomationError(null);
    try {
      const options = stored ?? {
        status: "PAUSED" as const,
        ...DEFAULT_AUTOMATION_OPTIONS,
      };
      const response = await sendAutomationRequest(
        stored ? "apply-policy" : "list",
        options,
        stored?.automationId,
      );
      const items = Array.isArray(response.items)
        ? response.items.filter(isAutomationHostItem)
        : [];
      if (!stored) {
        const policy = isAutomationHostPolicy(response.policy) ? response.policy : null;
        if (!policy) return;
        const item = items.find((candidate) => candidate.id === policy.automationId)
          ?? (items.length === 1 ? items[0] : undefined);
        writeProjectAutomation(selectedProjectId, {
          automationId: item?.id ?? policy.automationId,
          codexProjectId: automationProjectContext.codexProjectId,
          status: item?.status ?? "PAUSED",
          enabledByUser: policy.enabledByUser,
          quotaAware: policy.quotaAware,
          intervalMinutes: policy.intervalMinutes,
          model: policy.model,
          reasoningEffort: policy.reasoningEffort,
        });
        return;
      }
      const item = (isAutomationHostItem(response.item) ? response.item : undefined)
        ?? items.find((item) => item.id === stored?.automationId)
        ?? (items.length === 1 ? items[0] : undefined);
      if (!item) {
        if (stored) {
          writeProjectAutomation(selectedProjectId, {
            ...stored,
            automationId: undefined,
            status: "PAUSED",
            ...(response.quota ? { quota: response.quota } : {}),
          });
        }
        return;
      }
      const intervalMinutes = intervalMinutesFromRrule(item.rrule);
      if (!intervalMinutes) return;
      writeProjectAutomation(selectedProjectId, {
        automationId: item.id,
        codexProjectId: automationProjectContext.codexProjectId,
        status: item.status,
        enabledByUser: stored.enabledByUser,
        quotaAware: stored.quotaAware,
        ...(response.quota ? { quota: response.quota } : {}),
        intervalMinutes,
        model: item.model,
        reasoningEffort: item.reasoningEffort,
      });
    } catch (error) {
      setAutomationError(error instanceof Error ? error.message : "无法读取自动化状态");
    } finally {
      automationRequestInFlightRef.current = false;
      setAutomationPending(false);
    }
  }, [
    automationProjectContext,
    selectedProjectId,
    sendAutomationRequest,
    writeProjectAutomation,
  ]);

  const saveProjectAutomation = useCallback(async (options: {
    enabledByUser: boolean;
    quotaAware: boolean;
    intervalMinutes: AutomationIntervalMinutes;
    model: AutomationModel;
    reasoningEffort: AutomationReasoningEffort;
  }) => {
    const stored = projectAutomations[selectedProjectId];
    if (
      !selectedProjectId
      || automationProjectContext.unavailableReason
      || !automationProjectContext.codexProjectId
      || automationRequestInFlightRef.current
    ) return;
    const previousRecord = stored;
    automationRequestInFlightRef.current = true;
    setAutomationPending(true);
    setAutomationError(null);
    try {
      const response = await sendAutomationRequest("apply-policy", options, stored?.automationId);
      const item = isAutomationHostItem(response.item) ? response.item : undefined;
      writeProjectAutomation(selectedProjectId, {
        automationId: item?.id,
        codexProjectId: automationProjectContext.codexProjectId,
        status: item?.status ?? "PAUSED",
        enabledByUser: options.enabledByUser,
        quotaAware: options.quotaAware,
        ...(response.quota ? { quota: response.quota } : {}),
        intervalMinutes: options.intervalMinutes,
        model: options.model,
        reasoningEffort: options.reasoningEffort,
      });
    } catch (error) {
      writeProjectAutomation(selectedProjectId, previousRecord);
      setAutomationError(error instanceof Error ? error.message : "无法更新自动化");
    } finally {
      automationRequestInFlightRef.current = false;
      setAutomationPending(false);
    }
  }, [
    automationProjectContext,
    projectAutomations,
    selectedProjectId,
    sendAutomationRequest,
    writeProjectAutomation,
  ]);

  function openTaskDetail(task: Pick<Task, "identifier" | "projectId">) {
    closeContextMenu();
    setProjectMenuOpen(false);
    const fromGlobalBoard = selectedProjectId === GLOBAL_PROJECT_ID;
    if (fromGlobalBoard) {
      setSelectedProjectId(task.projectId);
      window.localStorage.setItem(LAST_PROJECT_KEY, task.projectId);
    }
    setDetailTaskIdentifier(task.identifier);
    const currentIssue = readIssueIdentifier(window.location.search);
    const boardUrl = buildIssueUrl(
      window.location.href,
      fromGlobalBoard ? null : task.projectId,
      null,
    );
    if (fromGlobalBoard) {
      boardUrl.searchParams.set(GLOBAL_VIEW_QUERY_PARAM, GLOBAL_VIEW_QUERY_VALUE);
    } else {
      boardUrl.searchParams.delete(GLOBAL_VIEW_QUERY_PARAM);
    }
    if (!currentIssue) {
      window.history.replaceState(window.history.state, "", boardUrl);
    }
    const detailUrl = buildIssueUrl(
      currentIssue ? window.location.href : boardUrl.href,
      task.projectId,
      task.identifier,
    );
    window.history.pushState(window.history.state, "", detailUrl);
  }

  function closeTaskDetail() {
    const currentUrl = new URL(window.location.href);
    const returnToGlobal = currentUrl.searchParams.get(GLOBAL_VIEW_QUERY_PARAM) === GLOBAL_VIEW_QUERY_VALUE;
    setDetailTaskIdentifier(null);
    if (returnToGlobal) {
      setBoardView("issues");
      setSelectedProjectId(GLOBAL_PROJECT_ID);
      window.localStorage.removeItem(LAST_PROJECT_KEY);
    }
    const url = buildIssueUrl(
      window.location.href,
      returnToGlobal ? null : selectedProjectId || null,
      null,
    );
    window.history.replaceState(window.history.state, "", url);
  }

  useEffect(() => {
    function syncRouteFromLocation() {
      const url = new URL(window.location.href);
      const routeIssueIdentifier = readIssueIdentifier(url.search);
      const routeIsGlobalBoard = !routeIssueIdentifier
        && url.searchParams.get(GLOBAL_VIEW_QUERY_PARAM) === GLOBAL_VIEW_QUERY_VALUE;
      const routeProjectId = routeIsGlobalBoard
        ? GLOBAL_PROJECT_ID
        : url.searchParams.get("project") ?? "";
      setDetailTaskIdentifier(routeIssueIdentifier);
      if (routeProjectId === selectedProjectId) return;
      setBoardView(routeProjectId === GLOBAL_PROJECT_ID ? "issues" : readProjectBoardView(routeProjectId));
      setSelectedProjectId(routeProjectId);
      if (routeProjectId) window.localStorage.setItem(LAST_PROJECT_KEY, routeProjectId);
      else window.localStorage.removeItem(LAST_PROJECT_KEY);
    }

    window.addEventListener("popstate", syncRouteFromLocation);
    return () => window.removeEventListener("popstate", syncRouteFromLocation);
  }, [selectedProjectId]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.dataset.embedded = String(embedded);
    document.documentElement.style.colorScheme = theme;
    if (!embedded) window.localStorage.setItem("taskboard.theme", theme);
  }, [embedded, theme]);

  useEffect(() => {
    writeTaskFilters(filters);
  }, [filters]);

  useEffect(() => {
    tasksRef.current = tasks;
  }, [tasks]);

  useEffect(() => {
    if (!taskboardMetadata) return;
    const controller = new AbortController();
    void refreshReviewTaskSnapshots(false, controller.signal);
    return () => controller.abort();
  }, [refreshReviewTaskSnapshots, taskboardMetadata]);

  useEffect(() => {
    if (!projectMenuOpen) return;
    function closeProjectMenu(event: PointerEvent) {
      const target = event.target as HTMLElement;
      if (!target.closest("[data-project-switcher]")) setProjectMenuOpen(false);
    }
    function closeProjectMenuWithEscape(event: KeyboardEvent) {
      if (event.key === "Escape") setProjectMenuOpen(false);
    }
    document.addEventListener("pointerdown", closeProjectMenu);
    window.addEventListener("keydown", closeProjectMenuWithEscape);
    return () => {
      document.removeEventListener("pointerdown", closeProjectMenu);
      window.removeEventListener("keydown", closeProjectMenuWithEscape);
    };
  }, [projectMenuOpen]);

  useEffect(() => {
    setAutomationError(null);
    void reconcileProjectAutomation();
  }, [selectedProjectId, reconcileProjectAutomation]);

  useEffect(() => {
    if (!embedded || window.parent === window) return;

    function receiveHostMessage(event: MessageEvent) {
      if (event.source !== window.parent || !event.data || typeof event.data !== "object") return;
      const message = event.data as { type?: string; payload?: unknown; theme?: unknown };

      if (message.type === "taskboard:automation-response" && message.payload) {
        const payload = message.payload as Partial<AutomationHostResponse>;
        if (typeof payload.requestId !== "string") return;
        const pending = pendingAutomationRequestsRef.current.get(payload.requestId);
        if (!pending) return;
        window.clearTimeout(pending.timeoutId);
        pendingAutomationRequestsRef.current.delete(payload.requestId);
        if (payload.ok) pending.resolve(payload as AutomationHostResponse);
        else pending.reject(new Error(
          typeof payload.error === "string" ? payload.error : "Codex 无法更新自动化",
        ));
        return;
      }

      if (message.type === "taskboard:project-activated" && message.payload) {
        const payload = message.payload as Partial<CodexProjectActivationResponse>;
        if (typeof payload.requestId !== "string") return;
        const pending = pendingProjectActivationsRef.current.get(payload.requestId);
        if (!pending) return;
        window.clearTimeout(pending.timeoutId);
        pendingProjectActivationsRef.current.delete(payload.requestId);
        if (payload.ok) pending.resolve(payload as CodexProjectActivationResponse);
        else pending.reject(new Error(
          typeof payload.error === "string" ? payload.error : "Codex 无法新增该项目",
        ));
        return;
      }

      if (
        (message.type === "taskboard:knowledge-thread-prepared"
          || message.type === "taskboard:knowledge-thread-error")
        && message.payload
      ) {
        const payload = message.payload as { requestId?: unknown; error?: unknown };
        if (typeof payload.requestId !== "string") return;
        const pending = pendingKnowledgeThreadsRef.current.get(payload.requestId);
        if (!pending) return;
        window.clearTimeout(pending.timeoutId);
        pendingKnowledgeThreadsRef.current.delete(payload.requestId);
        if (message.type === "taskboard:knowledge-thread-prepared") pending.resolve();
        else pending.reject(new Error(
          typeof payload.error === "string" ? payload.error : "无法创建项目知识分析会话。",
        ));
        return;
      }

      if (message.type === "taskboard:theme" && isTheme(message.theme)) {
        setTheme(message.theme);
        return;
      }

      if (message.type === "taskboard:thread-prepared" && message.payload) {
        const payload = message.payload as { requestId?: unknown };
        if (typeof payload.requestId !== "string" || !pendingThreadRequestsRef.current.has(payload.requestId)) {
          return;
        }
        setOpeningThreadTaskId(null);
        return;
      }

      if (message.type === "taskboard:thread-create-error" && message.payload) {
        const payload = message.payload as { requestId?: unknown; error?: unknown };
        if (typeof payload.requestId !== "string" || !pendingThreadRequestsRef.current.has(payload.requestId)) {
          return;
        }
        pendingThreadRequestsRef.current.delete(payload.requestId);
        writePendingThreadRequests(pendingThreadRequestsRef.current);
        setOpeningThreadTaskId(null);
        setActionError(typeof payload.error === "string" ? payload.error : "无法在 Codex 中创建对话。");
        return;
      }

      if (message.type === "taskboard:thread-created" && message.payload) {
        const payload = message.payload as {
          requestId?: unknown;
          taskId?: unknown;
          commentId?: unknown;
          threadId?: unknown;
        };
        if (
          typeof payload.requestId !== "string"
          || typeof payload.taskId !== "string"
          || typeof payload.threadId !== "string"
        ) return;
        const pendingRequest = pendingThreadRequestsRef.current.get(payload.requestId);
        if (
          !pendingRequest
          || pendingRequest.action === "follow-up"
          || pendingRequest.taskId !== payload.taskId
        ) return;
        const threadId = normalizeCodexThreadId(payload.threadId);
        if (!threadId) return;
        const commentId = pendingRequest.commentId ?? (
          typeof payload.commentId === "string" ? payload.commentId : undefined
        );
        if (pendingRequest.commentId && pendingRequest.commentId !== payload.commentId) return;
        void finalizeThreadLink({
          requestId: payload.requestId,
          taskId: payload.taskId,
          projectId: pendingRequest.projectId,
          commentId,
          threadId,
          runtime: "codex",
          sendAck: true,
        });
        return;
      }

      if (message.type === "taskboard:thread-followed-up" && message.payload) {
        const payload = message.payload as {
          requestId?: unknown;
          taskId?: unknown;
          threadId?: unknown;
        };
        if (
          typeof payload.requestId !== "string"
          || typeof payload.taskId !== "string"
          || typeof payload.threadId !== "string"
        ) return;
        const pendingRequest = pendingThreadRequestsRef.current.get(payload.requestId);
        if (
          !pendingRequest
          || pendingRequest.action !== "follow-up"
          || pendingRequest.taskId !== payload.taskId
        ) return;
        if (finalizingThreadRequestsRef.current.has(payload.requestId)) return;
        const threadId = normalizeCodexThreadId(payload.threadId);
        if (!threadId || normalizeCodexThreadId(pendingRequest.threadId) !== threadId) return;
        finalizingThreadRequestsRef.current.add(payload.requestId);
        void (async () => {
          try {
            let latestTasks = await listTasks(pendingRequest.projectId);
            let task = latestTasks.find((candidate) => candidate.id === payload.taskId);
            if (!task) throw new Error("没有找到需要继续跟进的议题。");
            let resumed = false;
            for (let attempt = 0; task.status === "in_review" && attempt < 2; attempt += 1) {
              try {
                task = await moveTaskRequest(task, "in_progress", undefined, threadId);
                resumed = true;
                latestTasks = latestTasks.map((candidate) => candidate.id === task?.id ? task : candidate);
              } catch (error) {
                if (!(error instanceof ApiError) || error.code !== "VERSION_CONFLICT" || attempt > 0) {
                  throw error;
                }
                latestTasks = await listTasks(pendingRequest.projectId);
                task = latestTasks.find((candidate) => candidate.id === payload.taskId);
                if (!task) throw new Error("没有找到需要继续跟进的议题。");
              }
            }
            if (selectedProjectIdRef.current === pendingRequest.projectId) {
              setTasks(sortTasks(latestTasks));
            }
            pendingThreadRequestsRef.current.delete(payload.requestId as string);
            writePendingThreadRequests(pendingThreadRequestsRef.current);
            setOpeningThreadTaskId(null);
            if (resumed) {
              setAnnouncement(`${task.identifier} 已恢复为进行中。`);
            }
            window.parent.postMessage({
              type: "taskboard:thread-link-ack",
              payload: { requestId: payload.requestId, taskId: payload.taskId, threadId },
            }, "*");
          } catch (error) {
            setActionError(`跟进消息已发送，但状态尚未更新：${errorMessage(error)} 将自动重试。`);
          } finally {
            finalizingThreadRequestsRef.current.delete(payload.requestId as string);
          }
        })();
        return;
      }

      if (message.type !== "taskboard:host-context" || !message.payload) return;
      const payload = message.payload as HostContext;
      setHostContext(payload);
      setCurrentUserActor(payload.user);
      if (isTheme(payload.theme)) setTheme(payload.theme);
    }

    window.addEventListener("message", receiveHostMessage);
    window.parent.postMessage({ type: "taskboard:ready" }, "*");
    return () => {
      window.removeEventListener("message", receiveHostMessage);
      for (const pending of pendingAutomationRequestsRef.current.values()) {
        window.clearTimeout(pending.timeoutId);
      }
      pendingAutomationRequestsRef.current.clear();
      for (const pending of pendingProjectActivationsRef.current.values()) {
        window.clearTimeout(pending.timeoutId);
        pending.reject(new Error("任务面板已关闭，项目同步已取消。"));
      }
      pendingProjectActivationsRef.current.clear();
      for (const pending of pendingKnowledgeThreadsRef.current.values()) {
        window.clearTimeout(pending.timeoutId);
        pending.reject(new Error("任务面板已关闭，项目知识分析已取消。"));
      }
      pendingKnowledgeThreadsRef.current.clear();
    };
  }, [embedded]);

  useLayoutEffect(() => {
    if (!embedded || window.parent === window || !dragRegionRef.current) return;
    const region = dragRegionRef.current;
    const publish = () => {
      const rect = region.getBoundingClientRect();
      window.parent.postMessage({
        type: "taskboard:drag-region",
        payload: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      }, "*");
    };
    const observer = new ResizeObserver(publish);
    observer.observe(region);
    window.addEventListener("resize", publish);
    publish();
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", publish);
      window.parent.postMessage({ type: "taskboard:drag-region", payload: null }, "*");
    };
  }, [detailTaskId, embedded, selectedProjectId]);

  const loadProjectList = useCallback(async (signal?: AbortSignal) => {
    setProjectsLoading(true);
    setLoadError(null);
    try {
      const [nextProjects, metadata, workspaces] = await Promise.all([
        listProjects(signal),
        getTaskboardMetadata(signal),
        listDeviceWorkspaces(signal),
      ]);
      setTaskboardMetadata((current) => (
        current
        && current.manageTaskboardSkillPath === metadata.manageTaskboardSkillPath
        && current.projectKnowledgeSkillPath === metadata.projectKnowledgeSkillPath
        ? current
        : metadata
      ));
      setManageTaskboardSkillPath(metadata.manageTaskboardSkillPath ?? "");
      setProjectKnowledgeSkillPath(metadata.projectKnowledgeSkillPath ?? "");
      setClaudeRuntimeSupported(metadata.claudeRuntime === true);
      setOmpRuntimeSupported(metadata.ompRuntime === true);
      setLocalKnowledgeAvailable(metadata.capabilities?.localKnowledge === true);
      setConnectors(metadata.connectors ?? []);
      setDeviceWorkspacePaths((current) => {
        const next = workspaces;
        if (JSON.stringify(next) === JSON.stringify(current)) return current;
        window.localStorage.setItem(DEVICE_WORKSPACE_PATHS_KEY, JSON.stringify(next));
        return next;
      });
      setProjects(nextProjects);
      setSelectedProjectId((current) => {
        const route = new URLSearchParams(window.location.search);
        const fromQuery = route.get("project");
        const fromGlobalView = !readIssueIdentifier(route.toString())
          && route.get(GLOBAL_VIEW_QUERY_PARAM) === GLOBAL_VIEW_QUERY_VALUE;
        const remembered = window.localStorage.getItem(LAST_PROJECT_KEY);
        if (fromQuery && nextProjects.some((project) => project.id === fromQuery)) return fromQuery;
        if (fromGlobalView) return GLOBAL_PROJECT_ID;
        if (current === GLOBAL_PROJECT_ID) return current;
        if (current && nextProjects.some((project) => project.id === current)) return current;
        if (remembered && nextProjects.some((project) => project.id === remembered)) return remembered;
        return "";
      });
    } catch (error) {
      if ((error as Error).name !== "AbortError") setLoadError(errorMessage(error));
    } finally {
      setProjectsLoading(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void loadProjectList(controller.signal);
    return () => controller.abort();
  }, [loadProjectList]);

  const refreshProjectList = useCallback(async () => {
    try {
      setProjects(await listProjects());
    } catch (error) {
      setLoadError(errorMessage(error));
    }
  }, []);

  const refreshTasks = useCallback(async (
    projectId: string,
    options: { quiet?: boolean; signal?: AbortSignal } = {},
  ) => {
    const requestId = ++tasksRequestRef.current;
    if (!options.quiet) setTasksLoading(true);
    setLoadError(null);
    try {
      const nextTasks = await listTasks(
        projectId === GLOBAL_PROJECT_ID ? undefined : projectId,
        options.signal,
      );
      if (requestId !== tasksRequestRef.current) return;
      setTasks(sortTasks(nextTasks));
      setHasLoadedTasks(true);
    } catch (error) {
      if ((error as Error).name !== "AbortError" && requestId === tasksRequestRef.current) {
        setLoadError(errorMessage(error));
      }
    } finally {
      if (!options.quiet && requestId === tasksRequestRef.current) setTasksLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!selectedProjectId) {
      setTasks([]);
      setHasLoadedTasks(false);
      return;
    }
    setHasLoadedTasks(false);
    const controller = new AbortController();
    void refreshTasks(selectedProjectId, { signal: controller.signal });
    return () => controller.abort();
  }, [refreshTasks, selectedProjectId]);

  const refreshWorkflowOptions = useCallback(async (projectId: string, signal?: AbortSignal) => {
    const record = await getWorkflowWorkspace<unknown>(projectId, signal);
    if (!signal?.aborted) setWorkflowOptions(workflowOptionsFromWorkspace(record.workspace));
  }, []);

  useEffect(() => {
    if (!selectedProjectId || isGlobalBoard) {
      setWorkflowOptions(DEFAULT_WORKFLOW_OPTIONS);
      return;
    }
    setWorkflowOptions(workflowOptionsFromWorkspace(readLegacyWorkflowWorkspace(selectedProjectId)));
    const controller = new AbortController();
    void refreshWorkflowOptions(selectedProjectId, controller.signal).catch((error) => {
      if ((error as Error).name !== "AbortError") {
        setWorkflowOptions(workflowOptionsFromWorkspace(readLegacyWorkflowWorkspace(selectedProjectId)));
      }
    });
    return () => controller.abort();
  }, [isGlobalBoard, refreshWorkflowOptions, selectedProjectId]);

  useEffect(() => {
    if (!selectedProjectId || isGlobalBoard) {
      setDevelopmentScan({ workspacePath: null, contexts: [] });
      return;
    }
    const controller = new AbortController();
    const codexProjectId = selectedProjectId === "local" ? hostContext?.projectId : selectedProjectId;
    const codexThreadId = hostContext?.threadId ?? detailTask?.threadId ?? undefined;
    setDevelopmentScan({ workspacePath: selectedDeviceWorkspacePath ?? null, contexts: [] });
    setDevelopmentScanLoading(true);
    void listDevelopmentContexts(
      selectedProjectId,
      codexProjectId,
      codexThreadId,
      controller.signal,
      selectedDeviceWorkspacePath,
    )
      .then((scan) => {
        setDevelopmentScan(scan);
      })
      .catch((error) => {
        if ((error as Error).name !== "AbortError") {
          setDevelopmentScan({ workspacePath: selectedDeviceWorkspacePath ?? null, contexts: [] });
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setDevelopmentScanLoading(false);
      });
    return () => controller.abort();
  }, [
    detailTask?.threadId,
    hostContext?.projectId,
    hostContext?.threadId,
    isGlobalBoard,
    selectedProjectId,
    selectedDeviceWorkspacePath,
  ]);

  function pushUndo(message: string, undo: () => Promise<void>, showNotice = true) {
    const operation = { id: ++undoSequenceRef.current, message, undo };
    undoStackRef.current = [...undoStackRef.current.slice(-19), operation];
    setAnnouncementValue("");
    setUndoNotice(showNotice ? { id: operation.id, message } : null);
  }

  async function performUndo() {
    if (undoInFlightRef.current) return;
    const operation = undoStackRef.current.at(-1);
    if (!operation) return;
    undoStackRef.current = undoStackRef.current.slice(0, -1);
    undoInFlightRef.current = true;
    setUndoNotice(null);
    setProjectMenuOpen(false);
    closeContextMenu();
    setActionError(null);
    try {
      await operation.undo();
    } catch (error) {
      setActionError(`无法撤回这次操作：${errorMessage(error)}`);
      if (selectedProjectId) void refreshTasks(selectedProjectId, { quiet: true });
    } finally {
      undoInFlightRef.current = false;
    }
  }

  async function restoreTaskDetails(
    snapshot: Task,
    changed: Task,
    assigneeTarget = assigneeTargetForActor(snapshot.assignee, currentUser),
  ) {
    const candidate = tasksRef.current.find((task) => task.id === changed.id);
    const current = candidate && candidate.version >= changed.version ? candidate : changed;
    const restored = await updateTaskRequest(current, {
      ...taskToDraft(snapshot),
      ...(assigneeTarget ? { assigneeTarget } : {}),
    });
    setTasks((tasks) => sortTasks(tasks.map((task) => task.id === restored.id ? restored : task)));
  }

  useEffect(() => {
    function handleShortcut(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      const isTyping = target?.matches("input, textarea, select, [contenteditable='true']");
      if (
        event.key.toLowerCase() === "z"
        && (event.metaKey || event.ctrlKey)
        && !event.shiftKey
        && !isTyping
        && !editor
      ) {
        event.preventDefault();
        void performUndo();
        return;
      }
      if (isTyping || contextMenu || projectMenuOpen) return;
      if (
        event.key.toLowerCase() === "c"
        && !event.metaKey
        && !event.ctrlKey
        && selectedProjectId
        && boardView === "issues"
      ) {
        event.preventDefault();
        openNewIssue();
      }
      if (event.key === "/" && !detailTaskId && selectedProjectId && boardView === "issues") {
        event.preventDefault();
        document.getElementById("task-search")?.focus();
      }
      if (event.key === "Escape" && detailTaskId) {
        closeTaskDetail();
      }
    }

    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  }, [boardView, contextMenu, detailTaskId, editor, projectMenuOpen, selectedProjectId]);

  const filteredTasks = useMemo(() => {
    return tasks.filter(
      (task) => (
        (!favoriteTasksOnly || favoriteTaskIds.has(task.id))
        && matchesTaskSearch(task, search)
        && matchesTaskFilters(task, filters)
      ),
    );
  }, [favoriteTaskIds, favoriteTasksOnly, filters, search, tasks]);

  const favoriteTaskCount = useMemo(
    () => tasks.filter((task) => favoriteTaskIds.has(task.id)).length,
    [favoriteTaskIds, tasks],
  );

  const activeFilterCount = taskFilterCount(filters);

  // Poll Codex session plan-progress for in_progress tasks linked to a Codex
  // thread. Non-codex (claude/omp) threads return null from the backend and are
  // simply skipped. Derived from upstream v0.2.3.
  const trackedCodexThreadIds = useMemo(() => [...new Set(tasks
    .filter((task) => task.status === "in_progress" && task.threadId)
    .map((task) => normalizeCodexThreadId(task.threadId))
    .filter((value): value is string => value !== null))].sort(), [tasks]);
  const trackedCodexThreadIdsKey = trackedCodexThreadIds.join(",");

  useEffect(() => {
    if (trackedCodexThreadIds.length === 0) {
      setCodexThreadProgress({});
      return;
    }
    let disposed = false;
    const sync = async () => {
      try {
        const progress = await getCodexThreadProgress(trackedCodexThreadIds);
        if (!disposed) {
          setCodexThreadProgress((current) => (
            JSON.stringify(current) === JSON.stringify(progress) ? current : progress
          ));
        }
      } catch {}
    };
    void sync();
    const timer = window.setInterval(sync, 2_000);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [trackedCodexThreadIdsKey]);

  const progressByTaskId = useMemo(() => {
    const map = new Map<string, CodexThreadProgress>();
    for (const task of tasks) {
      if (task.status !== "in_progress" || !task.threadId) continue;
      const normalized = normalizeCodexThreadId(task.threadId);
      if (!normalized) continue;
      const progress = codexThreadProgress[normalized];
      if (progress && progress.total !== null && progress.total > 0) {
        map.set(task.id, progress);
      }
    }
    return map;
  }, [codexThreadProgress, tasks]);

  const tasksByStatus = useMemo(() => {
    return Object.fromEntries(
      TASK_STATUSES.map((status) => [
        status,
        // Board issues view honors user drag order (sortOrder); time grouping by
        // statusChangedAt is applied inside BoardColumn, so groups still read
        // recent-activity while column order stays manual.
        sortTasks(filteredTasks.filter((task) => task.status === status)),
      ]),
    ) as Record<TaskStatus, Task[]>;
  }, [filteredTasks]);

  const columnVisibility = globalColumnVisibility ?? columnVisibilityByProject[selectedProjectId];

  const visibleStatuses = useMemo(
    () => columnOrder.filter((status) => (
      columnVisibility?.[status] ?? (showEmptyColumns || tasksByStatus[status].length > 0)
    )),
    [columnOrder, columnVisibility, showEmptyColumns, tasksByStatus],
  );

  const hiddenStatuses = useMemo(
    () => columnOrder.filter((status) => !(
      columnVisibility?.[status] ?? (showEmptyColumns || tasksByStatus[status].length > 0)
    )),
    [columnOrder, columnVisibility, showEmptyColumns, tasksByStatus],
  );

  function moveColumn(
    source: TaskStatus,
    target: TaskStatus,
    position: "before" | "after",
  ) {
    setColumnOrder((current) => {
      const next = current.filter((status) => status !== source);
      const targetIndex = next.indexOf(target);
      if (targetIndex < 0) return current;
      next.splice(targetIndex + (position === "after" ? 1 : 0), 0, source);
      window.localStorage.setItem(COLUMN_ORDER_KEY, JSON.stringify(next));
      return next;
    });
    setDraggedColumnStatus(null);
    setColumnDropTarget(null);
  }

  function updateColumnVisibility(status: TaskStatus, visible: boolean) {
    if (globalColumnVisibility !== null) {
      setGlobalColumnVisibility((current) => {
        const next = { ...(current ?? {}), [status]: visible };
        window.localStorage.setItem(GLOBAL_COLUMN_VISIBILITY_KEY, JSON.stringify(next));
        return next;
      });
      return;
    }
    if (!selectedProjectId) return;
    setColumnVisibilityByProject((current) => {
      const next = {
        ...current,
        [selectedProjectId]: {
          ...current[selectedProjectId],
          [status]: visible,
        },
      };
      window.localStorage.setItem(COLUMN_VISIBILITY_KEY, JSON.stringify(next));
      return next;
    });
  }

  function updateGlobalColumnVisibility(enabled: boolean) {
    if (!enabled) {
      setGlobalColumnVisibility(null);
      window.localStorage.removeItem(GLOBAL_COLUMN_VISIBILITY_KEY);
      return;
    }
    const next = Object.fromEntries(
      TASK_STATUSES.map((status) => [status, visibleStatuses.includes(status)]),
    ) as Record<TaskStatus, boolean>;
    setGlobalColumnVisibility(next);
    window.localStorage.setItem(GLOBAL_COLUMN_VISIBILITY_KEY, JSON.stringify(next));
  }

  function selectBoardView(view: BoardView) {
    closeContextMenu();
    setBoardView(view);
    writeProjectBoardView(selectedProjectId, view);
  }

  function openNewIssue(status: TaskStatus = "todo", projectId?: string) {
    const targetProjectId = projectId
      ?? selectedProject?.id
      ?? projects.find((project) => !archivedProjectIds.has(project.id))?.id
      ?? "";
    if (!targetProjectId) {
      setActionError("请先新增一个项目，再创建议题或草稿。");
      return;
    }
    setEditor({ task: null, status, projectId: targetProjectId });
  }

  function editIssueDraft(draft: IssueDraft) {
    setEditor({
      task: null,
      status: draft.content.status,
      projectId: draft.projectId,
      draft,
    });
  }

  function saveIssueDraft(content: TaskDraft) {
    if (!editor || editor.task || !editor.projectId) return;
    const timestamp = new Date().toISOString();
    const saved: IssueDraft = {
      id: editor.draft?.id ?? crypto.randomUUID(),
      projectId: editor.projectId,
      content,
      createdAt: editor.draft?.createdAt ?? timestamp,
      updatedAt: timestamp,
    };
    setIssueDrafts((current) => {
      const next = [saved, ...current.filter((draft) => draft.id !== saved.id)]
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
      persistIssueDrafts(next);
      return next;
    });
    setEditor(null);
    setAnnouncement("草稿已保存。");
  }

  function deleteIssueDraft(draft: IssueDraft) {
    setIssueDrafts((current) => {
      const next = current.filter((candidate) => candidate.id !== draft.id);
      persistIssueDrafts(next);
      return next;
    });
    setAnnouncement("草稿已删除。");
  }

  async function saveEditor(
    draft: TaskDraft,
    attachments: File[],
    inlineImages: PendingInlineImage[],
  ) {
    if (!editor) return;
    const editorProjectId = editor.task?.projectId ?? editor.projectId;
    if (!editorProjectId) return;
    setActionError(null);
    try {
      const creating = editor.task === null;
      let saved = editor.task
        ? await updateTaskRequest(editor.task, draft)
        : await createTaskRequest(editorProjectId, draft);
      if (creating) {
        setProjects((current) => current.map((project) => (
          project.id === editorProjectId
            ? { ...project, issueCount: project.issueCount + 1 }
            : project
        )));
      }
      let uploadedAttachments = 0;
      let failedAttachments = 0;
      if (creating && (attachments.length > 0 || inlineImages.length > 0)) {
        const [results, inlineAttachments] = await Promise.all([
          Promise.allSettled(
            attachments.map((file) => uploadAttachment(saved.id, file)),
          ),
          Promise.all(
            inlineImages.map((image) => uploadAttachment(saved.id, image.file)),
          ),
        ]);
        uploadedAttachments = results.filter((result) => result.status === "fulfilled").length;
        failedAttachments = results.length - uploadedAttachments;
        if (inlineImages.length > 0) {
          const description = resolveInlineMediaMarkdown(
            draft.description,
            inlineImages,
            inlineAttachments,
          );
          saved = await updateTaskRequest(saved, { ...draft, description });
        }
      }
      const relationResult = creating && editor.parentTaskId
        ? await addTaskRelation(saved, "parent", editor.parentTaskId)
        : null;
      if (relationResult) saved = relationResult.task;
      setTasks((current) => sortTasks([
        ...current
          .filter((task) => task.id !== saved.id)
          .map((task) => task.id === relationResult?.relatedTask.id ? relationResult.relatedTask : task),
        saved,
      ]));
      setEditor(null);
      if (editor.draft) {
        setIssueDrafts((current) => {
          const next = current.filter((candidate) => candidate.id !== editor.draft?.id);
          persistIssueDrafts(next);
          return next;
        });
      }
      if (failedAttachments > 0) {
        setActionError(`${saved.identifier} 已创建，但有 ${failedAttachments} 个附件上传失败，可在详情页重试。`);
      }
      if (creating) {
        const totalUploaded = uploadedAttachments + inlineImages.length;
        const message = `${saved.identifier} 已创建${totalUploaded > 0 ? `，已上传 ${totalUploaded} 个附件` : ""}。`;
        pushUndo(message, async () => {
          const candidate = tasksRef.current.find((task) => task.id === saved.id);
          const current = candidate && candidate.version >= saved.version ? candidate : saved;
          const archived = await archiveTaskRequest(current);
          setTasks((tasks) => sortTasks(tasks.map((task) => task.id === archived.id ? archived : task)));
        });
      } else if (editor.task) {
        const previous = editor.task;
        const previousAssigneeTarget = assigneeTargetForActor(previous.assignee, currentUser);
        if (!draft.assigneeTarget || previousAssigneeTarget) {
          pushUndo(
            `${saved.identifier} 已更新。`,
            () => restoreTaskDetails(previous, saved, previousAssigneeTarget),
          );
        }
      }
    } catch (error) {
      if (error instanceof ApiError && error.code === "VERSION_CONFLICT") {
        void refreshTasks(selectedProjectId || editorProjectId, { quiet: true });
      }
      throw error;
    }
  }

  function knowledgeWorkspaceForTask(task: Task): string | undefined {
    const taskContext = task.developmentContext;
    if (taskContext?.type === "worktree") {
      const matchingWorktree = developmentScan.contexts.find((context) => (
        context.type === "worktree"
        && (context.path === taskContext.path
          || (taskContext.branch && context.branch === taskContext.branch))
      ));
      if (matchingWorktree?.type === "worktree") return matchingWorktree.path;
    }
    return selectedDeviceWorkspacePath
      ?? developmentScan.workspacePath
      ?? selectedProject?.workspacePath
      ?? hostContext?.workspacePath;
  }

  async function createTaskKnowledgeProposal(
    task: Task,
    selectedComments?: Comment[],
    trigger = "manual",
  ): Promise<boolean> {
    if (!localKnowledgeAvailable) {
      throw new Error("当前入口无法访问本地项目文件，请启动本地 Taskboard 服务后重试。");
    }
    const workspacePath = knowledgeWorkspaceForTask(task);
    if (!workspacePath) throw new Error("请先为项目映射本地目录。");
    const comments = selectedComments ?? await listComments(task.id);
    const sourceType = selectedComments ? "comments" as const : "issue" as const;
    const generated = await generateKnowledgeProposal(task.projectId, {
      workspacePath,
      sourceType,
      developmentContext: task.developmentContext
        ? { type: task.developmentContext.type, branch: task.developmentContext.branch }
        : null,
      sourceSnapshot: {
        trigger,
        capturedAt: new Date().toISOString(),
        issue: {
          id: task.id,
          identifier: task.identifier,
          title: task.title,
          description: task.description,
          status: task.status,
          version: task.version,
          updatedAt: task.updatedAt,
          labels: task.labels,
        },
        comments: comments.map((comment) => ({
          id: comment.id,
          body: comment.body,
          authorName: comment.authorName,
          version: comment.version,
          updatedAt: comment.updatedAt,
          attachments: comment.attachments.map((attachment) => ({
            id: attachment.id,
            filename: attachment.filename,
            contentType: attachment.contentType,
          })),
        })),
      },
    });
    if (generated.changes.length === 0) return false;
    const automatic = trigger === "in_review" || trigger === "completed";
    const existing = automatic
      ? (await listKnowledgeProposals(task.projectId, "ready")).find((proposal) => (
        proposal.sourceType === "issue"
        && (proposal.sourceSnapshot.issue as { id?: string } | undefined)?.id === task.id
      ))
      : undefined;
    if (existing) {
      await updateKnowledgeProposal(existing, {
        title: generated.title,
        summary: generated.summary,
        changes: generated.changes,
      });
    } else {
      await createKnowledgeProposal(task.projectId, generated);
    }
    setKnowledgeRevision((current) => current + 1);
    return true;
  }

  function queueAutomaticKnowledgeReview(task: Task, trigger: "in_review" | "completed") {
    if (!localKnowledgeAvailable || !knowledgeWorkspaceForTask(task)) return;
    void createTaskKnowledgeProposal(task, undefined, trigger)
      .then((created) => {
        setAnnouncement(created
          ? `${task.identifier} 已生成待确认知识提案。`
          : `${task.identifier} 复盘完成，没有新的长期知识。`);
      })
      .catch((error) => setActionError(`知识复盘未完成：${errorMessage(error)}`));
  }

  async function moveTask(
    task: Task,
    status: TaskStatus,
    beforeTaskId: string | null = null,
    silent = false,
  ) {
    if (movingTaskId) {
      setDropTarget(null);
      setDraggedTaskId(null);
      setDraggedTaskHeight(0);
      return;
    }

    const destination = tasks.filter((candidate) => candidate.status === status && candidate.id !== task.id);
    const insertionIndex = beforeTaskId
      ? destination.findIndex((candidate) => candidate.id === beforeTaskId)
      : destination.length;
    const targetIndex = insertionIndex < 0 ? destination.length : insertionIndex;
    const desiredOrder = [...destination];
    desiredOrder.splice(targetIndex, 0, task);
    const currentOrder = tasks.filter((candidate) => candidate.status === status);
    if (
      task.status === status
      && currentOrder.length === desiredOrder.length
      && currentOrder.every((candidate, index) => candidate.id === desiredOrder[index].id)
    ) {
      setDropTarget(null);
      setDraggedTaskId(null);
      setDraggedTaskHeight(0);
      return;
    }
    const previousTask = destination[targetIndex - 1] ?? null;
    const nextTask = destination[targetIndex] ?? null;
    const sortOrder = previousTask && nextTask
      ? (previousTask.sortOrder + nextTask.sortOrder) / 2
      : previousTask
        ? previousTask.sortOrder + 1024
        : nextTask
          ? nextTask.sortOrder - 1024
          : 1024;
    const previous = task;
    setActionError(null);
    setMovingTaskId(task.id);
    setTasks((current) => sortTasks(current.map((candidate) =>
      candidate.id === task.id ? { ...candidate, status, sortOrder } : candidate,
    )));

    try {
      const moved = await moveTaskRequest(task, status, sortOrder);
      setTasks((current) => sortTasks(current.map((candidate) =>
        candidate.id === moved.id ? moved : candidate,
      )));
      if (task.status !== moved.status && (moved.status === "in_review" || moved.status === "done")) {
        queueAutomaticKnowledgeReview(moved, moved.status === "done" ? "completed" : "in_review");
      }
      const message = task.status === status
        ? `${task.identifier} 排序已调整。`
        : `${task.identifier} 已移至${STATUS_DETAILS[status].label}。`;
      pushUndo(message, async () => {
        const candidate = tasksRef.current.find((current) => current.id === moved.id);
        const current = candidate && candidate.version >= moved.version ? candidate : moved;
        const restored = await moveTaskRequest(current, previous.status, previous.sortOrder);
        setTasks((tasks) => sortTasks(tasks.map((item) => item.id === restored.id ? restored : item)));
      }, !silent);
    } catch (error) {
      setTasks((current) => sortTasks(current.map((candidate) =>
        candidate.id === previous.id ? previous : candidate,
      )));
      setActionError(error instanceof ApiError && error.code === "VERSION_CONFLICT"
        ? "That issue changed elsewhere. The board has been refreshed."
        : errorMessage(error));
      if (selectedProjectId) void refreshTasks(selectedProjectId, { quiet: true });
    } finally {
      setMovingTaskId(null);
      setDropTarget(null);
      setDraggedTaskId(null);
      setDraggedTaskHeight(0);
    }
  }

  function finishTaskDrop(destination: TaskStatus, taskId: string, beforeTaskId: string | null = null) {
    const task = tasks.find((candidate) => candidate.id === taskId);
    setDraggedTaskId(null);
    setDraggedTaskHeight(0);
    setDropTarget(null);
    if (!task) return;
    setSettlingTaskId(task.id);
    window.setTimeout(() => {
      setSettlingTaskId((current) => current === task.id ? null : current);
    }, 220);
    void moveTask(task, destination, beforeTaskId, true);
  }

  async function updateTaskProperties(task: Task, changes: Partial<TaskDraft>, message?: string): Promise<Task> {
    const previous = task;
    const { assigneeTarget, ...taskChanges } = changes;
    const optimisticAssignee = assigneeTarget
      ? actorForAssigneeTarget(assigneeTarget, currentUser)
      : task.assignee;
    setActionError(null);
    setTasks((current) => current.map((candidate) =>
      candidate.id === task.id
        ? { ...candidate, ...taskChanges, assignee: optimisticAssignee }
        : candidate,
    ));

    try {
      const updated = await updateTaskRequest(task, { ...taskToDraft(task), ...changes });
      setTasks((current) => sortTasks(current.map((candidate) =>
        candidate.id === updated.id ? updated : candidate,
      )));
      if (previous.status !== updated.status && (updated.status === "in_review" || updated.status === "done")) {
        queueAutomaticKnowledgeReview(updated, updated.status === "done" ? "completed" : "in_review");
      }
      const previousAssigneeTarget = assigneeTargetForActor(previous.assignee, currentUser);
      if (!assigneeTarget || previousAssigneeTarget) {
        pushUndo(
          message ?? `${task.identifier} 已更新。`,
          () => restoreTaskDetails(previous, updated, previousAssigneeTarget),
        );
      }
      return updated;
    } catch (error) {
      setTasks((current) => sortTasks(current.map((candidate) =>
        candidate.id === previous.id ? previous : candidate,
      )));
      setActionError(error instanceof ApiError && error.code === "VERSION_CONFLICT"
        ? "该议题已在其他位置更新，看板已重新同步。"
        : errorMessage(error));
      if (selectedProjectId) void refreshTasks(selectedProjectId, { quiet: true });
      throw error;
    }
  }

  async function transferTaskToProject(task: Task, projectId: string) {
    setActionError(null);
    try {
      const result = await transferTaskProjectRequest(task, projectId);
      setProjects((current) => current.map((project) => {
        if (project.id === result.previousProjectId) {
          return { ...project, issueCount: Math.max(0, project.issueCount - 1) };
        }
        if (project.id === projectId) {
          return { ...project, issueCount: project.issueCount + 1 };
        }
        return project;
      }));
      setBoardView(readProjectBoardView(projectId));
      setSelectedProjectId(projectId);
      setTasks([result.task]);
      setDetailTaskIdentifier(result.task.identifier);
      setSearch("");
      setFilters(EMPTY_TASK_FILTERS);
      setFavoriteTasksOnly(false);
      window.localStorage.setItem(LAST_PROJECT_KEY, projectId);
      const url = buildIssueUrl(window.location.href, projectId, result.task.identifier);
      url.searchParams.delete(GLOBAL_VIEW_QUERY_PARAM);
      window.history.replaceState(window.history.state, "", url);
      void refreshTasks(projectId, { quiet: true });
      void refreshProjectList();
      return result;
    } catch (error) {
      setActionError(error instanceof ApiError && error.code === "VERSION_CONFLICT"
        ? "该议题已在其他位置更新，请刷新后重试迁移。"
        : errorMessage(error));
      throw error;
    }
  }

  async function linkTaskToThread(task: Task, threadId: string): Promise<Task> {
    setActionError(null);
    try {
      const updated = await linkTaskThreadRequest(task, threadId);
      setTasks((current) => sortTasks(current.map((candidate) => (
        candidate.id === updated.id ? updated : candidate
      ))));
      return updated;
    } catch (error) {
      setActionError(error instanceof ApiError && error.code === "VERSION_CONFLICT"
        ? "该议题已在其他位置更新，看板已重新同步。"
        : errorMessage(error));
      if (selectedProjectId) void refreshTasks(selectedProjectId, { quiet: true });
      throw error;
    }
  }

  async function unlinkTaskFromThread(task: Task, threadId: string): Promise<Task> {
    setActionError(null);
    try {
      const updated = await unlinkTaskThreadRequest(task, threadId);
      setTasks((current) => sortTasks(current.map((candidate) => (
        candidate.id === updated.id ? updated : candidate
      ))));
      return updated;
    } catch (error) {
      setActionError(error instanceof ApiError && error.code === "VERSION_CONFLICT"
        ? "该议题已在其他位置更新，看板已重新同步。"
        : errorMessage(error));
      if (selectedProjectId) void refreshTasks(selectedProjectId, { quiet: true });
      throw error;
    }
  }

  async function mutateTaskRelation(
    action: "add" | "remove",
    task: Task,
    type: IssueRelationType,
    relatedTaskId: string,
  ) {
    setActionError(null);
    try {
      const result = action === "add"
        ? await addTaskRelation(task, type, relatedTaskId)
        : await removeTaskRelation(task, type, relatedTaskId);
      setTasks((current) => sortTasks(current.map((candidate) => {
        if (candidate.id === result.task.id) return result.task;
        if (candidate.id === result.relatedTask.id) return result.relatedTask;
        return candidate;
      })));
      if (selectedProjectId) void refreshTasks(selectedProjectId, { quiet: true });
      return result;
    } catch (error) {
      setActionError(error instanceof ApiError && error.code === "VERSION_CONFLICT"
        ? "该议题已在其他位置更新，看板已重新同步。"
        : errorMessage(error));
      if (selectedProjectId) void refreshTasks(selectedProjectId, { quiet: true });
      throw error;
    }
  }

  async function duplicateTask(task: Task) {
    setActionError(null);
    try {
      const duplicated = await createTaskRequest(task.projectId, {
        ...taskToDraft(task),
        assigneeTarget: assigneeTargetForActor(task.assignee, currentUser),
        developmentContext: null,
      });
      setTasks((current) => sortTasks([...current, duplicated]));
      pushUndo(`${duplicated.identifier} 副本已创建。`, async () => {
        const candidate = tasksRef.current.find((current) => current.id === duplicated.id);
        const current = candidate && candidate.version >= duplicated.version ? candidate : duplicated;
        const archived = await archiveTaskRequest(current);
        setTasks((tasks) => sortTasks(tasks.map((item) => item.id === archived.id ? archived : item)));
      });
    } catch (error) {
      setActionError(errorMessage(error));
    }
  }

  async function archiveTask(task: Task) {
    await moveTask(task, "archived");
  }

  async function copyText(text: string, message: string) {
    try {
      await navigator.clipboard.writeText(text);
      setAnnouncement(message);
    } catch {
      setActionError("无法写入剪贴板。");
    }
  }

  function openThread(threadId: string, task?: Task) {
    const normalizedThreadId = normalizeCodexThreadId(threadId);
    if (!normalizedThreadId) {
      setActionError("该任务关联的是旧版临时会话 ID，尚未形成可打开的会话。");
      return;
    }
    const resolvedTask = task ?? tasks.find((candidate) => (
      normalizeCodexThreadId(candidate.threadId) === normalizedThreadId
      || candidate.threadIds?.some((candidateThreadId) => (
        normalizeCodexThreadId(candidateThreadId) === normalizedThreadId
      ))
    ));
    if (!resolvedTask) {
      setActionError("没有找到该会话关联的议题，无法判断会话运行时。");
      return;
    }
    const resolvedRuntime = taskThreadRuntime(resolvedTask, normalizedThreadId);
    if (resolvedRuntime === "claude") {
      const workspacePath = resolveTaskWorkspacePath(resolvedTask);
      if (!workspacePath) {
        setActionError("该任务所属项目尚未映射本地目录，无法打开 Claude 会话。");
        return;
      }
      void resumeClaudeSession({ threadId: normalizedThreadId, workspacePath }).catch((error) => {
        setActionError(errorMessage(error));
      });
      return;
    }
    if (resolvedRuntime === "omp") {
      const workspacePath = resolveTaskWorkspacePath(resolvedTask);
      if (!workspacePath) {
        setActionError("该任务所属项目尚未映射本地目录，无法打开 Oh My Pi 会话。");
        return;
      }
      void resumeOmpSession({ threadId: normalizedThreadId, workspacePath }).catch((error) => {
        setActionError(errorMessage(error));
      });
      return;
    }
    if (embedded && window.parent !== window) {
      window.parent.postMessage({
        type: "taskboard:open-thread",
        payload: { threadId: normalizedThreadId },
      }, "*");
      return;
    }

    window.location.assign(`codex://threads/${encodeURIComponent(normalizedThreadId)}`);
  }

  function expandCodexSidebar() {
    if (!embedded || window.parent === window) return;
    window.parent.postMessage({ type: "taskboard:expand-sidebar" }, "*");
  }

  function resolveTaskWorkspacePath(task: Task): string | null {
    const worktreePath = task.developmentContext?.type === "worktree"
      ? task.developmentContext.path
      : null;
    const taskProject = projects.find((project) => project.id === task.projectId) ?? null;
    const workspacePath = worktreePath
      ?? deviceWorkspacePaths[task.projectId]
      ?? taskProject?.workspacePath
      ?? (task.projectId === selectedProjectId ? developmentScan.workspacePath : null);
    return workspacePath ?? null;
  }

  function taskThreadInstruction(task: Task, followUp?: string) {
    const instruction = `e-taskboard Addressing the issues mentioned in ${task.identifier}`;
    const normalizedFollowUp = followUp?.trim();
    return normalizedFollowUp
      ? `${instruction}\n\n请重点跟进这条评论：\n${normalizedFollowUp}`
      : instruction;
  }

  function taskSkill(task: Task) {
    const projectKnowledgeTask = task.labels.includes("项目知识库")
      && task.description.includes("项目知识库构建");
    if (projectKnowledgeTask) {
      return {
        name: "project-knowledge-builder",
        displayName: "Project Knowledge Builder",
        path: projectKnowledgeSkillPath,
      };
    }
    return {
      name: "manage-taskboard",
      displayName: "Manage Taskboard",
      path: manageTaskboardSkillPath,
    };
  }

  async function finalizeThreadLink(args: {
    requestId: string;
    taskId: string;
    projectId: string;
    commentId?: string;
    threadId: string;
    runtime: TaskRuntime;
    sendAck: boolean;
  }) {
    if (finalizingThreadRequestsRef.current.has(args.requestId)) return;
    finalizingThreadRequestsRef.current.add(args.requestId);
    try {
      if (args.commentId) {
        let commentLinked = false;
        for (let attempt = 0; attempt < 2 && !commentLinked; attempt += 1) {
          const comments = await listComments(args.taskId);
          const comment = comments.find((candidate) => candidate.id === args.commentId);
          if (!comment) throw new Error("没有找到需要关联会话的评论。");
          if (normalizeCodexThreadId(comment.threadId) === args.threadId) {
            commentLinked = true;
            break;
          }
          try {
            await updateCommentRequest(comment, comment.body, args.threadId);
            commentLinked = true;
          } catch (error) {
            if (!(error instanceof ApiError) || error.code !== "VERSION_CONFLICT" || attempt > 0) {
              throw error;
            }
          }
        }
        if (!commentLinked) throw new Error("评论会话关联没有完成。");
        setCommentsRevision((current) => current + 1);
      }

      let latestTasks = await listTasks(args.projectId);
      let task = latestTasks.find((candidate) => candidate.id === args.taskId);
      if (!task) throw new Error("没有找到需要关联会话的议题。");
      if (normalizeCodexThreadId(task.threadId) !== args.threadId) {
        try {
          task = await linkTaskThreadRequest(task, args.threadId, args.runtime);
          latestTasks = latestTasks.map((candidate) => candidate.id === task?.id ? task : candidate);
        } catch (error) {
          if (!(error instanceof ApiError) || error.code !== "VERSION_CONFLICT") throw error;
          latestTasks = await listTasks(args.projectId);
          task = latestTasks.find((candidate) => candidate.id === args.taskId);
          if (!task) throw new Error("没有找到需要关联会话的议题。");
          if (normalizeCodexThreadId(task.threadId) !== args.threadId) {
            task = await linkTaskThreadRequest(task, args.threadId, args.runtime);
            latestTasks = latestTasks.map((candidate) => candidate.id === task?.id ? task : candidate);
          }
        }
      }
      if (selectedProjectIdRef.current === args.projectId) {
        setTasks(sortTasks(latestTasks));
      }
      pendingThreadRequestsRef.current.delete(args.requestId);
      writePendingThreadRequests(pendingThreadRequestsRef.current);
      setOpeningThreadTaskId(null);
      if (args.sendAck && embedded && window.parent !== window) {
        window.parent.postMessage({
          type: "taskboard:thread-link-ack",
          payload: { requestId: args.requestId, taskId: args.taskId, commentId: args.commentId, threadId: args.threadId },
        }, "*");
      }
    } catch (error) {
      setActionError(`会话已创建，但关联尚未完成：${errorMessage(error)} 将自动重试。`);
    } finally {
      finalizingThreadRequestsRef.current.delete(args.requestId);
    }
  }

  function openTaskInThread(task: Task, followUp?: string, comment?: Comment, runtime: TaskRuntime = "codex") {
    const taskProject = projects.find((project) => project.id === task.projectId) ?? null;
    const workspacePath = resolveTaskWorkspacePath(task);
    if (!taskProject || !workspacePath) {
      setActionError("该任务所属项目尚未映射本地目录，无法创建正确归属的会话。");
      return;
    }
    const instruction = taskThreadInstruction(task, followUp);

    if (runtime === "claude") {
      if (!claudeRuntimeSupported) {
        setActionError("当前环境不支持 Claude Code 运行时（仅 macOS Terminal.app）。");
        return;
      }
      if (openingThreadTaskId) return;
      const requestId = crypto.randomUUID();
      pendingThreadRequestsRef.current.set(requestId, {
        taskId: task.id,
        projectId: task.projectId,
        commentId: comment?.id,
        action: "create",
        createdAt: Date.now(),
      });
      writePendingThreadRequests(pendingThreadRequestsRef.current);
      setOpeningThreadTaskId(task.id);
      setActionError(null);
      void (async () => {
        try {
          const result = await createClaudeSession({
            requestId,
            taskId: task.id,
            workspacePath,
            instruction,
            commentId: comment?.id,
          });
          await finalizeThreadLink({
            requestId,
            taskId: task.id,
            projectId: task.projectId,
            commentId: comment?.id,
            threadId: result.threadId,
            runtime: "claude",
            sendAck: false,
          });
        } catch (error) {
          pendingThreadRequestsRef.current.delete(requestId);
          writePendingThreadRequests(pendingThreadRequestsRef.current);
          setOpeningThreadTaskId(null);
          setActionError(errorMessage(error) || "无法启动 Claude 会话。");
        }
      })();
      return;
    }
    if (runtime === "omp") {
      if (!ompRuntimeSupported) {
        setActionError("当前环境不支持 Oh My Pi 运行时（仅 macOS Terminal.app）。");
        return;
      }
      if (openingThreadTaskId) return;
      const requestId = crypto.randomUUID();
      pendingThreadRequestsRef.current.set(requestId, {
        taskId: task.id,
        projectId: task.projectId,
        commentId: comment?.id,
        action: "create",
        createdAt: Date.now(),
      });
      writePendingThreadRequests(pendingThreadRequestsRef.current);
      setOpeningThreadTaskId(task.id);
      setActionError(null);
      void (async () => {
        try {
          const result = await createOmpSession({
            requestId,
            taskId: task.id,
            workspacePath,
            instruction,
            commentId: comment?.id,
          });
          await finalizeThreadLink({
            requestId,
            taskId: task.id,
            projectId: task.projectId,
            commentId: comment?.id,
            threadId: result.threadId,
            runtime: "omp",
            sendAck: false,
          });
        } catch (error) {
          pendingThreadRequestsRef.current.delete(requestId);
          writePendingThreadRequests(pendingThreadRequestsRef.current);
          setOpeningThreadTaskId(null);
          setActionError(errorMessage(error) || "无法启动 Oh My Pi 会话。");
        }
      })();
      return;
    }

    const skill = taskSkill(task);
    if (!skill.path) {
      setActionError(`任务面板还没有读取到 ${skill.displayName} Skill 路径，请刷新后重试。`);
      return;
    }
    const prompt = `[$${skill.name}](${skill.path}) ${instruction}`;

    if (!embedded || window.parent === window) {
      const query = new URLSearchParams();
      if (workspacePath) query.set("path", workspacePath);
      query.set("prompt", prompt);
      window.location.assign(`codex://new?${query.toString().replace(/\+/g, "%20")}`);
      return;
    }
    if (openingThreadTaskId) return;
    const requestId = crypto.randomUUID();
    const codexProject = hostContext?.projects?.find((project) => project.id === task.projectId)
      ?? hostContext?.projects?.find((project) => deviceWorkspacePaths[project.id] === workspacePath);
    pendingThreadRequestsRef.current.set(requestId, {
      taskId: task.id,
      projectId: task.projectId,
      commentId: comment?.id,
      action: "create",
      createdAt: Date.now(),
    });
    writePendingThreadRequests(pendingThreadRequestsRef.current);
    setOpeningThreadTaskId(task.id);
    setActionError(null);
    window.parent.postMessage({
      type: "taskboard:create-thread",
      payload: {
        requestId,
        taskId: task.id,
        commentId: comment?.id,
        identifier: task.identifier,
        instruction,
        skillName: skill.name,
        skillDisplayName: skill.displayName,
        skillPath: skill.path,
        codexProjectId: codexProject?.id ?? taskProject.id,
        projectName: taskProject.name,
        workspacePath,
        workspaceLabel: workspaceName(workspacePath),
      },
    }, "*");
  }

  function followUpTaskInThread(task: Task, threadId: string, followUp: string, runtime: TaskRuntime = task.runtime) {
    const normalizedThreadId = normalizeCodexThreadId(threadId);
    if (!normalizedThreadId) {
      setActionError("该议题关联的是旧版临时会话 ID，无法继续跟进。");
      return;
    }
    if (runtime === "claude") {
      const workspacePath = resolveTaskWorkspacePath(task);
      if (!workspacePath) {
        setActionError("该任务所属项目尚未映射本地目录，无法打开 Claude 会话。");
        return;
      }
      setActionError(null);
      void resumeClaudeSession({
        threadId: normalizedThreadId,
        workspacePath,
        followUp: taskThreadInstruction(task, followUp),
      }).catch((error) => {
        setActionError(errorMessage(error));
      });
      return;
    }
    if (runtime === "omp") {
      const workspacePath = resolveTaskWorkspacePath(task);
      if (!workspacePath) {
        setActionError("该任务所属项目尚未映射本地目录，无法打开 Oh My Pi 会话。");
        return;
      }
      setActionError(null);
      void resumeOmpSession({
        threadId: normalizedThreadId,
        workspacePath,
        followUp: taskThreadInstruction(task, followUp),
      }).catch((error) => {
        setActionError(errorMessage(error));
      });
      return;
    }
    const skill = taskSkill(task);
    if (!skill.path) {
      setActionError(`任务面板还没有读取到 ${skill.displayName} Skill 路径，请刷新后重试。`);
      return;
    }
    if (!embedded || window.parent === window) {
      openThread(normalizedThreadId, task);
      return;
    }
    if (openingThreadTaskId) return;
    const requestId = crypto.randomUUID();
    pendingThreadRequestsRef.current.set(requestId, {
      taskId: task.id,
      projectId: task.projectId,
      action: "follow-up",
      threadId: normalizedThreadId,
      createdAt: Date.now(),
    });
    writePendingThreadRequests(pendingThreadRequestsRef.current);
    setOpeningThreadTaskId(task.id);
    setActionError(null);
    window.parent.postMessage({
      type: "taskboard:follow-up-thread",
      payload: {
        requestId,
        taskId: task.id,
        threadId: normalizedThreadId,
        identifier: task.identifier,
        instruction: taskThreadInstruction(task, followUp),
        skillName: skill.name,
        skillDisplayName: skill.displayName,
        skillPath: skill.path,
      },
    }, "*");
  }

  function changeProject(projectId: string) {
    closeContextMenu();
    setProjectMenuOpen(false);
    setDetailTaskIdentifier(null);
    setBoardView(readProjectBoardView(projectId));
    setSelectedProjectId(projectId);
    window.localStorage.setItem(LAST_PROJECT_KEY, projectId);
    setSearch("");
    setFilters(EMPTY_TASK_FILTERS);
    setFavoriteTasksOnly(false);
    setActionError(null);
    undoStackRef.current = [];
    setUndoNotice(null);
    const url = buildIssueUrl(window.location.href, projectId, null);
    url.searchParams.delete(GLOBAL_VIEW_QUERY_PARAM);
    window.history.replaceState(null, "", url);
  }

  function openGlobalBoard(view: "issues" | "drafts" = "issues") {
    closeContextMenu();
    setProjectMenuOpen(false);
    setDetailTaskIdentifier(null);
    setSelectedProjectId(GLOBAL_PROJECT_ID);
    setBoardView(view);
    window.localStorage.removeItem(LAST_PROJECT_KEY);
    setSearch("");
    setFilters(EMPTY_TASK_FILTERS);
    setFavoriteTasksOnly(false);
    setActionError(null);
    const url = buildIssueUrl(window.location.href, null, null);
    url.searchParams.set(GLOBAL_VIEW_QUERY_PARAM, GLOBAL_VIEW_QUERY_VALUE);
    window.history.replaceState(null, "", url);
  }

  function returnToProjectHome() {
    closeContextMenu();
    setProjectMenuOpen(false);
    setDetailTaskIdentifier(null);
    setSelectedProjectId("");
    window.localStorage.removeItem(LAST_PROJECT_KEY);
    setSearch("");
    setFilters(EMPTY_TASK_FILTERS);
    setFavoriteTasksOnly(false);
    setActionError(null);
    undoStackRef.current = [];
    setUndoNotice(null);
    const url = buildIssueUrl(window.location.href, null, null);
    url.searchParams.delete(GLOBAL_VIEW_QUERY_PARAM);
    window.history.replaceState(null, "", url);
    void loadProjectList();
  }

  function toggleFavoriteProjectById(projectId: string, projectName: string) {
    const shouldFavorite = !favoriteProjectIds.has(projectId);
    setFavoriteProjectIds((current) => {
      const next = new Set(current);
      if (shouldFavorite) next.add(projectId);
      else next.delete(projectId);
      window.localStorage.setItem(FAVORITE_PROJECTS_KEY, JSON.stringify([...next]));
      return next;
    });
    setAnnouncement(`${projectName}${shouldFavorite ? "已收藏。" : "已取消收藏。"}`);
  }

  function toggleFavoriteTask(task: Task) {
    const shouldFavorite = !favoriteTaskIds.has(task.id);
    setFavoriteTaskIds((current) => {
      const next = new Set(current);
      if (shouldFavorite) next.add(task.id);
      else next.delete(task.id);
      window.localStorage.setItem(FAVORITE_TASKS_KEY, JSON.stringify([...next]));
      return next;
    });
    setAnnouncement(`${task.identifier}${shouldFavorite ? "已添加到收藏夹。" : "已取消收藏。"}`);
  }

  function toggleFavoriteProject() {
    if (!selectedProjectId) return;
    toggleFavoriteProjectById(
      selectedProjectId,
      projectAliases[selectedProjectId] ?? selectedProject?.name ?? "项目",
    );
  }

  function saveProjectName(project: ProjectChoice) {
    const nextName = projectNameDraft.trim();
    setRenamingProjectId(null);
    if (!nextName || nextName === project.name) return;
    setProjectAliases((current) => {
      const next = { ...current };
      if (nextName === project.sourceName) delete next[project.id];
      else next[project.id] = nextName;
      window.localStorage.setItem(PROJECT_ALIASES_KEY, JSON.stringify(next));
      return next;
    });
    setAnnouncement(`${project.name} 已重命名为 ${nextName}，项目目录未改变。`);
  }

  function setProjectArchived(project: ProjectChoice, archived: boolean) {
    setArchivedProjectIds((current) => {
      const next = new Set(current);
      if (archived) next.add(project.id);
      else next.delete(project.id);
      window.localStorage.setItem(ARCHIVED_PROJECTS_KEY, JSON.stringify([...next]));
      return next;
    });
    setAnnouncement(`${project.name}${archived ? "已归档。" : "已恢复。"}`);
  }

  function reorderProject(draggedId: string, targetId: string) {
    if (draggedId === targetId) return;
    const dragged = activeProjectChoices.find((project) => project.id === draggedId);
    const target = activeProjectChoices.find((project) => project.id === targetId);
    if (!dragged || !target || favoriteProjectIds.has(draggedId) !== favoriteProjectIds.has(targetId)) return;
    const favorite = favoriteProjectIds.has(draggedId);
    const groupIds = activeProjectChoices
      .filter((project) => favoriteProjectIds.has(project.id) === favorite)
      .map((project) => project.id);
    const fromIndex = groupIds.indexOf(draggedId);
    const targetIndex = groupIds.indexOf(targetId);
    groupIds.splice(fromIndex, 1);
    groupIds.splice(targetIndex, 0, draggedId);
    setProjectOrder((current) => {
      const groupSet = new Set(groupIds);
      const next = [...current.filter((projectId) => !groupSet.has(projectId)), ...groupIds];
      window.localStorage.setItem(PROJECT_ORDER_KEY, JSON.stringify(next));
      return next;
    });
    setAnnouncement(`${dragged.name} 的顺序已调整。`);
  }

  async function createProjectFromHome(draft: ProjectCreateDraft) {
    if (!draft.name) {
      setActionError("请输入项目名称。");
      return;
    }
    if (!isAbsoluteWorkspacePath(draft.workspacePath)) {
      setActionError("本地项目目录必须填写绝对路径。");
      return;
    }
    if (projectCreatePending) return;
    setProjectCreatePending(true);
    setActionError(null);
    try {
      const activation = await activateCodexProject(draft);
      const linkedWithCodex = embedded && window.parent !== window;
      if (linkedWithCodex && (!activation.project?.id || !activation.project.name)) {
        throw new Error("Codex 已切换目录，但没有返回可关联的项目，请重试。");
      }
      const project = await createProjectRequest({
        ...(activation.project?.id ? { id: activation.project.id } : {}),
        name: draft.name,
        workspacePath: draft.workspacePath,
      });
      await setDeviceWorkspace(project.id, draft.workspacePath);
      rememberDeviceWorkspacePath(project.id, draft.workspacePath);
      setProjects((current) => [
        ...current.filter((candidate) => candidate.id !== project.id),
        project,
      ]);
      setProjectCreatorOpen(false);
      setAnnouncement(`${project.name} 已新增${linkedWithCodex ? "，并同步到 Codex 项目。" : "。"}`);
    } catch (error) {
      setActionError(error instanceof ApiError && error.code === "PROJECT_EXISTS"
        ? "该项目已经存在，可直接从项目列表打开。"
        : errorMessage(error));
    } finally {
      setProjectCreatePending(false);
    }
  }

  async function chooseProjectWorkspace() {
    setActionError(null);
    try {
      return await chooseLocalDirectory();
    } catch (error) {
      setActionError(errorMessage(error));
      return null;
    }
  }

  async function selectProject(choice: ProjectChoice) {
    if (openingProjectId) return;
    setOpeningProjectId(choice.id);
    setActionError(null);
    try {
      let project = projects.find((candidate) => candidate.id === choice.id) ?? null;
      if (!project) {
        try {
          project = await createProjectRequest({
            id: choice.id,
            name: choice.sourceName,
            workspacePath: null,
          });
          setProjects((current) => [...current, project!]);
        } catch (error) {
          if (!(error instanceof ApiError) || error.code !== "PROJECT_EXISTS") throw error;
          const nextProjects = await listProjects();
          setProjects(nextProjects);
          project = nextProjects.find((candidate) => candidate.id === choice.id) ?? null;
          if (!project) throw error;
        }
      }
      changeProject(project.id);
    } catch (error) {
      setActionError(errorMessage(error));
    } finally {
      setOpeningProjectId(null);
    }
  }

  function renderProjectCard(project: ProjectChoice, options: { archived?: boolean; draggable?: boolean } = {}) {
    const archived = options.archived === true;
    const draggable = options.draggable === true && renamingProjectId !== project.id;
    const editing = renamingProjectId === project.id;
    const cardContent = (
      <>
        <span className="project-card-avatar" aria-hidden="true">
          {project.name.slice(0, 1).toUpperCase()}
        </span>
        <span className="project-card-copy">
          {editing ? (
            <input
              className="project-card-name-input"
              type="text"
              value={projectNameDraft}
              maxLength={200}
              autoFocus
              aria-label={`重命名 ${project.name}`}
              onChange={(event) => setProjectNameDraft(event.currentTarget.value)}
              onBlur={() => saveProjectName(project)}
              onKeyDown={(event) => {
                if (event.key === "Enter") event.currentTarget.blur();
                if (event.key === "Escape") {
                  setRenamingProjectId(null);
                  setProjectNameDraft("");
                }
              }}
            />
          ) : <strong>{project.name}</strong>}
          <span>
            {project.inCodex ? "Codex 项目" : "已保存的项目"}
            {project.issueCount > 0 ? ` · ${project.issueCount} 个议题` : ""}
          </span>
        </span>
        {favoriteProjectIds.has(project.id) && (
          <span className="project-card-favorite" aria-label="已收藏"><LinearIcon name="favorite" /></span>
        )}
        {!editing && !archived && (
          <span className="project-card-action" aria-hidden="true">
            {openingProjectId === project.id ? "正在打开…" : <LinearIcon name="chevronRight" />}
          </span>
        )}
      </>
    );

    return (
      <div
        className={`project-card${draggedProjectId === project.id ? " dragging" : ""}`}
        key={project.id}
        draggable={draggable}
        onDragStart={(event) => {
          if (!draggable) return;
          event.dataTransfer.effectAllowed = "move";
          event.dataTransfer.setData("text/plain", project.id);
          setDraggedProjectId(project.id);
        }}
        onDragEnd={() => setDraggedProjectId(null)}
        onDragOver={(event) => {
          if (
            !draggedProjectId
            || favoriteProjectIds.has(draggedProjectId) !== favoriteProjectIds.has(project.id)
          ) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = "move";
        }}
        onDrop={(event) => {
          event.preventDefault();
          const sourceId = draggedProjectId ?? event.dataTransfer.getData("text/plain");
          if (sourceId) reorderProject(sourceId, project.id);
          setDraggedProjectId(null);
        }}
      >
        <div className="project-card-main">
          {archived || editing ? (
            <div className="project-card-open">{cardContent}</div>
          ) : (
            <button
              className="project-card-open"
              type="button"
              disabled={openingProjectId !== null}
              onClick={() => void selectProject(project)}
            >
              {cardContent}
            </button>
          )}
          <div className="project-card-controls" aria-label={`${project.name} 项目操作`}>
            {archived ? (
              <button type="button" onClick={() => setProjectArchived(project, false)}>恢复</button>
            ) : (
              <>
                <button
                  type="button"
                  onClick={() => {
                    setRenamingProjectId(project.id);
                    setProjectNameDraft(project.name);
                  }}
                >重命名</button>
                <button
                  type="button"
                  onClick={() => toggleFavoriteProjectById(project.id, project.name)}
                >{favoriteProjectIds.has(project.id) ? "取消收藏" : "收藏"}</button>
                <button type="button" onClick={() => setProjectArchived(project, true)}>归档</button>
              </>
            )}
          </div>
        </div>
        {!archived && (
          <label className="project-card-directory">
            <LinearIcon name="folder" />
            <input
              key={deviceWorkspacePaths[project.id] ?? ""}
              type="text"
              defaultValue={deviceWorkspacePaths[project.id] ?? ""}
              placeholder="设置此设备的项目目录"
              aria-label={`${project.name} 在此设备上的项目目录`}
              onBlur={(event) => void saveDeviceWorkspacePath(project.id, event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") event.currentTarget.blur();
              }}
            />
          </label>
        )}
      </div>
    );
  }

  const contextName = workspaceName(hostContext?.workspacePath);
  const headerProjectName = isGlobalBoard
    ? "全局任务"
    : projectAliases[selectedProjectId] ?? selectedProject?.name ?? "任务面板";
  const appShellStyle = embedded
    ? { "--codex-titlebar-left-inset": `${hostContext?.titlebarLeftInset ?? 0}px` } as CSSProperties
    : undefined;

  return (
    <div className={`app-shell${embedded ? " embedded" : ""}`} style={appShellStyle}>
      {taskboardMetadata && (
        <LocalRealtimeSync
          selectedProjectId={selectedProjectId}
          detailTaskId={detailTaskId}
          onTaskChange={recordReviewTaskChange}
          refreshProjectList={refreshProjectList}
          refreshTasks={refreshTasks}
          refreshWorkflowOptions={refreshWorkflowOptions}
          setConnection={setConnection}
          setCommentsRevision={setCommentsRevision}
          setAttachmentsRevision={setAttachmentsRevision}
          setKnowledgeRevision={setKnowledgeRevision}
        />
      )}
      {!embedded && (
        <aside className="app-nav" aria-label="Taskboard navigation">
          <div className="brand-row">
            <span className="brand-mark" aria-hidden="true"><LinearIcon name="project" /></span>
            <span>任务面板</span>
          </div>

          <nav className="primary-nav" aria-label="Views">
            <span className="nav-label">工作区</span>
            <button className="nav-item active" type="button" aria-current="page">
              <span className="nav-glyph" aria-hidden="true">
                <LinearIcon name="myIssues" />
              </span>
              议题
              <span className="nav-count">{tasks.length}</span>
            </button>
          </nav>

          <div className="project-nav">
            <span className="nav-label">项目</span>
            {projects.map((project) => (
              <button
                key={project.id}
                type="button"
                className={`project-nav-item${selectedProjectId === project.id ? " active" : ""}`}
                onClick={() => changeProject(project.id)}
              >
                <span className="project-dot" aria-hidden="true" />
                <span>{project.name}</span>
              </button>
            ))}
          </div>

          <div className="nav-spacer" />
          <div className="nav-footer">
            <div className={`connection connection-${connection}`}>
              <span aria-hidden="true" />
              {connection === "live" ? "实时同步" : "正在重新连接…"}
            </div>
            <button
              type="button"
              className="theme-toggle"
              onClick={() => setTheme((current) => current === "dark" ? "light" : "dark")}
              aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}
            >
              <span aria-hidden="true"><LinearIcon name={theme === "dark" ? "sun" : "moon"} /></span>
              {theme === "dark" ? "浅色模式" : "深色模式"}
            </button>
          </div>
        </aside>
      )}

      <main className="workspace">
        {selectedProjectId ? (
          <header className="workspace-header">
          <div className="workspace-title">
            <div className="workspace-kicker">
              {embedded && hostContext?.sidebarCollapsed && (
                <button
                  className="detail-back-button codex-sidebar-expand-button"
                  type="button"
                  aria-label="展开 Codex 侧边栏"
                  title="展开侧边栏"
                  onClick={expandCodexSidebar}
                >
                  <LinearIcon name="codexSidebarExpand" />
                </button>
              )}
              {selectedProjectId && (
                <button
                  className="detail-back-button project-home-button"
                  type="button"
                  aria-label="返回项目首页"
                  title="返回项目首页"
                  onClick={returnToProjectHome}
                >
                  <LinearIcon name="home" />
                  <span>首页</span>
                </button>
              )}
              {selectedProjectId && <span className="breadcrumb-chevron" aria-hidden="true"><LinearIcon name="chevronRight" /></span>}
              {selectedProjectId ? (
                <div className="header-project-switcher" data-project-switcher>
                  <button
                    className="header-project-button"
                    type="button"
                    aria-label="切换项目"
                    aria-haspopup="menu"
                    aria-expanded={projectMenuOpen}
                    onClick={() => setProjectMenuOpen((current) => !current)}
                  >
                    <span className="project-avatar" aria-hidden="true">
                      {headerProjectName.slice(0, 1).toUpperCase()}
                    </span>
                    <span className="project-name">{headerProjectName}</span>
                    <LinearIcon className="project-switcher-chevron" name="chevronDown" />
                  </button>
                  {projectMenuOpen && (
                    <div className="header-project-menu" role="menu" aria-label="项目">
                      <span>切换项目</span>
                      {activeProjectChoices.map((project) => (
                        <button
                          type="button"
                          role="menuitemradio"
                          aria-checked={project.id === selectedProjectId}
                          disabled={openingProjectId !== null}
                          key={project.id}
                          onClick={() => {
                            if (project.id === selectedProjectId) setProjectMenuOpen(false);
                            else void selectProject(project);
                          }}
                        >
                          <span className="project-avatar" aria-hidden="true">{project.name.slice(0, 1).toUpperCase()}</span>
                          <span>{project.name}</span>
                          {favoriteProjectIds.has(project.id) && <span className="project-menu-favorite" aria-label="已收藏"><LinearIcon name="favorite" /></span>}
                          {project.id === selectedProjectId && <span className="project-menu-check" aria-hidden="true"><LinearIcon name="check" /></span>}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              ) : (
                <>
                  <span className="project-avatar" aria-hidden="true">
                    {headerProjectName.slice(0, 1).toUpperCase()}
                  </span>
                  <span className="project-name">{headerProjectName}</span>
                </>
              )}
              {detailTask && (
                <button
                  className="header-board-return"
                  type="button"
                  aria-label="返回议题看板"
                  title="返回议题看板 (Esc)"
                  onClick={closeTaskDetail}
                >
                  <LinearIcon name="chevronLeft" />
                  <span>返回看板</span>
                </button>
              )}
              {!selectedProjectId && (
                <>
                  <span className="breadcrumb-chevron" aria-hidden="true"><LinearIcon name="chevronRight" /></span>
                  <strong>项目</strong>
                </>
              )}
              {!detailTask && selectedProject && (
                <button
                  className={`favorite-button${favoriteProjectIds.has(selectedProjectId) ? " active" : ""}`}
                  type="button"
                  aria-label={favoriteProjectIds.has(selectedProjectId) ? "取消收藏项目" : "收藏项目"}
                  aria-pressed={favoriteProjectIds.has(selectedProjectId)}
                  title={favoriteProjectIds.has(selectedProjectId) ? "取消收藏" : "收藏项目"}
                  onClick={toggleFavoriteProject}
                >
                  <LinearIcon className="favorite-icon" name="favorite" />
                </button>
              )}
              {!detailTask && selectedProject && embedded && contextName && <span className="codex-context">{contextName}</span>}
            </div>
          </div>

          <div ref={dragRegionRef} className="workspace-drag-region" aria-hidden="true" />

          <div className="header-actions">
            {selectedProject && (
              <ProjectAutomationMenu
                automation={selectedProjectAutomation}
                pending={automationPending}
                error={automationError}
                unavailableReason={automationProjectContext.unavailableReason}
                onOpen={() => void reconcileProjectAutomation()}
                onChange={(options) => void saveProjectAutomation(options)}
              />
            )}
            {selectedProjectId && boardView === "issues" && (
              <button
                className="icon-button header-create-button"
                type="button"
                onClick={() => openNewIssue()}
                aria-label="新建议题"
                title="新建议题 (C)"
              >
                <LinearIcon name="plus" />
              </button>
            )}
          </div>
          </header>
        ) : (
          <div ref={dragRegionRef} className="home-window-drag-region" aria-hidden="true" />
        )}

        {selectedProjectId && !detailTask && <div className="board-toolbar">
          <div className="view-tabs" aria-label="看板视图">
            <button
              className={`view-tab${boardView === "issues" && !favoriteTasksOnly ? " active" : ""}`}
              type="button"
              aria-pressed={boardView === "issues" && !favoriteTasksOnly}
              onClick={() => {
                setFavoriteTasksOnly(false);
                selectBoardView("issues");
              }}
            >
              议题看板
            </button>
            <button
              className={`view-tab favorite-view-tab${boardView === "issues" && favoriteTasksOnly ? " active" : ""}`}
              type="button"
              aria-label="收藏议题"
              aria-pressed={boardView === "issues" && favoriteTasksOnly}
              onClick={() => {
                if (!isGlobalBoard) openGlobalBoard("issues");
                setFavoriteTasksOnly(true);
                selectBoardView("issues");
              }}
            >
              <LinearIcon name="favorite" />
              收藏{favoriteTaskCount > 0 ? ` ${favoriteTaskCount}` : ""}
            </button>
            <button
              className={`view-tab${boardView === "drafts" ? " active" : ""}`}
              type="button"
              aria-pressed={boardView === "drafts"}
              onClick={() => selectBoardView("drafts")}
            >
              草稿箱{visibleIssueDrafts.length > 0 ? ` ${visibleIssueDrafts.length}` : ""}
            </button>
            {!isGlobalBoard && (
              <button
                className={`view-tab${boardView === "knowledge" ? " active" : ""}`}
                type="button"
                aria-pressed={boardView === "knowledge"}
                onClick={() => selectBoardView("knowledge")}
              >
                项目知识{knowledgeProposalCount > 0 ? ` ${knowledgeProposalCount}` : ""}
              </button>
            )}
            {SHOW_WORKFLOW_BOARD_ENTRY && (
              <button
                className={`view-tab${boardView === "workflow" ? " active" : ""}`}
                type="button"
                aria-pressed={boardView === "workflow"}
                onClick={() => selectBoardView("workflow")}
              >
                节点模式
              </button>
            )}
          </div>
          {boardView === "issues" && <div className="toolbar-tools">
            {favoriteTasksOnly && (
              <div className="favorite-view-mode-switch" role="group" aria-label="收藏展示格式">
                <button
                  type="button"
                  aria-label="列表格式"
                  aria-pressed={favoriteViewMode === "list"}
                  onClick={() => {
                    setFavoriteViewMode("list");
                    window.localStorage.setItem(FAVORITE_VIEW_MODE_KEY, "list");
                  }}
                >
                  <LinearIcon name="myIssues" />
                  <span>列表</span>
                </button>
                <button
                  type="button"
                  aria-label="看板格式"
                  aria-pressed={favoriteViewMode === "board"}
                  onClick={() => {
                    setFavoriteViewMode("board");
                    window.localStorage.setItem(FAVORITE_VIEW_MODE_KEY, "board");
                  }}
                >
                  <LinearIcon name="dashboard" />
                  <span>看板</span>
                </button>
              </div>
            )}
            <label className={`search-field${search ? " has-value" : ""}`} title="搜索议题 (/)" >
              <LinearIcon className="search-icon" name="search" />
              <span className="sr-only">搜索议题</span>
              <input
                id="task-search"
                type="search"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="搜索议题…"
              />
              {!search && <kbd>/</kbd>}
            </label>
            <TaskFilterMenu
              tasks={tasks}
              search={search}
              labels={availableLabels}
              filters={filters}
              onChange={setFilters}
            />
            <BoardSettingsMenu
              visibleStatuses={visibleStatuses}
              applyToAllProjects={globalColumnVisibility !== null}
              onStatusVisibilityChange={updateColumnVisibility}
              onApplyToAllProjectsChange={updateGlobalColumnVisibility}
              onOpenConnectors={() => setShowConnectorsPanel(true)}
            />
            {showConnectorsPanel && (
              <ConnectorsPanel
                connectors={connectors}
                onChanged={() => { void listConnectors().then(setConnectors); }}
                onClose={() => setShowConnectorsPanel(false)}
              />
            )}
            {(search || activeFilterCount > 0 || favoriteTasksOnly) && (
              <button
                className="clear-filter"
                type="button"
                aria-label="清除筛选"
                title="清除筛选"
                onClick={() => { setSearch(""); setFilters(EMPTY_TASK_FILTERS); setFavoriteTasksOnly(false); }}
              >
                <LinearIcon name="close" />
              </button>
            )}
          </div>}
        </div>}

        {(loadError || actionError) && (
          <div className="error-banner" role="alert">
            <span className="error-mark" aria-hidden="true"><LinearIcon name="alert" /></span>
            <div><strong>Taskboard needs attention</strong><p>{actionError ?? loadError}</p></div>
            <button
              type="button"
              onClick={() => {
                setActionError(null);
                if (selectedProjectId) void refreshTasks(selectedProjectId);
                else void loadProjectList();
              }}
            >
              Try again
            </button>
          </div>
        )}

        {!selectedProjectId ? (
          <section className="project-home">
            <div className="project-home-heading">
              <span>任务面板</span>
              <div className="project-home-heading-row">
                <h1>选择项目</h1>
                <div className="project-home-heading-actions">
                  <button
                    className="project-create-trigger"
                    type="button"
                    onClick={() => openGlobalBoard("drafts")}
                  >
                    <LinearIcon name="createIssue" />
                    草稿箱{issueDrafts.length > 0 ? ` ${issueDrafts.length}` : ""}
                  </button>
                  <button
                    className="project-create-trigger"
                    type="button"
                    aria-expanded={projectCreatorOpen}
                    onClick={() => {
                      setActionError(null);
                      setProjectCreatorOpen((current) => !current);
                    }}
                  >
                    <LinearIcon name="plus" />
                    新增项目
                  </button>
                  <div className="project-home-mode-switch" role="group" aria-label="项目展示模式">
                    <button
                      className={projectHomeMode === "groups" ? "active" : ""}
                      type="button"
                      aria-pressed={projectHomeMode === "groups"}
                      onClick={() => {
                        setProjectHomeMode("groups");
                        window.localStorage.setItem(PROJECT_HOME_MODE_KEY, "groups");
                      }}
                    >分类</button>
                    <button
                      className={projectHomeMode === "priority" ? "active" : ""}
                      type="button"
                      aria-pressed={projectHomeMode === "priority"}
                      onClick={() => {
                        setProjectHomeMode("priority");
                        window.localStorage.setItem(PROJECT_HOME_MODE_KEY, "priority");
                      }}
                    >收藏排序</button>
                  </div>
                  <button
                    className="project-create-trigger"
                    type="button"
                    onClick={() => openGlobalBoard("issues")}
                  >
                    <LinearIcon name="myIssues" />
                    全局任务视角
                  </button>
                  <button
                    className="project-create-trigger"
                    type="button"
                    aria-label="运行时连接器"
                    onClick={() => setShowConnectorsPanel(true)}
                  >
                    <LinearIcon name="displayOptions" />
                    连接器
                  </button>
                </div>
              </div>
              <p>从 Codex 项目开始，或继续使用之前保存的项目。</p>
            </div>
            {projectCreatorOpen && (
              <ProjectCreator
                codexLinkAvailable={embedded && window.parent !== window}
                submitting={projectCreatePending}
                onCancel={() => setProjectCreatorOpen(false)}
                onChooseWorkspace={chooseProjectWorkspace}
                onSubmit={createProjectFromHome}
              />
            )}
            {showConnectorsPanel && (
              <ConnectorsPanel
                connectors={connectors}
                onChanged={() => { void listConnectors().then(setConnectors); }}
                onClose={() => setShowConnectorsPanel(false)}
              />
            )}
            {projectsLoading ? (
              <div className="project-grid project-grid-loading" aria-label="正在加载项目" aria-busy="true">
                <span /><span /><span />
              </div>
            ) : projectChoices.length > 0 ? (
              <div className="project-home-groups">
                {(projectHomeMode === "groups" ? [
                  { id: "with-issues", title: "已有议题", projects: projectsWithIssues },
                  { id: "without-issues", title: "尚未添加议题", projects: projectsWithoutIssues },
                ] : [
                  { id: "favorites", title: "收藏项目", projects: favoriteProjectChoices },
                  { id: "others", title: "其他项目", projects: otherProjectChoices },
                ]).map((group) => (
                  <section className="project-home-group" key={group.id} aria-labelledby={`project-group-${group.id}`}>
                    <div className="project-group-heading">
                      <h2 id={`project-group-${group.id}`}>{group.title}</h2>
                      <span>{group.projects.length}</span>
                      {projectHomeMode === "priority" && group.projects.length > 1 && (
                        <small>拖动卡片调整顺序</small>
                      )}
                    </div>
                    {group.projects.length > 0 ? (
                      <div className="project-grid">
                        {group.projects.map((project) => renderProjectCard(project, {
                          draggable: projectHomeMode === "priority",
                        }))}
                      </div>
                    ) : (
                      <p className="project-group-empty">暂无项目</p>
                    )}
                  </section>
                ))}
                {archivedProjectChoices.length > 0 && (
                  <section className="project-home-group archived-project-group" aria-labelledby="project-group-archived">
                    <button
                      className="project-group-heading archived-project-toggle"
                      type="button"
                      aria-expanded={showArchivedProjects}
                      onClick={() => setShowArchivedProjects((current) => !current)}
                    >
                      <h2 id="project-group-archived">已归档项目</h2>
                      <span>{archivedProjectChoices.length}</span>
                      <LinearIcon name={showArchivedProjects ? "chevronDown" : "chevronRight"} />
                    </button>
                    {showArchivedProjects && (
                      <div className="project-grid">
                        {archivedProjectChoices.map((project) => renderProjectCard(project, { archived: true }))}
                      </div>
                    )}
                  </section>
                )}
              </div>
            ) : (
              <div className="project-home-empty">
                <span className="empty-orbit" aria-hidden="true"><i /><i /></span>
                <h2>还没有项目</h2>
                <p>点击“新增项目”，选择本地项目目录后即可开始。</p>
              </div>
            )}
          </section>
        ) : !detailTask && boardView === "drafts" ? (
          <DraftBox
            drafts={visibleIssueDrafts}
            projectNames={projectNames}
            scopeName={isGlobalBoard ? "所有项目" : headerProjectName}
            onCreate={() => openNewIssue()}
            onEdit={editIssueDraft}
            onDelete={deleteIssueDraft}
          />
        ) : !detailTask && boardView === "knowledge" && selectedProject ? (
          <KnowledgeCenter
            project={selectedProject}
            workspacePath={selectedDeviceWorkspacePath ?? developmentScan.workspacePath}
            developmentScan={developmentScan}
            available={localKnowledgeAvailable}
            revision={knowledgeRevision}
            onProposalCountChange={setKnowledgeProposalCount}
            onInitialize={openKnowledgeInitializationIssue}
            onGenerateProposal={runKnowledgeAnalysisInCodex}
          />
        ) : detailTask && selectedProject ? (
          <TaskDetail
            key={detailTask.id}
            task={detailTask}
            tasks={tasks}
            currentUser={currentUser}
            availableLabels={availableLabels}
            workflows={workflowOptions}
            developmentScan={developmentScan}
            developmentScanLoading={developmentScanLoading}
            commentsRevision={commentsRevision}
            attachmentsRevision={attachmentsRevision}
            projectOptions={projects.map((project) => ({
              id: project.id,
              name: projectNames[project.id] ?? project.name,
            }))}
            onUpdate={(current, changes) => updateTaskProperties(current, changes)}
            knowledgeAvailable={localKnowledgeAvailable && Boolean(knowledgeWorkspaceForTask(detailTask))}
            onCreateKnowledgeProposal={async (current, selectedComments) => {
              const created = await createTaskKnowledgeProposal(current, selectedComments, "manual");
              if (created) {
                setDetailTaskIdentifier(null);
                const knowledgeUrl = buildIssueUrl(window.location.href, current.projectId, null);
                knowledgeUrl.searchParams.delete(GLOBAL_VIEW_QUERY_PARAM);
                window.history.replaceState(window.history.state, "", knowledgeUrl);
                setBoardView("knowledge");
              }
              return created;
            }}
            onTransferProject={transferTaskToProject}
            onOpenTask={openTaskDetail}
            onCreateSubIssue={(parent) => setEditor({
              task: null,
              status: "todo",
              projectId: parent.projectId,
              parentTaskId: parent.id,
            })}
            onAddRelation={(current, type, relatedTaskId) => (
              mutateTaskRelation("add", current, type, relatedTaskId)
            )}
            onRemoveRelation={(current, type, relatedTaskId) => (
              mutateTaskRelation("remove", current, type, relatedTaskId)
            )}
            onOpenThread={openThread}
            currentCodexThreadId={hostContext?.threadId}
            codexThreads={projectCodexThreads}
            onLinkThread={linkTaskToThread}
            onUnlinkThread={unlinkTaskFromThread}
            onOpenInThread={openTaskInThread}
            onFollowUpInThread={followUpTaskInThread}
            claudeRuntimeSupported={claudeRuntimeSupported}
            ompRuntimeSupported={ompRuntimeSupported}
            openingThread={openingThreadTaskId === detailTask.id}
            isFavorite={favoriteTaskIds.has(detailTask.id)}
            onToggleFavorite={toggleFavoriteTask}
            onError={setActionError}
            onAnnounce={setAnnouncement}
          />
        ) : boardView === "workflow" ? (
          <Suspense fallback={<div className="workflow-board-loading">正在打开节点模式…</div>}>
            <WorkflowBoard
              key={selectedProject?.id ?? "local"}
              projectId={selectedProject?.id ?? "local"}
              projectName={selectedProject?.name ?? "当前项目"}
              workspacePath={
                selectedDeviceWorkspacePath
                ?? developmentScan.workspacePath
                ?? hostContext?.workspacePath
              }
              revision={workflowRevision}
              onWorkflowsChange={setWorkflowOptions}
            />
          </Suspense>
        ) : tasksLoading && !hasLoadedTasks ? (
          <div className="loading-board" aria-label="Loading issues" aria-busy="true">
            {TASK_STATUSES.map((status) => (
              <div className="loading-column" key={status}>
                <span /><div /><div />
              </div>
            ))}
          </div>
        ) : favoriteTasksOnly && favoriteViewMode === "list" ? (
          <FavoriteTaskList
            tasks={filteredTasks}
            projectNames={projectNames}
            onOpenTask={openTaskDetail}
            onToggleFavorite={toggleFavoriteTask}
          />
        ) : (
          <div className="board-scroll" aria-label="Issue board">
            <div className="board">
              {filteredTasks.length === 0 && tasks.length > 0 && visibleStatuses.length === 0 && (
                <section className="page-empty filter-empty board-filter-empty">
                  <span className="empty-search" aria-hidden="true"><LinearIcon name="search" /></span>
                  <h2>没有匹配的议题</h2>
                  <p>请更换搜索词，或移除一个筛选条件。</p>
                  <button
                    className="button secondary"
                    type="button"
                    onClick={() => { setSearch(""); setFilters(EMPTY_TASK_FILTERS); setFavoriteTasksOnly(false); }}
                  >
                    清除筛选
                  </button>
                </section>
              )}
              {visibleStatuses.map((status) => (
                <BoardColumn
                  key={status}
                  status={status}
                  statusIndex={TASK_STATUSES.indexOf(status)}
                  tasks={tasksByStatus[status]}
                  progressByTaskId={progressByTaskId}
                  projectNames={isGlobalBoard ? projectNames : undefined}
                  isDropTarget={dropTarget === status}
                  isColumnDragging={draggedColumnStatus === status}
                  columnDropPosition={columnDropTarget?.status === status ? columnDropTarget.position : null}
                  draggedTaskId={draggedTaskId}
                  draggedTaskHeight={draggedTaskHeight}
                  movingTaskId={movingTaskId}
                  settlingTaskId={settlingTaskId}
                  contextMenuTaskId={contextMenu?.taskId ?? null}
                  favoriteTaskIds={favoriteTaskIds}
                  onCreate={(initialStatus) => openNewIssue(initialStatus)}
                  onEdit={openTaskDetail}
                  onToggleFavorite={toggleFavoriteTask}
                  onContextMenu={(task, position) => setContextMenu({ taskId: task.id, ...position })}
                  onMove={(task, destination) => void moveTask(task, destination)}
                  onDragStart={(task, height) => {
                    setDraggedTaskId(task.id);
                    setDraggedTaskHeight(height);
                    setDropTarget(task.status);
                  }}
                  onDragEnd={() => {
                    setDraggedTaskId(null);
                    setDraggedTaskHeight(0);
                    setDropTarget(null);
                  }}
                  onDragEnter={setDropTarget}
                  onDrop={finishTaskDrop}
                  onColumnDragStart={(draggedStatus) => {
                    setDraggedColumnStatus(draggedStatus);
                    setColumnDropTarget(null);
                  }}
                  onColumnDragOver={(targetStatus, position) => {
                    if (draggedColumnStatus && draggedColumnStatus !== targetStatus) {
                      setColumnDropTarget({ status: targetStatus, position });
                    }
                  }}
                  onColumnDrop={(sourceStatus, targetStatus, position) => {
                    moveColumn(sourceStatus, targetStatus, position);
                  }}
                  onColumnDragEnd={() => {
                    setDraggedColumnStatus(null);
                    setColumnDropTarget(null);
                  }}
                  onOpenThread={openThread}
                  onHide={(hiddenStatus) => updateColumnVisibility(hiddenStatus, false)}
                />
              ))}
              {hiddenStatuses.length > 0 && (
                <HiddenColumns
                  statuses={hiddenStatuses}
                  counts={Object.fromEntries(
                    TASK_STATUSES.map((status) => [status, tasksByStatus[status].length]),
                  ) as Record<TaskStatus, number>}
                  dropTarget={dropTarget}
                  onDragTargetChange={setDropTarget}
                  onDrop={(destination, taskId) => finishTaskDrop(destination, taskId)}
                  onShow={(shownStatus) => updateColumnVisibility(shownStatus, true)}
                />
              )}
            </div>
          </div>
        )}
      </main>

      {editor && (
        <TaskEditor
          key={editor.task?.id ?? editor.draft?.id ?? `new-${editor.status}-${editor.parentTaskId ?? "root"}`}
          task={editor.task}
          initialDraft={editor.draft?.content}
          initialStatus={editor.status}
          projectId={editor.projectId}
          projectOptions={isGlobalBoard
            ? projects.map((project) => ({ id: project.id, name: projectNames[project.id] ?? project.name }))
            : []}
          labels={availableLabels}
          workflows={workflowOptions}
          currentUser={currentUser}
          developmentScan={developmentScan}
          developmentScanLoading={developmentScanLoading}
          onProjectChange={(projectId) => setEditor((current) => current ? { ...current, projectId } : current)}
          onCancel={() => setEditor(null)}
          onSaveDraft={editor.task ? undefined : saveIssueDraft}
          onSave={saveEditor}
        />
      )}

      {contextMenu && contextMenuTask && (
        <TaskContextMenu
          task={contextMenuTask}
          position={{ x: contextMenu.x, y: contextMenu.y }}
          labels={availableLabels}
          onClose={closeContextMenu}
          onEdit={openTaskDetail}
          onStatusChange={(task, status) => void moveTask(task, status)}
          onPriorityChange={(task, nextPriority) => void updateTaskProperties(
            task,
            { priority: nextPriority },
            `${task.identifier} 优先级已更新。`,
          ).catch(() => {})}
          onLabelsChange={(task, labels) => void updateTaskProperties(
            task,
            { labels },
            `${task.identifier} 标签已更新。`,
          ).catch(() => {})}
          onDuplicate={(task) => void duplicateTask(task)}
          onCopy={(text, message) => void copyText(text, message)}
          onOpenInThread={openTaskInThread}
          onArchive={(task) => void archiveTask(task)}
        />
      )}

      <div className="sr-only" role="status" aria-live="polite">{announcement}</div>
      {undoNotice && (
        <div
          className="toast undo-toast"
          role="status"
          onAnimationEnd={() => setUndoNotice((current) => current?.id === undoNotice.id ? null : current)}
        >
          <span className="toast-check" aria-hidden="true"><LinearIcon name="check" /></span>
          <span className="undo-toast-message">{undoNotice.message}</span>
          <button type="button" onClick={() => void performUndo()}>
            撤回 <kbd>{undoShortcut}</kbd>
          </button>
        </div>
      )}
      {announcement && (
        <div className="toast" role="status" onAnimationEnd={() => setAnnouncementValue("")}>
          <span aria-hidden="true"><LinearIcon name="check" /></span>{announcement}
        </div>
      )}
      {draggedTaskId && <div className="drag-hint" aria-hidden="true">拖到目标位置后松开</div>}
    </div>
  );
}
