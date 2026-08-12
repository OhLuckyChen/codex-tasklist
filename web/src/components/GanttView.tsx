import { useEffect, useMemo, useRef, useState } from "react";
import { Gantt, type GanttStatic, type Task as GanttTask } from "dhtmlx-gantt";
import "dhtmlx-gantt/codebase/dhtmlxgantt.css";
import type { Task, TaskDraft, TaskStatus } from "../types";
import type { TaskCardPresentation } from "../taskConversations";
import { LinearIcon } from "./LinearIcon";

export type GanttZoom = "day" | "week" | "month";

interface GanttViewProps {
  tasks: Task[];
  presentations: Record<string, TaskCardPresentation>;
  hasActiveFilters: boolean;
  zoom: GanttZoom;
  hideCompleted: boolean;
  todayRequest: number;
  onOpenTask: (task: Task) => void;
  onUpdate: (task: Task, changes: Partial<TaskDraft>) => Promise<Task>;
}

interface TaskboardGanttTask extends GanttTask {
  taskboardStatus: TaskStatus;
  taskboardTitle: string;
  taskboardUnread: boolean;
  taskboardGroup: boolean;
  taskboardCount: number;
}

const GROUPS: Array<{ id: string; label: string; statuses: TaskStatus[]; defaultOpen: boolean }> = [
  { id: "in-progress", label: "进行中", statuses: ["in_progress"], defaultOpen: true },
  { id: "in-review", label: "审核中", statuses: ["in_review"], defaultOpen: true },
  { id: "blocked", label: "已阻塞", statuses: ["blocked"], defaultOpen: true },
  { id: "todo", label: "待处理", statuses: ["backlog", "todo"], defaultOpen: true },
  { id: "done", label: "已完成", statuses: ["done"], defaultOpen: false },
  { id: "canceled", label: "已取消", statuses: ["canceled", "archived"], defaultOpen: false },
];

function localDate(value: string) {
  return new Date(`${value}T00:00:00`);
}

function addDays(value: Date, days: number) {
  const next = new Date(value);
  next.setDate(next.getDate() + days);
  return next;
}

