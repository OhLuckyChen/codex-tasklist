# 上游 dashi-taskboard v0.2.3 整合方案

> 关联 issue：taskboard `3417FD193D6E-32`「能力持续优化」
> 执行分支：`feature/integration-v0.2.3`（worktree，隔离于 `feature/runtime-connectors` 工作树）
> 基线：本地 HEAD `8dbe5eb`（含 3 个未提交文件 app.mjs/claude-launcher.mjs/database.mjs 的 runtime-connectors 改动）↔ 上游 `chuspeeism/v0.2.3`

## 1. 关键事实（证据）

- **版本**：本地 `package.json` = `0.1.0`；上游 `v0.2.3` = `0.2.3`。
- **历史不相交**：`git merge-base feature/runtime-connectors chuspeeism/v0.2.3` 无结果（exit 1），双方 root commit 不同（本地 `83f97a6`，上游 `520bda7`/`5131e59`），无任何共享提交。
  - 推论：**禁止 `git merge chuspeeism/v0.2.3`**——会触发全文件 add/add 冲突。整合只能走**文件/内容级裁决**。
- **规模**：本地领先上游 36 提交（含 runtime-connectors、Codex 持久化、线程/评论归属、状态变更排序、知识工作流、README 等）；上游领先本地 291 提交。文件级 tree diff：246 文件差异，+18606/-38508 行。
- **本地独有文件**（上游无）：`server/claude-launcher.mjs`(293)、`server/omp-launcher.mjs`(264)、`server/knowledge-service.mjs`(703)、`docs/*`(24)、`macos/*`(3) 等。
- **上游独有文件**（本地无）：`src-tauri/*`(14，Tauri/macOS)、`cloud/*`(6)、`server/cloud-config.mjs`、`server/cloud-proxy.mjs`、`server/project-summary.mjs`、`server/codex-turn-owner.mjs`、`inject/workbuddy-taskboard.user.js` 等。
- **双方都有且都改的重叠文件**：`server/app.mjs`(本地 2684 / 上游 2602)、`server/database.mjs`(2288 / 2121)、`server/codex-process.mjs`(584/591)、`server/codex-process.mjs`(465/471)、`server/codex-process.mjs`(256/273)、`server/index.mjs`(38/41)。

## 2. 方法论

1. 不做 `git merge`。按文件分类裁决：重叠文件逐点对比选优（Phase 2），纯新增文件按"采纳/跳过/延后"决策直接迁移，本地独有文件保留不动。
2. 迁移以**内容级 patch / 手工移植**为主，逐文件对齐 import、路由注册、schema 迁移。
3. 每个重叠点产出"本地实现 vs 上游实现 → 选哪个 + 为什么"，由独立子智能体给出评估意见后综合裁定。
4. 不覆盖、不回滚本地未被判优的改动；3 个未提交文件纳入评估，落地时在 worktree 内统一进/退。

## 3. 上游能力域逐项处置

| # | 能力域 | 上游主要内容（文件） | 与本地关系 | 处置 | 冲突点 / 依赖 |
|---|--------|----------------------|------------|------|----------------|
| 1 | macOS/Tauri App 发布 | `src-tauri/*`(14)、`scripts/*` 签名/预检/发布、`.github` release、`rust-toolchain.toml` | 全新平台，本地无 | **延后（本轮跳过落地）** | 独立子系统，可后续单独拉取；本轮范围=重叠选优。方案留路径。 |
| 2 | Codex 嵌入启动器 | `inject/codex-taskboard.user.js`、状态栏/launcher（web）、更新检查 | 部分重叠：本地 `claude-launcher.mjs`+`omp-launcher.mjs` 是进程级启动器；上游是 CDP/注入式 | **对比 + 部分采纳**：启动器与线程归属→Phase 2 C1；`inject/*.user.js` 直接采纳上游新版（含 `workbuddy-taskboard.user.js` 新增，可选） | app.mjs 启动入口、database.mjs 会话表 |
| 3 | Cloudflare 协作 | `cloud/*`(6)、`wrangler.jsonc`、`server/cloud-config.mjs`、`server/cloud-proxy.mjs` | **前提纠正**：上游 cloud 栈是 task/project 协作，无 knowledge；本地 `knowledge-service.mjs`(703) 是本地独有完整闭环 | **延后（本轮跳过落地）**；knowledge 不依赖 cloud | cloud 与 knowledge 非二选一；云协作若需从本地提交 `b46cfef` 恢复 |
| 4 | 任务视图（Dashboard/Gantt/List） | `web/src/*`(58 新)、`DashboardView`/`GanttView`/`IssueListView` | 本地有看板列表；Dashboard/Gantt 为新视图 | **部分采纳**：新视图作为独立组件低冲突迁入；与本地"状态变更排序"(C5) 协同 | 排序/分组逻辑可能与本地 8351ff1 重叠 |
| 5 | 本地对话面板 | `server/codex-process.mjs`、`server/codex-turn-owner.mjs`(新)、web 面板/思考步骤/拖拽 | **双方都有**，上游更新更全 | **对比采纳**→Phase 2 C4 | app.mjs 路由注册、database.mjs 会话/轮次表 |
| 6 | 评论/详情增强 | Markdown 渲染、Linear 风格评论、图片粘贴/内联附件、详情文本选择 | 互补：本地增强在线程归属/评论链接；上游增强在渲染/富文本 | **采纳**（低冲突） | 评论组件、附件下载端点 |
| 7 | taskctl / Skill | `skills/manage-taskboard/{SKILL.md,references/cli.md,agents/openai.yaml}`、`skills/project-knowledge-builder/*` | 本地使用同一 skill | **采纳上游新版**，保留本地若有定制 | 注意本地 skill 目录是否有差异 |
| 8 | 任务协作模型 | assignee、conversation menu、project move、relations、start status sync | **强重叠**：本地"评论→Codex 线程归属/请求标记关联"在 app.mjs/database.mjs | **对比采纳**→Phase 2 C1/C2/C3 | 会话归属、状态流转、评论线程绑定 |
| 9 | i18n / 本地化 | web zh/en 资源、深色模式、Workflow/编辑器/详情页文案 | 纯增量资源 | **采纳**（低冲突） | 仅资源文件，注意 key 命名对齐 |
| + | 未发布提交（v0.2.3 后 main） | launcher 状态菜单、Markdown 图片编辑/软换行、附件下载修复、zh README、DMG 列表 | 多为修复 | **选择性采纳**修复类 | 评估后随相关域一起迁 |

