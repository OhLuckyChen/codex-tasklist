import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  ApiError,
  attachmentContentUrl,
  createComment,
  deleteAttachment,
  deleteComment,
  listAttachments,
  listComments,
  uploadAttachment,
  uploadCommentAttachment,
  updateComment,
} from "../api";
import { TASK_STATUSES } from "../types";
import type {
  ActorIdentity,
  Attachment,
  CodexThreadSummary,
  Comment,
  DevelopmentContext,
  DevelopmentScan,
  IssueRelationType,
  Recurrence,
  Task,
  TaskDraft,
  TaskProjectTransferResult,
  TaskPriority,
  TaskRelationSummary,
  TaskRuntime,
  TaskStatus,
  WorkflowOption,
} from "../types";
import {
  CODEX_AGENT_ACTOR,
  actorKey,
  assigneeTargetForActor,
} from "../actors";
import { taskThreadRuntime } from "../taskConversations";
import { ActorAvatar } from "./ActorAvatar";
import { STATUS_DETAILS } from "./BoardColumn";
import { LabelPicker } from "./LabelPicker";
import { LinearIcon, LinearPriorityIcon, LinearStatusIcon } from "./LinearIcon";
import {
  fileKey,
  MAX_ATTACHMENT_SIZE,
  PendingAttachments,
} from "./PendingAttachments";
import {
  createInlineMediaSegments,
  InlineMediaComposer,
  inlineMediaImages,
  inlineMediaText,
  resolveInlineMediaMarkdown,
  serializeInlineMedia,
  type InlineMediaComposerHandle,
  type InlineMediaSegment,
} from "./InlineMediaComposer";
import {
  IssueParentLink,
  IssueRelationSidebar,
  IssueSubIssues,
  type RelationMutationResult,
} from "./IssueRelations";
import { RuntimeIcon, RUNTIME_LABELS } from "./RuntimeIcon";

const PRIORITY_DETAILS: Record<TaskPriority, { label: string; bars: number }> = {
  none: { label: "无优先级", bars: 0 },
  urgent: { label: "紧急", bars: 3 },
  high: { label: "高", bars: 3 },
  medium: { label: "中", bars: 2 },
  low: { label: "低", bars: 1 },
};

interface TaskDetailProps {
  task: Task;
  tasks: Task[];
  currentUser: ActorIdentity;
  availableLabels: string[];
  workflows: WorkflowOption[];
  developmentScan: DevelopmentScan;
  developmentScanLoading: boolean;
  commentsRevision: number;
  attachmentsRevision: number;
  projectOptions: Array<{ id: string; name: string }>;
  onUpdate: (task: Task, changes: Partial<TaskDraft>) => Promise<Task>;
  knowledgeAvailable: boolean;
  onCreateKnowledgeProposal: (task: Task, comments?: Comment[]) => Promise<boolean>;
  onTransferProject: (task: Task, projectId: string) => Promise<TaskProjectTransferResult>;
  onOpenTask: (task: TaskRelationSummary) => void;
  onCreateSubIssue: (task: Task) => void;
  onAddRelation: (
    task: Task,
    type: IssueRelationType,
    relatedTaskId: string,
  ) => Promise<RelationMutationResult>;
  onRemoveRelation: (
    task: Task,
    type: IssueRelationType,
    relatedTaskId: string,
  ) => Promise<RelationMutationResult>;
  onOpenThread: (threadId: string, task: Task) => void;
  currentCodexThreadId?: string;
  codexThreads: CodexThreadSummary[];
  onLinkThread: (task: Task, threadId: string) => Promise<Task>;
  onUnlinkThread: (task: Task, threadId: string) => Promise<Task>;
  onOpenInThread: (task: Task, followUp?: string, comment?: Comment, runtime?: TaskRuntime) => void;
  onFollowUpInThread: (task: Task, threadId: string, followUp: string, runtime?: TaskRuntime) => void;
  claudeRuntimeSupported: boolean;
  ompRuntimeSupported: boolean;
  openingThread: boolean;
  isFavorite: boolean;
  onToggleFavorite: (task: Task) => void;
  onError: (message: string | null) => void;
  onAnnounce: (message: string) => void;
}

function messageFor(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return "操作未完成，请重试。";
}

