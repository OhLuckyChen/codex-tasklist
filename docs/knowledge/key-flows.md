---
id: project.key-flows
title: 关键流程
kind: flows
updated_at: 2026-08-11
sources:
  - type: file
    ref: web/src/App.tsx
    revision: git-blob:501f063e8010530dd5adf06ded54c728e68e3aae
  - type: file
    ref: web/src/components/TaskDetail.tsx
    revision: git-blob:bda983d1f258e15862c251a4b50fdd265562df8f
  - type: file
    ref: server/knowledge-service.mjs
    revision: git-blob:274f9bb6fe8fdab499861d902a5d917a27519364
---
# 关键流程

## 议题交付

议题从 `todo` 进入 `in_progress` 后由 Agent 执行；完成实现与自检后进入 `in_review`。只有用户明确验收或要求完成，才进入 `done`。所有并发写入携带当前版本，冲突后重新读取并协调。

## 会话关联

议题可从 Codex、Claude Code 或 Oh My Pi 新建会话，也可关联当前会话或历史会话。评论可以独立新建或关联会话；评论会话会进入议题历史，但不会覆盖议题当前会话。点击已关联 Codex 会话会跳回对应 Codex task，Claude/OMP 会话通过本机 CLI 恢复。

## 知识沉淀

1. 用户首次分析项目，或从整项议题、单条/多条评论、项目问答、过期页面和阶段复盘发起整理。
2. 议题进入 `in_review` 或 `done` 时自动发起复盘；相同议题已有待确认提案时刷新它。
3. 本地分析只读当前正式知识与相关代码，返回完整目标文件内容。
4. Taskboard 将来源快照和逐文件变化保存为 `ready` 提案，正式 Markdown 不变。
5. 用户查看行级差异，可编辑、保存草稿、驳回或确认发布。
6. 发布前核对每个目标的基线摘要；全部通过后使用临时文件替换，任一步骤失败会回滚已完成写入。
7. 文件写入成功后提案标记为 `published`，知识视图重新读取正式页面。

## 新鲜度与复盘

打开项目知识或手动检查时，文件来源用当前 Git blob 校验，议题和评论来源用业务版本校验。过期、缺失或无法验证的页面只显示健康状态，不会自动改正文；用户发起修订后仍走同一提案审核链路。
