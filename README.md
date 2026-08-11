# Codex Taskboard

Codex Taskboard 是一个本地优先的项目任务面板。它可以作为普通 Web 应用独立运行，也可以嵌入 Codex 桌面端，让人、Codex、Claude Code 和 Oh My Pi 围绕同一批项目议题协作。

这个仓库当前不包含云端协作后端：任务数据默认写入本机 SQLite，附件和日志保存在本机 `.data/`，实时刷新通过本地 HTTP API 和 Server-Sent Events 完成。

## 界面预览

![Codex 侧边栏中的任务面板](injection-proof.png)

![新建议题编辑器](linear-editor-proof.png)

![议题详情与评论](task-detail-embedded-proof.png)

## 核心功能

| 能力 | 说明 |
| --- | --- |
| 项目看板 | 多项目管理、跨项目总览、收藏项目、项目别名、归档与恢复。 |
| 议题管理 | backlog、todo、in_progress、in_review、blocked、done、canceled、archived 状态流转；支持优先级、标签、负责人、截止日期、重复规则、草稿箱和收藏。 |
| 评论与附件 | 议题详情支持 Markdown 描述、评论、附件下载、评论编辑删除和版本冲突保护。 |
| 关系建模 | 支持父子、阻塞、被阻塞和相关议题关系。 |
| 开发上下文 | 每个议题可记录 Git 分支、worktree 路径和项目本地目录映射。 |
| 实时刷新 | 多个浏览器窗口或 Codex 内嵌页面通过本地 SSE 同步刷新。 |
| taskctl CLI | 用命令行创建项目、移动议题、添加评论、下载附件、读取当前上下文。 |
| manage-taskboard Skill | Codex Agent 可按议题读取上下文、认领任务、提交评论、送审和关联当前会话。 |
| 项目知识 | 基于本地项目目录生成待确认知识提案，审核后写入 `docs/knowledge/`。 |
| AI 对话 | 在已映射项目中围绕项目、议题、评论和知识页发起本地 AI 对话。 |

## Agent 与会话

| Runtime | 支持内容 |
| --- | --- |
| Codex | 从议题新建 Codex 会话；从评论新建会话；向当前会话 follow-up；关联或取消关联当前会话；查看当前会话与历史会话；点击会话 ID 跳回对应 Codex task。 |
| Claude Code | 从议题或评论启动 Claude Code 会话；记录 Claude 会话 ID；点击已关联会话可通过本机终端恢复。 |
| Oh My Pi | 从议题或评论启动 Oh My Pi 会话；记录 OMP 会话 ID；点击已关联会话可通过本机终端恢复。 |

会话关联分两层保存：议题的当前会话用于“继续当前任务”，历史会话用于追踪曾经处理过这个议题的 Codex、Claude Code 或 Oh My Pi 上下文。评论也可以独立关联会话，适合从某条评论直接分派一个新会话。

## 工作方式

```text
Web UI / Codex 内嵌页 / taskctl / manage-taskboard Skill
                  |
                  v
          本地 Node.js HTTP API + SSE
                  |
                  v
      SQLite + .data/attachments + 项目目录映射
                  |
                  v
     Codex / Claude Code / Oh My Pi 本机集成
```

注入器只通过回环地址连接 Codex 的 CDP 端口，在 Codex 页面中增加 Taskboard 入口和会话跳转能力。它不会修改、替换或重新签名官方 Codex 应用。

## 安装要求

| 项目 | 是否必需 | 说明 |
| --- | --- | --- |
| Node.js >= 22.5 | 必需 | 服务端、CLI、构建和测试都依赖 Node。 |
| npm | 必需 | 使用 `npm ci` 安装锁定依赖。 |
| macOS | 可选 | 只有 Codex 桌面注入、Dock 启动器、Claude/OMP 终端恢复需要 macOS。 |
| Codex 桌面端 | 可选 | 需要内嵌看板、点击跳回 Codex task、Codex 会话桥接时使用。 |
| `codex` CLI | 可选 | 用于从议题创建或 follow-up Codex 会话。 |
| `claude` CLI | 可选 | 用于 Claude Code 会话启动和恢复。 |
| `omp` CLI | 可选 | 用于 Oh My Pi 会话启动和恢复。 |

## 快速开始

```bash
git clone https://github.com/OhLuckyChen/codex-tasklist.git
cd codex-tasklist
npm ci
npm run build:web
CODEX_TASKBOARD_HOST=127.0.0.1 npm start
```

打开 <http://127.0.0.1:47823>。

开发模式：

```bash
npm run dev
```

Vite 页面默认在 <http://127.0.0.1:5173>，API 会代理到本地 Taskboard 服务。

## 嵌入 Codex

推荐方式是安装 macOS Dock 启动器：

```bash
./scripts/install-macos-launcher.sh
```

安装器会做这些事：

