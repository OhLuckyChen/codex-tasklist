import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const appSource = await readFile(new URL("../web/src/App.tsx", import.meta.url), "utf8");
const boardColumnSource = await readFile(new URL("../web/src/components/BoardColumn.tsx", import.meta.url), "utf8");
const apiSource = await readFile(new URL("../web/src/api.ts", import.meta.url), "utf8");
const styles = await readFile(new URL("../web/src/styles.css", import.meta.url), "utf8");
const detailSource = await readFile(new URL("../web/src/components/TaskDetail.tsx", import.meta.url), "utf8");
const knowledgeSource = await readFile(new URL("../web/src/components/KnowledgeCenter.tsx", import.meta.url), "utf8");
const editorSource = await readFile(new URL("../web/src/components/TaskEditor.tsx", import.meta.url), "utf8");
const labelPickerSource = await readFile(new URL("../web/src/components/LabelPicker.tsx", import.meta.url), "utf8");
const contextMenuSource = await readFile(new URL("../web/src/components/TaskContextMenu.tsx", import.meta.url), "utf8");
const cardSource = await readFile(new URL("../web/src/components/TaskCard.tsx", import.meta.url), "utf8");
const filterSource = await readFile(new URL("../web/src/taskFilters.ts", import.meta.url), "utf8");
const typesSource = await readFile(new URL("../web/src/types.ts", import.meta.url), "utf8");

test("published comments can explicitly remove an incorrect conversation association", () => {
  assert.match(detailSource, /dissociatePublishedCommentFromThread/);
  assert.match(detailSource, /updateComment\(comment, comment\.body, null\)/);
  assert.match(detailSource, /解除关联/);
  assert.match(detailSource, /保留评论和 Codex 会话/);
  assert.match(detailSource, /className="comment-conversation-unlink"/);
  assert.match(detailSource, /aria-label="解除评论与会话的关联"/);
  assert.match(styles, /\.comment-conversation-link:hover \.comment-conversation-unlink/);
  assert.match(styles, /\.comment-conversation-link:focus-within \.comment-conversation-unlink/);
  assert.match(apiSource, /threadId\?: string \| null/);
  assert.match(apiSource, /threadId !== undefined/);
});

