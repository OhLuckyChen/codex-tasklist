---
id: project.code-map
title: 代码地图
kind: code-map
updated_at: 2026-08-10
sources:
  - type: file
    ref: server/app.mjs
    revision: git-blob:486a789c064e548df3ed1ce42b38b5229a03086a
  - type: file
    ref: web/src/App.tsx
    revision: git-blob:061efad14c473dcaea1dca2bf84aa8c814f2e6d7
  - type: file
    ref: web/src/api.ts
    revision: git-blob:b25754e3f5adcfe9f5002496363d44042fb141b5
---
# 代码地图

## 服务端

- `server/index.mjs`：本地服务启动入口与依赖装配。
- `server/app.mjs`：HTTP 路由、输入边界、云端代理、本地能力和 SSE 事件。
- `server/database.mjs`：SQLite schema、行映射、事务和业务数据读写。
- `server/knowledge-service.mjs`：知识页面读取、来源健康检查、分析、问答和安全发布。
- `server/ai-chat-process.mjs`：Codex 子进程参数、事件归一化和会话执行基础设施。

## Web

- `web/src/App.tsx`：全局状态、项目/议题路由、实时刷新、任务状态变化和知识触发编排。
- `web/src/components/TaskDetail.tsx`：议题内容、属性、评论、附件、会话和评论知识采集入口。
- `web/src/components/KnowledgeCenter.tsx`：正式知识浏览、搜索、问答、提案差异审核和健康检查。
- `web/src/api.ts` 与 `web/src/types.ts`：前后端请求契约和共享前端类型。
- `web/src/styles.css`：所有看板与知识中心视觉样式。

## 云端

- `cloud/src/index.mjs`：Worker 路由与 D1/R2 业务实现。
- `cloud/migrations/`：D1 结构迁移和全局修订触发器。
- `test/helpers/cloud-worker-harness.mjs`：本地 Worker/D1/R2 集成测试环境。

## 修改起点

- 改议题数据：先核对本地 `database.mjs`、本地路由、云端同名逻辑、前端类型与 API。
- 改项目视图：从 `App.tsx` 的 `BoardView`、工具栏和主内容分支开始。
- 改知识行为：先看 `KnowledgeCenter.tsx` 与 `knowledge-service.mjs`，再检查 SQLite/D1 提案契约。
- 改 Codex 嵌入：先读 `inject/` 与 `scripts/codex-injector*.mjs`，避免把宿主问题误判为 Web 问题。
