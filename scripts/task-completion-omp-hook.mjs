import { readFile } from "node:fs/promises";
import { checkTaskCompletion } from "../shared/task-completion-guard.mjs";

export default function taskCompletionOmpHook(pi) {
  let correctionQueued = false;
  pi.on("agent_end", async (_event, ctx) => {
    const metadataPath = process.env.TASKBOARD_GUARD_METADATA;
    if (!metadataPath) return;
    let result;
    try {
      const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
      result = await checkTaskCompletion(metadata);
    } catch (error) {
      result = {
        action: "error",
        reason: `任务完成门禁无法读取会话信息：${error instanceof Error ? error.message : String(error)}`,
      };
    }
    if (result.action === "correct" && !correctionQueued) {
      correctionQueued = true;
      pi.sendMessage({
        customType: "taskboard-completion-guard",
        content: result.reason,
        display: true,
        attribution: "agent",
      }, { deliverAs: "nextTurn", triggerTurn: true });
      return;
    }
    if (result.action === "correct") {
      ctx?.ui?.notify?.("任务仍未闭环，但自动纠偏已经执行过一次；本次停止以避免循环。", "error");
    } else if (result.action === "error") {
      ctx?.ui?.notify?.(result.reason, "error");
    }
  });
}
