#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { checkTaskCompletion } from "../shared/task-completion-guard.mjs";

async function readStdin() {
  let text = "";
  for await (const chunk of process.stdin) text += chunk;
  try { return JSON.parse(text || "{}"); } catch { return {}; }
}

const input = await readStdin();
const metadataPath = process.argv[2];
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

if (result.action === "correct" && input.stop_hook_active !== true) {
  process.stdout.write(JSON.stringify({ decision: "block", reason: result.reason }));
} else if (result.action === "correct") {
  process.stdout.write(JSON.stringify({
    systemMessage: "任务仍未闭环，但自动纠偏已经执行过一次；本次允许停止以避免循环。",
  }));
} else if (result.action === "error") {
  process.stdout.write(JSON.stringify({ systemMessage: result.reason }));
} else {
  process.stdout.write("{}");
}
