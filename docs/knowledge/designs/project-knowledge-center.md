---
id: design.project-knowledge-center
title: 项目持续知识中心
kind: design
updated_at: 2026-08-10
sources:
  - type: file
    ref: server/knowledge-service.mjs
    revision: git-blob:6aa0285d7e67d98569b25709c1b9fc2851c7c0e6
  - type: file
    ref: server/database.mjs
    revision: git-blob:74f2a9a8f566a306a068ae7c014b9223a7e86461
  - type: file
    ref: web/src/components/KnowledgeCenter.tsx
    revision: git-blob:cc2f6e54dae25e4201c0dd16f3a89be4a5d93ceb
  - type: file
    ref: cloud/migrations/0004_project_knowledge.sql
    revision: git-blob:bcacabc194cf3428624ac21f653c5dd1f7d993d2
---
# 项目持续知识中心

## 内容模型

系统将知识分为两种状态：

- 正式知识：项目仓库 `docs/knowledge/` 下按主题维护的 Markdown；`designs/` 保存已经落地并验证的技术方案。根目录 `changelog.md` 记录真实项目变化。
- 待确认提案：SQLite 或 D1 中的结构化记录，包含来源类型、来源快照、开发上下文、文件操作、生成基线、修改前后全文、状态和操作人。

提案状态为 `generating`、`ready`、`published`、`rejected` 或 `failed`。只有 `ready` 可以编辑并发布或驳回；发布和驳回都是终态。

## 触发点

- 项目首次初始化或重新分析。
- 整项议题、单条评论或用户选择的多条评论。
- 议题进入审核或完成；同一议题已有待确认提案时刷新原提案。
- 带来源的项目问答保存为提案。
- 健康检查发现过期页面后生成修订提案。
- 用户发起项目阶段复盘。

所有触发点只生成或刷新待确认提案，不自动发布。

## 正式知识读取

服务递归读取 `docs/knowledge/**/*.md`，解析最小 frontmatter：`id`、`title`、`kind`、`updated_at` 和 `sources`。界面展示正文、主题列表、文本搜索与健康状态，frontmatter 不作为正文显示。

来源类型包括项目文件、议题和评论。文件版本使用工作区当前内容的 Git blob；议题与评论版本由 SQLite 或 D1 查询接口提供。检查结果分为最新、可能过期、待验证和缺少来源。

## 生成与问答

本地分析过程只读项目目录。生成时先读取现有正式知识，再检查与触发来源相关的代码、配置、测试和文档；优先合并到已有主题页。输出必须是结构化的完整文件变更，目标仅限 `docs/knowledge/**/*.md` 和 `changelog.md`。

问答同时参考正式知识和当前代码，当前行为必须回到代码验证；回答携带知识页、文件或议题引用。用户可将回答及引用再次整理成待确认提案。

## 发布安全

- 工作目录必须属于项目根目录或扫描出的 worktree。
- 拒绝绝对路径、`..`、越界符号链接、非 Markdown 知识目标和超限内容。
- 单页最多 1 MiB，单提案最多 50 个文件和 5 MiB 内容。
- 写入前一次性验证全部目标的 `baseDigest`，避免部分冲突后才发现。
- 更新使用同目录临时文件和原子重命名；失败时按逆序恢复已写入文件。
- 若相同内容已写入但提案状态回写失败，重试会幂等完成；其他并发修改一律返回冲突，不覆盖。

## 本地与云端

提案表和变更明细在 SQLite 与 D1 保持同一契约。D1 变更会递增全局修订号；本地变更通过 SSE 广播。云端可浏览和编辑提案，但项目文件读取、分析、健康检查和发布必须经过本地 companion。
