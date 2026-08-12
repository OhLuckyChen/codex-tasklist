import { useState, type KeyboardEvent, type MouseEvent, type RefObject } from "react";
import { assigneeTargetForActor } from "../actors";
import { labelColor } from "../labels";
import type { ActorIdentity, Task, TaskDraft, TaskPriority, TaskStatus } from "../types";
import { TASK_PRIORITIES, TASK_STATUSES } from "../types";
import type { TaskCardPresentation, TaskConversationItem } from "../taskConversations";
import { ActorAvatar } from "./ActorAvatar";
import { StatusIcon, STATUS_DETAILS } from "./BoardColumn";
import { LinearIcon, LinearPriorityIcon } from "./LinearIcon";
import { RuntimeIcon, RUNTIME_LABELS } from "./RuntimeIcon";

interface IssueListViewProps {
  scrollRef: RefObject<HTMLDivElement | null>;
  tasks: Task[];
  presentations: Record<string, TaskCardPresentation>;
  currentUser: ActorIdentity;
  hasActiveFilters: boolean;
  onOpenTask: (task: Task) => void;
  onOpenConversation: (task: Task, conversation: TaskConversationItem) => void;
  onUpdate: (task: Task, changes: Partial<TaskDraft>) => Promise<Task>;
}

const COLLAPSED_BY_DEFAULT = new Set<TaskStatus>(["backlog", "done", "canceled", "archived"]);
const PRIORITY_LABELS: Record<TaskPriority, string> = {
  none: "无",
  urgent: "紧急",
  high: "高",
  medium: "中",
  low: "低",
};

function createdDate(value: string) {
  return new Intl.DateTimeFormat("zh-CN", { month: "short", day: "numeric" }).format(new Date(value));
}

function calendarDate(value: string) {
  return new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric" })
    .format(new Date(`${value}T12:00:00`));
}

export function IssueListView({
  scrollRef,
  tasks,
  presentations,
  currentUser,
  hasActiveFilters,
  onOpenTask,
  onOpenConversation,
  onUpdate,
}: IssueListViewProps) {
  const [collapsed, setCollapsed] = useState(() => new Set(COLLAPSED_BY_DEFAULT));

  function stopRow(event: MouseEvent | KeyboardEvent) {
    event.stopPropagation();
  }

  function toggleStatus(status: TaskStatus) {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(status)) next.delete(status);
      else next.add(status);
      return next;
    });
  }

  return (
    <div className="issue-list-view" ref={scrollRef}>
      {TASK_STATUSES.map((status) => {
        const statusTasks = tasks.filter((task) => task.status === status);
        const isCollapsed = collapsed.has(status);
        return (
          <section className={`issue-list-group status-${status}`} key={status}>
            <button className="issue-list-group-header" type="button" onClick={() => toggleStatus(status)} aria-expanded={!isCollapsed}>
              <LinearIcon name={isCollapsed ? "chevronRight" : "chevronDown"} />
              <span><StatusIcon status={status} /></span>
              <strong>{STATUS_DETAILS[status].label}</strong>
              <b>{statusTasks.length}</b>
            </button>
            {!isCollapsed && (
              <div className="issue-list-rows">
                {statusTasks.length ? statusTasks.map((task) => {
                  const assigneeTarget = assigneeTargetForActor(task.assignee, currentUser) ?? "current-user";
                  const conversations = presentations[task.id]?.conversations ?? [];
                  return (
                    <div
                      className={`issue-list-row${presentations[task.id]?.unread ? " is-unread" : ""}`}
                      role="button"
                      tabIndex={0}
                      onClick={() => onOpenTask(task)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" || event.key === " ") onOpenTask(task);
                      }}
                      key={task.id}
                    >
                      <span className="issue-list-title">
                        <small>{task.identifier}</small>
                        <strong>{task.title}</strong>
                        {presentations[task.id]?.unread && <i className="task-unread-dot" aria-label="有未读更新" />}
                      </span>
                      <span className="issue-list-meta" onClick={stopRow} onKeyDown={stopRow}>
                        <select
                          className={`issue-list-priority priority-${task.priority}`}
                          aria-label={`${task.identifier} 优先级`}
                          value={task.priority}
                          onChange={(event) => void onUpdate(task, { priority: event.target.value as TaskPriority }).catch(() => {})}
                        >
                          {TASK_PRIORITIES.map((priority) => (
                            <option value={priority} key={priority}>{PRIORITY_LABELS[priority]}</option>
                          ))}
                        </select>
                        <span className={`issue-list-priority-icon priority-${task.priority}`} aria-hidden="true">
                          <LinearPriorityIcon priority={task.priority} />
                        </span>
                        <span className="issue-list-labels">
                          {task.labels.slice(0, 2).map((label) => {
                            return <i style={{ borderColor: labelColor(label) }} key={label}>{label}</i>;
                          })}
                          {task.labels.length > 2 && <b>+{task.labels.length - 2}</b>}
                        </span>
                        {task.dueDate && (
                          <label className="issue-list-date">
                            <LinearIcon name="calendar" />
                            <span>{calendarDate(task.dueDate)}</span>
                            <input
                              type="date"
                              aria-label={`${task.identifier} 截止日期`}
                              value={task.dueDate}
                              onChange={(event) => void onUpdate(task, {
                                dueDate: event.target.value || null,
                                ...(event.target.value ? {} : { recurrence: null }),
                              }).catch(() => {})}
                            />
                          </label>
                        )}
                        {conversations[0]?.nativeThreadId && (
                          <button
                            type="button"
                            className="issue-list-thread"
                            aria-label={`打开 ${task.identifier} ${RUNTIME_LABELS[conversations[0].runtime]} 对话`}
                            title={RUNTIME_LABELS[conversations[0].runtime]}
                            onClick={() => onOpenConversation(task, conversations[0])}
                          >
                            <RuntimeIcon runtime={conversations[0].runtime} />
                          </button>
                        )}
                        <label className="issue-list-assignee" title={task.assignee.name}>
                          <ActorAvatar actor={task.assignee} />
                          <select
                            aria-label={`${task.identifier} 负责人`}
                            value={assigneeTarget}
                            onChange={(event) => void onUpdate(task, { assigneeTarget: event.target.value as "current-user" | "codex-agent" }).catch(() => {})}
                          >
                            <option value="current-user">{currentUser.name}</option>
                            <option value="codex-agent">Codex Agent</option>
                          </select>
                        </label>
                      </span>
                      <time dateTime={task.createdAt} title={`创建于 ${new Date(task.createdAt).toLocaleString("zh-CN")}`}>
                        {createdDate(task.createdAt)}
                      </time>
                    </div>
                  );
                }) : (
                  <div className="issue-list-empty">
                    {hasActiveFilters ? "当前筛选下没有匹配议题" : `没有${STATUS_DETAILS[status].label}议题`}
                  </div>
                )}
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}
