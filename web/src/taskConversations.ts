import type { Task, TaskRuntime } from "./types";

export function taskThreadRuntime(task: Task | null | undefined, threadId: string | null | undefined): TaskRuntime {
  if (!task || !threadId) return "codex";
  return task.threadRuntimes?.[threadId] ?? (threadId === task.threadId ? task.runtime : "codex");
}