test("project knowledge keeps confirmed files separate from reviewable issue and comment proposals", () => {
  assert.match(appSource, /type BoardView = "dashboard" \| "issues" \| "list" \| "gantt" \| "drafts" \| "knowledge"/);
  assert.match(appSource, />\s*项目知识\{knowledgeProposalCount/);
  assert.match(appSource, /queueAutomaticKnowledgeReview/);
  assert.match(appSource, /moved\.status === "in_review" \|\| moved\.status === "done"/);
  assert.match(detailSource, /整理为项目知识/);
  assert.match(detailSource, /加入知识提案/);
  assert.match(detailSource, /选择评论整理/);
  assert.match(knowledgeSource, /已发布/);
  assert.match(knowledgeSource, /待确认/);
  assert.match(knowledgeSource, /健康状态/);
  assert.match(knowledgeSource, /knowledge-line-diff/);
  assert.match(knowledgeSource, /保存为知识提案/);
  assert.match(apiSource, /\/knowledge-source-versions/);
  assert.match(typesSource, /type KnowledgeProposalStatus = "generating" \| "ready" \| "published"/);
  assert.match(styles, /\.knowledge-published-layout/);
  assert.match(styles, /\.comment-knowledge-toolbar/);
});

test("dashboard, list, and gantt views share the issue task model", () => {
  assert.match(appSource, /import \{ DashboardView \}/);
  assert.match(appSource, /import \{ GanttView, type GanttZoom \}/);
  assert.match(appSource, /import \{ IssueListView \}/);
  assert.match(appSource, /taskCardPresentation\(task, false, progressByTaskId\.get\(task\.id\) \?\? null\)/);
  assert.match(appSource, /selectBoardView\("dashboard"\)/);
  assert.match(appSource, /selectBoardView\("list"\)/);
  assert.match(appSource, /selectBoardView\("gantt"\)/);
  assert.match(appSource, /onUpdate=\{\(task, changes\) => updateTaskProperties\(task, changes\)\}/);
});

function workflowStatuses() {
  const match = typesSource.match(/export const TASK_STATUSES = (\[[\s\S]*?\]) as const/);
  assert.ok(match);
  return [...match[1].matchAll(/"([^"]+)"/g)].map((entry) => entry[1]);
}

test("dragging previews the insertion rank before committing it", () => {
  assert.match(boardColumnSource, /function findDropBefore/);
  assert.match(boardColumnSource, /clientY < card\.getBoundingClientRect\(\)\.top \+ card\.offsetHeight \/ 2/);
  assert.match(boardColumnSource, /onDrop\(status, taskId, findDropBefore/);
  assert.match(boardColumnSource, /function getTaskDragShift/);
  assert.match(boardColumnSource, /shift -= dragDistance/);
  assert.match(boardColumnSource, /shift \+= dragDistance/);
  assert.match(boardColumnSource, /dragShift=\{dragShift\}/);
  assert.match(styles, /\.task-card\.is-dragging \{[\s\S]*?opacity: 0/);
  assert.doesNotMatch(styles, /\.task-card\.is-dragging \{[^}]*pointer-events: none/);
  assert.match(styles, /transform 160ms cubic-bezier/);
  assert.match(appSource, /beforeTaskId: string \| null = null/);
  assert.match(appSource, /\(previousTask\.sortOrder \+ nextTask\.sortOrder\) \/ 2/);
  assert.match(appSource, /currentOrder\.every\(\(candidate, index\) => candidate\.id === desiredOrder\[index\]\.id\)/);
  assert.match(appSource, /setTasks\(\(current\) => sortTasks\(current\.map/);
  assert.match(appSource, /setSettlingTaskId\(task\.id\)/);
  assert.match(styles, /\.task-card\.is-settling \{[\s\S]*?task-card-settle 200ms/);
});

test("status change date groups stay contiguous before card rendering", () => {
  assert.match(boardColumnSource, /const STATUS_CHANGED_GROUPS = \["今日", "昨日", "上周", "更早"\] as const/);
  assert.match(boardColumnSource, /function compareTasksByStatusGroup/);
  assert.match(boardColumnSource, /if \(leftGroup !== rightGroup\) return leftGroup - rightGroup/);
  assert.match(boardColumnSource, /const updatedDelta = updatedTime\(right\) - updatedTime\(left\)/);
  assert.match(boardColumnSource, /const sortedTasks = tasks\.slice\(\)\.sort/);
  assert.match(boardColumnSource, /sortedTasks\.map\(\(task, index\) =>/);
  assert.match(boardColumnSource, /statusChangedGroup\(sortedTasks\[index - 1\], groupingNow\)/);
});

test("text selection is reserved for editable fields", () => {
  assert.match(styles, /body \{[^}]*user-select: none/);
  assert.match(styles, /input,[\s\S]*?textarea,[\s\S]*?\[contenteditable="true"\][\s\S]*?user-select: text/);
});

test("issue cards omit timestamps and keep compact project-aware rows", () => {
  assert.doesNotMatch(cardSource, /task\.createdAt|创建于|card-footer|created-at|project-chip/);
  assert.doesNotMatch(styles, /\.card-footer|\.created-at|\.project-chip/);
  assert.match(cardSource, /projectName\?: string/);
  assert.match(cardSource, /className="task-project-name"/);
  assert.match(styles, /\.task-card \{[\s\S]*?min-height: 80px;[\s\S]*?gap: 6px;[\s\S]*?padding: 7px 8px/);
  assert.match(detailSource, /currentTask\.createdAt/);
});

test("scrollbars stay proportional while the workflow node library hides its bar", () => {
  assert.match(styles, /:root \{[\s\S]*?--scrollbar-thumb: rgba\(27, 27, 27, 0\.15\)/);
  assert.match(styles, /:root\[data-theme="dark"\] \{[\s\S]*?--scrollbar-thumb: rgba\(238, 238, 239, 0\.15\)/);
  assert.match(styles, /\* \{[\s\S]*?scrollbar-color: var\(--scrollbar-thumb\) transparent[\s\S]*?scrollbar-width: thin/);
  assert.match(styles, /\*::\-webkit-scrollbar-track,[\s\S]*?\*::\-webkit-scrollbar-track-piece,[\s\S]*?\*::\-webkit-scrollbar-corner \{[\s\S]*?background: transparent/);
  assert.match(styles, /\*::\-webkit-scrollbar-button \{[\s\S]*?display: none/);
  assert.match(styles, /\*::\-webkit-scrollbar-thumb \{[\s\S]*?min-height: 30px[\s\S]*?background: var\(--scrollbar-thumb\)[\s\S]*?background-clip: padding-box/);
  assert.doesNotMatch(styles, /scrollbar-color: var\(--border-strong\) transparent/);
  assert.doesNotMatch(styles, /\*::\-webkit-scrollbar-thumb:(?:vertical|horizontal)/);
  assert.match(styles, /\.workflow-node-groups \{[\s\S]*?overflow-y: auto;[\s\S]*?scrollbar-width: none/);
  assert.match(styles, /\.workflow-node-groups::\-webkit-scrollbar \{[\s\S]*?display: none;[\s\S]*?width: 0;[\s\S]*?height: 0/);
});

test("each status column remains a drop target for the full board height", () => {
  assert.match(styles, /\.board \{[\s\S]*?align-items: stretch;[\s\S]*?height: 100%/);
  assert.match(styles, /\.board-column \{[\s\S]*?display: flex;[\s\S]*?flex-direction: column;[\s\S]*?height: 100%/);
  assert.match(styles, /\.column-list \{[\s\S]*?flex: 1 0 auto;[\s\S]*?min-height: calc\(100% - 48px\)/);
});

test("the issue board has no shared vertical scroll and each status column scrolls below a sticky heading", () => {
  assert.match(styles, /\.board-scroll \{[\s\S]*?overflow-x: auto;[\s\S]*?overflow-y: hidden;[\s\S]*?overscroll-behavior-y: none/);
  assert.match(styles, /\.board-column \{[\s\S]*?overflow-x: hidden;[\s\S]*?overflow-y: auto;[\s\S]*?overscroll-behavior-y: contain/);
  assert.match(styles, /\.column-header \{[\s\S]*?position: sticky;[\s\S]*?top: 0;[\s\S]*?background: var\(--board-column-surface\)/);
});

test("the complete Linear-style workflow shares one ordered status source", () => {
  assert.deepEqual(workflowStatuses(), [
    "backlog",
    "todo",
    "in_progress",
    "in_review",
    "done",
    "blocked",
    "canceled",
    "archived",
  ]);
  assert.match(boardColumnSource, /in_review: \{ label: "审核中", tone: "review" \}/);
  assert.match(boardColumnSource, /blocked: \{ label: "已阻塞", tone: "blocked" \}/);
  assert.match(boardColumnSource, /canceled: \{ label: "已取消", tone: "canceled" \}/);
  assert.match(boardColumnSource, /archived: \{ label: "归档", tone: "archived" \}/);
  assert.match(cardSource, /import \{ TASK_STATUSES,/);
  assert.doesNotMatch(cardSource, /STATUS_ORDER/);
  assert.match(detailSource, /TASK_STATUSES\.map\(\(status\) =>/);
  assert.match(editorSource, /TASK_STATUSES\.map\(\(value\) =>/);
  assert.match(contextMenuSource, /TASK_STATUSES\.map\(\(status, index\) =>/);
});

test("review, blocked and canceled statuses round-trip through filter URLs", () => {
  const statuses = workflowStatuses();
  const selected = ["in_review", "blocked", "canceled"];
  const url = new URL("http://taskboard.local/");
  url.searchParams.set("status", selected.join(","));
  const restored = url.searchParams.get("status").split(",").filter((status) => statuses.includes(status));

  assert.deepEqual(restored, selected);
  assert.match(filterSource, /filters\.statuses\.join\(","\)/);
  assert.match(filterSource, /\.split\(","\)\.filter\(isTaskStatus\)/);
  assert.match(filterSource, /TASK_STATUSES\.includes\(value as TaskStatus\)/);
});

test("the column surface wraps its heading and issue list", () => {
  assert.match(styles, /\.board-column \{[\s\S]*?--board-column-surface: var\(--column-header\)[\s\S]*?background: var\(--board-column-surface\)/);
  assert.match(styles, /\.column-header \{[\s\S]*?background: var\(--board-column-surface\)/);
  assert.match(styles, /\.column-list \{[\s\S]*?padding: 8px 8px 8px/);
});

test("common issue mutations enter a Linear-style undo queue", () => {
  assert.match(appSource, /const undoStackRef = useRef<UndoOperation\[]>/);
  assert.match(appSource, /event\.key\.toLowerCase\(\) === "z"/);
  assert.match(appSource, /event\.metaKey \|\| event\.ctrlKey/);
  assert.match(appSource, /function pushUndo/);
  assert.match(appSource, /setUndoNotice\(showNotice \? \{ id: operation\.id, message \} : null\)/);
  assert.match(appSource, /moveTask\(task, destination, beforeTaskId, true\)/);
  assert.doesNotMatch(appSource, /setAnnouncement\(`已撤回：/);
  assert.match(appSource, /className="toast undo-toast"/);
  assert.match(appSource, /await moveTask\(task, "archived"\)/);
  assert.match(apiSource, /archived: "all"/);
});

test("issues expose a current conversation and expandable conversation history", () => {
  assert.match(detailSource, /新建 Codex 会话/);
  assert.match(detailSource, /onOpenInThread\(currentTask\)/);
  assert.doesNotMatch(appSource, /detail-thread-button/);
  assert.doesNotMatch(detailSource, /输入对话 ID|解除 Codex 对话绑定|>绑定</);
  assert.doesNotMatch(editorSource, /对话 ID|linkedThreadId/);
  assert.match(detailSource, /currentTask\.threadId/);
  assert.match(detailSource, /currentTask\.threadIds/);
  assert.match(detailSource, /taskThreadRuntime\(currentTask, threadId\)/);
  assert.match(detailSource, /onOpen=\{\(threadId\) => onOpenThread\(threadId, currentTask\)\}/);
  assert.match(detailSource, /历史相关会话/);
  assert.match(detailSource, /label="当前会话"/);
  assert.match(detailSource, /className="conversation-thread-id">\{threadId\}/);
  assert.doesNotMatch(detailSource, /shortThreadId/);
  assert.doesNotMatch(detailSource, /detail-property-label">Codex/);
  assert.match(detailSource, /comment\.threadId/);
  assert.match(detailSource, /threadId=\{comment\.threadId\}/);
  assert.doesNotMatch(detailSource, /compact/);
  assert.doesNotMatch(styles, /issue-conversation-link\.compact/);
  assert.match(styles, /\.issue-conversation-history/);
  assert.match(detailSource, /代码分支/);
  assert.match(detailSource, /Worktree/);
  assert.match(detailSource, /developmentContext/);
  assert.doesNotMatch(detailSource, /placeholder="绑定分支/);
  assert.doesNotMatch(contextMenuSource, /打开关联 Codex 对话/);
  assert.match(contextMenuSource, /onOpenInThread/);
});

test("issues bind one workflow from the current project's workflow tabs", () => {
  assert.match(typesSource, /export interface Task \{[\s\S]*?workflowId: string \| null/);
  assert.match(typesSource, /export interface TaskDraft \{[\s\S]*?workflowId: string \| null/);
  assert.match(appSource, /function taskToDraft[\s\S]*?workflowId: task\.workflowId/);
  assert.match(appSource, /const \[workflowOptions, setWorkflowOptions\] = useState<WorkflowOption\[\]>/);
  assert.match(appSource, /workflowOptionsFromWorkspace\(record\.workspace\)/);
  assert.match(editorSource, /workflows: WorkflowOption\[\]/);
  assert.match(editorSource, /workflowId: workflowId \|\| null/);
  assert.match(editorSource, /<span className="sr-only">工作流<\/span>/);
  assert.match(detailSource, /<span className="detail-property-label">工作流<\/span>/);
  assert.match(detailSource, /onChange=\{\(workflowId\) => void saveTask\(\{\s*workflowId: workflowId \|\| null/);
  assert.match(detailSource, /当前设备未找到此流程/);
});

test("comments stage, upload, render and delete their own attachments", () => {
  assert.match(apiSource, /export async function uploadCommentAttachment/);
  assert.match(apiSource, /\/api\/comments\/\$\{encodeURIComponent\(commentId\)\}\/attachments/);
  assert.match(detailSource, /pendingCommentFiles/);
  assert.match(detailSource, /uploadCommentAttachment\(comment\.id, file\)/);
  assert.match(detailSource, /comment\.attachments[\s\S]*?\.map/);
  assert.match(detailSource, /setPendingAttachmentDelete\(attachment\)/);
});

test("comments publish before a conversation is associated", () => {
  assert.match(detailSource, /\{submitting \? "发表中…" : "发表评论"\}/);
  assert.doesNotMatch(detailSource, /评论并新建会话|评论并在已有会话跟进|选择会话并发布评论/);
  assert.match(detailSource, /function openPublishedCommentInNewThread\(comment: Comment, runtime: TaskRuntime = "codex"\)/);
  assert.match(detailSource, /function associatePublishedCommentWithThread\(comment: Comment, threadId: string\)/);
  assert.match(detailSource, /updateComment\(comment, comment\.body, threadId\)/);
  assert.match(appSource, /const requestId = crypto\.randomUUID\(\)/);
  assert.match(appSource, /pendingThreadRequestsRef\.current\.set\(requestId, \{/);
  assert.match(appSource, /commentId: comment\?\.id/);
  assert.match(appSource, /writePendingThreadRequests\(pendingThreadRequestsRef\.current\)/);
  assert.match(appSource, /pendingThreadRequestsRef\.current\.get\(payload\.requestId\)/);
  assert.match(appSource, /await listComments\(args\.taskId\)/);
  assert.match(appSource, /taskboard:thread-link-ack/);
  assert.match(appSource, /requestId,/);
  assert.match(appSource, /commentId: comment\?\.id/);
  assert.match(detailSource, /新建 Codex 会话/);
  assert.match(detailSource, /关联已有会话/);
  assert.match(detailSource, /在关联会话处理/);
  assert.match(detailSource, /在当前会话处理/);
  assert.match(detailSource, /需要处理时，请点击“在关联会话处理”/);
  assert.match(detailSource, /const commentThreadOptions = \[/);
  assert.match(detailSource, /\.\.\.linkedThreadIds/);
  assert.match(apiSource, /Array\.isArray\(data\.comments\)/);
  assert.match(apiSource, /attachments: Array\.isArray\(comment\.attachments\)/);
});

test("a sent follow-up resumes an issue under review without changing it on prefill", () => {
  assert.match(appSource, /action: "follow-up"/);
  assert.match(appSource, /type: "taskboard:follow-up-thread"/);
  assert.match(appSource, /message\.type === "taskboard:thread-followed-up"/);
  assert.match(appSource, /task\.status === "in_review"/);
  assert.match(appSource, /moveTaskRequest\(task, "in_progress", undefined, threadId\)/);
  assert.doesNotMatch(
    appSource.slice(
      appSource.indexOf("function followUpTaskInThread"),
      appSource.indexOf("function changeProject"),
    ),
    /moveTaskRequest/,
  );
});

test("issue creation and detail share one searchable, creatable label picker", () => {
  assert.match(editorSource, /<LabelPicker/);
  assert.match(detailSource, /<LabelPicker/);
  assert.match(appSource, /<TaskDetail[\s\S]*?availableLabels=\{availableLabels\}/);
  assert.match(detailSource, /selectedLabels=\{currentTask\.labels\}/);
  assert.match(detailSource, /saveTask\(\{ labels: nextLabels \}, "labels"\)/);
  assert.doesNotMatch(detailSource, /标签，以逗号分隔|function saveLabels|labels\.split/);
  assert.match(labelPickerSource, /availableLabels\.filter/);
  assert.match(labelPickerSource, /selectedLabels\.includes\(label\)/);
  assert.match(labelPickerSource, /创建 “\{normalizedSearch\}”/);
  assert.match(labelPickerSource, /labelColor\(normalizedSearch\)/);
  assert.match(labelPickerSource, /aria-multiselectable="true"/);
  assert.match(styles, /\.detail-label-picker \.label-popover/);
});
