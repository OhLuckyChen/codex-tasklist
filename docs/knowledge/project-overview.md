---
id: project.overview
title: 项目概览
kind: overview
updated_at: 2026-08-11
sources:
  - type: file
    ref: README.md
    revision: git-blob:530ecea0c57ee25828e0f5ac0321bfe5ce2e8fe9
  - type: file
    ref: package.json
    revision: git-blob:1cd0a10a297e9ee3d27c4b6ad3e03575eeecc794
---
# 项目概览

e-taskboard 是本地优先的项目与议题看板，可独立在浏览器中运行，也可嵌入 Codex 桌面端。React 界面、`taskctl` CLI 和 `manage-taskboard` Skill 通过同一套本地 HTTP API 协作。

## 核心用户与能力

- 人类用户维护项目、议题、评论、附件、关系、工作流和知识提案。
- Codex、Claude Code 和 Oh My Pi 可从议题或评论创建、恢复和关联会话。
- Codex Agent 通过 Skill 读取最新议题与评论，认领任务、执行、验证并送审。
- 项目支持本地目录、Git 分支和 worktree 上下文。
- 项目知识将确认事实保存在 `docs/knowledge/`，待确认内容保存在 Taskboard 提案队列。

## 技术栈

- Web：React、TypeScript、Vite。
- 本地服务：Node.js HTTP 服务、SQLite、Server-Sent Events。
- Agent 集成：Codex 注入器、`taskctl`、Codex/Claude/OMP 本机 CLI 启动器。

## 常用命令

```bash
npm run dev
npm run typecheck
npm run build
npm test
npm run check
```

生产启动默认使用 `node server/index.mjs`，服务端口为 `47823`。本地数据默认位于 `.data/`，不进入 Git。