- 检查并记录当前可用的 Node.js 路径到 `.data/node-path`。
- 如果能找到 `codex` CLI，会记录到 `.data/codex-path`。
- 安装 LaunchAgent，后台监听 Codex 的本地 CDP 端口并恢复 Taskboard。
- 备份 Dock 配置到 `.data/com.apple.dock.before-codex-taskboard.plist`。
- 将 Dock 中的 Codex 入口替换为 Codex Taskboard 启动器。

如果 Codex 已经打开，首次安装后请退出一次，再从新的 Dock 图标启动。

也可以手动注入一个已经启用 CDP 的 Codex 实例：

```bash
npm run codex:inject -- --port 9229 --open
```

需要指定自定义可执行文件时使用环境变量：

```bash
CODEX_TASKBOARD_NODE=/absolute/path/to/node \
CODEX_EXECUTABLE=/absolute/path/to/codex \
./scripts/install-macos-launcher.sh
```

## 使用 taskctl

从仓库内运行：

```bash
npm run taskctl -- project create \
  --id my-project \
  --name "My Project" \
  --workspace-path /absolute/path/to/repository

npm run taskctl -- issue create \
  --project my-project \
  --title "Implement the next slice" \
  --status todo \
  --priority high \
  --labels product,mvp
```

也可以执行 `npm link`，让 `taskctl` 出现在当前 shell 的命令搜索路径。完整命令见 [`skills/manage-taskboard/references/cli.md`](skills/manage-taskboard/references/cli.md)。

## 安装 Skill

Codex 使用：

```bash
mkdir -p ~/.codex/skills
ln -s "$(pwd)/skills/manage-taskboard" ~/.codex/skills/manage-taskboard
```

然后在 Codex 中用：

```text
$manage-taskboard ISSUE-ID
```

Skill 会读取最新议题、评论和版本号，用 `taskctl` 写回认领、评论、移动状态和会话关联。

## 配置

| 环境变量 | 默认值 | 作用 |
| --- | --- | --- |
| `CODEX_TASKBOARD_HOST` | `0.0.0.0` | HTTP 监听地址。独立本机使用建议设为 `127.0.0.1`。 |
| `CODEX_TASKBOARD_PORT` | `47823` | HTTP 服务端口。 |
| `CODEX_TASKBOARD_DATA_DIR` | `.data` | SQLite、附件、日志和运行文件目录。 |
| `CODEX_TASKBOARD_URL` | `http://127.0.0.1:47823` | `taskctl` 访问的 API 地址。 |
| `CODEX_EXECUTABLE` | 自动探测 | Codex CLI 路径。 |
| `CLAUDE_EXECUTABLE` | 自动探测 | Claude Code CLI 路径。 |
| `OMP_EXECUTABLE` | 自动探测 | Oh My Pi CLI 路径。 |
| `CODEX_TASKBOARD_NODE` | 自动探测 | macOS 启动器使用的 Node.js 路径。 |

默认监听 `0.0.0.0` 是为了允许局域网设备访问。这个本地服务没有公网账户认证，不要直接暴露到公网。

## 数据边界

- `.data/` 不提交到 Git，里面包含 SQLite、附件、日志、安装器记录的本机可执行文件路径和 Dock 备份。
- 项目目录映射保存在 SQLite 的项目记录中，不依赖个人机器上的额外配置文件。
- `~/.codex/skills` 和 `~/.claude/skills` 是用户级 Agent 集成目录，只在你选择安装 Skill 时使用。
- `/Applications/ChatGPT.app` 是 macOS Codex 桌面集成的默认位置；只运行 Web 看板时不需要它。
- 仓库不再包含 Cloudflare Worker、D1、R2、Wrangler 或云端协作迁移脚本。

## 验证

```bash
npm run check
```

这个命令会执行 TypeScript 类型检查、Web 生产构建和 Node 测试。

也可以拆开执行：

```bash
npm run typecheck
npm run build
npm test
```

## 常见问题

| 问题 | 处理方式 |
| --- | --- |
| `npm ci` 报 Node 版本不满足 | 安装 Node.js 22.5 或更高版本。 |
| Web 能打开但无法读取项目文件 | 在项目设置中映射本地仓库目录，或用 `taskctl project map PROJECT_ID --workspace-path /path/to/repo`。 |
| Codex 内没有 Taskboard | 确认从 Codex Taskboard Dock 图标启动，或手动运行 `npm run codex:inject -- --port 9229 --open`。 |
| 点击 Claude/OMP 会话没有反应 | 确认本机安装了对应 CLI，或设置 `CLAUDE_EXECUTABLE` / `OMP_EXECUTABLE`。 |
| 局域网其他设备能访问 | 启动时设置 `CODEX_TASKBOARD_HOST=127.0.0.1`。 |

## 许可证

当前仓库尚未声明开源许可证。在添加许可证前，默认保留全部权利。
