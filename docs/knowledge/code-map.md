---
id: project.code-map
title: 代码地图
kind: code-map
updated_at: 2026-08-11
sources:
  - type: file
    ref: server/app.mjs
    revision: git-blob:fa36da290404d66a14b87b7c97ca699313658f10
  - type: file
    ref: web/src/App.tsx
    revision: git-blob:501f063e8010530dd5adf06ded54c728e68e3aae
  - type: file
    ref: web/src/components/TaskDetail.tsx
    revision: git-blob:bda983d1f258e15862c251a4b50fdd265562df8f
---
# 代码地图

## 服务端

- `server/index.mjs`：本地服务启动入口与依赖装配。
- `server/app.mjs`：HTTP 路由、输入边界、本地能力、会话启动和 SSE 事件。
- `server/database.mjs`：SQLite schema、行映射、事务和业务数据读写。
- `server/knowledge-service.mjs`：知识页面读取、来源健康检查、分析、问答和安全发布。
- `server/codex-process.mjs`：Codex 子进程事件归一化和受控执行基础设施。
- `server/claude-launcher.mjs` 与 `server/omp-launcher.mjs`：Claude Code 和 Oh My Pi 会话启动/恢复。

## Web

- `web/src/App.tsx`：全局状态、项目/议题路由、实时刷新、任务状态变化和知识触发编排。
- `web/src/components/TaskDetail.tsx`：议题内容、属性、评论、附件、会话和评论知识采集入口。
- `web/src/components/KnowledgeCenter.tsx`：正式知识浏览、搜索、问答、提案差异审核和健康检查。
- `web/src/api.ts` 与 `web/src/types.ts`：前后端请求契约和共享前端类型。
- `web/src/styles.css`：所有看板与知识中心视觉样式。

## 修改起点

- 改议题数据：先核对 `database.mjs`、`app.mjs` 路由、前端类型与 API。
- 改项目视图：从 `App.tsx` 的 `BoardView`、工具栏和主内容分支开始。
- 改知识行为：先看 `KnowledgeCenter.tsx` 与 `knowledge-service.mjs`，再检查 SQLite 提案契约。
- 改 Codex 嵌入：先读 `inject/` 与 `scripts/codex-injector*.mjs`，避免把宿主问题误判为 Web 问题。
- 改 Claude/OMP：先读对应 launcher 和 `TaskDetail.tsx` 的 runtime 分支。
