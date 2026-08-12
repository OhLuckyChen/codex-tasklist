import type { MouseEvent } from "react";
import { TASK_STATUSES, type CodexThreadProgress, type Task, type TaskPriority, type TaskStatus } from "../types";
import { ActorAvatar } from "./ActorAvatar";
import { LinearIcon, LinearPriorityIcon } from "./LinearIcon";
import { RuntimeIcon, RUNTIME_LABELS } from "./RuntimeIcon";

const PRIORITY_LABELS: Record<TaskPriority, string> = {
  none: "无优先级",
  urgent: "紧急",
  high: "高优先级",
  medium: "中优先级",
  low: "低优先级",
};

function descriptionPreview(description: string) {
  return description
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

interface TaskCardProps {
  task: Task;
  projectName?: string;
  progress?: CodexThreadProgress | null;
  statusIndex: number;
  isDragging: boolean;
  dragShift: number;
  isMoving: boolean;
  isSettling: boolean;
  isContextMenuOpen: boolean;
  isFavorite: boolean;
  onEdit: (task: Task) => void;
  onToggleFavorite: (task: Task) => void;
  onContextMenu: (task: Task, position: { x: number; y: number }) => void;
  onMove: (task: Task, status: TaskStatus) => void;
  onDragStart: (task: Task, height: number) => void;
  onDragEnd: () => void;
  onOpenThread: (threadId: string, task: Task) => void;
}

export function TaskCard({
  task,
  projectName,
  progress,
  statusIndex,
  isDragging,
  dragShift,
  isMoving,
  isSettling,
  isContextMenuOpen,
  isFavorite,
  onEdit,
  onToggleFavorite,
  onContextMenu,
  onMove,
  onDragStart,
  onDragEnd,
  onOpenThread,
}: TaskCardProps) {
  const dueDate = task.dueDate
    ? new Intl.DateTimeFormat("zh-CN", { month: "short", day: "numeric" }).format(new Date(`${task.dueDate}T12:00:00`))
    : null;
  const subIssueTotal = task.relations.subIssues.length;
  const completedSubIssues = task.relations.subIssues.filter((issue) => issue.status === "done").length;
  const activeBlockers = task.relations.blockedBy.filter((issue) => (
    issue.status !== "done" && issue.status !== "canceled" && issue.status !== "archived"
  )).length;
  const preview = descriptionPreview(task.description);

  function stopThen(callback: () => void) {
    return (event: MouseEvent<HTMLButtonElement>) => {
      event.stopPropagation();
      callback();
    };
  }

  return (
    <article
      className={`task-card priority-${task.priority}${isDragging ? " is-dragging" : ""}${dragShift ? " is-drag-shifted" : ""}${isMoving ? " is-moving" : ""}${isSettling ? " is-settling" : ""}${isContextMenuOpen ? " is-context-open" : ""}`}
      style={dragShift ? { transform: `translate3d(0, ${dragShift}px, 0)` } : undefined}
      draggable={!isMoving}
      aria-labelledby={`task-${task.id}-title`}
      data-task-id={task.id}
      data-drag-shift={dragShift || undefined}
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onContextMenu(task, { x: event.clientX, y: event.clientY });
      }}
      onDragStart={(event) => {
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", task.id);
        event.dataTransfer.setData("application/x-taskboard-task", task.id);
        onDragStart(task, event.currentTarget.offsetHeight);
      }}
      onDragEnd={onDragEnd}
    >
      <button
        className="task-card-open"
        type="button"
        aria-label={`打开 ${task.identifier}: ${task.title}`}
        onClick={() => onEdit(task)}
      />

      <div className="card-topline">
        <span className="card-reference">
          <span className="task-identifier">{task.identifier}</span>
          {projectName && (
            <span className="task-project-name" title={`所属项目：${projectName}`}>
              <LinearIcon name="folder" />
              <span>{projectName}</span>
            </span>
          )}
          {task.relations.parent && (
            <>
              <LinearIcon name="chevronRight" />
              <span className="card-parent-title" title={task.relations.parent.title}>
                {task.relations.parent.title}
              </span>
            </>
          )}
        </span>
        <ActorAvatar actor={task.assignee} className="card-assignee-avatar" />
        <div className="card-actions" aria-label="移动议题">
          <button
            className="icon-button compact"
            type="button"
            disabled={statusIndex === 0 || isMoving}
            aria-label="移到上一状态"
            title="移到上一状态"
            onClick={stopThen(() => onMove(task, TASK_STATUSES[statusIndex - 1]))}
          >
            <LinearIcon name="chevronLeft" />
          </button>
          <button
            className="icon-button compact"
            type="button"
            disabled={statusIndex === TASK_STATUSES.length - 1 || isMoving}
            aria-label="移到下一状态"
            title="移到下一状态"
            onClick={stopThen(() => onMove(task, TASK_STATUSES[statusIndex + 1]))}
          >
            <LinearIcon name="chevronRight" />
          </button>
        </div>
      </div>

      <h3 id={`task-${task.id}-title`}>{task.title}</h3>

      {progress && progress.total !== null && progress.total > 0 && progress.completed !== null && (
        <div className="card-progress-row">
          <div
            className={`task-progress-segments${progress.running ? " is-running" : ""}`}
            aria-label={`处理进度 ${Math.max(0, Math.min(progress.completed, progress.total))}/${progress.total}`}
            title={`处理进度 ${Math.max(0, Math.min(progress.completed, progress.total))}/${progress.total}`}
          >
            {Array.from({ length: progress.total }, (_, index) => (
              <span className={index < progress.completed! ? "is-complete" : ""} key={index} />
            ))}
          </div>
        </div>
      )}

      {preview && <p className="card-description">{preview}</p>}

      <div className="card-properties" aria-label="议题属性">
        <button
          className={`task-card-favorite${isFavorite ? " active" : ""}`}
          type="button"
          aria-label={isFavorite ? `取消收藏 ${task.identifier}` : `收藏 ${task.identifier}`}
          aria-pressed={isFavorite}
          title={isFavorite ? "取消收藏" : "添加到收藏夹"}
          onClick={stopThen(() => onToggleFavorite(task))}
        >
          <LinearIcon name="favorite" />
        </button>
        <span className={`priority-icon priority-icon-${task.priority}`} title={PRIORITY_LABELS[task.priority]}>
          <LinearPriorityIcon priority={task.priority} />
        </span>
        {activeBlockers > 0 && (
          <span className="blocked-by-count" title={`被 ${activeBlockers} 个未完成议题阻塞`}>
            <LinearIcon name="alert" />
            {activeBlockers}
          </span>
        )}
        {subIssueTotal > 0 && (
          <span className="sub-issue-progress-chip" title={`${completedSubIssues}/${subIssueTotal} 个子议题已完成`}>
            <span className="sub-issue-progress" aria-hidden="true" />
            {completedSubIssues}/{subIssueTotal}
          </span>
        )}
        {task.labels.slice(0, 2).map((label) => (
          <span className="label-chip" key={label}>{label}</span>
        ))}
        {task.labels.length > 2 && (
          <span className="label-more" title={task.labels.slice(2).join(", ")}>+{task.labels.length - 2}</span>
        )}
        {dueDate && (
          <span className="due-date-chip" title={`截止日期 ${task.dueDate}`}>
            <LinearIcon name="calendar" /> {dueDate}
          </span>
        )}
        {task.threadId && (
          <button
            className="thread-link"
            type="button"
            aria-label={`查看对话 ${task.threadId}`}
            title={`${RUNTIME_LABELS[task.runtime]} · 查看对话 ${task.threadId}`}
            onClick={stopThen(() => onOpenThread(task.threadId!, task))}
          >
            <RuntimeIcon runtime={task.runtime} />
          </button>
        )}
      </div>
    </article>
  );
}