function dateValue(value: Date) {
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`;
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;",
  }[character]!));
}

function dateCellClass(date: Date) {
  const today = new Date();
  const classes: string[] = [];
  if (date.getDay() === 0 || date.getDay() === 6) classes.push("is-weekend");
  if (
    date.getFullYear() === today.getFullYear()
    && date.getMonth() === today.getMonth()
    && date.getDate() === today.getDate()
  ) classes.push("is-today");
  return classes.join(" ");
}

function taskProgress(task: Task, presentation: TaskCardPresentation | undefined) {
  const processing = presentation?.processing;
  if (processing?.total) return Math.min(1, (processing.completed ?? 0) / processing.total);
  if (task.status === "in_review" || task.status === "done") return 1;
  return 0;
}

export function GanttView({ tasks, presentations, hasActiveFilters, zoom, hideCompleted, todayRequest, onOpenTask, onUpdate }: GanttViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const ganttRef = useRef<GanttStatic | null>(null);
  const tasksRef = useRef(tasks);
  const onOpenTaskRef = useRef(onOpenTask);
  const onUpdateRef = useRef(onUpdate);
  const hasParsedRef = useRef(false);
  const [gridCollapsed, setGridCollapsed] = useState(false);
  const [gridWidth, setGridWidth] = useState(340);
  const [todayMarkerLeft, setTodayMarkerLeft] = useState<number | null>(null);
  const gridCollapsedRef = useRef(false);
  const expandedGridWidthRef = useRef(340);
  tasksRef.current = tasks;
  onOpenTaskRef.current = onOpenTask;
  onUpdateRef.current = onUpdate;

  const visibleTasks = useMemo(
    () => hideCompleted ? tasks.filter((task) => task.status !== "done" && task.status !== "canceled" && task.status !== "archived") : tasks,
    [hideCompleted, tasks],
  );

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const instance = Gantt.getGanttInstance();
    ganttRef.current = instance;
    instance.config.date_format = "%Y-%m-%d";
    instance.config.xml_date = "%Y-%m-%d";
    instance.config.row_height = 52;
    instance.config.bar_height = 34;
    instance.config.scale_height = 60;
    instance.config.grid_width = 340;
    instance.config.min_column_width = 38;
    instance.config.drag_progress = false;
    instance.config.drag_links = false;
    instance.config.show_progress = true;
    instance.config.show_unscheduled = true;
    instance.config.details_on_dblclick = false;
    instance.config.round_dnd_dates = true;
    instance.config.select_task = false;
    instance.config.columns = [{
      name: "text",
      label: "议题",
      tree: true,
      width: "*",
      min_width: 190,
      template: (item) => {
        const task = item as TaskboardGanttTask;
        if (task.taskboardGroup) {
          return `<div class="gantt-grid-group"><strong>${escapeHtml(task.taskboardTitle)}</strong><span>${task.taskboardCount}</span></div>`;
        }
        return `<div class="gantt-grid-issue"><strong>${escapeHtml(task.taskboardTitle)}</strong>${task.taskboardUnread ? `<i class="task-unread-dot" aria-label="有未读更新"></i>` : ""}</div>`;
      },
    }];
    instance.templates.grid_folder = () => "";
    instance.templates.grid_file = () => "";
    instance.templates.grid_blank = () => "";
    instance.templates.task_class = (_start, _end, item) => {
      const task = item as TaskboardGanttTask;
      return task.taskboardGroup ? "gantt-group-task" : `gantt-status-${task.taskboardStatus}`;
    };
    instance.templates.task_text = (start, end, item) => {
      const task = item as TaskboardGanttTask;
      if (task.taskboardGroup) return "";
      const displayEnd = addDays(end, -1);
      const format = new Intl.DateTimeFormat("zh-CN", { month: "short", day: "numeric" });
      return `<span class="gantt-bar-content"><strong>${escapeHtml(task.taskboardTitle)}</strong><small>${format.format(start)} - ${format.format(displayEnd)}</small></span>`;
    };
    const rowClass = (item: GanttTask) => {
      const task = item as TaskboardGanttTask;
      if (task.taskboardGroup) return `is-group gantt-status-${task.taskboardStatus}`;
      return `gantt-status-${task.taskboardStatus}${task.taskboardUnread ? " is-unread" : ""}`;
    };
    instance.templates.grid_row_class = (_start, _end, item) => rowClass(item);
    instance.templates.task_row_class = (_start, _end, item) => rowClass(item);
    instance.templates.scale_cell_class = dateCellClass;
    instance.templates.timeline_cell_class = (_item, date) => dateCellClass(date);
    const monthFormat = (date: Date) => new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "long" }).format(date);
    const dayFormat = (date: Date) => `<span class="gantt-scale-date"><span>${date.getDate()}</span></span>`;
    instance.ext.zoom.init({
      levels: [
        { name: "day", scale_height: 60, min_column_width: 56, scales: [{ unit: "month", step: 1, format: monthFormat }, { unit: "day", step: 1, format: dayFormat, css: dateCellClass }] },
        { name: "week", scale_height: 60, min_column_width: 38, scales: [{ unit: "month", step: 1, format: monthFormat }, { unit: "day", step: 1, format: dayFormat, css: dateCellClass }] },
        { name: "month", scale_height: 60, min_column_width: 76, scales: [{ unit: "year", step: 1, format: (date: Date) => `${date.getFullYear()}` }, { unit: "month", step: 1, format: (date: Date) => new Intl.DateTimeFormat("zh-CN", { month: "short" }).format(date) }] },
      ],
    });
    instance.ext.zoom.setLevel(zoom);
    const updateTodayMarker = () => {
      if (!containerRef.current) return;
      const gridOffset = instance.config.show_grid === false ? 0 : Number(instance.config.grid_width);
      const left = gridOffset + instance.posFromDate(localDate(dateValue(new Date()))) - instance.getScrollState().x;
      setTodayMarkerLeft(left >= gridOffset && left <= containerRef.current.clientWidth ? left : null);
    };
    instance.attachEvent("onGanttScroll", updateTodayMarker);
    instance.attachEvent("onGanttRender", updateTodayMarker);
    instance.attachEvent("onAfterTaskUpdate", (id, item) => {
      const ganttTask = item as TaskboardGanttTask;
      const task = tasksRef.current.find((candidate) => candidate.id === String(id));
      if (!task || ganttTask.taskboardGroup || item.unscheduled) return true;
      const startDate = dateValue(item.start_date as Date);
      const dueDate = dateValue(addDays(item.end_date as Date, -1));
      if (task.startDate === startDate && task.dueDate === dueDate) return true;
      void onUpdateRef.current(task, { startDate, dueDate }).catch(() => {});
      return true;
    });
    instance.attachEvent("onTaskDblClick", (id) => {
      const task = tasksRef.current.find((candidate) => candidate.id === String(id));
      if (task) onOpenTaskRef.current(task);
      return false;
    });
    instance.init(container);
    const resizeObserver = new ResizeObserver(([entry]) => {
      const nextGridWidth = Math.round(Math.max(280, Math.min(440, entry.contentRect.width * 0.3)));
      expandedGridWidthRef.current = nextGridWidth;
      setGridWidth(nextGridWidth);
      if (!gridCollapsedRef.current) instance.config.grid_width = nextGridWidth;
      instance.setSizes();
    });
    resizeObserver.observe(container);
    return () => {
      resizeObserver.disconnect();
      ganttRef.current = null;
      instance.destructor();
    };
  }, []);

  useEffect(() => {
    const instance = ganttRef.current;
    if (!instance) return;
    const data: TaskboardGanttTask[] = [];
    const groupOpenState = new Map<string, boolean>();
    for (const group of GROUPS) {
      const groupId = `gantt-group-${group.id}`;
      if (instance.isTaskExists(groupId)) {
        groupOpenState.set(groupId, Boolean((instance.getTask(groupId) as TaskboardGanttTask & { $open?: boolean }).$open));
      }
    }
    for (const group of GROUPS) {
      const groupId = `gantt-group-${group.id}`;
      const groupTasks = visibleTasks
        .filter((task) => group.statuses.includes(task.status))
        .sort((left, right) => Number(Boolean(right.startDate && right.dueDate)) - Number(Boolean(left.startDate && left.dueDate)) || left.sortOrder - right.sortOrder);
      if (!groupTasks.length) continue;
      const progress = groupTasks.reduce((sum, task) => sum + taskProgress(task, presentations[task.id]), 0) / groupTasks.length;
      data.push({
        id: groupId,
        text: group.label,
        type: "project",
        open: groupOpenState.get(groupId) ?? group.defaultOpen,
        readonly: true,
        unscheduled: true,
        progress,
        taskboardStatus: group.statuses[0],
        taskboardTitle: group.label,
        taskboardUnread: groupTasks.some((task) => presentations[task.id]?.unread),
        taskboardGroup: true,
        taskboardCount: groupTasks.length,
      } as TaskboardGanttTask);
      for (const task of groupTasks) {
        const isScheduled = Boolean(task.startDate && task.dueDate);
        data.push({
          id: task.id,
          parent: groupId,
          text: task.title,
          ...(isScheduled ? {
            start_date: localDate(task.startDate!),
            end_date: addDays(localDate(task.dueDate!), 1),
          } : { unscheduled: true }),
          progress: taskProgress(task, presentations[task.id]),
          taskboardStatus: task.status,
          taskboardTitle: task.title,
          taskboardUnread: presentations[task.id]?.unread ?? false,
          taskboardGroup: false,
          taskboardCount: 0,
        } as TaskboardGanttTask);
      }
    }
    const scheduledTasks = visibleTasks.filter((task) => task.startDate && task.dueDate);
    const today = localDate(dateValue(new Date()));
    const starts = scheduledTasks.map((task) => localDate(task.startDate!).getTime());
    const ends = scheduledTasks.map((task) => localDate(task.dueDate!).getTime());
    const rangeStart = new Date(Math.min(today.getTime(), ...starts));
    const rangeEnd = new Date(Math.max(today.getTime(), ...ends));
    const previousScroll = instance.getScrollState();
    const timelineWidth = containerRef.current?.querySelector<HTMLElement>(".gantt_task")?.clientWidth ?? 0;
    const anchorDate = hasParsedRef.current && timelineWidth
      ? instance.dateFromPos(previousScroll.x + timelineWidth / 2)
      : null;
    instance.config.start_date = addDays(rangeStart, -7);
    instance.config.end_date = addDays(rangeEnd, 8);
    instance.clearAll();
    instance.parse({ data });
    if (anchorDate) {
      instance.scrollTo(Math.max(0, instance.posFromDate(anchorDate) - timelineWidth / 2), previousScroll.y);
    } else if (starts.length) {
      instance.showDate(new Date(Math.min(...starts)));
    }
    hasParsedRef.current = true;
  }, [presentations, visibleTasks]);

  useEffect(() => {
    ganttRef.current?.ext.zoom.setLevel(zoom);
  }, [zoom]);

  useEffect(() => {
    if (todayRequest) ganttRef.current?.showDate(new Date());
  }, [todayRequest]);

  function toggleGrid() {
    const instance = ganttRef.current;
    if (!instance) return;
    const nextCollapsed = !gridCollapsedRef.current;
    const scroll = instance.getScrollState();
    gridCollapsedRef.current = nextCollapsed;
    setGridCollapsed(nextCollapsed);
    instance.config.show_grid = !nextCollapsed;
    instance.config.grid_width = nextCollapsed ? 0 : expandedGridWidthRef.current;
    instance.render();
    instance.scrollTo(scroll.x, scroll.y);
  }

  return (
    <div className="gantt-view">
      <div className="gantt-canvas-shell">
        <div className="gantt-canvas" ref={containerRef} />
        {todayMarkerLeft !== null && <div className="gantt-today-marker" style={{ left: todayMarkerLeft }}><span>今天</span></div>}
        <button
          type="button"
          className={`gantt-grid-toggle${gridCollapsed ? " is-collapsed" : ""}`}
          style={{ left: gridCollapsed ? 14 : gridWidth }}
          aria-label={gridCollapsed ? "展开标题区域" : "收起标题区域"}
          onClick={toggleGrid}
        >
          <LinearIcon name={gridCollapsed ? "chevronRight" : "chevronLeft"} />
        </button>
        {!visibleTasks.length && (
          <div className="gantt-empty-overlay">
            <LinearIcon name="calendar" />
            <span>{hasActiveFilters || hideCompleted ? "当前条件下没有议题" : "创建带开始/截止日期的议题后，可在这里安排时间线"}</span>
          </div>
        )}
      </div>
    </div>
  );
}
