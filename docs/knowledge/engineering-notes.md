---
id: project.engineering-notes
title: 工程说明
kind: engineering
updated_at: 2026-08-11
sources:
  - type: file
    ref: package.json
    revision: git-blob:1cd0a10a297e9ee3d27c4b6ad3e03575eeecc794
  - type: file
    ref: server/app.mjs
    revision: git-blob:fa36da290404d66a14b87b7c97ca699313658f10
  - type: file
    ref: scripts/install-macos-launcher.sh
    revision: git-blob:8c28ac00faf7626ed96e92c2788017a1c9a0bb44
---
# 工程说明

## 开发与验证

- Node.js 最低版本为 22.5。
- `npm run typecheck` 检查 Web TypeScript。
- `npm run build:web` 只构建 Web；`npm run build` 还会在任务面板正在运行时刷新嵌入页面。
- `npm test` 执行本地服务、CLI、注入器和静态交互测试。
- `npm run check` 依次执行类型检查、生产构建和完整测试。

## 实现约束

- 业务持久化只有本地 SQLite 一套实现；新增实体必须补 schema、路由、前端契约和测试。
- 用户输入先经过允许字段、长度、枚举和路径校验；大体积知识提案使用单独的 6 MiB 请求上限。
- 不覆盖或回滚工作区中的其他改动。知识发布只写审核提案列出的允许文件。
- macOS 启动器不得硬编码个人目录或固定 Homebrew 路径；安装时记录 Node/Codex 可执行文件路径，运行时也允许环境变量覆盖。

## 常见注意事项

- `npm run build` 可能刷新正在运行的 Codex 内嵌 iframe，但不会重启 Codex 主进程。
- 正式知识中的来源版本是工作区当前内容的 Git blob，而不是最近提交版本，因此未提交但已确认的实现也能被准确检查。
- 问答会同时读取正式知识与当前代码；涉及当前行为时以代码证据为准，并返回引用。
