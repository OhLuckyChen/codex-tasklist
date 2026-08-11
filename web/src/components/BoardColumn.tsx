import { useEffect, useState } from "react";
import type { DragEvent } from "react";
import type { Task, TaskStatus } from "../types";
import { ColumnVisibilityMenu } from "./ColumnVisibilityMenu";
import { LinearIcon, LinearStatusIcon } from "./LinearIcon";
import { TaskCard } from "./TaskCard";

export const STATUS_DETAILS: Record<
  TaskStatus,
  { label: string; tone: string }
> = {
  backlog: { label: "积压事项", tone: "backlog" },
  todo: { label: "待办事项", tone: "todo" },
  in_progress: { label: "进行中", tone: "progress" },
  in_review: { label: "审核中", tone: "review" },
  blocked: { label: "已阻塞", tone: "blocked" },
  done: { label: "完成", tone: "done" },
  canceled: { label: "已取消", tone: "canceled" },
  archived: { label: "归档", tone: "archived" },
};

export function StatusIcon({ status }: { status: TaskStatus }) {
  return <LinearStatusIcon status={status} />;
}

interface BoardColumnProps {
  status: TaskStatus;
  statusIndex: number;
  tasks: Task[];
  projectNames?: Record<string, string>;
  isDropTarget: boolean;
  isColumnDragging: boolean;
  columnDropPosition: "before" | "after" | null;
  draggedTaskId: string | null;
  draggedTaskHeight: number;
  movingTaskId: string | null;
  settlingTaskId: string | null;
  contextMenuTaskId: string | null;
  favoriteTaskIds: Set<string>;
  onCreate: (status: TaskStatus) => void;
  onEdit: (task: Task) => void;
  onToggleFavorite: (task: Task) => void;
  onContextMenu: (task: Task, position: { x: number; y: number }) => void;
  onMove: (task: Task, status: TaskStatus) => void;
  onDragStart: (task: Task, height: number) => void;
  onDragEnd: () => void;
  onDragEnter: (status: TaskStatus) => void;
  onDrop: (status: TaskStatus, taskId: string, beforeTaskId: string | null) => void;
  onColumnDragStart: (status: TaskStatus) => void;
  onColumnDragOver: (status: TaskStatus, position: "before" | "after") => void;
  onColumnDrop: (source: TaskStatus, target: TaskStatus, position: "before" | "after") => void;
  onColumnDragEnd: () => void;
  onOpenThread: (threadId: string) => void;
  onHide: (status: TaskStatus) => void;
}

