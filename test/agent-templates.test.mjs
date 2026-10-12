import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const [appSource, managerSource, editorSource, detailSource, serverSource] = await Promise.all([
  readFile(new URL("../web/src/App.tsx", import.meta.url), "utf8"),
  readFile(new URL("../web/src/components/AgentManager.tsx", import.meta.url), "utf8"),
  readFile(new URL("../web/src/components/TaskEditor.tsx", import.meta.url), "utf8"),
  readFile(new URL("../web/src/components/TaskDetail.tsx", import.meta.url), "utf8"),
  readFile(new URL("../server/app.mjs", import.meta.url), "utf8"),
]);

test("Agent management stays limited to name, template source, local file, and Skills", () => {
  assert.match(managerSource, /Agent 只保存名称、模板和 Skill/);
  assert.match(managerSource, /<span>名称<\/span>/);
  assert.match(managerSource, /<span>模板来源<\/span>/);
  assert.match(managerSource, /<option value="inline">手工填写<\/option>/);
  assert.match(managerSource, /<option value="file">本地文件<\/option>/);
  assert.match(managerSource, /<legend>关联 Skill<\/legend>/);
  assert.match(managerSource, /api\.chooseAgentTemplateFile\(\)/);
  assert.match(managerSource, /<input readOnly value=\{draft\.templateValue\}/);
  assert.match(managerSource, /api\.chooseAgentSkillDirectory\(\)/);
  assert.match(managerSource, /\+ 选择 Skill 目录/);
  assert.doesNotMatch(managerSource, /当前工作区没有发现可用 Skill/);
  assert.match(serverSource, /path\.join\(resolvedDirectory, "SKILL\.md"\)/);
  assert.match(serverSource, /skills = await Promise\.all\(agent\.skillPaths\.map\(readAgentSkillDirectory\)\)/);
  assert.match(managerSource, /api\.setProjectAgentIds\(projectId, next\)/);
  assert.doesNotMatch(managerSource, /模型|权限|MCP|runtime|运行时/);
});

test("Issues and comments expose project Agent choices with comment inheritance", () => {
  assert.match(editorSource, /<span className="sr-only">Agent<\/span>/);
  assert.match(detailSource, /ariaLabel="Agent"/);
  assert.match(detailSource, /<option value="">继承 Issue Agent<\/option>/);
  assert.match(detailSource, /createComment\(task\.id, body, undefined, commentAgentId \|\| null\)/);
});

test("one resolved Agent instruction feeds Codex, Claude, and OMP new-session paths", () => {
  const start = appSource.indexOf("async function openTaskInThread");
  const end = appSource.indexOf("function followUpTaskInThread", start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const source = appSource.slice(start, end);
  assert.match(source, /if \(task\.agentId \|\| comment\?\.agentId\)/);
  assert.match(source, /instruction = await resolveAgentInstruction/);
  assert.match(source, /createClaudeSession\(\{[\s\S]*?instruction,/);
  assert.match(source, /createOmpSession\(\{[\s\S]*?instruction,/);
  assert.match(source, /const prompt = `\[\$\$\{skill\.name\}\]\(\$\{skill\.path\}\) \$\{instruction\}`/);
  assert.match(source, /type: "taskboard:create-thread"[\s\S]*?instruction,/);
});
