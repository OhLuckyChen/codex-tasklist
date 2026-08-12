# 重叠点对比评估报告（本地 fork vs 上游 v0.2.3）

> 关联：issue `3417FD193D6E-32`；方案见 `docs/integration-v0.2.3.md`
> 方法：6 个独立子智能体只读评估，按文件分片避免重复读取；最后综合裁定。
> 评估基准：本地 = worktree HEAD `8dbe5eb` + 3 个未提交文件（runtime-connectors）；上游 = `chuspeeism/v0.2.3`

## 综合裁定总表

| 点 | 主题 | 裁定 | 一句话结论 |
|----|------|------|-----------|
| C1 | Codex/Claude/OMP 启动器（进程级） | **hybrid** | 保留本地 Claude/OMP 启动器+connectors；Codex 回移植上游 `--cdp-pipe`+generation-guarded 重启；Tauri 延后 |
| C2 | `server/app.mjs` 路由/中间件/线程归属 | **hybrid** | 以本地多 runtime 骨架为基座，回填上游 Codex 会话进度扫描；不采纳 cloud-proxy/项目摘要/物理删除 |
| C3 | `server/database.mjs` 数据层/Schema | **hybrid** | 本地 schema 是超集，保留；补 `start_date` 列；可选 `task_activities`/`project_summaries`；加 `PRAGMA user_version` |
| C4 | 本地对话面板（codex-process.mjs） | **upstream** | 本地是更旧简化版且有退化（重复解析）；直接采纳上游 3 文件+新增 `codex-turn-owner.mjs`+`shared/codex-environment.mjs`，适配 app.mjs 调用点 |
| C5 | 任务卡片状态变更排序 | **hybrid** | 保留 `status_changed_at` 列+迁移；看板 issues 视图恢复 `sortOrder` 拖拽；Dashboard/List（视图集成后）用 statusChangedAt；Gantt 保持时间轴 |
| C6 | knowledge/runtime 集成 | **local** | **前提纠正**：上游 v0.2.3 无 knowledge；保留本地 `knowledge-service.mjs`；内容不入 D1/R2；云协作从 `b46cfef` 恢复 |

## 前提纠正（重要）

- **C6**：上游 `chuspeeism/v0.2.3` 全仓零 knowledge 命中，`cloud-config.mjs`/`cloud-proxy.mjs`/`cloud/*` 是 task/project 协作栈，与 knowledge 无关。方案 `docs/integration-v0.2.3.md` 第 3 节 #3 行把 cloud 当成上游 knowledge 能力是**误记**——那其实是本地 fork 自己提交 `b46cfef` 的 hybrid 设计，后在 HEAD `8dbe5eb` 合并 `origin/main` 时被删。因此 C6 不属"同一问题两种实现"，上游无替代，本地胜出。
- **C1**：上游对 Codex 是 Tauri 桌面 App 托管（`src-tauri/main.rs`）；本地对 Codex 是 shell supervisor+launchd+网络 CDP。**属同一问题两种实现仅限 Codex**；Claude/OMP 是本地独有，上游无对应物（CLI 工具无 webview 可注入），不构成"他也做了"。

## 逐点详评

### C1 Codex/Claude/OMP 启动器 — hybrid

- **本地**：`claude-launcher.mjs`(293)+`omp-launcher.mjs`(264) 经 `osascript`→Terminal.app 开窗，per-session 脚本落 `data/{claude,omp}-runs/`，`ps` 扫 `--session-id`/`--resume` 判活，`findSessionTtys`+`focusTerminalForTty` 复用窗口。Codex 走 `codex-taskboard-supervisor.sh`(0.5s 轮询 CDP signature)+`codex-taskboard-launcher.sh`(`--remote-debugging-port=9229`)+`install-macos-launcher.sh`(LaunchAgents)。未提交 diff 给 claude-launcher 加 `connectorEnvLines`(ANTHROPIC_BASE_URL/AUTH_TOKEN/CUSTOM_HEADERS)+`connectorModelArg`(--model)。
- **上游**：`src-tauri/main.rs`(901) 把 `codex-injector.mjs --launch --watch --open --cdp-pipe` 作为受管子进程，`CdpPipeBrowser`(stdio[3]/[4] 私有管道，无网络端口) 注入；`child.wait()` 事件驱动 + 2s 退避 + generation/intentional_stop/update_in_progress 三重守卫自动重启；tray + auto-updater。
- **选优**：Claude/OMP 全保留（上游无替代+runtime-connectors 耦合不可拆+CLI 托管模型正确）；Codex 保留本地 shell/launchd 模型但吸收上游可靠性与安全模式；Tauri 延后（工具链/分发成本高）。
- **风险**：`claude-launcher.mjs` 硬编码 `--dangerously-skip-permissions`（安全）；本地 `codex-injector.mjs` 不支持 `--cdp-pipe`，Codex CDP 暴露 `127.0.0.1:9229`；shell 轮询 vs 事件驱动效率差。
- **落地**：(1) 保留并提交 claude/omp-launcher 的 connector diff；(2) 从上游回移植 `--cdp-pipe` 支持（依赖 `scripts/codex-cdp-pipe.mjs` 的 `CdpPipeBrowser`），9229 降级为 fallback；(3) 把 generation-guarded 重启模式移进 shell 轮询或换 Node 版 supervisor；(4) launchd plist 保留；(5) 不引入 `src-tauri/*`。
- **硬依赖**（保护清单）：app.mjs launch/resume 路由、connectors CRUD 路由、database.mjs `connectors` 表+`getDefaultConnector(runtime)`+`parseConnectorRuntime`。

