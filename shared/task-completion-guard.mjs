const INCOMPLETE_STATUSES = new Set(["backlog", "todo", "in_progress"]);

function normalizedThreadIds(task) {
  return new Set([
    ...(Array.isArray(task?.threadIds) ? task.threadIds : []),
    task?.threadId,
  ].filter((value) => typeof value === "string" && value.trim()).map((value) => value.trim().toLowerCase()));
}

export function taskCompletionCorrection(task) {
  const identifier = task?.identifier || task?.id || "当前任务";
  return [
    `任务 ${identifier} 仍处于 ${task?.status || "未知状态"}，本次任务面板会话尚未闭环。`,
    "请重新读取任务描述和最新评论，完成遗漏的实现与验证；完成后先添加结果评论，再把任务移动到 in_review。",
    "如果存在无法继续的真实阻塞，请添加说明阻塞原因的评论并把任务移动到 blocked。",
    "这是唯一一次自动纠偏；不要只回复说明而不回写任务面板。",
  ].join("\n");
}

export function evaluateTaskCompletion({ task, taskId, threadId }) {
  if (!task || task.id !== taskId) {
    return { action: "inactive", reason: "任务记录与会话门禁不匹配" };
  }
  const normalizedThreadId = String(threadId || "").trim().toLowerCase();
  if (!normalizedThreadId || !normalizedThreadIds(task).has(normalizedThreadId)) {
    return { action: "inactive", reason: "当前会话未关联到该任务" };
  }
  if (!INCOMPLETE_STATUSES.has(task.status)) {
    return { action: "allow", status: task.status };
  }
  return {
    action: "correct",
    status: task.status,
    reason: taskCompletionCorrection(task),
  };
}

export async function checkTaskCompletion(metadata, options = {}) {
  const taskboardUrl = String(
    metadata?.taskboardUrl || process.env.CODEX_TASKBOARD_URL || "http://127.0.0.1:47823",
  );
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? 3_000;
  try {
    const endpoint = new URL(`/api/tasks/${encodeURIComponent(metadata.taskId)}`, taskboardUrl);
    const response = await fetchImpl(endpoint, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    const body = await response.json();
    return evaluateTaskCompletion({
      task: body?.task,
      taskId: metadata.taskId,
      threadId: metadata.threadId,
    });
  } catch (error) {
    return {
      action: "error",
      reason: `任务完成门禁无法读取任务面板状态：${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
