---
id: project.overview
title: 项目概览
kind: overview
updated_at: 2026-08-10
sources:
  - type: file
    ref: README.md
    revision: git-blob:f797af23bd94b42bd673782e36cc7c0e65b32748
  - type: file
    ref: package.json
    revision: git-blob:30dd4173c74cd24b4903959f635320078216fa7b
---
# 项目概览

e-taskboard 是本地优先的项目与议题看板，可独立在浏览器中运行，也可嵌入 Codex 桌面端。React 界面、`taskctl` CLI 和 `manage-taskboard` Skill 通过同一套 HTTP API 协作。

## 核心用户与能力

- 人类用户维护项目、议题、评论、附件、关系、工作流和知识提案。
- Codex 或 Claude Agent 读取最新议题与评论，认领任务、执行、验证并送审。
- 项目支持本地目录、Git 分支和 worktree 上下文；云端协作者可各自映射不同的本地检出路径。
- 项目知识将确认事实保存在 `docs/knowledge/`，待确认内容保存在 Taskboard 提案队列。

## 技术栈

- Web：React、TypeScript、Vite。
- 本地服务：Node.js HTTP 服务、Node SQLite。
- 云端协作：Cloudflare Worker、D1 和 R2。
- 实时更新：本地使用 Server-Sent Events，云端使用全局修订号轮询。

## 常用命令

```bash
npm run dev
npm run typecheck
npm run build
npm test
npm run check
```

生产启动默认使用 `node server/index.mjs`，服务端口为 `47823`。本地数据默认位于 `.data/`，不进入 Git。
