---
id: project.architecture
title: 系统架构
kind: architecture
updated_at: 2026-08-11
sources:
  - type: file
    ref: server/app.mjs
    revision: git-blob:fa36da290404d66a14b87b7c97ca699313658f10
  - type: file
    ref: server/database.mjs
    revision: git-blob:f408488ec84cddf2cd0f9818b2d13401433a8207
  - type: file
    ref: README.md
    revision: git-blob:530ecea0c57ee25828e0f5ac0321bfe5ce2e8fe9
---
# 系统架构

## 组成

1. React Web 负责项目首页、议题看板、详情、工作流、知识中心和本地 AI 对话。
2. 本地 Taskboard 服务提供 HTTP API、SQLite 持久化、SSE、项目目录解析、Git/worktree 扫描和设备本地能力。
3. Codex 注入器把同一 Web 应用嵌入桌面端，并桥接宿主项目、会话和运行时状态。
4. Claude Code 与 Oh My Pi 集成通过本机 CLI 和终端恢复会话。

## 数据边界

- 项目、议题、评论、关系、工作流、会话关联和知识提案保存在本机 SQLite。
- 附件保存在 `.data/attachments`，数据库只保存元数据。
- 项目目录映射保存在项目记录中；源码读取、Git/worktree、工程分析和知识文件发布只在已映射的本地目录内执行。
- `.data/`、用户级 Skill 目录和本机 CLI 路径是安装后的本机状态，不提交到仓库。

## 并发与更新

议题、评论、工作流和知识提案使用递增 `version` 做乐观并发控制。本地业务变更通过 SSE 通知其他已打开页面刷新。

## 安全边界

本地目录请求必须解析到项目已映射根目录或已发现 worktree。知识发布只允许写入 `docs/knowledge/**/*.md` 与根目录 `changelog.md`，并拒绝路径穿越和越界符号链接。