### C2 `server/app.mjs` — hybrid

- **本地独有**：`actorFromRequest` 读 `x-taskboard-agent-runtime` 分发 codex/claude/omp；runtime 继承（claude-agent+codex→claude）；`parseCommentPatch` 允许 `threadId:null` 解绑；`DELETE /api/tasks/:id/threads/:threadId`（unlinkTaskThread）；`POST /api/tasks/:id/transfer`；`/api/local/claude/*`+`/api/local/omp/*`+`/api/connectors/*`+knowledge 路由组；`resolveServerOptions` 三元组 claudeExecutable/ompExecutable/codexExecutable；`ensureClaudeSkill()` 写软链。
- **上游独有**：`routePrefix` 实例令牌路由隔离+HMAC `x-codex-taskboard-proof` 双向鉴权；`fd` socket-activation listen；`client-storage`/`cloud-proxy`/`cloud-session`；`/api/local/host-runtime`(PUT) 推送 threadRunning/progress；`/api/local/codex-thread-progress`(GET) 经 `findCodexSession`/`readCodexSessionState` 扫 `~/.codex/sessions/*-${threadId}.jsonl` 尾部提取 plan 步骤完成度；`taskActivities` 路由；`DELETE /api/tasks/:id`(deleteArchivedTask+附件清理)；`/api/local/projects/:id/summary`(ProjectSummaryService)。
- **选优**：本地多 runtime 架构是必须保留的主干；上游中被删的正交能力里，**Codex 会话 plan 进度扫描**（`readCodexSessionState`+`/api/local/codex-thread-progress`+`PUT /api/local/host-runtime`）是本地完全缺失的功能回退，值得回填；launcher HMAC 鉴权+socket-activation 可选回填（恢复嵌入式/多实例部署时）；其余上游独有项（cloud-proxy/cloud-session/client-storage/project-summary/taskActivities/deleteArchivedTask）不采纳。
- **落地**：保留本地 app.mjs 骨架；回填 `findCodexSession`/`readCodexSessionState`/`CODEX_PLAN_TAIL_BYTES`/`codexSessionStateCache`+`GET /api/local/codex-thread-progress` 路由，但 `parseThreadId` 放宽为本地语义（可空+normalize），仅对 `runtime==="codex"` 走 session 扫描，claude/omp 走各自 /status 路由。
- **一致性修复**：若 connector 未来支持 codex，统一 `parseConnectorRuntime` 与 `parseRuntime` 枚举；考虑把 `ensureClaudeSkill()` 从构造期移到 listen 成功后。

### C3 `server/database.mjs` — hybrid

- **本地独有表/列**：`task_threads`(task_id,thread_id,linked_at) 持久化关联；`connectors`；`knowledge_proposals`+`knowledge_proposal_changes`；tasks 多 `runtime`/`status_changed_at`/archived status（+archived_at）；迁移链更完整（migrateTaskStatuses→migrateArchivedStatus→migrateRuntimeCheckConstraint）。
- **上游独有**：`task_activities`(变更日志)；`project_summaries`(AI 摘要缓存)；tasks 多 `start_date`；`attachTaskActivity` 读取时派生 `conversationRefs`/`participants`（不持久化）。
- **选优**：本地 tasks 是上游真超集；本地 `task_threads` 持久化关联严格优于上游派生模型（支持多线程/解绑/关联时间）；上游 `task_activities`/`project_summaries` 为纯增量新表可补。
- **风险**：上游 status CHECK 不含 archived，套用上游建表会让本地已归档任务迁移失败；无 schema versioning，表重建迁移不可重放。
- **落地**：保留本地基座；补 `start_date TEXT`（建表+taskFromRow+ALTER 探测）；选择性引入 `task_activities`+`project_summaries` 纯新表；**不**引入 `attachTaskActivity` 派生模型；在 `#migrate` 开头加 `PRAGMA user_version` 阶梯式升级。

### C4 本地对话面板 — canceled

