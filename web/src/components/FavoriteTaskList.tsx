import { useMemo, useState } from "react";
import type { Task } from "../types";
import { ActorAvatar } from "./ActorAvatar";
import { STATUS_DETAILS } from "./BoardColumn";
import { LinearIcon, LinearStatusIcon } from "./LinearIcon";

const FAVORITE_PROJECT_ORDER_KEY = "taskboard.favoriteTaskProjectOrder.v1";
const FAVORITE_TASK_ORDER_KEY = "taskboard.favoriteTaskOrderByProject.v1";

function readStringList(key: string): string[] {
  try {
    const value = JSON.parse(window.localStorage.getItem(key) ?? "[]");
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function readTaskOrder(): Record<string, string[]> {
  try {
    const value = JSON.parse(window.localStorage.getItem(FAVORITE_TASK_ORDER_KEY) ?? "{}");
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).flatMap(([projectId, taskIds]) => (
      Array.isArray(taskIds)
        ? [[projectId, taskIds.filter((item): item is string => typeof item === "string")]]
        : []
    )));
  } catch {
    return {};
  }
}

function moveId(ids: string[], sourceId: string, targetId: string, after: boolean): string[] {
  if (sourceId === targetId) return ids;
  const next = ids.filter((id) => id !== sourceId);
  const targetIndex = next.indexOf(targetId);
  if (targetIndex < 0) return ids;
  next.splice(targetIndex + Number(after), 0, sourceId);
  return next;
}