## 4. 重叠对比点清单（→ Phase 2 子智能体评估）

每个点：本地实现 vs 上游实现 → 选优。**子智能体各出独立意见，综合裁定。**

- **C1 Codex/Claude/OMP 启动器 + 线程/评论归属**
  本地：`claude-launcher.mjs`(293) + `omp-launcher.mjs`(264) + 未提交 `app.mjs`/`database.mjs` 线程绑定段（fix: bind comments to created Codex thread / correlate by request marker）
  上游：CDP/inject 启动器 + state bar + start-status sync + conversation menu（`app.mjs`/`database.mjs` 内）
  选优维度：持久化可靠性、线程归属准确度、与本地 runtime-connectors 的耦合
- **C2 `server/app.mjs` 路由/中间件层**（本地 2684 / 上游 2602）
- **C3 `server/database.mjs` 数据层/Schema**（本地 2288 / 上游 2121）
- **C4 本地对话面板**（`codex-process.mjs` 584/591、`codex-process.mjs` 465/471、`codex-process.mjs` 256/273；上游新增 `codex-turn-owner.mjs`）
- **C5 任务卡片状态变更排序**：本地提交 `8351ff1`「按状态变更时间排序并分组」↔ 上游任务视图（Dashboard/List/Gantt + start status sync）
- **C6 knowledge/runtime 集成**：本地 `knowledge-service.mjs`(703, 独立) ↔ 上游 `cloud-config.mjs`+`cloud-proxy.mjs`+`/api/local/projects/*/knowledge-*`（云端架构）

## 5. 落地顺序（依赖优先）

1. 先迁**纯增量低冲突**域：#9 i18n、#6 评论/详情渲染、#7 taskctl/Skill、#4 任务视图新组件 → 建立"采纳上游"基线。
2. 再做**重叠选优**：C2/C3（数据/路由层先稳）→ C1（启动器/线程归属，依赖前两者）→ C4（本地对话面板）→ C5（排序，依赖视图）→ C6（knowledge 架构二选一）。
3. 最后评估**未发布修复**按需补迁。
4. 延后域（#1 Tauri/macOS、#3 Cloudflare）单独排期，不在本轮落地。

## 6. 风险

- **历史不相交**：任何整支 merge 不可行；必须逐文件，遗漏 import/路由注册会导致启动失败。
- **schema 迁移**：`database.mjs` 双方都改表，采纳上游表结构需配套迁移脚本，避免本地存量数据丢失。
- **线程归属语义**：本地"请求标记关联"与上游"start-status sync"模型不同，混用易导致评论挂错线程。
- **runtime-connectors 耦合**：3 个未提交文件是本地启动器核心，若判"上游更优"需整体替换而非打补丁。
- **未提交改动保护**：worktree 已镜像这 3 文件改动；落地时若判本地更优则原样保留，判上游更优则在 worktree 内整体替换并记录。

## 7. 验收要点（→ Phase 4）

- 任务板可启动（现有启动方式），`package.json`/`server/index.mjs` 入口正常。
- 关键功能不回归：任务列表、评论增改、线程归属（评论挂在正确会话）、任务按状态变更时间排序。
- 重叠点结论均有"选哪个+为什么"证据；未被判优的本地定制仍在。
- 工作区边界：所有写入仅在 `/Users/lincya/workspace/my-taskboard` 内。