本地对话面板已从产品中裁撤。保留的只有 `server/codex-process.mjs` 与 `server/codex-turn-owner.mjs` 这组通用 Codex JSON 子进程执行基础设施，供 `knowledge-service.mjs` 生成知识提案使用；不再保留独立面板、本地对话 API、会话表或前端组件。

### C5 任务卡片状态变更排序 — hybrid

- **本地**：提交 `8351ff1` 新增 `status_changed_at` 列；前端 `compareTasksByStatusChangedAt` 倒序+`statusChangedGroup`(今日/昨日/上周/更早) 分组；BoardColumn 按时间分组渲染。
- **上游**：排序键 `sortOrder`（REAL，拖拽中点计算）正序，tie-break createdAt；无时间分组；服务端 ORDER BY 与前端一致。
- **冲突**：本地 `tasksByStatus.sort(compareTasksByStatusChangedAt)` **直接覆盖** `sortTasks(sortOrder)`——看板列内用户手动拖拽顺序被完全忽略，是交互回退。
- **选优**：两者解决不同问题——sortOrder 解决"用户意图顺序"，statusChangedAt 解决"最近发生什么"，应分视图适配不互斥。
- **落地**：保留 `status_changed_at` 列与迁移（DB 增量）；看板 issues 视图恢复 `sortTasks(sortOrder)` 列内排序，时间分组可选保留（分组内按 sort_order）；Dashboard/List 视图（v0.2.3 视图集成后）用 statusChangedAt+分组；Gantt 保持时间轴。把排序策略提取为可配置项，避免硬编码在 tasksByStatus。
- **本轮范围**：v0.2.3 的 Dashboard/List/Gantt 是纯新增视图（非重叠点），本轮按方案"决策但不强制落地"。本轮只修复看板 issues 的拖拽回退+让 statusChangedAt 与 sortOrder 共存；Dashboard/List 的 statusChangedAt 应用作为视图集成后的后续项。

### C6 knowledge — local（前提纠正见上）

- **本地**：`knowledge-service.mjs`(703) 完整闭环：overview/list/readPage/search/check（fresh/stale/unverified/missing_sources）/generate（codex 异步 knowledge-runs 回调）/ask（带 citations）/publish（baseDigest 乐观锁+失败回滚）/proposal CRUD（状态机）/source 版本跟踪。proposal 元数据落本地 SQLite（knowledge_proposals/changes 表），知识内容落项目 `docs/knowledge/**/*.md`（随 git 走可 review）。与 runtime-connectors 零耦合。
- **上游**：无 knowledge。
- **选优**：本地优先，离线可用，内容入 git 可追溯，唯一外部依赖 codex CLI。保留。
- **风险**：强依赖 `codex exec` 子进程（codex 不可用时 generate/ask 失效）；search 是子串+线性扫描（50 条截断），知识页多时召回差；proposal 上限 50 文件/5MB。
- **落地**：保留不动；不把知识内容搬 D1/R2；云协作需从 `b46cfef` cherry-pick 恢复 cloud 半边（仅 proposal 元数据入 D1）；search 升级为前置项。

## Phase 3 实施计划（按依赖与风险排序）

1. **C3 database 增量**（低风险）：补 `start_date` 列+迁移；加 `PRAGMA user_version`；可选 `task_activities`/`project_summaries` 新表。
2. **C4 本地对话面板 采纳上游**（中风险，需适配）：覆盖 3 文件+新增 2 文件；调整本地 app.mjs 的 本地对话面板 调用点（getCatalog 签名、resolveContext、discoverAiCatalog workspacePath）。
3. **C2 app.mjs 回填 Codex 进度**（中风险）：移植 `findCodexSession`/`readCodexSessionState`+`/api/local/codex-thread-progress`+`PUT /api/local/host-runtime`，适配本地 threadId 可空/多 runtime 语义。
4. **C5 看板排序修复**（低风险）：恢复 issues 视图 sortOrder，statusChangedAt 分组共存。
5. **C1 Codex 启动器补强**（中高风险）：提交 connector diff；回移植 `--cdp-pipe`+`CdpPipeBrowser`；9229 降级 fallback；generation-guarded 重启。
6. **C6**：不改，记录。

每步后做增量验证（语法/import/启动），全部完成后做 Phase 4 整体验收。

## 延后项（本轮不落地，方案已记录）

- #1 Tauri/macOS App（`src-tauri/*`）— 独立子系统。
- #3 Cloudflare 协作（`cloud/*`+cloud-config/proxy）— 架构分歧，且 knowledge 不依赖。
- v0.2.3 任务视图 Dashboard/List/Gantt — 纯新增视图，集成后 C5 再应用 statusChangedAt。
- launcher HMAC 鉴权 + socket-activation — 恢复嵌入式/多实例部署时再回填。
- 未发布修复 `65a6452`(Markdown 图片/软换行)、`5de72b9`(附件下载)、`43fbfb6`(Launcher 状态栏) — 视相关域落地时一并。
