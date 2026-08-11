---
id: project.key-flows
title: 关键流程
kind: flows
updated_at: 2026-08-10
sources:
  - type: file
    ref: web/src/App.tsx
    revision: git-blob:061efad14c473dcaea1dca2bf84aa8c814f2e6d7
  - type: file
    ref: web/src/components/TaskDetail.tsx
    revision: git-blob:0413199aec02741413e9e17bf3f8511397e51c4c
  - type: file
    ref: server/knowledge-service.mjs
    revision: git-blob:6aa0285d7e67d98569b25709c1b9fc2851c7c0e6
---
# 关键流程

## 议题交付

议题从 `todo` 进入 `in_progress` 后由 Agent 执行；完成实现与自检后进入 `in_review`。只有用户明确验收或要求完成，才进入 `done`。所有并发写入携带当前版本，冲突后重新读取并协调。

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

## 云端协作

提案及其文件差异、来源快照和状态可在 D1 中共享。源码分析和发布必须由持有项目目录映射的本地 companion 完成。发布时根据提案分支或 worktree 上下文选择对应本地目录。