export function BoardColumn({
  status,
  statusIndex,
  tasks,
  projectNames,
  isDropTarget,
  isColumnDragging,
  columnDropPosition,
  draggedTaskId,
  draggedTaskHeight,
  movingTaskId,
  settlingTaskId,
  contextMenuTaskId,
  favoriteTaskIds,
  onCreate,
  onEdit,
  onToggleFavorite,
  onContextMenu,
  onMove,
  onDragStart,
  onDragEnd,
  onDragEnter,
  onDrop,
  onColumnDragStart,
  onColumnDragOver,
  onColumnDrop,
  onColumnDragEnd,
  onOpenThread,
  onHide,
}: BoardColumnProps) {
  const details = STATUS_DETAILS[status];
  const [dropBeforeTaskId, setDropBeforeTaskId] = useState<string | null | undefined>();
  const taskIndexes = new Map(tasks.map((task, index) => [task.id, index]));
  const remainingTasks = tasks.filter((task) => task.id !== draggedTaskId);
  const remainingIndexes = new Map(remainingTasks.map((task, index) => [task.id, index]));
  const draggedTaskIndex = draggedTaskId ? taskIndexes.get(draggedTaskId) ?? -1 : -1;
  const beforeIndex = dropBeforeTaskId
    ? remainingIndexes.get(dropBeforeTaskId) ?? remainingTasks.length
    : remainingTasks.length;
  const previewIndex = isDropTarget && dropBeforeTaskId !== undefined ? beforeIndex : -1;
  const dragDistance = draggedTaskHeight + 8;

  useEffect(() => {
    if (!isDropTarget || !draggedTaskId) setDropBeforeTaskId(undefined);
  }, [draggedTaskId, isDropTarget]);

  function findDropBefore(container: HTMLElement, clientY: number): string | null {
    const cards = Array.from(container.querySelectorAll<HTMLElement>("[data-task-id]"))
      .filter((card) => card.dataset.taskId !== draggedTaskId);
    return cards.find((card) => clientY < card.getBoundingClientRect().top + card.offsetHeight / 2)
      ?.dataset.taskId ?? null;
  }

  function handleDrop(event: DragEvent<HTMLElement>) {
    event.preventDefault();
    const sourceStatus = event.dataTransfer.getData("application/x-taskboard-column") as TaskStatus;
    if (sourceStatus) {
      const bounds = event.currentTarget.getBoundingClientRect();
      onColumnDrop(
        sourceStatus,
        status,
        event.clientX < bounds.left + bounds.width / 2 ? "before" : "after",
      );
      return;
    }
    const taskId =
      event.dataTransfer.getData("application/x-taskboard-task") ||
      event.dataTransfer.getData("text/plain");
    if (taskId) onDrop(status, taskId, findDropBefore(event.currentTarget, event.clientY));
    setDropBeforeTaskId(undefined);
  }

  function getTaskDragShift(task: Task): number {
    if (!draggedTaskId || task.id === draggedTaskId) return 0;
    let shift = 0;
    const taskIndex = taskIndexes.get(task.id) ?? -1;
    const remainingIndex = remainingIndexes.get(task.id) ?? -1;

    if (draggedTaskIndex >= 0 && taskIndex > draggedTaskIndex) shift -= dragDistance;
    if (previewIndex >= 0 && remainingIndex >= previewIndex) shift += dragDistance;
    return shift;
  }

  return (
    <section
      className={`board-column status-${status}${isDropTarget ? " is-drop-target" : ""}${isColumnDragging ? " is-column-dragging" : ""}${columnDropPosition ? ` is-column-drop-${columnDropPosition}` : ""}`}
      data-column-status={status}
      aria-labelledby={`column-${status}`}
      onDragEnter={(event) => {
        if (event.dataTransfer.types.includes("application/x-taskboard-column")) return;
        onDragEnter(status);
      }}
      onDragOver={(event) => {
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        if (event.dataTransfer.types.includes("application/x-taskboard-column")) {
          const bounds = event.currentTarget.getBoundingClientRect();
          onColumnDragOver(status, event.clientX < bounds.left + bounds.width / 2 ? "before" : "after");
          return;
        }
        onDragEnter(status);
        setDropBeforeTaskId(findDropBefore(event.currentTarget, event.clientY));
      }}
      onDragLeave={(event) => {
        if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) {
          setDropBeforeTaskId(undefined);
        }
      }}
      onDrop={handleDrop}
    >
      <header
        className="column-header"
        draggable
        title={`拖动调整${details.label}列的位置`}
        onDragStart={(event) => {
          if (event.target instanceof Element && event.target.closest("button")) {
            event.preventDefault();
            return;
          }
          event.dataTransfer.effectAllowed = "move";
          event.dataTransfer.setData("application/x-taskboard-column", status);
          event.dataTransfer.setData("text/plain", status);
          onColumnDragStart(status);
        }}
        onDragEnd={onColumnDragEnd}
      >
        <div className="column-heading">
          <span className={`status-icon status-icon-${details.tone}`}>
            <StatusIcon status={status} />
          </span>
          <h2 id={`column-${status}`}>{details.label}</h2>
          <span className="task-count" aria-label={`${tasks.length} 个议题`}>{tasks.length}</span>
        </div>
        <div className="column-actions">
          <ColumnVisibilityMenu
            label={details.label}
            action="hide"
            className="icon-button column-menu"
            onAction={() => onHide(status)}
          />
          <button
            type="button"
            className="icon-button add-task-button"
            onClick={() => onCreate(status)}
            aria-label={`在${details.label}中新建议题`}
            title={`添加到${details.label}`}
          >
            <LinearIcon name="plus" />
          </button>
        </div>
      </header>

      <div className="column-list">
        {tasks.map((task) => {
          const dragShift = getTaskDragShift(task);
          return (
            <TaskCard
              key={task.id}
              task={task}
              projectName={projectNames?.[task.projectId]}
              statusIndex={statusIndex}
              isDragging={draggedTaskId === task.id}
              dragShift={dragShift}
              isMoving={movingTaskId === task.id}
              isSettling={settlingTaskId === task.id}
              isContextMenuOpen={contextMenuTaskId === task.id}
              isFavorite={favoriteTaskIds.has(task.id)}
              onEdit={onEdit}
              onToggleFavorite={onToggleFavorite}
              onContextMenu={onContextMenu}
              onMove={onMove}
              onDragStart={onDragStart}
              onDragEnd={onDragEnd}
              onOpenThread={onOpenThread}
            />
          );
        })}
      </div>
    </section>
  );
}