function exactTime(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function relativeTime(value: string): string {
  const seconds = Math.round((new Date(value).getTime() - Date.now()) / 1000);
  const formatter = new Intl.RelativeTimeFormat("zh-CN", { numeric: "auto" });
  if (Math.abs(seconds) < 60) return formatter.format(seconds, "second");
  const minutes = Math.round(seconds / 60);
  if (Math.abs(minutes) < 60) return formatter.format(minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return formatter.format(hours, "hour");
  const days = Math.round(hours / 24);
  if (Math.abs(days) < 30) return formatter.format(days, "day");
  return new Intl.DateTimeFormat("zh-CN", { month: "short", day: "numeric" }).format(new Date(value));
}

function resizeTextarea(element: HTMLTextAreaElement | null) {
  if (!element) return;
  element.style.height = "0px";
  element.style.height = `${element.scrollHeight}px`;
}

function fileSize(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(value < 10 * 1024 ? 1 : 0)} KB`;
  return `${(value / (1024 * 1024)).toFixed(value < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

function contextValue(context: DevelopmentContext | null): string {
  return context ? JSON.stringify(context) : "";
}

function contextLabel(context: DevelopmentContext): string {
  if (context.type === "branch") return context.branch;
  const folder = context.path.split(/[\\/]/).filter(Boolean).at(-1) ?? context.path;
  return `${context.branch ?? "detached"} · ${folder}`;
}

function normalizeOrderedListMarkers(value: string): string {
  return value.replace(/^(\s*\d+[.)])(?=\S)/gm, "$1 ");
}

function DescriptionDocument({ value }: { value: string }) {
  return (
    <div className="issue-description-document">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noreferrer" />,
        }}
      >
        {normalizeOrderedListMarkers(value)}
      </ReactMarkdown>
    </div>
  );
}

function ConversationLink({
  threadId,
  onOpen,
  label = "查看对话",
  runtime = "codex",
}: {
  threadId: string;
  onOpen: (threadId: string) => void;
  label?: string;
  runtime?: TaskRuntime;
}) {
  const runtimeLabel = RUNTIME_LABELS[runtime];
  return (
    <button
      className="issue-conversation-link"
      type="button"
      title={`${runtimeLabel} · 查看对话 ${threadId}`}
      onClick={() => onOpen(threadId)}
    >
      <RuntimeIcon runtime={runtime} />
      <strong>{label}</strong>
      <span className="conversation-divider" aria-hidden="true" />
      <span className="conversation-thread-id">{threadId}</span>
    </button>
  );
}

interface PropertyOption<Value extends string> {
  value: Value;
  label: string;
  group?: string;
  icon?: ReactNode;
  title?: string;
}

function PropertyPicker<Value extends string>({
  ariaLabel,
  value,
  options,
  disabled = false,
  onChange,
}: {
  ariaLabel: string;
  value: Value;
  options: PropertyOption<Value>[];
  disabled?: boolean;
  onChange: (value: Value) => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const selected = options.find((option) => option.value === value) ?? options[0];

  useEffect(() => {
    if (!open) return;
    requestAnimationFrame(() => {
      const selectedOption = rootRef.current?.querySelector<HTMLButtonElement>("[role='option'][aria-selected='true']");
      (selectedOption ?? rootRef.current?.querySelector<HTMLButtonElement>("[role='option']"))?.focus();
    });

    function closeFromOutside(event: PointerEvent) {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    }

    function closeFromEscape(event: globalThis.KeyboardEvent) {
      if (event.key !== "Escape") return;
      setOpen(false);
      triggerRef.current?.focus();
    }

    document.addEventListener("pointerdown", closeFromOutside);
    window.addEventListener("keydown", closeFromEscape);
    return () => {
      document.removeEventListener("pointerdown", closeFromOutside);
      window.removeEventListener("keydown", closeFromEscape);
    };
  }, [open]);

  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  function handleMenuKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      triggerRef.current?.focus();
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const optionButtons = [...(rootRef.current?.querySelectorAll<HTMLButtonElement>("[role='option']") ?? [])];
    if (optionButtons.length === 0) return;
    event.preventDefault();
    const currentIndex = optionButtons.indexOf(document.activeElement as HTMLButtonElement);
    const nextIndex = event.key === "Home"
      ? 0
      : event.key === "End"
        ? optionButtons.length - 1
        : event.key === "ArrowUp"
          ? (currentIndex <= 0 ? optionButtons.length - 1 : currentIndex - 1)
          : (currentIndex + 1) % optionButtons.length;
    optionButtons[nextIndex]?.focus();
  }

  let previousGroup: string | undefined;

  return (
    <div className="detail-property-picker" ref={rootRef}>
      <button
        ref={triggerRef}
        className="detail-property-picker-trigger"
        type="button"
        disabled={disabled}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={selected?.title}
        onClick={() => setOpen((current) => !current)}
        onKeyDown={(event) => {
          if (event.key !== "Escape" || !open) return;
          event.preventDefault();
          event.stopPropagation();
          setOpen(false);
        }}
      >
        <span>{selected?.label ?? "未设置"}</span>
        <LinearIcon name="chevronDown" />
      </button>
      {open && (
        <div
          className="detail-property-menu"
          role="listbox"
          aria-label={ariaLabel}
          onKeyDown={handleMenuKeyDown}
        >
          {options.map((option) => {
            const showGroup = Boolean(option.group && option.group !== previousGroup);
            previousGroup = option.group;
            return (
              <div className="detail-property-option-wrap" key={option.value}>
                {showGroup && <span className="detail-property-group-label">{option.group}</span>}
                <button
                  type="button"
                  role="option"
                  aria-selected={option.value === value}
                  title={option.title}
                  onClick={() => {
                    setOpen(false);
                    if (option.value !== value) onChange(option.value);
                  }}
                >
                  <span className="detail-property-option-icon" aria-hidden="true">
                    {option.icon ?? <LinearIcon name="status" />}
                  </span>
                  <span className="detail-property-option-label">{option.label}</span>
                  {option.value === value && <LinearIcon className="detail-property-option-check" name="check" />}
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function TaskDetail({
  task,
  tasks,
  currentUser,
  availableLabels,
  workflows,
  developmentScan,
  developmentScanLoading,
  commentsRevision,
  attachmentsRevision,
  projectOptions,
  onUpdate,
  knowledgeAvailable,
  onCreateKnowledgeProposal,
  onTransferProject,
  onOpenTask,
  onCreateSubIssue,
  onAddRelation,
  onRemoveRelation,
  onOpenThread,
  currentCodexThreadId,
  codexThreads,
  onLinkThread,
  onUnlinkThread,
  onOpenInThread,
  onFollowUpInThread,
  claudeRuntimeSupported,
  ompRuntimeSupported,
  openingThread,
  isFavorite,
  onToggleFavorite,
  onError,
  onAnnounce,
}: TaskDetailProps) {
  const [currentTask, setCurrentTask] = useState(task);
  const [title, setTitle] = useState(task.title);
  const [description, setDescription] = useState(task.description);
  const [editingDescription, setEditingDescription] = useState(false);
  const [labelMenuOpen, setLabelMenuOpen] = useState(false);
  const [savingProperty, setSavingProperty] = useState<string | null>(null);
  const [pendingProjectId, setPendingProjectId] = useState<string | null>(null);
  const [migratingProject, setMigratingProject] = useState(false);
  const [linkingThreadId, setLinkingThreadId] = useState<string | null>(null);
  const [threadMenuOpen, setThreadMenuOpen] = useState(false);
  const [unlinkingThreadId, setUnlinkingThreadId] = useState<string | null>(null);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [attachmentsLoading, setAttachmentsLoading] = useState(true);
  const [attachmentsError, setAttachmentsError] = useState<string | null>(null);
  const [uploadingAttachments, setUploadingAttachments] = useState(false);
  const [pendingAttachmentDelete, setPendingAttachmentDelete] = useState<Attachment | null>(null);
  const [deletingAttachment, setDeletingAttachment] = useState(false);
  const [comments, setComments] = useState<Comment[]>([]);
  const [commentsLoading, setCommentsLoading] = useState(true);
  const [commentsError, setCommentsError] = useState<string | null>(null);
  const [activityOrder, setActivityOrder] = useState<"desc" | "asc">("desc");
  const [commentSearch, setCommentSearch] = useState("");
  const [commentSegments, setCommentSegments] = useState<InlineMediaSegment[]>(
    () => createInlineMediaSegments(
      window.localStorage.getItem(`taskboard.comment-draft.${task.id}`) ?? "",
    ),
  );
  const [pendingCommentFiles, setPendingCommentFiles] = useState<File[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [commentThreadMenuId, setCommentThreadMenuId] = useState<string | null>(null);
  const [commentThreadActionId, setCommentThreadActionId] = useState<string | null>(null);
  const [activeMenuId, setActiveMenuId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingBody, setEditingBody] = useState("");
  const [savingCommentId, setSavingCommentId] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<Comment | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [selectingKnowledgeComments, setSelectingKnowledgeComments] = useState(false);
  const [selectedKnowledgeCommentIds, setSelectedKnowledgeCommentIds] = useState<Set<string>>(new Set());
  const [knowledgeBusy, setKnowledgeBusy] = useState(false);
  const titleRef = useRef<HTMLTextAreaElement>(null);
  const descriptionRef = useRef<HTMLTextAreaElement>(null);
  const composerRef = useRef<InlineMediaComposerHandle>(null);
  const attachmentInputRef = useRef<HTMLInputElement>(null);
  const commentAttachmentInputRef = useRef<HTMLInputElement>(null);
  const commentThreadMenuRef = useRef<HTMLDivElement>(null);
  const threadMenuRef = useRef<HTMLDivElement>(null);
  const threadMenuTriggerRef = useRef<HTMLButtonElement>(null);
  const workflowAvailable = !currentTask.workflowId
    || workflows.some((workflow) => workflow.id === currentTask.workflowId);
  const selectableCodexThreads = codexThreads.filter((thread) => thread.id !== currentCodexThreadId);
  const linkedThreadIds = currentTask.threadIds?.length > 0
    ? currentTask.threadIds
    : currentTask.threadId
      ? [currentTask.threadId]
      : [];
  const historicalThreadIds = linkedThreadIds.filter((threadId) => threadId !== currentTask.threadId);
  const currentThreadRuntime = taskThreadRuntime(currentTask, currentTask.threadId);
  const commentThreadOptions = [
    ...codexThreads,
    ...linkedThreadIds
      .filter((threadId) => !codexThreads.some((thread) => thread.id === threadId))
      .map((threadId) => ({
        id: threadId,
        title: threadId === currentTask.threadId ? "当前会话" : "历史会话",
        projectId: currentTask.projectId,
      })),
  ];
  const projectPropertyOptions = projectOptions.map((project) => ({
    value: project.id,
    label: project.name,
    icon: <LinearIcon name="project" />,
  }));
  const pendingProject = projectOptions.find((project) => project.id === pendingProjectId) ?? null;
  const currentRelations = [
    ...(currentTask.relations.parent ? [currentTask.relations.parent] : []),
    ...currentTask.relations.subIssues,
    ...currentTask.relations.blockedBy,
    ...currentTask.relations.blocks,
    ...currentTask.relations.related,
  ];
  const draft = serializeInlineMedia(commentSegments);
  const commentFollowUpText = inlineMediaText(commentSegments).trim();
  const commentInlineImages = inlineMediaImages(commentSegments);
  const canSubmitComment = Boolean(
    draft.trim()
    || pendingCommentFiles.length > 0
    || commentInlineImages.length > 0,
  );
  const normalizedCommentSearch = commentSearch.trim().toLocaleLowerCase();
  const filteredComments = normalizedCommentSearch
    ? comments.filter((comment) => comment.body.toLocaleLowerCase().includes(normalizedCommentSearch))
    : comments;
  const orderedComments = activityOrder === "desc" ? [...filteredComments].reverse() : filteredComments;
  const createdActivity = (
    <div className={`activity-entry activity-created is-${currentTask.creatorType}`}>
      <ActorAvatar
        className="comment-avatar"
        actor={{
          type: currentTask.creatorType,
          id: currentTask.creatorId,
          name: currentTask.creatorName,
          avatarUrl: currentTask.creatorAvatarUrl,
        }}
      />
      <p>
        <strong>{currentTask.creatorName}</strong>
        <span className="actor-id">@{currentTask.creatorId}</span>
        创建了此议题
        <time title={exactTime(currentTask.createdAt)}>{relativeTime(currentTask.createdAt)}</time>
      </p>
    </div>
  );

  useEffect(() => {
    setCurrentTask(task);
    setThreadMenuOpen(false);
    setCommentThreadMenuId(null);
    setCommentSearch("");
    if (document.activeElement !== titleRef.current) setTitle(task.title);
    if (document.activeElement !== descriptionRef.current) setDescription(task.description);
  }, [task]);

  useEffect(() => {
    resizeTextarea(titleRef.current);
    resizeTextarea(descriptionRef.current);
  }, [title, description, editingDescription]);

  useEffect(() => {
    if (!editingDescription) return;
    requestAnimationFrame(() => {
      descriptionRef.current?.focus();
      resizeTextarea(descriptionRef.current);
    });
  }, [editingDescription]);

  useEffect(() => {
    const controller = new AbortController();
    setCommentsError(null);
    void listComments(task.id, controller.signal).then(
      (nextComments) => {
        setComments(nextComments);
        setCommentsLoading(false);
      },
      (error) => {
        if ((error as Error).name === "AbortError") return;
        setCommentsError(messageFor(error));
        setCommentsLoading(false);
      },
    );
    return () => controller.abort();
  }, [commentsRevision, task.id]);

  useEffect(() => {
    const controller = new AbortController();
    setAttachmentsLoading(true);
    setAttachmentsError(null);
    void listAttachments(task.id, controller.signal).then(
      (nextAttachments) => {
        setAttachments(nextAttachments.filter((attachment) => !attachment.commentId));
        setAttachmentsLoading(false);
      },
      (error) => {
        if ((error as Error).name === "AbortError") return;
        setAttachmentsError(messageFor(error));
        setAttachmentsLoading(false);
      },
    );
    return () => controller.abort();
  }, [attachmentsRevision, task.id]);

  useEffect(() => {
    const key = `taskboard.comment-draft.${task.id}`;
    const text = inlineMediaText(commentSegments);
    if (text) window.localStorage.setItem(key, text);
    else window.localStorage.removeItem(key);
  }, [commentSegments, task.id]);

  useEffect(() => {
    function handleShortcut(event: globalThis.KeyboardEvent) {
      if (event.key.toLowerCase() !== "r" || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target?.matches("input, textarea, select, [contenteditable='true']")) return;
      event.preventDefault();
      composerRef.current?.focus();
    }
    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  }, []);

  useEffect(() => {
    if (!activeMenuId) return;
    function closeMenu(event: PointerEvent) {
      const target = event.target as HTMLElement;
      if (!target.closest(`[data-comment-menu-root="${activeMenuId}"]`)) setActiveMenuId(null);
    }
    function closeWithEscape(event: globalThis.KeyboardEvent) {
      if (event.key === "Escape") setActiveMenuId(null);
    }
    document.addEventListener("pointerdown", closeMenu);
    window.addEventListener("keydown", closeWithEscape);
    return () => {
      document.removeEventListener("pointerdown", closeMenu);
      window.removeEventListener("keydown", closeWithEscape);
    };
  }, [activeMenuId]);

  useEffect(() => {
    if (!threadMenuOpen) return;
    requestAnimationFrame(() => {
      threadMenuRef.current?.querySelector<HTMLButtonElement>("[role='option']")?.focus();
    });

    function closeFromOutside(event: PointerEvent) {
      if (!threadMenuRef.current?.contains(event.target as Node)) setThreadMenuOpen(false);
    }

    function closeFromEscape(event: globalThis.KeyboardEvent) {
      if (event.key !== "Escape") return;
      setThreadMenuOpen(false);
      threadMenuTriggerRef.current?.focus();
    }

    document.addEventListener("pointerdown", closeFromOutside);
    window.addEventListener("keydown", closeFromEscape);
    return () => {
      document.removeEventListener("pointerdown", closeFromOutside);
      window.removeEventListener("keydown", closeFromEscape);
    };
  }, [threadMenuOpen]);

  useEffect(() => {
    if (!commentThreadMenuId) return;
    requestAnimationFrame(() => {
      commentThreadMenuRef.current?.querySelector<HTMLButtonElement>("[role='option']")?.focus();
    });

    function closeFromOutside(event: PointerEvent) {
      if (!commentThreadMenuRef.current?.contains(event.target as Node)) setCommentThreadMenuId(null);
    }

    function closeFromEscape(event: globalThis.KeyboardEvent) {
      if (event.key !== "Escape") return;
      const trigger = document.querySelector<HTMLButtonElement>(
        `[data-comment-thread-trigger="${commentThreadMenuId}"]`,
      );
      setCommentThreadMenuId(null);
      trigger?.focus();
    }

    document.addEventListener("pointerdown", closeFromOutside);
    window.addEventListener("keydown", closeFromEscape);
    return () => {
      document.removeEventListener("pointerdown", closeFromOutside);
      window.removeEventListener("keydown", closeFromEscape);
    };
  }, [commentThreadMenuId]);

  async function saveTask(changes: Partial<TaskDraft>, property: string) {
    setSavingProperty(property);
    onError(null);
    try {
      const saved = await onUpdate(currentTask, changes);
      setCurrentTask(saved);
      setTitle(saved.title);
      setDescription(saved.description);
      onAnnounce(`${saved.identifier} 已更新。`);
      return saved;
    } catch (error) {
      onError(messageFor(error));
      setTitle(currentTask.title);
      setDescription(currentTask.description);
      return null;
    } finally {
      setSavingProperty(null);
    }
  }

  async function createKnowledgeProposalFrom(commentsForKnowledge?: Comment[]) {
    if (!knowledgeAvailable || knowledgeBusy) return;
    setKnowledgeBusy(true);
    setActiveMenuId(null);
    onError(null);
    try {
      const created = await onCreateKnowledgeProposal(currentTask, commentsForKnowledge);
      onAnnounce(created
        ? "已生成待确认知识提案，正式知识尚未修改。"
        : "整理完成，没有发现需要长期沉淀的新知识。");
      if (commentsForKnowledge) {
        setSelectingKnowledgeComments(false);
        setSelectedKnowledgeCommentIds(new Set());
      }
    } catch (error) {
      onError(messageFor(error));
    } finally {
      setKnowledgeBusy(false);
    }
  }

  async function confirmProjectTransfer() {
    if (!pendingProjectId || migratingProject) return;
    setMigratingProject(true);
    onError(null);
    try {
      const result = await onTransferProject(currentTask, pendingProjectId);
      setCurrentTask(result.task);
      setTitle(result.task.title);
      setDescription(result.task.description);
      setPendingProjectId(null);
      onAnnounce(`${result.previousIdentifier} 已迁移为 ${result.task.identifier}。`);
    } catch (error) {
      onError(messageFor(error));
    } finally {
      setMigratingProject(false);
    }
  }

  async function applyRelationMutation(
    mutation: () => Promise<RelationMutationResult>,
  ): Promise<RelationMutationResult> {
    onError(null);
    try {
      const result = await mutation();
      const nextCurrent = result.task.id === currentTask.id
        ? result.task
        : result.relatedTask.id === currentTask.id
          ? result.relatedTask
          : null;
      if (nextCurrent) setCurrentTask(nextCurrent);
      return result;
    } catch (error) {
      onError(messageFor(error));
      throw error;
    }
  }

  async function linkThread(threadId: string) {
    if (!threadId || linkingThreadId) return;
    setThreadMenuOpen(false);
    setLinkingThreadId(threadId);
    onError(null);
    try {
      const saved = await onLinkThread(currentTask, threadId);
      setCurrentTask(saved);
      const threadTitle = codexThreads.find((thread) => thread.id === threadId)?.title;
      onAnnounce(`${saved.identifier} 已关联到${threadTitle ? `「${threadTitle}」` : "所选会话"}。`);
    } catch (error) {
      onError(messageFor(error));
    } finally {
      setLinkingThreadId(null);
    }
  }

  function handleThreadMenuKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      setThreadMenuOpen(false);
      threadMenuTriggerRef.current?.focus();
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const options = [...(threadMenuRef.current?.querySelectorAll<HTMLButtonElement>("[role='option']") ?? [])];
    if (options.length === 0) return;
    event.preventDefault();
    const currentIndex = options.indexOf(document.activeElement as HTMLButtonElement);
    const nextIndex = event.key === "Home"
      ? 0
      : event.key === "End"
        ? options.length - 1
        : event.key === "ArrowUp"
          ? (currentIndex <= 0 ? options.length - 1 : currentIndex - 1)
          : (currentIndex + 1) % options.length;
    options[nextIndex]?.focus();
  }

  function handleTitleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      event.currentTarget.blur();
    }
    if (event.key === "Escape") {
      setTitle(currentTask.title);
      event.currentTarget.blur();
    }
  }

  async function saveTitle() {
    const normalized = title.trim();
    if (!normalized) {
      setTitle(currentTask.title);
      onError("议题标题不能为空。");
      return;
    }
    if (normalized === currentTask.title) {
      setTitle(normalized);
      return;
    }
    await saveTask({ title: normalized }, "title");
  }

  async function saveDescription() {
    const normalized = description.trim();
    if (normalized === currentTask.description) return;
    await saveTask({ description: normalized }, "description");
  }

  async function submitComment(): Promise<string | null> {
    const body = draft.trim();
    if (!canSubmitComment || submitting) return null;
    const followUp = commentFollowUpText || "请查看刚发布的评论及附件。";
    setSubmitting(true);
    setCommentsError(null);
    try {
      const comment = await createComment(task.id, body);
      const [results, inlineAttachments] = await Promise.all([
        Promise.allSettled(
          pendingCommentFiles.map((file) => uploadCommentAttachment(comment.id, file)),
        ),
        Promise.all(
          commentInlineImages.map((image) => uploadCommentAttachment(comment.id, image.file)),
        ),
      ]);
      const uploaded = results.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
      const nextComment = commentInlineImages.length > 0
        ? await updateComment(
            comment,
            resolveInlineMediaMarkdown(body, commentInlineImages, inlineAttachments),
          )
        : { ...comment, attachments: [...comment.attachments, ...uploaded] };
      setComments((current) => [...current, nextComment]);
      setCommentSegments(createInlineMediaSegments());
      setPendingCommentFiles([]);
      if (commentAttachmentInputRef.current) commentAttachmentInputRef.current.value = "";
      const failed = results.length - uploaded.length;
      if (failed > 0) setCommentsError(`评论已发布，但有 ${failed} 个附件上传失败。`);
      else onAnnounce(
        uploaded.length + inlineAttachments.length > 0
          ? "评论和附件已发布。"
          : "评论已发布。",
      );
      requestAnimationFrame(() => composerRef.current?.focus());
      return followUp;
    } catch (error) {
      setCommentsError(messageFor(error));
      return null;
    } finally {
      setSubmitting(false);
    }
  }

  function openPublishedCommentInNewThread(comment: Comment, runtime: TaskRuntime = "codex") {
    setCommentThreadMenuId(null);
    onOpenInThread(
      currentTask,
      comment.body.trim() || "请查看这条评论及附件。",
      comment,
      runtime,
    );
  }

  async function associatePublishedCommentWithThread(comment: Comment, threadId: string) {
    if (commentThreadActionId) return;
    setCommentThreadMenuId(null);
    setCommentThreadActionId(comment.id);
    setCommentsError(null);
    try {
      const updated = await updateComment(comment, comment.body, threadId);
      setComments((current) => current.map((item) => item.id === updated.id ? updated : item));
      onAnnounce("评论已关联会话。需要处理时，请点击“在关联会话处理”。");
    } catch (error) {
      setCommentsError(messageFor(error));
    } finally {
      setCommentThreadActionId(null);
    }
  }

  async function dissociatePublishedCommentFromThread(comment: Comment) {
    if (commentThreadActionId || !comment.threadId) return;
    setCommentThreadMenuId(null);
    setCommentThreadActionId(comment.id);
    setCommentsError(null);
    try {
      const updated = await updateComment(comment, comment.body, null);
      setComments((current) => current.map((item) => item.id === updated.id ? updated : item));
      onAnnounce("已解除评论与会话的关联。");
    } catch (error) {
      setCommentsError(messageFor(error));
    } finally {
      setCommentThreadActionId(null);
    }
  }

  function stageCommentFiles(files: FileList | File[]) {
    const selected = Array.from(files);
    const oversized = selected.find((file) => file.size > MAX_ATTACHMENT_SIZE);
    if (oversized) {
      setCommentsError(`“${oversized.name}” 超过 25 MB，无法上传。`);
      if (commentAttachmentInputRef.current) commentAttachmentInputRef.current.value = "";
      return;
    }
    setCommentsError(null);
    setPendingCommentFiles((current) => {
      const existing = new Set(current.map(fileKey));
      return [...current, ...selected.filter((file) => !existing.has(fileKey(file)))];
    });
  }

  function handleSubmitShortcut(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      void submitComment();
    }
  }

  function handleCommentThreadMenuKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      const trigger = commentThreadMenuId
        ? document.querySelector<HTMLButtonElement>(`[data-comment-thread-trigger="${commentThreadMenuId}"]`)
        : null;
      setCommentThreadMenuId(null);
      trigger?.focus();
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const options = [...(commentThreadMenuRef.current?.querySelectorAll<HTMLButtonElement>("[role='option']") ?? [])];
    if (options.length === 0) return;
    event.preventDefault();
    const currentIndex = options.indexOf(document.activeElement as HTMLButtonElement);
    const nextIndex = event.key === "Home"
      ? 0
      : event.key === "End"
        ? options.length - 1
        : event.key === "ArrowUp"
          ? (currentIndex <= 0 ? options.length - 1 : currentIndex - 1)
          : (currentIndex + 1) % options.length;
    options[nextIndex]?.focus();
  }

  function beginEdit(comment: Comment) {
    setEditingId(comment.id);
    setEditingBody(comment.body);
    setActiveMenuId(null);
  }

  async function saveComment(comment: Comment) {
    const body = editingBody.trim();
    if (!body || body === comment.body) {
      if (body === comment.body) setEditingId(null);
      return;
    }
    setSavingCommentId(comment.id);
    setCommentsError(null);
    try {
      const updated = await updateComment(comment, body);
      setComments((current) => current.map((item) => item.id === updated.id ? updated : item));
      setEditingId(null);
      onAnnounce("评论已更新。");
    } catch (error) {
      setCommentsError(messageFor(error));
    } finally {
      setSavingCommentId(null);
    }
  }

  async function confirmDelete() {
    if (!pendingDelete || deleting) return;
    setDeleting(true);
    setCommentsError(null);
    try {
      await deleteComment(pendingDelete);
      setComments((current) => current.filter((comment) => comment.id !== pendingDelete.id));
      setPendingDelete(null);
      onAnnounce("评论已删除。");
    } catch (error) {
      setCommentsError(messageFor(error));
    } finally {
      setDeleting(false);
    }
  }

  async function unlinkThread(threadId: string) {
    if (unlinkingThreadId) return;
    setUnlinkingThreadId(threadId);
    onError(null);
    try {
      const updated = await onUnlinkThread(currentTask, threadId);
      setCurrentTask(updated);
      setComments((current) => current.map((comment) => (
        comment.threadId === threadId
          ? { ...comment, threadId: null, version: comment.version + 1, updatedAt: updated.updatedAt }
          : comment
      )));
      onAnnounce("已解除议题与会话的关联。");
    } catch (error) {
      onError(messageFor(error));
    } finally {
      setUnlinkingThreadId(null);
    }
  }

  async function uploadFiles(files: FileList) {
    const selected = Array.from(files);
    if (selected.length === 0 || uploadingAttachments) return;
    const oversized = selected.find((file) => file.size > MAX_ATTACHMENT_SIZE);
    if (oversized) {
      setAttachmentsError(`“${oversized.name}” 超过 25 MB，无法上传。`);
      if (attachmentInputRef.current) attachmentInputRef.current.value = "";
      return;
    }

    setUploadingAttachments(true);
    setAttachmentsError(null);
    let uploaded = 0;
    try {
      for (const file of selected) {
        const attachment = await uploadAttachment(task.id, file);
        setAttachments((current) => current.some((item) => item.id === attachment.id)
          ? current
          : [...current, attachment]);
        uploaded += 1;
      }
      onAnnounce(uploaded === 1 ? "附件已上传。" : `${uploaded} 个附件已上传。`);
    } catch (error) {
      setAttachmentsError(messageFor(error));
    } finally {
      setUploadingAttachments(false);
      if (attachmentInputRef.current) attachmentInputRef.current.value = "";
    }
  }

  async function confirmAttachmentDelete() {
    if (!pendingAttachmentDelete || deletingAttachment) return;
    setDeletingAttachment(true);
    setAttachmentsError(null);
    try {
      await deleteAttachment(pendingAttachmentDelete);
      setAttachments((current) => current.filter((attachment) => attachment.id !== pendingAttachmentDelete.id));
      setComments((current) => current.map((comment) => ({
        ...comment,
        attachments: comment.attachments.filter((attachment) => attachment.id !== pendingAttachmentDelete.id),
      })));
      setPendingAttachmentDelete(null);
      onAnnounce("附件已删除。");
    } catch (error) {
      setAttachmentsError(messageFor(error));
    } finally {
      setDeletingAttachment(false);
    }
  }

  const developmentOptions = [...developmentScan.contexts];
  if (
    currentTask.developmentContext
    && !developmentOptions.some((context) => contextValue(context) === contextValue(currentTask.developmentContext))
  ) {
    developmentOptions.unshift(currentTask.developmentContext);
  }
  const assigneeOptions = [currentTask.assignee, currentUser, CODEX_AGENT_ACTOR]
    .filter((actor, index, actors) => (
      actors.findIndex((candidate) => actorKey(candidate) === actorKey(actor)) === index
    ));
  const statusOptions: PropertyOption<TaskStatus>[] = TASK_STATUSES.map((status) => ({
    value: status,
    label: STATUS_DETAILS[status].label,
    icon: <LinearStatusIcon status={status} />,
  }));
  const priorityOptions: PropertyOption<TaskPriority>[] = (
    Object.keys(PRIORITY_DETAILS) as TaskPriority[]
  ).map((priority) => ({
    value: priority,
    label: PRIORITY_DETAILS[priority].label,
    icon: <LinearPriorityIcon priority={priority} />,
  }));
  const assigneePropertyOptions: PropertyOption<string>[] = assigneeOptions.map((actor) => ({
    value: actorKey(actor),
    label: actor.id === currentUser.id ? `${actor.name}（我）` : actor.name,
    icon: <ActorAvatar actor={actor} className="detail-property-option-avatar" />,
  }));
  const workflowPropertyOptions: PropertyOption<string>[] = [
    {
      value: "",
      label: "未绑定",
      icon: <LinearIcon name="dashboard" />,
    },
    ...(!workflowAvailable && currentTask.workflowId ? [{
      value: currentTask.workflowId,
      label: "当前设备未找到此流程",
      icon: <LinearIcon name="alert" />,
    }] : []),
    ...workflows.map((workflow) => ({
      value: workflow.id,
      label: workflow.name,
      icon: <LinearIcon name="dashboard" />,
    })),
  ];
  const developmentPropertyOptions: PropertyOption<string>[] = [
    {
      value: "",
      label: developmentScanLoading ? "正在扫描 Git…" : "未绑定",
      icon: <LinearIcon name="branch" />,
    },
    ...developmentOptions.map((context) => ({
      value: contextValue(context),
      label: contextLabel(context),
      group: context.type === "branch" ? "代码分支" : "Worktree",
      icon: <LinearIcon name="branch" />,
      title: context.type === "worktree" ? context.path : context.branch,
    })),
  ];
  const recurrenceOptions: PropertyOption<string>[] = [
    { value: "", label: "不重复", icon: <LinearIcon name="recurrence" /> },
    { value: "day", label: "每天", icon: <LinearIcon name="recurrence" /> },
    { value: "week", label: "每周", icon: <LinearIcon name="recurrence" /> },
    { value: "month", label: "每月", icon: <LinearIcon name="recurrence" /> },
    { value: "year", label: "每年", icon: <LinearIcon name="recurrence" /> },
  ];
  const visibleTaskAttachments = attachments.filter(
    (attachment) => !description.includes(attachmentContentUrl(attachment)),
  );
  const commentComposer = (
    <form
      className={`comment-composer${activityOrder === "desc" ? " is-before-stream" : ""}`}
      onSubmit={(event) => { event.preventDefault(); void submitComment(); }}
    >
      <div className="composer-author">
        <ActorAvatar
          className="comment-avatar"
          actor={currentUser}
        />
        <strong>{currentUser.name}</strong>
        <span className="actor-id">@{currentUser.id}</span>
      </div>
      <InlineMediaComposer
        ref={composerRef}
        className="comment-inline-media"
        segments={commentSegments}
        placeholder="留下评论…"
        ariaLabel="留下评论"
        onChange={setCommentSegments}
        onError={setCommentsError}
        onKeyDown={handleSubmitShortcut}
      />
      <PendingAttachments
        files={pendingCommentFiles}
        disabled={submitting}
        uploadLabel="发布后上传"
        ariaLabel="待上传评论附件"
        className="comment-composer-files"
        onRemove={(index) => setPendingCommentFiles((current) => current.filter((_, itemIndex) => itemIndex !== index))}
      />
      <footer className="composer-footer">
        <div className="composer-footer-leading">
          <button
            className="comment-attach-button"
            type="button"
            disabled={submitting}
            aria-label="添加评论附件"
            title="添加附件"
            onClick={() => commentAttachmentInputRef.current?.click()}
          >
            <LinearIcon name="attachment" />
          </button>
          <span>草稿会自动保存</span>
          <input
            ref={commentAttachmentInputRef}
            type="file"
            multiple
            hidden
            onChange={(event) => {
              if (event.currentTarget.files) stageCommentFiles(event.currentTarget.files);
            }}
          />
        </div>
        <div className="composer-submit-actions">
          <kbd>⌘ Enter</kbd>
          <button
            className="button primary"
            type="submit"
            disabled={!canSubmitComment || submitting}
          >
            {submitting ? "发表中…" : "发表评论"}
          </button>
        </div>
      </footer>
    </form>
  );

  return (
    <section className="issue-detail" aria-label={`${task.identifier} 议题详情`}>
      <div className="issue-detail-scroll">
        <div className="issue-detail-layout">
          <div className="issue-detail-main">
            <article className="issue-editor" aria-label="议题内容">
              <div className="issue-editor-content">
                <div className="issue-title-row">
                  <textarea
                    ref={titleRef}
                    className="issue-title-input"
                    rows={1}
                    value={title}
                    aria-label="议题标题"
                    disabled={savingProperty === "title"}
                    onChange={(event) => {
                      setTitle(event.target.value.replace(/\n/g, ""));
                      resizeTextarea(event.currentTarget);
                    }}
                    onKeyDown={handleTitleKeyDown}
                    onBlur={() => void saveTitle()}
                  />
                  <button
                    className={`issue-favorite-button${isFavorite ? " active" : ""}`}
                    type="button"
                    aria-label={isFavorite ? `取消收藏 ${currentTask.identifier}` : `收藏 ${currentTask.identifier}`}
                    aria-pressed={isFavorite}
                    title={isFavorite ? "取消收藏" : "添加到收藏夹"}
                    onClick={() => onToggleFavorite(currentTask)}
                  >
                    <LinearIcon name="favorite" />
                  </button>
                  <button
                    className="issue-knowledge-button"
                    type="button"
                    disabled={!knowledgeAvailable || knowledgeBusy}
                    title={knowledgeAvailable ? "整理整项议题及评论" : "需要先映射本地项目目录"}
                    onClick={() => void createKnowledgeProposalFrom()}
                  >
                    <LinearIcon name="write" />
                    {knowledgeBusy ? "整理中…" : "整理为项目知识"}
                  </button>
                </div>
                <IssueParentLink
                  task={currentTask}
                  tasks={tasks}
                  onOpenTask={onOpenTask}
                  onAddRelation={(anchor, type, relatedTaskId) => applyRelationMutation(
                    () => onAddRelation(anchor, type, relatedTaskId),
                  )}
                  onRemoveRelation={(anchor, type, relatedTaskId) => applyRelationMutation(
                    () => onRemoveRelation(anchor, type, relatedTaskId),
                  )}
                />
                {editingDescription ? (
                  <textarea
                    ref={descriptionRef}
                    className="issue-description-input"
                    rows={1}
                    value={description}
                    aria-label="议题描述"
                    placeholder="添加描述…"
                    disabled={savingProperty === "description"}
                    onChange={(event) => {
                      setDescription(event.target.value);
                      resizeTextarea(event.currentTarget);
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "Escape") {
                        setDescription(currentTask.description);
                        setEditingDescription(false);
                      }
                    }}
                    onBlur={() => {
                      setEditingDescription(false);
                      void saveDescription();
                    }}
                  />
                ) : (
                  <div
                    className={`issue-description-read${description ? "" : " empty"}`}
                    role="button"
                    tabIndex={0}
                    aria-label="编辑议题描述"
                    onClick={() => setEditingDescription(true)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        setEditingDescription(true);
                      }
                    }}
                  >
                    {description ? <DescriptionDocument value={description} /> : "添加描述…"}
                  </div>
                )}
                {linkedThreadIds.length > 0 && (
                  <div className="issue-conversation-list" aria-label="处理此议题的对话">
                    {currentTask.threadId && (
                      <div className="comment-conversation-link issue-conversation-item">
                        <ConversationLink
                          threadId={currentTask.threadId}
                          onOpen={(threadId) => onOpenThread(threadId, currentTask)}
                          label="当前会话"
                          runtime={currentThreadRuntime}
                        />
                        <button
                          className="comment-conversation-unlink"
                          type="button"
                          aria-label={`解除会话 ${currentTask.threadId} 与议题的关联`}
                          title="解除关联"
                          disabled={Boolean(unlinkingThreadId)}
                          onClick={() => void unlinkThread(currentTask.threadId!)}
                        >
                          <LinearIcon name="close" />
                        </button>
                      </div>
                    )}
                    {historicalThreadIds.length > 0 && (
                      <details className="issue-conversation-history">
                        <summary>历史相关会话（{historicalThreadIds.length}）</summary>
                        <div>
                          {historicalThreadIds.map((threadId) => (
                            <div className="comment-conversation-link issue-conversation-item" key={threadId}>
                              <ConversationLink
                                threadId={threadId}
                                onOpen={(threadId) => onOpenThread(threadId, currentTask)}
                                runtime={taskThreadRuntime(currentTask, threadId)}
                              />
                              <button
                                className="comment-conversation-unlink"
                                type="button"
                                aria-label={`解除会话 ${threadId} 与议题的关联`}
                                title="解除关联"
                                disabled={Boolean(unlinkingThreadId)}
                                onClick={() => void unlinkThread(threadId)}
                              >
                                <LinearIcon name="close" />
                              </button>
                            </div>
                          ))}
                        </div>
                      </details>
                    )}
                  </div>
                )}
              </div>
            </article>

            <IssueSubIssues
              task={currentTask}
              tasks={tasks}
              onOpenTask={onOpenTask}
              onCreateSubIssue={onCreateSubIssue}
              onAddRelation={(anchor, type, relatedTaskId) => applyRelationMutation(
                () => onAddRelation(anchor, type, relatedTaskId),
              )}
              onRemoveRelation={(anchor, type, relatedTaskId) => applyRelationMutation(
                () => onRemoveRelation(anchor, type, relatedTaskId),
              )}
            />

            <section className="issue-attachments" aria-labelledby="attachments-heading">
              <header className="attachments-heading">
                <div>
                  <h2 id="attachments-heading">附件</h2>
                  <span>{visibleTaskAttachments.length}</span>
                </div>
                <button
                  className="attachment-add-button"
                  type="button"
                  disabled={uploadingAttachments}
                  onClick={() => attachmentInputRef.current?.click()}
                >
                  <LinearIcon name="attachment" />
                  {uploadingAttachments ? "上传中…" : "添加附件"}
                </button>
                <input
                  ref={attachmentInputRef}
                  type="file"
                  multiple
                  hidden
                  onChange={(event) => {
                    if (event.currentTarget.files) void uploadFiles(event.currentTarget.files);
                  }}
                />
              </header>

              {attachmentsLoading ? (
                <div className="attachments-loading" aria-label="正在加载附件" aria-busy="true"><i /><i /></div>
              ) : visibleTaskAttachments.length > 0 ? (
                <ul className="attachment-list">
                  {visibleTaskAttachments.map((attachment) => (
                    <li key={attachment.id}>
                      <a
                        className="attachment-link"
                        href={attachmentContentUrl(attachment)}
                        target="_blank"
                        rel="noreferrer"
                        title={`打开 ${attachment.filename}`}
                      >
                        <span className="attachment-file-icon" aria-hidden="true">
                          <LinearIcon name="file" />
                        </span>
                        <span className="attachment-copy">
                          <strong>{attachment.filename}</strong>
                          <span>{fileSize(attachment.size)} · {relativeTime(attachment.createdAt)}</span>
                        </span>
                      </a>
                      <div className="attachment-actions">
                        <a
                          href={attachmentContentUrl(attachment)}
                          download={attachment.filename}
                          aria-label={`下载 ${attachment.filename}`}
                          title="下载附件"
                        >
                          <LinearIcon name="openExternal" />
                        </a>
                        <button
                          type="button"
                          aria-label={`删除 ${attachment.filename}`}
                          title="删除附件"
                          onClick={() => setPendingAttachmentDelete(attachment)}
                        >
                          <LinearIcon name="trash" />
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="attachments-empty">添加图片、文档或其他文件，单个文件不超过 25 MB。</p>
              )}
              {attachmentsError && <div className="attachments-error" role="alert">{attachmentsError}</div>}
            </section>

            <section className="activity-section" aria-labelledby="activity-heading">
              <header className="activity-heading">
                <h2 id="activity-heading">活动</h2>
                <span>{normalizedCommentSearch ? `${filteredComments.length}/${comments.length}` : comments.length}</span>
                <button
                  className={`comment-knowledge-select${selectingKnowledgeComments ? " active" : ""}`}
                  type="button"
                  disabled={!knowledgeAvailable || knowledgeBusy || comments.length === 0}
                  onClick={() => {
                    setSelectingKnowledgeComments((current) => !current);
                    setSelectedKnowledgeCommentIds(new Set());
                  }}
                >
                  {selectingKnowledgeComments ? "取消选择" : "选择评论整理"}
                </button>
                <div className="activity-order" role="group" aria-label="活动排序">
                  <button
                    type="button"
                    aria-pressed={activityOrder === "desc"}
                    onClick={() => setActivityOrder("desc")}
                  >
                    最新优先
                  </button>
                  <button
                    type="button"
                    aria-pressed={activityOrder === "asc"}
                    onClick={() => setActivityOrder("asc")}
                  >
                    最早优先
                  </button>
                </div>
              </header>

              {selectingKnowledgeComments && (
                <div className="comment-knowledge-toolbar">
                  <span>已选择 {selectedKnowledgeCommentIds.size} 条评论</span>
                  <button
                    type="button"
                    onClick={() => setSelectedKnowledgeCommentIds((current) => (
                      current.size === filteredComments.length
                        ? new Set()
                        : new Set(filteredComments.map((comment) => comment.id))
                    ))}
                  >
                    {selectedKnowledgeCommentIds.size === filteredComments.length ? "取消全选" : "全选当前结果"}
                  </button>
                  <button
                    className="button primary"
                    type="button"
                    disabled={selectedKnowledgeCommentIds.size === 0 || knowledgeBusy}
                    onClick={() => void createKnowledgeProposalFrom(
                      comments.filter((comment) => selectedKnowledgeCommentIds.has(comment.id)),
                    )}
                  >
                    {knowledgeBusy ? "整理中…" : "生成知识提案"}
                  </button>
                </div>
              )}

              <div className={`comment-search${normalizedCommentSearch ? " has-value" : ""}`}>
                <LinearIcon name="search" />
                <input
                  type="search"
                  value={commentSearch}
                  placeholder="搜索当前议题的评论内容"
                  aria-label="搜索当前议题的评论内容"
                  onChange={(event) => setCommentSearch(event.currentTarget.value)}
                />
                {commentSearch && (
                  <button
                    type="button"
                    aria-label="清空评论搜索"
                    title="清空搜索"
                    onClick={() => setCommentSearch("")}
                  >
                    <LinearIcon name="close" />
                  </button>
                )}
              </div>

              {activityOrder === "desc" && commentComposer}

              <div className="activity-stream">
                {!normalizedCommentSearch && activityOrder === "asc" && createdActivity}

                {commentsLoading ? (
                  <div className="comments-loading" aria-label="正在加载评论" aria-busy="true"><i /><i /></div>
                ) : normalizedCommentSearch && orderedComments.length === 0 ? (
                  <p className="comment-search-empty">没有找到包含“{commentSearch.trim()}”的评论</p>
                ) : orderedComments.map((comment) => (
                  <article
                    className={`comment-entry is-${comment.authorType}`}
                    key={comment.id}
                    id={`comment-${comment.id}`}
                  >
                    <div className="comment-card">
                      <header className="comment-header">
                        <ActorAvatar
                          className="comment-avatar"
                          actor={{
                            type: comment.authorType,
                            id: comment.authorId,
                            name: comment.authorName,
                            avatarUrl: comment.authorAvatarUrl,
                          }}
                        />
                        <strong>{comment.authorName}</strong>
                        <span className="actor-id">@{comment.authorId}</span>
                        <time title={exactTime(comment.createdAt)}>{relativeTime(comment.createdAt)}</time>
                        {comment.version > 1 && (
                          <span className="comment-edited" title={`编辑于 ${exactTime(comment.updatedAt)}`}>已编辑</span>
                        )}
                        {selectingKnowledgeComments && (
                          <label className="comment-knowledge-checkbox" title="选择这条评论">
                            <input
                              type="checkbox"
                              checked={selectedKnowledgeCommentIds.has(comment.id)}
                              onChange={(event) => setSelectedKnowledgeCommentIds((current) => {
                                const next = new Set(current);
                                if (event.currentTarget.checked) next.add(comment.id);
                                else next.delete(comment.id);
                                return next;
                              })}
                            />
                            <span>选择</span>
                          </label>
                        )}
                        <div className="comment-actions" data-comment-menu-root={comment.id}>
                          <button
                            type="button"
                            className="comment-menu-trigger"
                            aria-label="评论操作"
                            aria-haspopup="menu"
                            aria-expanded={activeMenuId === comment.id}
                            onClick={() => setActiveMenuId((current) => current === comment.id ? null : comment.id)}
                          >
                            <LinearIcon name="more" />
                          </button>
                          {activeMenuId === comment.id && (
                            <div className="comment-action-menu" role="menu">
                              <button
                                type="button"
                                role="menuitem"
                                disabled={!knowledgeAvailable || knowledgeBusy}
                                onClick={() => void createKnowledgeProposalFrom([comment])}
                              >
                                <LinearIcon name="write" />
                                加入知识提案
                              </button>
                              <button type="button" role="menuitem" onClick={() => beginEdit(comment)}>
                                <LinearIcon name="write" />
                                编辑评论
                              </button>
                              <button
                                type="button"
                                role="menuitem"
                                className="danger"
                                onClick={() => { setPendingDelete(comment); setActiveMenuId(null); }}
                              >
                                <LinearIcon name="trash" />
                                删除评论
                              </button>
                            </div>
                          )}
                        </div>
                      </header>

                      {editingId === comment.id ? (
                        <div className="comment-edit-form">
                          <textarea
                            className="comment-input"
                            autoFocus
                            value={editingBody}
                            rows={3}
                            aria-label="编辑评论"
                            onChange={(event) => setEditingBody(event.target.value)}
                            onKeyDown={(event) => {
                              if (event.key === "Escape") setEditingId(null);
                              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                                event.preventDefault();
                                void saveComment(comment);
                              }
                            }}
                          />
                          <div>
                            <button className="button secondary" type="button" onClick={() => setEditingId(null)}>取消</button>
                            <button
                              className="button primary"
                              type="button"
                              disabled={!editingBody.trim() || savingCommentId === comment.id}
                              onClick={() => void saveComment(comment)}
                            >
                              {savingCommentId === comment.id ? "保存中…" : "保存"}
                            </button>
                          </div>
                        </div>
                      ) : (
                        comment.body && <div className="comment-body"><DescriptionDocument value={comment.body} /></div>
                      )}
                      {comment.attachments.some(
                        (attachment) => !comment.body.includes(attachmentContentUrl(attachment)),
                      ) && (
                        <ul className="comment-attachment-list" aria-label="评论附件">
                          {comment.attachments
                            .filter((attachment) => !comment.body.includes(attachmentContentUrl(attachment)))
                            .map((attachment) => (
                              <li key={attachment.id}>
                                <a
                                  href={attachmentContentUrl(attachment)}
                                  target="_blank"
                                  rel="noreferrer"
                                  title={`打开 ${attachment.filename}`}
                                >
                                  <span className="attachment-file-icon" aria-hidden="true">
                                    <LinearIcon name="file" />
                                  </span>
                                  <span><strong>{attachment.filename}</strong><small>{fileSize(attachment.size)}</small></span>
                                </a>
                                <button
                                  type="button"
                                  aria-label={`删除 ${attachment.filename}`}
                                  title="删除附件"
                                  onClick={() => setPendingAttachmentDelete(attachment)}
                                >
                                  <LinearIcon name="trash" />
                                </button>
                              </li>
                            ))}
                        </ul>
                      )}
                      {comment.threadId && (
                        <div className="comment-conversation-link">
                          <ConversationLink
                            threadId={comment.threadId}
                            onOpen={(threadId) => onOpenThread(threadId, currentTask)}
                            runtime={taskThreadRuntime(currentTask, comment.threadId)}
                          />
                          <button
                            className="comment-conversation-unlink"
                            type="button"
                            aria-label="解除评论与会话的关联"
                            title="解除关联"
                            disabled={Boolean(commentThreadActionId)}
                            onClick={() => void dissociatePublishedCommentFromThread(comment)}
                          >
                            <LinearIcon name="close" />
                          </button>
                        </div>
                      )}
                      <div className="comment-conversation-actions">
                        {comment.threadId && (
                          <button
                            className="button secondary comment-follow-up-thread-button"
                            type="button"
                            disabled={openingThread || Boolean(commentThreadActionId)}
                            onClick={() => onFollowUpInThread(
                              currentTask,
                              comment.threadId as string,
                              comment.body.trim() || "请查看这条评论及附件。",
                            )}
                          >
                            <RuntimeIcon runtime={taskThreadRuntime(currentTask, comment.threadId)} />
                            {openingThread ? "正在发送…" : "在关联会话处理"}
                          </button>
                        )}
                        <button
                          className="button secondary comment-new-thread-button"
                          type="button"
                          disabled={openingThread || Boolean(commentThreadActionId)}
                          onClick={() => openPublishedCommentInNewThread(comment)}
                        >
                          <RuntimeIcon runtime="codex" />
                          {openingThread ? "正在打开…" : "新建 Codex 会话"}
                        </button>
                        <button
                          className="button secondary comment-new-thread-claude"
                          type="button"
                          disabled={openingThread || Boolean(commentThreadActionId) || !claudeRuntimeSupported}
                          title={claudeRuntimeSupported ? "用 Claude Code 新建会话" : "仅 macOS Terminal.app 支持 Claude"}
                          onClick={() => openPublishedCommentInNewThread(comment, "claude")}
                        >
                          <RuntimeIcon runtime="claude" />
                          {openingThread ? "正在打开…" : "新建 Claude 会话"}
                        </button>
                        <button
                          className="button secondary comment-new-thread-omp"
                          type="button"
                          disabled={openingThread || Boolean(commentThreadActionId) || !ompRuntimeSupported}
                          title={ompRuntimeSupported ? "用 Oh My Pi 新建会话" : "仅 macOS Terminal.app 支持 OMP"}
                          onClick={() => openPublishedCommentInNewThread(comment, "omp")}
                        >
                          <RuntimeIcon runtime="omp" />
                          {openingThread ? "正在打开…" : "新建 OMP 会话"}
                        </button>
                        <div
                          className="comment-thread-picker"
                          ref={commentThreadMenuId === comment.id ? commentThreadMenuRef : undefined}
                        >
                          <button
                            className="button secondary comment-thread-picker-trigger"
                            type="button"
                            data-comment-thread-trigger={comment.id}
                            disabled={openingThread || Boolean(commentThreadActionId) || commentThreadOptions.length === 0}
                            aria-label="关联已有会话"
                            aria-haspopup="listbox"
                            aria-expanded={commentThreadMenuId === comment.id}
                            title={commentThreadOptions.length === 0 ? "当前议题没有可关联的 Codex 会话" : "Codex · 关联已有会话"}
                            onClick={() => setCommentThreadMenuId((current) => current === comment.id ? null : comment.id)}
                          >
                            <RuntimeIcon runtime="codex" />
                            <span>{comment.threadId ? "更换关联会话" : "关联已有会话"}</span>
                            <LinearIcon className="comment-thread-picker-chevron" name="chevronDown" />
                          </button>
                          {commentThreadMenuId === comment.id && (
                            <div
                              className="comment-thread-menu"
                              role="listbox"
                              aria-label="选择要关联的会话"
                              onKeyDown={handleCommentThreadMenuKeyDown}
                            >
                              <span className="comment-thread-menu-heading">选择后将关联并打开会话</span>
                              {comment.threadId && (
                                <button
                                  type="button"
                                  role="option"
                                  aria-selected="false"
                                  className="comment-thread-unlink-option"
                                  onClick={() => void dissociatePublishedCommentFromThread(comment)}
                                >
                                  <span className="detail-thread-option-icon"><LinearIcon name="trash" /></span>
                                  <span className="comment-thread-option-copy">
                                    <strong>解除关联</strong>
                                    <small>保留评论和 Codex 会话</small>
                                  </span>
                                </button>
                              )}
                              {commentThreadOptions.map((thread) => (
                                <button
                                  type="button"
                                  role="option"
                                  aria-selected={comment.threadId === thread.id}
                                  key={thread.id}
                                  title={thread.title}
                                  onClick={() => void associatePublishedCommentWithThread(comment, thread.id)}
                                >
                                  <span className="detail-thread-option-icon"><RuntimeIcon runtime="codex" /></span>
                                  <span className="comment-thread-option-copy">
                                    <strong>{thread.title}</strong>
                                    <small>{thread.id}</small>
                                  </span>
                                </button>
                              ))}
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  </article>
                ))}

                {!normalizedCommentSearch && activityOrder === "desc" && createdActivity}
              </div>

              {commentsError && <div className="comments-error" role="alert">{commentsError}</div>}

              {activityOrder === "asc" && commentComposer}
            </section>
          </div>

          <aside className="issue-properties" aria-label="议题属性">
            <div className="detail-thread-actions" aria-label="会话关联">
              <h2>会话</h2>
              <button
                className="detail-open-thread-action"
                type="button"
                disabled={(
                  !currentCodexThreadId
                  || Boolean(linkingThreadId)
                  || currentTask.threadId === currentCodexThreadId
                )}
                title={currentTask.threadId === currentCodexThreadId ? "Codex · 已关联当前会话" : "Codex · 关联当前会话"}
                onClick={() => currentCodexThreadId && void linkThread(currentCodexThreadId)}
              >
                <RuntimeIcon runtime="codex" />
                <span>{currentTask.threadId === currentCodexThreadId ? "已关联当前会话" : "关联当前会话"}</span>
              </button>
              <div className="detail-thread-picker" ref={threadMenuRef}>
                <button
                  ref={threadMenuTriggerRef}
                  className="detail-thread-picker-trigger"
                  type="button"
                  disabled={Boolean(linkingThreadId) || selectableCodexThreads.length === 0}
                  aria-label="选择已有会话"
                  aria-haspopup="listbox"
                  aria-expanded={threadMenuOpen}
                  title={selectableCodexThreads.length > 0 ? "Codex · 选择已有会话" : "暂无可选会话"}
                  onClick={() => setThreadMenuOpen((open) => !open)}
                  onKeyDown={(event) => {
                    if (event.key !== "Escape" || !threadMenuOpen) return;
                    event.preventDefault();
                    event.stopPropagation();
                    setThreadMenuOpen(false);
                  }}
                >
                  <RuntimeIcon runtime="codex" />
                  <span>
                    {linkingThreadId
                      ? "正在关联…"
                      : selectableCodexThreads.length > 0
                        ? "选择已有会话"
                        : "暂无可选会话"}
                  </span>
                  <LinearIcon className="detail-thread-picker-chevron" name="chevronDown" />
                </button>
                {threadMenuOpen && (
                  <div
                    className="detail-thread-menu"
                    role="listbox"
                    aria-label="已有会话"
                    onKeyDown={handleThreadMenuKeyDown}
                  >
                    {selectableCodexThreads.map((thread) => (
                      <button
                        key={thread.id}
                        type="button"
                        role="option"
                        aria-selected="false"
                        title={thread.title}
                        onClick={() => void linkThread(thread.id)}
                      >
                        <span className="detail-thread-option-icon"><RuntimeIcon runtime="codex" /></span>
                        <span className="detail-thread-option-title">{thread.title}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
              {currentTask.threadId && (
                <button
                  className="detail-open-thread-action"
                  type="button"
                  disabled={openingThread}
                  title={`${RUNTIME_LABELS[currentThreadRuntime]} · 在当前会话处理`}
                  onClick={() => onFollowUpInThread(currentTask, currentTask.threadId as string, "", currentThreadRuntime)}
                >
                  <RuntimeIcon runtime={currentThreadRuntime} />
                  <span>{openingThread ? "正在发送…" : "在当前会话处理"}</span>
                </button>
              )}
              <button
                className="detail-open-thread-action"
                type="button"
                disabled={openingThread}
                title="Codex · 新建会话"
                onClick={() => onOpenInThread(currentTask)}
              >
                <RuntimeIcon runtime="codex" />
                <span>{openingThread ? "正在打开…" : "新建 Codex 会话"}</span>
              </button>
              <button
                className="detail-open-thread-action detail-open-thread-claude"
                type="button"
                disabled={openingThread || !claudeRuntimeSupported}
                title={claudeRuntimeSupported ? "用 Claude Code 新建会话" : "仅 macOS Terminal.app 支持 Claude"}
                onClick={() => onOpenInThread(currentTask, undefined, undefined, "claude")}
              >
                <RuntimeIcon runtime="claude" />
                <span>{openingThread ? "正在打开…" : "新建 Claude 会话"}</span>
              </button>
              <button
                className="detail-open-thread-action detail-open-thread-omp"
                type="button"
                disabled={openingThread || !ompRuntimeSupported}
                title={ompRuntimeSupported ? "用 Oh My Pi 新建会话" : "仅 macOS Terminal.app 支持 OMP"}
                onClick={() => onOpenInThread(currentTask, undefined, undefined, "omp")}
              >
                <RuntimeIcon runtime="omp" />
                <span>{openingThread ? "正在打开…" : "新建 OMP 会话"}</span>
              </button>
            </div>
            <h2>属性</h2>
            <div className="detail-property-row">
              <span className="detail-property-icon" aria-hidden="true"><LinearIcon name="project" /></span>
              <span className="detail-property-label">项目</span>
              <PropertyPicker
                ariaLabel="项目"
                value={currentTask.projectId}
                options={projectPropertyOptions}
                disabled={migratingProject || projectPropertyOptions.length < 2}
                onChange={setPendingProjectId}
              />
            </div>
            <div className="detail-property-row">
              <span className={`detail-property-icon status-icon-${STATUS_DETAILS[currentTask.status].tone}`}><LinearStatusIcon status={currentTask.status} /></span>
              <span className="detail-property-label">状态</span>
              <PropertyPicker
                ariaLabel="状态"
                value={currentTask.status}
                options={statusOptions}
                disabled={savingProperty === "status"}
                onChange={(status) => void saveTask({ status }, "status")}
              />
            </div>
            <div className="detail-property-row">
              <span className="detail-property-icon"><LinearPriorityIcon priority={currentTask.priority} /></span>
              <span className="detail-property-label">优先级</span>
              <PropertyPicker
                ariaLabel="优先级"
                value={currentTask.priority}
                options={priorityOptions}
                disabled={savingProperty === "priority"}
                onChange={(priority) => void saveTask({ priority }, "priority")}
              />
            </div>
            <div className="detail-property-row assignee-property">
              <ActorAvatar actor={currentTask.assignee} className="detail-assignee-avatar" />
              <span className="detail-property-label">负责人</span>
              <PropertyPicker
                ariaLabel="负责人"
                value={actorKey(currentTask.assignee)}
                options={assigneePropertyOptions}
                disabled={savingProperty === "assignee"}
                onChange={(actor) => {
                  const selected = assigneeOptions.find((option) => actorKey(option) === actor);
                  const assigneeTarget = selected
                    ? assigneeTargetForActor(selected, currentUser)
                    : undefined;
                  if (assigneeTarget) void saveTask({ assigneeTarget }, "assignee");
                }}
              />
            </div>
            <div className="detail-property-row labels-property">
              <span className="detail-property-icon" aria-hidden="true">
                <LinearIcon name="label" />
              </span>
              <span className="detail-property-label">标签</span>
              <LabelPicker
                availableLabels={availableLabels}
                selectedLabels={currentTask.labels}
                open={labelMenuOpen}
                disabled={savingProperty === "labels"}
                className="detail-label-picker"
                triggerClassName="detail-label-trigger"
                placeholder="添加标签…"
                onOpenChange={setLabelMenuOpen}
                onChange={(nextLabels) => void saveTask({ labels: nextLabels }, "labels")}
              />
            </div>
            <div className="detail-property-row workflow-property">
              <span className="detail-property-icon" aria-hidden="true">
                <LinearIcon name="dashboard" />
              </span>
              <span className="detail-property-label">工作流</span>
              <PropertyPicker
                ariaLabel="工作流"
                value={currentTask.workflowId ?? ""}
                options={workflowPropertyOptions}
                disabled={savingProperty === "workflowId"}
                onChange={(workflowId) => void saveTask({
                  workflowId: workflowId || null,
                }, "workflowId")}
              />
            </div>
            <div className="detail-property-row development-property">
              <span className="detail-property-icon" aria-hidden="true">
                <LinearIcon name="branch" />
              </span>
              <span className="detail-property-label">开发上下文</span>
              <PropertyPicker
                ariaLabel="开发上下文"
                value={contextValue(currentTask.developmentContext)}
                options={developmentPropertyOptions}
                disabled={developmentScanLoading || savingProperty === "developmentContext"}
                onChange={(context) => void saveTask({
                  developmentContext: context ? JSON.parse(context) as DevelopmentContext : null,
                }, "developmentContext")}
              />
            </div>
            <label className="detail-property-row">
              <span className="detail-property-icon" aria-hidden="true"><LinearIcon name="calendar" /></span>
              <span className="detail-property-label">开始日期</span>
              <input
                type="date"
                value={currentTask.startDate ?? ""}
                disabled={savingProperty === "startDate"}
                onChange={(event) => void saveTask({
                  startDate: event.target.value || null,
                }, "startDate")}
              />
            </label>
            <label className="detail-property-row">
              <span className="detail-property-icon" aria-hidden="true"><LinearIcon name="calendar" /></span>
              <span className="detail-property-label">截止日期</span>
              <input
                type="date"
                value={currentTask.dueDate ?? ""}
                disabled={savingProperty === "dueDate"}
                onChange={(event) => void saveTask({
                  dueDate: event.target.value || null,
                  ...(event.target.value ? {} : { recurrence: null }),
                }, "dueDate")}
              />
            </label>
            <div className="detail-property-row">
              <span className="detail-property-icon" aria-hidden="true"><LinearIcon name="recurrence" /></span>
              <span className="detail-property-label">重复</span>
              <PropertyPicker
                ariaLabel="重复"
                value={currentTask.recurrence?.unit ?? ""}
                options={recurrenceOptions}
                disabled={!currentTask.dueDate || savingProperty === "recurrence"}
                onChange={(unit) => void saveTask({
                  recurrence: unit
                    ? { interval: 1, unit: unit as Recurrence["unit"] }
                    : null,
                }, "recurrence")}
              />
            </div>
            <IssueRelationSidebar
              task={currentTask}
              tasks={tasks}
              onOpenTask={onOpenTask}
              onAddRelation={(anchor, type, relatedTaskId) => applyRelationMutation(
                () => onAddRelation(anchor, type, relatedTaskId),
              )}
              onRemoveRelation={(anchor, type, relatedTaskId) => applyRelationMutation(
                () => onRemoveRelation(anchor, type, relatedTaskId),
              )}
            />
            <div className="detail-timestamps">
              <span>创建于 {exactTime(currentTask.createdAt)}</span>
              {currentTask.updatedAt !== currentTask.createdAt && <span>更新于 {exactTime(currentTask.updatedAt)}</span>}
            </div>
          </aside>
        </div>
      </div>

      {pendingDelete && (
        <div className="delete-backdrop" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget && !deleting) setPendingDelete(null);
        }}>
          <div className="delete-dialog" role="alertdialog" aria-modal="true" aria-labelledby="delete-comment-title">
            <h2 id="delete-comment-title">删除这条评论？</h2>
            <p>此操作无法撤销。</p>
            <div>
              <button className="button secondary" type="button" disabled={deleting} onClick={() => setPendingDelete(null)}>取消</button>
              <button className="button danger" type="button" disabled={deleting} onClick={() => void confirmDelete()}>{deleting ? "删除中…" : "删除评论"}</button>
            </div>
          </div>
        </div>
      )}

      {pendingAttachmentDelete && (
        <div className="delete-backdrop" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget && !deletingAttachment) setPendingAttachmentDelete(null);
        }}>
          <div className="delete-dialog" role="alertdialog" aria-modal="true" aria-labelledby="delete-attachment-title">
            <h2 id="delete-attachment-title">删除这个附件？</h2>
            <p>“{pendingAttachmentDelete.filename}” 将被永久删除，此操作无法撤销。</p>
            <div>
              <button className="button secondary" type="button" disabled={deletingAttachment} onClick={() => setPendingAttachmentDelete(null)}>取消</button>
              <button className="button danger" type="button" disabled={deletingAttachment} onClick={() => void confirmAttachmentDelete()}>{deletingAttachment ? "删除中…" : "删除附件"}</button>
            </div>
          </div>
        </div>
      )}

      {pendingProject && (
        <div className="delete-backdrop" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget && !migratingProject) setPendingProjectId(null);
        }}>
          <div
            className="delete-dialog project-transfer-dialog"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="transfer-project-title"
          >
            <h2 id="transfer-project-title">迁移到“{pendingProject.name}”？</h2>
            <p>
              {currentTask.identifier} 将获得目标项目的新编号。描述、评论、附件、状态、负责人、
              会话关联和开发上下文都会保留。
            </p>
            {currentRelations.length > 0 && (
              <div className="project-transfer-warning" role="note">
                <strong>将解除 {currentRelations.length} 条无法跨项目保留的议题关系：</strong>
                <span>{currentRelations.map((relation) => relation.identifier).join("、")}</span>
              </div>
            )}
            <div>
              <button
                className="button secondary"
                type="button"
                disabled={migratingProject}
                onClick={() => setPendingProjectId(null)}
              >取消</button>
              <button
                className="button primary"
                type="button"
                disabled={migratingProject}
                onClick={() => void confirmProjectTransfer()}
              >{migratingProject ? "迁移中…" : "确认迁移"}</button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