function descriptionPreview(description: string): string {
  return description
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

interface FavoriteTaskListProps {
  tasks: Task[];
  projectNames: Record<string, string>;
  onOpenTask: (task: Task) => void;
  onToggleFavorite: (task: Task) => void;
}

export function FavoriteTaskList({
  tasks,
  projectNames,
  onOpenTask,
  onToggleFavorite,
}: FavoriteTaskListProps) {
  const [projectOrder, setProjectOrder] = useState(() => readStringList(FAVORITE_PROJECT_ORDER_KEY));
  const [taskOrderByProject, setTaskOrderByProject] = useState(readTaskOrder);
  const [draggedProjectId, setDraggedProjectId] = useState<string | null>(null);
  const [draggedTask, setDraggedTask] = useState<{ projectId: string; taskId: string } | null>(null);

  const groups = useMemo(() => {
    const tasksByProject = new Map<string, Task[]>();
    for (const task of tasks) {
      const current = tasksByProject.get(task.projectId) ?? [];
      current.push(task);
      tasksByProject.set(task.projectId, current);
    }
    const projectIndex = new Map(projectOrder.map((projectId, index) => [projectId, index]));
    return [...tasksByProject.entries()]
      .map(([projectId, projectTasks]) => {
        const taskIndex = new Map((taskOrderByProject[projectId] ?? []).map((taskId, index) => [taskId, index]));
        return {
          projectId,
          projectName: projectNames[projectId] ?? projectId,
          tasks: [...projectTasks].sort((left, right) => {
            const leftIndex = taskIndex.get(left.id);
            const rightIndex = taskIndex.get(right.id);
            if (leftIndex !== undefined || rightIndex !== undefined) {
              if (leftIndex === undefined) return 1;
              if (rightIndex === undefined) return -1;
              if (leftIndex !== rightIndex) return leftIndex - rightIndex;
            }
            return right.updatedAt.localeCompare(left.updatedAt);
          }),
        };
      })
      .sort((left, right) => {
        const leftIndex = projectIndex.get(left.projectId);
        const rightIndex = projectIndex.get(right.projectId);
        if (leftIndex !== undefined || rightIndex !== undefined) {
          if (leftIndex === undefined) return 1;
          if (rightIndex === undefined) return -1;
          if (leftIndex !== rightIndex) return leftIndex - rightIndex;
        }
        return left.projectName.localeCompare(right.projectName, "zh-CN");
      });
  }, [projectNames, projectOrder, taskOrderByProject, tasks]);

  function reorderProjects(sourceProjectId: string, targetProjectId: string, after: boolean) {
    if (sourceProjectId === targetProjectId) return;
    const visibleIds = groups.map((group) => group.projectId);
    const hiddenIds = projectOrder.filter((projectId) => !visibleIds.includes(projectId));
    const next = [...moveId(visibleIds, sourceProjectId, targetProjectId, after), ...hiddenIds];
    setProjectOrder(next);
    window.localStorage.setItem(FAVORITE_PROJECT_ORDER_KEY, JSON.stringify(next));
  }

  function reorderTasks(projectId: string, sourceTaskId: string, targetTaskId: string, after: boolean) {
    if (sourceTaskId === targetTaskId) return;
    const group = groups.find((candidate) => candidate.projectId === projectId);
    if (!group) return;
    const visibleIds = group.tasks.map((task) => task.id);
    const hiddenIds = (taskOrderByProject[projectId] ?? []).filter((taskId) => !visibleIds.includes(taskId));
    const nextOrder = [...moveId(visibleIds, sourceTaskId, targetTaskId, after), ...hiddenIds];
    setTaskOrderByProject((current) => {
      const next = { ...current, [projectId]: nextOrder };
      window.localStorage.setItem(FAVORITE_TASK_ORDER_KEY, JSON.stringify(next));
      return next;
    });
  }

  if (groups.length === 0) {
    return (
      <section className="page-empty favorite-list-empty" aria-label="收藏任务列表">
        <span className="empty-search" aria-hidden="true"><LinearIcon name="favorite" /></span>
        <h2>没有匹配的收藏任务</h2>
        <p>可以先收藏任务，或更换搜索词和筛选条件。</p>
      </section>
    );
  }

  return (
    <div className="favorite-list-scroll">
      <div className="favorite-list-view" aria-label="收藏任务列表">
        {groups.map((group) => (
          <section
            className={`favorite-project-group${draggedProjectId === group.projectId ? " is-dragging" : ""}`}
            key={group.projectId}
            data-favorite-project-id={group.projectId}
          >
            <header className="favorite-project-heading">
              <span
                className="favorite-drag-handle"
                role="button"
                tabIndex={0}
                aria-label={`拖动调整 ${group.projectName} 的顺序`}
                title={`拖动调整 ${group.projectName} 的顺序`}
                onPointerDown={(event) => {
                  event.preventDefault();
                  event.currentTarget.setPointerCapture(event.pointerId);
                  setDraggedProjectId(group.projectId);
                }}
                onPointerMove={(event) => {
                  if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
                  const target = document.elementFromPoint(event.clientX, event.clientY)
                    ?.closest<HTMLElement>(".favorite-project-group");
                  const targetProjectId = target?.dataset.favoriteProjectId;
                  if (!target || !targetProjectId || targetProjectId === group.projectId) return;
                  const bounds = target.getBoundingClientRect();
                  reorderProjects(group.projectId, targetProjectId, event.clientY >= bounds.top + bounds.height / 2);
                }}
                onPointerUp={(event) => {
                  if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                    event.currentTarget.releasePointerCapture(event.pointerId);
                  }
                  setDraggedProjectId(null);
                }}
                onPointerCancel={() => setDraggedProjectId(null)}
                onKeyDown={(event) => {
                  if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
                  const currentIndex = groups.findIndex((candidate) => candidate.projectId === group.projectId);
                  const targetIndex = event.key === "ArrowUp" ? currentIndex - 1 : currentIndex + 1;
                  const target = groups[targetIndex];
                  if (!target) return;
                  event.preventDefault();
                  reorderProjects(group.projectId, target.projectId, event.key === "ArrowDown");
                }}
              />
              <span className="favorite-project-avatar" aria-hidden="true">
                {group.projectName.slice(0, 1).toUpperCase()}
              </span>
              <h2>{group.projectName}</h2>
              <span>{group.tasks.length} 个收藏任务</span>
              <small>拖动项目调整顺序</small>
            </header>

            <div className="favorite-task-grid">
              {group.tasks.map((task) => {
                const preview = descriptionPreview(task.description);
                return (
                  <article
                    className={`favorite-task-list-card${draggedTask?.taskId === task.id ? " is-dragging" : ""}`}
                    key={task.id}
                    data-favorite-task-id={task.id}
                  >
                    <button
                      className="favorite-task-open"
                      type="button"
                      aria-label={`打开 ${task.identifier}: ${task.title}`}
                      onClick={() => onOpenTask(task)}
                    />
                    <div className="favorite-task-card-topline">
                      <span
                        className="favorite-drag-handle"
                        role="button"
                        tabIndex={0}
                        aria-label={`拖动调整 ${task.identifier} 的顺序`}
                        title={`拖动调整 ${task.identifier} 的顺序`}
                        onPointerDown={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                          event.currentTarget.setPointerCapture(event.pointerId);
                          setDraggedTask({ projectId: group.projectId, taskId: task.id });
                        }}
                        onPointerMove={(event) => {
                          if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
                          const target = document.elementFromPoint(event.clientX, event.clientY)
                            ?.closest<HTMLElement>(".favorite-task-list-card");
                          const targetTaskId = target?.dataset.favoriteTaskId;
                          const targetProjectId = target
                            ?.closest<HTMLElement>(".favorite-project-group")
                            ?.dataset.favoriteProjectId;
                          if (
                            !target
                            || !targetTaskId
                            || targetProjectId !== group.projectId
                            || targetTaskId === task.id
                          ) return;
                          const bounds = target.getBoundingClientRect();
                          reorderTasks(
                            group.projectId,
                            task.id,
                            targetTaskId,
                            event.clientX >= bounds.left + bounds.width / 2,
                          );
                        }}
                        onPointerUp={(event) => {
                          if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                            event.currentTarget.releasePointerCapture(event.pointerId);
                          }
                          setDraggedTask(null);
                        }}
                        onPointerCancel={() => setDraggedTask(null)}
                        onKeyDown={(event) => {
                          if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
                          const currentIndex = group.tasks.findIndex((candidate) => candidate.id === task.id);
                          const moveBackward = event.key === "ArrowLeft" || event.key === "ArrowUp";
                          const targetIndex = moveBackward ? currentIndex - 1 : currentIndex + 1;
                          const target = group.tasks[targetIndex];
                          if (!target) return;
                          event.preventDefault();
                          reorderTasks(group.projectId, task.id, target.id, !moveBackward);
                        }}
                      />
                      <span className={`status-icon status-icon-${STATUS_DETAILS[task.status].tone}`}>
                        <LinearStatusIcon status={task.status} />
                      </span>
                      <span>{STATUS_DETAILS[task.status].label}</span>
                      <span className="favorite-task-identifier">{task.identifier}</span>
                      <ActorAvatar actor={task.assignee} className="favorite-task-assignee" />
                    </div>
                    <h3>{task.title}</h3>
                    {preview && <p>{preview}</p>}
                    <footer>
                      <span>{task.labels.slice(0, 2).join(" · ") || "无标签"}</span>
                      <button
                        type="button"
                        aria-label={`取消收藏 ${task.identifier}`}
                        title="取消收藏"
                        onClick={(event) => {
                          event.stopPropagation();
                          onToggleFavorite(task);
                        }}
                      >
                        <LinearIcon name="favorite" />
                      </button>
                      <LinearIcon name="chevronRight" />
                    </footer>
                  </article>
                );
              })}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
