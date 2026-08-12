import { useMemo } from "react";
import { labelColor } from "../labels";
import type { ActorIdentity, Task, TaskPriority, TaskStatus } from "../types";
import type { TaskCardPresentation } from "../taskConversations";
import { ActorAvatar } from "./ActorAvatar";
import { LinearIcon, LinearPriorityIcon } from "./LinearIcon";
import { STATUS_DETAILS } from "./BoardColumn";
import { RuntimeIcon, RUNTIME_LABELS } from "./RuntimeIcon";

interface DashboardViewProps {
  projectCreatedAt: string | null;
  tasks: Task[];
  presentations: Record<string, TaskCardPresentation>;
  currentUser: ActorIdentity;
  onOpenTask: (task: Task) => void;
  onOpenThread: (threadId: string, task: Task) => void;
}

const PRIORITIES: TaskPriority[] = ["urgent", "high", "medium", "low", "none"];
const ACTIVE_STATUSES = new Set<TaskStatus>(["backlog", "todo", "in_progress", "in_review", "blocked"]);

function dayValue(value: string) {
  return new Date(`${value}T00:00:00`).getTime();
}

function shortDate(value: string) {
  return new Intl.DateTimeFormat("zh-CN", { month: "short", day: "numeric" })
    .format(new Date(`${value}T12:00:00`));
}

