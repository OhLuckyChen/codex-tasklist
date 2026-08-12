import type { CodexThreadProgress, Task, TaskRuntime } from "./types";

export interface TaskConversationItem {
  key: string;
  kind: "native";
  title: string;
  nativeThreadId: string | null;
  runtime: TaskRuntime;
  updatedAt: string;
}

export interface TaskProcessingPresentation {
  running: boolean;
  completed: number | null;
  total: number | null;
  startedAt: string | null;
}

export interface TaskCardPresentation {
  conversations: TaskConversationItem[];
  processing: TaskProcessingPresentation;
  unread: boolean;
}

function normalizeThreadId(value: string | null | undefined) {
  const trimmed = value?.trim() ?? "";
  return trimmed.replace(/^(?:local|cloud):/i, "").trim();
}

export function taskThreadRuntime(task: Task | null | undefined, threadId: string | null | undefined): TaskRuntime {
  if (!task || !threadId) return "codex";
  return task.threadRuntimes?.[threadId] ?? (threadId === task.threadId ? task.runtime : "codex");
}

export function taskConversations(task: Task) {
  const items = new Map<string, TaskConversationItem>();

  for (const threadId of task.threadIds ?? []) {
    const normalizedId = normalizeThreadId(threadId);
    if (!normalizedId) continue;
    const key = `native:${normalizedId}`;
    items.set(key, {
      key,
      kind: "native",
      title: task.title,
      nativeThreadId: threadId,
      runtime: taskThreadRuntime(task, threadId),
      updatedAt: task.updatedAt,
    });
  }

  if (task.threadId) {
    const normalizedId = normalizeThreadId(task.threadId);
    if (normalizedId && !items.has(`native:${normalizedId}`)) {
      items.set(`native:${normalizedId}`, {
        key: `native:${normalizedId}`,
        kind: "native",
        title: task.title,
        nativeThreadId: task.threadId,
        runtime: taskThreadRuntime(task, task.threadId),
        updatedAt: task.updatedAt,
      });
    }
  }

  return [...items.values()].sort((left, right) => {
    if (left.updatedAt !== right.updatedAt) return right.updatedAt.localeCompare(left.updatedAt);
    return left.key.localeCompare(right.key);
  });
}

export function taskCardPresentation(
  task: Task,
  unread = false,
  progress?: CodexThreadProgress | null,
): TaskCardPresentation {
  const conversations = taskConversations(task);
  const hasNativeProgress = Boolean(progress && progress.running);
  const running = task.status === "in_progress" && hasNativeProgress;

  return {
    conversations,
    unread,
    processing: {
      running,
      completed: progress?.completed ?? null,
      total: progress?.total ?? null,
      startedAt: null,
    },
  };
}
