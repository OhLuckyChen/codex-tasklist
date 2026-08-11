---
id: project.architecture
title: 系统架构
kind: architecture
updated_at: 2026-08-10
sources:
  - type: file
    ref: server/app.mjs
    revision: git-blob:486a789c064e548df3ed1ce42b38b5229a03086a
  - type: file
    ref: server/database.mjs
    revision: git-blob:74f2a9a8f566a306a068ae7c014b9223a7e86461
  - type: file
    ref: cloud/src/index.mjs
    revision: git-blob:a64ec39efc97bff4c374b3ca0e4af6751b61200d
---
# 系统架构

## 组成

1. React Web 负责项目首页、议题看板、详情、工作流、知识中心和本地 AI 对话。
2. 本地 companion 提供 HTTP API、SQLite 持久化、SSE、项目目录解析、Git/worktree 扫描和设备本地能力。
3. Codex 注入器把同一 Web 应用嵌入桌面端，并桥接宿主项目、会话和运行时状态。
4. Cloudflare Worker 提供可共享的业务 API；D1 保存结构化数据，R2 保存附件。

## 数据边界

- 项目、议题、评论、关系、工作流与知识提案属于业务数据，可保存在本地 SQLite 或云端 D1。
- 附件在本地文件目录或云端 R2 中保存，数据库只存元数据。
- 项目目录映射、源码读取、Git/worktree、工程分析和知识文件发布属于设备能力，只通过本地 companion 执行。
- 云模式的普通业务请求由 companion 转发到云端；失败时不会回退或双写本地数据库。

## 并发与更新

议题、评论、工作流和知识提案使用递增 `version` 做乐观并发控制。本地业务变更通过 SSE 通知其他页面；D1 表触发器递增全局修订号，云端页面轮询后刷新相关数据。

## 安全边界

本地目录请求必须解析到项目已映射根目录或已发现 worktree。知识发布只允许写入 `docs/knowledge/**/*.md` 与根目录 `changelog.md`，并拒绝路径穿越和越界符号链接。