function dateKey(value: Date) {
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`;
}

function statusCount(tasks: Task[], status: TaskStatus) {
  return tasks.filter((task) => task.status === status).length;
}

export function DashboardView({
  projectCreatedAt,
  tasks,
  presentations,
  currentUser,
  onOpenTask,
  onOpenThread,
}: DashboardViewProps) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayValue = today.getTime();
  const activeTasks = tasks.filter((task) => ACTIVE_STATUSES.has(task.status));
  const completedTasks = tasks.filter((task) => task.status === "done");
  const completionRate = tasks.length ? Math.round((completedTasks.length / tasks.length) * 100) : 0;
  const overdueTasks = activeTasks.filter((task) => task.dueDate && dayValue(task.dueDate) < todayValue);
  const upcomingTasks = activeTasks
    .filter((task) => task.dueDate && dayValue(task.dueDate) <= todayValue + 14 * 86_400_000)
    .sort((left, right) => (left.dueDate ?? "").localeCompare(right.dueDate ?? ""))
    .slice(0, 6);
  const runningTasks = tasks
    .filter((task) => presentations[task.id]?.processing.running)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, 5);
  const attentionTasks = activeTasks
    .filter((task) => task.status === "blocked" || presentations[task.id]?.unread)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, 6);

  const priorityCounts = PRIORITIES.map((priority) => ({
    priority,
    count: tasks.filter((task) => task.priority === priority).length,
  }));

  const labelCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const task of tasks) {
      for (const label of task.labels) counts.set(label, (counts.get(label) ?? 0) + 1);
    }
    return [...counts.entries()]
      .map(([label, count]) => ({ label, count, color: labelColor(label) }))
      .sort((left, right) => right.count - left.count || left.label.localeCompare(right.label))
      .slice(0, 10);
  }, [tasks]);

  const roleContributions = useMemo(() => {
    const counts = new Map<string, { actor: Task["assignee"]; done: number; total: number }>();
    for (const task of tasks) {
      const key = `${task.assignee.type}:${task.assignee.id}`;
      const item = counts.get(key) ?? { actor: task.assignee, done: 0, total: 0 };
      item.total += 1;
      if (task.status === "done") item.done += 1;
      counts.set(key, item);
    }
    return [...counts.values()].sort((left, right) => right.done - left.done || right.total - left.total);
  }, [tasks]);

  const activityDays = useMemo(() => {
    const counts = new Map<string, number>();
    for (const task of tasks) {
      const key = dateKey(new Date(task.statusChangedAt || task.updatedAt || task.createdAt));
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    const start = new Date(todayValue);
    start.setDate(start.getDate() - 83);
    return Array.from({ length: 84 }, (_, index) => {
      const date = new Date(start);
      date.setDate(date.getDate() + index);
      const key = dateKey(date);
      return { key, count: counts.get(key) ?? 0, future: date.getTime() > todayValue };
    });
  }, [tasks, todayValue]);
  const maxActivity = Math.max(1, ...activityDays.map((day) => day.count));
  const projectAgeDays = projectCreatedAt
    ? Math.max(1, Math.ceil((todayValue - new Date(projectCreatedAt).getTime()) / 86_400_000))
    : null;

  return (
    <div className="dashboard-view">
      <section className="dashboard-hero">
        <div>
          <span className="dashboard-kicker">项目完成度</span>
          <h2>{completionRate}%</h2>
          <p>{completedTasks.length} 个已完成，{activeTasks.length} 个尚未结束</p>
        </div>
        <div className="dashboard-summary-bubble">
          <img src="codex-agent-logo.png" alt="" aria-hidden="true" />
          <p>
            {currentUser.name}，当前项目共有 {tasks.length} 个议题
            {projectAgeDays ? `，已运行 ${projectAgeDays} 天` : ""}。
            {overdueTasks.length ? ` ${overdueTasks.length} 个议题已逾期，建议优先处理。` : " 暂无逾期议题。"}
            项目 AI 总结服务未在本地 release/qa 启用，本视图先展示实时统计。
          </p>
        </div>
      </section>

      <section className="dashboard-metrics">
        {(["in_progress", "in_review", "blocked", "backlog", "done"] as TaskStatus[]).map((status) => (
          <article className={`dashboard-metric status-${status}`} key={status}>
            <span>{STATUS_DETAILS[status].label}</span>
            <strong>{statusCount(tasks, status)}</strong>
          </article>
        ))}
      </section>

      <div className="dashboard-grid">
        <section className="dashboard-panel dashboard-priority-panel">
          <header>优先级分布</header>
          <div className="dashboard-priority-list">
            {priorityCounts.map((item) => (
              <div className={`dashboard-priority-row priority-${item.priority}`} key={item.priority}>
                <span><LinearPriorityIcon priority={item.priority} />{item.priority === "none" ? "无" : item.priority}</span>
                <i><b style={{ width: `${tasks.length ? (item.count / tasks.length) * 100 : 0}%` }} /></i>
                <strong>{item.count}</strong>
              </div>
            ))}
          </div>
        </section>

        <section className="dashboard-panel">
          <header>需要关注</header>
          <div className="dashboard-task-list">
            {attentionTasks.length ? attentionTasks.map((task) => (
              <button type="button" className="dashboard-task-row" onClick={() => onOpenTask(task)} key={task.id}>
                <LinearIcon name={task.status === "blocked" ? "alert" : "conversation"} />
                <span><strong>{task.title}</strong><small>{task.identifier}</small></span>
              </button>
            )) : <div className="dashboard-empty">当前没有阻塞或未读议题</div>}
          </div>
        </section>

        <section className="dashboard-panel">
          <header>运行中对话</header>
          <div className="dashboard-task-list">
            {runningTasks.length ? runningTasks.map((task) => {
              const progress = presentations[task.id]?.processing;
              return (
                <article className="dashboard-running-card" key={task.id}>
                  <button type="button" onClick={() => onOpenTask(task)}>
                    <small>{task.identifier}</small>
                    <strong>{task.title}</strong>
                  </button>
                  {progress?.total ? (
                    <div className="task-progress-segments is-running">
                      {Array.from({ length: progress.total }, (_, index) => (
                        <span className={index < (progress.completed ?? 0) ? "is-complete" : ""} key={index} />
                      ))}
                    </div>
                  ) : null}
                  {task.threadId && (
                    <button
                      type="button"
                      className="dashboard-thread-link"
                      title={`${RUNTIME_LABELS[task.runtime]} · 打开对话`}
                      onClick={() => onOpenThread(task.threadId!, task)}
                    >
                      <RuntimeIcon runtime={task.runtime} />打开对话
                    </button>
                  )}
                </article>
              );
            }) : <div className="dashboard-empty">当前没有运行中的对话</div>}
          </div>
        </section>

        <section className="dashboard-panel">
          <header>即将到期</header>
          <div className="dashboard-task-list">
            {upcomingTasks.length ? upcomingTasks.map((task) => (
              <button type="button" className="dashboard-task-row" onClick={() => onOpenTask(task)} key={task.id}>
                <LinearIcon name="calendar" />
                <span><strong>{task.title}</strong><small>{task.identifier} · {shortDate(task.dueDate!)}</small></span>
              </button>
            )) : <div className="dashboard-empty">未来 14 天没有到期议题</div>}
          </div>
        </section>

        <section className="dashboard-panel">
          <header>标签分布</header>
          <div className="dashboard-label-list">
            {labelCounts.length ? labelCounts.map((item) => (
              <div className="dashboard-label-row" key={item.label}>
                <span>{item.label}</span>
                <i><b style={{ width: `${tasks.length ? (item.count / tasks.length) * 100 : 0}%`, background: item.color }} /></i>
                <strong>{item.count}</strong>
              </div>
            )) : <div className="dashboard-empty">当前没有标签数据</div>}
          </div>
        </section>

        <section className="dashboard-panel dashboard-role-panel">
          <header>角色贡献</header>
          <div className="dashboard-role-list">
            {roleContributions.map((item) => (
              <div className="dashboard-role-row" key={`${item.actor.type}:${item.actor.id}`}>
                <ActorAvatar actor={item.actor} />
                <span><strong>{item.actor.name}</strong><small>{item.done}/{item.total} 已完成</small></span>
              </div>
            ))}
          </div>
        </section>

        <section className="dashboard-panel dashboard-activity-panel">
          <header>最近活动</header>
          <div className="dashboard-activity-grid">
            {activityDays.map((day) => {
              const level = day.count === 0 ? 0 : Math.min(4, Math.ceil((day.count / maxActivity) * 4));
              return <span className={`level-${level}${day.future ? " is-future" : ""}`} title={`${day.key} · ${day.count} 次更新`} key={day.key} />;
            })}
          </div>
        </section>
      </div>
    </div>
  );
}
