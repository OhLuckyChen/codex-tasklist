---
id: design.taskboard-overall
title: 任务面板整体设计
kind: design
updated_at: 2026-08-11
sources:
  - type: file
    ref: README.md
    revision: git-blob:3bb637a9cfde5b42250249a3f3dc1713eeeb6d2e
  - type: file
    ref: README_ZH.md
    revision: git-blob:2d23f061bcbc9e024150b0acadc14174e43789b0
  - type: file
    ref: server/app.mjs
    revision: git-blob:fa36da290404d66a14b87b7c97ca699313658f10
  - type: file
    ref: server/database.mjs
    revision: git-blob:f408488ec84cddf2cd0f9818b2d13401433a8207
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
# 任务面板整体设计

## 定位

e-taskboard 是本地优先的 Agent 任务面板。它把项目、Issue、评论、附件、状态、开发上下文和 Codex / Claude Code / Oh My Pi 会话统一到同一个本地看板中，使用户从“追踪多个会话”转为“围绕任务推进和验收”。

系统默认不依赖托管后端。Web、CLI、Skill 和 Codex 内嵌面板共用本机 Node.js 服务；业务数据进入本机 SQLite，附件进入 `.data/attachments`，项目长期知识进入对应项目仓库的 `docs/knowledge/`。

## 设计原则

1. 任务是主线，运行时会话是任务的执行证据和推进方式。
2. 本地数据和本地项目目录是可信边界，外部 Agent 只能在明确映射的工作区内行动。
3. Issue 描述、评论和会话结果先回到任务面板，再由用户决定是否沉淀为项目知识。
4. 状态流转必须可追溯；Agent 自检完成只能送审，不能自行标记完成。
5. README、截图和方案文档面向公开分发时只展示可证实能力，不暴露私有项目名、路径或作者本机依赖。

## 核心对象

| 对象 | 职责 | 持久化 |
| --- | --- | --- |
| Project | 管理本地项目、别名、收藏、归档和目录映射 | SQLite |
| Issue | 承载需求、状态、优先级、标签、负责人、开发上下文和关系 | SQLite |
| Comment | 承载反馈、证据、补充要求和会话跟进点 | SQLite |
| Runtime session | 记录 Codex、Claude Code 或 OMP 当前/历史会话 | SQLite |
| Attachment | 保存图片等上下文材料 | SQLite 元数据 + `.data/attachments` |
| Knowledge proposal | 保存待确认知识变更和差异 | SQLite |
| Knowledge page | 保存已确认项目事实、架构、流程和方案 | 项目仓库 `docs/knowledge/` |

## 真实操作路径

### 看板与 Issue

入口在 `web/src/App.tsx`。用户在项目页、新建弹窗、任务卡、详情页或全局视图触发操作后，前端通过 `web/src/api.ts` 调用 `server/app.mjs` 的项目、Issue、评论、关系、附件和会话接口。服务端在 `server/database.mjs` 中执行 SQLite 事务，成功后通过 SSE 通知已打开页面刷新。可观察结果是看板列、详情右侧属性、活动区、评论区和历史会话列表同步更新。

### 多运行时会话

Issue 详情中的 Codex、Claude Code 和 OMP 操作由 `web/src/components/TaskDetail.tsx` 暴露。Codex 会话通过 Codex 宿主桥接创建或跳转；Claude Code 和 OMP 通过本机 launcher 启动或恢复。新会话创建时带上 Issue 上下文和 `CODEX_THREAD_ID`，返回的会话标识写回 Issue 或评论，之后可从任务详情继续跟进。

### 项目知识

项目知识入口在项目页。`KnowledgeCenter` 读取 `server/knowledge-service.mjs` 返回的正式页面、提案、健康状态和问答结果。初始化、整项 Issue、单条/多条评论、问答保存、过期修订和阶段复盘只生成待确认提案；用户确认发布后，服务端校验目标文件基线并原子写入 `docs/knowledge/**/*.md` 或 `changelog.md`。

## 目录结构

```text
.
├── cli/                         # taskctl CLI，供 Agent 和用户读写任务板
├── docs/
│   ├── knowledge/               # 当前正式知识
│   │   ├── designs/             # 已落地或待评审技术方案
│   │   └── designs/legacy/      # 历史方案，仅用于对比
│   └── screenshots/             # README 公开截图和历史 proof 截图
├── inject/                      # Codex 桌面端注入资源
├── macos/                       # macOS 启动器资源
├── scripts/                     # 开发、安装、注入和运行脚本
├── server/                      # 本地 HTTP API、SQLite、会话 launcher、知识服务
├── shared/                      # 前后端共享的运行时和工作流工具
├── skills/                      # 随仓库分发的 Agent Skill
├── test/                        # Node test 套件
└── web/                         # React + Vite 前端
```

根目录只保留分发入口、构建配置、变更记录和仓库级规则；技术方案归入 `docs/knowledge/designs`，截图归入 `docs/screenshots`，避免 README 和项目根目录继续膨胀。

## 关键设计

### 状态与协作

Issue 状态覆盖 `backlog`、`todo`、`in_progress`、`in_review`、`blocked`、`done`、`canceled` 和 `archived`。Agent 执行前用版本号认领 `todo` 到 `in_progress`；完成实现和验证后追加评论并移动到 `in_review`；只有用户明确验收或要求完成时才进入 `done`。评论和 Issue 写入都使用版本号处理并发。

### 评论驱动的返工

评论不是附属聊天记录，而是可派发的工作单元。用户可以把某条评论交给新的 Codex、Claude Code 或 OMP 会话，也可以在已有会话中继续跟进。评论级会话会进入 Issue 历史，但不覆盖 Issue 当前主线会话。

### 项目知识闭环

正式知识按主题维护，待确认内容留在提案队列。知识页通过 frontmatter 记录文件、Issue 或评论来源；健康检查只判断来源是否可能过期，不自动改写正文。发布前必须校验 `baseDigest`，避免覆盖用户或其他 Agent 的并行修改。

### 公开分发

公开 README 使用真实 UI 截图，但必须脱敏。安装文档只描述可复现路径：克隆、`npm ci`、构建、启动、Codex 嵌入、CLI 和 Skill 安装。不得依赖作者本机路径、固定 Homebrew Node 路径、Cloudflare 后端或未声明的云服务。

## 当前边界

- 知识中心不自动发布知识，必须人工确认。
- 本机服务默认可独立运行；Codex、Claude Code 和 OMP 缺失时只影响对应运行时按钮。
- `.data/` 是安装后的本机状态，不进入 Git。
- 历史 proof 截图用于内部追溯，不作为公开产品截图。
